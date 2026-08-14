require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('../config/database');

async function seedVerifier() {
  try {
    console.log('Checking for default verifier user...');

    // Check if verifier exists
    const result = await db.query(
      "SELECT id FROM users WHERE username = 'verifier'"
    );

    if (result.rows.length === 0) {
      // Create default verifier
      const hashedPassword = await bcrypt.hash('verifier123', 10);
      
      await db.query(
        "INSERT INTO users (username, password, role) VALUES ($1, $2, $3)",
        ['verifier', hashedPassword, 'verifier']
      );

      console.log('✓ Default verifier user created');
      console.log('  Username: verifier');
      console.log('  Password: verifier123');
      console.log('  ⚠️  Please change the password after first login!');
    } else {
      console.log('✓ Verifier user already exists');
    }

    process.exit(0);
  } catch (error) {
    console.error('Error seeding verifier:', error);
    process.exit(1);
  }
}

seedVerifier();
