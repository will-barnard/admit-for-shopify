const express = require('express');
const db = require('../config/database');
const { sendViaResend, getSender } = require('../services/email');
const authMiddleware = require('../middleware/auth');
const superAdminMiddleware = require('../middleware/superadmin');
const emailJobs = require('../services/email-jobs');

const router = express.Router();

const isEmailConfigured = Boolean(process.env.RESEND_API_KEY);

// Send test email
router.post('/test', authMiddleware, superAdminMiddleware, async (req, res) => {
  try {
    const { subject, body, testEmail, includeLogo = false } = req.body;

    if (!subject || !body || !testEmail) {
      return res.status(400).json({ error: 'Subject, body, and test email address are required' });
    }

    if (!isEmailConfigured) {
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

    // Send test email. sendViaResend throws if Resend rejects it - the SDK
    // resolves to { data, error } rather than throwing, so this used to report
    // success for messages that were never delivered.
    const sent = await sendViaResend({
      from: getSender(),
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
            <p>Sent by: ${req.user.username}</p>
          </div>
        </div>
      `
    });

    console.log(`Test email accepted by Resend (id ${sent.id}) for ${testEmail}, sent by ${req.user.username}`);
    if (logoImgUrl) console.log(`   Logo URL used: ${logoImgUrl}`);

    res.json({
      success: true,
      message: `Test email sent to ${testEmail}`,
      messageId: sent.id,
      logoUrl: logoImgUrl || null
    });
  } catch (error) {
    console.error('Error sending test email:', error);
    // Surface the actual reason. A generic message here is what made this
    // impossible to diagnose from the UI.
    res.status(502).json({
      error: 'Failed to send test email',
      reason: error.message,
      resendError: error.resendError || undefined,
      hint: error.resendError
        ? 'Check that the EMAIL_FROM domain is verified at https://resend.com/domains and that RESEND_API_KEY has send permission.'
        : undefined,
    });
  }
});

// Start a bulk email job.
//
// This used to send inline: up to 100 recipients six seconds apart is about ten
// minutes, against a sixty-second proxy timeout. The caller got a 504 while
// sending continued unseen, and because the only guard was a sixty-second
// per-user cooldown, retrying after the timeout sent the entire batch a second
// time. It now returns as soon as the job is recorded; services/email-jobs.js
// drains it.
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

    if (!isEmailConfigured) {
      return res.status(503).json({ error: 'Email service is not configured' });
    }

    // One job at a time per shop. The old per-user cooldown was the only thing
    // standing between a timed-out request and a duplicate send; an explicit
    // check against live job state says what is actually true.
    const active = await db.query(
      `SELECT id FROM email_jobs WHERE shop_id = $1 AND status IN ('queued', 'running') LIMIT 1`,
      [req.shopId]
    );
    if (active.rows.length > 0) {
      return res.status(409).json({
        error: 'A bulk email is already in progress. Wait for it to finish, or cancel it.',
        jobId: active.rows[0].id,
      });
    }

    // Get recipients - either from explicit email list or by event
    let recipients;
    if (hasEmails) {
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

    const remaining = await emailJobs.remainingQuota(req.shopId);
    if (remaining === 0) {
      return res.status(429).json({
        error: `Daily email limit of ${emailJobs.DAILY_LIMIT} emails reached. Please try again tomorrow.`,
      });
    }
    if (recipients.length > remaining) {
      return res.status(429).json({
        error: `Cannot send ${recipients.length} emails. Only ${remaining} emails remaining in today's quota of ${emailJobs.DAILY_LIMIT}.`,
      });
    }

    // Resolve the logo once, now, rather than per message.
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

    const job = await emailJobs.createJob({
      shopId: req.shopId,
      userId: req.user.id,
      subject,
      body,
      options: { showTicketHolder, logoImgUrl, orgName },
      recipients,
    });

    console.log(`Bulk email job ${job.id} queued by ${req.user.username}: ${job.total} recipient(s)`);

    res.status(202).json({
      success: true,
      message: 'Bulk email queued',
      jobId: job.id,
      total: job.total,
      status: job.status,
    });
  } catch (error) {
    console.error('Error queueing bulk email:', error);
    res.status(500).json({ error: 'Failed to queue bulk email' });
  }
});

// Progress for the job list and the progress bar.
router.get('/jobs', authMiddleware, superAdminMiddleware, async (req, res) => {
  try {
    res.json({ jobs: await emailJobs.listJobs(req.shopId) });
  } catch (error) {
    console.error('Error listing email jobs:', error);
    res.status(500).json({ error: 'Failed to list email jobs' });
  }
});

router.get('/jobs/:id', authMiddleware, superAdminMiddleware, async (req, res) => {
  try {
    const job = await emailJobs.getJob(req.params.id, req.shopId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json({
      ...job,
      // 'sending' means the process stopped between Resend accepting the
      // message and the row being updated. Those are never retried, so report
      // them rather than pretending they either did or did not arrive.
      failures: await emailJobs.jobFailures(req.params.id, req.shopId),
    });
  } catch (error) {
    console.error('Error fetching email job:', error);
    res.status(500).json({ error: 'Failed to fetch email job' });
  }
});

router.post('/jobs/:id/cancel', authMiddleware, superAdminMiddleware, async (req, res) => {
  try {
    const job = await emailJobs.cancelJob(req.params.id, req.shopId);
    if (!job) return res.status(404).json({ error: 'No job to cancel' });
    // Messages already handed to Resend are gone; this only stops the rest.
    res.json({ message: 'Cancelled', job });
  } catch (error) {
    console.error('Error cancelling email job:', error);
    res.status(500).json({ error: 'Failed to cancel email job' });
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
