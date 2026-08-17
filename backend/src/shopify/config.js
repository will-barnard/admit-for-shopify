/**
 * Shopify app configuration.
 *
 * Distribution: CUSTOM (single store). This choice is irreversible on the app
 * record - a custom app cannot become a public App Store app later. Going
 * public means creating a second app record that shares this codebase, which is
 * why everything here is written per-shop rather than assuming one merchant.
 *
 * What custom distribution buys us, and what it costs:
 *   + Level 1 and Level 2 protected customer data with no review
 *   + no App Store review, no mandatory compliance webhooks
 *   + non-expiring offline access tokens (public apps created on or after
 *     2026-04-01 must use expiring tokens with 90-day refresh rotation)
 *   - no Billing API, so merchants cannot be charged through Shopify
 *
 * These primitives are hand-rolled rather than pulled from @shopify/shopify-api
 * because this app makes essentially no Admin API calls - it receives webhooks
 * and renders an embedded admin. That is three small, well-specified things
 * (HMAC verification, session-token verification, token exchange), all covered
 * by tests. If Admin API usage grows, reconsider.
 */

const REQUIRED = ['SHOPIFY_APP_CLIENT_ID', 'SHOPIFY_APP_CLIENT_SECRET'];

const config = {
  clientId: process.env.SHOPIFY_APP_CLIENT_ID || '',
  clientSecret: process.env.SHOPIFY_APP_CLIENT_SECRET || '',
  // Keep in step with [webhooks] api_version in shopify.app.toml.
  apiVersion: process.env.SHOPIFY_API_VERSION || '2026-07',
  scopes: (process.env.SHOPIFY_SCOPES || 'read_orders').split(',').map((s) => s.trim()).filter(Boolean),
  appUrl: process.env.SHOPIFY_APP_URL || process.env.FRONTEND_URL || '',
};

/** Is the Shopify integration configured at all? Lets the app boot without it. */
function isConfigured() {
  return Boolean(config.clientId && config.clientSecret);
}

function assertConfigured() {
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`Shopify app is not configured. Missing: ${missing.join(', ')}`);
  }
}

const SHOP_DOMAIN_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/;

/** Never build a URL from an unvalidated shop value - it is attacker-supplied. */
function isValidShopDomain(domain) {
  return typeof domain === 'string' && domain.length <= 255 && SHOP_DOMAIN_RE.test(domain);
}

module.exports = { config, isConfigured, assertConfigured, isValidShopDomain };
