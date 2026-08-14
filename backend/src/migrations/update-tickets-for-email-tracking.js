require('dotenv').config();
const db = require('../config/database');

async function updateTicketsForEmailTracking() {
  try {
    console.log('Updating tickets table for email tracking...');

    // Add email_sent column
    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'tickets' AND column_name = 'email_sent'
        ) THEN
          ALTER TABLE tickets ADD COLUMN email_sent BOOLEAN DEFAULT false;
        END IF;
      END $$;
    `);
    console.log('✓ email_sent column added to tickets table');

    // Add email_sent_at column
    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'tickets' AND column_name = 'email_sent_at'
        ) THEN
          ALTER TABLE tickets ADD COLUMN email_sent_at TIMESTAMP;
        END IF;
      END $$;
    `);
    console.log('✓ email_sent_at column added to tickets table');

    console.log('Tickets table updated successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Migration error:', error);
    process.exit(1);
  }
}

updateTicketsForEmailTracking();
