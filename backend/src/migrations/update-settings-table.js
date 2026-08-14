require('dotenv').config();
const db = require('../config/database');

async function updateSettingsTable() {
  try {
    console.log('Updating settings table...');

    // Add enable_ticket_cap column if it doesn't exist
    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'settings' AND column_name = 'enable_ticket_cap'
        ) THEN
          ALTER TABLE settings ADD COLUMN enable_ticket_cap BOOLEAN DEFAULT FALSE;
        END IF;
      END $$;
    `);
    console.log('✓ enable_ticket_cap column ensured');

    // Add ticket_cap column if it doesn't exist
    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'settings' AND column_name = 'ticket_cap'
        ) THEN
          ALTER TABLE settings ADD COLUMN ticket_cap INTEGER DEFAULT 0;
        END IF;
      END $$;
    `);
    console.log('✓ ticket_cap column ensured');

    console.log('Settings table updated successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Error updating settings table:', error);
    process.exit(1);
  }
}

updateSettingsTable();
