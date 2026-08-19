const express = require('express');
const router = express.Router();
const db = require('../config/database');
const auth = require('../middleware/auth');
const superAdminMiddleware = require('../middleware/superadmin');
const multer = require('multer');
const requireRole = require('../middleware/require-role');
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

// SVG is deliberately absent. An SVG is an XML document that can carry
// <script>, and uploads are served from this app's own origin - so an uploaded
// logo would be stored XSS against the admin session, reachable by anyone who
// can upload a logo. The old filter also matched loosely (a regex `test` on the
// mime type, so "image/svg+xml" passed the check for "svg"); both the extension
// and the mime type are now exact-matched against a list.
const ALLOWED_LOGO_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const ALLOWED_LOGO_MIMETYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    const extname = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_LOGO_EXTENSIONS.has(extname) && ALLOWED_LOGO_MIMETYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Logo must be a JPEG, PNG, GIF or WebP image'));
    }
  }
});

/**
 * One CSV cell, quoted per RFC 4180 and defused for spreadsheets.
 *
 * Two separate problems. An embedded double quote used to end the field early,
 * so an attendee named `Bob" ,x` shifted every later column. And Excel, Sheets
 * and LibreOffice execute a cell that begins with = + - @, so an attendee could
 * choose a name that runs a formula when staff open the export - the classic
 * CSV injection. Both attendee names arrive from Shopify order payloads, which
 * are attacker-controlled.
 */
function csvCell(value) {
  if (value === null || value === undefined) return '""';
  let str = String(value);
  if (/^[=+\-@\t\r]/.test(str)) str = `'${str}`;
  return `"${str.replace(/"/g, '""')}"`;
}

// Changing how the organisation presents itself is not a door-staff action.
const canManageSettings = requireRole('admin', 'superadmin');

// Get public settings (no auth - used for logo/org name on the login pages).
// IMPORTANT: this endpoint is unauthenticated. Only ever return the columns
// whitelisted below. It previously returned SELECT *, which leaked
// receive_mode_secret and made /api/migration/receive world-writable.
const PUBLIC_SETTINGS_COLUMNS = ['org_name', 'logo_url'];

router.get('/', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT ${PUBLIC_SETTINGS_COLUMNS.join(', ')} FROM settings WHERE shop_id = $1`,
      [req.shopId]
    );
    if (result.rows.length === 0) {
      return res.json({ org_name: 'My Organization', logo_url: null });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching public settings:', error);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// Get full settings (authenticated). Used by the admin Settings page.
// receive_mode_secret is only returned to superadmins.
router.get('/admin', auth, async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM settings WHERE shop_id = $1', [req.shopId]);
    if (result.rows.length === 0) {
      return res.json({
        id: 1,
        org_name: 'My Organization',
        logo_url: null,
        auto_send_emails: true,
        lockdown_mode: false,
        receive_mode_enabled: false,
        timezone: 'America/Chicago'
      });
    }

    const settings = { ...result.rows[0] };
    if (req.user.role !== 'superadmin') {
      delete settings.receive_mode_secret;
    }
    res.json(settings);
  } catch (error) {
    console.error('Error fetching settings:', error);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// Update settings
router.put('/', auth, canManageSettings, async (req, res) => {
  try {
    const { org_name, auto_send_emails, timezone } = req.body;
    
    // Check if settings exist
    const result = await db.query(
      `INSERT INTO settings (shop_id, org_name, auto_send_emails, timezone, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (shop_id) DO UPDATE
          SET org_name = EXCLUDED.org_name,
              auto_send_emails = EXCLUDED.auto_send_emails,
              timezone = EXCLUDED.timezone,
              updated_at = NOW()
       RETURNING *`,
      [req.shopId, org_name, auto_send_emails !== undefined ? auto_send_emails : true, timezone || 'America/Chicago']
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating settings:', error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// Upload logo
router.post('/logo', auth, canManageSettings, upload.single('logo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const logoUrl = `/uploads/logos/${req.file.filename}`;
    
    // Check if settings exist
    const checkResult = await db.query('SELECT * FROM settings WHERE shop_id = $1', [req.shopId]);

    // Remove the previous logo file if there was one
    if (checkResult.rows[0]?.logo_url) {
      const oldLogoPath = path.join(__dirname, '../..', checkResult.rows[0].logo_url);
      if (fs.existsSync(oldLogoPath)) {
        fs.unlinkSync(oldLogoPath);
      }
    }

    const result = await db.query(
      `INSERT INTO settings (shop_id, org_name, logo_url, updated_at)
       VALUES ($1, 'My Organization', $2, NOW())
       ON CONFLICT (shop_id) DO UPDATE
          SET logo_url = EXCLUDED.logo_url, updated_at = NOW()
       RETURNING *`,
      [req.shopId, logoUrl]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error uploading logo:', error);
    res.status(500).json({ error: 'Failed to upload logo' });
  }
});

// Delete logo
router.delete('/logo', auth, canManageSettings, async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM settings WHERE shop_id = $1', [req.shopId]);

    if (result.rows.length > 0 && result.rows[0].logo_url) {
      // Delete file
      const logoPath = path.join(__dirname, '../..', result.rows[0].logo_url);
      if (fs.existsSync(logoPath)) {
        fs.unlinkSync(logoPath);
      }
      
      // Update database
      await db.query(
        'UPDATE settings SET logo_url = NULL, updated_at = NOW() WHERE shop_id = $1',
        [req.shopId]
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
    const checkResult = await db.query('SELECT * FROM settings WHERE shop_id = $1', [req.shopId]);

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
      'UPDATE settings SET receive_mode_enabled = $1, receive_mode_secret = $2, updated_at = NOW() WHERE shop_id = $3 RETURNING receive_mode_enabled, receive_mode_secret',
      [enabled, secret, req.shopId]
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
    const result = await db.query(
      'UPDATE settings SET lockdown_mode = $1, updated_at = NOW() WHERE shop_id = $2 RETURNING lockdown_mode',
      [enabled, req.shopId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Settings not found' });
    }
    
    console.log(`🔒 Lockdown mode ${enabled ? 'ENABLED - Database is now READ-ONLY' : 'DISABLED - Normal operations resumed'}`);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error toggling lockdown mode:', error);
    res.status(500).json({ error: 'Failed to toggle lockdown mode' });
  }
});

// Export tickets without emails as CSV (Admin/SuperAdmin only)
router.get('/export-no-email-tickets', auth, canManageSettings, async (req, res) => {
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
      LEFT JOIN ticket_scans ts ON t.id = ts.ticket_id AND ts.shop_id = t.shop_id
      WHERE t.shop_id = $1 AND t.email IS NULL
      ORDER BY t.created_at DESC
    `, [req.shopId]);

    // Convert to CSV
    const tickets = result.rows;
    if (tickets.length === 0) {
      return res.status(404).json({ message: 'No tickets without email found' });
    }

    const csvHeader = 'ID,Event,Name,Order ID,Status,Scanned,Created At\n';
    const csvRows = tickets.map(ticket => [
      ticket.id,
      ticket.event_name,
      ticket.name,
      ticket.shopify_order_id,
      ticket.status || 'valid',
      ticket.scanned,
      new Date(ticket.created_at).toISOString()
    ].map(csvCell).join(',')).join('\n');

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
