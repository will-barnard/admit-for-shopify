require('dotenv').config();
const db = require('../config/database');

async function runMigrations() {
  try {
    console.log('Running migrations...');

    // Create users table
    await db.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        role VARCHAR(50) DEFAULT 'admin',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT valid_role CHECK (role IN ('admin', 'verifier', 'superadmin'))
      )
    `);
    console.log('✓ Users table created');

    // Ensure role constraint
    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'users' AND column_name = 'role'
        ) THEN
          ALTER TABLE users ADD COLUMN role VARCHAR(50) DEFAULT 'admin';
        END IF;
        
        IF EXISTS (
          SELECT 1 FROM information_schema.table_constraints 
          WHERE constraint_name = 'valid_role' AND table_name = 'users'
        ) THEN
          ALTER TABLE users DROP CONSTRAINT valid_role;
        END IF;
        ALTER TABLE users ADD CONSTRAINT valid_role CHECK (role IN ('admin', 'verifier', 'superadmin'));
      END $$;
    `);
    console.log('✓ Role column ensured');

    // Create events table
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
        archived BOOLEAN DEFAULT FALSE,
        archived_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✓ Events table created');

    // Add archived columns if upgrading from old schema
    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'events' AND column_name = 'archived'
        ) THEN
          ALTER TABLE events ADD COLUMN archived BOOLEAN DEFAULT FALSE;
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'events' AND column_name = 'archived_at'
        ) THEN
          ALTER TABLE events ADD COLUMN archived_at TIMESTAMP;
        END IF;
      END $$;
    `);
    console.log('✓ Events archived columns ensured');

    await db.query(`CREATE INDEX IF NOT EXISTS idx_events_sku ON events(sku)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_events_active ON events(active)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_events_date ON events(event_date)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_events_archived ON events(archived)`);
    console.log('✓ Events indexes created');

    // Create tickets table (single type: attendee, linked to events)
    await db.query(`
      CREATE TABLE IF NOT EXISTS tickets (
        id SERIAL PRIMARY KEY,
        ticket_type VARCHAR(50) NOT NULL DEFAULT 'attendee',
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255),
        uuid VARCHAR(255) UNIQUE NOT NULL,
        is_used BOOLEAN DEFAULT FALSE,
        used_at TIMESTAMP,
        status VARCHAR(50) DEFAULT 'valid',
        shopify_order_id VARCHAR(255),
        event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
        email_sent BOOLEAN DEFAULT false,
        email_sent_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT valid_ticket_status CHECK (status IN ('valid', 'invalid', 'refunded', 'cancelled', 'chargeback'))
      )
    `);
    console.log('✓ Tickets table created');

    // Add event_id if upgrading from old schema
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

    // Make email column nullable
    await db.query(`
      DO $$
      BEGIN
        ALTER TABLE tickets ALTER COLUMN email DROP NOT NULL;
      EXCEPTION WHEN others THEN
        NULL;
      END $$;
    `);
    console.log('✓ Email column made nullable');

    // Track which Shopify line item a ticket came from, so partial refunds can
    // void only the refunded tickets instead of the whole order.
    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'tickets' AND column_name = 'shopify_line_item_id'
        ) THEN
          ALTER TABLE tickets ADD COLUMN shopify_line_item_id VARCHAR(255);
        END IF;
      END $$;
    `);
    console.log('\u2713 shopify_line_item_id column ensured');

    // Create ticket scans table
    await db.query(`
      CREATE TABLE IF NOT EXISTS ticket_scans (
        id SERIAL PRIMARY KEY,
        ticket_id INTEGER REFERENCES tickets(id) ON DELETE CASCADE,
        scanned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        scan_date DATE DEFAULT CURRENT_DATE,
        scanned_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
      )
    `);
    console.log('✓ Ticket scans table created');

    // Create indexes
    await db.query(`CREATE INDEX IF NOT EXISTS idx_tickets_uuid ON tickets(uuid)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_tickets_email ON tickets(email)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_tickets_shopify_order_id ON tickets(shopify_order_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_tickets_event_id ON tickets(event_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_tickets_shopify_line_item_id ON tickets(shopify_line_item_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_ticket_scans_ticket_date ON ticket_scans(ticket_id, scan_date)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_ticket_scans_user ON ticket_scans(scanned_by_user_id)`);
    console.log('✓ Indexes created');

    // Create settings table
    await db.query(`
      CREATE TABLE IF NOT EXISTS settings (
        id SERIAL PRIMARY KEY,
        org_name VARCHAR(255) NOT NULL DEFAULT 'My Organization',
        logo_url TEXT,
        auto_send_emails BOOLEAN DEFAULT true,
        lockdown_mode BOOLEAN DEFAULT FALSE,
        receive_mode_enabled BOOLEAN DEFAULT FALSE,
        receive_mode_secret TEXT,
        timezone VARCHAR(100) DEFAULT 'America/Chicago',
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✓ Settings table created');

    // Handle migration from old convention_name to org_name
    await db.query(`
      DO $$
      BEGIN
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
    console.log('✓ Settings column migration ensured');

    // Add status column if missing (old schema upgrade)
    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'tickets' AND column_name = 'status'
        ) THEN
          ALTER TABLE tickets ADD COLUMN status VARCHAR(50) DEFAULT 'valid';
        END IF;
      END $$;
    `);
    console.log('✓ Status column ensured');

    // Create webhook_logs table
    await db.query(`
      CREATE TABLE IF NOT EXISTS webhook_logs (
        id SERIAL PRIMARY KEY,
        shopify_order_id VARCHAR(255),
        webhook_data JSONB NOT NULL,
        processed BOOLEAN DEFAULT FALSE,
        webhook_type VARCHAR(50) DEFAULT 'order_create',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        processed_at TIMESTAMP,
        error_message TEXT,
        tickets_created INTEGER DEFAULT 0
      )
    `);
    console.log('✓ Webhook logs table created');

    await db.query(`CREATE INDEX IF NOT EXISTS idx_webhook_logs_order_id ON webhook_logs(shopify_order_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_webhook_logs_processed ON webhook_logs(processed)`);

    // Create email send log table
    await db.query(`
      CREATE TABLE IF NOT EXISTS email_send_log (
        id SERIAL PRIMARY KEY,
        sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        recipient_email VARCHAR(255) NOT NULL,
        ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
        send_type VARCHAR(50) NOT NULL,
        success BOOLEAN DEFAULT true
      )
    `);
    console.log('✓ Email send log table created');

    await db.query(`CREATE INDEX IF NOT EXISTS idx_email_send_log_sent_at ON email_send_log(sent_at)`);

    console.log('Migrations completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Migration error:', error);
    process.exit(1);
  }
}

runMigrations();
