const axios = require('axios');
const { config, isValidShopDomain } = require('./config');

const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ID_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id_token';
const OFFLINE_TOKEN_TYPE = 'urn:shopify:params:oauth:token-type:offline-access-token';
const ONLINE_TOKEN_TYPE = 'urn:shopify:params:oauth:token-type:online-access-token';

/**
 * Trade a session token for an Admin API access token.
 *
 * This is the modern replacement for the OAuth authorization code grant. With
 * Shopify managed installation (scopes declared in shopify.app.toml) there is
 * no redirect dance to implement - the first request from an embedded app
 * arrives with a session token, and this turns it into a usable credential.
 *
 * `expiring` is false here because this is a CUSTOM distribution app. Public
 * apps created on or after 2026-04-01 MUST request expiring offline tokens and
 * handle 90-day refresh rotation; if this app ever goes public, that changes.
 */
async function exchangeToken(shopDomain, sessionToken, { online = false, expiring = false } = {}) {
  if (!isValidShopDomain(shopDomain)) throw new Error(`Invalid shop domain: ${shopDomain}`);
  if (!sessionToken) throw new Error('No session token to exchange');

  const response = await axios.post(
    `https://${shopDomain}/admin/oauth/access_token`,
    {
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: TOKEN_EXCHANGE_GRANT,
      subject_token: sessionToken,
      subject_token_type: ID_TOKEN_TYPE,
      requested_token_type: online ? ONLINE_TOKEN_TYPE : OFFLINE_TOKEN_TYPE,
      expiring: expiring ? 1 : 0,
    },
    { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
  );

  const data = response.data || {};
  if (!data.access_token) throw new Error('Token exchange returned no access_token');

  return {
    accessToken: data.access_token,
    scopes: data.scope || null,
    expiresIn: data.expires_in ?? null,
    refreshToken: data.refresh_token || null,
    refreshTokenExpiresIn: data.refresh_token_expires_in ?? null,
  };
}

/** Minimal Admin GraphQL client. REST is legacy; do not add a REST path. */
async function adminGraphql(shopDomain, accessToken, query, variables = {}) {
  if (!isValidShopDomain(shopDomain)) throw new Error(`Invalid shop domain: ${shopDomain}`);

  const response = await axios.post(
    `https://${shopDomain}/admin/api/${config.apiVersion}/graphql.json`,
    { query, variables },
    { headers: { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' }, timeout: 15000 }
  );

  if (response.data?.errors?.length) {
    throw new Error(`Admin API error: ${JSON.stringify(response.data.errors)}`);
  }
  return response.data?.data;
}

module.exports = { exchangeToken, adminGraphql };
