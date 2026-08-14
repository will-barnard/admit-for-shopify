const express = require('express');
const router = express.Router();
const db = require('../config/database');
const auth = require('../middleware/auth');
const superAdminMiddleware = require('../middleware/superadmin');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Configure multer for logo upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '../../uploads/logos');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'logo-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|svg/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    if (extname && mimetype) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

// Get settings (public - no auth required for logo on login pages)
router.get('/', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM settings LIMIT 1');
    if (result.rows.length === 0) {
      // Return default settings if none exist
      return res.json({
        id: 1,
        org_name: 'My Organization',
        logo_url: null,
        auto_send_emails: true,
        lockdown_mode: false,
        timezone: 'America/Chicago'
      });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching settings:', error);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// Update settings
router.put('/', auth, async (req, res) => {
  try {
    const { org_name, auto_send_emails, timezone } = req.body;
    
    // Check if settings exist
    const checkResult = await db.query('SELECT * FROM settings LIMIT 1');
    
    if (checkResult.rows.length === 0) {
      const result = await db.query(
        'INSERT INTO settings (org_name, auto_send_emails, timezone, updated_at) VALUES ($1, $2, $3, NOW()) RETURNING *',
        [org_name, auto_send_emails !== undefined ? auto_send_emails : true, timezone || 'America/Chicago']
      );
      res.json(result.rows[0]);
    } else {
      const result = await db.query(
        'UPDATE settings SET org_name = $1, auto_send_emails = $2, timezone = $3, updated_at = NOW() WHERE id = $4 RETURNING *',
        [org_name, auto_send_emails !== undefined ? auto_send_emails : true, timezone || 'America/Chicago', checkResult.rows[0].id]
      );
      res.json(result.rows[0]);
    }
  } catch (error) {
    console.error('Error updating settings:', error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// Upload logo
router.post('/logo', auth, upload.single('logo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const logoUrl = `/uploads/logos/${req.file.filename}`;
    
    // Check if settings exist
    const checkResult = await db.query('SELECT * FROM settings LIMIT 1');
    
    if (checkResult.rows.length === 0) {
      // Insert new settings with logo
      const result = await db.query(
        'INSERT INTO settings (org_name, logo_url, updated_at) VALUES ($1, $2, NOW()) RETURNING *',
        ['My Organization', logoUrl]
      );
      res.json(result.rows[0]);
    } else {
      // Delete old logo if exists
      if (checkResult.rows[0].logo_url) {
        const oldLogoPath = path.join(__dirname, '../..', checkResult.rows[0].logo_url);
        if (fs.existsSync(oldLogoPath)) {
          fs.unlinkSync(oldLogoPath);
        }
      }
      
      // Update with new logo
      const result = await db.query(
        'UPDATE settings SET logo_url = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
        [logoUrl, checkResult.rows[0].id]
      );
      res.json(result.rows[0]);
    }
  } catch (error) {
    console.error('Error uploading logo:', error);
    res.status(500).json({ error: 'Failed to upload logo' });
  }
});

// Delete logo
router.delete('/logo', auth, async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM settings LIMIT 1');
    
    if (result.rows.length > 0 && result.rows[0].logo_url) {
      // Delete file
      const logoPath = path.join(__dirname, '../..', result.rows[0].logo_url);
      if (fs.existsSync(logoPath)) {
        fs.unlinkSync(logoPath);
      }
      
      // Update database
      await db.query(
        'UPDATE settings SET logo_url = NULL, updated_at = NOW() WHERE id = $1',
        [result.rows[0].id]
      );
    }
    
    res.json({ message: 'Logo deleted successfully' });
  } catch (error) {
    console.error('Error deleting logo:', error);
    res.status(500).json({ error: 'Failed to delete logo' });
  }
});

// Toggle receive mode (SuperAdmin only)
router.put('/receive-mode', superAdminMiddleware, async (req, res) => {
  try {
    const { enabled } = req.body;
    
    // Get current settings
    const checkResult = await db.query('SELECT * FROM settings LIMIT 1');
    
    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: 'Settings not found' });
    }
    
    let secret = checkResult.rows[0].receive_mode_secret;
    
    // Generate new secret if enabling and no secret exists
    if (enabled && !secret) {
      secret = crypto.randomBytes(32).toString('hex');
    }
    
    // Clear secret if disabling
    if (!enabled) {
      secret = null;
    }
    
    const result = await db.query(
      'UPDATE settings SET receive_mode_enabled = $1, receive_mode_secret = $2, updated_at = NOW() WHERE id = $3 RETURNING receive_mode_enabled, receive_mode_secret',
      [enabled, secret, checkResult.rows[0].id]
    );
    
    console.log(`Receive mode ${enabled ? 'enabled' : 'disabled'}`);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error toggling receive mode:', error);
    res.status(500).json({ error: 'Failed to toggle receive mode' });
  }
});

// Toggle lockdown mode (SuperAdmin only)
router.put('/lockdown-mode', superAdminMiddleware, async (req, res) => {
  try {
    const { enabled } = req.body;
    
    // Get current settings
    const checkResult = await db.query('SELECT * FROM settings LIMIT 1');
    
    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: 'Settings not found' });
    }
    
    const result = await db.query(
      'UPDATE settings SET lockdown_mode = $1, updated_at = NOW() WHERE id = $2 RETURNING lockdown_mode',
      [enabled, checkResult.rows[0].id]
    );
    
    console.log(`🔒 Lockdown mode ${enabled ? 'ENABLED - Database is now READ-ONLY' : 'DISABLED - Normal operations resumed'}`);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error toggling lockdown mode:', error);
    res.status(500).json({ error: 'Failed to toggle lockdown mode' });
  }
});

// Export tickets without emails as CSV (Admin/SuperAdmin only)
router.get('/export-no-email-tickets', auth, async (req, res) => {
  // Allow both admin and superadmin
  if (req.user.role !== 'admin' && req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  try {
    const result = await db.query(`
      SELECT 
        t.id,
        e.name as event_name,
        t.name,
        t.shopify_order_id,
        t.status,
        t.created_at,
        CASE WHEN ts.ticket_id IS NOT NULL THEN 'Yes' ELSE 'No' END as scanned
      FROM tickets t
      LEFT JOIN events e ON t.event_id = e.id
      LEFT JOIN ticket_scans ts ON t.id = ts.ticket_id
      WHERE t.email IS NULL
      ORDER BY t.created_at DESC
    `);

    // Convert to CSV
    const tickets = result.rows;
    if (tickets.length === 0) {
      return res.status(404).json({ message: 'No tickets without email found' });
    }

    const csvHeader = 'ID,Event,Name,Order ID,Status,Scanned,Created At\n';
    const csvRows = tickets.map(ticket => {
      return [
        ticket.id,
        ticket.event_name ? `"${ticket.event_name}"` : '',
        `"${ticket.name}"`,
        ticket.shopify_order_id || '',
        ticket.status || 'valid',
        ticket.scanned,
        new Date(ticket.created_at).toISOString()
      ].join(',');
    }).join('\n');

    const csv = csvHeader + csvRows;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="no-email-tickets-${Date.now()}.csv"`);
    res.send(csv);
  } catch (error) {
    console.error('Error exporting no-email tickets:', error);
    res.status(500).json({ error: 'Failed to export tickets' });
  }
});

module.exports = router;
