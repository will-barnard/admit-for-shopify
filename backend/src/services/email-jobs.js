/**
 * Bulk email as a persisted, resumable job.
 *
 * The problem this replaces: POST /api/bulk-email/send did the whole send
 * inside the request. Up to 100 recipients, six seconds apart, is around ten
 * minutes - against a sixty-second proxy timeout. So the operator got a 504
 * while sending carried on invisibly in the background; a second attempt a
 * minute later would send the whole batch again to everyone; and a container
 * restart mid-run lost the rest with no record of who had already been
 * reached.
 *
 * Now: the recipient list is materialised into email_job_recipients when the
 * job is created, the request returns immediately, and a worker drains it.
 * Every state transition is a row update, so progress survives a restart.
 *
 * Not double-sending is the priority throughout. A recipient moves
 * pending -> sending -> sent, and only a `pending` row is ever picked up. If
 * the process dies after Resend accepted a message but before the row was
 * updated, that row stays `sending` forever and is reported as unknown rather
 * than retried - one person not getting a duplicate matters more than closing
 * the books neatly.
 */

const db = require('../config/database');
const { sendViaResend, getSender } = require('./email');
const { DAILY_LIMIT, remainingQuota } = require('./email-quota');

const SEND_INTERVAL_MS = Number(process.env.BULK_EMAIL_INTERVAL_MS ?? 6000);
const IDLE_POLL_MS = Number(process.env.BULK_EMAIL_POLL_MS ?? 5000);

const lockKey = (jobId) => `email-job:${jobId}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The message body. `body` is authored by a superadmin so its line breaks are
 * honoured, but the recipient name comes from a Shopify order payload and is
 * escaped.
 */
function renderEmail({ body, showTicketHolder, logoImgUrl, orgName }, recipient) {
  const htmlBody = String(body).replace(/\n/g, '<br>\n');
  const logo = logoImgUrl
    ? `<div style="text-align: center; padding: 20px 0; background-color: white;"><img src="${escapeHtml(logoImgUrl)}" alt="${escapeHtml(orgName || 'Event')}" style="max-width: 100%; max-height: 150px; object-fit: contain;" /></div>`
    : '';
  const footer = showTicketHolder
    ? `<div style="margin-top: 30px; padding-top: 20px; border-top: 2px solid #eee; color: #666; font-size: 12px;"><p>Ticket holder: ${escapeHtml(recipient.name)}</p></div>`
    : '';
  return `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              ${logo}
              ${htmlBody}
              ${footer}
            </div>
          `;
}

/**
 * Create a job and its recipient rows in one transaction. Duplicate addresses
 * collapse (unique on job_id + lower(email)), so `total` is the count actually
 * inserted, not the length of what was passed in.
 */
async function createJob({ shopId, userId, subject, body, options = {}, recipients }) {
  return db.withTransaction(async (client) => {
    const jobResult = await client.query(
      `INSERT INTO email_jobs (shop_id, created_by_user_id, subject, body, options, status, total)
       VALUES ($1, $2, $3, $4, $5, 'queued', 0) RETURNING *`,
      [shopId, userId ?? null, subject, body, JSON.stringify(options)]
    );
    const job = jobResult.rows[0];

    let inserted = 0;
    for (const recipient of recipients) {
      const result = await client.query(
        `INSERT INTO email_job_recipients (job_id, shop_id, email, name)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (job_id, lower(email)) DO NOTHING
         RETURNING id`,
        [job.id, shopId, recipient.email, recipient.name || null]
      );
      inserted += result.rowCount;
    }

    const updated = await client.query(
      'UPDATE email_jobs SET total = $1 WHERE id = $2 RETURNING *',
      [inserted, job.id]
    );
    return updated.rows[0];
  });
}

async function getJob(jobId, shopId) {
  const result = await db.query(
    `SELECT j.*,
            COUNT(r.id) FILTER (WHERE r.status = 'pending')  AS pending,
            COUNT(r.id) FILTER (WHERE r.status = 'sending')  AS unknown,
            COUNT(r.id) FILTER (WHERE r.status = 'skipped')  AS skipped
       FROM email_jobs j
       LEFT JOIN email_job_recipients r ON r.job_id = j.id AND r.shop_id = j.shop_id
      WHERE j.id = $1 AND j.shop_id = $2
      GROUP BY j.id`,
    [jobId, shopId]
  );
  return result.rows[0] || null;
}

async function listJobs(shopId, limit = 20) {
  const result = await db.query(
    `SELECT id, subject, status, total, sent, failed, error_message,
            created_at, started_at, finished_at
       FROM email_jobs WHERE shop_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [shopId, limit]
  );
  return result.rows;
}

async function jobFailures(jobId, shopId) {
  const result = await db.query(
    `SELECT email, status, error FROM email_job_recipients
      WHERE job_id = $1 AND shop_id = $2 AND status IN ('failed', 'sending')
      ORDER BY id`,
    [jobId, shopId]
  );
  return result.rows;
}

async function cancelJob(jobId, shopId) {
  const result = await db.query(
    `UPDATE email_jobs SET status = 'cancelled', finished_at = NOW()
      WHERE id = $1 AND shop_id = $2 AND status IN ('queued', 'running')
      RETURNING *`,
    [jobId, shopId]
  );
  if (result.rows.length === 0) return null;
  await db.query(
    `UPDATE email_job_recipients SET status = 'skipped', error = 'Cancelled'
      WHERE job_id = $1 AND shop_id = $2 AND status = 'pending'`,
    [jobId, shopId]
  );
  return result.rows[0];
}

/**
 * Claim one queued job. SKIP LOCKED means two workers cannot take the same row
 * even if they look at the same instant.
 */
async function claimJob() {
  const result = await db.query(
    `UPDATE email_jobs SET status = 'running', started_at = COALESCE(started_at, NOW())
      WHERE id = (
        SELECT id FROM email_jobs WHERE status = 'queued'
        ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
      ) RETURNING *`
  );
  return result.rows[0] || null;
}

/**
 * Requeue jobs left mid-flight by a crash.
 *
 * A 'running' row does not by itself mean abandoned - another worker may be
 * draining it right now. The advisory lock is what distinguishes the two: a
 * live worker holds it for the whole drain, so being able to take it means
 * nobody is there.
 */
async function recoverAbandonedJobs() {
  const running = await db.query("SELECT id FROM email_jobs WHERE status = 'running'");
  let recovered = 0;

  for (const row of running.rows) {
    const client = await db.pool.connect();
    try {
      const got = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [lockKey(row.id)]);
      if (got.rows[0].ok) {
        await client.query("UPDATE email_jobs SET status = 'queued' WHERE id = $1 AND status = 'running'", [row.id]);
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey(row.id)]);
        recovered += 1;
      }
    } finally {
      client.release();
    }
  }

  if (recovered > 0) {
    console.log(`Requeued ${recovered} interrupted bulk email job(s)`);
  }
  return recovered;
}

async function finishJob(jobId, status, errorMessage = null) {
  await db.query(
    `UPDATE email_jobs SET status = $1, finished_at = NOW(), error_message = $2 WHERE id = $3`,
    [status, errorMessage, jobId]
  );
}

/**
 * Send one job to completion. Holds a session-level advisory lock for the whole
 * drain so recoverAbandonedJobs() can tell "in progress" from "abandoned".
 */
async function runJob(job, { onProgress } = {}) {
  const lockClient = await db.pool.connect();
  try {
    const got = await lockClient.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [lockKey(job.id)]);
    if (!got.rows[0].ok) return { skipped: 'locked' };

    const options = typeof job.options === 'string' ? JSON.parse(job.options) : (job.options || {});
    let stoppedBecause = null;

    for (;;) {
      const current = await db.query('SELECT status FROM email_jobs WHERE id = $1', [job.id]);
      if (!current.rows[0] || current.rows[0].status === 'cancelled') {
        stoppedBecause = 'cancelled';
        break;
      }

      // The daily quota is checked per message, not once up front: another
      // job, a ticket email or a second shop may have consumed it meanwhile.
      if (await remainingQuota(job.shop_id) <= 0) {
        stoppedBecause = 'quota';
        break;
      }

      const claimed = await db.query(
        `UPDATE email_job_recipients SET status = 'sending'
          WHERE id = (
            SELECT id FROM email_job_recipients
             WHERE job_id = $1 AND status = 'pending'
             ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED
          ) RETURNING *`,
        [job.id]
      );
      const recipient = claimed.rows[0];
      if (!recipient) break; // nothing left

      try {
        await sendViaResend({
          from: getSender(),
          to: recipient.email,
          subject: job.subject,
          html: renderEmail({ body: job.body, ...options }, recipient),
        });
        await db.query(
          "UPDATE email_job_recipients SET status = 'sent', sent_at = NOW() WHERE id = $1",
          [recipient.id]
        );
        await db.query('UPDATE email_jobs SET sent = sent + 1 WHERE id = $1', [job.id]);
        await db.query(
          'INSERT INTO email_send_log (shop_id, recipient_email, send_type, success) VALUES ($1, $2, $3, true)',
          [job.shop_id, recipient.email, 'bulk_email']
        );
      } catch (error) {
        console.error(`Bulk email to ${recipient.email} failed:`, error.message);
        await db.query(
          "UPDATE email_job_recipients SET status = 'failed', error = $2 WHERE id = $1",
          [recipient.id, error.message || 'Unknown error']
        );
        await db.query('UPDATE email_jobs SET failed = failed + 1 WHERE id = $1', [job.id]);
        await db.query(
          'INSERT INTO email_send_log (shop_id, recipient_email, send_type, success) VALUES ($1, $2, $3, false)',
          [job.shop_id, recipient.email, 'bulk_email']
        );
      }

      if (onProgress) await onProgress(job.id);
      if (SEND_INTERVAL_MS > 0) await sleep(SEND_INTERVAL_MS);
    }

    if (stoppedBecause === 'cancelled') {
      // cancelJob already set the status and skipped the pending rows.
    } else if (stoppedBecause === 'quota') {
      await db.query(
        `UPDATE email_job_recipients SET status = 'skipped', error = 'Daily email limit reached'
          WHERE job_id = $1 AND status = 'pending'`,
        [job.id]
      );
      await finishJob(job.id, 'completed', 'Stopped early: daily email limit reached');
    } else {
      await finishJob(job.id, 'completed');
    }

    return { done: true, stoppedBecause };
  } finally {
    try {
      await lockClient.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey(job.id)]);
    } catch { /* connection may already be gone */ }
    lockClient.release();
  }
}

/** Drain every claimable job, then return. Used by the worker and by tests. */
async function drain(options) {
  let ran = 0;
  for (;;) {
    const job = await claimJob();
    if (!job) return ran;
    try {
      await runJob(job, options);
    } catch (error) {
      console.error(`Bulk email job ${job.id} failed:`, error);
      await finishJob(job.id, 'failed', error.message || 'Unknown error');
    }
    ran += 1;
  }
}

let workerTimer = null;

function startWorker() {
  if (workerTimer) return;

  const tick = async () => {
    try {
      await drain();
    } catch (error) {
      console.error('Bulk email worker error:', error);
    }
    workerTimer = setTimeout(tick, IDLE_POLL_MS);
    if (workerTimer.unref) workerTimer.unref();
  };

  recoverAbandonedJobs()
    .catch((error) => console.error('Could not recover interrupted email jobs:', error))
    .finally(tick);
}

function stopWorker() {
  if (workerTimer) clearTimeout(workerTimer);
  workerTimer = null;
}

module.exports = {
  createJob,
  getJob,
  listJobs,
  jobFailures,
  cancelJob,
  claimJob,
  runJob,
  drain,
  recoverAbandonedJobs,
  remainingQuota,
  renderEmail,
  escapeHtml,
  startWorker,
  stopWorker,
  DAILY_LIMIT,
};
