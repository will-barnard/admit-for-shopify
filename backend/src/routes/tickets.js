const express = require('express');
const { body, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const db = require('../config/database');
const authMiddleware = require('../middleware/auth');
const superAdminMiddleware = require('../middleware/superadmin');
const checkLockdown = require('../middleware/lockdown');
const emailService = require('../services/email');

const router = express.Router();

// Get all tickets (protected)
router.get('/', authMiddleware, async (req, res) => {
  try {
    // This used to fetch every ticket and every scan, then run
    // scans.filter(...) once per ticket - O(tickets x scans) in JavaScript, on
    // every load of the tickets page. A LATERAL join asks the database for the
    // first scan per ticket instead, which is one indexed lookup each.
    //
    // The earliest scan is now the one reported. The old code took whichever
    // row the filter happened to yield first, with no ORDER BY, so "scanned on"
    // could change between requests for a re-scanned ticket.
    const ticketsResult = await db.query(
      `SELECT t.id, t.event_id, t.ticket_type_id, t.name, t.email, t.uuid, t.is_used,
              t.email_sent, t.status, t.shopify_order_id, t.created_at,
              e.name as event_name,
              e.archived as event_archived,
              tt.name as ticket_type_name,
              s.scan_date, s.scanned_by_user_id, s.scanned_by_username
       FROM tickets t
       LEFT JOIN events e ON t.event_id = e.id AND e.shop_id = t.shop_id
       LEFT JOIN event_ticket_types tt ON tt.id = t.ticket_type_id AND tt.shop_id = t.shop_id
       LEFT JOIN LATERAL (
         SELECT ts.scan_date, ts.scanned_by_user_id, u.username AS scanned_by_username
           FROM ticket_scans ts
           LEFT JOIN users u ON ts.scanned_by_user_id = u.id
          WHERE ts.ticket_id = t.id AND ts.shop_id = t.shop_id
          ORDER BY ts.scan_date, ts.id
          LIMIT 1
       ) s ON TRUE
       WHERE t.shop_id = $1
       ORDER BY t.created_at DESC`,
      [req.shopId]
    );

    const checkInsResult = await db.query(
      'SELECT COUNT(*)::int AS total FROM ticket_scans WHERE shop_id = $1',
      [req.shopId]
    );

    const tickets = ticketsResult.rows.map((row) => {
      const { scan_date, scanned_by_user_id, scanned_by_username, ...ticket } = row;
      return {
        ...ticket,
        scans: {
          scanned: scan_date !== null,
          scannedOn: scan_date,
          scannedBy: scan_date === null ? null : {
            userId: scanned_by_user_id,
            username: scanned_by_username,
          },
        },
      };
    });

    res.json({ tickets, totalCheckIns: checkInsResult.rows[0].total });
  } catch (error) {
    console.error('Error fetching tickets:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create single ticket (protected)
router.post('/',
  authMiddleware,
  checkLockdown,
  body('eventId').isInt(),
  body('name').trim().notEmpty(),
  body('email').isEmail(),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { eventId, name, email } = req.body;

      // Verify event exists
      const eventResult = await db.query(
        'SELECT id, name FROM events WHERE id = $1 AND shop_id = $2',
        [eventId, req.shopId]
      );
      if (eventResult.rows.length === 0) {
        return res.status(400).json({ error: 'Event not found' });
      }

      const settingsResult = await db.query('SELECT auto_send_emails FROM settings WHERE shop_id = $1', [req.shopId]);
      const autoSendEmails = settingsResult.rows.length > 0 ? settingsResult.rows[0].auto_send_emails : true;

      const ticketUuid = uuidv4();
      const verifyUrl = `${process.env.FRONTEND_URL}/verify/${ticketUuid}`;

      const result = await db.query(
        `INSERT INTO tickets (shop_id, event_id, ticket_type_id, name, email, uuid)
         VALUES ($1, $2,
           COALESCE($3, (SELECT id FROM event_ticket_types
                          WHERE event_id = $2 AND shop_id = $1 AND active = true
                          ORDER BY sort_order, id LIMIT 1)),
           $4, $5, $6) RETURNING *`,
        [req.shopId, eventId, req.body.ticketTypeId || null, name, email, ticketUuid]
      );

      const ticket = result.rows[0];
      const qrCodeDataUrl = await QRCode.toDataURL(verifyUrl);

      let emailSent = false;
      let emailError = null;

      if (autoSendEmails) {
        try {
          await emailService.sendTicketEmail({
            to: email,
            name: name,
            tickets: [{ ...ticket, qrCodeDataUrl, verifyUrl, event_name: eventResult.rows[0].name }],
            shopId: req.shopId
          });
          emailSent = true;
          await db.query('UPDATE tickets SET email_sent = true, email_sent_at = NOW() WHERE id = $1 AND shop_id = $2', [ticket.id, req.shopId]);
        } catch (emailErr) {
          console.error('Error sending email:', emailErr);
          emailError = 'Email could not be sent';
        }
      }

      res.status(201).json({
        message: emailSent ? 'Ticket created and sent successfully' : 'Ticket created but email delivery failed',
        ticketCount: 1,
        tickets: [{ id: ticket.id, uuid: ticket.uuid, email_sent: emailSent }],
        warning: emailError
      });
    } catch (error) {
      console.error('Error creating ticket:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// Create order with multiple tickets (protected)
router.post('/create-order',
  authMiddleware,
  checkLockdown,
  body('customerName').trim().notEmpty(),
  body('email').optional({ nullable: true, checkFalsy: true }).isEmail(),
  body('tickets').isArray({ min: 1 }),
  body('tickets.*.eventId').isInt(),
  body('tickets.*.name').trim().notEmpty(),
  body('tickets.*.quantity').isInt({ min: 1, max: 50 }),
  body('tickets.*.attendeeNames').optional().isArray({ max: 50 }),
  body('tickets.*.attendeeNames.*').optional({ nullable: true }).isString().trim(),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { customerName, email, tickets: ticketItems } = req.body;
      const customerEmail = email || null;

      // Validate all events exist
      for (const ticketItem of ticketItems) {
        const eventResult = await db.query(
          'SELECT id, name FROM events WHERE id = $1 AND shop_id = $2',
          [ticketItem.eventId, req.shopId]
        );
        if (eventResult.rows.length === 0) {
          return res.status(400).json({ error: 'Event not found: ' + ticketItem.eventId });
        }

        // A ticket type is only valid for the event it belongs to. The foreign
        // key alone would happily accept another event's type - or another
        // shop's - so check it here rather than trusting the client.
        if (ticketItem.ticketTypeId) {
          const typeResult = await db.query(
            'SELECT id FROM event_ticket_types WHERE id = $1 AND event_id = $2 AND shop_id = $3',
            [ticketItem.ticketTypeId, ticketItem.eventId, req.shopId]
          );
          if (typeResult.rows.length === 0) {
            return res.status(400).json({
              error: 'Ticket type ' + ticketItem.ticketTypeId + ' does not belong to event ' + ticketItem.eventId,
            });
          }
        }
      }

      const manualOrderId = `manual-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      const settingsResult = await db.query('SELECT auto_send_emails FROM settings WHERE shop_id = $1', [req.shopId]);
      const autoSendEmails = settingsResult.rows.length > 0 ? settingsResult.rows[0].auto_send_emails : true;

      const createdTickets = [];
      let emailError = null;

      // Preload event names
      const eventIds = [...new Set(ticketItems.map(t => t.eventId))];
      const eventsResult = await db.query(
        'SELECT id, name FROM events WHERE id = ANY($1) AND shop_id = $2',
        [eventIds, req.shopId]
      );
      const eventMap = {};
      eventsResult.rows.forEach(e => { eventMap[e.id] = e.name; });

      for (const ticketItem of ticketItems) {
        const { eventId, name, quantity } = ticketItem;
        const ticketQuantity = quantity || 1;

        // One name per LINE was the only option, so quantity 5 produced five
        // tickets all called the same thing. Fine for a family; wrong for a
        // company buying five passes, where the door needs to know who is who.
        // attendeeNames is optional and positional - a blank entry, or none at
        // all, falls back to the line's name, so the simple case is unchanged.
        const attendeeNames = Array.isArray(ticketItem.attendeeNames) ? ticketItem.attendeeNames : [];

        for (let i = 0; i < ticketQuantity; i++) {
          const attendeeName = String(attendeeNames[i] ?? '').trim() || name;
          const ticketUuid = uuidv4();
          const verifyUrl = `${process.env.FRONTEND_URL}/verify/${ticketUuid}`;

          const result = await db.query(
            `INSERT INTO tickets (shop_id, event_id, ticket_type_id, name, email, uuid, shopify_order_id)
             VALUES ($1, $2,
               COALESCE($3, (SELECT id FROM event_ticket_types
                              WHERE event_id = $2 AND shop_id = $1 AND active = true
                              ORDER BY sort_order, id LIMIT 1)),
               $4, $5, $6, $7) RETURNING *`,
            [req.shopId, eventId, ticketItem.ticketTypeId || null, attendeeName, customerEmail, ticketUuid, manualOrderId]
          );
          const ticket = result.rows[0];
          const qrCodeDataUrl = await QRCode.toDataURL(verifyUrl);
          
          createdTickets.push({
            ...ticket,
            event_name: eventMap[eventId],
            qrCodeDataUrl,
            verifyUrl
          });
        }
      }

      let emailSent = false;
      
      if (autoSendEmails && customerEmail) {
        try {
          const todayStart = new Date();
          todayStart.setHours(0, 0, 0, 0);
          
          const quotaResult = await db.query(
            'SELECT COUNT(*) as sent_today FROM email_send_log WHERE shop_id = $1 AND sent_at >= $2 AND success = true',
            [req.shopId, todayStart]
          );
          
          const sentToday = parseInt(quotaResult.rows[0].sent_today);
          const dailyLimit = 100;
          const remaining = dailyLimit - sentToday;
          
          if (remaining > 0) {
            await emailService.sendTicketEmail({
              to: customerEmail,
              name: customerName,
              tickets: createdTickets,
              shopId: req.shopId
            });

            emailSent = true;

            const ticketIds = createdTickets.map(t => t.id);
            await db.query(
              'UPDATE tickets SET email_sent = true, email_sent_at = NOW() WHERE id = ANY($1) AND shop_id = $2',
              [ticketIds, req.shopId]
            );

            // One row per message sent, not per ticket - the daily quota counts
            // Resend messages. See services/shopify-orders.js.
            await db.query(
              'INSERT INTO email_send_log (shop_id, recipient_email, ticket_id, send_type, success) VALUES ($1, $2, $3, $4, $5)',
              [req.shopId, customerEmail, createdTickets[0].id, 'manual_order', true]
            );
          } else {
            emailError = `Daily email limit of ${dailyLimit} reached. Tickets created but email not sent.`;
          }
        } catch (emailErr) {
          console.error('Error sending email:', emailErr);
          emailError = 'Email could not be sent';
          
          try {
            await emailService.sendAdminNotification({
              subject: 'Email Delivery Failure',
              message: 'A ticket email failed to send.',
              ticketDetails: {
                recipientEmail: customerEmail,
                recipientName: customerName,
                ticketCount: createdTickets.length,
                error: emailErr.message || 'Unknown error'
              }
            });
          } catch (notificationErr) {
            console.error('Failed to send admin notification:', notificationErr);
          }
        }
      }

      const totalTickets = createdTickets.length;
      const responseMessage = !customerEmail
        ? `Order created with ${totalTickets} ticket(s) - no email provided`
        : (autoSendEmails 
          ? (emailSent ? `Order created with ${totalTickets} ticket(s) and sent successfully` : `Order created with ${totalTickets} ticket(s) but email delivery failed`)
          : `Order created with ${totalTickets} ticket(s) (email sending disabled)`);

      res.status(201).json({
        message: responseMessage,
        ticketCount: totalTickets,
        orderId: manualOrderId,
        tickets: createdTickets.map(t => ({
          id: t.id,
          uuid: t.uuid,
          email_sent: emailSent
        })),
        warning: emailError ? 'Email delivery failed' : null
      });
    } catch (error) {
      console.error('Error creating order:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// Reset database - Delete all tickets (SuperAdmin only)
router.delete('/reset-database', superAdminMiddleware, async (req, res) => {
  try {
    console.log('SuperAdmin initiated database reset - deleting all tickets');
    
    await db.query('DELETE FROM ticket_scans WHERE shop_id = $1', [req.shopId]);
    console.log('Deleted ticket scans for shop', req.shopId);

    const result = await db.query('DELETE FROM tickets WHERE shop_id = $1 RETURNING id', [req.shopId]);
    const deletedCount = result.rows.length;
    console.log(`Deleted ${deletedCount} tickets`);
    
    res.json({
      message: 'Database reset successful',
      deleted: { tickets: deletedCount, scans: 'all' }
    });
  } catch (error) {
    console.error('Error resetting database:', error);
    res.status(500).json({ error: 'Server error during database reset' });
  }
});

// Delete ticket (protected)
router.delete('/:id', authMiddleware, checkLockdown, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      'DELETE FROM tickets WHERE id = $1 AND shop_id = $2 RETURNING id',
      [id, req.shopId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    res.json({ message: 'Ticket deleted successfully' });
  } catch (error) {
    console.error('Error deleting ticket:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update ticket status (protected)
router.patch('/:id/status', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const validStatuses = ['valid', 'invalid', 'refunded', 'chargeback', 'cancelled'];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({ 
        error: 'Invalid status. Must be one of: ' + validStatuses.join(', ')
      });
    }

    const result = await db.query(
      'UPDATE tickets SET status = $1 WHERE id = $2 AND shop_id = $3 RETURNING id, status',
      [status, id, req.shopId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    res.json({ message: 'Ticket status updated successfully', ticket: result.rows[0] });
  } catch (error) {
    console.error('Error updating ticket status:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Edit ticket (Admin/SuperAdmin)
router.put('/:id', authMiddleware, checkLockdown, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  try {
    const { id } = req.params;
    const { name, email } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }

    const result = await db.query(
      'UPDATE tickets SET name = $1, email = $2 WHERE id = $3 AND shop_id = $4 RETURNING *',
      [name, email || null, id, req.shopId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    res.json({ message: 'Ticket updated successfully', ticket: result.rows[0] });
  } catch (error) {
    console.error('Error updating ticket:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Toggle scan status (Admin/SuperAdmin only)
router.post('/:id/scan-status', authMiddleware, checkLockdown, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  try {
    const { id } = req.params;
    const { action } = req.body;

    if (!action || !['mark', 'unmark'].includes(action)) {
      return res.status(400).json({ error: 'Action must be "mark" or "unmark"' });
    }

    const ticketResult = await db.query(
      'SELECT id FROM tickets WHERE id = $1 AND shop_id = $2',
      [id, req.shopId]
    );
    if (ticketResult.rows.length === 0) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    if (action === 'mark') {
      const scanCheck = await db.query(
        'SELECT id FROM ticket_scans WHERE ticket_id = $1 AND shop_id = $2',
        [id, req.shopId]
      );
      if (scanCheck.rows.length > 0) {
        return res.status(400).json({ error: 'Ticket is already marked as scanned' });
      }

      await db.query(
        'INSERT INTO ticket_scans (shop_id, ticket_id, scan_date, scanned_by_user_id) VALUES ($1, $2, NOW(), $3)',
        [req.shopId, id, req.user.id]
      );

      const scanResult = await db.query(
        `SELECT ts.scan_date, ts.scanned_by_user_id, u.username as scanned_by_username
         FROM ticket_scans ts LEFT JOIN users u ON ts.scanned_by_user_id = u.id
         WHERE ts.ticket_id = $1 AND ts.shop_id = $2`,
        [id, req.shopId]
      );

      res.json({
        message: 'Ticket marked as scanned',
        scanned: true,
        scannedOn: scanResult.rows[0].scan_date,
        scannedBy: {
          userId: scanResult.rows[0].scanned_by_user_id,
          username: scanResult.rows[0].scanned_by_username
        }
      });
    } else {
      const deleteResult = await db.query(
        'DELETE FROM ticket_scans WHERE ticket_id = $1 AND shop_id = $2',
        [id, req.shopId]
      );
      if (deleteResult.rowCount === 0) {
        return res.status(400).json({ error: 'Ticket was not scanned' });
      }

      res.json({ message: 'Ticket unmarked as scanned', scanned: false, scannedOn: null });
    }
  } catch (error) {
    console.error('Error toggling scan status:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get remaining daily email quota
router.get('/daily-email-quota', authMiddleware, async (req, res) => {
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    
    const result = await db.query(
      'SELECT COUNT(*) as sent_today FROM email_send_log WHERE shop_id = $1 AND sent_at >= $2 AND success = true',
      [req.shopId, todayStart]
    );

    const sentToday = parseInt(result.rows[0].sent_today);
    const dailyLimit = 100;
    const remaining = Math.max(0, dailyLimit - sentToday);

    res.json({ sentToday, dailyLimit, remaining });
  } catch (error) {
    console.error('Error getting daily email quota:', error);
    res.status(500).json({ error: 'Failed to get email quota' });
  }
});

// Batch send emails for unsent tickets (protected)
router.post('/batch-send-emails', authMiddleware, async (req, res) => {
  try {
    const { eventId } = req.body;
    
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    
    const quotaResult = await db.query(
      'SELECT COUNT(*) as sent_today FROM email_send_log WHERE shop_id = $1 AND sent_at >= $2 AND success = true',
      [req.shopId, todayStart]
    );

    const sentToday = parseInt(quotaResult.rows[0].sent_today);
    const dailyLimit = 100;
    const remaining = Math.max(0, dailyLimit - sentToday);
    const batchLimit = 85;
    
    if (remaining === 0) {
      return res.status(429).json({ 
        error: 'Daily email limit of 100 emails reached. Please try again tomorrow.',
        sentToday, dailyLimit, remaining: 0
      });
    }
    
    let query = `SELECT t.id, t.name, t.email, t.uuid, e.name as event_name
                 FROM tickets t
                 LEFT JOIN events e ON t.event_id = e.id AND e.shop_id = t.shop_id
                 WHERE t.shop_id = $1
                 AND (t.email_sent = false OR t.email_sent IS NULL)
                 AND t.email IS NOT NULL
                 AND (t.status IS NULL OR t.status = 'valid')`;
    const params = [req.shopId];

    if (eventId && eventId !== 'all') {
      query += ' AND t.event_id = $2';
      params.push(eventId);
    }
    
    query += ' ORDER BY t.created_at ASC';
    
    const ticketsResult = await db.query(query, params);

    if (ticketsResult.rows.length === 0) {
      return res.json({ message: 'No unsent emails found', sent: 0, failed: 0 });
    }

    // Group tickets by email
    const emailGroups = {};
    for (const ticket of ticketsResult.rows) {
      const emailKey = ticket.email.toLowerCase();
      if (!emailGroups[emailKey]) {
        emailGroups[emailKey] = [];
      }
      emailGroups[emailKey].push(ticket);
    }

    const effectiveLimit = Math.min(batchLimit, remaining);
    const groupsToProcess = Object.values(emailGroups).slice(0, effectiveLimit);

    let sentCount = 0;
    let failedCount = 0;

    for (let groupIndex = 0; groupIndex < groupsToProcess.length; groupIndex++) {
      const group = groupsToProcess[groupIndex];
      const recipientEmail = group[0].email;
      const recipientName = group[0].name;

      try {
        const ticketsForEmail = [];
        for (const ticket of group) {
          const verifyUrl = `${process.env.FRONTEND_URL}/verify/${ticket.uuid}`;
          const qrCodeDataUrl = await QRCode.toDataURL(verifyUrl);

          ticketsForEmail.push({
            ...ticket,
            verifyUrl,
            qrCodeDataUrl,
          });
        }

        await emailService.sendTicketEmail({
          to: recipientEmail,
          name: recipientName,
          tickets: ticketsForEmail,
          shopId: req.shopId,
        });

        const ticketIds = group.map(t => t.id);
        await db.query(
          'UPDATE tickets SET email_sent = true, email_sent_at = NOW() WHERE id = ANY($1) AND shop_id = $2',
          [ticketIds, req.shopId]
        );

        await db.query(
          'INSERT INTO email_send_log (shop_id, recipient_email, ticket_id, send_type, success) VALUES ($1, $2, $3, $4, $5)',
          [req.shopId, recipientEmail, group[0].id, 'batch_send', true]
        );

        sentCount++;

        if (groupIndex < groupsToProcess.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 6000));
        }
      } catch (emailError) {
        console.error(`Failed to send batch email to ${recipientEmail}:`, emailError);
        failedCount++;
        
        try {
          await db.query(
            'INSERT INTO email_send_log (shop_id, recipient_email, ticket_id, send_type, success) VALUES ($1, $2, $3, $4, $5)',
            [req.shopId, recipientEmail, group[0].id, 'batch_send', false]
          );
        } catch (logError) {
          console.error('Failed to log email failure:', logError);
        }

        try {
          await emailService.sendAdminNotification({
            subject: 'Batch Email Delivery Failure',
            message: 'A ticket email failed to send during batch processing.',
            ticketDetails: {
              recipientEmail,
              recipientName,
              ticketCount: group.length,
              error: emailError.message || 'Unknown error'
            }
          });
        } catch (notificationErr) {
          console.error('Failed to send admin notification:', notificationErr);
        }
      }
    }

    const updatedQuotaResult = await db.query(
      'SELECT COUNT(*) as sent_today FROM email_send_log WHERE shop_id = $1 AND sent_at >= $2 AND success = true',
      [req.shopId, todayStart]
    );
    const updatedSentToday = parseInt(updatedQuotaResult.rows[0].sent_today);
    const updatedRemaining = Math.max(0, dailyLimit - updatedSentToday);

    res.json({
      message: `Batch send complete. Sent: ${sentCount} email(s), Failed: ${failedCount}`,
      sent: sentCount,
      failed: failedCount,
      total: groupsToProcess.length,
      dailyQuota: { sentToday: updatedSentToday, dailyLimit, remaining: updatedRemaining }
    });
  } catch (error) {
    console.error('Error in batch send:', error);
    res.status(500).json({ error: 'Server error during batch send' });
  }
});

// Update ticket email (protected, admin/superadmin)
router.put('/:id/email', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  const ticketId = parseInt(req.params.id);
  const { email } = req.body;

  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email format' });
  }

  try {
    const ticketResult = await db.query(
      'SELECT id, email, email_sent FROM tickets WHERE id = $1 AND shop_id = $2',
      [ticketId, req.shopId]
    );

    if (ticketResult.rows.length === 0) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    const ticket = ticketResult.rows[0];
    const oldEmail = ticket.email;
    const wasEmailSent = ticket.email_sent;

    const result = await db.query(
      'UPDATE tickets SET email = $1 WHERE id = $2 AND shop_id = $3 RETURNING *',
      [email || null, ticketId, req.shopId]
    );

    let emailStatusChanged = false;
    if (wasEmailSent && oldEmail !== email) {
      await db.query(
        'UPDATE tickets SET email_sent = false, email_sent_at = NULL WHERE id = $1 AND shop_id = $2',
        [ticketId, req.shopId]
      );
      emailStatusChanged = true;
    }

    res.json({
      message: 'Email updated successfully',
      ticket: result.rows[0],
      emailStatusChanged,
      showResendOption: emailStatusChanged
    });
  } catch (error) {
    console.error('Error updating email:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Send individual ticket email (protected, admin/superadmin)
router.post('/:id/send-email', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  const ticketId = parseInt(req.params.id);

  try {
    const ticketResult = await db.query(
      `SELECT t.id, t.name, t.email, t.uuid, t.status, e.name as event_name
       FROM tickets t
       LEFT JOIN events e ON t.event_id = e.id AND e.shop_id = t.shop_id
       WHERE t.id = $1 AND t.shop_id = $2`,
      [ticketId, req.shopId]
    );

    if (ticketResult.rows.length === 0) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    const ticket = ticketResult.rows[0];

    if (ticket.status && ticket.status !== 'valid') {
      return res.status(400).json({ 
        error: `Cannot send email for ${ticket.status} ticket. Only valid tickets can receive QR codes.`,
        status: ticket.status 
      });
    }

    if (!ticket.email) {
      return res.status(400).json({ error: 'No email address on file for this ticket' });
    }

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost';
    const verifyUrl = `${frontendUrl}/verify/${ticket.uuid}`;
    const qrCodeDataUrl = await QRCode.toDataURL(verifyUrl);

    await emailService.sendTicketEmail({
      to: ticket.email,
      name: ticket.name,
      tickets: [{
        uuid: ticket.uuid,
        qrCodeDataUrl,
        event_name: ticket.event_name
      }],
      shopId: req.shopId
    });

    await db.query(
      'UPDATE tickets SET email_sent = true, email_sent_at = NOW() WHERE id = $1 AND shop_id = $2',
      [ticketId, req.shopId]
    );

    await db.query(
      'INSERT INTO email_send_log (shop_id, recipient_email, ticket_id, send_type, success) VALUES ($1, $2, $3, $4, $5)',
      [req.shopId, ticket.email, ticketId, 'individual_send', true]
    );

    res.json({ message: 'Ticket email sent successfully' });
  } catch (error) {
    console.error('Error sending ticket email:', error);
    res.status(500).json({ error: 'Failed to send ticket email' });
  }
});

// Send consolidated email for multiple tickets in an order (protected, admin/superadmin)
router.post('/send-order-email', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  const { ticketIds, customerName, customerEmail } = req.body;

  if (!ticketIds || !Array.isArray(ticketIds) || ticketIds.length === 0) {
    return res.status(400).json({ error: 'ticketIds array is required' });
  }

  if (!customerEmail) {
    return res.status(400).json({ error: 'customerEmail is required' });
  }

  try {
    const ticketsResult = await db.query(
      `SELECT t.id, t.name, t.email, t.uuid, t.status, e.name as event_name
       FROM tickets t
       LEFT JOIN events e ON t.event_id = e.id AND e.shop_id = t.shop_id
       WHERE t.id = ANY($1) AND t.shop_id = $2`,
      [ticketIds, req.shopId]
    );

    if (ticketsResult.rows.length === 0) {
      return res.status(404).json({ error: 'No tickets found' });
    }

    const tickets = ticketsResult.rows;

    const invalidTickets = tickets.filter(t => t.status && t.status !== 'valid');
    if (invalidTickets.length > 0) {
      const invalidStatuses = invalidTickets.map(t => `${t.name} (${t.status})`).join(', ');
      return res.status(400).json({ 
        error: `Cannot send email for non-valid tickets: ${invalidStatuses}`
      });
    }

    const validTickets = tickets.filter(t => !t.status || t.status === 'valid');

    const ticketsWithQR = await Promise.all(
      validTickets.map(async (ticket) => {
        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost';
        const verifyUrl = `${frontendUrl}/verify/${ticket.uuid}`;
        const qrCodeDataUrl = await QRCode.toDataURL(verifyUrl);
        return { ...ticket, qrCodeDataUrl, verifyUrl };
      })
    );

    await emailService.sendTicketEmail({
      to: customerEmail,
      name: customerName || validTickets[0].name,
      tickets: ticketsWithQR,
      shopId: req.shopId
    });

    const validTicketIds = validTickets.map(t => t.id);
    await db.query(
      'UPDATE tickets SET email_sent = true, email_sent_at = NOW() WHERE id = ANY($1) AND shop_id = $2',
      [validTicketIds, req.shopId]
    );

    await db.query(
      'INSERT INTO email_send_log (shop_id, recipient_email, ticket_id, send_type, success) VALUES ($1, $2, $3, $4, $5)',
      [req.shopId, customerEmail, validTickets[0].id, 'order_send', true]
    );

    res.json({ message: 'Consolidated email sent successfully', ticketsSent: validTickets.length });
  } catch (error) {
    console.error('Error sending order email:', error);
    res.status(500).json({ error: 'Failed to send order email' });
  }
});

module.exports = router;
