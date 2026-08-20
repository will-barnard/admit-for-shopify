const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../config/database');
const authMiddleware = require('../middleware/auth');
const requireRole = require('../middleware/require-role');
const eventPublish = require('../services/event-publish');

// Reads stay open to any signed-in user - the scanner needs the active-event
// list. Every write is admin or superadmin: a 'verifier' door account could
// previously create, edit, archive and delete events and their ticket types.
const canManageEvents = requireRole('admin', 'superadmin');

/**
 * events.event_time is a Postgres `time` column, but the form used to be free
 * text hinting "e.g. 10:00 AM - 6:00 PM". Typing exactly that raised a
 * datetime parse error, which the catch below turned into a bare
 * `{"error":"Server error"}` - so following the app's own placeholder produced
 * an unexplained 500.
 *
 * A single clock time is what the column can hold. A range needs separate
 * start/end columns, which is a schema change worth doing on its own; until
 * then, say so rather than failing opaquely.
 */
const TIME_PATTERN = /^([01]?\d|2[0-3]):[0-5]\d(:[0-5]\d)?$|^(0?[1-9]|1[0-2]):[0-5]\d\s*([AaPp][Mm])$/;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Work out the event's window from whatever the caller sent.
 *
 * starts_at is the source of truth now, but event_date + event_time is still
 * accepted: it is what the legacy Flow integration sends, and what every
 * existing caller sends. The two columns are GENERATED from starts_at, so they
 * can no longer be written to directly - this is where the translation happens.
 *
 * The actual composition is left to Postgres ($date::date + $time::time)
 * rather than parsed here, so "7:00 PM" and "19:00" both work without this
 * file growing a clock parser.
 *
 * An ends_at given as a bare date means the END of that day, because that is
 * what "a two-day pass through the 15th" means to the person typing it.
 */
function resolveWindow(body) {
  const startsAt = (body.starts_at || '').trim();
  const eventDate = (body.event_date || '').trim();

  if (!startsAt && !eventDate) {
    return { error: 'An event needs a start - send starts_at, or event_date.' };
  }

  let endsAt = (body.ends_at || '').trim() || null;
  if (endsAt && DATE_ONLY.test(endsAt)) endsAt = `${endsAt} 23:59:59`;

  return {
    startsAt: startsAt || null,
    eventDate: eventDate || null,
    eventTime: (body.event_time || '').trim() || null,
    endsAt,
  };
}

// Composes starts_at from either form, in SQL. $1 starts_at, $2 date, $3 time.
const STARTS_AT_SQL = "COALESCE($1::timestamp, $2::date + COALESCE($3::time, TIME '00:00'))";

function invalidTime(value) {
  if (value === undefined || value === null || value === '') return null;
  if (TIME_PATTERN.test(String(value).trim())) return null;
  return {
    error: 'Event time must be a single clock time, such as 19:00 or 7:00 PM. '
      + 'For a range like "10:00 AM - 6:00 PM", put it in the description for now.',
  };
}

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
                     tt.shopify_sku, tt.capacity, tt.price, tt.sort_order, tt.active,
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
       ORDER BY e.starts_at DESC, e.created_at DESC`,
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
  canManageEvents,
  body('name').trim().notEmpty().withMessage('Event name is required'),
  // Either starts_at or event_date is required; resolveWindow decides, because
  // "one of these two" is not something a per-field validator can express.
  body('event_date').optional({ nullable: true, checkFalsy: true }),
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

      const { name, description, location, sku } = req.body;

      const timeProblem = invalidTime(req.body.event_time);
      if (timeProblem) return res.status(400).json(timeProblem);

      const window = resolveWindow(req.body);
      if (window.error) return res.status(400).json({ error: window.error });

      const created = await db.withTransaction(async (client) => {
        const eventResult = await client.query(
          `INSERT INTO events (shop_id, name, description, starts_at, ends_at, location)
           VALUES ($4, $5, $6, ${STARTS_AT_SQL}, $7::timestamp, $8) RETURNING *`,
          [window.startsAt, window.eventDate, window.eventTime,
           req.shopId, name, description || null, window.endsAt, location || null]
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
               (shop_id, event_id, name, shopify_variant_id, shopify_product_id, shopify_sku, capacity, sort_order, price)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
            [req.shopId, event.id, (t.name || 'General Admission').trim(),
             t.shopify_variant_id || null, t.shopify_product_id || null,
             t.shopify_sku || null, t.capacity ?? null, t.sort_order ?? i,
             t.price === '' || t.price == null ? null : t.price]
          );
          inserted.push(row.rows[0]);
        }
        return { ...event, ticket_types: inserted };
      });

      res.status(201).json(created);
    } catch (error) {
      if (error.code === '23514' && error.constraint === 'events_end_after_start') {
        return res.status(400).json({ error: 'The event cannot end before it starts.' });
      }
      if (error.code === '22007' || error.code === '22008') {
        return res.status(400).json({ error: 'That start or end time could not be read as a date and time.' });
      }
      console.error('Error creating event:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// Update event (protected)
router.put('/:id',
  authMiddleware,
  canManageEvents,
  body('name').trim().notEmpty().withMessage('Event name is required'),
  // Either starts_at or event_date is required; resolveWindow decides, because
  // "one of these two" is not something a per-field validator can express.
  body('event_date').optional({ nullable: true, checkFalsy: true }),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { id } = req.params;
      const { name, description, location, active } = req.body;

      const timeProblem = invalidTime(req.body.event_time);
      if (timeProblem) return res.status(400).json(timeProblem);

      const window = resolveWindow(req.body);
      if (window.error) return res.status(400).json({ error: window.error });

      // events.sku is no longer written - the Shopify mapping lives on
      // event_ticket_types. The column is retained for historical rows.
      const result = await db.query(
        `UPDATE events SET name = $4, description = $5, starts_at = ${STARTS_AT_SQL},
         ends_at = $6::timestamp, location = $7, active = $8, updated_at = NOW()
         WHERE id = $9 AND shop_id = $10 RETURNING *`,
        [window.startsAt, window.eventDate, window.eventTime,
         name, description || null, window.endsAt, location || null, active !== false, id, req.shopId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Event not found' });
      }

      res.json(result.rows[0]);
    } catch (error) {
      if (error.code === '23514' && error.constraint === 'events_end_after_start') {
        return res.status(400).json({ error: 'The event cannot end before it starts.' });
      }
      if (error.code === '22007' || error.code === '22008') {
        return res.status(400).json({ error: 'That start or end time could not be read as a date and time.' });
      }
      console.error('Error updating event:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// Delete event (protected)
router.delete('/:id', authMiddleware, canManageEvents, async (req, res) => {
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
      `SELECT e.id, e.name, e.event_date, e.starts_at, e.ends_at,
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
        ORDER BY e.starts_at ASC`,
      [req.shopId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching active events:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Archive an event (protected)
router.post('/:id/archive', authMiddleware, canManageEvents, async (req, res) => {
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
router.post('/:id/unarchive', authMiddleware, canManageEvents, async (req, res) => {
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
// Publishing to the storefront
//
// Creates or updates the event's Shopify product: one variant per ticket type,
// with the date and location alongside as metafields. Upserts on the event id,
// so pressing Publish twice cannot make two products.
// ---------------------------------------------------------------------------

router.post('/:id/publish', authMiddleware, canManageEvents, async (req, res) => {
  try {
    const result = await eventPublish.publishEvent(req.shopId, req.params.id, {
      collectionIds: Array.isArray(req.body?.collectionIds) ? req.body.collectionIds : [],
      status: req.body?.status,
    });
    if (!result) return res.status(404).json({ error: 'Event not found' });
    res.json(result);
  } catch (error) {
    // A refusal from Shopify is the merchant's problem to see, not a 500 -
    // "you have no active ticket types" or "that handle is taken" are things
    // they can act on. The message is already recorded on the event.
    const isRefusal = error.name === 'AdminApiError' || /ticket type/i.test(error.message || '');
    console.error('Error publishing event:', error.message);
    res.status(isRefusal ? 400 : 500).json({
      error: error.message || 'Failed to publish',
      userErrors: error.userErrors || undefined,
    });
  }
});

router.post('/:id/unpublish', authMiddleware, canManageEvents, async (req, res) => {
  try {
    const result = await eventPublish.unpublishEvent(req.shopId, req.params.id);
    if (!result) return res.status(404).json({ error: 'Event not found' });
    res.json(result);
  } catch (error) {
    console.error('Error unpublishing event:', error.message);
    res.status(error.name === 'AdminApiError' ? 400 : 500).json({ error: error.message || 'Failed to unpublish' });
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
  canManageEvents,
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

      const { name, shopify_variant_id, shopify_product_id, shopify_sku, capacity, sort_order, price } = req.body;

      const result = await db.query(
        `INSERT INTO event_ticket_types
           (shop_id, event_id, name, shopify_variant_id, shopify_product_id, shopify_sku, capacity, price, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $9, COALESCE($8, (
           SELECT COALESCE(MAX(sort_order) + 1, 0) FROM event_ticket_types WHERE event_id = $2 AND shop_id = $1
         ))) RETURNING *`,
        [req.shopId, req.params.id, name.trim(), shopify_variant_id || null,
         shopify_product_id || null, shopify_sku || null, capacity ?? null, sort_order ?? null,
         price === '' || price == null ? null : price]
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
  canManageEvents,
  body('name').trim().notEmpty().withMessage('Ticket type name is required'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { name, shopify_variant_id, shopify_product_id, shopify_sku, capacity, sort_order, active, price } = req.body;

      const result = await db.query(
        `UPDATE event_ticket_types
            SET name = $1, shopify_variant_id = $2, shopify_product_id = $3, shopify_sku = $4,
                capacity = $5, sort_order = COALESCE($6, sort_order), active = $7,
                price = $11, updated_at = NOW()
          WHERE id = $8 AND event_id = $9 AND shop_id = $10
          RETURNING *`,
        [name.trim(), shopify_variant_id || null, shopify_product_id || null, shopify_sku || null,
         capacity ?? null, sort_order ?? null, active !== false,
         req.params.typeId, req.params.id, req.shopId,
         price === '' || price == null ? null : price]
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
router.delete('/:id/ticket-types/:typeId', authMiddleware, canManageEvents, async (req, res) => {
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
