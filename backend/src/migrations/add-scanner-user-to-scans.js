require('dotenv').config();
const db = require('../config/database');

async function addScannerUserToScans() {
  try {
    console.log('Adding scanned_by_user_id column to ticket_scans table...');

    // Add scanned_by_user_id column to track which user scanned the ticket
    await db.query(`
      ALTER TABLE ticket_scans 
      ADD COLUMN IF NOT EXISTS scanned_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
    `);
    console.log('✓ scanned_by_user_id column added to ticket_scans');

    // Create index for efficient lookups
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_ticket_scans_user 
      ON ticket_scans(scanned_by_user_id)
    `);
    console.log('✓ Index created on scanned_by_user_id');

    console.log('Scanner user tracking migration completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Migration error:', error);
    process.exit(1);
  }
}

addScannerUserToScans();
