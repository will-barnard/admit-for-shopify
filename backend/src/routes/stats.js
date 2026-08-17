const express = require('express');
const db = require('../config/database');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

// Get ticket statistics grouped by event
router.get('/', authMiddleware, async (req, res) => {
  try {
    // Exclude tickets whose event has been archived (archived events
    // shouldn't appear on the dashboard). Tickets with no event_id are
    // still included via the LEFT JOIN (e.archived IS NULL).
    const ticketsResult = await db.query(
      `SELECT t.id, t.event_id, t.shopify_order_id, e.name as event_name, e.event_date
       FROM tickets t
       LEFT JOIN events e ON t.event_id = e.id
       WHERE t.shop_id = $1
         AND (t.status IS NULL OR t.status = 'valid')
         AND (e.archived IS NULL OR e.archived = false)`,
      [req.shopId]
    );
    const tickets = ticketsResult.rows;

    const scansResult = await db.query('SELECT ticket_id FROM ticket_scans WHERE shop_id = $1', [req.shopId]);
    const scannedTicketIds = new Set(scansResult.rows.map(s => s.ticket_id));

    const eventMap = new Map();
    
    tickets.forEach(ticket => {
      const eventId = ticket.event_id || 'unassigned';
      if (!eventMap.has(eventId)) {
        eventMap.set(eventId, {
          event_id: ticket.event_id,
          event_name: ticket.event_name || 'Unassigned',
          event_date: ticket.event_date,
          tickets: []
        });
      }
      eventMap.get(eventId).tickets.push(ticket);
    });

    const eventStats = Array.from(eventMap.values()).map(event => {
      const sold = event.tickets.length;
      const scanned = event.tickets.filter(t => scannedTicketIds.has(t.id)).length;
      return {
        event_id: event.event_id,
        event_name: event.event_name,
        event_date: event.event_date,
        sold,
        scanned,
        remaining: sold - scanned
      };
    });

    eventStats.sort((a, b) => {
      if (!a.event_date) return 1;
      if (!b.event_date) return -1;
      return new Date(a.event_date) - new Date(b.event_date);
    });

    const totalSold = tickets.length;
    const totalScanned = tickets.filter(t => scannedTicketIds.has(t.id)).length;

    res.json({
      eventStats,
      totals: {
        sold: totalSold,
        scanned: totalScanned,
        remaining: totalSold - totalScanned
      }
    });
  } catch (error) {
    console.error('Error fetching usage stats:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
