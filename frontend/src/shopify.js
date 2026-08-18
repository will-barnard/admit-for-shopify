/**
 * Shopify App Bridge integration for the admin SPA.
 *
 * When this app is opened from the Shopify admin it runs embedded in an iframe.
 * In that mode there is no login page: identity comes from a session token that
 * App Bridge mints per request, and the backend verifies it
 * (middleware/shopify-auth.js). When opened directly it falls back to the
 * app's own username/password login, so both work while the two overlap.
 */

import axios from 'axios';

/**
 * Are we actually running inside the Shopify admin?
 *
 * Requires BOTH conditions, and that matters:
 *
 *   - framed: the Shopify admin renders the app in an iframe. Opened directly
 *     in a tab we are top-level.
 *   - window.shopify: App Bridge has loaded.
 *
 * Checking only for window.shopify was a bug. The App Bridge script is served
 * whenever a client id is configured, so if it defines its global on a
 * top-level page too, the app would decide it was embedded, skip the login page
 * entirely, and then fail every request because there is no real Shopify
 * session - locking you out with no way back to the login form.
 *
 * Reading window.top cross-origin throws, and that throw only happens when we
 * ARE framed by another origin, so treat it as framed.
 */
export function isEmbedded() {
  if (typeof window === 'undefined') return false;

  let framed;
  try {
    framed = window.top !== window.self;
  } catch {
    framed = true;
  }

  return framed && typeof window.shopify !== 'undefined';
}

export function shopDomain() {
  try {
    return window.shopify?.config?.shop || null;
  } catch {
    return null;
  }
}

/**
 * Session tokens live ONE MINUTE, so there is nothing to cache - fetch a fresh
 * one per request. `shopify.idToken()` handles that.
 */
export async function getSessionToken() {
  if (!isEmbedded()) return null;
  try {
    return await window.shopify.idToken();
  } catch (error) {
    console.error('Could not get a Shopify session token:', error);
    return null;
  }
}

/**
 * Attach the session token to outgoing requests.
 *
 * App Bridge patches window.fetch to do this automatically, but axios uses
 * XMLHttpRequest, so it is NOT covered by that patch. Without this interceptor
 * every API call from the embedded app would arrive unauthenticated.
 */
export function installAxiosInterceptors() {
  if (!isEmbedded()) return;

  axios.interceptors.request.use(async (config) => {
    const token = await getSessionToken();
    if (token) {
      config.headers = config.headers || {};
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  });

  // A 401 carrying this header means the token went stale between minting and
  // arrival. The documented contract is to retry once with a fresh token.
  axios.interceptors.response.use(
    (response) => response,
    async (error) => {
      const retryable = error.response?.headers?.['x-shopify-retry-invalid-session-request'];
      if (retryable && !error.config?.__shopifyRetried) {
        const token = await getSessionToken();
        if (token) {
          error.config.__shopifyRetried = true;
          error.config.headers.Authorization = `Bearer ${token}`;
          return axios.request(error.config);
        }
      }
      return Promise.reject(error);
    }
  );
}
