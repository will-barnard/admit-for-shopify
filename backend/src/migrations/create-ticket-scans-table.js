require('dotenv').config();
const db = require('../config/database');

async function createTicketScansTable() {
  try {
    console.log('Creating ticket_scans table...');

    // Create ticket_scans table to track daily usage
    await db.query(`
      CREATE TABLE IF NOT EXISTS ticket_scans (
        id SERIAL PRIMARY KEY,
        ticket_id INTEGER REFERENCES tickets(id) ON DELETE CASCADE,
        scanned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        scan_date DATE DEFAULT CURRENT_DATE
      )
    `);
    console.log('✓ ticket_scans table created');

    // Create index for efficient lookups
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_ticket_scans_ticket_date 
      ON ticket_scans(ticket_id, scan_date)
    `);
    console.log('✓ Index created on ticket_scans');

    console.log('ticket_scans table created successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Migration error:', error);
    process.exit(1);
  }
}

createTicketScansTable();
