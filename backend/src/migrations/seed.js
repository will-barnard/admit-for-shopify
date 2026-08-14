require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('../config/database');

async function seedAdminUser() {
  try {
    console.log('Checking for default admin user...');

    // Check if admin user exists
    const existingAdmin = await db.query(
      'SELECT id FROM users WHERE username = $1',
      ['admin']
    );

    if (existingAdmin.rows.length > 0) {
      console.log('✓ Admin user already exists');
      process.exit(0);
      return;
    }

    // Create default admin user
    const hashedPassword = await bcrypt.hash('admin123', 10);
    
    await db.query(
      'INSERT INTO users (username, password) VALUES ($1, $2)',
      ['admin', hashedPassword]
    );

    console.log('✓ Default admin user created');
    console.log('  Username: admin');
    console.log('  Password: admin123');
    console.log('  ⚠️  Please change the password after first login!');
    
    process.exit(0);
  } catch (error) {
    console.error('Error seeding admin user:', error);
    process.exit(1);
  }
}

seedAdminUser();
