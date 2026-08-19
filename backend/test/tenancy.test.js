/*
 * Cross-tenant isolation tests.
 *
 * Requires a real, EMPTY Postgres database - it truncates tables. Never point
 * this at production.
 *
 *   DATABASE_URL=postgresql://postgres@localhost:5432/tickets_test \
 *     node src/migrations/run.js
 *   DATABASE_URL=postgresql://postgres@localhost:5432/tickets_test \
 *     npm run test:tenancy
 *
 * These drive the HTTP surface, not the query layer, because the failure mode
 * that matters is "shop A's request returned shop B's rows". A static check
 * (npm run check:tenancy) catches missing shop_id in source; this catches the
 * cases where shop_id is present but wired to the wrong value.
 */

const http = require('http');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'tenancy-test-secret';
process.env.PORT = process.env.PORT || '3998';
process.env.DEFAULT_SHOP_DOMAIN = 'shop-a.test';

const db = require('../src/config/database');
const shopContextModule = require('../src/middleware/shop-context');

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${detail}`); }
}

const BASE = `http://127.0.0.1:${process.env.PORT}`;
const tokenFor = (role = 'superadmin', id = 1) =>
  jwt.sign({ id, username: 'tester', role }, process.env.JWT_SECRET, { expiresIn: '1h' });

async function api(path, { method = 'GET', body, shopDomain, token } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token || tokenFor()}`,
      ...(shopDomain ? { 'x-test-shop-domain': shopDomain } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body: json, raw: text };
}

const q = (t, p) => db.query(t, p).then((r) => r.rows);

(async () => {
  // --- fixture: two shops, each with an event and tickets ---
  await db.query('TRUNCATE ticket_scans, email_send_log, webhook_logs, tickets, events, settings, shops, users RESTART IDENTITY CASCADE');

  // ticket_scans.scanned_by_user_id is a real FK, so the identity in the test
  // JWT must exist. users is intentionally NOT shop-scoped - see run.js.
  await db.query(
    "INSERT INTO users (id, username, password, role) VALUES (1, 'tester', 'x', 'superadmin')"
  );

  const shops = await q(
    `INSERT INTO shops (domain) VALUES ('shop-a.test'), ('shop-b.test') RETURNING id, domain`
  );
  const A = shops.find((s) => s.domain === 'shop-a.test').id;
  const B = shops.find((s) => s.domain === 'shop-b.test').id;
  shopContextModule.clearShopCache();

  await db.query(
    `INSERT INTO settings (shop_id, org_name, auto_send_emails, receive_mode_secret)
     VALUES ($1,'Shop A',false,'secret-a'), ($2,'Shop B',false,'secret-b')`, [A, B]
  );

  // Same SKU in both shops - this is the case the old global UNIQUE(sku) forbade.
  const evA = (await q(
    `INSERT INTO events (shop_id, name, starts_at, sku) VALUES ($1,'A Fest','2026-09-01','SHARED-SKU') RETURNING id`, [A]
  ))[0].id;
  const evB = (await q(
    `INSERT INTO events (shop_id, name, starts_at, sku) VALUES ($1,'B Fest','2026-09-01','SHARED-SKU') RETURNING id`, [B]
  ))[0].id;
  check('same SKU allowed in two shops', Boolean(evA && evB));

  await db.query(
    `INSERT INTO tickets (shop_id, event_id, name, email, uuid, shopify_order_id) VALUES
      ($1,$2,'Alice A','alice@a.test','uuid-a1','ord-a'),
      ($1,$2,'Anna A','anna@a.test','uuid-a2','ord-a'),
      ($3,$4,'Bob B','bob@b.test','uuid-b1','ord-b')`, [A, evA, B, evB]
  );
  await db.query(
    `INSERT INTO webhook_logs (shop_id, shopify_order_id, webhook_data, webhook_type)
     VALUES ($1,'ord-a','{"customer":{"email":"alice@a.test"}}','order_create'),
            ($2,'ord-b','{"customer":{"email":"bob@b.test"}}','order_create')`, [A, B]
  );

  // --- start the server with a test-only shop resolver ---
  const express = require('express');
  const app = express();
  app.use(express.json());
  // Stand in for a Shopify session token: the shop domain arrives per-request.
  app.use('/api', (req, res, next) => {
    if (req.headers['x-test-shop-domain']) req.shopDomain = req.headers['x-test-shop-domain'];
    next();
  });
  app.use('/api', require('../src/middleware/shop-context'));
  app.use('/api/tickets', require('../src/routes/tickets'));
  app.use('/api/events', require('../src/routes/events'));
  app.use('/api/stats', require('../src/routes/stats'));
  app.use('/api/settings', require('../src/routes/settings'));
  app.use('/api/verify', require('../src/routes/verify'));
  app.use('/api/webhooks', require('../src/routes/webhooks'));
  const server = await new Promise((resolve) => {
    const s = app.listen(process.env.PORT, () => resolve(s));
  });

  console.log('\n1. reads are scoped to the requesting shop');
  let r = await api('/api/tickets', { shopDomain: 'shop-a.test' });
  const aNames = (r.body?.tickets || []).map((t) => t.name).sort();
  check('shop A sees only its 2 tickets', JSON.stringify(aNames) === '["Alice A","Anna A"]', JSON.stringify(aNames));

  r = await api('/api/tickets', { shopDomain: 'shop-b.test' });
  const bNames = (r.body?.tickets || []).map((t) => t.name);
  check('shop B sees only its 1 ticket', JSON.stringify(bNames) === '["Bob B"]', JSON.stringify(bNames));

  r = await api('/api/events', { shopDomain: 'shop-a.test' });
  check('events scoped', r.body?.length === 1 && r.body[0].name === 'A Fest', JSON.stringify(r.body?.map?.((e) => e.name)));

  r = await api('/api/stats', { shopDomain: 'shop-b.test' });
  check('stats scoped', r.body?.totals?.sold === 1, JSON.stringify(r.body?.totals));

  r = await api('/api/webhooks', { shopDomain: 'shop-a.test' });
  check('webhook logs scoped', r.body?.total === 1 && r.body.logs[0].shopify_order_id === 'ord-a', JSON.stringify(r.body?.logs));

  console.log('\n2. settings are per shop, and the public endpoint stays narrow');
  r = await api('/api/settings/admin', { shopDomain: 'shop-a.test' });
  check('shop A gets its own settings', r.body?.org_name === 'Shop A', r.body?.org_name);
  check("shop A cannot see shop B's secret", r.body?.receive_mode_secret !== 'secret-b', String(r.body?.receive_mode_secret));

  r = await api('/api/settings/admin', { shopDomain: 'shop-b.test', token: tokenFor('admin') });
  check('non-superadmin gets no secret at all', r.body?.receive_mode_secret === undefined, String(r.body?.receive_mode_secret));

  r = await api('/api/settings', { shopDomain: 'shop-b.test' });
  check('public settings limited to org_name + logo_url',
    JSON.stringify(Object.keys(r.body || {}).sort()) === '["logo_url","org_name"]', JSON.stringify(r.body));

  console.log("\n3. writes cannot reach another shop's rows");
  const bTicket = (await q('SELECT id FROM tickets WHERE shop_id = $1', [B]))[0].id;

  r = await api(`/api/tickets/${bTicket}`, {
    method: 'PUT', shopDomain: 'shop-a.test', body: { name: 'HACKED', email: 'x@x.test' },
  });
  check("shop A cannot edit shop B's ticket (404)", r.status === 404, `got ${r.status}`);
  let row = (await q('SELECT name FROM tickets WHERE id = $1', [bTicket]))[0];
  check('shop B ticket untouched', row.name === 'Bob B', row.name);

  r = await api(`/api/tickets/${bTicket}`, { method: 'DELETE', shopDomain: 'shop-a.test' });
  check("shop A cannot delete shop B's ticket (404)", r.status === 404, `got ${r.status}`);
  check('shop B ticket still exists', (await q('SELECT id FROM tickets WHERE id = $1', [bTicket])).length === 1);

  r = await api(`/api/tickets/${bTicket}/status`, {
    method: 'PATCH', shopDomain: 'shop-a.test', body: { status: 'refunded' },
  });
  check("shop A cannot void shop B's ticket (404)", r.status === 404, `got ${r.status}`);

  r = await api(`/api/events/${evB}`, { method: 'DELETE', shopDomain: 'shop-a.test' });
  check("shop A cannot delete shop B's event (404)", r.status === 404, `got ${r.status}`);
  check('shop B event still exists', (await q('SELECT id FROM events WHERE id = $1', [evB])).length === 1);

  r = await api(`/api/events/${evB}/archive`, { method: 'POST', shopDomain: 'shop-a.test' });
  check("shop A cannot archive shop B's event (404)", r.status === 404, `got ${r.status}`);

  console.log('\n4. scanning is scoped');
  r = await api('/api/verify/uuid-b1', { shopDomain: 'shop-a.test' });
  check("shop A cannot scan shop B's ticket", r.status === 404 && r.body?.status === 'invalid', `${r.status} ${JSON.stringify(r.body)}`);
  check('no scan recorded', (await q('SELECT id FROM ticket_scans')).length === 0);

  r = await api('/api/verify/uuid-b1', { shopDomain: 'shop-b.test' });
  check('shop B can scan its own ticket', r.body?.status === 'valid', JSON.stringify(r.body));
  const scans = await q('SELECT shop_id FROM ticket_scans');
  check('scan attributed to shop B', scans.length === 1 && scans[0].shop_id === B, JSON.stringify(scans));

  console.log('\n5. destructive operations stay inside the shop');
  r = await api('/api/tickets/reset-database', { method: 'DELETE', shopDomain: 'shop-a.test' });
  check('reset-database succeeded for shop A', r.status === 200, `${r.status} ${r.raw.slice(0, 80)}`);
  check('shop A tickets deleted', (await q('SELECT id FROM tickets WHERE shop_id = $1', [A])).length === 0);
  check("shop B tickets SURVIVED", (await q('SELECT id FROM tickets WHERE shop_id = $1', [B])).length === 1);

  console.log('\n6. unknown shop is rejected');
  r = await api('/api/tickets', { shopDomain: 'not-a-shop.test' });
  check('unknown shop domain -> 401', r.status === 401, `got ${r.status}`);

  await db.query('UPDATE shops SET uninstalled_at = NOW() WHERE id = $1', [B]);
  shopContextModule.clearShopCache();
  r = await api('/api/tickets', { shopDomain: 'shop-b.test' });
  check('uninstalled shop -> 401', r.status === 401, `got ${r.status}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  server.close();
  await db.pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('\nHARNESS ERROR:', e); process.exit(1); });
