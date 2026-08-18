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

    // Shopify webhook delivery id, used to deduplicate. Shopify documents
    // X-Shopify-Webhook-Id as a unique composite key per delivery and retries
    // 8 times over 4 hours, so the same delivery can legitimately arrive twice.
    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'webhook_logs' AND column_name = 'delivery_id'
        ) THEN
          ALTER TABLE webhook_logs ADD COLUMN delivery_id VARCHAR(255);
        END IF;
      END $$;
    `);
    await db.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_logs_delivery_id
         ON webhook_logs(delivery_id) WHERE delivery_id IS NOT NULL`
    );
    console.log('\u2713 Webhook delivery_id ensured');

    // ---------------------------------------------------------------
    // Multi-tenancy
    //
    // Every tenant-owned row belongs to a shop. Today there is exactly one
    // shop (the legacy single-tenant install), but the column and the
    // constraints exist from here on so that adding a second tenant is a data
    // change rather than a schema migration.
    //
    // `users` is deliberately NOT shop-scoped: it is the legacy app-owned auth
    // system, which a Shopify app replaces with session tokens rather than
    // partitions. It goes away at cutover.
    // ---------------------------------------------------------------

    await db.query(`
      CREATE TABLE IF NOT EXISTS shops (
        id SERIAL PRIMARY KEY,
        domain VARCHAR(255) UNIQUE NOT NULL,
        access_token TEXT,
        access_token_expires_at TIMESTAMP,
        refresh_token TEXT,
        refresh_token_expires_at TIMESTAMP,
        scopes TEXT,
        installed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        uninstalled_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✓ Shops table created');

    // The tenant that owns all pre-existing data. Overridable so a real
    // myshopify.com domain can be used from the start on a fresh install.
    const legacyDomain = process.env.DEFAULT_SHOP_DOMAIN || 'legacy.local';
    await db.query(
      `INSERT INTO shops (domain) VALUES ($1) ON CONFLICT (domain) DO NOTHING`,
      [legacyDomain]
    );
    const legacyShop = await db.query('SELECT id FROM shops WHERE domain = $1', [legacyDomain]);
    const legacyShopId = legacyShop.rows[0].id;
    console.log(`✓ Default shop ensured: ${legacyDomain} (id ${legacyShopId})`);

    // settings is one row per shop. Collapse any historical duplicates first,
    // otherwise the unique constraint below cannot be created.
    await db.query(`
      DELETE FROM settings a USING settings b
       WHERE a.id > b.id
    `);

    const tenantTables = ['events', 'tickets', 'ticket_scans', 'settings', 'webhook_logs', 'email_send_log'];
    for (const table of tenantTables) {
      await db.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = '${table}' AND column_name = 'shop_id'
          ) THEN
            ALTER TABLE ${table} ADD COLUMN shop_id INTEGER REFERENCES shops(id) ON DELETE CASCADE;
          END IF;
        END $$;
      `);
      await db.query(`UPDATE ${table} SET shop_id = $1 WHERE shop_id IS NULL`, [legacyShopId]);
      await db.query(`ALTER TABLE ${table} ALTER COLUMN shop_id SET NOT NULL`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_${table}_shop_id ON ${table}(shop_id)`);
    }
    console.log('✓ shop_id backfilled and enforced on ' + tenantTables.join(', '));

    // Ensure a settings row exists for the default shop.
    await db.query(
      `INSERT INTO settings (shop_id) SELECT $1
        WHERE NOT EXISTS (SELECT 1 FROM settings WHERE shop_id = $1)`,
      [legacyShopId]
    );
    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'settings_shop_id_key'
        ) THEN
          ALTER TABLE settings ADD CONSTRAINT settings_shop_id_key UNIQUE (shop_id);
        END IF;
      END $$;
    `);
    console.log('✓ One settings row per shop enforced');

    // events.sku was globally unique, which would stop two merchants from ever
    // using the same SKU string. It must be unique per shop instead.
    await db.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'events_sku_key') THEN
          ALTER TABLE events DROP CONSTRAINT events_sku_key;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'events_shop_id_sku_key') THEN
          ALTER TABLE events ADD CONSTRAINT events_shop_id_sku_key UNIQUE (shop_id, sku);
        END IF;
      END $$;
    `);
    console.log('✓ events.sku is now unique per shop');

    // tickets.uuid stays GLOBALLY unique on purpose: it is a random UUID and
    // GET /api/verify/:uuid looks it up without knowing the shop up front.
    await db.query(`CREATE INDEX IF NOT EXISTS idx_tickets_shop_created ON tickets(shop_id, created_at DESC)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_events_shop_active ON events(shop_id, active, archived)`);

    // ---------------------------------------------------------------
    // Ticket types
    //
    // An event has ONE OR MORE ticket types. A simple event has exactly one -
    // which is what every pre-existing event is migrated to below, so nothing
    // about a single-type event changes.
    //
    // Each ticket type maps to a Shopify product variant. Matching prefers
    // shopify_variant_id: a variant id is immutable, whereas a SKU is free text
    // a merchant can edit in the Shopify product admin at any time, silently
    // breaking the mapping. SKU is kept as a fallback for orders placed before
    // a variant id was recorded.
    // ---------------------------------------------------------------

    await db.query(`
      CREATE TABLE IF NOT EXISTS event_ticket_types (
        id SERIAL PRIMARY KEY,
        shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
        event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        shopify_variant_id VARCHAR(255),
        shopify_product_id VARCHAR(255),
        shopify_sku VARCHAR(255),
        capacity INTEGER,
        sort_order INTEGER DEFAULT 0,
        active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('\u2713 Ticket types table created');

    await db.query(`CREATE INDEX IF NOT EXISTS idx_ticket_types_shop ON event_ticket_types(shop_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_ticket_types_event ON event_ticket_types(event_id)`);
    // Partial unique indexes: a variant or SKU may only be claimed once per
    // shop, but many ticket types legitimately have neither set yet.
    await db.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ticket_types_variant
        ON event_ticket_types(shop_id, shopify_variant_id)
        WHERE shopify_variant_id IS NOT NULL
    `);
    await db.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ticket_types_sku
        ON event_ticket_types(shop_id, lower(shopify_sku))
        WHERE shopify_sku IS NOT NULL
    `);

    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'tickets' AND column_name = 'ticket_type_id'
        ) THEN
          ALTER TABLE tickets
            ADD COLUMN ticket_type_id INTEGER REFERENCES event_ticket_types(id) ON DELETE SET NULL;
        END IF;
      END $$;
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_tickets_ticket_type ON tickets(ticket_type_id)`);
    console.log('\u2713 tickets.ticket_type_id ensured');

    // Backfill: one ticket type per existing event, carrying that event's SKU.
    // Named "General Admission" rather than reusing the event name, which would
    // read as "Chicago Drum Show / Chicago Drum Show" in the UI. Rename freely.
    await db.query(`
      INSERT INTO event_ticket_types (shop_id, event_id, name, shopify_sku, sort_order)
      SELECT e.shop_id, e.id, 'General Admission', e.sku, 0
        FROM events e
       WHERE NOT EXISTS (
         SELECT 1 FROM event_ticket_types tt WHERE tt.event_id = e.id
       )
    `);

    // Point existing tickets at their event's ticket type. Events migrated
    // above have exactly one, so this is unambiguous.
    await db.query(`
      UPDATE tickets t
         SET ticket_type_id = tt.id
        FROM event_ticket_types tt
       WHERE t.ticket_type_id IS NULL
         AND tt.event_id = t.event_id
         AND tt.shop_id = t.shop_id
    `);
    console.log('\u2713 Existing events backfilled with a single ticket type');

    // Record which line items an order contained that matched no ticket type,
    // so a mistyped or unmapped SKU is visible instead of silently producing
    // nothing. See routes/webhooks.js and the "needs attention" list.
    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'webhook_logs' AND column_name = 'unmatched_line_items'
        ) THEN
          ALTER TABLE webhook_logs ADD COLUMN unmatched_line_items JSONB;
        END IF;
      END $$;
    `);
    console.log('\u2713 webhook_logs.unmatched_line_items ensured');

    console.log('Migrations completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Migration error:', error);
    process.exit(1);
  }
}

runMigrations();
