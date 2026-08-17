const db = require('../config/database');
const { isValidShopDomain } = require('./config');
const shopContext = require('../middleware/shop-context');

/**
 * Create or update a shop and store its offline access token.
 *
 * Reinstalls must work: App Store review treats "app doesn't reinstall
 * properly" as a hard rejection, and the same logic applies here. A shop that
 * was uninstalled and comes back reuses its row - and therefore keeps its
 * events, tickets and scan history - rather than starting empty.
 */
async function upsertShop({ domain, accessToken, scopes, expiresIn, refreshToken, refreshTokenExpiresIn }) {
  if (!isValidShopDomain(domain)) throw new Error(`Invalid shop domain: ${domain}`);

  const accessExpiry = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;
  const refreshExpiry = refreshTokenExpiresIn ? new Date(Date.now() + refreshTokenExpiresIn * 1000) : null;

  const result = await db.query(
    `INSERT INTO shops (domain, access_token, access_token_expires_at, refresh_token, refresh_token_expires_at, scopes, installed_at, uninstalled_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), NULL, NOW())
     ON CONFLICT (domain) DO UPDATE
        SET access_token = EXCLUDED.access_token,
            access_token_expires_at = EXCLUDED.access_token_expires_at,
            refresh_token = EXCLUDED.refresh_token,
            refresh_token_expires_at = EXCLUDED.refresh_token_expires_at,
            scopes = EXCLUDED.scopes,
            installed_at = COALESCE(shops.installed_at, NOW()),
            uninstalled_at = NULL,
            updated_at = NOW()
     RETURNING id, domain`,
    [domain, accessToken, accessExpiry, refreshToken, refreshExpiry, scopes]
  );

  // A reinstall flips uninstalled_at back to NULL, and shop-context caches only
  // installed shops - so the cache must be dropped or the shop stays 401.
  shopContext.clearShopCache();

  const shop = result.rows[0];
  await ensureSettingsRow(shop.id);
  return shop;
}

/** Every shop needs exactly one settings row; UNIQUE (shop_id) enforces it. */
async function ensureSettingsRow(shopId) {
  await db.query(
    `INSERT INTO settings (shop_id) VALUES ($1) ON CONFLICT (shop_id) DO NOTHING`,
    [shopId]
  );
}

async function getShopByDomain(domain) {
  const result = await db.query('SELECT * FROM shops WHERE domain = $1', [domain]);
  return result.rows[0] || null;
}

/**
 * Handle app/uninstalled.
 *
 * The access token is dead the moment the merchant uninstalls, so it is cleared
 * rather than kept around. Tenant data is deliberately NOT deleted here: a
 * reinstall should find its events and tickets intact. For a public app,
 * shop/redact arrives 48 hours after uninstall and starts a 30-day clock to
 * erase everything - that handler belongs here when this goes public.
 */
async function markUninstalled(domain) {
  const result = await db.query(
    `UPDATE shops
        SET uninstalled_at = NOW(),
            access_token = NULL,
            access_token_expires_at = NULL,
            refresh_token = NULL,
            refresh_token_expires_at = NULL,
            updated_at = NOW()
      WHERE domain = $1
      RETURNING id`,
    [domain]
  );
  shopContext.clearShopCache();
  return result.rows[0] || null;
}

module.exports = { upsertShop, getShopByDomain, markUninstalled, ensureSettingsRow };
