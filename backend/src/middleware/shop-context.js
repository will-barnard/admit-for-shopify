/**
 * Resolves which shop (tenant) a request belongs to and puts it on `req.shopId`.
 *
 * Every query against a tenant-owned table must filter on that value. There is
 * no framework magic doing it for you - a missing `WHERE shop_id = $n` is a
 * cross-tenant data leak, which is a strictly worse failure than the role-check
 * gaps this codebase used to have. `backend/test/tenancy.test.js` exists to
 * catch exactly that and should be extended whenever a query is added.
 *
 * Two resolution modes coexist during the migration to a Shopify app:
 *
 *   legacy  - the app's own JWT auth. There is exactly one shop, resolved once
 *             from DEFAULT_SHOP_DOMAIN and cached.
 *   shopify - a Shopify session token, whose `dest` claim names the shop. Not
 *             wired up yet; resolveShopByDomain() is the seam it will use.
 */

const db = require('../config/database');

const DEFAULT_SHOP_DOMAIN = process.env.DEFAULT_SHOP_DOMAIN || 'legacy.local';

let defaultShopIdCache = null;
const domainCache = new Map();

async function getDefaultShopId() {
  if (defaultShopIdCache !== null) return defaultShopIdCache;

  const result = await db.query('SELECT id FROM shops WHERE domain = $1', [DEFAULT_SHOP_DOMAIN]);
  if (result.rows.length === 0) {
    throw new Error(
      `No shop row for DEFAULT_SHOP_DOMAIN "${DEFAULT_SHOP_DOMAIN}". ` +
      'Migrations create it - run `npm run migrate`.'
    );
  }
  defaultShopIdCache = result.rows[0].id;
  return defaultShopIdCache;
}

async function resolveShopByDomain(domain) {
  if (!domain) return null;
  if (domainCache.has(domain)) return domainCache.get(domain);

  const result = await db.query(
    'SELECT id FROM shops WHERE domain = $1 AND uninstalled_at IS NULL',
    [domain]
  );
  const id = result.rows.length > 0 ? result.rows[0].id : null;
  if (id !== null) domainCache.set(domain, id);
  return id;
}

function clearShopCache() {
  defaultShopIdCache = null;
  domainCache.clear();
}

/**
 * Express middleware. Must run after whatever established identity, because a
 * Shopify session token carries the shop domain on `req.shopDomain`.
 */
async function shopContext(req, res, next) {
  try {
    if (req.shopDomain) {
      const id = await resolveShopByDomain(req.shopDomain);
      if (id === null) {
        return res.status(401).json({ error: 'Unknown or uninstalled shop' });
      }
      req.shopId = id;
    } else {
      req.shopId = await getDefaultShopId();
    }
    next();
  } catch (error) {
    console.error('Failed to resolve shop context:', error);
    res.status(500).json({ error: 'Server error' });
  }
}

module.exports = shopContext;
module.exports.getDefaultShopId = getDefaultShopId;
module.exports.resolveShopByDomain = resolveShopByDomain;
module.exports.clearShopCache = clearShopCache;
module.exports.DEFAULT_SHOP_DOMAIN = DEFAULT_SHOP_DOMAIN;
