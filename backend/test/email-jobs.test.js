/*
 * Bulk email as a job, rather than a ten-minute HTTP request.
 *
 * What this is really testing is that the two things which used to go wrong
 * cannot: the caller no longer waits (so no 504 while sending continues
 * invisibly), and nobody is ever sent the same message twice - not by retrying
 * after a timeout, not by a restart mid-run, not by two workers racing.
 *
 * Resend is stubbed, and BULK_EMAIL_INTERVAL_MS is zeroed, so this runs in
 * about a second rather than the ten minutes a real batch would take.
 *
 * Requires a real, EMPTY Postgres database - it truncates tables.
 *
 *   DATABASE_URL=... node src/migrations/run.js
 *   DATABASE_URL=... npm run test:email-jobs
 */

const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'email-jobs-test-secret';
process.env.PORT = process.env.PORT || '3992';
process.env.DEFAULT_SHOP_DOMAIN = 'jobs-shop.test';
process.env.RESEND_API_KEY = 'test-key';
process.env.EMAIL_FROM = 'Tickets <no-reply@example.test>';
process.env.BULK_EMAIL_INTERVAL_MS = '0';   // no pacing delay in tests
process.env.BULK_EMAIL_POLL_MS = '50';

const db = require('../src/config/database');
const shopContextModule = require('../src/middleware/shop-context');

// --- stub Resend before anything imports the email service ---------------
const email = require('../src/services/email');
const sent = [];
let sendBehaviour = async () => {};
email.sendViaResend = async (message) => {
  sent.push(message);
  return sendBehaviour(message);
};

const emailJobs = require('../src/services/email-jobs');

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${detail}`); }
}

const BASE = `http://127.0.0.1:${process.env.PORT}`;
const q = (t, p) => db.query(t, p).then((r) => r.rows);
const token = (role = 'superadmin', id = 1) =>
  jwt.sign({ id, username: 'tester', role }, process.env.JWT_SECRET, { expiresIn: '1h' });

async function api(path, { method = 'GET', body, role = 'superadmin', shopDomain = 'jobs-shop.test' } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token(role)}`,
      'x-test-shop-domain': shopDomain,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body: json, raw: text };
}

(async () => {
  await db.query(
    'TRUNCATE email_job_recipients, email_jobs, ticket_scans, email_send_log, webhook_logs, tickets, event_ticket_types, events, settings, shops, users RESTART IDENTITY CASCADE'
  );
  await db.query("INSERT INTO users (id, username, password, role) VALUES (1,'tester','x','superadmin')");
  await db.query("SELECT setval('users_id_seq', (SELECT MAX(id) FROM users))");

  const A = (await q("INSERT INTO shops (domain) VALUES ('jobs-shop.test') RETURNING id"))[0].id;
  const B = (await q("INSERT INTO shops (domain) VALUES ('other-shop.test') RETURNING id"))[0].id;
  await db.query("INSERT INTO settings (shop_id, org_name) VALUES ($1,'A'), ($2,'B')", [A, B]);
  const eventA = (await q(
    "INSERT INTO events (shop_id, name, starts_at) VALUES ($1,'Jobs Fest','2026-12-01') RETURNING id", [A]
  ))[0].id;

  const holders = ['a@x.test', 'b@x.test', 'c@x.test', 'd@x.test'];
  for (const [i, e] of holders.entries()) {
    await db.query(
      `INSERT INTO tickets (shop_id, event_id, name, email, uuid, shopify_order_id)
       VALUES ($1,$2,$3,$4,$5,'ord-1')`,
      [A, eventA, `Holder ${i}`, e, `uuid-${i}`]
    );
  }
  shopContextModule.clearShopCache();

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api', (req, res, next) => {
    if (req.headers['x-test-shop-domain']) req.shopDomain = req.headers['x-test-shop-domain'];
    next();
  });
  app.use('/api', require('../src/middleware/shop-context'));
  app.use('/api/bulk-email', require('../src/routes/bulk-email'));
  app.use('/api/tickets', require('../src/routes/tickets'));
  const server = await new Promise((r) => { const s = app.listen(process.env.PORT, () => r(s)); });

  // -------------------------------------------------------------------------
  console.log('\n1. the request returns immediately');

  const startedAt = Date.now();
  let r = await api('/api/bulk-email/send', {
    method: 'POST',
    body: { subject: 'Doors at 7', body: 'See you there', eventIds: [eventA] },
  });
  const elapsed = Date.now() - startedAt;

  check('queueing answers 202, not 200-after-ten-minutes', r.status === 202, `${r.status} ${r.raw}`);
  check('  ...and returns before any email is sent', sent.length === 0, `${sent.length} already sent`);
  check('  ...quickly enough that no proxy would time out', elapsed < 2000, `${elapsed}ms`);
  const jobId = r.body.jobId;
  check('  ...with the recipient count', r.body.total === 4, JSON.stringify(r.body));

  r = await api(`/api/bulk-email/jobs/${jobId}`);
  check('the job is visible while queued', r.body.status === 'queued', JSON.stringify(r.body?.status));
  check('  ...with nothing sent yet', r.body.sent === 0 && Number(r.body.pending) === 4,
    JSON.stringify({ sent: r.body.sent, pending: r.body.pending }));

  // -------------------------------------------------------------------------
  console.log('\n2. a second send is refused while one is in flight');

  r = await api('/api/bulk-email/send', {
    method: 'POST',
    body: { subject: 'Oops again', body: 'duplicate', eventIds: [eventA] },
  });
  check('a concurrent send is refused with 409', r.status === 409, `${r.status} ${r.raw}`);
  check('  ...naming the job already running', r.body.jobId === jobId, JSON.stringify(r.body));

  // -------------------------------------------------------------------------
  console.log('\n3. draining the job');

  await emailJobs.drain();

  check('every recipient got exactly one message', sent.length === 4, String(sent.length));
  const addresses = sent.map((m) => m.to).sort();
  check('  ...and they are the right four', JSON.stringify(addresses) === JSON.stringify(holders),
    JSON.stringify(addresses));
  check('the subject carried through', sent.every((m) => m.subject === 'Doors at 7'));
  check('the body carried through', sent.every((m) => m.html.includes('See you there')));

  r = await api(`/api/bulk-email/jobs/${jobId}`);
  check('the job is completed', r.body.status === 'completed', r.body.status);
  check('  ...with a full count', r.body.sent === 4 && r.body.failed === 0,
    JSON.stringify({ sent: r.body.sent, failed: r.body.failed }));

  const logged = await q("SELECT COUNT(*)::int c FROM email_send_log WHERE shop_id = $1 AND success = true", [A]);
  check('each send is logged against the daily quota', logged[0].c === 4, JSON.stringify(logged));

  // -------------------------------------------------------------------------
  console.log('\n4. re-running a drained job sends nothing');

  const before = sent.length;
  await db.query("UPDATE email_jobs SET status = 'queued' WHERE id = $1", [jobId]);
  await emailJobs.drain();
  check('a requeued job with no pending recipients sends nothing',
    sent.length === before, `${sent.length - before} extra`);

  // -------------------------------------------------------------------------
  console.log('\n5. an interrupted send is never retried');

  sent.length = 0;
  r = await api('/api/bulk-email/send', {
    method: 'POST',
    body: { subject: 'Second batch', body: 'hello', eventIds: [eventA] },
  });
  const job2 = r.body.jobId;

  // Simulate a crash between "Resend accepted it" and "row updated": leave one
  // recipient stuck in 'sending', which is exactly what the process would.
  await db.query(
    `UPDATE email_job_recipients SET status = 'sending'
      WHERE id = (SELECT id FROM email_job_recipients WHERE job_id = $1 ORDER BY id LIMIT 1)`,
    [job2]
  );
  await emailJobs.drain();

  check('the interrupted recipient is NOT sent again', sent.length === 3, String(sent.length));
  const stuck = await q("SELECT email, status FROM email_job_recipients WHERE job_id = $1 AND status = 'sending'", [job2]);
  check('  ...and stays visible as unknown rather than silently dropped', stuck.length === 1,
    JSON.stringify(stuck));

  r = await api(`/api/bulk-email/jobs/${job2}`);
  check('  ...and is reported to the operator', Number(r.body.unknown) === 1, JSON.stringify(r.body.unknown));
  check('  ...in the failures list', (r.body.failures || []).some((f) => f.status === 'sending'),
    JSON.stringify(r.body.failures));

  // -------------------------------------------------------------------------
  console.log('\n6. crash recovery requeues, and does not double-send');

  sent.length = 0;
  r = await api('/api/bulk-email/send', {
    method: 'POST',
    body: { subject: 'Third batch', body: 'hello', eventIds: [eventA] },
  });
  const job3 = r.body.jobId;

  // Send two of the four, then pretend the process died: status stays 'running'
  // with nobody holding the advisory lock.
  const claimed = await emailJobs.claimJob();
  check('the worker claims the queued job', claimed?.id === job3, JSON.stringify(claimed?.id));
  await db.query(
    `UPDATE email_job_recipients SET status = 'sent', sent_at = NOW()
      WHERE id IN (SELECT id FROM email_job_recipients WHERE job_id = $1 ORDER BY id LIMIT 2)`,
    [job3]
  );
  await db.query('UPDATE email_jobs SET sent = 2 WHERE id = $1', [job3]);

  const recovered = await emailJobs.recoverAbandonedJobs();
  check('an abandoned running job is requeued', recovered === 1, String(recovered));

  await emailJobs.drain();
  check('only the UNSENT recipients are sent on resume', sent.length === 2, String(sent.length));
  const finalCounts = await q(
    "SELECT status, COUNT(*)::int c FROM email_job_recipients WHERE job_id = $1 GROUP BY 1 ORDER BY 1", [job3]
  );
  check('  ...leaving all four sent exactly once',
    JSON.stringify(finalCounts) === '[{"status":"sent","c":4}]', JSON.stringify(finalCounts));

  // -------------------------------------------------------------------------
  console.log('\n7. cancelling');

  sent.length = 0;
  r = await api('/api/bulk-email/send', {
    method: 'POST',
    body: { subject: 'Fourth batch', body: 'hello', eventIds: [eventA] },
  });
  const job4 = r.body.jobId;

  r = await api(`/api/bulk-email/jobs/${job4}/cancel`, { method: 'POST' });
  check('a queued job can be cancelled', r.status === 200, `${r.status} ${r.raw}`);

  await emailJobs.drain();
  check('a cancelled job sends nothing', sent.length === 0, String(sent.length));
  const cancelled = await q(
    "SELECT status, COUNT(*)::int c FROM email_job_recipients WHERE job_id = $1 GROUP BY 1", [job4]
  );
  check('  ...and its recipients are marked skipped, not pending',
    JSON.stringify(cancelled) === '[{"status":"skipped","c":4}]', JSON.stringify(cancelled));

  r = await api('/api/bulk-email/send', {
    method: 'POST', body: { subject: 'After cancel', body: 'hello', eventIds: [eventA] },
  });
  check('cancelling frees the shop to send again', r.status === 202, `${r.status} ${r.raw}`);
  await api(`/api/bulk-email/jobs/${r.body.jobId}/cancel`, { method: 'POST' });

  // -------------------------------------------------------------------------
  console.log('\n8. individual failures do not stop the batch');

  sent.length = 0;
  sendBehaviour = async (message) => {
    if (message.to === 'b@x.test') throw new Error('Resend said no');
  };
  r = await api('/api/bulk-email/send', {
    method: 'POST', body: { subject: 'Fifth batch', body: 'hello', eventIds: [eventA] },
  });
  const job5 = r.body.jobId;
  await emailJobs.drain();
  sendBehaviour = async () => {};

  check('one failure does not abort the remaining recipients', sent.length === 4, String(sent.length));
  r = await api(`/api/bulk-email/jobs/${job5}`);
  check('the failure is counted', r.body.sent === 3 && r.body.failed === 1,
    JSON.stringify({ sent: r.body.sent, failed: r.body.failed }));
  check('  ...and the address is named with its reason',
    r.body.failures?.[0]?.email === 'b@x.test' && /Resend said no/.test(r.body.failures[0].error),
    JSON.stringify(r.body.failures));
  check('the job still completes rather than hanging', r.body.status === 'completed', r.body.status);

  // -------------------------------------------------------------------------
  console.log('\n9. the daily quota still binds');

  const usedSoFar = (await q(
    "SELECT COUNT(*)::int c FROM email_send_log WHERE shop_id = $1 AND success = true", [A]
  ))[0].c;
  check('the quota helper agrees with the log',
    (await emailJobs.remainingQuota(A)) === emailJobs.DAILY_LIMIT - usedSoFar,
    `${await emailJobs.remainingQuota(A)} vs ${emailJobs.DAILY_LIMIT - usedSoFar}`);

  // Burn the rest of today's allowance.
  await db.query(
    `INSERT INTO email_send_log (shop_id, recipient_email, send_type, success)
     SELECT $1, 'filler@x.test', 'bulk_email', true FROM generate_series(1, $2)`,
    [A, emailJobs.DAILY_LIMIT - usedSoFar]
  );
  r = await api('/api/bulk-email/send', {
    method: 'POST', body: { subject: 'Over quota', body: 'hello', eventIds: [eventA] },
  });
  check('a send over the daily limit is refused at enqueue time', r.status === 429, `${r.status} ${r.raw}`);

  // -------------------------------------------------------------------------
  console.log('\n10. jobs are scoped to one shop');

  const otherShopJobs = await api('/api/bulk-email/jobs', { shopDomain: 'other-shop.test' });
  check('another shop sees none of these jobs', (otherShopJobs.body.jobs || []).length === 0,
    JSON.stringify(otherShopJobs.body));

  const crossRead = await api(`/api/bulk-email/jobs/${job5}`, { shopDomain: 'other-shop.test' });
  check('another shop cannot read this job by id', crossRead.status === 404, `${crossRead.status}`);

  const crossCancel = await api(`/api/bulk-email/jobs/${job5}/cancel`, {
    method: 'POST', shopDomain: 'other-shop.test',
  });
  check('another shop cannot cancel it either', crossCancel.status === 404, `${crossCancel.status}`);

  // -------------------------------------------------------------------------
  console.log('\n11. the ticket listing reports scans correctly');

  const tickets = await q('SELECT id FROM tickets WHERE shop_id = $1 ORDER BY id', [A]);
  await db.query(
    `INSERT INTO ticket_scans (shop_id, ticket_id, scan_date, scanned_by_user_id)
     VALUES ($1, $2, '2026-12-01', 1), ($1, $2, '2026-12-02', 1), ($1, $3, '2026-12-03', 1)`,
    [A, tickets[0].id, tickets[1].id]
  );

  r = await api('/api/tickets');
  check('the listing responds', r.status === 200, `${r.status}`);
  check('  ...counting every scan, including repeats', r.body.totalCheckIns === 3,
    String(r.body.totalCheckIns));

  const listed = Object.fromEntries(r.body.tickets.map((t) => [t.id, t]));
  check('a scanned ticket is marked scanned', listed[tickets[0].id].scans.scanned === true);
  check('  ...reporting the EARLIEST scan, not an arbitrary one',
    String(listed[tickets[0].id].scans.scannedOn).startsWith('2026-12-01'),
    String(listed[tickets[0].id].scans.scannedOn));
  check('  ...with who scanned it', listed[tickets[0].id].scans.scannedBy?.username === 'tester',
    JSON.stringify(listed[tickets[0].id].scans.scannedBy));
  check('an unscanned ticket is not', listed[tickets[2].id].scans.scanned === false
    && listed[tickets[2].id].scans.scannedBy === null,
    JSON.stringify(listed[tickets[2].id].scans));
  check('every ticket is still returned', r.body.tickets.length === 4, String(r.body.tickets.length));

  // -------------------------------------------------------------------------
  console.log('\n12. naive times and the daily boundary do not drift with TZ');

  // Run this file under TZ=Asia/Tokyo or America/Chicago and these must still
  // hold. Before, node-postgres turned a naive timestamp into a JS Date in the
  // process's zone, so an event at 10:00 came back six hours out - and every
  // quota check built "today" from the app clock while sent_at came from the
  // database clock, so the boundary moved by whole hours between them.
  const naive = (await q("SELECT '2026-11-14 10:00'::timestamp AS t, '2026-11-14'::date AS d"))[0];
  check('a naive timestamp comes back as the same wall clock',
    String(naive.t).startsWith('2026-11-14 10:00'), JSON.stringify(naive.t));
  check('  ...and a date does not shift a day', String(naive.d) === '2026-11-14', JSON.stringify(naive.d));
  check('  ...neither is a Date the driver reinterpreted',
    !(naive.t instanceof Date) && !(naive.d instanceof Date));

  // The quota boundary is the DATABASE's midnight, so an entry logged just
  // before it counts for yesterday and one after counts for today, whatever
  // zone this process happens to be running in.
  const quotaShop = (await q("INSERT INTO shops (domain) VALUES ('quota.test') RETURNING id"))[0].id;
  await db.query("INSERT INTO settings (shop_id, org_name) VALUES ($1,'Q')", [quotaShop]);
  await db.query(
    `INSERT INTO email_send_log (shop_id, recipient_email, send_type, success, sent_at) VALUES
       ($1,'y@x.test','bulk_email',true, date_trunc('day', LOCALTIMESTAMP) - INTERVAL '1 second'),
       ($1,'t@x.test','bulk_email',true, date_trunc('day', LOCALTIMESTAMP) + INTERVAL '1 second')`,
    [quotaShop]
  );
  const quota = require('../src/services/email-quota');
  check('only today\'s send counts against the quota',
    (await quota.emailsSentToday(quotaShop)) === 1, String(await quota.emailsSentToday(quotaShop)));
  check('  ...and the remainder follows from it',
    (await quota.remainingQuota(quotaShop)) === quota.DAILY_LIMIT - 1,
    String(await quota.remainingQuota(quotaShop)));

  console.log(`\n${pass} passed, ${fail} failed`);
  emailJobs.stopWorker();
  server.close();
  await db.pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('\nHARNESS ERROR:', e); process.exit(1); });
