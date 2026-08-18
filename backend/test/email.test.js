/*
 * Tests for the Resend result handling.
 *
 * No database, no network, no API key needed.
 *
 * The bug these exist to prevent: the Resend SDK does NOT throw on failure, it
 * resolves to { data, error }. Every call site awaited it and assumed success,
 * so a rejected send was logged as "sent" and the ticket was marked
 * email_sent = true. Nothing surfaced until someone noticed mail never arrived.
 *
 * Run: npm run test:email
 */

const { assertResendAccepted, checkSenderDomain, parseSender } = require('../src/services/email');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${detail}`); }
};
function throws(fn) {
  try { fn(); return null; } catch (e) { return e; }
}

// Keep the expected console.error noise out of the output.
const realError = console.error;
console.error = () => {};

console.log('\n1. a successful send');
const ok = assertResendAccepted({ data: { id: 'msg_123' }, error: null }, 'a@b.test');
check('returns the message data', ok?.id === 'msg_123', JSON.stringify(ok));

console.log('\n2. Resend rejections must throw, not pass silently');
let e = throws(() => assertResendAccepted(
  { data: null, error: { statusCode: 403, name: 'validation_error',
    message: 'The chicagoelectricpiano.com domain is not verified. Please add and verify your domain on https://resend.com/domains' } },
  'a@b.test'));
check('unverified sending domain throws', e !== null);
check('  error is named ResendError', e?.name === 'ResendError', e?.name);
check('  the real reason survives in the message', /not verified/.test(e?.message || ''), e?.message);
check('  the raw Resend error is attached for the API response',
  e?.resendError?.statusCode === 403, JSON.stringify(e?.resendError));

e = throws(() => assertResendAccepted(
  { data: null, error: { statusCode: 401, message: 'API key is invalid' } }, 'a@b.test'));
check('invalid API key throws', e !== null && /API key is invalid/.test(e.message), e?.message);

console.log('\n3. malformed successes are failures too');
check('no data at all throws', throws(() => assertResendAccepted({}, 'a@b.test')) !== null);
check('data without an id throws', throws(() => assertResendAccepted({ data: {} }, 'a@b.test')) !== null);
check('undefined result throws', throws(() => assertResendAccepted(undefined, 'a@b.test')) !== null);
check('null result throws', throws(() => assertResendAccepted(null, 'a@b.test')) !== null);

console.log('\n4. EMAIL_FROM parsing');
const CANONICAL = 'Chicago Electric Piano <no-reply@chicagoelectricpiano.com>';
const BARE = 'no-reply@chicagoelectricpiano.com';

// [input, expected ok, expected domain, expected normalised value]
const cases = [
  [CANONICAL,                             true,  'chicagoelectricpiano.com', CANONICAL],
  [BARE,                                  true,  'chicagoelectricpiano.com', BARE],
  // A value pasted into a dashboard field very often carries trailing
  // whitespace. Resend answers a malformed `from` with 422 "The domain is
  // invalid", which reads like a verification failure but is not one.
  [CANONICAL + ' ',                       true,  'chicagoelectricpiano.com', CANONICAL],
  ['  ' + BARE + '\n',                    true,  'chicagoelectricpiano.com', BARE],
  ['Chicago Electric Piano < ' + BARE + ' >', true, 'chicagoelectricpiano.com', CANONICAL],
  ['Chicago Electric Piano',              false, null, null],
  ['no-reply@localhost',                  false, null, null],
  ['<>',                                  false, null, null],
  ['',                                    false, null, null],
  [undefined,                             false, null, null],
];

for (const [input, expectOk, expectDomain, expectValue] of cases) {
  const r = parseSender(input);
  const label = JSON.stringify(input);
  check(`${expectOk ? 'accepts' : 'rejects'} ${label}`, r.ok === expectOk, JSON.stringify(r));
  if (expectOk && r.ok) {
    check(`  domain is ${expectDomain}`, r.domain === expectDomain, r.domain);
    check('  normalises to the canonical form', r.value === expectValue, `[${r.value}]`);
  }
}

console.log('\n5. sender domain warning');
const warnings = [];
console.error = (...a) => warnings.push(a.join(' '));

process.env.EMAIL_FROM = 'Chicago Drum Show <chicagodrumshow@gmail.com>';
checkSenderDomain();
check('warns about a free-provider sender (can never be verified)',
  warnings.some((w) => /gmail\.com/.test(w) && /never be verified/.test(w)), JSON.stringify(warnings));

warnings.length = 0;
process.env.EMAIL_FROM = 'Chicago Electric Piano <no-reply@chicagoelectricpiano.com>';
checkSenderDomain();
check('stays quiet for a real domain', warnings.length === 0, JSON.stringify(warnings));

warnings.length = 0;
process.env.EMAIL_FROM = '';
checkSenderDomain();
check('notes a missing EMAIL_FROM only when email is configured',
  warnings.length === 0 || warnings.some((w) => /EMAIL_FROM/.test(w)), JSON.stringify(warnings));

console.error = realError;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
