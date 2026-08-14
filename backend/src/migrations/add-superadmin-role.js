require('dotenv').config();
const db = require('../config/database');

async function addSuperAdminRole() {
  try {
    console.log('Adding superadmin role...');

    // Drop the old constraint and add new one with superadmin
    await db.query(`
      DO $$
      BEGIN
        -- Drop existing constraint if it exists
        IF EXISTS (
          SELECT 1 FROM information_schema.table_constraints 
          WHERE constraint_name = 'valid_role' AND table_name = 'users'
        ) THEN
          ALTER TABLE users DROP CONSTRAINT valid_role;
        END IF;
        
        -- Add new constraint with superadmin included
        ALTER TABLE users ADD CONSTRAINT valid_role CHECK (role IN ('admin', 'verifier', 'superadmin'));
      END $$;
    `);
    
    console.log('✓ SuperAdmin role added to valid roles');
    process.exit(0);
  } catch (error) {
    console.error('Error adding superadmin role:', error);
    process.exit(1);
  }
}

addSuperAdminRole();
