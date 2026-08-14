require('dotenv').config();
const db = require('../config/database');

async function updateSettingsForEmailToggle() {
  try {
    console.log('Updating settings table for email toggle...');

    // Add auto_send_emails column
    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'settings' AND column_name = 'auto_send_emails'
        ) THEN
          ALTER TABLE settings ADD COLUMN auto_send_emails BOOLEAN DEFAULT true;
        END IF;
      END $$;
    `);
    console.log('✓ auto_send_emails column added to settings table');

    console.log('Settings table updated successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Migration error:', error);
    process.exit(1);
  }
}

updateSettingsForEmailToggle();
