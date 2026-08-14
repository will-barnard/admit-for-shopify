const express = require('express');
const router = express.Router();
const db = require('../config/database');
const authMiddleware = require('../middleware/auth');
const crypto = require('crypto');

// Get all webhook logs (protected, admin only)
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { processed, limit = 50, offset = 0 } = req.query;
    
    let query = 'SELECT id, shopify_order_id, processed, created_at, processed_at, error_message, tickets_created, webhook_type FROM webhook_logs';
    const params = [];
    
    // Filter by processed status if specified
    if (processed !== undefined) {
      query += ' WHERE processed = $1';
      params.push(processed === 'true');
    }
    
    query += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
    params.push(parseInt(limit), parseInt(offset));
    
    const result = await db.query(query, params);
    
    // Get total count
    let countQuery = 'SELECT COUNT(*) FROM webhook_logs';
    if (processed !== undefined) {
      countQuery += ' WHERE processed = $1';
    }
    const countResult = await db.query(countQuery, processed !== undefined ? [processed === 'true'] : []);
    
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
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await db.query(
      'SELECT * FROM webhook_logs WHERE id = $1',
      [id]
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
router.get('/stats/summary', authMiddleware, async (req, res) => {
  try {
    const stats = await db.query(`
      SELECT 
        COUNT(*) as total_webhooks,
        COUNT(*) FILTER (WHERE processed = TRUE) as processed_webhooks,
        COUNT(*) FILTER (WHERE processed = FALSE) as unprocessed_webhooks,
        COUNT(*) FILTER (WHERE error_message IS NOT NULL) as webhooks_with_errors,
        SUM(tickets_created) as total_tickets_created
      FROM webhook_logs
    `);
    
    res.json(stats.rows[0]);
  } catch (error) {
    console.error('Error fetching webhook stats:', error);
    res.status(500).json({ error: 'Failed to fetch webhook statistics' });
  }
});

// Retry webhook processing (protected, admin only)
router.post('/:id/retry', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { webhook_type: overrideWebhookType } = req.body; // Allow manual webhook type override
    
    // Get webhook log
    const webhookResult = await db.query(
      'SELECT * FROM webhook_logs WHERE id = $1',
      [id]
    );
    
    if (webhookResult.rows.length === 0) {
      return res.status(404).json({ error: 'Webhook log not found' });
    }
    
    const webhook = webhookResult.rows[0];
    
    // Use override webhook type if provided, otherwise use original
    const webhookType = overrideWebhookType || webhook.webhook_type;
    
    // Only retry failed or unprocessed webhooks (unless we're changing the type)
    if (webhook.processed && !webhook.error_message && !overrideWebhookType) {
      return res.status(400).json({ 
        error: 'Webhook already processed successfully. Use webhook type override to reprocess as different type.',
        webhook_id: id,
        processed: webhook.processed,
        current_type: webhook.webhook_type
      });
    }
    
    // Validate webhook type
    const validTypes = ['order_create', 'refund', 'cancel', 'chargeback'];
    if (!validTypes.includes(webhookType)) {
      return res.status(400).json({ 
        error: 'Invalid webhook type',
        valid_types: validTypes,
        provided: webhookType
      });
    }
    
    console.log(`🔄 Retrying webhook ${id} as type: ${webhookType}${overrideWebhookType ? ` (overridden from ${webhook.webhook_type})` : ''} (order: ${webhook.shopify_order_id})`);
    
    // Parse webhook data
    let webhookData;
    try {
      webhookData = typeof webhook.webhook_data === 'string' 
        ? JSON.parse(webhook.webhook_data) 
        : webhook.webhook_data;
    } catch (parseError) {
      console.error('Failed to parse webhook data:', parseError);
      return res.status(400).json({ 
        error: 'Invalid webhook data format',
        details: parseError.message 
      });
    }
    
    // Reset webhook log status
    await db.query(
      `UPDATE webhook_logs 
       SET processed = FALSE, 
           error_message = NULL, 
           processed_at = NULL,
           tickets_created = NULL
       WHERE id = $1`,
      [id]
    );
    
    let result;
    
    // Process based on webhook type (using override if provided)
    switch (webhookType) {
      case 'order_create':
        result = await retryOrderCreate(webhookData, id);
        break;
      case 'refund':
        result = await retryRefund(webhookData, id);
        break;
      case 'cancel':
        result = await retryCancel(webhookData, id);
        break;
      case 'chargeback':
        result = await retryChargeback(webhookData, id);
        break;
      default:
        throw new Error(`Unknown webhook type: ${webhookType}`);
    }
    
    // If we used an override type, update the webhook log to reflect the new type
    if (overrideWebhookType && overrideWebhookType !== webhook.webhook_type) {
      await db.query(
        `UPDATE webhook_logs SET webhook_type = $1 WHERE id = $2`,
        [webhookType, id]
      );
      console.log(`📝 Updated webhook ${id} type from ${webhook.webhook_type} to ${webhookType}`);
    }
    
    console.log(`✅ Successfully retried webhook ${id}:`, result);
    
    res.json({
      success: true,
      message: `Webhook ${id} retried successfully`,
      webhook_id: id,
      webhook_type: webhookType,
      original_type: webhook.webhook_type,
      type_overridden: overrideWebhookType ? true : false,
      result: result
    });
    
  } catch (error) {
    console.error('Error retrying webhook:', error);
    
    // Update webhook log with retry error
    try {
      await db.query(
        `UPDATE webhook_logs 
         SET error_message = $1
         WHERE id = $2`,
        [`Retry failed: ${error.message}`, req.params.id]
      );
    } catch (updateError) {
      console.error('Failed to update webhook log with retry error:', updateError);
    }
    
    res.status(500).json({ 
      error: 'Failed to retry webhook processing',
      details: error.message,
      webhook_id: req.params.id
    });
  }
});

// Helper functions for webhook retry processing
async function retryOrderCreate(webhookData, webhookLogId) {
  const { sendTicketEmail, sendAdminNotification } = require('../services/email');
  const { v4: uuidv4 } = require('uuid');
  const QRCode = require('qrcode');
  
  const { line_items, customer, id: order_id } = webhookData;
  const shopify_order_id = order_id ? String(order_id) : null;
  const customerName = `${customer.first_name} ${customer.last_name || ''}`.trim();
  const customerEmail = customer.email || null;
  
  // Look up SKU→event mapping from database
  const eventsResult = await db.query('SELECT id, name, sku FROM events WHERE sku IS NOT NULL');
  const skuToEvent = {};
  eventsResult.rows.forEach(e => { skuToEvent[e.sku.toLowerCase()] = { eventId: e.id, eventName: e.name }; });
  
  // Check for duplicate order
  if (shopify_order_id) {
    const duplicateCheck = await db.query(
      'SELECT id, uuid, shopify_order_id FROM tickets WHERE shopify_order_id = $1',
      [shopify_order_id]
    );
    
    if (duplicateCheck.rows.length > 0) {
      await db.query(
        `UPDATE webhook_logs 
         SET processed = TRUE, 
             processed_at = NOW(), 
             tickets_created = $1,
             error_message = 'Duplicate order - tickets already exist'
         WHERE id = $2`,
        [duplicateCheck.rows.length, webhookLogId]
      );
      
      return {
        duplicate: true,
        tickets_found: duplicateCheck.rows.length,
        message: 'Order already processed'
      };
    }
  }
  
  // Filter ticket line items to those with known SKUs
  const ticketLineItems = line_items.filter(item => {
    const sku = item.sku?.toLowerCase();
    return sku && skuToEvent[sku];
  });
  
  if (ticketLineItems.length === 0) {
    await db.query(
      `UPDATE webhook_logs 
       SET processed = TRUE, 
           processed_at = NOW(), 
           tickets_created = 0,
           error_message = 'No ticket items found in order'
       WHERE id = $1`,
      [webhookLogId]
    );
    
    return { tickets_created: 0, message: 'No ticket items found' };
  }
  
  // Check email settings
  const settingsResult = await db.query('SELECT auto_send_emails FROM settings LIMIT 1');
  const autoSendEmails = settingsResult.rows[0]?.auto_send_emails ?? true;
  
  const createdTickets = [];
  
  // Create tickets
  for (const lineItem of ticketLineItems) {
    const sku = lineItem.sku.toLowerCase();
    const eventMapping = skuToEvent[sku];
    const quantity = lineItem.quantity || 1;
    
    for (let i = 0; i < quantity; i++) {
      const uuid = uuidv4();
      
      const result = await db.query(
        `INSERT INTO tickets (event_id, name, email, uuid, shopify_order_id, email_sent, created_at) 
         VALUES ($1, $2, $3, $4, $5, $6, NOW()) 
         RETURNING *`,
        [eventMapping.eventId, customerName, customerEmail, uuid, shopify_order_id, false]
      );
      
      const ticket = result.rows[0];
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost';
      const verifyUrl = `${frontendUrl}/verify/${ticket.uuid}`;
      const qrCodeDataUrl = await QRCode.toDataURL(verifyUrl);
      
      createdTickets.push({ ...ticket, event_name: eventMapping.eventName, qrCodeDataUrl, verifyUrl });
    }
  }
  
  // Send email if enabled
  if (autoSendEmails && createdTickets.length > 0 && customerEmail) {
    try {
      await sendTicketEmail({
        to: customerEmail,
        name: customerName,
        tickets: createdTickets
      });
      
      // Update tickets as sent
      const ticketIds = createdTickets.map(t => t.id);
      await db.query(
        'UPDATE tickets SET email_sent = true, email_sent_at = NOW() WHERE id = ANY($1)',
        [ticketIds]
      );
      
      // Log email sends
      for (const ticket of createdTickets) {
        await db.query(
          'INSERT INTO email_send_log (recipient_email, ticket_id, send_type, success) VALUES ($1, $2, $3, $4)',
          [customerEmail, ticket.id, 'shopify_order_retry', true]
        );
      }
    } catch (emailError) {
      console.error('Email send failed during retry:', emailError);
      // Continue processing even if email fails
    }
  }
  
  // Update webhook log
  await db.query(
    `UPDATE webhook_logs 
     SET processed = TRUE, 
         processed_at = NOW(), 
         tickets_created = $1
     WHERE id = $2`,
    [createdTickets.length, webhookLogId]
  );
  
  return {
    tickets_created: createdTickets.length,
    email_sent: autoSendEmails && customerEmail && createdTickets.length > 0
  };
}

async function retryRefund(webhookData, webhookLogId) {
  const { sendAdminNotification } = require('../services/email');
  const { order_id, refund_line_items, transactions } = webhookData; // Fixed: use order_id instead of id
  
  console.log(`💰 Retrying refund for order ${order_id}`);
  console.log(`   Refund line items: ${refund_line_items?.length || 0}`);
  console.log(`   Transactions: ${transactions?.length || 0}`);
  
  // Find tickets for this order
  const ticketsResult = await db.query(
    'SELECT id, uuid, name, email FROM tickets WHERE shopify_order_id = $1',
    [String(order_id)]
  );
  
  if (ticketsResult.rows.length === 0) {
    await db.query(
      `UPDATE webhook_logs 
       SET processed = TRUE, 
           processed_at = NOW(), 
           error_message = $1
       WHERE id = $2`,
      ['No tickets found for this order', webhookLogId]
    );
    
    return { message: 'No tickets found for this order' };
  }
  
  // Update tickets to refunded status
  const updateResult = await db.query(
    'UPDATE tickets SET status = $1 WHERE shopify_order_id = $2 RETURNING id, uuid, status',
    ['refunded', String(order_id)]
  );
  
  // Send admin notification
  const ticketList = ticketsResult.rows.map(t => 
    `- ${t.name} (${t.email}) - UUID: ${t.uuid}`
  ).join('\n');
  
  try {
    await sendAdminNotification({
      subject: `Order Refunded - ${updateResult.rows.length} Ticket(s) Invalidated`,
      message: `Order #${order_id} has been refunded (retry processing).`,
      ticketDetails: `The following tickets have been marked as refunded:\n\n${ticketList}\n\nRefund Details:\nRefund Line Items: ${refund_line_items?.length || 0}\nTransactions: ${transactions?.length || 0}\n\nFirst Transaction: ${JSON.stringify(transactions?.[0], null, 2)}`
    });
  } catch (emailError) {
    console.error('Admin notification failed during retry:', emailError);
  }
  
  // Update webhook log
  await db.query(
    `UPDATE webhook_logs 
     SET processed = TRUE, 
         processed_at = NOW(), 
         tickets_created = $1
     WHERE id = $2`,
    [updateResult.rows.length, webhookLogId]
  );
  
  return {
    tickets_updated: updateResult.rows.length,
    status: 'refunded'
  };
}

async function retryCancel(webhookData, webhookLogId) {
  const { sendAdminNotification } = require('../services/email');
  const { id: refund_id, order_id, refund_line_items } = webhookData;
  
  // Find tickets for this order
  const ticketsResult = await db.query(
    'SELECT id, uuid, name, email FROM tickets WHERE shopify_order_id = $1',
    [String(order_id)]
  );
  
  if (ticketsResult.rows.length === 0) {
    await db.query(
      `UPDATE webhook_logs 
       SET processed = TRUE, 
           processed_at = NOW(), 
           error_message = $1
       WHERE id = $2`,
      ['No tickets found for this order', webhookLogId]
    );
    
    return { message: 'No tickets found for this order' };
  }
  
  // Update tickets to cancelled status
  const updateResult = await db.query(
    'UPDATE tickets SET status = $1 WHERE shopify_order_id = $2 RETURNING id, uuid, status',
    ['cancelled', String(order_id)]
  );
  
  // Send admin notification
  const ticketList = ticketsResult.rows.map(t => 
    `- ${t.name} (${t.email}) - UUID: ${t.uuid}`
  ).join('\n');
  
  try {
    await sendAdminNotification({
      subject: `Order Cancelled - ${updateResult.rows.length} Ticket(s) Invalidated`,
      message: `Order #${order_id} has been cancelled (retry processing).`,
      ticketDetails: `The following tickets have been marked as cancelled:\n\n${ticketList}\n\nCancellation Details:\nRefund ID: ${refund_id}\nLine Items: ${refund_line_items?.length || 0}`
    });
  } catch (emailError) {
    console.error('Admin notification failed during retry:', emailError);
  }
  
  // Update webhook log
  await db.query(
    `UPDATE webhook_logs 
     SET processed = TRUE, 
         processed_at = NOW(), 
         tickets_created = $1
     WHERE id = $2`,
    [updateResult.rows.length, webhookLogId]
  );
  
  return {
    tickets_updated: updateResult.rows.length,
    status: 'cancelled'
  };
}

async function retryChargeback(webhookData, webhookLogId) {
  const { sendAdminNotification } = require('../services/email');
  const { id: dispute_id, order_id } = webhookData;
  
  // Find tickets for this order
  const ticketsResult = await db.query(
    'SELECT id, uuid, name, email FROM tickets WHERE shopify_order_id = $1',
    [String(order_id)]
  );
  
  if (ticketsResult.rows.length === 0) {
    await db.query(
      `UPDATE webhook_logs 
       SET processed = TRUE, 
           processed_at = NOW(), 
           error_message = $1
       WHERE id = $2`,
      ['No tickets found for this order', webhookLogId]
    );
    
    return { message: 'No tickets found for this order' };
  }
  
  // Update tickets to chargeback status
  const updateResult = await db.query(
    'UPDATE tickets SET status = $1 WHERE shopify_order_id = $2 RETURNING id, uuid, status',
    ['chargeback', String(order_id)]
  );
  
  // Send admin notification
  const ticketList = ticketsResult.rows.map(t => 
    `- ${t.name} (${t.email}) - UUID: ${t.uuid}`
  ).join('\n');
  
  try {
    await sendAdminNotification({
      subject: `⚠️ CHARGEBACK ALERT - ${updateResult.rows.length} Ticket(s) Invalidated`,
      message: `A chargeback/dispute has been filed for Order #${order_id} (retry processing).`,
      ticketDetails: `The following tickets have been marked as chargeback:\n\n${ticketList}\n\nDispute ID: ${dispute_id}\n\nPlease review this case immediately.`
    });
  } catch (emailError) {
    console.error('Admin notification failed during retry:', emailError);
  }
  
  // Update webhook log
  await db.query(
    `UPDATE webhook_logs 
     SET processed = TRUE, 
         processed_at = NOW(), 
         tickets_created = $1
     WHERE id = $2`,
    [updateResult.rows.length, webhookLogId]
  );
  
  return {
    tickets_updated: updateResult.rows.length,
    status: 'chargeback'
  };
}

module.exports = router;
