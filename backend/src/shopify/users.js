const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../config/database');

/**
 * Map an authenticated Shopify staff member onto a row in `users`.
 *
 * Why this exists: the embedded admin authenticates with an App Bridge session
 * token, which is signed with the app's client secret - not JWT_SECRET. Every
 * protected route runs middleware/auth.js, which only understood the legacy
 * JWT, so an embedded request was verified by shopify-auth and then rejected a
 * few lines later with "Invalid token". The app rendered and every call 401'd.
 *
 * A synthetic in-memory identity would not have been enough:
 * ticket_scans.scanned_by_user_id is a real foreign key, so scanning from the
 * embedded admin needs a row that actually exists.
 *
 * Role: superadmin. Access to an embedded app is already gated by the
 * merchant's own staff permissions in the Shopify admin - a person who can open
 * this app is, from Shopify's point of view, entitled to the shop's data. The
 * frontend already assumes this (stores/auth.js effectiveRole). If this app
 * ever goes public, revisit: "can open the app" is a coarser grant than some
 * merchants will want.
 */

const cache = new Map();

function usernameFor(shopDomain, shopifyUserId) {
  // Unique per staff member so scans are attributable. Shopify omits `sub` for
  // app-level (offline) contexts, so fall back to a shop-wide identity.
  return `shopify:${shopifyUserId || 'shop'}@${shopDomain}`.slice(0, 255);
}

async function resolveShopifyUser(shopDomain, shopifyUserId) {
  const username = usernameFor(shopDomain, shopifyUserId);
  const cached = cache.get(username);
  if (cached) return cached;

  const existing = await db.query(
    'SELECT id, username, role FROM users WHERE username = $1',
    [username]
  );
  if (existing.rows.length > 0) {
    cache.set(username, existing.rows[0]);
    return existing.rows[0];
  }

  // The password column is NOT NULL and there is no password to store. Hash a
  // fresh random secret that is discarded immediately, so the row can never be
  // used with POST /api/auth/login - an empty or sentinel value would risk
  // being compared successfully by some bcrypt implementation.
  const unusable = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);

  const inserted = await db.query(
    `INSERT INTO users (username, password, role)
     VALUES ($1, $2, 'superadmin')
     ON CONFLICT (username) DO UPDATE SET username = EXCLUDED.username
     RETURNING id, username, role`,
    [username, unusable]
  );

  const user = inserted.rows[0];
  cache.set(username, user);
  return user;
}

function clearShopifyUserCache() {
  cache.clear();
}

module.exports = { resolveShopifyUser, clearShopifyUserCache, usernameFor };
