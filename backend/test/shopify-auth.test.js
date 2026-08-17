/*
 * Tests for the Shopify auth primitives: webhook HMAC, session tokens, and the
 * webhook endpoint's verification / dedup / dispatch behaviour.
 *
 * Requires a real, EMPTY Postgres database - it truncates tables.
 *
 *   DATABASE_URL=... node src/migrations/run.js
 *   DATABASE_URL=... npm run test:shopify-auth
 *
 * No network calls: token exchange is stubbed.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const CLIENT_ID = 'test-client-id';
const CLIENT_SECRET = 'test-client-secret';
process.env.SHOPIFY_APP_CLIENT_ID = CLIENT_ID;
process.env.SHOPIFY_APP_CLIENT_SECRET = CLIENT_SECRET;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'legacy-secret';
process.env.PORT = process.env.PORT || '3996';
process.env.DEFAULT_SHOP_DOMAIN = 'shop-a.myshopify.com';

const db = require('../src/config/database');
const { verifyWebhookHmac, verifyQueryHmac } = require('../src/shopify/hmac');
const { verifySessionToken } = require('../src/shopify/session-token');
const { isValidShopDomain } = require('../src/shopify/config');
const shopContextModule = require('../src/middleware/shop-context');

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${detail}`); }
}
const q = (t, p) => db.query(t, p).then((r) => r.rows);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const hmacFor = (body, secret = CLIENT_SECRET) =>
  crypto.createHmac('sha256', secret).update(body).digest('base64');

function sessionToken(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign({
    iss: 'https://shop-a.myshopify.com/admin',
    dest: 'https://shop-a.myshopify.com',
    aud: CLIENT_ID,
    sub: '42',
    exp: now + 60,
    nbf: now - 5,
    iat: now,
    jti: 'abc',
    sid: 'sess-1',
    ...overrides,
  }, CLIENT_SECRET, { algorithm: 'HS256' });
}

(async () => {
  console.log('\n1. shop domain validation');
  check('accepts a myshopify domain', isValidShopDomain('acme.myshopify.com'));
  check('rejects a lookalike host', !isValidShopDomain('acme.myshopify.com.evil.test'));
  check('rejects a path traversal attempt', !isValidShopDomain('acme.myshopify.com/../x'));
  check('rejects an arbitrary domain', !isValidShopDomain('evil.test'));
  check('rejects empty', !isValidShopDomain(''));

  console.log('\n2. webhook HMAC');
  const body = Buffer.from(JSON.stringify({ id: 1, hello: 'world' }));
  check('accepts a correct digest', verifyWebhookHmac(body, hmacFor(body)));
  check('rejects a wrong digest', !verifyWebhookHmac(body, hmacFor(body, 'other-secret')));
  check('rejects a tampered body', !verifyWebhookHmac(Buffer.from('{"id":2}'), hmacFor(body)));
  check('rejects a missing header', !verifyWebhookHmac(body, undefined));
  check('rejects a truncated digest', !verifyWebhookHmac(body, hmacFor(body).slice(0, 10)));

  console.log('\n3. query HMAC (app proxy / legacy grant)');
  const params = { shop: 'acme.myshopify.com', timestamp: '123', path_prefix: '/apps/x' };
  const msg = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
  const good = crypto.createHmac('sha256', CLIENT_SECRET).update(msg).digest('hex');
  check('accepts a correct signature', verifyQueryHmac({ ...params, signature: good }));
  check('rejects a wrong signature', !verifyQueryHmac({ ...params, signature: 'deadbeef' }));
  check('rejects when a param is altered', !verifyQueryHmac({ ...params, shop: 'evil.myshopify.com', signature: good }));

  console.log('\n4. session tokens');
  const v = verifySessionToken(sessionToken());
  check('extracts the shop domain from dest', v.shopDomain === 'shop-a.myshopify.com', v.shopDomain);
  check('extracts the user id', v.userId === '42', v.userId);

  const expectThrow = (name, token, matcher) => {
    try { verifySessionToken(token); check(name, false, 'no error thrown'); }
    catch (e) { check(name, matcher ? matcher(e) : true, e.message); }
  };
  expectThrow('rejects a token signed with the wrong secret',
    jwt.sign({ dest: 'https://shop-a.myshopify.com', aud: CLIENT_ID }, 'wrong', { algorithm: 'HS256' }));
  expectThrow('rejects a token for another app (aud)', sessionToken({ aud: 'someone-elses-app' }));
  expectThrow('rejects an expired token',
    sessionToken({ exp: Math.floor(Date.now() / 1000) - 120, iat: Math.floor(Date.now() / 1000) - 180 }),
    (e) => e.name === 'TokenExpiredError');
  expectThrow('rejects a non-myshopify dest', sessionToken({ dest: 'https://evil.test', iss: 'https://evil.test/admin' }));
  expectThrow('rejects iss/dest disagreement', sessionToken({ iss: 'https://other-shop.myshopify.com/admin' }));

  // An unsigned "alg: none" token must never be accepted.
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({ dest: 'https://shop-a.myshopify.com', aud: CLIENT_ID })).toString('base64url');
  expectThrow('rejects an alg:none token', `${header}.${claims}.`);

  console.log('\n5. webhook endpoint');
  await db.query('TRUNCATE ticket_scans, email_send_log, webhook_logs, tickets, events, settings, shops, users RESTART IDENTITY CASCADE');
  const shopId = (await q("INSERT INTO shops (domain) VALUES ('shop-a.myshopify.com') RETURNING id"))[0].id;
  await db.query("INSERT INTO settings (shop_id, org_name, auto_send_emails) VALUES ($1,'A',false)", [shopId]);
  await db.query(
    "INSERT INTO events (shop_id, name, event_date, sku, active) VALUES ($1,'Fest','2026-09-01','SKU-1',true)", [shopId]
  );
  shopContextModule.clearShopCache();

  const express = require('express');
  const app = express();
  app.use('/api/shopify/webhooks', express.raw({ type: '*/*' }), require('../src/routes/shopify-webhooks'));
  const server = await new Promise((r) => { const s = app.listen(process.env.PORT, () => r(s)); });
  const BASE = `http://127.0.0.1:${process.env.PORT}/api/shopify/webhooks`;

  async function post(payload, { topic, shop = 'shop-a.myshopify.com', deliveryId, badHmac = false } = {}) {
    const raw = JSON.stringify(payload);
    const res = await fetch(BASE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Topic': topic,
        'X-Shopify-Shop-Domain': shop,
        'X-Shopify-Webhook-Id': deliveryId || crypto.randomUUID(),
        'X-Shopify-Hmac-Sha256': badHmac ? 'bogus' : hmacFor(Buffer.from(raw)),
      },
      body: raw,
    });
    return { status: res.status, text: await res.text() };
  }

  const order = { id: 900, customer: { first_name: 'Jo', email: 'jo@x.test' }, line_items: [{ id: 11, sku: 'SKU-1', quantity: 2 }] };

  let r = await post(order, { topic: 'orders/create', badHmac: true });
  check('bad HMAC -> 401', r.status === 401, `${r.status} ${r.text}`);
  check('nothing persisted on bad HMAC', (await q('SELECT id FROM webhook_logs')).length === 0);

  r = await post(order, { topic: 'orders/create', shop: 'evil.test' });
  check('invalid shop domain -> 400', r.status === 400, `${r.status}`);

  r = await post({ x: 1 }, { topic: 'carts/update' });
  check('unhandled topic acknowledged (200)', r.status === 200 && r.text === 'ignored', `${r.status} ${r.text}`);

  const delivery = crypto.randomUUID();
  r = await post(order, { topic: 'orders/create', deliveryId: delivery });
  check('valid order webhook -> 200', r.status === 200, `${r.status} ${r.text}`);
  await sleep(1200); // background processing
  check('2 tickets created', (await q('SELECT id FROM tickets')).length === 2);
  let logs = await q('SELECT processed, tickets_created, delivery_id FROM webhook_logs');
  check('webhook marked processed', logs.length === 1 && logs[0].processed === true && logs[0].tickets_created === 2, JSON.stringify(logs));

  r = await post(order, { topic: 'orders/create', deliveryId: delivery });
  check('replayed delivery id -> 200 duplicate', r.status === 200 && r.text === 'duplicate', `${r.status} ${r.text}`);
  check('no extra webhook_logs row', (await q('SELECT id FROM webhook_logs')).length === 1);
  check('no extra tickets', (await q('SELECT id FROM tickets')).length === 2);

  // Partial refund via the native refunds/create shape.
  r = await post({ order_id: 900, refund_line_items: [{ line_item_id: 11, quantity: 1 }] }, { topic: 'refunds/create' });
  check('refund webhook -> 200', r.status === 200);
  await sleep(1000);
  const statuses = await q('SELECT status, COUNT(*) c FROM tickets GROUP BY 1 ORDER BY 1');
  check('partial refund voided exactly one ticket',
    JSON.stringify(statuses.map((x) => [x.status, +x.c])) === '[["refunded",1],["valid",1]]', JSON.stringify(statuses));

  // orders/cancelled carries the order itself, so order id is `id`, not `order_id`.
  r = await post({ id: 900 }, { topic: 'orders/cancelled' });
  check('cancel webhook -> 200', r.status === 200);
  await sleep(1000);
  const cancelled = await q("SELECT COUNT(*) c FROM tickets WHERE status = 'cancelled'");
  check('cancellation voided the remaining valid ticket', +cancelled[0].c === 1, JSON.stringify(cancelled));

  r = await post({ shop_domain: 'shop-a.myshopify.com' }, { topic: 'app/uninstalled' });
  check('uninstall webhook -> 200', r.status === 200);
  const shop = (await q('SELECT uninstalled_at, access_token FROM shops WHERE id = $1', [shopId]))[0];
  check('shop marked uninstalled', shop.uninstalled_at !== null);
  check('access token cleared', shop.access_token === null);
  check('tenant data retained for reinstall', (await q('SELECT id FROM tickets')).length === 2);

  console.log(`\n${pass} passed, ${fail} failed`);
  server.close();
  await db.pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('\nHARNESS ERROR:', e); process.exit(1); });
