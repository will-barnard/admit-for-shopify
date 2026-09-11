/**
 * Day-of event reminders.
 *
 * One email per RSVP'd ticket holder, sent once per event, at the clock time
 * the merchant set on the event (events.reminder_time), on the calendar day
 * events.starts_at falls on - both evaluated in the shop's own
 * settings.timezone rather than this container's, so "day of, at 9am" means
 * 9am for the merchant even if this process runs in UTC.
 *
 * There is no per-recipient job table like bulk email has (see
 * services/email-jobs.js) - an event fires its reminder once, ever, and
 * reminder_sent_at is both the "already sent" flag and the claim: it is set
 * in the same UPDATE that selects the due event, so two ticks of the worker
 * (or two container replicas) cannot send the same event's reminder twice.
 * The trade-off, deliberately consistent with the rest of this app: a crash
 * between claim and send does not retry. Editing reminder_enabled or
 * reminder_time re-arms the event - see routes/events.js.
 */

const db = require('../config/database');
const { sendViaResend, getSender } = require('./email');
const { remainingQuota } = require('./email-quota');

const POLL_MS = Number(process.env.REMINDER_POLL_MS ?? 60000);
const SEND_INTERVAL_MS = Number(process.env.REMINDER_EMAIL_INTERVAL_MS ?? 1000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Timestamps come back naive (no zone) because that is how they are stored: a
 * venue means local wall-clock time. Split the string rather than going
 * through Date, which would reinterpret it in this process's zone and could
 * move the day. Mirrors frontend/src/views/Events.vue's splitStamp/prettyDate
 * /prettyTime - same bug class, same fix, kept in sync deliberately.
 */
function splitStamp(value) {
  if (!value) return { date: '', time: '' };
  const [datePart, timePart = ''] = String(value).replace('T', ' ').split(' ');
  return { date: datePart, time: timePart.slice(0, 5) };
}

function prettyDate(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
}

function prettyTime(timeStr) {
  if (!timeStr) return '';
  const [h, min] = timeStr.split(':').map(Number);
  return new Date(2000, 0, 1, h, min).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

/**
 * Claim at most one due event: reminder_enabled, has a reminder_time, has not
 * already been sent, is not archived, and the shop's own local wall-clock has
 * reached both the event's start date and the reminder time.
 *
 * `FOR UPDATE OF e SKIP LOCKED` locks (and skips-if-locked) only the events
 * row, not the joined settings row - two workers racing on different events
 * in the same shop must not block each other over a shared settings lock.
 *
 * starts_at is cast to text here (not read back as a JS Date) for the same
 * reason splitStamp() exists: a Date built from a naive timestamp gets
 * reinterpreted in this process's own zone, which is exactly the bug this
 * whole feature has to avoid.
 */
const CLAIM_SQL = `
  UPDATE events
     SET reminder_sent_at = NOW()
   WHERE id = (
     SELECT e.id
       FROM events e
       JOIN settings s ON s.shop_id = e.shop_id
      WHERE e.reminder_enabled = true
        AND e.reminder_time IS NOT NULL
        AND e.reminder_sent_at IS NULL
        AND (e.archived IS NULL OR e.archived = false)
        AND (NOW() AT TIME ZONE COALESCE(s.timezone, 'America/Chicago'))::date = e.starts_at::date
        AND (NOW() AT TIME ZONE COALESCE(s.timezone, 'America/Chicago'))::time >= e.reminder_time
      ORDER BY e.id
      LIMIT 1
      FOR UPDATE OF e SKIP LOCKED
   )
   RETURNING *, starts_at::text AS starts_at_text, ends_at::text AS ends_at_text
`;

async function claimDueEvent() {
  const result = await db.query(CLAIM_SQL);
  return result.rows[0] || null;
}

function renderReminderEmail({ event, orgName, when }, recipient) {
  const ticketNote = recipient.ticket_count > 1
    ? `<p>You have ${recipient.ticket_count} tickets for this event.</p>`
    : '';
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
      <div style="background-color: #4CAF50; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0;">
        <h1 style="margin: 0; font-size: 22px;">${escapeHtml(event.name)} is today!</h1>
      </div>
      <div style="padding: 24px; background-color: #f9f9f9; border-radius: 0 0 8px 8px;">
        <p>Hi ${escapeHtml(recipient.name || 'there')},</p>
        <p>Just a reminder that <strong>${escapeHtml(event.name)}</strong> is happening today${when ? `, ${escapeHtml(when)}` : ''}.</p>
        ${event.location ? `<p><strong>Location:</strong> ${escapeHtml(event.location)}</p>` : ''}
        ${ticketNote}
        <p>We look forward to seeing you!</p>
        <p style="color: #888; font-size: 12px; margin-top: 24px;">This is an automated reminder from ${escapeHtml(orgName)}.</p>
      </div>
    </div>
  `;
}

/**
 * Send one event's reminder to every valid ticket holder with an email on
 * file, one row per distinct address (someone holding two tickets for the
 * same event gets one reminder, not two).
 *
 * The daily quota is checked per recipient, same as bulk email - another
 * send may be consuming it concurrently. If it runs out mid-list, the
 * remaining recipients are simply not reminded: the event is already claimed
 * (see CLAIM_SQL) so this does not retry later. Logged loudly so an operator
 * watching the logs can see it happened and follow up by hand.
 */
async function sendEventReminder(event) {
  const settingsRow = (await db.query(
    'SELECT org_name FROM settings WHERE shop_id = $1', [event.shop_id]
  )).rows[0] || {};
  const orgName = settingsRow.org_name || 'Ticket Manager';

  const { date: startsDate, time: startsTime } = splitStamp(event.starts_at_text);
  const when = [prettyDate(startsDate), prettyTime(startsTime)].filter(Boolean).join(' at ');

  const recipients = (await db.query(
    `SELECT MIN(name) AS name, email, COUNT(*)::int AS ticket_count
       FROM tickets
      WHERE event_id = $1 AND shop_id = $2 AND status = 'valid' AND email IS NOT NULL
      GROUP BY email
      ORDER BY email`,
    [event.id, event.shop_id]
  )).rows;

  let sent = 0;
  let failed = 0;

  for (const recipient of recipients) {
    if (await remainingQuota(event.shop_id) <= 0) {
      const remaining = recipients.length - sent - failed;
      console.error(
        `Reminder for event ${event.id} ("${event.name}") stopped early: daily email limit reached. `
        + `${remaining} recipient(s) were not reminded and this will not retry.`
      );
      break;
    }

    try {
      await sendViaResend({
        from: getSender(),
        to: recipient.email,
        subject: `Reminder: ${event.name} is today`,
        html: renderReminderEmail({ event, orgName, when }, recipient),
      });
      await db.query(
        'INSERT INTO email_send_log (shop_id, recipient_email, send_type, success) VALUES ($1, $2, $3, true)',
        [event.shop_id, recipient.email, 'event_reminder']
      );
      sent += 1;
    } catch (error) {
      console.error(`Reminder email to ${recipient.email} for event ${event.id} failed:`, error.message);
      await db.query(
        'INSERT INTO email_send_log (shop_id, recipient_email, send_type, success) VALUES ($1, $2, $3, false)',
        [event.shop_id, recipient.email, 'event_reminder']
      );
      failed += 1;
    }

    if (SEND_INTERVAL_MS > 0) await sleep(SEND_INTERVAL_MS);
  }

  console.log(
    `Event reminder for "${event.name}" (id ${event.id}): ${sent} sent, ${failed} failed, `
    + `${recipients.length} recipient(s) total.`
  );
  return { sent, failed, total: recipients.length };
}

/** Claim and send every due event's reminder, then return. Used by the worker and by tests. */
async function drainDue() {
  let ran = 0;
  for (;;) {
    const event = await claimDueEvent();
    if (!event) return ran;
    try {
      await sendEventReminder(event);
    } catch (error) {
      // Already claimed (reminder_sent_at is set) - this does not retry, so
      // make sure it is at least loud.
      console.error(`Reminder job for event ${event.id} ("${event.name}") failed:`, error);
    }
    ran += 1;
  }
}

let workerTimer = null;

function startWorker() {
  if (workerTimer) return;

  const tick = async () => {
    try {
      await drainDue();
    } catch (error) {
      console.error('Event reminder worker error:', error);
    }
    workerTimer = setTimeout(tick, POLL_MS);
    if (workerTimer.unref) workerTimer.unref();
  };

  tick();
}

function stopWorker() {
  if (workerTimer) clearTimeout(workerTimer);
  workerTimer = null;
}

module.exports = {
  claimDueEvent,
  sendEventReminder,
  renderReminderEmail,
  drainDue,
  startWorker,
  stopWorker,
  splitStamp,
  prettyDate,
  prettyTime,
};
