const crypto = require('crypto');
const { config } = require('./config');

/**
 * Verify the X-Shopify-Hmac-Sha256 header on a webhook delivery.
 *
 * Must be given the RAW request body. Once express.json() has parsed and
 * re-serialised it, key order and whitespace can differ and the digest will not
 * match - which is why the Shopify webhook router is mounted with express.raw()
 * before the global JSON parser in server.js.
 */
function verifyWebhookHmac(rawBody, headerValue, secret = config.clientSecret) {
  if (!secret || !headerValue || !rawBody) return false;

  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');

  const a = Buffer.from(digest, 'utf8');
  const b = Buffer.from(String(headerValue), 'utf8');
  // timingSafeEqual throws on length mismatch, so check that first - but compare
  // anyway so a wrong-length header does not return measurably faster.
  if (a.length !== b.length) {
    crypto.timingSafeEqual(a, a);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

/**
 * Verify the `hmac` query parameter used by the legacy authorization code grant
 * and by app proxy requests. Digest is over the sorted query string, hex, with
 * the hmac/signature parameter itself removed.
 */
function verifyQueryHmac(query, secret = config.clientSecret) {
  if (!secret || !query) return false;
  const provided = query.hmac || query.signature;
  if (!provided) return false;

  const message = Object.keys(query)
    .filter((k) => k !== 'hmac' && k !== 'signature')
    .sort()
    .map((k) => `${k}=${Array.isArray(query[k]) ? query[k].join(',') : query[k]}`)
    .join('&');

  const digest = crypto.createHmac('sha256', secret).update(message).digest('hex');
  const a = Buffer.from(digest, 'utf8');
  const b = Buffer.from(String(provided), 'utf8');
  if (a.length !== b.length) {
    crypto.timingSafeEqual(a, a);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

module.exports = { verifyWebhookHmac, verifyQueryHmac };
