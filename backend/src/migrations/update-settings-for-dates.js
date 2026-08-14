require('dotenv').config();
const db = require('../config/database');

async function updateSettingsForDates() {
  try {
    console.log('Updating settings table with convention dates...');

    // Add date columns
    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'settings' AND column_name = 'friday_date'
        ) THEN
          ALTER TABLE settings ADD COLUMN friday_date DATE;
        END IF;
        
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'settings' AND column_name = 'saturday_date'
        ) THEN
          ALTER TABLE settings ADD COLUMN saturday_date DATE;
        END IF;
        
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'settings' AND column_name = 'sunday_date'
        ) THEN
          ALTER TABLE settings ADD COLUMN sunday_date DATE;
        END IF;
      END $$;
    `);
    console.log('✓ Date columns added to settings table');

    console.log('Settings table updated successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Migration error:', error);
    process.exit(1);
  }
}

updateSettingsForDates();
