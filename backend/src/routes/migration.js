const express = require('express');
const router = express.Router();
const db = require('../config/database');
const superAdminMiddleware = require('../middleware/superadmin');
const axios = require('axios');

// Receive endpoint - accepts database migration from another instance
router.post('/receive', async (req, res) => {
  try {
    const { secret, tickets, ticket_scans } = req.body;
    
    if (!secret) {
      return res.status(400).json({ error: 'Secret key is required' });
    }
    
    // Verify receive mode is enabled and secret matches
    const settingsResult = await db.query('SELECT receive_mode_enabled, receive_mode_secret FROM settings LIMIT 1');
    
    if (settingsResult.rows.length === 0 || !settingsResult.rows[0].receive_mode_enabled) {
      return res.status(403).json({ error: 'Receive mode is not enabled' });
    }
    
    if (settingsResult.rows[0].receive_mode_secret !== secret) {
      return res.status(403).json({ error: 'Invalid secret key' });
    }
    
    console.log(`Receiving migration with ${tickets?.length || 0} tickets, ${ticket_scans?.length || 0} scans`);
    
    let ticketsUpserted = 0;
    let scansInserted = 0;
    
    // Begin transaction
    await db.query('BEGIN');
    
    try {
      // Upsert tickets
      if (tickets && tickets.length > 0) {
        for (const ticket of tickets) {
          await db.query(`
            INSERT INTO tickets (event_id, name, email, uuid, is_used, used_at, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (uuid) 
            DO UPDATE SET 
              event_id = EXCLUDED.event_id,
              name = EXCLUDED.name,
              email = EXCLUDED.email,
              is_used = EXCLUDED.is_used,
              used_at = EXCLUDED.used_at
          `, [
            ticket.event_id,
            ticket.name,
            ticket.email,
            ticket.uuid,
            ticket.is_used,
            ticket.used_at,
            ticket.created_at
          ]);
          ticketsUpserted++;
        }
      }
      
      // Insert ticket scans (only insert new ones, skip duplicates)
      if (ticket_scans && ticket_scans.length > 0) {
        for (const scan of ticket_scans) {
          // Get the ticket ID from UUID
          const ticketResult = await db.query('SELECT id FROM tickets WHERE uuid = $1', [scan.ticket_uuid]);
          
          if (ticketResult.rows.length > 0) {
            const ticketId = ticketResult.rows[0].id;
            
            // Check if scan already exists
            const existingScan = await db.query(
              'SELECT id FROM ticket_scans WHERE ticket_id = $1 AND scanned_at = $2',
              [ticketId, scan.scanned_at]
            );
            
            if (existingScan.rows.length === 0) {
              await db.query(
                'INSERT INTO ticket_scans (ticket_id, scanned_by, scanned_at) VALUES ($1, $2, $3)',
                [ticketId, scan.scanned_by, scan.scanned_at]
              );
              scansInserted++;
            }
          }
        }
      }
      
      await db.query('COMMIT');
      
      console.log(`Migration completed: ${ticketsUpserted} tickets upserted, ${scansInserted} scans inserted`);
      
      res.json({
        message: 'Migration received successfully',
        summary: {
          tickets_upserted: ticketsUpserted,
          scans_inserted: scansInserted
        }
      });
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    }
  } catch (error) {
    console.error('Error receiving migration:', error);
    res.status(500).json({ error: 'Failed to receive migration', details: error.message });
  }
});

// Send endpoint - exports database to another instance
router.post('/send', superAdminMiddleware, async (req, res) => {
  try {
    const { targetUrl, secret } = req.body;
    
    if (!targetUrl || !secret) {
      return res.status(400).json({ error: 'Target URL and secret key are required' });
    }
    
    console.log(`Preparing to send migration to ${targetUrl}`);
    
    // Fetch all tickets
    const ticketsResult = await db.query('SELECT * FROM tickets ORDER BY id');
    const tickets = ticketsResult.rows;
    
    // Fetch all ticket scans with ticket UUIDs
    const scansResult = await db.query(`
      SELECT ts.*, t.uuid as ticket_uuid
      FROM ticket_scans ts
      JOIN tickets t ON ts.ticket_id = t.id
      ORDER BY ts.id
    `);
    const ticket_scans = scansResult.rows;
    
    console.log(`Sending ${tickets.length} tickets, ${ticket_scans.length} scans`);
    
    // Send to target instance
    const targetEndpoint = `${targetUrl.replace(/\/$/, '')}/api/migration/receive`;
    
    try {
      const response = await axios.post(targetEndpoint, {
        secret,
        tickets,
        ticket_scans
      }, {
        timeout: 60000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      });
      
      console.log('Migration sent successfully:', response.data);
      
      res.json({
        message: 'Migration sent successfully',
        sent: {
          tickets: tickets.length,
          scans: ticket_scans.length
        },
        target_response: response.data
      });
    } catch (sendError) {
      console.error('Error sending to target:', sendError.message);
      
      if (sendError.response) {
        return res.status(502).json({
          error: 'Target instance rejected migration',
          details: sendError.response.data
        });
      } else if (sendError.request) {
        return res.status(502).json({
          error: 'Failed to connect to target instance',
          details: 'Check that the target URL is correct and the instance is running'
        });
      } else {
        throw sendError;
      }
    }
  } catch (error) {
    console.error('Error sending migration:', error);
    res.status(500).json({ error: 'Failed to send migration', details: error.message });
  }
});

module.exports = router;
