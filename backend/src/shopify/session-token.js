const jwt = require('jsonwebtoken');
const { config, isValidShopDomain } = require('./config');

/**
 * Verify a Shopify App Bridge session token (an ID token).
 *
 * These are HS256 JWTs signed with the app's client secret, and they live for
 * ONE MINUTE - App Bridge mints a fresh one per request. They authenticate the
 * browser to this backend; they are not Admin API credentials. Trade one for an
 * access token via token-exchange.js when you actually need to call Shopify.
 *
 * Claims: iss, dest, aud, sub, exp, nbf, iat, jti, sid.
 */
function verifySessionToken(token, { clockToleranceSec = 5 } = {}) {
  if (!token) throw new Error('No session token provided');
  if (!config.clientSecret) throw new Error('Shopify client secret is not configured');

  const payload = jwt.verify(token, config.clientSecret, {
    algorithms: ['HS256'],
    audience: config.clientId,
    clockTolerance: clockToleranceSec,
  });

  // `dest` is the shop this token is for. `iss` is that shop's admin URL, and
  // the two must agree - a mismatch means the token was minted for a different
  // shop than it claims.
  const dest = String(payload.dest || '');
  const shopDomain = dest.replace(/^https?:\/\//, '').replace(/\/$/, '');

  if (!isValidShopDomain(shopDomain)) {
    throw new Error(`Session token has an invalid dest claim: ${dest}`);
  }
  if (payload.iss && !String(payload.iss).includes(shopDomain)) {
    throw new Error('Session token iss and dest disagree');
  }

  return { payload, shopDomain, userId: payload.sub ? String(payload.sub) : null, sessionId: payload.sid || null };
}

/** Pull the token off a request: Authorization: Bearer <jwt>, or ?id_token= */
function extractSessionToken(req) {
  const auth = req.headers?.authorization;
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  if (req.query?.id_token) return String(req.query.id_token);
  return null;
}

module.exports = { verifySessionToken, extractSessionToken };
