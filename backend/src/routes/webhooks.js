const express = require('express');
const router = express.Router();
const db = require('../config/database');
const superAdminMiddleware = require('../middleware/superadmin');
const checkLockdown = require('../middleware/lockdown');
const orders = require('../services/shopify-orders');

// Get all webhook logs (protected, admin only)
router.get('/', superAdminMiddleware, async (req, res) => {
  try {
    const { processed, limit = 50, offset = 0 } = req.query;
    
    let query = 'SELECT id, shopify_order_id, processed, created_at, processed_at, error_message, tickets_created, webhook_type FROM webhook_logs WHERE shop_id = $1';
    const params = [req.shopId];

    // Filter by processed status if specified
    if (processed !== undefined) {
      query += ' AND processed = $2';
      params.push(processed === 'true');
    }
    
    query += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
    params.push(parseInt(limit), parseInt(offset));
    
    const result = await db.query(query, params);
    
    // Get total count
    let countQuery = 'SELECT COUNT(*) FROM webhook_logs WHERE shop_id = $1';
    const countParams = [req.shopId];
    if (processed !== undefined) {
      countQuery += ' AND processed = $2';
      countParams.push(processed === 'true');
    }
    const countResult = await db.query(countQuery, countParams);
    
    res.json({
      logs: result.rows,
      total: parseInt(countResult.rows[0].count),
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (error) {
    console.error('Error fetching webhook logs:', error);
    res.status(500).json({ error: 'Failed to fetch webhook logs' });
  }
});

// Get webhook log by ID with full webhook data (protected, admin only)
router.get('/:id', superAdminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await db.query(
      'SELECT * FROM webhook_logs WHERE id = $1 AND shop_id = $2',
      [id, req.shopId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Webhook log not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching webhook log:', error);
    res.status(500).json({ error: 'Failed to fetch webhook log' });
  }
});

// Get webhook logs statistics (protected, admin only)
router.get('/stats/summary', superAdminMiddleware, async (req, res) => {
  try {
    const stats = await db.query(`
      SELECT
        COUNT(*) as total_webhooks,
        COUNT(*) FILTER (WHERE processed = TRUE) as processed_webhooks,
        COUNT(*) FILTER (WHERE processed = FALSE) as unprocessed_webhooks,
        COUNT(*) FILTER (WHERE error_message IS NOT NULL) as webhooks_with_errors,
        SUM(tickets_created) as total_tickets_created
      FROM webhook_logs
      WHERE shop_id = $1
    `, [req.shopId]);
    
    res.json(stats.rows[0]);
  } catch (error) {
    console.error('Error fetching webhook stats:', error);
    res.status(500).json({ error: 'Failed to fetch webhook statistics' });
  }
});

// Retry webhook processing (SuperAdmin only).
//
// Replays the stored payload through the same service the live endpoints use
// (services/shopify-orders.js). This used to be a second, drifted copy of the
// order-processing logic - see the note at the top of that file.
router.post('/:id/retry', superAdminMiddleware, checkLockdown, async (req, res) => {
  const { id } = req.params;
  const { webhook_type: overrideWebhookType } = req.body;

  try {
    const webhookResult = await db.query(
      'SELECT * FROM webhook_logs WHERE id = $1 AND shop_id = $2',
      [id, req.shopId]
    );
    if (webhookResult.rows.length === 0) {
      return res.status(404).json({ error: 'Webhook log not found' });
    }

    const webhook = webhookResult.rows[0];
    const webhookType = overrideWebhookType || webhook.webhook_type;

    if (webhook.processed && !webhook.error_message && !overrideWebhookType) {
      return res.status(400).json({
        error: 'Webhook already processed successfully. Use webhook type override to reprocess as a different type.',
        webhook_id: id,
        processed: webhook.processed,
        current_type: webhook.webhook_type,
      });
    }

    const validTypes = ['order_create', 'refund', 'cancel', 'chargeback'];
    if (!validTypes.includes(webhookType)) {
      return res.status(400).json({
        error: 'Invalid webhook type',
        valid_types: validTypes,
        provided: webhookType,
      });
    }

    let webhookData;
    try {
      webhookData = typeof webhook.webhook_data === 'string'
        ? JSON.parse(webhook.webhook_data)
        : webhook.webhook_data;
    } catch (parseError) {
      return res.status(400).json({
        error: 'Invalid webhook data format',
        details: parseError.message,
      });
    }

    console.log(`Retrying webhook ${id} as ${webhookType} (order ${webhook.shopify_order_id})`);

    // Clear the previous outcome so the service can write a fresh one.
    await db.query(
      `UPDATE webhook_logs
          SET processed = FALSE, error_message = NULL, processed_at = NULL, tickets_created = NULL
        WHERE id = $1 AND shop_id = $2`,
      [id, req.shopId]
    );

    let result;
    if (webhookType === 'order_create') {
      result = await orders.processOrderCreate(webhookData, {
        source: 'retry', webhookLogId: id, shopId: req.shopId,
      });
    } else {
      const status = { refund: 'refunded', cancel: 'cancelled', chargeback: 'chargeback' }[webhookType];
      result = await orders.processOrderStatusChange({
        payload: webhookData,
        status,
        webhookType,
        source: 'retry',
        webhookLogId: id,
        shopId: req.shopId,
      });
    }

    if (overrideWebhookType && overrideWebhookType !== webhook.webhook_type) {
      await db.query(
        'UPDATE webhook_logs SET webhook_type = $1 WHERE id = $2 AND shop_id = $3',
        [webhookType, id, req.shopId]
      );
      console.log(`Updated webhook ${id} type from ${webhook.webhook_type} to ${webhookType}`);
    }

    res.json({
      success: true,
      message: `Webhook ${id} retried successfully`,
      webhook_id: id,
      webhook_type: webhookType,
      original_type: webhook.webhook_type,
      type_overridden: Boolean(overrideWebhookType),
      result,
    });
  } catch (error) {
    console.error('Error retrying webhook:', error);
    await orders.markWebhookFailed(id, `Retry failed: ${error.message}`, req.shopId);
    res.status(500).json({
      error: 'Failed to retry webhook processing',
      details: error.message,
      webhook_id: id,
    });
  }
});

module.exports = router;
