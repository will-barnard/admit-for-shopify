const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { sendTicketEmail, sendAdminNotification } = require('../services/email');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const checkLockdown = require('../middleware/lockdown');

// Middleware to validate Shopify Flow API key
const validateApiKey = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];

  if (!apiKey || apiKey !== process.env.SHOPIFY_API_KEY) {
    console.log('❌ 401 Unauthorized: Invalid or missing X-API-Key header');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
};

// POST endpoint for Shopify to create attendee tickets
router.post('/create-ticket', validateApiKey, checkLockdown, async (req, res) => {
  let webhookLogId = null;
  
  const { line_items, customer, id: order_id } = req.body;

  // Validate required fields
  if (!line_items || !Array.isArray(line_items)) {
    console.log('❌ 400 Bad Request: Missing or invalid line_items array');
    
    // Log failed webhook
    if (webhookLogId === null) {
      try {
        const logResult = await db.query(
          `INSERT INTO webhook_logs (shopify_order_id, webhook_data, processed, error_message, webhook_type, created_at) 
           VALUES ($1, $2, FALSE, $3, $4, NOW()) 
           RETURNING id`,
          [order_id ? String(order_id) : null, JSON.stringify(req.body), 'Missing or invalid line_items array', 'order_create']
        );
        webhookLogId = logResult.rows[0].id;
      } catch (logErr) {
        console.error('Failed to log webhook error:', logErr);
      }
    }
    
    return res.status(400).json({ 
      error: 'Missing required field: line_items must be an array' 
    });
  }

  if (!customer || !customer.first_name) {
    console.log('❌ 400 Bad Request: Missing customer information', { customer });
    
    // Log failed webhook
    if (webhookLogId === null) {
      try {
        const logResult = await db.query(
          `INSERT INTO webhook_logs (shopify_order_id, webhook_data, processed, error_message, webhook_type, created_at) 
           VALUES ($1, $2, FALSE, $3, $4, NOW()) 
           RETURNING id`,
          [order_id ? String(order_id) : null, JSON.stringify(req.body), 'Missing customer first_name', 'order_create']
        );
        webhookLogId = logResult.rows[0].id;
      } catch (logErr) {
        console.error('Failed to log webhook error:', logErr);
      }
    }
    
    return res.status(400).json({ 
      error: 'Missing required field: customer.first_name is required' 
    });
  }

  const shopify_order_id = order_id ? String(order_id) : null;
  const customerName = `${customer.first_name} ${customer.last_name || ''}`.trim();
  const customerEmail = customer.email || null;

  // Log webhook to database FIRST (before any processing)
  try {
    const webhookLogResult = await db.query(
      `INSERT INTO webhook_logs (shopify_order_id, webhook_data, processed, webhook_type, created_at) 
       VALUES ($1, $2, FALSE, $3, NOW()) 
       RETURNING id`,
      [shopify_order_id, JSON.stringify(req.body), 'order_create']
    );
    webhookLogId = webhookLogResult.rows[0].id;
    console.log(`📝 Webhook logged with ID: ${webhookLogId}`);
  } catch (logError) {
    console.error('❌ Failed to log webhook to database:', logError);
    // Continue processing even if logging fails
  }

  console.log(`📦 Processing order ${shopify_order_id} for ${customerName} (${customerEmail})`);
  console.log(`   Found ${line_items.length} line item(s) in order`);

  try {
    // Check for duplicate order - prevent creating tickets multiple times if webhook is sent again
    if (shopify_order_id) {
      const duplicateCheck = await db.query(
        'SELECT id, uuid, shopify_order_id, email_sent FROM tickets WHERE shopify_order_id = $1',
        [shopify_order_id]
      );
      
      if (duplicateCheck.rows.length > 0) {
        console.log(`Duplicate Shopify order detected: ${shopify_order_id}. Returning existing tickets.`);
        
        // Mark webhook as processed (duplicate)
        if (webhookLogId) {
          try {
            await db.query(
              `UPDATE webhook_logs 
               SET processed = TRUE, 
                   processed_at = NOW(), 
                   tickets_created = $1,
                   error_message = 'Duplicate order - tickets already exist'
               WHERE id = $2`,
              [duplicateCheck.rows.length, webhookLogId]
            );
          } catch (updateError) {
            console.error('Failed to update webhook log:', updateError);
          }
        }
        
        return res.status(200).json({
          success: true,
          message: 'Order already processed',
          duplicate: true,
          tickets: duplicateCheck.rows.map(ticket => ({
            id: ticket.id,
            uuid: ticket.uuid,
            shopify_order_id: ticket.shopify_order_id,
            email_sent: ticket.email_sent
          }))
        });
      }
    }

    // Look up all active events and build SKU->event mapping from database
    const eventsResult = await db.query('SELECT id, name, sku FROM events WHERE active = true');
    const skuToEvent = new Map();
    eventsResult.rows.forEach(event => {
      if (event.sku) skuToEvent.set(event.sku.toLowerCase(), event);
    });

    // Filter line items that have matching event SKUs
    const ticketLineItems = line_items.filter(item => {
      const sku = item.sku?.toLowerCase();
      return sku && skuToEvent.has(sku);
    });

    console.log(`🎫 Found ${ticketLineItems.length} ticket line item(s) to process`);

    if (ticketLineItems.length === 0) {
      console.log('ℹ️  No ticket items found in this order. Skipping ticket creation.');
      
      // Mark webhook as processed (no tickets to create)
      if (webhookLogId) {
        try {
          await db.query(
            `UPDATE webhook_logs 
             SET processed = TRUE, 
                 processed_at = NOW(), 
                 tickets_created = 0,
                 error_message = 'No ticket items found in order'
             WHERE id = $1`,
            [webhookLogId]
          );
        } catch (updateError) {
          console.error('Failed to update webhook log:', updateError);
        }
      }
      
      return res.status(200).json({
        success: true,
        message: 'No ticket items found in order',
        tickets: []
      });
    }
    
    // Check if auto_send_emails is enabled
    const settingsResult = await db.query('SELECT auto_send_emails FROM settings LIMIT 1');
    const autoSendEmails = settingsResult.rows[0]?.auto_send_emails ?? true;

    const createdTickets = [];
    const failedTickets = [];

    // Process each ticket line item - Create all tickets first without sending emails
    for (const lineItem of ticketLineItems) {
      const sku = lineItem.sku.toLowerCase();
      const event = skuToEvent.get(sku);
      const quantity = lineItem.quantity || 1;

      console.log(`   Processing ${quantity}x ${lineItem.name} (SKU: ${sku} -> event: ${event.name})`);

      // Create multiple tickets if quantity > 1
      for (let i = 0; i < quantity; i++) {
        try {
          const uuid = uuidv4();
          
          // Insert ticket into database
          const result = await db.query(
            `INSERT INTO tickets (event_id, name, email, uuid, shopify_order_id, email_sent, created_at) 
             VALUES ($1, $2, $3, $4, $5, $6, NOW()) 
             RETURNING *`,
            [event.id, customerName, customerEmail, uuid, shopify_order_id, false]
          );

          const ticket = result.rows[0];

          // Generate QR code
          const frontendUrl = process.env.FRONTEND_URL || 'http://localhost';
          const verifyUrl = `${frontendUrl}/verify/${ticket.uuid}`;
          const qrCodeDataUrl = await QRCode.toDataURL(verifyUrl);

          createdTickets.push({
            ...ticket,
            event_name: event.name,
            qrCodeDataUrl,
            verifyUrl
          });

          console.log(`      ✓ Created ticket ${i + 1}/${quantity} for ${lineItem.name}`);
        } catch (ticketError) {
          console.error('Failed to create ticket:', ticketError);
          failedTickets.push({ sku, error: ticketError.message });
        }
      }
    }

    // Send one consolidated email with all tickets if auto_send_emails is enabled and email provided
    if (autoSendEmails && createdTickets.length > 0 && customerEmail) {
      try {
        // Check daily email limit before sending
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        
        const quotaResult = await db.query(
          'SELECT COUNT(*) as sent_today FROM email_send_log WHERE sent_at >= $1 AND success = true',
          [todayStart]
        );
        
        const sentToday = parseInt(quotaResult.rows[0].sent_today);
        const dailyLimit = 100;
        const remaining = dailyLimit - sentToday;
        
        if (remaining > 0) {
          // We have quota remaining, send the email
          await sendTicketEmail({
            to: customerEmail,
            name: customerName,
            tickets: createdTickets
          });
          
          // Update email_sent status for all tickets
          const ticketIds = createdTickets.map(t => t.id);
          await db.query(
            'UPDATE tickets SET email_sent = true, email_sent_at = NOW() WHERE id = ANY($1)',
            [ticketIds]
          );
          
          // Log the email send
          for (const ticket of createdTickets) {
            await db.query(
              'INSERT INTO email_send_log (recipient_email, ticket_id, send_type, success) VALUES ($1, $2, $3, $4)',
              [customerEmail, ticket.id, 'shopify_order', true]
            );
          }
          
          console.log(`📧 Sent consolidated email with ${createdTickets.length} ticket(s) to ${customerEmail}`);
        } else {
          // Daily limit reached, leave tickets marked as unsent
          console.log(`⚠️  Daily email limit reached (${sentToday}/${dailyLimit}). Tickets created but email NOT sent. Use batch send tomorrow.`);
          
          // Send admin notification about hitting the limit
          try {
            await sendAdminNotification({
              subject: 'Daily Email Limit Reached - Tickets Created Without Email',
              message: `A Shopify order was processed but the email was not sent because the daily limit of ${dailyLimit} emails has been reached.`,
              ticketDetails: `Order ID: ${shopify_order_id}\nCustomer: ${customerName} <${customerEmail}>\nTickets Created: ${createdTickets.length}\nEmails Sent Today: ${sentToday}/${dailyLimit}\n\nThe tickets are saved in the database and marked as unsent. Use the batch send feature tomorrow to send these tickets.`
            });
          } catch (notifyError) {
            console.error('Failed to send admin notification:', notifyError);
          }
        }
      } catch (emailError) {
        console.error('Failed to send ticket email:', emailError);
        
        // Send admin notification about the bounce/failure
        try {
          await sendAdminNotification({
            subject: 'Shopify Order Email Delivery Failure',
            message: 'A ticket email from a Shopify order failed to send. The recipient may have an invalid email address or the email server rejected the message.',
            ticketDetails: `Recipient: ${customerName} <${customerEmail}>\nOrder ID: ${shopify_order_id}\nTicket Count: ${createdTickets.length}\nError: ${emailError.message}`
          });
        } catch (notifyError) {
          console.error('Failed to send admin notification:', notifyError);
        }
      }
    } else if (autoSendEmails && createdTickets.length > 0 && !customerEmail) {
      console.log('ℹ️  No email provided for Shopify order - tickets created without sending email');
    }

    console.log(`✅ Successfully created ${createdTickets.length} ticket(s) from order ${shopify_order_id}`);

    // Mark webhook as processed in database
    if (webhookLogId) {
      try {
        await db.query(
          `UPDATE webhook_logs 
           SET processed = TRUE, 
               processed_at = NOW(), 
               tickets_created = $1
           WHERE id = $2`,
          [createdTickets.length, webhookLogId]
        );
        console.log(`✅ Webhook ${webhookLogId} marked as processed`);
      } catch (updateError) {
        console.error('Failed to update webhook log:', updateError);
      }
    }

    res.status(201).json({
      success: true,
      message: `Successfully created ${createdTickets.length} ticket(s)`,
      tickets: createdTickets,
      failed: failedTickets.length > 0 ? failedTickets : undefined
    });

  } catch (error) {
    console.error('Error processing Shopify order:', error);
    
    // Update webhook log with error
    if (webhookLogId) {
      try {
        await db.query(
          `UPDATE webhook_logs 
           SET error_message = $1 
           WHERE id = $2`,
          [error.message || 'Unknown error processing webhook', webhookLogId]
        );
      } catch (updateError) {
        console.error('Failed to update webhook log with error:', updateError);
      }
    }
    
    res.status(500).json({ error: 'Failed to process order' });
  }
});

// POST endpoint for Shopify order refunds
router.post('/refund', validateApiKey, async (req, res) => {
  let webhookLogId = null;
  
  const { order_id, refund_line_items, transactions } = req.body; // Fixed: use order_id instead of id
  
  try {
    console.log(`💰 Processing refund for order ${order_id}`);
    console.log(`   Refund line items: ${refund_line_items?.length || 0}`);
    console.log(`   Transactions: ${transactions?.length || 0}`);
    
    // Log webhook
    const logResult = await db.query(
      `INSERT INTO webhook_logs (shopify_order_id, webhook_data, processed, webhook_type, created_at) 
       VALUES ($1, $2, FALSE, $3, NOW()) 
       RETURNING id`,
      [order_id ? String(order_id) : null, JSON.stringify(req.body), 'refund']
    );
    webhookLogId = logResult.rows[0].id;
    
    // Check if order has tickets in our system
    const ticketsResult = await db.query(
      'SELECT id, uuid, name, email FROM tickets WHERE shopify_order_id = $1',
      [String(order_id)]
    );
    
    if (ticketsResult.rows.length === 0) {
      console.log(`⚠️  No tickets found for order ${order_id}`);
      
      await db.query(
        `UPDATE webhook_logs 
         SET processed = TRUE, 
             processed_at = NOW(), 
             error_message = $1
         WHERE id = $2`,
        ['No tickets found for this order', webhookLogId]
      );
      
      return res.status(200).json({ 
        message: 'No tickets found for this order',
        order_id 
      });
    }
    
    console.log(`🔄 Attempting to mark ${ticketsResult.rows.length} ticket(s) as refunded for order ${order_id}`);
    
    // Update all tickets for this order to refunded status
    const updateResult = await db.query(
      'UPDATE tickets SET status = $1 WHERE shopify_order_id = $2 RETURNING id, uuid, status',
      ['refunded', String(order_id)]
    );
    
    console.log(`✅ Successfully updated ${updateResult.rows.length} ticket(s) to refunded status:`);
    updateResult.rows.forEach(ticket => {
      console.log(`   - Ticket ${ticket.id} (${ticket.uuid}) -> status: ${ticket.status}`);
    });
    
    // Send admin notification
    const ticketList = ticketsResult.rows.map(t => 
      `- ${t.name} (${t.email}) - UUID: ${t.uuid}`
    ).join('\n');
    
    await sendAdminNotification({
      subject: `Order Refunded - ${ticketsResult.rows.length} Ticket(s) Invalidated`,
      message: `Order #${order_id} has been refunded.`,
      ticketDetails: `The following tickets have been marked as refunded:\n\n${ticketList}\n\nRefund Details:\nRefund Line Items: ${refund_line_items?.length || 0}\nTransactions: ${transactions?.length || 0}\n\nFirst Transaction: ${JSON.stringify(transactions?.[0], null, 2)}`
    });
    
    // Mark webhook as processed
    await db.query(
      `UPDATE webhook_logs 
       SET processed = TRUE, 
           processed_at = NOW(), 
           tickets_created = $1
       WHERE id = $2`,
      [updateResult.rows.length, webhookLogId]
    );
    
    res.status(200).json({
      success: true,
      message: `Marked ${updateResult.rows.length} ticket(s) as refunded`,
      tickets_updated: updateResult.rows.length,
      updated_tickets: updateResult.rows.map(t => ({ id: t.id, uuid: t.uuid, status: t.status }))
    });
    
  } catch (error) {
    console.error('Error processing refund webhook:', error);
    
    if (webhookLogId) {
      await db.query(
        `UPDATE webhook_logs 
         SET error_message = $1 
         WHERE id = $2`,
        [error.message || 'Unknown error processing refund webhook', webhookLogId]
      );
    }
    
    res.status(500).json({ error: 'Failed to process refund' });
  }
});

// POST endpoint for Shopify disputes/chargebacks
router.post('/chargeback', validateApiKey, async (req, res) => {
  let webhookLogId = null;
  
  const { id: dispute_id, order_id } = req.body;
  
  try {
    // Log webhook
    const logResult = await db.query(
      `INSERT INTO webhook_logs (shopify_order_id, webhook_data, processed, webhook_type, created_at) 
       VALUES ($1, $2, FALSE, $3, NOW()) 
       RETURNING id`,
      [order_id ? String(order_id) : null, JSON.stringify(req.body), 'chargeback']
    );
    webhookLogId = logResult.rows[0].id;
    
    // Check if order has tickets in our system
    const ticketsResult = await db.query(
      'SELECT id, uuid, name, email FROM tickets WHERE shopify_order_id = $1',
      [String(order_id)]
    );
    
    if (ticketsResult.rows.length === 0) {
      console.log(`⚠️  No tickets found for order ${order_id}`);
      
      await db.query(
        `UPDATE webhook_logs 
         SET processed = TRUE, 
             processed_at = NOW(), 
             error_message = $1
         WHERE id = $2`,
        ['No tickets found for this order', webhookLogId]
      );
      
      return res.status(200).json({ 
        message: 'No tickets found for this order',
        order_id 
      });
    }
    
    // Update all tickets for this order to chargeback status
    await db.query(
      'UPDATE tickets SET status = $1 WHERE shopify_order_id = $2',
      ['chargeback', String(order_id)]
    );
    
    console.log(`⚠️  Marked ${ticketsResult.rows.length} ticket(s) as chargeback for order ${order_id}`);
    
    // Send admin notification
    const ticketList = ticketsResult.rows.map(t => 
      `- ${t.name} (${t.email}) - UUID: ${t.uuid}`
    ).join('\n');
    
    await sendAdminNotification({
      subject: `⚠️ CHARGEBACK ALERT - ${ticketsResult.rows.length} Ticket(s) Invalidated`,
      message: `A chargeback/dispute has been filed for Order #${order_id}.`,
      ticketDetails: `The following tickets have been marked as chargeback:\n\n${ticketList}\n\nDispute ID: ${dispute_id}\n\nPlease review this case immediately.`
    });
    
    // Mark webhook as processed
    await db.query(
      `UPDATE webhook_logs 
       SET processed = TRUE, 
           processed_at = NOW(), 
           tickets_created = $1
       WHERE id = $2`,
      [ticketsResult.rows.length, webhookLogId]
    );
    
    res.status(200).json({
      success: true,
      message: `Marked ${ticketsResult.rows.length} ticket(s) as chargeback`,
      tickets_updated: ticketsResult.rows.length
    });
    
  } catch (error) {
    console.error('Error processing chargeback webhook:', error);
    
    if (webhookLogId) {
      await db.query(
        `UPDATE webhook_logs 
         SET error_message = $1 
         WHERE id = $2`,
        [error.message || 'Unknown error processing chargeback webhook', webhookLogId]
      );
    }
    
    res.status(500).json({ error: 'Failed to process chargeback' });
  }
});

// POST endpoint for Shopify order cancellations
router.post('/cancel', validateApiKey, async (req, res) => {
  let webhookLogId = null;
  
  const { id: refund_id, order_id, refund_line_items } = req.body;
  
  try {
    // Log webhook
    const logResult = await db.query(
      `INSERT INTO webhook_logs (shopify_order_id, webhook_data, processed, webhook_type, created_at) 
       VALUES ($1, $2, FALSE, $3, NOW()) 
       RETURNING id`,
      [order_id ? String(order_id) : null, JSON.stringify(req.body), 'cancel']
    );
    webhookLogId = logResult.rows[0].id;
    
    // Check if order has tickets in our system
    const ticketsResult = await db.query(
      'SELECT id, uuid, name, email FROM tickets WHERE shopify_order_id = $1',
      [String(order_id)]
    );
    
    if (ticketsResult.rows.length === 0) {
      console.log(`⚠️  No tickets found for order ${order_id}`);
      
      await db.query(
        `UPDATE webhook_logs 
         SET processed = TRUE, 
             processed_at = NOW(), 
             error_message = $1
         WHERE id = $2`,
        ['No tickets found for this order', webhookLogId]
      );
      
      return res.status(200).json({ 
        message: 'No tickets found for this order',
        order_id 
      });
    }
    
    console.log(`🔄 Attempting to mark ${ticketsResult.rows.length} ticket(s) as cancelled for order ${order_id}`);
    
    // Update all tickets for this order to cancelled status
    const updateResult = await db.query(
      'UPDATE tickets SET status = $1 WHERE shopify_order_id = $2 RETURNING id, uuid, status',
      ['cancelled', String(order_id)]
    );
    
    console.log(`✅ Successfully updated ${updateResult.rows.length} ticket(s) to cancelled status:`);
    updateResult.rows.forEach(ticket => {
      console.log(`   - Ticket ${ticket.id} (${ticket.uuid}) -> status: ${ticket.status}`);
    });
    
    // Send admin notification
    const ticketList = ticketsResult.rows.map(t => 
      `- ${t.name} (${t.email}) - UUID: ${t.uuid}`
    ).join('\n');
    
    await sendAdminNotification({
      subject: `Order Cancelled - ${ticketsResult.rows.length} Ticket(s) Invalidated`,
      message: `Order #${order_id} has been cancelled.`,
      ticketDetails: `The following tickets have been marked as cancelled:\n\n${ticketList}\n\nCancellation Details:\nRefund ID: ${refund_id}\nLine Items: ${refund_line_items?.length || 0}`
    });
    
    // Mark webhook as processed
    await db.query(
      `UPDATE webhook_logs 
       SET processed = TRUE, 
           processed_at = NOW(), 
           tickets_created = $1
       WHERE id = $2`,
      [updateResult.rows.length, webhookLogId]
    );
    
    res.status(200).json({
      success: true,
      message: `Marked ${updateResult.rows.length} ticket(s) as cancelled`,
      tickets_updated: updateResult.rows.length,
      updated_tickets: updateResult.rows.map(t => ({ id: t.id, uuid: t.uuid, status: t.status }))
    });
    
  } catch (error) {
    console.error('Error processing cancel webhook:', error);
    
    if (webhookLogId) {
      await db.query(
        `UPDATE webhook_logs 
         SET error_message = $1 
         WHERE id = $2`,
        [error.message || 'Unknown error processing cancel webhook', webhookLogId]
      );
    }
    
    res.status(500).json({ error: 'Failed to process cancellation' });
  }
});

// Debug endpoint to see recent webhook activity
router.get('/debug/webhooks', async (req, res) => {
  try {
    const recentWebhooks = await db.query(`
      SELECT 
        id, 
        shopify_order_id, 
        webhook_type, 
        processed, 
        error_message, 
        tickets_created,
        created_at,
        processed_at
      FROM webhook_logs 
      ORDER BY created_at DESC 
      LIMIT 20
    `);
    
    const ticketCounts = await db.query(`
      SELECT 
        status, 
        COUNT(*) as count 
      FROM tickets 
      GROUP BY status
    `);
    
    res.json({
      recent_webhooks: recentWebhooks.rows,
      ticket_status_counts: ticketCounts.rows,
      debug_info: {
        current_time: new Date().toISOString(),
        webhook_endpoints: [
          '/api/shopify/create-ticket',
          '/api/shopify/refund', 
          '/api/shopify/cancel',
          '/api/shopify/chargeback'
        ]
      }
    });
  } catch (error) {
    console.error('Error in debug endpoint:', error);
    res.status(500).json({ error: 'Debug endpoint failed', message: error.message });
  }
});

// Health check endpoint (doesn't require API key)
router.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'shopify-integration' });
});

module.exports = router;
