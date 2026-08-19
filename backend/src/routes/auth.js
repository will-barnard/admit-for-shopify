const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const db = require('../config/database');
const { loginAttemptLimiter } = require('../middleware/rate-limit');

const router = express.Router();

// NOTE: the open POST /register endpoint was removed 2026-08-14.
// It was unauthenticated and new users defaulted to role='admin' (see migrations/run.js),
// which let anyone on the internet mint an admin account.
// Accounts are created by a superadmin via POST /api/user/create.

// Login
router.post('/login',
  loginAttemptLimiter,
  body('username').trim().notEmpty(),
  body('password').notEmpty(),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { username, password } = req.body;

      // Find user
      const result = await db.query(
        'SELECT id, username, password, role FROM users WHERE username = $1',
        [username]
      );

      if (result.rows.length === 0) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const user = result.rows[0];

      // Check password
      const isValidPassword = await bcrypt.compare(password, user.password);
      if (!isValidPassword) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      // Generate token
      const token = jwt.sign(
        { id: user.id, username: user.username, role: user.role },
        process.env.JWT_SECRET,
        // An unset JWT_EXPIRES_IN passes `expiresIn: undefined`, which jwt.sign
        // reads as "no expiry" - a stolen admin token would be valid forever.
        { expiresIn: process.env.JWT_EXPIRES_IN || '12h' }
      );

      res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
    } catch (error) {
      console.error('Login error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

module.exports = router;
