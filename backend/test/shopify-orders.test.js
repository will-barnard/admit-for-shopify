/*
 * Functional tests for services/shopify-orders.js.
 *
 * Requires a real, EMPTY Postgres database - it truncates tables. Never point
 * this at production.
 *
 *   createdb tickets_test
 *   DATABASE_URL=postgresql://postgres@localhost:5432/tickets_test \
 *     node src/migrations/run.js
 *   DATABASE_URL=postgresql://postgres@localhost:5432/tickets_test \
 *     npm run test:orders
 *
 * Leave RESEND_API_KEY unset so no real email is sent.
 */
const db = require('../src/config/database');
const orders = require('../src/services/shopify-orders');

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${detail}`); }
}
const q = (t, p) => db.query(t, p).then(r => r.rows);

let SHOP;

async function reset() {
  await db.query('TRUNCATE ticket_scans, email_send_log, webhook_logs, tickets, events, settings, shops RESTART IDENTITY CASCADE');
  SHOP = (await q("INSERT INTO shops (domain) VALUES ('test.myshopify.com') RETURNING id"))[0].id;
  await db.query(
    "INSERT INTO settings (shop_id, org_name, auto_send_emails) VALUES ($1, 'Test Org', false)", [SHOP]
  );
  await db.query(`INSERT INTO events (shop_id, name, event_date, sku, active, archived) VALUES
    ($1, 'Two Day Pass',  '2026-09-01', 'CDS-2DAY', true,  false),
    ($1, 'Saturday Pass', '2026-09-01', 'CDS-SAT',  true,  false),
    ($1, 'Archived Show', '2025-09-01', 'CDS-OLD',  true,  true),
    ($1, 'Inactive Show', '2026-10-01', 'CDS-OFF',  false, false)`, [SHOP]);
}

const order = (id, lines, email = 'buyer@example.com') => ({
  id,
  customer: { first_name: 'John', last_name: 'Doe', email },
  line_items: lines,
});

(async () => {
  // ---- A: happy path ----
  console.log('\nA. order create');
  await reset();
  let r = await orders.processOrderCreate(
    order(1001, [
      { id: 5001, sku: 'CDS-2DAY', quantity: 2 },
      { id: 5002, sku: 'CDS-SAT', quantity: 1 },
    ]), { source: 'live', shopId: SHOP });
  check('outcome=created', r.outcome === 'created', r.outcome);
  check('3 tickets created', r.tickets.length === 3, `got ${r.tickets.length}`);
  let rows = await q('SELECT shopify_line_item_id, COUNT(*) c FROM tickets GROUP BY 1 ORDER BY 1');
  check('line item ids recorded 2+1', JSON.stringify(rows.map(x => [x.shopify_line_item_id, +x.c])) === '[["5001",2],["5002",1]]', JSON.stringify(rows));
  check('QR generated', r.tickets.every(t => t.qrCodeDataUrl?.startsWith('data:image/png')));
  let logs = await q('SELECT processed, tickets_created FROM webhook_logs');
  check('webhook logged processed', logs.length === 1 && logs[0].processed === true && logs[0].tickets_created === 3, JSON.stringify(logs));

  // ---- B: duplicate ----
  console.log('\nB. duplicate replay');
  r = await orders.processOrderCreate(order(1001, [{ id: 5001, sku: 'CDS-2DAY', quantity: 2 }]), { source: 'retry', shopId: SHOP });
  check('outcome=duplicate', r.outcome === 'duplicate', r.outcome);
  check('still 3 tickets', (await q('SELECT * FROM tickets')).length === 3);

  // ---- C: archived / inactive events are not sellable ----
  console.log('\nC. archived + inactive events excluded (the retry-path drift bug)');
  r = await orders.processOrderCreate(order(1002, [{ id: 5003, sku: 'CDS-OLD', quantity: 2 }]), { source: 'retry', shopId: SHOP });
  check('archived event -> no tickets', r.outcome === 'no_ticket_items', r.outcome);
  r = await orders.processOrderCreate(order(1003, [{ id: 5004, sku: 'CDS-OFF', quantity: 1 }]), { source: 'retry', shopId: SHOP });
  check('inactive event -> no tickets', r.outcome === 'no_ticket_items', r.outcome);

  // ---- D: partial refund ----
  console.log('\nD. partial refund voids only the refunded ticket');
  r = await orders.processOrderStatusChange({
    payload: { order_id: 1001, refund_line_items: [{ line_item_id: 5001, quantity: 1 }] },
    status: 'refunded', webhookType: 'refund', source: 'live', shopId: SHOP,
  });
  check('outcome=updated', r.outcome === 'updated', r.outcome);
  check('exactly 1 voided', r.updated.length === 1, `got ${r.updated.length}`);
  check('flagged partial', r.selection.partial === true);
  rows = await q("SELECT status, COUNT(*) c FROM tickets GROUP BY 1 ORDER BY 1");
  check('1 refunded / 2 valid', JSON.stringify(rows.map(x => [x.status, +x.c])) === '[["refunded",1],["valid",2]]', JSON.stringify(rows));

  // ---- E: prefers unscanned tickets ----
  console.log('\nE. refund prefers an unscanned ticket over a scanned one');
  await reset();
  r = await orders.processOrderCreate(order(2001, [{ id: 6001, sku: 'CDS-2DAY', quantity: 2 }]), { source: 'live', shopId: SHOP });
  const [t1, t2] = r.tickets;
  await db.query('INSERT INTO ticket_scans (shop_id, ticket_id, scan_date) VALUES ($1, $2, NOW())', [SHOP, t1.id]);
  r = await orders.processOrderStatusChange({
    payload: { order_id: 2001, refund_line_items: [{ line_item_id: 6001, quantity: 1 }] },
    status: 'refunded', webhookType: 'refund', source: 'live', shopId: SHOP,
  });
  check('voided the unscanned ticket', r.updated.length === 1 && r.updated[0].id === t2.id, `voided ${JSON.stringify(r.updated)}`);
  const scanned = await q('SELECT status FROM tickets WHERE id = $1', [t1.id]);
  check('scanned ticket left valid', scanned[0].status === 'valid', scanned[0].status);

  // ---- F: legacy tickets without line item ids ----
  console.log('\nF. legacy tickets (no line item id) fall back to voiding all');
  await reset();
  await db.query(`INSERT INTO tickets (shop_id, event_id, name, email, uuid, shopify_order_id) VALUES
    ($1,1,'Legacy A','a@x.com','uuid-a','3001'), ($1,1,'Legacy B','b@x.com','uuid-b','3001')`, [SHOP]);
  r = await orders.processOrderStatusChange({
    payload: { order_id: 3001, refund_line_items: [{ line_item_id: 7001, quantity: 1 }] },
    status: 'refunded', webhookType: 'refund', source: 'live', shopId: SHOP,
  });
  check('voided both (fallback)', r.updated.length === 2, `got ${r.updated.length}`);
  check('fallback reason reported', r.selection.reason === 'tickets_predate_line_item_tracking', r.selection.reason);

  // ---- G: concurrent delivery of the same order ----
  console.log('\nG. concurrent duplicate deliveries (advisory lock)');
  await reset();
  const payload = order(4001, [{ id: 8001, sku: 'CDS-2DAY', quantity: 3 }]);
  const results = await Promise.all([
    orders.processOrderCreate(payload, { source: 'live', shopId: SHOP }),
    orders.processOrderCreate(payload, { source: 'live', shopId: SHOP }),
    orders.processOrderCreate(payload, { source: 'live', shopId: SHOP }),
  ]);
  const total = (await q('SELECT * FROM tickets')).length;
  check('exactly 3 tickets, not 9', total === 3, `got ${total}`);
  check('one created + two duplicates', results.filter(x => x.outcome === 'created').length === 1
    && results.filter(x => x.outcome === 'duplicate').length === 2,
    JSON.stringify(results.map(x => x.outcome)));

  // ---- H: email quota accounting + silent-failure handling ----
  console.log('\nH. email accounting (RESEND_API_KEY unset)');
  await reset();
  await db.query('UPDATE settings SET auto_send_emails = true WHERE shop_id = $1', [SHOP]);
  r = await orders.processOrderCreate(order(5001, [{ id: 9001, sku: 'CDS-2DAY', quantity: 4 }]), { source: 'live', shopId: SHOP });
  check('tickets still created', r.tickets.length === 4);
  check('email reported not sent', r.email.sent === false, JSON.stringify(r.email));
  const sentFlags = await q('SELECT DISTINCT email_sent FROM tickets');
  check('tickets NOT marked email_sent', sentFlags.length === 1 && sentFlags[0].email_sent === false, JSON.stringify(sentFlags));
  const elog = await q('SELECT success, COUNT(*) c FROM email_send_log GROUP BY 1');
  check('one log row per message (not per ticket), marked failed',
    elog.length === 1 && elog[0].success === false && +elog[0].c === 1, JSON.stringify(elog));

  // ---- I: validation ----
  console.log('\nI. validation');
  await reset();
  r = await orders.processOrderCreate({ id: 6001, customer: { first_name: 'X' } }, { source: 'live', shopId: SHOP });
  check('missing line_items rejected', r.outcome === 'invalid', r.outcome);
  r = await orders.processOrderCreate({ id: 6002, line_items: [], customer: {} }, { source: 'live', shopId: SHOP });
  check('missing first_name rejected', r.outcome === 'invalid', r.outcome);
  check('validation failures still logged', (await q('SELECT * FROM webhook_logs')).length === 2);

  console.log(`\n${pass} passed, ${fail} failed`);
  await db.pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('\nHARNESS ERROR:', e); process.exit(1); });
