require('dotenv').config();
const db = require('../config/database');

async function updateTicketsTable() {
  try {
    console.log('Updating tickets table for attendee ticket types...');

    // Add ticket_subtype column
    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'tickets' AND column_name = 'ticket_subtype'
        ) THEN
          ALTER TABLE tickets ADD COLUMN ticket_subtype VARCHAR(100);
        END IF;
      END $$;
    `);
    console.log('✓ ticket_subtype column ensured');

    // First, migrate existing 'day_pass' tickets to 'attendee' (before updating constraint)
    await db.query(`
      UPDATE tickets SET ticket_type = 'attendee' WHERE ticket_type = 'day_pass';
    `);
    console.log('✓ Migrated existing day_pass tickets to attendee type');

    // Now update the constraint to allow 'attendee' instead of 'day_pass'
    await db.query(`
      ALTER TABLE tickets DROP CONSTRAINT IF EXISTS valid_ticket_type;
    `);
    
    await db.query(`
      ALTER TABLE tickets ADD CONSTRAINT valid_ticket_type 
      CHECK (ticket_type IN ('student', 'exhibitor', 'attendee'));
    `);
    console.log('✓ Updated ticket_type constraint to include attendee');

    console.log('Tickets table updated successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Migration error:', error);
    process.exit(1);
  }
}

updateTicketsTable();
