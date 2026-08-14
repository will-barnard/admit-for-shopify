const db = require('../config/database');

// Middleware to check if lockdown mode is enabled
const checkLockdown = async (req, res, next) => {
  try {
    const result = await db.query('SELECT lockdown_mode FROM settings LIMIT 1');
    
    if (result.rows.length > 0 && result.rows[0].lockdown_mode === true) {
      return res.status(423).json({ 
        error: 'Database is in lockdown mode',
        message: '🔒 The system is currently in lockdown mode. All ticket creation and scanning operations are temporarily disabled.'
      });
    }
    
    next();
  } catch (error) {
    console.error('Error checking lockdown mode:', error);
    // If we can't check, allow the request to proceed (fail open)
    next();
  }
};

module.exports = checkLockdown;
