require('dotenv').config();
const db = require('../config/database');

async function addLockdownMode() {
  try {
    console.log('Adding lockdown_mode column to settings table...');

    // Check if column already exists
    const columnCheck = await db.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name='settings' AND column_name='lockdown_mode'
    `);

    if (columnCheck.rows.length === 0) {
      await db.query(`
        ALTER TABLE settings 
        ADD COLUMN lockdown_mode BOOLEAN DEFAULT FALSE
      `);
      console.log('✓ lockdown_mode column added to settings table');
    } else {
      console.log('✓ lockdown_mode column already exists');
    }

    process.exit(0);
  } catch (error) {
    console.error('Error adding lockdown_mode column:', error);
    process.exit(1);
  }
}

addLockdownMode();
