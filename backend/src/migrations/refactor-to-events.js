require('dotenv').config();
const db = require('../config/database');

async function refactorToEvents() {
  try {
    console.log('Running event-based refactoring migration...');

    // 1. Create events table
    await db.query(`
      CREATE TABLE IF NOT EXISTS events (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        event_date DATE NOT NULL,
        event_time TIME,
        location VARCHAR(255),
        sku VARCHAR(255) UNIQUE,
        active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✓ Events table created');

    // 2. Create indexes for events
    await db.query(`CREATE INDEX IF NOT EXISTS idx_events_sku ON events(sku)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_events_active ON events(active)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_events_date ON events(event_date)`);
    console.log('✓ Events indexes created');

    // 3. Add event_id column to tickets table
    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'tickets' AND column_name = 'event_id'
        ) THEN
          ALTER TABLE tickets ADD COLUMN event_id INTEGER REFERENCES events(id) ON DELETE SET NULL;
        END IF;
      END $$;
    `);
    console.log('✓ event_id column added to tickets');

    // 4. Create index on event_id
    await db.query(`CREATE INDEX IF NOT EXISTS idx_tickets_event_id ON tickets(event_id)`);
    console.log('✓ Tickets event_id index created');

    // 5. Update ticket_type constraint to only allow 'attendee'
    await db.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.table_constraints 
          WHERE constraint_name = 'valid_ticket_type' AND table_name = 'tickets'
        ) THEN
          ALTER TABLE tickets DROP CONSTRAINT valid_ticket_type;
        END IF;
      END $$;
    `);
    // Set all existing tickets to attendee type
    await db.query(`UPDATE tickets SET ticket_type = 'attendee' WHERE ticket_type != 'attendee'`);
    await db.query(`ALTER TABLE tickets ALTER COLUMN ticket_type SET DEFAULT 'attendee'`);
    console.log('✓ All tickets converted to attendee type');

    // 6. Remove convention-specific date columns from settings, add org_name
    await db.query(`
      DO $$
      BEGIN
        -- Rename convention_name to org_name if not already done
        IF EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'settings' AND column_name = 'convention_name'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'settings' AND column_name = 'org_name'
        ) THEN
          ALTER TABLE settings RENAME COLUMN convention_name TO org_name;
        END IF;
      END $$;
    `);
    console.log('✓ Settings table updated');

    console.log('Event-based refactoring migration completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Migration error:', error);
    process.exit(1);
  }
}

refactorToEvents();
