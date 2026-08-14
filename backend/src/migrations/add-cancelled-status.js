const db = require('../config/database');

async function addCancelledStatus() {
  try {
    console.log('Updating ticket status constraint to include cancelled...');
    
    // Drop the old constraint
    await db.query(`
      ALTER TABLE tickets DROP CONSTRAINT IF EXISTS valid_ticket_status
    `);
    
    // Add the new constraint with 'cancelled' included
    await db.query(`
      ALTER TABLE tickets ADD CONSTRAINT valid_ticket_status 
      CHECK (status IN ('valid', 'invalid', 'refunded', 'cancelled', 'chargeback'))
    `);
    
    console.log('✓ Successfully updated ticket status constraint to include cancelled');
    process.exit(0);
  } catch (error) {
    console.error('Error updating ticket status constraint:', error);
    process.exit(1);
  }
}

addCancelledStatus();
