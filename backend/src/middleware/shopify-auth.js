const { verifySessionToken, extractSessionToken } = require('../shopify/session-token');
const { exchangeToken } = require('../shopify/token-exchange');
const { isConfigured } = require('../shopify/config');
const { upsertShop, getShopByDomain } = require('../shopify/shops');

/**
 * Authenticate an embedded-admin request using a Shopify App Bridge session
 * token, and make sure we hold an offline access token for that shop.
 *
 * Runs BEFORE middleware/shop-context.js: it sets req.shopDomain, which
 * shop-context turns into req.shopId.
 *
 * Session tokens live one minute and App Bridge mints a fresh one per request,
 * so an expired token is normal, not an attack. The documented contract is to
 * answer XHR with 401 plus X-Shopify-Retry-Invalid-Session-Request: 1, which
 * tells App Bridge to fetch a new token and retry.
 */
async function shopifyAuth(req, res, next) {
  if (!isConfigured()) return next();

  const token = extractSessionToken(req);
  if (!token) return next(); // fall through to legacy JWT auth

  let verified;
  try {
    verified = verifySessionToken(token);
  } catch (error) {
    // A malformed token is not ours to interpret - it might be a legacy app JWT.
    if (error.name === 'JsonWebTokenError') return next();

    if (error.name === 'TokenExpiredError') {
      res.setHeader('X-Shopify-Retry-Invalid-Session-Request', '1');
      return res.status(401).json({ error: 'Session token expired' });
    }
    console.warn('Rejected Shopify session token:', error.message);
    return res.status(401).json({ error: 'Invalid session token' });
  }

  req.shopDomain = verified.shopDomain;
  req.shopifyUserId = verified.userId;
  req.isShopifyRequest = true;

  // Managed installation means there is no OAuth callback to hang this off, so
  // the first authenticated request is where the offline token gets minted.
  try {
    const shop = await getShopByDomain(verified.shopDomain);
    if (!shop || !shop.access_token || shop.uninstalled_at) {
      const exchanged = await exchangeToken(verified.shopDomain, token);
      await upsertShop({
        domain: verified.shopDomain,
        accessToken: exchanged.accessToken,
        scopes: exchanged.scopes,
        expiresIn: exchanged.expiresIn,
        refreshToken: exchanged.refreshToken,
        refreshTokenExpiresIn: exchanged.refreshTokenExpiresIn,
      });
      console.log(`Stored offline access token for ${verified.shopDomain}`);
    }
  } catch (error) {
    // Don't fail the request: the app is useful without an Admin API token,
    // because everything it needs arrives by webhook.
    console.error(`Token exchange failed for ${verified.shopDomain}:`, error.message);
  }

  next();
}

module.exports = shopifyAuth;
