/*
 * Tests for the event -> ticket types model.
 *
 * The point of this file is the promise made when the model changed: an event
 * may have many ticket types, but an event with exactly ONE must keep working
 * without anyone ever thinking about types. Both halves are asserted here.
 *
 * It also covers the failure mode the model was meant to make visible - a line
 * item that matches no ticket type - end to end, from the order pipeline to the
 * needs-attention endpoint that surfaces it.
 *
 * Requires a real, EMPTY Postgres database - it truncates tables.
 *
 *   DATABASE_URL=... node src/migrations/run.js
 *   DATABASE_URL=... npm run test:ticket-types
 */

const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'ticket-types-test-secret';
process.env.PORT = process.env.PORT || '3995';
process.env.DEFAULT_SHOP_DOMAIN = 'shop-a.test';

const db = require('../src/config/database');
const shopContextModule = require('../src/middleware/shop-context');
const orders = require('../src/services/shopify-orders');

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${detail}`); }
}

const BASE = `http://127.0.0.1:${process.env.PORT}`;
const token = jwt.sign({ id: 1, username: 'tester', role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: '1h' });

async function api(path, { method = 'GET', body, shopDomain = 'shop-a.test' } = {}) {
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

const q = (t, p) => db.query(t, p).then((r) => r.rows);

(async () => {
  await db.query(
    'TRUNCATE ticket_scans, email_send_log, webhook_logs, tickets, event_ticket_types, events, settings, shops, users RESTART IDENTITY CASCADE'
  );
  await db.query("INSERT INTO users (id, username, password, role) VALUES (1, 'tester', 'x', 'superadmin')");

  const A = (await q("INSERT INTO shops (domain) VALUES ('shop-a.test') RETURNING id"))[0].id;
  const B = (await q("INSERT INTO shops (domain) VALUES ('shop-b.test') RETURNING id"))[0].id;
  await db.query(
    "INSERT INTO settings (shop_id, org_name, auto_send_emails) VALUES ($1,'A',false), ($2,'B',false)", [A, B]
  );
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
  app.use('/api/tickets', require('../src/routes/tickets'));
  app.use('/api/webhooks', require('../src/routes/webhooks'));
  const server = await new Promise((resolve) => {
    const s = app.listen(process.env.PORT, () => resolve(s));
  });

  // -------------------------------------------------------------------------
  console.log('\n1. a simple event still behaves like a simple event');

  let r = await api('/api/events', {
    method: 'POST',
    body: { name: 'Open Mic', event_date: '2026-10-01', sku: 'OPENMIC' },
  });
  check('created', r.status === 201, `${r.status} ${r.raw}`);
  const simple = r.body;
  check('exactly one ticket type was created', (simple.ticket_types || []).length === 1,
    JSON.stringify(simple.ticket_types));
  check('it is named General Admission', simple.ticket_types?.[0]?.name === 'General Admission',
    simple.ticket_types?.[0]?.name);
  check('it carries the SKU the caller passed as event.sku',
    simple.ticket_types?.[0]?.shopify_sku === 'OPENMIC', simple.ticket_types?.[0]?.shopify_sku);

  r = await api(`/api/events/${simple.id}/ticket-types`, {
    method: 'DELETE',
  });
  check('an event refuses to give up its last ticket type (route needs a typeId)',
    r.status === 404, `${r.status}`);

  const onlyTypeId = simple.ticket_types[0].id;
  r = await api(`/api/events/${simple.id}/ticket-types/${onlyTypeId}`, { method: 'DELETE' });
  check('deleting the only ticket type is refused', r.status === 400, `${r.status} ${r.raw}`);
  check('  ...with a reason that says why', /at least one/i.test(r.body?.error || ''), r.body?.error);

  // -------------------------------------------------------------------------
  console.log('\n1b. event time is a clock time, and says so when it is not');

  // events.event_time is a Postgres `time`. The form used to hint
  // "e.g. 10:00 AM - 6:00 PM", which the column rejects - and the route turned
  // that parse error into a bare 500, so following the app's own placeholder
  // produced an unexplained failure.
  r = await api('/api/events', {
    method: 'POST',
    body: { name: 'Ranged', event_date: '2026-10-02', event_time: '10:00 AM - 6:00 PM' },
  });
  check('a time RANGE is refused with 400, not a 500', r.status === 400, `${r.status} ${r.raw}`);
  check('  ...explaining what to do instead', /single clock time/i.test(r.body?.error || ''), r.body?.error);

  for (const good of ['19:00', '09:30', '7:00 PM', '11:15:00']) {
    r = await api('/api/events', {
      method: 'POST',
      body: { name: `Timed ${good}`, event_date: '2026-10-03', event_time: good },
    });
    check(`"${good}" is accepted`, r.status === 201, `${r.status} ${r.raw}`);
  }

  r = await api('/api/events', {
    method: 'POST', body: { name: 'No time', event_date: '2026-10-04', event_time: '' },
  });
  check('an empty time is still fine', r.status === 201, `${r.status} ${r.raw}`);

  r = await api('/api/events', {
    method: 'POST', body: { name: 'Nonsense', event_date: '2026-10-05', event_time: 'whenever' },
  });
  check('gibberish is refused too', r.status === 400, `${r.status}`);

  r = await api(`/api/events/${simple.id}`, {
    method: 'PUT',
    body: { name: 'Open Mic', event_date: '2026-10-01', event_time: '10:00 AM - 6:00 PM' },
  });
  check('editing an event checks the time as well', r.status === 400, `${r.status} ${r.raw}`);

  // -------------------------------------------------------------------------
  console.log('\n2. an event with several ticket types');

  r = await api('/api/events', {
    method: 'POST',
    body: {
      name: 'Chicago Drum Show',
      event_date: '2026-11-14',
      ticket_types: [
        { name: 'VIP', shopify_variant_id: '111', shopify_sku: 'CDS-VIP', capacity: 50 },
        { name: 'Adult 2-Day', shopify_variant_id: '222', shopify_sku: 'CDS-ADULT-2D' },
        { name: 'Child Saturday', shopify_sku: 'CDS-CHILD-SAT' },
      ],
    },
  });
  check('created with 3 types', r.status === 201 && r.body.ticket_types.length === 3,
    `${r.status} ${JSON.stringify(r.body?.ticket_types?.length)}`);
  const show = r.body;
  const vip = show.ticket_types.find((t) => t.name === 'VIP');
  const adult = show.ticket_types.find((t) => t.name === 'Adult 2-Day');
  const child = show.ticket_types.find((t) => t.name === 'Child Saturday');
  check('sort_order follows the order they were given',
    show.ticket_types.map((t) => t.sort_order).join(',') === '0,1,2',
    show.ticket_types.map((t) => t.sort_order).join(','));
  check('capacity is stored', vip.capacity === 50, String(vip.capacity));

  r = await api('/api/events');
  const listed = r.body.find((e) => e.id === show.id);
  check('the list endpoint embeds ticket types', (listed.ticket_types || []).length === 3,
    JSON.stringify(listed.ticket_types?.length));
  check('one row per SHOW, not one per ticket type',
    r.body.filter((e) => e.name === 'Chicago Drum Show').length === 1,
    JSON.stringify(r.body.map((e) => e.name)));

  // Uniqueness is per shop, and only where a value is present.
  r = await api(`/api/events/${show.id}/ticket-types`, {
    method: 'POST',
    body: { name: 'Duplicate variant', shopify_variant_id: '111' },
  });
  check('a variant id cannot be mapped twice', r.status === 400, `${r.status} ${r.raw}`);

  r = await api(`/api/events/${show.id}/ticket-types`, {
    method: 'POST',
    body: { name: 'Duplicate sku, different case', shopify_sku: 'cds-vip' },
  });
  check('SKU uniqueness is case-insensitive', r.status === 400, `${r.status} ${r.raw}`);

  r = await api(`/api/events/${show.id}/ticket-types`, {
    method: 'POST',
    body: { name: 'Comp ticket' },
  });
  check('an unmapped type is allowed (manual-only)', r.status === 201, `${r.status} ${r.raw}`);
  const comp = r.body;
  check('  ...and lands at the end', comp.sort_order === 3, String(comp.sort_order));

  r = await api(`/api/events/${show.id}/ticket-types/${comp.id}`, { method: 'DELETE' });
  check('an unused type can be deleted', r.status === 200, `${r.status} ${r.raw}`);

  // Shop B may reuse the same variant id - uniqueness is per shop.
  const bEvent = (await q(
    "INSERT INTO events (shop_id, name, event_date) VALUES ($1,'B Show','2026-11-14') RETURNING id", [B]
  ))[0].id;
  r = await api(`/api/events/${bEvent}/ticket-types`, {
    method: 'POST',
    body: { name: 'VIP', shopify_variant_id: '111' },
    shopDomain: 'shop-b.test',
  });
  check('another shop may use the same variant id', r.status === 201, `${r.status} ${r.raw}`);

  // -------------------------------------------------------------------------
  console.log('\n3. orders match the right ticket type');

  const order = {
    id: 5001,
    name: '#5001',
    order_number: 5001,
    customer: { first_name: 'Dana', last_name: 'Ray', email: 'dana@x.test' },
    line_items: [
      { id: 1, variant_id: 111, sku: 'IGNORED-BECAUSE-VARIANT-WINS', quantity: 2 },
      { id: 2, sku: 'cds-child-sat', quantity: 1 },              // case-insensitive SKU fallback
      { id: 3, sku: 'TSHIRT-L', variant_id: 999, quantity: 1 },  // not a ticket at all
      { id: 4, title: 'Gift wrap', quantity: 1 },                // no sku, no variant - ignored entirely
    ],
  };

  const result = await orders.processOrderCreate(order, { source: 'test', shopId: A });
  check('order produced tickets', result.outcome === 'created', result.outcome);
  check('3 tickets issued (2 VIP + 1 child)', result.tickets.length === 3, String(result.tickets.length));

  const byType = await q(
    `SELECT tt.name, COUNT(*)::int AS c FROM tickets t
       JOIN event_ticket_types tt ON tt.id = t.ticket_type_id
      WHERE t.shop_id = $1 GROUP BY tt.name ORDER BY tt.name`, [A]
  );
  check('variant id wins over a conflicting SKU',
    JSON.stringify(byType) === '[{"name":"Child Saturday","c":1},{"name":"VIP","c":2}]',
    JSON.stringify(byType));

  check('the non-ticket line item is recorded as unmatched',
    (result.unmatched || []).length === 1, JSON.stringify(result.unmatched));
  check('  ...and it is the t-shirt, not the gift wrap',
    result.unmatched[0].sku === 'TSHIRT-L', JSON.stringify(result.unmatched[0]));

  // -------------------------------------------------------------------------
  console.log('\n4. unmatched line items surface as needs-attention');

  r = await api('/api/webhooks/needs-attention');
  check('endpoint resolves ahead of GET /:id', r.status === 200, `${r.status} ${r.raw}`);
  check('the partially-matched order is listed', r.body.orders.length === 1, JSON.stringify(r.body.count));
  const entry = r.body.orders[0];
  check('  ...with the order name from the payload', entry.order_name === '#5001', entry.order_name);
  check('  ...the customer', entry.customer === 'Dana Ray', entry.customer);
  check('  ...and an honest partial count', entry.tickets_created === 3, String(entry.tickets_created));
  check('unmapped SKUs are aggregated', r.body.unmapped.length === 1 && r.body.unmapped[0].sku === 'TSHIRT-L',
    JSON.stringify(r.body.unmapped));

  r = await api('/api/webhooks/stats/summary');
  check('the stats summary counts it', Number(r.body.needs_attention) === 1, JSON.stringify(r.body.needs_attention));

  r = await api(`/api/webhooks/${entry.id}/resolve-unmatched`, { method: 'POST' });
  check('it can be dismissed', r.status === 200, `${r.status} ${r.raw}`);

  r = await api('/api/webhooks/needs-attention');
  check('dismissing removes it from the list', r.body.orders.length === 0, JSON.stringify(r.body.count));
  const kept = await q('SELECT unmatched_line_items IS NOT NULL AS still_there FROM webhook_logs WHERE id = $1', [entry.id]);
  check('  ...but the record itself is kept', kept[0].still_there === true, JSON.stringify(kept));

  r = await api('/api/webhooks/needs-attention', { shopDomain: 'shop-b.test' });
  check('needs-attention is scoped to one shop', r.body.orders.length === 0, JSON.stringify(r.body));

  // An order that matches nothing at all is the original silent failure.
  const dud = {
    id: 5002,
    name: '#5002',
    customer: { first_name: 'Sam', last_name: 'Nil', email: 'sam@x.test' },
    line_items: [{ id: 9, sku: 'NOT-A-TICKET', quantity: 3 }],
  };
  const dudResult = await orders.processOrderCreate(dud, { source: 'test', shopId: A });
  check('an order matching nothing reports no_ticket_items', dudResult.outcome === 'no_ticket_items', dudResult.outcome);
  r = await api('/api/webhooks/needs-attention');
  check('  ...and appears in needs-attention', r.body.orders.length === 1, JSON.stringify(r.body.count));
  check('  ...showing zero tickets issued', r.body.orders[0].tickets_created === 0,
    String(r.body.orders[0].tickets_created));

  // -------------------------------------------------------------------------
  console.log('\n5. manual tickets and ticket types');

  r = await api('/api/tickets/create-order', {
    method: 'POST',
    body: {
      customerName: 'Walk Up',
      email: null,
      tickets: [{ eventId: simple.id, name: 'Walk Up', quantity: 1 }],
    },
  });
  check('a single-type event needs no ticket type from the caller', r.status === 201 || r.status === 200,
    `${r.status} ${r.raw}`);
  let manual = await q(
    `SELECT tt.name FROM tickets t JOIN event_ticket_types tt ON tt.id = t.ticket_type_id
      WHERE t.event_id = $1 AND t.shop_id = $2`, [simple.id, A]
  );
  check('  ...and the ticket still gets the one type', manual.length === 1 && manual[0].name === 'General Admission',
    JSON.stringify(manual));

  r = await api('/api/tickets/create-order', {
    method: 'POST',
    body: {
      customerName: 'Comped VIP',
      email: null,
      tickets: [{ eventId: show.id, ticketTypeId: vip.id, name: 'Comped VIP', quantity: 1 }],
    },
  });
  check('an explicit ticket type is honoured', r.status === 201 || r.status === 200, `${r.status} ${r.raw}`);
  manual = await q(
    `SELECT COUNT(*)::int AS c FROM tickets WHERE ticket_type_id = $1 AND shop_id = $2 AND name = 'Comped VIP'`,
    [vip.id, A]
  );
  check('  ...and lands on that type', manual[0].c === 1, JSON.stringify(manual));

  r = await api('/api/tickets/create-order', {
    method: 'POST',
    body: {
      customerName: 'Wrong',
      email: null,
      // adult belongs to `show`, not to `simple` - the FK alone would allow it
      tickets: [{ eventId: simple.id, ticketTypeId: adult.id, name: 'Wrong', quantity: 1 }],
    },
  });
  check('a ticket type from another event is rejected', r.status === 400, `${r.status} ${r.raw}`);
  check('  ...with a specific message', /does not belong to event/i.test(r.body?.error || ''), r.body?.error);

  const bType = (await q(
    'SELECT id FROM event_ticket_types WHERE shop_id = $1 LIMIT 1', [B]
  ))[0].id;
  r = await api('/api/tickets/create-order', {
    method: 'POST',
    body: {
      customerName: 'Cross tenant',
      email: null,
      tickets: [{ eventId: show.id, ticketTypeId: bType, name: 'Cross tenant', quantity: 1 }],
    },
  });
  check('a ticket type from another SHOP is rejected', r.status === 400, `${r.status} ${r.raw}`);

  // -------------------------------------------------------------------------
  console.log('\n5b. naming each attendee on a manual order');

  // Quantity 5 used to mean five tickets all called the same thing. That is
  // right for a family and wrong for a company buying passes, so the names are
  // optional and positional rather than either behaviour being imposed.
  r = await api('/api/tickets/create-order', {
    method: 'POST',
    body: {
      customerName: 'Acme Corp',
      email: null,
      tickets: [{
        eventId: show.id,
        ticketTypeId: child.id,
        name: 'Acme Corp',
        quantity: 3,
        attendeeNames: ['Ada Lovelace', '', 'Grace Hopper'],
      }],
    },
  });
  check('an order with per-attendee names is accepted', r.status === 201 || r.status === 200,
    `${r.status} ${r.raw}`);

  const named = await q(
    `SELECT name FROM tickets WHERE ticket_type_id = $1 AND shop_id = $2 ORDER BY id`, [child.id, A]
  );
  const namesOnly = named.map((t) => t.name);
  check('each name lands on its own ticket',
    namesOnly.includes('Ada Lovelace') && namesOnly.includes('Grace Hopper'), JSON.stringify(namesOnly));
  check('a blank entry falls back to the order name',
    namesOnly.filter((n) => n === 'Acme Corp').length === 1, JSON.stringify(namesOnly));
  check('  ...and the count is still the quantity asked for',
    namesOnly.filter((n) => ['Ada Lovelace', 'Grace Hopper', 'Acme Corp'].includes(n)).length >= 3,
    JSON.stringify(namesOnly));

  // Omitting the array entirely must behave exactly as before.
  r = await api('/api/tickets/create-order', {
    method: 'POST',
    body: {
      customerName: 'Family',
      email: null,
      tickets: [{ eventId: show.id, ticketTypeId: adult.id, name: 'The Smiths', quantity: 4 }],
    },
  });
  check('omitting the names still works', r.status === 201 || r.status === 200, `${r.status} ${r.raw}`);
  const family = await q(
    "SELECT name FROM tickets WHERE ticket_type_id = $1 AND shop_id = $2 AND name = 'The Smiths'", [adult.id, A]
  );
  check('  ...giving every ticket the line name, as before', family.length === 4, String(family.length));

  // -------------------------------------------------------------------------
  console.log('\n6. a type with issued tickets is protected');

  r = await api(`/api/events/${show.id}/ticket-types/${vip.id}`, { method: 'DELETE' });
  check('cannot delete a type that has tickets', r.status === 400, `${r.status} ${r.raw}`);
  check('  ...and is told to deactivate instead', /deactivate/i.test(r.body?.error || ''), r.body?.error);

  r = await api(`/api/events/${show.id}/ticket-types/${vip.id}`, {
    method: 'PUT',
    body: { name: 'VIP', shopify_variant_id: '111', shopify_sku: 'CDS-VIP', capacity: 50, active: false },
  });
  check('it can be deactivated', r.status === 200 && r.body.active === false, `${r.status} ${r.raw}`);

  const encore = {
    id: 5003,
    customer: { first_name: 'Late', last_name: 'Buyer', email: 'late@x.test' },
    line_items: [{ id: 21, variant_id: 111, quantity: 1 }],
  };
  const encoreResult = await orders.processOrderCreate(encore, { source: 'test', shopId: A });
  check('a deactivated type stops matching new orders',
    encoreResult.outcome === 'no_ticket_items', encoreResult.outcome);
  check('  ...and the line item is reported rather than dropped',
    (encoreResult.unmatched || []).length === 1, JSON.stringify(encoreResult.unmatched));

  const stillThere = await q('SELECT COUNT(*)::int AS c FROM tickets WHERE ticket_type_id = $1', [vip.id]);
  check('existing VIP tickets are untouched', stillThere[0].c === 3, JSON.stringify(stillThere));

  console.log(`\n${pass} passed, ${fail} failed`);
  server.close();
  await db.pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('\nHARNESS ERROR:', e); process.exit(1); });
