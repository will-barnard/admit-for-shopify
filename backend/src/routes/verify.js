const express = require('express');
const db = require('../config/database');
const authMiddleware = require('../middleware/auth');
const checkLockdown = require('../middleware/lockdown');

const { publicTicketLimiter } = require('../middleware/rate-limit');

const router = express.Router();

/**
 * Public, read-only ticket lookup - the QR code target.
 *
 * Every QR encodes `${FRONTEND_URL}/verify/{uuid}` and the ticket email links
 * to the same place, but the only endpoint behind it required a staff login.
 * An attendee scanning their own ticket with a phone camera, or clicking "View
 * Ticket Online", got a 401 and a dead end.
 *
 * Pointing that page at the authenticated route was not an option either: that
 * route RECORDS A SCAN. An admin who happened to be logged in and clicked a
 * ticket link would silently burn the ticket. This one only reads.
 *
 * The UUID is the credential. It is a v4 - 122 bits of randomness - and it is
 * only ever in the hands of the ticket holder and the merchant. What it
 * unlocks is what the holder already has: their own name, the event, and
 * whether the ticket has been used. Email addresses, order ids and internal
 * ids are deliberately not returned.
 */
router.get('/public/:uuid', publicTicketLimiter, async (req, res) => {
  try {
    const { uuid } = req.params;

    // tenancy-ok: looked up by ticket UUID, which is the credential here. A
    // public request has no session to derive a shop from - req.shopId would be
    // the DEFAULT_SHOP_DOMAIN fallback, which would make every other tenant's
    // tickets unreadable. The row's own shop_id scopes the joins below.
    const result = await db.query(
      `SELECT t.id, t.shop_id, t.name, t.is_used, t.status,
              e.name AS event_name, e.event_date, e.event_time, e.location,
              e.archived AS event_archived,
              tt.name AS ticket_type_name,
              s.org_name,
              (SELECT MIN(ts.scan_date) FROM ticket_scans ts
                WHERE ts.ticket_id = t.id AND ts.shop_id = t.shop_id) AS scanned_on
         FROM tickets t
         LEFT JOIN events e ON e.id = t.event_id AND e.shop_id = t.shop_id
         LEFT JOIN event_ticket_types tt ON tt.id = t.ticket_type_id AND tt.shop_id = t.shop_id
         LEFT JOIN settings s ON s.shop_id = t.shop_id
        WHERE t.uuid = $1`,
      [uuid]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ status: 'invalid', message: 'Ticket not found' });
    }

    const ticket = result.rows[0];

    // Same vocabulary the staff endpoint uses, so the page renders one way.
    let status = 'valid';
    let message = 'This ticket is valid.';
    if (ticket.event_archived) {
      status = 'archived';
      message = 'This event has been archived.';
    } else if (ticket.status && ticket.status !== 'valid') {
      status = ticket.status;
      message = `This ticket is ${ticket.status}.`;
    } else if (ticket.scanned_on) {
      status = 'already_scanned';
      message = 'This ticket has already been checked in.';
    }

    res.json({
      status,
      message,
      name: ticket.name,
      eventName: ticket.event_name,
      ticketType: ticket.ticket_type_name || null,
      eventDate: ticket.event_date,
      eventTime: ticket.event_time,
      location: ticket.location,
      orgName: ticket.org_name || null,
      scannedOn: ticket.scanned_on || null,
    });
  } catch (error) {
    console.error('Error looking up ticket:', error);
    res.status(500).json({ status: 'error', message: 'Server error' });
  }
});

// Verify AND CHECK IN a ticket (staff only).
//
// This is the scanner's endpoint: reaching it records a scan, which is why it
// is not what the customer-facing page calls. See /public/:uuid above.
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
        ticketType: ticket.ticket_type_name || null,
      });
    }

    // Check ticket status
    if (ticket.status && ticket.status !== 'valid') {
      return res.status(400).json({
        status: ticket.status,
        message: `Ticket is ${ticket.status}.`,
        name: ticket.name,
        eventName: ticket.event_name,
        ticketType: ticket.ticket_type_name || null,
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
        ticketType: ticket.ticket_type_name || null,
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
