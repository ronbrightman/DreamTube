// test/check-email.test.js
//
// Covers netlify/functions/check-email.js -- the cheap, rate-limited
// "is this email already registered" check added to close the money-leak
// in wizard.html's/start.html's "generate during signup" funnel (tracker
// item for-product-money-leak-blocked-signups-e-v2g1vi): both funnels
// used to fire a real, billed start-pending-generation.js call in
// parallel with signup, so a blocked signup (email already taken,
// discovered only later) had already spent real money on a dream nobody
// would ever own. This endpoint lets both funnels check BEFORE firing
// that generation. See test/wizard-ui-behavioral.test.js/
// test/funnel-signup-navigation-token-guard-behavioral.test.js for the
// browser-driven coverage of the funnels actually calling this.
//
// Same conventions as test/account-store.test.js: mock-blobs, fakeEvent.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');

var ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return '10.3.0.' + ipCounter;
}

test.beforeEach(function () {
  mockBlobs.reset();
  delete process.env.MAX_CHECK_EMAIL_PER_IP_PER_DAY;
  delete require.cache[require.resolve('../netlify/functions/check-email')];
  delete require.cache[require.resolve('../netlify/functions/register-account')];
  delete require.cache[require.resolve('../netlify/functions/lib/account-store')];
});

test('check-email: rejects non-POST with E1', async function () {
  var handler = require('../netlify/functions/check-email').handler;
  var res = await handler(fakeEvent({ method: 'GET' }));
  assert.equal(res.statusCode, 405);
  assert.match(JSON.parse(res.body).error, /^E1: method_not_allowed/);
});

test('check-email: invalid JSON body is rejected with E2', async function () {
  var handler = require('../netlify/functions/check-email').handler;
  var res = await handler({ httpMethod: 'POST', headers: {}, body: '{not json' });
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E2: invalid_json/);
});

test('check-email: missing/blank email is rejected with E3', async function () {
  var handler = require('../netlify/functions/check-email').handler;
  var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: {} }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E3: email_required/);

  var blank = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { email: '   ' } }));
  assert.equal(blank.statusCode, 400);
  assert.match(JSON.parse(blank.body).error, /^E3: email_required/);
});

test('check-email: returns available:true for an email with no account', async function () {
  var handler = require('../netlify/functions/check-email').handler;
  var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { email: 'nobody-here@example.com' } }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.available, true);
});

test('check-email: returns available:false for an email that already has an account, and never exposes anything beyond ok/available', async function () {
  var accountStore = require('../netlify/functions/lib/account-store');
  var event = fakeEvent({ method: 'POST', ip: nextIp() });
  var created = await accountStore.createAccount(event, { username: 'existinguser', password: 'longenoughpw1', email: 'taken@example.com' });
  assert.equal(created.ok, true);

  var handler = require('../netlify/functions/check-email').handler;
  var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { email: 'taken@example.com' } }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.available, false);
  assert.deepEqual(Object.keys(body).sort(), ['available', 'ok'], 'response must be enumeration-safe -- ok/available only, no username or other account details');
});

test('check-email: normalizes email the same way register-account.js/entitlements.js do (trim + lowercase) -- same address, different case/whitespace, still resolves as taken', async function () {
  var accountStore = require('../netlify/functions/lib/account-store');
  var event = fakeEvent({ method: 'POST', ip: nextIp() });
  await accountStore.createAccount(event, { username: 'caseuser', password: 'longenoughpw1', email: 'Case-Test@Example.com' });

  var handler = require('../netlify/functions/check-email').handler;
  var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { email: '  case-test@example.com  ' } }));
  var body = JSON.parse(res.body);
  assert.equal(body.available, false, 'differently-cased/whitespace-padded re-check of the same email must still resolve as taken');
});

test('check-email: reflects register-account.js\'s own authoritative email_taken decision -- an email created via the real signup endpoint is reported unavailable here', async function () {
  var registerHandler = require('../netlify/functions/register-account').handler;
  var reg = await registerHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { username: 'realuser1', password: 'longenoughpw1', email: 'realuser1@example.com' } }));
  assert.equal(JSON.parse(reg.body).ok, true);

  var checkHandler = require('../netlify/functions/check-email').handler;
  var res = await checkHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { email: 'realuser1@example.com' } }));
  assert.equal(JSON.parse(res.body).available, false);

  var resOther = await checkHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { email: 'realuser1-plus-tag@example.com' } }));
  assert.equal(JSON.parse(resOther.body).available, true, 'a genuinely different, never-registered email must still report available');
});

test('check-email: exceeding MAX_CHECK_EMAIL_PER_IP_PER_DAY is rejected with E4 rate_limited (429, ok:false), independent of whether the email is taken', async function () {
  process.env.MAX_CHECK_EMAIL_PER_IP_PER_DAY = '1';
  var handler = require('../netlify/functions/check-email').handler;
  var ip = nextIp();

  var first = await handler(fakeEvent({ method: 'POST', ip: ip, body: { email: 'quota-first@example.com' } }));
  assert.equal(first.statusCode, 200);

  var second = await handler(fakeEvent({ method: 'POST', ip: ip, body: { email: 'quota-second@example.com' } }));
  assert.equal(second.statusCode, 429);
  var body = JSON.parse(second.body);
  assert.equal(body.ok, false);
  assert.match(body.error, /^E4: rate_limited/);
});

test('check-email: the per-IP rate limit is scoped independently of register-account.js\'s own bucket -- exhausting one does not exhaust the other', async function () {
  process.env.MAX_CHECK_EMAIL_PER_IP_PER_DAY = '1';
  var checkHandler = require('../netlify/functions/check-email').handler;
  var registerHandler = require('../netlify/functions/register-account').handler;
  var ip = nextIp();

  await checkHandler(fakeEvent({ method: 'POST', ip: ip, body: { email: 'scope-test@example.com' } }));
  var secondCheck = await checkHandler(fakeEvent({ method: 'POST', ip: ip, body: { email: 'scope-test-2@example.com' } }));
  assert.equal(secondCheck.statusCode, 429, 'check-email\'s own bucket should now be exhausted');

  var reg = await registerHandler(fakeEvent({ method: 'POST', ip: ip, body: { username: 'scopetestuser', password: 'longenoughpw1', email: 'scope-test-3@example.com' } }));
  assert.equal(reg.statusCode, 200, 'register-account.js must still work from the same IP -- separate rate-limit scope key');
  assert.equal(JSON.parse(reg.body).ok, true);
});
