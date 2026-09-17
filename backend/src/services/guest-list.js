/**
 * Emailing an event's guest list to internal recipients (organizers, door
 * staff) - not to be confused with services/reminder-jobs.js, which emails
 * the ticket holders themselves. This is a report ABOUT them, sent to
 * whoever the merchant types in at send time; nothing about recipients is
 * persisted beyond the usual email_send_log row.
 */

const db = require('../config/database');
const { sendViaResend, getSender } = require('./email');
const { remainingQuota } = require('./email-quota');
const { splitStamp, prettyDate, prettyTime } = require('./reminder-jobs');

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Loose on purpose - this only needs to catch a typo before it reaches
// Resend, not exhaustively validate RFC 5322.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MAX_RECIPIENTS = 20;

function normalizeRecipients(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const out = [];
  for (const value of list) {
    const email = String(value || '').trim();
    if (!email) continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(email);
  }
  return out;
}

function csvField(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildCsv(guests) {
  const lines = ['Name,Email,Tickets'];
  for (const g of guests) {
    lines.push([csvField(g.name || ''), csvField(g.email || ''), csvField(g.ticket_count)].join(','));
  }
  return lines.join('\r\n');
}

function renderGuestListEmail({ event, when, guests, totalTickets, orgName }) {
  const rows = guests.length
    ? guests.map((g) => `
        <tr>
          <td style="padding: 6px 10px; border-bottom: 1px solid #eee;">${escapeHtml(g.name || '(no name)')}</td>
          <td style="padding: 6px 10px; border-bottom: 1px solid #eee;">${escapeHtml(g.email || '(no email)')}</td>
          <td style="padding: 6px 10px; border-bottom: 1px solid #eee; text-align: right;">${g.ticket_count}</td>
        </tr>`).join('')
    : '<tr><td colspan="3" style="padding: 10px; color: #888;">No tickets have been issued yet.</td></tr>';

  return `
    <div style="font-family: Arial, sans-serif; max-width: 640px; margin: 0 auto; color: #333;">
      <h2 style="margin-bottom: 4px;">${escapeHtml(event.name)}</h2>
      <p style="color: #666; margin-top: 0;">${when ? escapeHtml(when) : ''}${event.location ? ` &middot; ${escapeHtml(event.location)}` : ''}</p>
      <p>${guests.length} guest${guests.length === 1 ? '' : 's'}, ${totalTickets} ticket${totalTickets === 1 ? '' : 's'} total.</p>
      <table style="width: 100%; border-collapse: collapse; margin-top: 12px;">
        <thead>
          <tr style="text-align: left; border-bottom: 2px solid #ddd;">
            <th style="padding: 6px 10px;">Name</th>
            <th style="padding: 6px 10px;">Email</th>
            <th style="padding: 6px 10px; text-align: right;">Tickets</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="color: #888; font-size: 12px; margin-top: 24px;">
        Guest list for ${escapeHtml(event.name)}, sent from ${escapeHtml(orgName)}'s ticketing system.
        Also attached as a CSV.
      </p>
    </div>
  `;
}

/**
 * One guest per distinct email address (someone holding three tickets is one
 * row with ticket_count 3), except a ticket with no email on file - those
 * can't be correlated to anyone else, so each gets its own row rather than
 * being collapsed together under a shared "no email" bucket. GROUP BY email
 * alone would do exactly that: Postgres treats all NULLs as one group.
 */
const GUESTS_SQL = `
  WITH t AS (
    SELECT id, name, email,
           COALESCE(lower(email), 'noemail-' || id::text) AS group_key
      FROM tickets
     WHERE event_id = $1 AND shop_id = $2 AND (status IS NULL OR status = 'valid')
  )
  SELECT MIN(name) AS name, MIN(email) AS email, COUNT(*)::int AS ticket_count
    FROM t
   GROUP BY group_key
   ORDER BY MIN(name) NULLS LAST, MIN(email) NULLS LAST
`;

/**
 * @returns {null} if the event does not exist for this shop
 * @throws {Error & {status:number}} on bad recipients, quota, or a Resend failure
 */
async function sendGuestList(shopId, eventId, rawRecipients) {
  const recipients = normalizeRecipients(rawRecipients);
  if (recipients.length === 0) {
    const error = new Error('At least one recipient email is required.');
    error.status = 400;
    throw error;
  }
  const bad = recipients.filter((r) => !EMAIL_RE.test(r));
  if (bad.length > 0) {
    const error = new Error(`Not a valid email address: ${bad.join(', ')}`);
    error.status = 400;
    throw error;
  }
  if (recipients.length > MAX_RECIPIENTS) {
    const error = new Error(`Send to at most ${MAX_RECIPIENTS} recipients at once.`);
    error.status = 400;
    throw error;
  }

  const eventResult = await db.query(
    'SELECT *, starts_at::text AS starts_at_text FROM events WHERE id = $1 AND shop_id = $2',
    [eventId, shopId]
  );
  const event = eventResult.rows[0];
  if (!event) return null;

  const settingsRow = (await db.query(
    'SELECT org_name FROM settings WHERE shop_id = $1', [shopId]
  )).rows[0] || {};
  const orgName = settingsRow.org_name || 'Ticket Manager';

  const { date: startsDate, time: startsTime } = splitStamp(event.starts_at_text);
  const when = [prettyDate(startsDate), prettyTime(startsTime)].filter(Boolean).join(' at ');

  const guests = (await db.query(GUESTS_SQL, [eventId, shopId])).rows;
  const totalTickets = guests.reduce((sum, g) => sum + g.ticket_count, 0);

  // One check, not one per recipient - this is a single Resend call to a
  // handful of addresses, not a fan-out like bulk email or reminders.
  if (await remainingQuota(shopId) <= 0) {
    const error = new Error('Daily email limit reached - try again tomorrow.');
    error.status = 429;
    throw error;
  }

  const csv = buildCsv(guests);
  const logRecipients = recipients.join(', ').slice(0, 255);

  try {
    await sendViaResend({
      from: getSender(),
      to: recipients,
      subject: `Guest list: ${event.name}`,
      html: renderGuestListEmail({ event, when, guests, totalTickets, orgName }),
      attachments: [{
        filename: 'guest-list.csv',
        content: Buffer.from(csv, 'utf-8').toString('base64'),
      }],
    });
    await db.query(
      'INSERT INTO email_send_log (shop_id, recipient_email, send_type, success) VALUES ($1, $2, $3, true)',
      [shopId, logRecipients, 'guest_list']
    );
  } catch (error) {
    await db.query(
      'INSERT INTO email_send_log (shop_id, recipient_email, send_type, success) VALUES ($1, $2, $3, false)',
      [shopId, logRecipients, 'guest_list']
    );
    throw error;
  }

  return { recipients, guestCount: guests.length, totalTickets };
}

module.exports = {
  sendGuestList,
  normalizeRecipients,
  buildCsv,
  renderGuestListEmail,
  MAX_RECIPIENTS,
};
