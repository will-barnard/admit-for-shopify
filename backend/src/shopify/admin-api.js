/**
 * Admin GraphQL client.
 *
 * config.js used to note that this app makes essentially no Admin API calls, so
 * the primitives were hand-rolled rather than pulled from @shopify/shopify-api.
 * Publishing events to the storefront changes that: the app now writes to the
 * merchant's catalogue, which is a different level of trust and a different
 * failure surface. This is still deliberately small, but it is the one place
 * that talks to the Admin API, so the awkward parts live here rather than
 * scattered through callers.
 *
 * The awkward parts:
 *
 *   Throttling. Shopify's GraphQL API is cost-based, not request-based. Going
 *   over returns 200 with a THROTTLED error in the body rather than a 429, so a
 *   naive client sees "success" with no data. Retried with backoff, using the
 *   restore rate Shopify reports rather than a guess.
 *
 *   userErrors. A mutation can succeed at the transport level and still refuse
 *   to do anything, reporting why in userErrors. Silently ignoring that field
 *   is the single most common way an integration appears to work and does not.
 *   assertNoUserErrors makes it loud.
 *
 * REST is legacy - do not add a REST path.
 */

const axios = require('axios');
const db = require('../config/database');
const { config, isValidShopDomain } = require('./config');

const MAX_ATTEMPTS = Number(process.env.SHOPIFY_ADMIN_RETRIES ?? 3);
const TIMEOUT_MS = Number(process.env.SHOPIFY_ADMIN_TIMEOUT_MS ?? 15000);

class AdminApiError extends Error {
  constructor(message, { userErrors = [], graphqlErrors = [], status = null } = {}) {
    super(message);
    this.name = 'AdminApiError';
    this.userErrors = userErrors;
    this.graphqlErrors = graphqlErrors;
    this.status = status;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Injectable for tests: no test should reach the network, and stubbing global
 * fetch/axios wholesale would hide real mistakes in how the request is formed.
 */
let transport = async (url, body, headers) => {
  const response = await axios.post(url, body, { headers, timeout: TIMEOUT_MS, validateStatus: () => true });
  return { status: response.status, data: response.data };
};

function setTransport(fn) { transport = fn; }

function isThrottled(payload) {
  return (payload?.errors || []).some(
    (e) => e?.extensions?.code === 'THROTTLED' || /throttl/i.test(e?.message || '')
  );
}

async function adminGraphql(shopDomain, accessToken, query, variables = {}) {
  if (!isValidShopDomain(shopDomain)) throw new AdminApiError(`Invalid shop domain: ${shopDomain}`);
  if (!accessToken) throw new AdminApiError(`No Admin API access token stored for ${shopDomain}`);

  const url = `https://${shopDomain}/admin/api/${config.apiVersion}/graphql.json`;
  const headers = { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' };

  let lastPayload = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const { status, data } = await transport(url, { query, variables }, headers);
    lastPayload = data;

    if (status === 429 || isThrottled(data)) {
      if (attempt === MAX_ATTEMPTS) break;
      // Wait long enough for the leaky bucket to refill, using the rate Shopify
      // reports rather than a fixed guess.
      const cost = data?.extensions?.cost;
      const restore = cost?.throttleStatus?.restoreRate || 50;
      const needed = Math.max(0, (cost?.requestedQueryCost || 0) - (cost?.throttleStatus?.currentlyAvailable || 0));
      await sleep(Math.min(5000, Math.max(500, Math.ceil((needed / restore) * 1000)) * attempt));
      continue;
    }

    if (status >= 400) {
      throw new AdminApiError(`Admin API HTTP ${status}`, { status, graphqlErrors: data?.errors || [] });
    }
    if (data?.errors?.length) {
      throw new AdminApiError(`Admin API error: ${JSON.stringify(data.errors)}`, { graphqlErrors: data.errors });
    }
    return data?.data;
  }

  throw new AdminApiError('Admin API stayed throttled after retries', { graphqlErrors: lastPayload?.errors || [] });
}

/**
 * A mutation that "succeeded" but refused to act reports why here. Never skip.
 */
function assertNoUserErrors(result, label) {
  const userErrors = result?.userErrors || [];
  if (userErrors.length > 0) {
    const detail = userErrors
      .map((e) => `${(e.field || []).join('.') || 'general'}: ${e.message}`)
      .join('; ');
    throw new AdminApiError(`${label} refused: ${detail}`, { userErrors });
  }
  return result;
}

/** Run a query as a given shop, looking up its stored offline token. */
async function forShop(shopId, query, variables) {
  // tenancy-ok: `shops` is the tenant table itself, keyed by its own id.
  const result = await db.query('SELECT domain, access_token, uninstalled_at FROM shops WHERE id = $1', [shopId]);
  const shop = result.rows[0];
  if (!shop) throw new AdminApiError(`Unknown shop ${shopId}`);
  if (shop.uninstalled_at) throw new AdminApiError(`App is uninstalled from ${shop.domain}`);
  return adminGraphql(shop.domain, shop.access_token, query, variables);
}

const gid = {
  toNumeric(value) {
    if (value == null) return null;
    const tail = String(value).split('/').pop();
    return /^\d+$/.test(tail) ? tail : null;
  },
};

module.exports = { adminGraphql, assertNoUserErrors, forShop, setTransport, AdminApiError, gid };
