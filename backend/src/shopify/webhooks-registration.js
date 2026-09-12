/**
 * Register this app's webhook subscriptions with Shopify, for every shop that
 * currently holds a valid offline access token.
 *
 * Exists because [webhooks] in shopify.app.toml is a MANAGED config: Shopify
 * only creates those subscriptions once `shopify app deploy` has pushed this
 * file to the app record. This project doesn't use the Shopify CLI (see the
 * commit that dropped the theme extension for why), so that push never
 * happened - chicagoelectricpiano.com installed cleanly, read_orders scope and
 * all, and Shopify was never told to expect an order. No webhook ever fired,
 * silently, because nothing had ever asked Shopify to send one.
 *
 * This does the equivalent registration without the CLI: it calls
 * webhookSubscriptionCreate directly, using each shop's OWN access token, so
 * the subscription is owned by this app - the HMAC on delivery is signed with
 * this app's client secret, which is what shopify/hmac.js verifies against.
 * (A subscription created with a different app's token would deliver here
 * too, but sign with that app's secret, and every delivery would fail HMAC
 * verification and eventually get auto-deleted by Shopify after repeated
 * failures - so it matters that this runs with the shop's real Admit token,
 * not some other credential.)
 *
 * Called from two places, so both existing and future installs stay covered:
 *   - on every backend boot (migrations/ensure-webhooks.js), so an already
 *     installed shop like chicagoelectricpiano.com gets fixed on next deploy
 *     without anyone running anything by hand;
 *   - right after a shop's offline token is first minted in
 *     middleware/shopify-auth.js, so a brand new install doesn't have to wait
 *     for the next deploy either.
 * Idempotent either way - it only creates what's missing.
 */

const db = require('../config/database');
const { config, isConfigured } = require('./config');
const { adminGraphql } = require('./token-exchange');

// Keep in step with [[webhooks.subscriptions]] in shopify.app.toml.
const TOPICS = ['ORDERS_CREATE', 'ORDERS_CANCELLED', 'REFUNDS_CREATE', 'DISPUTES_CREATE', 'APP_UNINSTALLED'];

const LIST_QUERY = `
  query AdmitListWebhooks {
    webhookSubscriptions(first: 50) {
      nodes { id topic uri }
    }
  }
`;

const CREATE_MUTATION = `
  mutation AdmitCreateWebhook($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
      webhookSubscription { id topic uri }
      userErrors { field message }
    }
  }
`;

/** Where Shopify should deliver to. Same endpoint for every shop - one backend, one route. */
function callbackUri() {
  const base = (config.appUrl || '').replace(/\/+$/, '');
  return base ? `${base}/api/shopify/webhooks` : null;
}

/** Create whatever subscriptions this shop is missing. Returns how many it created. */
async function ensureWebhooksForShop({ domain, access_token: accessToken }, uri) {
  const existing = await adminGraphql(domain, accessToken, LIST_QUERY, {});
  const have = new Set(
    (existing?.webhookSubscriptions?.nodes || [])
      .filter((node) => node.uri === uri)
      .map((node) => node.topic)
  );

  let created = 0;
  for (const topic of TOPICS) {
    if (have.has(topic)) continue;

    const result = await adminGraphql(domain, accessToken, CREATE_MUTATION, {
      topic,
      webhookSubscription: { uri, format: 'JSON' },
    });
    const errors = result?.webhookSubscriptionCreate?.userErrors || [];
    if (errors.length > 0) {
      console.warn(`  ${domain}: could not subscribe to ${topic}: ${errors.map((e) => e.message).join('; ')}`);
      continue;
    }
    created += 1;
    console.log(`  ${domain}: subscribed to ${topic}`);
  }
  return created;
}

/** Run for one shop. Never throws - a Shopify API hiccup here should not fail the caller. */
async function ensureWebhooksForDomain(domain) {
  if (!isConfigured()) return;
  const uri = callbackUri();
  if (!uri) {
    console.warn('SHOPIFY_APP_URL/FRONTEND_URL not set - cannot register webhooks for', domain);
    return;
  }
  try {
    const result = await db.query(
      'SELECT domain, access_token FROM shops WHERE domain = $1 AND access_token IS NOT NULL',
      [domain]
    );
    const shop = result.rows[0];
    if (!shop) return;
    const created = await ensureWebhooksForShop(shop, uri);
    if (created > 0) console.log(`${domain}: registered ${created} webhook subscription(s)`);
  } catch (error) {
    console.error(`${domain}: failed to ensure webhooks - ${error.message}`);
  }
}

/** Run for every currently installed shop. Used at boot. */
async function ensureWebhooksForAllShops() {
  if (!isConfigured()) {
    console.log('Shopify app not configured - skipping webhook registration.');
    return;
  }
  const uri = callbackUri();
  if (!uri) {
    console.warn('SHOPIFY_APP_URL/FRONTEND_URL not set - cannot register webhooks, skipping.');
    return;
  }

  const shops = (await db.query(
    'SELECT domain, access_token FROM shops WHERE uninstalled_at IS NULL AND access_token IS NOT NULL'
  )).rows;

  if (shops.length === 0) {
    console.log('No installed shops with an access token - nothing to register.');
    return;
  }

  console.log(`Ensuring Shopify webhook subscriptions for ${shops.length} shop(s) -> ${uri}`);
  for (const shop of shops) {
    try {
      const created = await ensureWebhooksForShop(shop, uri);
      if (created === 0) console.log(`  ${shop.domain}: already up to date`);
    } catch (error) {
      console.error(`  ${shop.domain}: failed to ensure webhooks - ${error.message}`);
    }
  }
}

module.exports = { ensureWebhooksForAllShops, ensureWebhooksForDomain, callbackUri, TOPICS };
