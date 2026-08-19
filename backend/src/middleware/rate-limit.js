const rateLimit = require('express-rate-limit');

/**
 * Rate limits for the unauthenticated login endpoints.
 *
 * Two limiters, because they defend against different things and fail
 * differently if the proxy chain is misconfigured:
 *
 *   loginAttemptLimiter - keyed on IP *and* the username being tried. This is
 *     the credential brute-force defence, and it keeps working even when every
 *     request appears to come from one IP (see trust proxy below), because the
 *     username half still separates the buckets. successful logins are not
 *     counted, so normal use never accumulates.
 *
 *   authRouteLimiter - a coarse per-IP cap on the whole auth router. Each
 *     attempt runs a bcrypt comparison, which is deliberately expensive, so an
 *     unbounded endpoint is also a CPU exhaustion vector. Kept generous: this
 *     is the one that would over-block if X-Forwarded-For were wrong.
 *
 * A note on IPs: behind nginx, req.ip is the proxy's address unless Express is
 * told how many proxies to trust. server.js sets that from TRUST_PROXY_HOPS.
 * Get it wrong in the permissive direction and a client can spoof its own
 * X-Forwarded-For to dodge the limit; get it wrong in the strict direction and
 * everyone shares one bucket. Hence the username-keyed limiter above, which
 * does not care either way.
 */

const FIFTEEN_MINUTES = 15 * 60 * 1000;

const loginAttemptLimiter = rateLimit({
  windowMs: FIFTEEN_MINUTES,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => {
    const username = String(req.body?.username || '').trim().toLowerCase();
    return `${req.ip}|${username}`;
  },
  message: { error: 'Too many sign-in attempts. Try again in 15 minutes.' },
});

const authRouteLimiter = rateLimit({
  windowMs: FIFTEEN_MINUTES,
  limit: 100,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests. Try again shortly.' },
});

/**
 * The public ticket lookup. A ticket UUID is a v4 - 122 bits - so guessing one
 * is not a realistic attack, but the endpoint is unauthenticated and hits the
 * database, so it should not be free to hammer. Generous: a family opening
 * five tickets from one phone must not be blocked.
 */
const publicTicketLimiter = rateLimit({
  windowMs: FIFTEEN_MINUTES,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests. Try again shortly.' },
});

module.exports = { loginAttemptLimiter, authRouteLimiter, publicTicketLimiter };
