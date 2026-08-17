const express = require('express');
const { Resend } = require('resend');
const db = require('../config/database');
const authMiddleware = require('../middleware/auth');
const superAdminMiddleware = require('../middleware/superadmin');

const router = express.Router();

// Rate limiting - track last send time per user
const lastSendTimes = new Map();
const RATE_LIMIT_MS = 60000; // 1 minute between bulk sends

// Create Resend client
const isEmailConfigured = process.env.RESEND_API_KEY;
let resend = null;
if (isEmailConfigured) {
  resend = new Resend(process.env.RESEND_API_KEY);
}

// Send test email
router.post('/test', authMiddleware, superAdminMiddleware, async (req, res) => {
  try {
    const { subject, body, testEmail, includeLogo = false } = req.body;

    if (!subject || !body || !testEmail) {
      return res.status(400).json({ error: 'Subject, body, and test email address are required' });
    }

    if (!isEmailConfigured || !resend) {
      return res.status(503).json({ error: 'Email service is not configured' });
    }

    // Resolve logo URL if requested
    let logoImgUrl = null;
    let orgName = 'Event';
    if (includeLogo) {
      try {
        const settingsResult = await db.query('SELECT org_name, logo_url FROM settings WHERE shop_id = $1', [req.shopId]);
        if (settingsResult.rows.length > 0) {
          orgName = settingsResult.rows[0].org_name || orgName;
          const logoPath = settingsResult.rows[0].logo_url;
          if (logoPath) {
            const frontendUrl = (process.env.FRONTEND_URL || '').replace(/\/$/, '').replace(/^http:\/\//, 'https://');
            logoImgUrl = `${frontendUrl}${logoPath}`;
          }
        }
      } catch (e) {
        console.log('Note: Could not fetch logo for test email');
      }
    }

    // Preserve line breaks from the textarea
    const htmlBody = body.replace(/\n/g, '<br>\n');

    // Send test email
    await resend.emails.send({
      from: process.env.EMAIL_FROM,
      to: testEmail,
      subject: `[TEST] ${subject}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: #f44336; color: white; padding: 15px; text-align: center; font-weight: bold; margin-bottom: 20px;">
            🧪 TEST EMAIL - This is a preview
          </div>
          ${logoImgUrl ? `<div style="text-align: center; padding: 20px 0; background-color: white;"><img src="${logoImgUrl}" alt="${orgName}" style="max-width: 100%; max-height: 150px; object-fit: contain;" /></div>` : ''}
          ${htmlBody}
          <div style="margin-top: 30px; padding-top: 20px; border-top: 2px solid #eee; color: #666; font-size: 12px;">
            <p>This is a test email sent from the Bulk Email tool.</p>
            <p>Sent by: ${req.user.name || req.user.email}</p>
          </div>
        </div>
      `
    });

    console.log(`📧 Test email sent to ${testEmail} by ${req.user.email}`);
    if (logoImgUrl) console.log(`   Logo URL used: ${logoImgUrl}`);

    res.json({
      success: true,
      message: `Test email sent to ${testEmail}`,
      logoUrl: logoImgUrl || null
    });
  } catch (error) {
    console.error('Error sending test email:', error);
    res.status(500).json({ error: 'Failed to send test email' });
  }
});

// Send bulk email
router.post('/send', authMiddleware, superAdminMiddleware, async (req, res) => {
  try {
    const { subject, body, eventIds, emails, showTicketHolder = true, includeLogo = false } = req.body;

    if (!subject || !body) {
      return res.status(400).json({ error: 'Subject and body are required' });
    }

    const hasEmails = emails && Array.isArray(emails) && emails.length > 0;
    const hasEventIds = eventIds && Array.isArray(eventIds) && eventIds.length > 0;

    if (!hasEmails && !hasEventIds) {
      return res.status(400).json({ error: 'Either emails or eventIds must be provided' });
    }

    if (!isEmailConfigured || !resend) {
      return res.status(503).json({ error: 'Email service is not configured' });
    }

    // Check rate limit
    const userId = req.user.id;
    const lastSendTime = lastSendTimes.get(userId);
    const now = Date.now();

    if (lastSendTime && (now - lastSendTime) < RATE_LIMIT_MS) {
      const remainingSeconds = Math.ceil((RATE_LIMIT_MS - (now - lastSendTime)) / 1000);
      return res.status(429).json({ 
        error: `Please wait ${remainingSeconds} seconds before sending another bulk email` 
      });
    }
    
    // Get recipients - either from explicit email list or by event
    let recipients;
    if (emails && Array.isArray(emails) && emails.length > 0) {
      const placeholders = emails.map((_, i) => `$${i + 2}`).join(', ');
      const result = await db.query(
        `SELECT DISTINCT t.email, t.name, e.name as event_name
         FROM tickets t
         LEFT JOIN events e ON t.event_id = e.id AND e.shop_id = t.shop_id
         WHERE t.shop_id = $1
         AND t.email IN (${placeholders})
         AND (t.status IS NULL OR t.status = 'valid')
         ORDER BY t.email`,
        [req.shopId, ...emails]
      );
      recipients = result.rows;
    } else {
      const placeholders = eventIds.map((_, i) => `$${i + 2}`).join(', ');
      const result = await db.query(
        `SELECT DISTINCT t.email, t.name, e.name as event_name
         FROM tickets t
         LEFT JOIN events e ON t.event_id = e.id AND e.shop_id = t.shop_id
         WHERE t.shop_id = $1
         AND t.event_id IN (${placeholders})
         AND t.email IS NOT NULL
         AND t.email != ''
         AND (t.status IS NULL OR t.status = 'valid')
         ORDER BY t.email`,
        [req.shopId, ...eventIds]
      );
      recipients = result.rows;
    }

    if (recipients.length === 0) {
      return res.status(400).json({ error: 'No valid recipients found for selected events' });
    }
    
    // Check daily email limit after getting recipients count
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    
    const quotaResult = await db.query(
      'SELECT COUNT(*) as sent_today FROM email_send_log WHERE shop_id = $1 AND sent_at >= $2 AND success = true',
      [req.shopId, todayStart]
    );
    
    const sentToday = parseInt(quotaResult.rows[0].sent_today);
    const dailyLimit = 100;
    const remaining = Math.max(0, dailyLimit - sentToday);
    
    if (remaining === 0) {
      return res.status(429).json({ 
        error: 'Daily email limit of 100 emails reached. Please try again tomorrow.'
      });
    }
    
    if (recipients.length > remaining) {
      return res.status(429).json({ 
        error: `Cannot send ${recipients.length} emails. Only ${remaining} emails remaining in today's quota of 100.`
      });
    }

    // Update rate limit timestamp
    lastSendTimes.set(userId, now);

    // Fetch logo URL if requested
    let logoImgUrl = null;
    let orgName = 'Event';
    if (includeLogo) {
      try {
        const settingsResult = await db.query('SELECT org_name, logo_url FROM settings WHERE shop_id = $1', [req.shopId]);
        if (settingsResult.rows.length > 0) {
          orgName = settingsResult.rows[0].org_name || orgName;
          const logoPath = settingsResult.rows[0].logo_url;
          if (logoPath) {
            const frontendUrl = (process.env.FRONTEND_URL || '').replace(/\/$/, '').replace(/^http:\/\//, 'https://');
            logoImgUrl = `${frontendUrl}${logoPath}`;
          }
        }
      } catch (e) {
        console.log('Note: Could not fetch logo for bulk email');
      }
    }

    // Send emails with delay (6 seconds between each = 10 per minute)
    let sentCount = 0;
    let failedCount = 0;
    const errors = [];

    // Preserve line breaks from the textarea
    const htmlBody = body.replace(/\n/g, '<br>\n');

    for (const recipient of recipients) {
      try {
        const attachments = [];

        await resend.emails.send({
          from: process.env.EMAIL_FROM,
          to: recipient.email,
          subject: subject,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              ${logoImgUrl ? `<div style="text-align: center; padding: 20px 0; background-color: white;"><img src="${logoImgUrl}" alt="${orgName}" style="max-width: 100%; max-height: 150px; object-fit: contain;" /></div>` : ''}
              ${htmlBody}
              ${showTicketHolder ? `<div style="margin-top: 30px; padding-top: 20px; border-top: 2px solid #eee; color: #666; font-size: 12px;"><p>Ticket holder: ${recipient.name}</p></div>` : ''}
            </div>
          `
        });
        
        // Log successful send
        await db.query(
          'INSERT INTO email_send_log (shop_id, recipient_email, send_type, success) VALUES ($1, $2, $3, $4)',
          [req.shopId, recipient.email, 'bulk_email', true]
        );
        
        sentCount++;

        // 6-second delay between emails (10 per minute)
        if (sentCount < recipients.length) {
          await new Promise(resolve => setTimeout(resolve, 6000));
        }
      } catch (error) {
        console.error(`Failed to send to ${recipient.email}:`, error.message);
        failedCount++;
        errors.push({ email: recipient.email, error: error.message });
        
        // Log failed send
        try {
          await db.query(
            'INSERT INTO email_send_log (shop_id, recipient_email, send_type, success) VALUES ($1, $2, $3, $4)',
            [req.shopId, recipient.email, 'bulk_email', false]
          );
        } catch (logError) {
          console.error('Failed to log email failure:', logError);
        }
      }
    }

    console.log(`📧 Bulk email sent by ${req.user.email}: ${sentCount} sent, ${failedCount} failed`);

    res.json({
      success: true,
      message: 'Bulk email sending completed',
      sent: sentCount,
      failed: failedCount,
      total: recipients.length,
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (error) {
    console.error('Error sending bulk email:', error);
    res.status(500).json({ error: 'Failed to send bulk email' });
  }
});

// Get individual recipient list for selection UI
router.post('/preview/list', authMiddleware, superAdminMiddleware, async (req, res) => {
  try {
    const { eventIds } = req.body;

    if (!eventIds || !Array.isArray(eventIds) || eventIds.length === 0) {
      return res.status(400).json({ error: 'At least one event must be selected' });
    }

    const placeholders = eventIds.map((_, i) => `$${i + 2}`).join(', ');
    const result = await db.query(
      `SELECT DISTINCT t.email, t.name, e.name as event_name
       FROM tickets t
       LEFT JOIN events e ON t.event_id = e.id AND e.shop_id = t.shop_id
       WHERE t.shop_id = $1
       AND t.event_id IN (${placeholders})
       AND t.email IS NOT NULL
       AND t.email != ''
       AND (t.status IS NULL OR t.status = 'valid')
       ORDER BY t.name`,
      [req.shopId, ...eventIds]
    );

    res.json({ recipients: result.rows });
  } catch (error) {
    console.error('Error getting recipient list:', error);
    res.status(500).json({ error: 'Failed to get recipient list' });
  }
});

// Get recipient count preview
router.post('/preview', authMiddleware, superAdminMiddleware, async (req, res) => {
  try {
    const { eventIds } = req.body;

    if (!eventIds || !Array.isArray(eventIds) || eventIds.length === 0) {
      return res.status(400).json({ error: 'At least one event must be selected' });
    }

    const placeholders = eventIds.map((_, i) => `$${i + 2}`).join(', ');
    const query = `
      SELECT
        e.name as event_name,
        t.event_id,
        COUNT(DISTINCT t.email) as count
      FROM tickets t
      LEFT JOIN events e ON t.event_id = e.id AND e.shop_id = t.shop_id
      WHERE t.shop_id = $1
      AND t.event_id IN (${placeholders})
      AND t.email IS NOT NULL
      AND t.email != ''
      AND (t.status IS NULL OR t.status = 'valid')
      GROUP BY t.event_id, e.name
    `;

    const result = await db.query(query, [req.shopId, ...eventIds]);
    
    const total = result.rows.reduce((sum, row) => sum + parseInt(row.count), 0);

    res.json({
      breakdown: result.rows,
      total: total
    });
  } catch (error) {
    console.error('Error getting recipient preview:', error);
    res.status(500).json({ error: 'Failed to get recipient preview' });
  }
});

module.exports = router;
