require('dotenv').config();
const db = require('../config/database');

async function addTicketStatus() {
  try {
    console.log('Adding status field to tickets table...');

    await db.query(`
      DO $$
      BEGIN
        -- Add status column if it doesn't exist
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'tickets' AND column_name = 'status'
        ) THEN
          ALTER TABLE tickets ADD COLUMN status VARCHAR(50) DEFAULT 'valid';
          RAISE NOTICE '✓ Added status column';
        ELSE
          RAISE NOTICE 'status column already exists';
        END IF;

        -- Add constraint for valid status values
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints 
          WHERE constraint_name = 'valid_ticket_status' AND table_name = 'tickets'
        ) THEN
          ALTER TABLE tickets ADD CONSTRAINT valid_ticket_status CHECK (status IN ('valid', 'invalid', 'refunded', 'chargeback'));
          RAISE NOTICE '✓ Added status constraint';
        ELSE
          RAISE NOTICE 'Status constraint already exists';
        END IF;

        -- Add index for status for faster lookups
        IF NOT EXISTS (
          SELECT 1 FROM pg_indexes 
          WHERE tablename = 'tickets' AND indexname = 'idx_tickets_status'
        ) THEN
          CREATE INDEX idx_tickets_status ON tickets(status);
          RAISE NOTICE '✓ Added index on status';
        ELSE
          RAISE NOTICE 'Index on status already exists';
        END IF;
      END $$;
    `);

    console.log('✓ Ticket status field migration completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Migration error:', error);
    process.exit(1);
  }
}

addTicketStatus();
