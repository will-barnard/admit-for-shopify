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
 * App Bridge is loaded by a script tag in index.html and exposes `shopify` on
 * window. Its presence is the signal that we are embedded - checking for an
 * iframe is not enough, since the app could be framed by something else.
 */
export function isEmbedded() {
  return typeof window !== 'undefined' && typeof window.shopify !== 'undefined';
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
