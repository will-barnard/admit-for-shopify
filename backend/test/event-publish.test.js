/*
 * Publishing an event to the storefront.
 *
 * The app now CREATES the Shopify product for an event rather than being
 * pointed at one, which inverts the direction of the integration. The things
 * that matter, in order:
 *
 *   - pressing Publish twice must not make two products
 *   - renaming a ticket type must EDIT its variant, not replace it, because a
 *     replacement orphans every ticket already sold against the old one
 *   - the variant ids Shopify hands back must land on the ticket types, since
 *     that is what the order pipeline matches on
 *   - a refusal from Shopify must surface, not vanish
 *
 * The Admin API transport is stubbed. Nothing here touches the network, and the
 * stub asserts on the request the client actually formed rather than trusting
 * that it formed one.
 *
 * Requires a real, EMPTY Postgres database - it truncates tables.
 *
 *   DATABASE_URL=... node src/migrations/run.js
 *   DATABASE_URL=... npm run test:event-publish
 */

const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'event-publish-secret';
process.env.PORT = process.env.PORT || '3990';
process.env.DEFAULT_SHOP_DOMAIN = 'pub-shop.myshopify.com';
process.env.SHOPIFY_APP_CLIENT_ID = 'test-client';
process.env.SHOPIFY_APP_CLIENT_SECRET = 'test-secret';
process.env.SHOPIFY_ADMIN_RETRIES = '3';

const db = require('../src/config/database');
const shopContextModule = require('../src/middleware/shop-context');
const adminApi = require('../src/shopify/admin-api');
const publish = require('../src/services/event-publish');

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${detail}`); }
}

const BASE = `http://127.0.0.1:${process.env.PORT}`;
const q = (t, p) => db.query(t, p).then((r) => r.rows);
const token = jwt.sign({ id: 1, username: 'tester', role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: '1h' });

async function api(path, { method = 'GET', body, shopDomain = 'pub-shop.myshopify.com' } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'x-test-shop-domain': shopDomain,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body: json, raw: text };
}

// --- the fake Shopify -------------------------------------------------------
// Keeps one product keyed by the admit.event_id metafield, so it exercises the
// upsert-on-custom-id contract the real mutation provides.
const calls = [];
const store = new Map(); // eventId -> { id, handle, variants: [{id,title,sku,price}] }
let nextProductId = 900;
let nextVariantId = 8000;
let respondWith = null; // override for a single call

adminApi.setTransport(async (url, body, headers) => {
  calls.push({ url, body, headers });
  if (respondWith) { const r = respondWith; respondWith = null; return r; }

  const input = body.variables.input;
  const eventId = body.variables.identifier?.customId?.value;

  let product = store.get(eventId);
  if (!product) {
    product = { id: `gid://shopify/Product/${nextProductId += 1}`, handle: `event-${eventId}`, variants: [] };
    store.set(eventId, product);
  }
  product.status = input.status;

  // Declarative: the variant list becomes exactly what was asked for.
  product.variants = input.variants.map((v) => {
    const title = v.optionValues[0].name;
    const existing = v.id ? product.variants.find((e) => e.id === v.id) : null;
    return {
      id: existing ? existing.id : `gid://shopify/ProductVariant/${nextVariantId += 1}`,
      title,
      sku: v.sku ?? null,
      price: v.price,
    };
  });

  return {
    status: 200,
    data: {
      data: {
        productSet: {
          product: {
            id: product.id,
            handle: product.handle,
            status: product.status,
            onlineStoreUrl: `https://pub-shop.myshopify.com/products/${product.handle}`,
            variants: { nodes: product.variants },
          },
          userErrors: [],
        },
      },
    },
  };
});

(async () => {
  await db.query(
    'TRUNCATE ticket_scans, email_send_log, webhook_logs, tickets, event_ticket_types, events, settings, shops, users RESTART IDENTITY CASCADE'
  );
  await db.query("INSERT INTO users (id, username, password, role) VALUES (1,'tester','x','superadmin')");
  await db.query("SELECT setval('users_id_seq', (SELECT MAX(id) FROM users))");
  const A = (await q(
    "INSERT INTO shops (domain, access_token) VALUES ('pub-shop.myshopify.com','shpat_test') RETURNING id"
  ))[0].id;
  await db.query("INSERT INTO settings (shop_id, org_name) VALUES ($1,'Pub')", [A]);
  shopContextModule.clearShopCache();

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api', (req, res, next) => {
    if (req.headers['x-test-shop-domain']) req.shopDomain = req.headers['x-test-shop-domain'];
    next();
  });
  app.use('/api', require('../src/middleware/shop-context'));
  app.use('/api/events', require('../src/routes/events'));
  const server = await new Promise((r) => { const s = app.listen(process.env.PORT, () => r(s)); });

  // -------------------------------------------------------------------------
  console.log('\n1. publishing an event');

  let r = await api('/api/events', {
    method: 'POST',
    body: {
      name: 'Drum Show',
      starts_at: '2026-11-14 10:00',
      ends_at: '2026-11-15 18:00',
      location: 'The Barn',
      ticket_types: [
        { name: 'VIP', price: '95.00', shopify_sku: 'DS-VIP' },
        { name: 'Adult', price: '45.00' },
        { name: 'Child', price: '0.00' },
      ],
    },
  });
  check('event created', r.status === 201, `${r.status} ${r.raw}`);
  const event = r.body;

  r = await api(`/api/events/${event.id}/publish`, { method: 'POST' });
  check('publish succeeds', r.status === 200, `${r.status} ${r.raw}`);
  check('  ...returning the product handle', Boolean(r.body.product?.handle), JSON.stringify(r.body.product));
  check('  ...and the storefront URL', /products\//.test(r.body.product?.onlineStoreUrl || ''),
    r.body.product?.onlineStoreUrl);

  const sent = calls[calls.length - 1].body.variables;
  check('one variant per ticket type', sent.input.variants.length === 3,
    String(sent.input.variants.length));
  check('the option is named per ticket, not "Title"',
    sent.input.productOptions[0].name === 'Ticket', JSON.stringify(sent.input.productOptions));
  check('prices are carried up', sent.input.variants.map((v) => v.price).join(',') === '95.00,45.00,0.00',
    sent.input.variants.map((v) => v.price).join(','));
  check('inventory is NOT tracked in Shopify (capacity lives here)',
    sent.input.variants.every((v) => v.inventoryItem.tracked === false));
  check('  ...and selling is not blocked by Shopify stock',
    sent.input.variants.every((v) => v.inventoryPolicy === 'CONTINUE'));
  check('tickets are not shippable',
    sent.input.variants.every((v) => v.inventoryItem.requiresShipping === false));

  const meta = Object.fromEntries(sent.input.metafields.map((m) => [m.key, m.value]));
  check('the event id goes up as a metafield', meta.event_id === String(event.id), JSON.stringify(meta));
  check('  ...with the start', String(meta.starts_at).startsWith('2026-11-14T10:00'), meta.starts_at);
  check('  ...the end', String(meta.ends_at).startsWith('2026-11-15T18:00'), meta.ends_at);
  check('  ...and the location', meta.location === 'The Barn', meta.location);
  check('the metafield types are declared', sent.input.metafields.every((m) => Boolean(m.type)));

  check('the request went to the right shop and version',
    calls[calls.length - 1].url === 'https://pub-shop.myshopify.com/admin/api/2026-07/graphql.json',
    calls[calls.length - 1].url);
  check('  ...with the stored access token',
    calls[calls.length - 1].headers['X-Shopify-Access-Token'] === 'shpat_test');

  // -------------------------------------------------------------------------
  console.log('\n2. the variant ids come back to the ticket types');

  const types = await q(
    'SELECT name, shopify_variant_id FROM event_ticket_types WHERE event_id = $1 ORDER BY sort_order', [event.id]
  );
  check('every ticket type learned its variant id', types.every((t) => Boolean(t.shopify_variant_id)),
    JSON.stringify(types));
  check('  ...and they are distinct', new Set(types.map((t) => t.shopify_variant_id)).size === 3,
    JSON.stringify(types.map((t) => t.shopify_variant_id)));
  const vipVariantId = types.find((t) => t.name === 'VIP').shopify_variant_id;

  // This is the whole point: the order pipeline matches on variant id, and it
  // is now populated by publishing rather than by hand.
  const orders = require('../src/services/shopify-orders');
  const result = await orders.processOrderCreate({
    id: 8801,
    customer: { first_name: 'Pat', last_name: 'Buyer', email: 'pat@x.test' },
    line_items: [{ id: 1, variant_id: Number(vipVariantId), quantity: 2 }],
  }, { source: 'test', shopId: A });
  check('an order against a published variant issues tickets', result.tickets.length === 2,
    `${result.outcome} ${result.tickets.length}`);

  // -------------------------------------------------------------------------
  console.log('\n3. publishing twice is idempotent');

  const productsBefore = store.size;
  r = await api(`/api/events/${event.id}/publish`, { method: 'POST' });
  check('a second publish succeeds', r.status === 200, `${r.status} ${r.raw}`);
  check('  ...and does NOT create a second product', store.size === productsBefore,
    `${store.size} vs ${productsBefore}`);

  const typesAfter = await q(
    'SELECT name, shopify_variant_id FROM event_ticket_types WHERE event_id = $1 ORDER BY sort_order', [event.id]
  );
  check('  ...leaving the variant ids untouched',
    JSON.stringify(typesAfter) === JSON.stringify(types), JSON.stringify(typesAfter));

  const identifier = calls[calls.length - 1].body.variables.identifier;
  check('identity is the event id, not the stored product id',
    identifier.customId.key === 'event_id' && identifier.customId.value === String(event.id),
    JSON.stringify(identifier));

  // Even with the local product id wiped, the upsert still finds it.
  await db.query('UPDATE events SET shopify_product_id = NULL WHERE id = $1', [event.id]);
  r = await api(`/api/events/${event.id}/publish`, { method: 'POST' });
  check('a stale/blank product id does not fork a new product',
    r.status === 200 && store.size === productsBefore, `${r.status} ${store.size}`);

  // -------------------------------------------------------------------------
  console.log('\n4. renaming a ticket type edits its variant');

  const vipType = (await q(
    "SELECT * FROM event_ticket_types WHERE event_id = $1 AND name = 'VIP'", [event.id]
  ))[0];
  r = await api(`/api/events/${event.id}/ticket-types/${vipType.id}`, {
    method: 'PUT',
    body: { name: 'VIP Weekend', price: '110.00', shopify_variant_id: vipType.shopify_variant_id, shopify_sku: 'DS-VIP' },
  });
  check('the rename saves', r.status === 200, `${r.status} ${r.raw}`);

  r = await api(`/api/events/${event.id}/publish`, { method: 'POST' });
  check('re-publishing after a rename succeeds', r.status === 200, `${r.status} ${r.raw}`);

  const renamedSent = calls[calls.length - 1].body.variables.input.variants;
  const renamed = renamedSent.find((v) => v.optionValues[0].name === 'VIP Weekend');
  check('the existing variant id is sent, so Shopify edits rather than replaces',
    renamed?.id === `gid://shopify/ProductVariant/${vipVariantId}`, JSON.stringify(renamed?.id));

  const afterRename = (await q(
    "SELECT shopify_variant_id FROM event_ticket_types WHERE id = $1", [vipType.id]
  ))[0];
  check('  ...so tickets already sold keep pointing at a live variant',
    afterRename.shopify_variant_id === vipVariantId,
    `${afterRename.shopify_variant_id} vs ${vipVariantId}`);

  // -------------------------------------------------------------------------
  console.log('\n5. refusals surface');

  respondWith = {
    status: 200,
    data: { data: { productSet: { product: null, userErrors: [
      { field: ['input', 'handle'], message: 'Handle is already taken', code: 'TAKEN' },
    ] } } },
  };
  r = await api(`/api/events/${event.id}/publish`, { method: 'POST' });
  check('a userErrors refusal is a 400, not a silent success', r.status === 400, `${r.status} ${r.raw}`);
  check('  ...quoting what Shopify said', /Handle is already taken/.test(r.body?.error || ''), r.body?.error);
  const failed = (await q('SELECT publish_error FROM events WHERE id = $1', [event.id]))[0];
  check('  ...and it is recorded on the event', /Handle is already taken/.test(failed.publish_error || ''),
    failed.publish_error);

  respondWith = { status: 200, data: { errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] } };
  const callsBefore = calls.length;
  r = await api(`/api/events/${event.id}/publish`, { method: 'POST' });
  check('a throttled call is retried, not failed outright', calls.length > callsBefore + 1,
    `${calls.length - callsBefore} attempts`);
  check('  ...and succeeds once the throttle clears', r.status === 200, `${r.status} ${r.raw}`);

  // -------------------------------------------------------------------------
  console.log('\n6. what cannot be published');

  r = await api('/api/events', {
    method: 'POST',
    body: { name: 'No sellable types', starts_at: '2026-12-01 19:00' },
  });
  const bare = r.body;
  await db.query('UPDATE event_ticket_types SET active = false WHERE event_id = $1', [bare.id]);
  r = await api(`/api/events/${bare.id}/publish`, { method: 'POST' });
  check('an event with no ACTIVE ticket type is refused', r.status === 400, `${r.status} ${r.raw}`);
  check('  ...explaining why', /at least one active ticket type/i.test(r.body?.error || ''), r.body?.error);

  r = await api('/api/events/999999/publish', { method: 'POST' });
  check('an unknown event is a 404', r.status === 404, `${r.status}`);

  // -------------------------------------------------------------------------
  console.log('\n7. unpublishing drafts rather than deletes');

  r = await api(`/api/events/${event.id}/unpublish`, { method: 'POST' });
  check('unpublish succeeds', r.status === 200, `${r.status} ${r.raw}`);
  check('  ...by drafting the product', r.body.product?.status === 'DRAFT', JSON.stringify(r.body.product));
  check('  ...and the product still exists, with its order history',
    store.has(String(event.id)) && store.get(String(event.id)).variants.length > 0,
    JSON.stringify(store.get(String(event.id))?.variants?.length));
  const unpublished = (await q('SELECT published_at, shopify_product_id FROM events WHERE id = $1', [event.id]))[0];
  check('  ...while the event reads as unpublished', unpublished.published_at === null,
    String(unpublished.published_at));
  check('  ...keeping the product link for next time', Boolean(unpublished.shopify_product_id),
    String(unpublished.shopify_product_id));

  // -------------------------------------------------------------------------
  console.log('\n8. tenancy');

  const B = (await q("INSERT INTO shops (domain, access_token) VALUES ('other.myshopify.com','shpat_b') RETURNING id"))[0].id;
  await db.query("INSERT INTO settings (shop_id, org_name) VALUES ($1,'B')", [B]);
  shopContextModule.clearShopCache();
  r = await api(`/api/events/${event.id}/publish`, { method: 'POST', shopDomain: 'other.myshopify.com' });
  check('another shop cannot publish this event', r.status === 404, `${r.status} ${r.raw}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  server.close();
  await db.pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('\nHARNESS ERROR:', e); process.exit(1); });
