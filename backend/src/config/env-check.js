/**
 * Report the environment at startup.
 *
 * A variable that silently arrives empty is one of the hardest failures to
 * diagnose in a container: the app boots, most things work, and one feature is
 * quietly broken with no error until someone exercises it. EMAIL_FROM did
 * exactly that in production.
 *
 * Values are never printed - only whether each key is set, and its length.
 */

const SPEC = [
  { key: 'DATABASE_URL', required: true, note: 'built from DB_PASSWORD in docker-compose.yml' },
  { key: 'JWT_SECRET', required: true, note: 'legacy login will fail without it' },
  { key: 'FRONTEND_URL', required: true, note: 'baked into every QR code at creation time' },

  { key: 'RESEND_API_KEY', required: false, note: 'unset disables all email' },
  { key: 'EMAIL_FROM', required: false, note: 'required if RESEND_API_KEY is set', requiredWith: 'RESEND_API_KEY' },
  { key: 'ADMIN_EMAIL', required: false, note: 'admin alerts go nowhere without it' },

  { key: 'DEFAULT_SHOP_DOMAIN', required: false, note: "defaults to 'legacy.local'; must match a row in shops" },

  { key: 'SHOPIFY_APP_CLIENT_ID', required: false, note: 'Shopify integration dormant without it' },
  { key: 'SHOPIFY_APP_CLIENT_SECRET', required: false, note: 'webhook HMAC + session tokens', requiredWith: 'SHOPIFY_APP_CLIENT_ID' },
  { key: 'SHOPIFY_APP_URL', required: false },
  { key: 'SHOPIFY_API_VERSION', required: false, note: "defaults to '2026-07'" },
  { key: 'SHOPIFY_SCOPES', required: false, note: "defaults to 'read_orders'" },
  { key: 'SHOPIFY_API_KEY', required: false, note: 'legacy Shopify Flow shared secret' },

  { key: 'TRUST_PROXY_HOPS', required: false, note: "defaults to '2'; wrong value breaks login rate limiting by IP" },
  { key: 'BULK_EMAIL_INTERVAL_MS', required: false, note: "defaults to '6000' between bulk messages" },
  { key: 'EMAIL_DAILY_LIMIT', required: false, note: "defaults to '100' successful sends per shop per day" },
];

function reportEnvironment() {
  const problems = [];
  const lines = [];

  for (const { key, required, note, requiredWith } of SPEC) {
    const raw = process.env[key];
    const isSet = raw !== undefined && raw !== '';
    const needed = required || (requiredWith && process.env[requiredWith]);

    if (isSet) {
      const trimmed = raw.trim();
      let flag = '';
      if (trimmed !== raw) flag = '  <-- has leading/trailing whitespace';
      if (trimmed === 'change-me') flag = '  <-- still the placeholder value';
      lines.push(`  set     ${key}  (${raw.length} chars)${flag}`);
    } else if (needed) {
      const why = raw === '' ? 'present but EMPTY' : 'not set';
      problems.push(`${key} is ${why}${note ? ` - ${note}` : ''}`);
      lines.push(`  MISSING ${key}  (${why})`);
    } else {
      lines.push(`  unset   ${key}${note ? `  - ${note}` : ''}`);
    }
  }

  console.log('Environment:');
  lines.forEach((l) => console.log(l));

  if (problems.length) {
    console.error('\nEnvironment problems:');
    problems.forEach((p) => console.error(`  ${p}`));
    console.error(
      '\nOn Beachhead these must be set as GLOBAL variables (no Target Service). ' +
      'A variable that is empty rather than absent usually means it was declared ' +
      'in docker-compose.yml as ${VAR} but never written to .env.\n'
    );
  }

  return problems;
}

module.exports = { reportEnvironment, SPEC };
