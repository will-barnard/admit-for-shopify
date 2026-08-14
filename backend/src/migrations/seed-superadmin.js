require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('../config/database');

async function seedSuperAdminUser() {
  try {
    console.log('Checking for default superadmin user...');

    // Check if superadmin user exists
    const existingSuperAdmin = await db.query(
      'SELECT id FROM users WHERE username = $1',
      ['superadmin']
    );

    if (existingSuperAdmin.rows.length > 0) {
      console.log('✓ SuperAdmin user already exists');
      process.exit(0);
      return;
    }

    // Create default superadmin user
    const hashedPassword = await bcrypt.hash('superadmin123', 10);
    
    await db.query(
      'INSERT INTO users (username, password, role) VALUES ($1, $2, $3)',
      ['superadmin', hashedPassword, 'superadmin']
    );

    console.log('✓ Default superadmin user created');
    console.log('  Username: superadmin');
    console.log('  Password: superadmin123');
    console.log('  ⚠️  Please change the password after first login!');
    
    process.exit(0);
  } catch (error) {
    console.error('Error seeding superadmin user:', error);
    process.exit(1);
  }
}

seedSuperAdminUser();
