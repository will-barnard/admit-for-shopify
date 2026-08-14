require('dotenv').config();
const db = require('../config/database');

async function createWebhookLogsTable() {
  try {
    console.log('Creating webhook_logs table...');

    await db.query(`
      CREATE TABLE IF NOT EXISTS webhook_logs (
        id SERIAL PRIMARY KEY,
        shopify_order_id VARCHAR(255),
        webhook_data JSONB NOT NULL,
        processed BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        processed_at TIMESTAMP,
        error_message TEXT,
        tickets_created INTEGER DEFAULT 0
      )
    `);
    
    console.log('✓ webhook_logs table created');

    // Create index on shopify_order_id for faster lookups
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_webhook_logs_order_id 
      ON webhook_logs(shopify_order_id)
    `);
    
    console.log('✓ Index on shopify_order_id created');

    // Create index on processed for filtering
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_webhook_logs_processed 
      ON webhook_logs(processed)
    `);
    
    console.log('✓ Index on processed created');

    process.exit(0);
  } catch (error) {
    console.error('Error creating webhook_logs table:', error);
    process.exit(1);
  }
}

createWebhookLogsTable();
