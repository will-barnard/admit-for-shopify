const express = require('express');
const db = require('../config/database');
const authMiddleware = require('../middleware/auth');
const checkLockdown = require('../middleware/lockdown');

const router = express.Router();

// Verify ticket by UUID (protected endpoint - requires authentication)
router.get('/:uuid', authMiddleware, checkLockdown, async (req, res) => {
  try {
    const { uuid } = req.params;

    // Find ticket with event info
    const ticketResult = await db.query(
      `SELECT t.id, t.name, t.email, t.is_used, t.status, t.event_id,
              e.name as event_name, e.event_date, e.location,
              e.archived as event_archived,
              tt.name as ticket_type_name
       FROM tickets t
       LEFT JOIN events e ON t.event_id = e.id AND e.shop_id = t.shop_id
       LEFT JOIN event_ticket_types tt ON tt.id = t.ticket_type_id AND tt.shop_id = t.shop_id
       WHERE t.uuid = $1 AND t.shop_id = $2`,
      [uuid, req.shopId]
    );

    if (ticketResult.rows.length === 0) {
      return res.status(404).json({
        status: 'invalid',
        message: 'Ticket not found',
      });
    }

    const ticket = ticketResult.rows[0];

    // Reject scans for archived events
    if (ticket.event_archived) {
      return res.status(400).json({
        status: 'archived',
        message: 'This event has been archived. Tickets cannot be scanned.',
        name: ticket.name,
        eventName: ticket.event_name,
      });
    }

    // Check ticket status
    if (ticket.status && ticket.status !== 'valid') {
      return res.status(400).json({
        status: ticket.status,
        message: `Ticket is ${ticket.status}.`,
        name: ticket.name,
        eventName: ticket.event_name,
      });
    }

    // Check if already scanned
    const scanCheckResult = await db.query(
      'SELECT scan_date FROM ticket_scans WHERE ticket_id = $1 AND shop_id = $2 LIMIT 1',
      [ticket.id, req.shopId]
    );

    if (scanCheckResult.rows.length > 0) {
      const scannedDate = scanCheckResult.rows[0].scan_date;
      return res.status(400).json({
        status: 'already_scanned',
        message: 'This ticket has already been scanned.',
        scannedOn: scannedDate,
        name: ticket.name,
        eventName: ticket.event_name,
      });
    }

    // Record the scan
    await db.query(
      'INSERT INTO ticket_scans (shop_id, ticket_id, scan_date, scanned_by_user_id) VALUES ($1, $2, NOW(), $3)',
      [req.shopId, ticket.id, req.user.id]
    );

    return res.json({
      status: 'valid',
      message: 'Access granted',
      name: ticket.name,
      eventName: ticket.event_name,
      ticketType: ticket.ticket_type_name || null,
      eventDate: ticket.event_date,
      location: ticket.location,
    });
  } catch (error) {
    console.error('Error verifying ticket:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error',
    });
  }
});

module.exports = router;
