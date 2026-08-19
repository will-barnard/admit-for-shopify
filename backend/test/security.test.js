/*
 * Security tests: who is allowed to do what, and what the unauthenticated
 * surface will tolerate.
 *
 * The headline case is the first section. The embedded Shopify admin
 * authenticates with an App Bridge session token, which is signed with the
 * app's CLIENT SECRET - not JWT_SECRET. middleware/shopify-auth verified it and
 * then middleware/auth rejected it a few lines later, so the embedded app
 * rendered and 401'd on every single call. Nothing caught that, because no test
 * had ever driven a protected route with a session token.
 *
 * Requires a real, EMPTY Postgres database - it truncates tables.
 *
 *   DATABASE_URL=... node src/migrations/run.js
 *   DATABASE_URL=... npm run test:security
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const CLIENT_ID = 'test-client-id';
const CLIENT_SECRET = 'test-client-secret';
process.env.SHOPIFY_APP_CLIENT_ID = CLIENT_ID;
process.env.SHOPIFY_APP_CLIENT_SECRET = CLIENT_SECRET;
process.env.JWT_SECRET = 'security-test-secret';
process.env.PORT = process.env.PORT || '3993';
process.env.DEFAULT_SHOP_DOMAIN = 'sec-shop.myshopify.com';

const db = require('../src/config/database');
const shopContextModule = require('../src/middleware/shop-context');
const shopifyUsers = require('../src/shopify/users');

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${detail}`); }
}

const BASE = `http://127.0.0.1:${process.env.PORT}`;
const q = (t, p) => db.query(t, p).then((r) => r.rows);

const legacyToken = (role, id) =>
  jwt.sign({ id, username: `u${id}`, role }, process.env.JWT_SECRET, { expiresIn: '1h' });

function sessionToken(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign({
    iss: 'https://sec-shop.myshopify.com/admin',
    dest: 'https://sec-shop.myshopify.com',
    aud: CLIENT_ID,
    sub: '4242',
    exp: now + 60, nbf: now - 5, iat: now, jti: crypto.randomUUID(), sid: 'sess-sec',
    ...overrides,
  }, CLIENT_SECRET, { algorithm: 'HS256' });
}

async function api(path, { method = 'GET', body, token, headers = {} } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
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
    'TRUNCATE ticket_scans, email_send_log, webhook_logs, tickets, event_ticket_types, events, settings, shops, users RESTART IDENTITY CASCADE'
  );

  const shopId = (await q(
    "INSERT INTO shops (domain, access_token) VALUES ('sec-shop.myshopify.com','shpat_fake') RETURNING id"
  ))[0].id;
  await db.query("INSERT INTO settings (shop_id, org_name) VALUES ($1,'Sec')", [shopId]);
  const eventId = (await q(
    "INSERT INTO events (shop_id, name, event_date) VALUES ($1,'Sec Fest','2026-12-01') RETURNING id", [shopId]
  ))[0].id;
  await db.query(
    "INSERT INTO event_ticket_types (shop_id, event_id, name) VALUES ($1,$2,'General Admission')", [shopId, eventId]
  );

  const pw = await bcrypt.hash('correct-horse', 10);
  await db.query(
    `INSERT INTO users (id, username, password, role) VALUES
       (1,'super',$1,'superadmin'), (2,'admin',$1,'admin'), (3,'door',$1,'verifier')`, [pw]
  );
  // Explicit ids do not advance the sequence, and the Shopify identity rows are
  // inserted without one - so leave the sequence where the next INSERT expects it.
  await db.query("SELECT setval('users_id_seq', (SELECT MAX(id) FROM users))");
  shopContextModule.clearShopCache();
  shopifyUsers.clearShopifyUserCache();

  const express = require('express');
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/api/auth', require('../src/middleware/rate-limit').authRouteLimiter);
  app.use('/api/auth', require('../src/routes/auth'));
  app.use('/api/auth', require('../src/routes/verifier-auth'));
  app.use('/api', require('../src/middleware/shopify-auth'));
  app.use('/api', require('../src/middleware/shop-context'));
  app.use('/api/events', require('../src/routes/events'));
  app.use('/api/settings', require('../src/routes/settings'));
  const server = await new Promise((r) => { const s = app.listen(process.env.PORT, () => r(s)); });

  // -------------------------------------------------------------------------
  console.log('\n1. the embedded Shopify admin can actually use the API');

  let r = await api('/api/events', { token: sessionToken() });
  check('a valid session token authenticates a protected route', r.status === 200, `${r.status} ${r.raw}`);
  check('  ...and returns that shop\'s events', Array.isArray(r.body) && r.body.length === 1,
    JSON.stringify(r.body?.length));

  const shopifyUsers1 = await q("SELECT id, username, role, password FROM users WHERE username LIKE 'shopify:%'");
  check('a real users row was created for the staff member', shopifyUsers1.length === 1,
    JSON.stringify(shopifyUsers1.map((u) => u.username)));
  check('  ...keyed to the staff id and shop',
    shopifyUsers1[0]?.username === 'shopify:4242@sec-shop.myshopify.com', shopifyUsers1[0]?.username);
  check('  ...with a password nobody can use',
    !(await bcrypt.compare('', shopifyUsers1[0].password))
    && !(await bcrypt.compare('correct-horse', shopifyUsers1[0].password)));

  r = await api('/api/auth/login', {
    method: 'POST',
    body: { username: 'shopify:4242@sec-shop.myshopify.com', password: '' },
  });
  check('  ...and cannot be logged into', r.status === 400 || r.status === 401, `${r.status} ${r.raw}`);

  r = await api('/api/events', { token: sessionToken() });
  const shopifyUsers2 = await q("SELECT id FROM users WHERE username LIKE 'shopify:%'");
  check('a second request reuses the same identity, not a new row', shopifyUsers2.length === 1,
    String(shopifyUsers2.length));

  r = await api('/api/events', { token: sessionToken({ sub: '9999' }) });
  const shopifyUsers3 = await q("SELECT id FROM users WHERE username LIKE 'shopify:%'");
  check('a different staff member gets a distinct identity', shopifyUsers3.length === 2,
    String(shopifyUsers3.length));

  // A session token signed with the wrong secret must not slip through as a
  // legacy JWT either.
  r = await api('/api/events', {
    token: jwt.sign({ dest: 'https://sec-shop.myshopify.com', aud: CLIENT_ID }, 'not-the-secret', { algorithm: 'HS256' }),
  });
  check('a forged session token is still rejected', r.status === 401, `${r.status} ${r.raw}`);

  r = await api('/api/events');
  check('no token at all is still rejected', r.status === 401, `${r.status}`);

  // -------------------------------------------------------------------------
  console.log('\n2. door staff cannot administer the event');

  const door = legacyToken('verifier', 3);
  const admin = legacyToken('admin', 2);
  const superadmin = legacyToken('superadmin', 1);

  r = await api('/api/events', { token: door });
  check('a verifier may still READ events', r.status === 200, `${r.status}`);

  r = await api('/api/events/list/active', { token: door });
  check('  ...and the active list the scanner needs', r.status === 200, `${r.status}`);

  const writes = [
    ['create an event', '/api/events', 'POST', { name: 'Nope', event_date: '2026-12-02' }],
    ['edit an event', `/api/events/${eventId}`, 'PUT', { name: 'Renamed', event_date: '2026-12-01' }],
    ['delete an event', `/api/events/${eventId}`, 'DELETE', undefined],
    ['archive an event', `/api/events/${eventId}/archive`, 'POST', {}],
    ['unarchive an event', `/api/events/${eventId}/unarchive`, 'POST', {}],
    ['add a ticket type', `/api/events/${eventId}/ticket-types`, 'POST', { name: 'Nope' }],
    ['change settings', '/api/settings', 'PUT', { org_name: 'Pwned' }],
    ['export the ticket CSV', '/api/settings/export-no-email-tickets', 'GET', undefined],
  ];
  for (const [label, path, method, body] of writes) {
    const res = await api(path, { method, body, token: door });
    check(`a verifier cannot ${label}`, res.status === 403, `${res.status} ${res.raw?.slice(0, 90)}`);
  }

  r = await api('/api/events', { method: 'POST', body: { name: 'Admin Made', event_date: '2026-12-03' }, token: admin });
  check('an admin can create an event', r.status === 201, `${r.status} ${r.raw}`);

  r = await api(`/api/events/${eventId}/ticket-types`, { method: 'POST', body: { name: 'VIP' }, token: superadmin });
  check('a superadmin can add a ticket type', r.status === 201, `${r.status} ${r.raw}`);

  r = await api('/api/events', { method: 'POST', body: { name: 'Embedded Made', event_date: '2026-12-04' }, token: sessionToken() });
  check('the embedded Shopify admin can create an event', r.status === 201, `${r.status} ${r.raw}`);

  // -------------------------------------------------------------------------
  console.log('\n3. login is rate limited');

  const attempt = (username, password, ip) => api('/api/auth/login', {
    method: 'POST',
    body: { username, password },
    headers: { 'X-Forwarded-For': ip },
  });

  let statuses = [];
  for (let i = 0; i < 12; i += 1) {
    statuses.push((await attempt('admin', 'wrong-password', '203.0.113.10')).status);
  }
  check('the first 10 wrong passwords are answered normally',
    statuses.slice(0, 10).every((s) => s === 401), JSON.stringify(statuses));
  check('the 11th is refused with 429', statuses[10] === 429, JSON.stringify(statuses));

  r = await attempt('super', 'wrong-password', '203.0.113.10');
  check('another account from the same IP is not caught in it', r.status === 401, `${r.status}`);

  r = await attempt('admin', 'correct-horse', '203.0.113.11');
  check('the real password still works from a different address', r.status === 200, `${r.status} ${r.raw}`);

  // Successful logins are not counted, so ordinary use never trips the limit.
  statuses = [];
  for (let i = 0; i < 12; i += 1) {
    statuses.push((await attempt('admin', 'correct-horse', '203.0.113.12')).status);
  }
  check('12 SUCCESSFUL logins in a row are all allowed',
    statuses.every((s) => s === 200), JSON.stringify(statuses));

  // -------------------------------------------------------------------------
  console.log('\n4. the login token expires');

  const decoded = jwt.decode((await attempt('admin', 'correct-horse', '203.0.113.13')).body.token);
  check('a login token carries an expiry even with JWT_EXPIRES_IN unset',
    typeof decoded.exp === 'number', JSON.stringify(decoded));
  check('  ...and it is not decades away', decoded.exp - decoded.iat <= 24 * 3600,
    String(decoded.exp - decoded.iat));

  // -------------------------------------------------------------------------
  console.log('\n5. the CSV export cannot carry a formula');

  await db.query(
    `INSERT INTO tickets (shop_id, event_id, name, email, uuid, shopify_order_id) VALUES
       ($1,$2,'=cmd|''/c calc''!A1', NULL, 'uuid-csv-1', 'ord-1'),
       ($1,$2,'Bob" ,injected',      NULL, 'uuid-csv-2', 'ord-2'),
       ($1,$2,'@SUM(1+1)',           NULL, 'uuid-csv-3', 'ord-3'),
       ($1,$2,'Ordinary Name',       NULL, 'uuid-csv-4', 'ord-4')`,
    [shopId, eventId]
  );

  const csvRes = await fetch(`${BASE}/api/settings/export-no-email-tickets`, {
    headers: { Authorization: `Bearer ${admin}` },
  });
  const csv = await csvRes.text();
  check('the export is served', csvRes.status === 200, `${csvRes.status}`);

  const lines = csv.trim().split('\n');
  check('one header plus one row per ticket', lines.length === 5, `${lines.length}: ${JSON.stringify(lines.slice(0, 2))}`);
  check('a leading = is defused', /"'=cmd/.test(csv), csv.slice(0, 400));
  check('a leading @ is defused', /"'@SUM/.test(csv), csv.slice(0, 400));
  check('an embedded quote is doubled, not left to split the row',
    csv.includes('"Bob"" ,injected"'), csv.slice(0, 400));
  check('an ordinary name is untouched apart from quoting',
    csv.includes('"Ordinary Name"') && !csv.includes("'Ordinary"), csv.slice(0, 400));
  check('no data row has more fields than the header',
    lines.slice(1).every((line) => (line.match(/","/g) || []).length === 6),
    JSON.stringify(lines.slice(1)));

  // -------------------------------------------------------------------------
  console.log('\n6. the logo uploader refuses executable images');

  const postLogo = async (filename, type, body, token = admin) => {
    const form = new FormData();
    form.append('logo', new Blob([body], { type }), filename);
    const res = await fetch(`${BASE}/api/settings/logo`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
    });
    return { status: res.status, text: await res.text() };
  };

  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.cookie)</script></svg>';
  let up = await postLogo('logo.svg', 'image/svg+xml', svg);
  check('an SVG is refused', up.status >= 400, `${up.status} ${up.text.slice(0, 120)}`);

  up = await postLogo('logo.svg', 'image/png', svg);
  check('  ...and cannot sneak past by lying about its mime type', up.status >= 400,
    `${up.status} ${up.text.slice(0, 120)}`);

  up = await postLogo('logo.png', 'image/svg+xml', svg);
  check('  ...or by lying about its extension', up.status >= 400, `${up.status} ${up.text.slice(0, 120)}`);

  // A one-pixel PNG, to prove the filter did not just break uploading.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  up = await postLogo('logo.png', 'image/png', png);
  check('a real PNG is still accepted', up.status === 200, `${up.status} ${up.text.slice(0, 160)}`);

  up = await postLogo('logo.png', 'image/png', png, legacyToken('verifier', 3));
  check('a verifier cannot upload a logo at all', up.status === 403, `${up.status}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  server.close();
  await db.pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('\nHARNESS ERROR:', e); process.exit(1); });
