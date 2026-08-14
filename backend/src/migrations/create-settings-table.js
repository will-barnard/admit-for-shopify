require('dotenv').config();
const db = require('../config/database');

async function createSettingsTable() {
  try {
    console.log('Creating settings table...');

    await db.query(`
      CREATE TABLE IF NOT EXISTS settings (
        id SERIAL PRIMARY KEY,
        convention_name VARCHAR(255) NOT NULL DEFAULT 'My Convention',
        logo_url TEXT,
        enable_ticket_cap BOOLEAN DEFAULT FALSE,
        ticket_cap INTEGER DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    console.log('✓ Settings table created');

    // Insert default settings if table is empty
    const result = await db.query('SELECT COUNT(*) FROM settings');
    if (parseInt(result.rows[0].count) === 0) {
      await db.query(`
        INSERT INTO settings (convention_name) 
        VALUES ('Chicago Drum Show')
      `);
      console.log('✓ Default settings inserted');
    }

    process.exit(0);
  } catch (error) {
    console.error('Error creating settings table:', error);
    process.exit(1);
  }
}

createSettingsTable();
