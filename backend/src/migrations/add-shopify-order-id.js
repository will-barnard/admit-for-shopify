require('dotenv').config();
const db = require('../config/database');

async function addShopifyOrderId() {
  try {
    console.log('Adding shopify_order_id field to tickets table...');

    await db.query(`
      DO $$
      BEGIN
        -- Add shopify_order_id column if it doesn't exist
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'tickets' AND column_name = 'shopify_order_id'
        ) THEN
          ALTER TABLE tickets ADD COLUMN shopify_order_id VARCHAR(255);
          RAISE NOTICE '✓ Added shopify_order_id column';
        ELSE
          RAISE NOTICE 'shopify_order_id column already exists';
        END IF;

        -- Add index for shopify_order_id for faster lookups
        IF NOT EXISTS (
          SELECT 1 FROM pg_indexes 
          WHERE tablename = 'tickets' AND indexname = 'idx_tickets_shopify_order_id'
        ) THEN
          CREATE INDEX idx_tickets_shopify_order_id ON tickets(shopify_order_id);
          RAISE NOTICE '✓ Added index on shopify_order_id';
        ELSE
          RAISE NOTICE 'Index on shopify_order_id already exists';
        END IF;
      END $$;
    `);

    console.log('✓ Shopify order ID field migration completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Migration error:', error);
    process.exit(1);
  }
}

addShopifyOrderId();
