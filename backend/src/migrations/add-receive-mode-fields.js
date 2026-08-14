require('dotenv').config();
const db = require('../config/database');

async function addReceiveModeFields() {
  try {
    console.log('Adding receive mode fields to settings table...');

    await db.query(`
      DO $$
      BEGIN
        -- Add receive_mode_enabled column if it doesn't exist
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'settings' AND column_name = 'receive_mode_enabled'
        ) THEN
          ALTER TABLE settings ADD COLUMN receive_mode_enabled BOOLEAN DEFAULT FALSE;
          RAISE NOTICE '✓ Added receive_mode_enabled column';
        ELSE
          RAISE NOTICE 'receive_mode_enabled column already exists';
        END IF;

        -- Add receive_mode_secret column if it doesn't exist
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'settings' AND column_name = 'receive_mode_secret'
        ) THEN
          ALTER TABLE settings ADD COLUMN receive_mode_secret TEXT;
          RAISE NOTICE '✓ Added receive_mode_secret column';
        ELSE
          RAISE NOTICE 'receive_mode_secret column already exists';
        END IF;
      END $$;
    `);

    console.log('✓ Receive mode fields migration completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Migration error:', error);
    process.exit(1);
  }
}

addReceiveModeFields();
