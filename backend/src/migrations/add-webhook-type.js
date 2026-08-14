const db = require('../config/database');

async function addWebhookType() {
  try {
    console.log('Adding webhook_type column to webhook_logs table...');
    
    await db.query(`
      ALTER TABLE webhook_logs 
      ADD COLUMN IF NOT EXISTS webhook_type VARCHAR(50) DEFAULT 'order_create'
    `);
    
    console.log('✓ Successfully added webhook_type column');
    process.exit(0);
  } catch (error) {
    console.error('Error adding webhook_type column:', error);
    process.exit(1);
  }
}

addWebhookType();
