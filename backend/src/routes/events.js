const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../config/database');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

// Get all events (protected)
// By default, archived events are hidden. Pass ?include_archived=true to include them.
router.get('/', authMiddleware, async (req, res) => {
  try {
    const includeArchived = req.query.include_archived === 'true';
    const archivedClause = includeArchived ? '' : 'AND (e.archived IS NULL OR e.archived = false)';
    const result = await db.query(
      `SELECT e.*,
        (SELECT COUNT(*) FROM tickets t WHERE t.event_id = e.id AND t.shop_id = e.shop_id AND (t.status IS NULL OR t.status = 'valid')) as ticket_count,
        (SELECT COUNT(*) FROM ticket_scans ts JOIN tickets t ON ts.ticket_id = t.id WHERE t.event_id = e.id AND t.shop_id = e.shop_id) as checkin_count,
        COALESCE((
          SELECT json_agg(tt ORDER BY tt.sort_order, tt.id)
            FROM (
              SELECT tt.id, tt.name, tt.shopify_variant_id, tt.shopify_product_id,
                     tt.shopify_sku, tt.capacity, tt.sort_order, tt.active,
                     (SELECT COUNT(*) FROM tickets t
                       WHERE t.ticket_type_id = tt.id AND t.shop_id = tt.shop_id
                         AND (t.status IS NULL OR t.status = 'valid')) as ticket_count
                FROM event_ticket_types tt
               WHERE tt.event_id = e.id AND tt.shop_id = e.shop_id
            ) tt
        ), '[]'::json) as ticket_types
       FROM events e
       WHERE e.shop_id = $1
       ${archivedClause}
       ORDER BY e.event_date DESC, e.created_at DESC`,
      [req.shopId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching events:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get single event (protected)
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      `SELECT e.*,
        (SELECT COUNT(*) FROM tickets t WHERE t.event_id = e.id AND t.shop_id = e.shop_id AND (t.status IS NULL OR t.status = 'valid')) as ticket_count,
        (SELECT COUNT(*) FROM ticket_scans ts JOIN tickets t ON ts.ticket_id = t.id WHERE t.event_id = e.id AND t.shop_id = e.shop_id) as checkin_count
       FROM events e WHERE e.id = $1 AND e.shop_id = $2`,
      [id, req.shopId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching event:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create event (protected)
router.post('/',
  authMiddleware,
  body('name').trim().notEmpty().withMessage('Event name is required'),
  body('event_date').notEmpty().withMessage('Event date is required'),
  body('sku').optional({ nullable: true, checkFalsy: true }).trim(),
  body('location').optional({ nullable: true, checkFalsy: true }).trim(),
  body('description').optional({ nullable: true, checkFalsy: true }).trim(),
  body('event_time').optional({ nullable: true, checkFalsy: true }).trim(),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { name, description, event_date, event_time, location, sku } = req.body;

      const created = await db.withTransaction(async (client) => {
        const eventResult = await client.query(
          `INSERT INTO events (shop_id, name, description, event_date, event_time, location)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
          [req.shopId, name, description || null, event_date, event_time || null, location || null]
        );
        const event = eventResult.rows[0];

        // Every event gets at least one ticket type. A simple event has exactly
        // one and never needs to think about them; the caller may pass
        // ticket_types to create several up front.
        const types = Array.isArray(req.body.ticket_types) && req.body.ticket_types.length > 0
          ? req.body.ticket_types
          : [{ name: 'General Admission', shopify_sku: sku || null }];

        const inserted = [];
        for (const [i, t] of types.entries()) {
          const row = await client.query(
            `INSERT INTO event_ticket_types
               (shop_id, event_id, name, shopify_variant_id, shopify_product_id, shopify_sku, capacity, sort_order)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
            [req.shopId, event.id, (t.name || 'General Admission').trim(),
             t.shopify_variant_id || null, t.shopify_product_id || null,
             t.shopify_sku || null, t.capacity ?? null, t.sort_order ?? i]
          );
          inserted.push(row.rows[0]);
        }
        return { ...event, ticket_types: inserted };
      });

      res.status(201).json(created);
    } catch (error) {
      console.error('Error creating event:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// Update event (protected)
router.put('/:id',
  authMiddleware,
  body('name').trim().notEmpty().withMessage('Event name is required'),
  body('event_date').notEmpty().withMessage('Event date is required'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { id } = req.params;
      const { name, description, event_date, event_time, location, active } = req.body;

      // events.sku is no longer written - the Shopify mapping lives on
      // event_ticket_types. The column is retained for historical rows.
      const result = await db.query(
        `UPDATE events SET name = $1, description = $2, event_date = $3, event_time = $4,
         location = $5, active = $6, updated_at = NOW()
         WHERE id = $7 AND shop_id = $8 RETURNING *`,
        [name, description || null, event_date, event_time || null, location || null, active !== false, id, req.shopId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Event not found' });
      }

      res.json(result.rows[0]);
    } catch (error) {
      console.error('Error updating event:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// Delete event (protected)
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if there are tickets for this event
    const ticketCheck = await db.query(
      'SELECT COUNT(*) as count FROM tickets WHERE event_id = $1 AND shop_id = $2',
      [id, req.shopId]
    );
    if (parseInt(ticketCheck.rows[0].count) > 0) {
      return res.status(400).json({ 
        error: 'Cannot delete event with existing tickets. Remove tickets first or deactivate the event.' 
      });
    }

    const result = await db.query(
      'DELETE FROM events WHERE id = $1 AND shop_id = $2 RETURNING id',
      [id, req.shopId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }

    res.json({ message: 'Event deleted successfully' });
  } catch (error) {
    console.error('Error deleting event:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get active events (for dropdowns - public for verifier)
router.get('/list/active', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT e.id, e.name, e.event_date,
              COALESCE((
                SELECT json_agg(json_build_object('id', tt.id, 'name', tt.name)
                                ORDER BY tt.sort_order, tt.id)
                  FROM event_ticket_types tt
                 WHERE tt.event_id = e.id AND tt.shop_id = e.shop_id AND tt.active = true
              ), '[]'::json) as ticket_types
         FROM events e
        WHERE e.shop_id = $1
          AND e.active = true
          AND (e.archived IS NULL OR e.archived = false)
        ORDER BY e.event_date ASC`,
      [req.shopId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching active events:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Archive an event (protected)
router.post('/:id/archive', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      `UPDATE events
       SET archived = true, archived_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND shop_id = $2
       RETURNING *`,
      [id, req.shopId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error archiving event:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Unarchive an event (protected)
router.post('/:id/unarchive', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      `UPDATE events
       SET archived = false, archived_at = NULL, updated_at = NOW()
       WHERE id = $1 AND shop_id = $2
       RETURNING *`,
      [id, req.shopId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error unarchiving event:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------------------------------------------------------------------------
// Ticket types
//
// An event has one or more. A simple event has exactly one and the UI can hide
// the concept entirely; multi-type events map each type to its own Shopify
// variant. Matching prefers variant id over SKU - see services/shopify-orders.js.
// ---------------------------------------------------------------------------

// List ticket types for an event
router.get('/:id/ticket-types', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT tt.*,
              (SELECT COUNT(*) FROM tickets t
                WHERE t.ticket_type_id = tt.id AND t.shop_id = tt.shop_id
                  AND (t.status IS NULL OR t.status = 'valid')) as ticket_count
         FROM event_ticket_types tt
        WHERE tt.event_id = $1 AND tt.shop_id = $2
        ORDER BY tt.sort_order, tt.id`,
      [req.params.id, req.shopId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching ticket types:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Add a ticket type
router.post('/:id/ticket-types',
  authMiddleware,
  body('name').trim().notEmpty().withMessage('Ticket type name is required'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const eventCheck = await db.query(
        'SELECT id FROM events WHERE id = $1 AND shop_id = $2',
        [req.params.id, req.shopId]
      );
      if (eventCheck.rows.length === 0) return res.status(404).json({ error: 'Event not found' });

      const { name, shopify_variant_id, shopify_product_id, shopify_sku, capacity, sort_order } = req.body;

      const result = await db.query(
        `INSERT INTO event_ticket_types
           (shop_id, event_id, name, shopify_variant_id, shopify_product_id, shopify_sku, capacity, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, (
           SELECT COALESCE(MAX(sort_order) + 1, 0) FROM event_ticket_types WHERE event_id = $2 AND shop_id = $1
         ))) RETURNING *`,
        [req.shopId, req.params.id, name.trim(), shopify_variant_id || null,
         shopify_product_id || null, shopify_sku || null, capacity ?? null, sort_order ?? null]
      );
      res.status(201).json(result.rows[0]);
    } catch (error) {
      if (error.code === '23505') {
        return res.status(400).json({
          error: 'That Shopify variant or SKU is already mapped to another ticket type',
        });
      }
      console.error('Error creating ticket type:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// Update a ticket type
router.put('/:id/ticket-types/:typeId',
  authMiddleware,
  body('name').trim().notEmpty().withMessage('Ticket type name is required'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { name, shopify_variant_id, shopify_product_id, shopify_sku, capacity, sort_order, active } = req.body;

      const result = await db.query(
        `UPDATE event_ticket_types
            SET name = $1, shopify_variant_id = $2, shopify_product_id = $3, shopify_sku = $4,
                capacity = $5, sort_order = COALESCE($6, sort_order), active = $7, updated_at = NOW()
          WHERE id = $8 AND event_id = $9 AND shop_id = $10
          RETURNING *`,
        [name.trim(), shopify_variant_id || null, shopify_product_id || null, shopify_sku || null,
         capacity ?? null, sort_order ?? null, active !== false,
         req.params.typeId, req.params.id, req.shopId]
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'Ticket type not found' });
      res.json(result.rows[0]);
    } catch (error) {
      if (error.code === '23505') {
        return res.status(400).json({
          error: 'That Shopify variant or SKU is already mapped to another ticket type',
        });
      }
      console.error('Error updating ticket type:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// Delete a ticket type
router.delete('/:id/ticket-types/:typeId', authMiddleware, async (req, res) => {
  try {
    // Never orphan issued tickets.
    const inUse = await db.query(
      'SELECT COUNT(*) as count FROM tickets WHERE ticket_type_id = $1 AND shop_id = $2',
      [req.params.typeId, req.shopId]
    );
    if (parseInt(inUse.rows[0].count, 10) > 0) {
      return res.status(400).json({
        error: 'Cannot delete a ticket type that has tickets. Deactivate it instead to stop new sales.',
      });
    }

    // An event must always keep at least one ticket type.
    const remaining = await db.query(
      'SELECT COUNT(*) as count FROM event_ticket_types WHERE event_id = $1 AND shop_id = $2',
      [req.params.id, req.shopId]
    );
    if (parseInt(remaining.rows[0].count, 10) <= 1) {
      return res.status(400).json({
        error: 'An event must have at least one ticket type.',
      });
    }

    const result = await db.query(
      'DELETE FROM event_ticket_types WHERE id = $1 AND event_id = $2 AND shop_id = $3 RETURNING id',
      [req.params.typeId, req.params.id, req.shopId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Ticket type not found' });
    res.json({ message: 'Ticket type deleted' });
  } catch (error) {
    console.error('Error deleting ticket type:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
