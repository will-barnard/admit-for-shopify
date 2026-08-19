/**
 * Ticket type capacity.
 *
 * `capacity` has been stored and displayed since ticket types existed, but
 * nothing ever checked it - "142 of 200 sold" was decoration.
 *
 * The two paths are deliberately different, and that asymmetry is the whole
 * design:
 *
 *   Manual creation is REFUSED when it would exceed capacity. Staff are acting
 *   deliberately and can be told why, and an explicit override exists for the
 *   comp-at-the-door case.
 *
 *   A Shopify order is NEVER refused. The customer has already paid; declining
 *   to issue their ticket would turn an inventory mistake into a support
 *   problem and a chargeback. Shopify's own inventory is what should have
 *   stopped the sale, so an overage here means the two systems disagree - which
 *   is exactly the thing worth telling someone about. It is recorded and shown
 *   in the needs-attention list instead.
 *
 * Counting matches ticket_count everywhere else: refunded and cancelled
 * tickets free their place back up.
 */

const db = require('../config/database');

const SOLD_SQL = `
  SELECT tt.id,
         tt.name,
         tt.capacity,
         (SELECT COUNT(*)::int FROM tickets t
           WHERE t.ticket_type_id = tt.id AND t.shop_id = tt.shop_id
             AND (t.status IS NULL OR t.status = 'valid')) AS sold
    FROM event_ticket_types tt
   WHERE tt.shop_id = $1 AND tt.id = ANY($2)`;

/**
 * @param {Array<{ticketTypeId: number, quantity: number}>} requests
 * @returns {Promise<Array>} one entry per type that WOULD be over capacity.
 *          A type with no capacity set is unlimited and never appears.
 */
async function findOverages(shopId, requests, client = db) {
  const wanted = new Map();
  for (const { ticketTypeId, quantity } of requests) {
    if (!ticketTypeId) continue;
    wanted.set(Number(ticketTypeId), (wanted.get(Number(ticketTypeId)) || 0) + (Number(quantity) || 0));
  }
  if (wanted.size === 0) return [];

  const result = await client.query(SOLD_SQL, [shopId, [...wanted.keys()]]);

  return result.rows
    .filter((row) => row.capacity !== null && row.capacity !== undefined)
    .map((row) => {
      const requested = wanted.get(row.id) || 0;
      return {
        ticket_type_id: row.id,
        name: row.name,
        capacity: row.capacity,
        sold: row.sold,
        requested,
        over_by: row.sold + requested - row.capacity,
      };
    })
    .filter((row) => row.over_by > 0);
}

/**
 * Serialise capacity decisions for a set of ticket types, so two people
 * clicking Create at the same moment cannot both squeeze into the last place.
 * Locks are taken in a stable order to avoid deadlocking against each other.
 */
async function lockTicketTypes(client, shopId, ticketTypeIds) {
  const ids = [...new Set(ticketTypeIds.filter(Boolean).map(Number))].sort((a, b) => a - b);
  for (const id of ids) {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`ticket-type-capacity:${shopId}:${id}`]);
  }
}

function describeOverage(overages) {
  return overages
    .map((o) => `${o.name}: ${o.sold} of ${o.capacity} sold, ${o.requested} more requested`)
    .join('; ');
}

module.exports = { findOverages, lockTicketTypes, describeOverage };
