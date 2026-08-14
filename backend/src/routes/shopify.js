const express = require('express');
const router = express.Router();
const db = require('../config/database');
const checkLockdown = require('../middleware/lockdown');
const authMiddleware = require('../middleware/auth');
const orders = require('../services/shopify-orders');

// All order-processing logic lives in services/shopify-orders.js so that these
// routes and the webhook retry path in routes/webhooks.js cannot drift apart.
// These handlers only translate between HTTP and that service.

// Middleware to validate the Shopify Flow API key.
// NOTE: this is a shared static secret, not a signature. When this moves to a
// real Shopify app, replace it with HMAC verification of X-Shopify-Hmac-Sha256
// over the raw request body (which also means express.json() can no longer be
// applied globally in server.js).
const validateApiKey = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];

  if (!apiKey || apiKey !== process.env.SHOPIFY_API_KEY) {
    console.log('401 Unauthorized: invalid or missing x-api-key header');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
};

// Create tickets for a Shopify order.
router.post('/create-ticket', validateApiKey, checkLockdown, async (req, res) => {
  try {
    const result = await orders.processOrderCreate(req.body, { source: 'live' });

    switch (result.outcome) {
      case 'invalid':
        return res.status(400).json({ error: `Missing required field: ${result.error}` });

      case 'duplicate':
        return res.status(200).json({
          success: true,
          message: 'Order already processed',
          duplicate: true,
          tickets: result.tickets.map((t) => ({
            id: t.id,
            uuid: t.uuid,
            shopify_order_id: t.shopify_order_id,
            email_sent: t.email_sent,
          })),
        });

      case 'no_ticket_items':
        return res.status(200).json({
          success: true,
          message: 'No ticket items found in order',
          tickets: [],
        });

      default:
        return res.status(201).json({
          success: true,
          message: `Successfully created ${result.tickets.length} ticket(s)`,
          tickets: result.tickets,
          email_sent: result.email?.sent === true,
        });
    }
  } catch (error) {
    console.error('Error processing Shopify order:', error);
    res.status(500).json({ error: 'Failed to process order' });
  }
});

// Refund / cancel / chargeback all void tickets on an order. They deliberately
// do NOT run checkLockdown: invalidating a refunded ticket is a safety
// operation, and blocking it during an event would leave a refunded ticket
// scannable at the door.
function statusChangeRoute({ status, webhookType, describe }) {
  return async (req, res) => {
    try {
      const result = await orders.processOrderStatusChange({
        payload: req.body,
        status,
        webhookType,
        source: 'live',
        extraDetails: describe(req.body),
      });

      if (result.outcome === 'no_tickets') {
        return res.status(200).json({
          message: 'No tickets found for this order',
          order_id: result.orderId,
        });
      }

      return res.status(200).json({
        success: true,
        message: `Marked ${result.updated.length} ticket(s) as ${status}`,
        tickets_updated: result.updated.length,
        tickets_on_order: result.totalOnOrder,
        partial: result.selection.partial === true,
        updated_tickets: result.updated,
      });
    } catch (error) {
      console.error(`Error processing ${webhookType} webhook:`, error);
      res.status(500).json({ error: `Failed to process ${webhookType}` });
    }
  };
}

router.post('/refund', validateApiKey, statusChangeRoute({
  status: 'refunded',
  webhookType: 'refund',
  describe: (body) => `\nRefund Line Items: ${body.refund_line_items?.length || 0}\nTransactions: ${body.transactions?.length || 0}`,
}));

router.post('/cancel', validateApiKey, statusChangeRoute({
  status: 'cancelled',
  webhookType: 'cancel',
  describe: (body) => `\nRefund ID: ${body.id}\nLine Items: ${body.refund_line_items?.length || 0}`,
}));

router.post('/chargeback', validateApiKey, statusChangeRoute({
  status: 'chargeback',
  webhookType: 'chargeback',
  describe: (body) => `\nDispute ID: ${body.id}\n\nPlease review this case immediately.`,
}));

// Debug endpoint to see recent webhook activity (authenticated).
// Largely duplicates GET /api/webhooks - consider removing.
router.get('/debug/webhooks', authMiddleware, async (req, res) => {
  try {
    const recentWebhooks = await db.query(`
      SELECT id, shopify_order_id, webhook_type, processed, error_message,
             tickets_created, created_at, processed_at
        FROM webhook_logs
       ORDER BY created_at DESC
       LIMIT 20
    `);

    const ticketCounts = await db.query(
      'SELECT status, COUNT(*) as count FROM tickets GROUP BY status'
    );

    res.json({
      recent_webhooks: recentWebhooks.rows,
      ticket_status_counts: ticketCounts.rows,
      debug_info: {
        current_time: new Date().toISOString(),
        webhook_endpoints: [
          '/api/shopify/create-ticket',
          '/api/shopify/refund',
          '/api/shopify/cancel',
          '/api/shopify/chargeback',
        ],
      },
    });
  } catch (error) {
    console.error('Error in debug endpoint:', error);
    res.status(500).json({ error: 'Debug endpoint failed' });
  }
});

// Health check (no API key required)
router.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'shopify-integration' });
});

module.exports = router;
