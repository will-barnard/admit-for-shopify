/*
 * Tests for src/shopify.js — the App Bridge glue.
 *
 * App Bridge itself can only run inside the Shopify admin, so `window.shopify`
 * is stubbed here. What is actually under test is the part that breaks
 * silently: axios uses XMLHttpRequest, so it is NOT covered by App Bridge's
 * fetch patch, and without our own interceptor every embedded API call would
 * go out unauthenticated.
 *
 * Run: npm run test:shopify
 */

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${detail}`); }
};

// --- stub the browser before importing anything ---
let issuedTokens = 0;
let idTokenImpl = async () => { issuedTokens += 1; return `token-${issuedTokens}`; };

const stubWindow = (withShopify, framed = true) => {
  const w = {
    location: { href: 'https://tickets.example.com/', origin: 'https://tickets.example.com' },
    ...(withShopify
      ? { shopify: { config: { shop: 'test-shop.myshopify.com' }, idToken: (...a) => idTokenImpl(...a) } }
      : {}),
  };
  w.self = w;
  w.top = framed ? { __other: true } : w;
  globalThis.window = w;
};
stubWindow(true);
globalThis.document = { documentElement: { classList: { add() {} } } };

const axios = (await import('axios')).default;
const { isEmbedded, shopDomain, getSessionToken, installAxiosInterceptors } =
  await import('../src/shopify.js');

console.log('\n1. embedded detection');
check('embedded: framed AND App Bridge present', isEmbedded() === true);

// The lockout case: App Bridge loaded, but we are top-level. If this reported
// embedded, the router would skip the login page and every request would fail
// with no way back to the login form.
stubWindow(true, false);
check('NOT embedded when App Bridge is present but we are top-level', isEmbedded() === false);

stubWindow(false, true);
check('NOT embedded when framed but App Bridge is absent', isEmbedded() === false);

stubWindow(true, true);
check('reads the shop domain', shopDomain() === 'test-shop.myshopify.com', shopDomain());

console.log('\n2. session tokens');
const t = await getSessionToken();
check('returns a token', typeof t === 'string' && t.startsWith('token-'), String(t));

const before = issuedTokens;
await getSessionToken();
await getSessionToken();
check('fetches a FRESH token each time (they last 60s, caching would break)',
  issuedTokens === before + 2, `issued ${issuedTokens - before}`);

idTokenImpl = async () => { throw new Error('App Bridge exploded'); };
check('returns null instead of throwing when App Bridge fails',
  (await getSessionToken()) === null);
idTokenImpl = async () => { issuedTokens += 1; return `token-${issuedTokens}`; };

console.log('\n3. axios request interceptor');
installAxiosInterceptors();
const handlers = axios.interceptors.request.handlers.filter(Boolean);
check('a request interceptor was installed', handlers.length >= 1, `${handlers.length}`);

const cfg = await handlers[handlers.length - 1].fulfilled({ url: '/api/tickets', headers: {} });
check('sets an Authorization bearer header',
  /^Bearer token-\d+$/.test(cfg.headers.Authorization || ''), cfg.headers.Authorization);

const cfg2 = await handlers[handlers.length - 1].fulfilled({ url: '/api/events', headers: {} });
check('uses a different token on the next request',
  cfg2.headers.Authorization !== cfg.headers.Authorization,
  `${cfg.headers.Authorization} vs ${cfg2.headers.Authorization}`);

console.log('\n4. standalone mode is untouched');
stubWindow(false, false); // standalone: no App Bridge, top-level
check('isEmbedded false without window.shopify', isEmbedded() === false);
check('shopDomain null', shopDomain() === null);
check('getSessionToken null', (await getSessionToken()) === null);

const cfg3 = await handlers[handlers.length - 1].fulfilled({ url: '/api/tickets', headers: {} });
check('interceptor adds no header when not embedded',
  cfg3.headers.Authorization === undefined, String(cfg3.headers.Authorization));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
