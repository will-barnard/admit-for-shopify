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
    const whereClause = includeArchived ? '' : 'WHERE (e.archived IS NULL OR e.archived = false)';
    const result = await db.query(
      `SELECT e.*,
        (SELECT COUNT(*) FROM tickets t WHERE t.event_id = e.id AND (t.status IS NULL OR t.status = 'valid')) as ticket_count,
        (SELECT COUNT(*) FROM ticket_scans ts JOIN tickets t ON ts.ticket_id = t.id WHERE t.event_id = e.id) as checkin_count
       FROM events e
       ${whereClause}
       ORDER BY e.event_date DESC, e.created_at DESC`
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
        (SELECT COUNT(*) FROM tickets t WHERE t.event_id = e.id AND (t.status IS NULL OR t.status = 'valid')) as ticket_count,
        (SELECT COUNT(*) FROM ticket_scans ts JOIN tickets t ON ts.ticket_id = t.id WHERE t.event_id = e.id) as checkin_count
       FROM events e WHERE e.id = $1`,
      [id]
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

      // Check for duplicate SKU if provided
      if (sku) {
        const skuCheck = await db.query('SELECT id FROM events WHERE sku = $1', [sku]);
        if (skuCheck.rows.length > 0) {
          return res.status(400).json({ error: 'An event with this SKU already exists' });
        }
      }

      const result = await db.query(
        `INSERT INTO events (name, description, event_date, event_time, location, sku) 
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [name, description || null, event_date, event_time || null, location || null, sku || null]
      );

      res.status(201).json(result.rows[0]);
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
      const { name, description, event_date, event_time, location, sku, active } = req.body;

      // Check for duplicate SKU if provided (excluding current event)
      if (sku) {
        const skuCheck = await db.query('SELECT id FROM events WHERE sku = $1 AND id != $2', [sku, id]);
        if (skuCheck.rows.length > 0) {
          return res.status(400).json({ error: 'An event with this SKU already exists' });
        }
      }

      const result = await db.query(
        `UPDATE events SET name = $1, description = $2, event_date = $3, event_time = $4, 
         location = $5, sku = $6, active = $7, updated_at = NOW() 
         WHERE id = $8 RETURNING *`,
        [name, description || null, event_date, event_time || null, location || null, sku || null, active !== false, id]
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
    const ticketCheck = await db.query('SELECT COUNT(*) as count FROM tickets WHERE event_id = $1', [id]);
    if (parseInt(ticketCheck.rows[0].count) > 0) {
      return res.status(400).json({ 
        error: 'Cannot delete event with existing tickets. Remove tickets first or deactivate the event.' 
      });
    }

    const result = await db.query('DELETE FROM events WHERE id = $1 RETURNING id', [id]);
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
      `SELECT id, name, event_date, sku FROM events
       WHERE active = true
         AND (archived IS NULL OR archived = false)
       ORDER BY event_date ASC`
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
       WHERE id = $1
       RETURNING *`,
      [id]
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
       WHERE id = $1
       RETURNING *`,
      [id]
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

module.exports = router;
