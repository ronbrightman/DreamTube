// test/session-transfer.test.js
//
// Covers netlify/functions/lib/session-transfer-token.js and the two
// Netlify Functions built on it — create-session-transfer.js (mint) and
// verify-session-transfer.js (verify + consume) — the fix for tracker.html's
// for-product-bug-fix-founder-high-in-app--sv3mym item's Issue 2: opening
// a signed-in session via the host app's 3-dots-menu "open in browser"
// used to land the visitor signed OUT in the real external browser,
// because localStorage doesn't cross from an in-app webview into it.
//
// Same conventions as test/account-store.test.js: direct handler calls
// (no HTTP layer), mock-blobs for the Netlify Blobs store, fake-event for
// the Lambda-compatible event shape.
//
// SECURITY FOCUS (this is the load-bearing part of this feature — see
// create-session-transfer.js's own header comment for the full reasoning):
// minting a token requires the account's REAL password, verified the
// exact same way account-login.js verifies one — NOT a bare client-
// claimed email/username, which would let anyone mint a token that signs
// them in as any known username (every @handle is public) with zero
// authentication. The tests below exercise that boundary directly, plus
// the single-use/TTL guarantees the token itself relies on.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');

var ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return '10.9.0.' + ipCounter;
}

test.beforeEach(function () {
  mockBlobs.reset();
  delete process.env.MAX_SESSION_TRANSFER_ATTEMPTS_PER_IP_PER_DAY;
  delete process.env.MAX_SESSION_TRANSFER_ATTEMPTS_PER_IDENTIFIER_PER_DAY;
  delete require.cache[require.resolve('../netlify/functions/create-session-transfer')];
  delete require.cache[require.resolve('../netlify/functions/verify-session-transfer')];
  delete require.cache[require.resolve('../netlify/functions/lib/session-transfer-token')];
  delete require.cache[require.resolve('../netlify/functions/lib/account-store')];
  delete require.cache[require.resolve('../netlify/functions/register-account')];
});

async function registerTestAccount(overrides) {
  var registerHandler = require('../netlify/functions/register-account').handler;
  var body = Object.assign({ username: 'nudgeuser', password: 'realpassword1', email: 'nudgeuser@example.com' }, overrides || {});
  var res = await registerHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: body }));
  assert.equal(JSON.parse(res.body).ok, true, 'test setup: account registration must succeed');
  return body;
}

// ===== create-session-transfer.js: the password-verified minting gate =====

test('create-session-transfer: mints a token only when the REAL password is supplied, not a bare username/email claim', async function () {
  var account = await registerTestAccount({ username: 'mintuser', password: 'correctpw123', email: 'mintuser@example.com' });
  var handler = require('../netlify/functions/create-session-transfer').handler;

  var wrongPw = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { username: account.username, password: 'totally-wrong-pw' } }));
  assert.equal(wrongPw.statusCode, 200);
  var wrongPwBody = JSON.parse(wrongPw.body);
  assert.equal(wrongPwBody.ok, false);
  assert.match(wrongPwBody.error, /^E4: incorrect_password/);
  assert.equal(wrongPwBody.token, undefined, 'must never mint a token alongside a failed password check');

  var right = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { username: account.username, password: account.password } }));
  assert.equal(right.statusCode, 200);
  var rightBody = JSON.parse(right.body);
  assert.equal(rightBody.ok, true);
  assert.equal(typeof rightBody.token, 'string');
  assert.ok(rightBody.token.length >= 32, 'token should be a real random string, not a short/guessable value');
});

test('create-session-transfer: an unregistered username never mints a token, even if a password happens to be supplied', async function () {
  var handler = require('../netlify/functions/create-session-transfer').handler;
  var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { username: 'nobody-registered-at-all', password: 'whatever123' } }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.match(body.error, /^E4: incorrect_password/);
});

test('create-session-transfer: the payload has no email field at all -- an attacker can\'t attach an arbitrary email to a token by supplying one, since only username+password (both real-account-verified) ever determine the minted identity', async function () {
  var account = await registerTestAccount({ username: 'noemailspoof', password: 'realpassword1', email: 'real@example.com' });
  var createHandler = require('../netlify/functions/create-session-transfer').handler;
  var verifyHandler = require('../netlify/functions/verify-session-transfer').handler;

  // Even if a caller stuffs an `email` field into the request body, it's
  // simply ignored -- create-session-transfer.js never reads payload.email
  // at all (confirmed by reading that file), only the VERIFIED account
  // record's own email is ever used.
  var mint = await createHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { username: account.username, password: account.password, email: 'attacker-controlled@evil.example' } }));
  var mintBody = JSON.parse(mint.body);
  assert.equal(mintBody.ok, true);

  var verify = await verifyHandler(fakeEvent({ method: 'POST', body: { token: mintBody.token } }));
  var verifyBody = JSON.parse(verify.body);
  assert.equal(verifyBody.ok, true);
  assert.equal(verifyBody.email, 'real@example.com', 'must resolve the ACCOUNT\'s real, verified email -- never a client-supplied override');
});

test('create-session-transfer: validates shape and rejects non-POST/invalid JSON', async function () {
  var handler = require('../netlify/functions/create-session-transfer').handler;

  var missing = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { username: 'onlyusername' } }));
  assert.equal(missing.statusCode, 400);
  assert.match(JSON.parse(missing.body).error, /^E3: missing_fields/);

  var badJson = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: '{not json' }));
  assert.equal(badJson.statusCode, 400);
  assert.match(JSON.parse(badJson.body).error, /^E2: invalid_json/);

  var wrongMethod = await handler(fakeEvent({ method: 'GET' }));
  assert.equal(wrongMethod.statusCode, 405);
  assert.match(JSON.parse(wrongMethod.body).error, /^E1: method_not_allowed/);
});

test('create-session-transfer: exceeding MAX_SESSION_TRANSFER_ATTEMPTS_PER_IP_PER_DAY is rejected with E5 rate_limited (429, ok:false)', async function () {
  process.env.MAX_SESSION_TRANSFER_ATTEMPTS_PER_IP_PER_DAY = '1';
  var account = await registerTestAccount({ username: 'ratecapuser', password: 'realpassword1', email: 'ratecapuser@example.com' });
  var handler = require('../netlify/functions/create-session-transfer').handler;
  var ip = nextIp();

  var first = await handler(fakeEvent({ method: 'POST', ip: ip, body: { username: account.username, password: account.password } }));
  assert.equal(first.statusCode, 200);

  var second = await handler(fakeEvent({ method: 'POST', ip: ip, body: { username: account.username, password: account.password } }));
  assert.equal(second.statusCode, 429);
  var body = JSON.parse(second.body);
  assert.equal(body.ok, false);
  assert.match(body.error, /^E5: rate_limited/);
});

test('create-session-transfer: exceeding MAX_SESSION_TRANSFER_ATTEMPTS_PER_IDENTIFIER_PER_DAY throttles repeated password guesses against ONE account even from rotating IPs (round-2 review fix -- this endpoint checks a real password just like account-login.js, so a per-IP-only cap alone would let an attacker guess one known @handle\'s password indefinitely by rotating IPs)', async function () {
  process.env.MAX_SESSION_TRANSFER_ATTEMPTS_PER_IDENTIFIER_PER_DAY = '2';
  var account = await registerTestAccount({ username: 'guesstarget2', password: 'realpassword1', email: 'guesstarget2@example.com' });
  var handler = require('../netlify/functions/create-session-transfer').handler;

  var first = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { username: account.username, password: 'wrong-guess-one' } }));
  assert.equal(first.statusCode, 200); // 1st of 2 allowed identifier attempts (E4 incorrect_password)

  var second = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { username: account.username, password: 'wrong-guess-two' } }));
  assert.equal(second.statusCode, 200); // still under the per-identifier cap, even from a brand-new IP each time

  var third = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { username: 'GuessTarget2', password: 'wrong-guess-three' } }));
  assert.equal(third.statusCode, 429, 'a different IP does not bypass the per-identifier cap');
  assert.match(JSON.parse(third.body).error, /^E5: rate_limited/);

  // The real password, tried from yet another fresh IP, is ALSO blocked --
  // the per-identifier cap protects the account regardless of whether the
  // caller happens to know the real password on this particular attempt.
  var fourth = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { username: account.username, password: account.password } }));
  assert.equal(fourth.statusCode, 429);
});

test('create-session-transfer: submitting the account\'s EMAIL instead of its username does not open a second, independent rate-limit bucket for the same account (round-3 review fix -- mirrors account-login.js\'s getByEmail fallback in canonicalAccount resolution, closing a doubled-guess-budget bypass)', async function () {
  process.env.MAX_SESSION_TRANSFER_ATTEMPTS_PER_IDENTIFIER_PER_DAY = '2';
  var account = await registerTestAccount({ username: 'emailbypasstarget', password: 'realpassword1', email: 'emailbypasstarget@example.com' });
  var handler = require('../netlify/functions/create-session-transfer').handler;

  // Exhaust the per-identifier cap using the USERNAME.
  var first = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { username: account.username, password: 'wrong-guess-one' } }));
  assert.equal(first.statusCode, 200);
  var second = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { username: account.username, password: 'wrong-guess-two' } }));
  assert.equal(second.statusCode, 200);

  // A third attempt against the SAME account, submitted via its EMAIL
  // instead of its username, must land in the same bucket -- not a fresh
  // one -- and be blocked.
  var third = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { username: account.email, password: 'wrong-guess-three' } }));
  assert.equal(third.statusCode, 429, 'the email-addressed attempt must share the username-addressed bucket, not get its own');
  assert.match(JSON.parse(third.body).error, /^E5: rate_limited/);
});

// ===== verify-session-transfer.js: single-use, TTL'd consumption =====

test('verify-session-transfer: a freshly minted token verifies + consumes exactly once, returning {ok:true, username, email} matching account-login.js\'s own success shape', async function () {
  var account = await registerTestAccount({ username: 'roundtripuser', password: 'realpassword1', email: 'roundtrip@example.com' });
  var createHandler = require('../netlify/functions/create-session-transfer').handler;
  var verifyHandler = require('../netlify/functions/verify-session-transfer').handler;

  var mint = await createHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { username: account.username, password: account.password } }));
  var token = JSON.parse(mint.body).token;

  var first = await verifyHandler(fakeEvent({ method: 'POST', body: { token: token } }));
  assert.equal(first.statusCode, 200);
  var firstBody = JSON.parse(first.body);
  assert.equal(firstBody.ok, true);
  assert.equal(firstBody.username, account.username);
  assert.equal(firstBody.email, account.email);
});

test('verify-session-transfer: the SAME token used a second time fails silently (ok:false, 200 -- not an error) -- single-use is enforced', async function () {
  var account = await registerTestAccount({ username: 'onceuser', password: 'realpassword1', email: 'once@example.com' });
  var createHandler = require('../netlify/functions/create-session-transfer').handler;
  var verifyHandler = require('../netlify/functions/verify-session-transfer').handler;

  var mint = await createHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { username: account.username, password: account.password } }));
  var token = JSON.parse(mint.body).token;

  var first = await verifyHandler(fakeEvent({ method: 'POST', body: { token: token } }));
  assert.equal(JSON.parse(first.body).ok, true);

  var second = await verifyHandler(fakeEvent({ method: 'POST', body: { token: token } }));
  assert.equal(second.statusCode, 200, 'a reused token must degrade to a silent no-op, never a distinct error status');
  var secondBody = JSON.parse(second.body);
  assert.equal(secondBody.ok, false);
  assert.equal(secondBody.username, undefined, 'must never leak the identity a second time');
});

test('verify-session-transfer: an unknown/garbage token is a silent no-op (ok:false, 200), never a 4xx/5xx', async function () {
  var verifyHandler = require('../netlify/functions/verify-session-transfer').handler;
  var res = await verifyHandler(fakeEvent({ method: 'POST', body: { token: 'not-a-real-token-just-guessed-hex-abc123' } }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.ok, false);
});

test('verify-session-transfer: an expired token is a silent no-op, even though it was never actually consumed', async function () {
  var account = await registerTestAccount({ username: 'expireduser', password: 'realpassword1', email: 'expired@example.com' });
  var createHandler = require('../netlify/functions/create-session-transfer').handler;
  var verifyHandler = require('../netlify/functions/verify-session-transfer').handler;
  var sessionTransferToken = require('../netlify/functions/lib/session-transfer-token');

  var mint = await createHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { username: account.username, password: account.password } }));
  var token = JSON.parse(mint.body).token;

  // Simulate the ~15 minute TTL having already elapsed -- directly rewrite
  // the stored record's expiresAt into the past, same "arrange state via
  // mockBlobs.seed" approach account-store.test.js's orphaned-index test
  // uses, rather than waiting 15 real minutes.
  mockBlobs.seed(sessionTransferToken.STORE_NAME, token, {
    username: account.username, email: account.email,
    createdAt: Date.now() - (20 * 60 * 1000), expiresAt: Date.now() - 1000, consumed: false
  });

  var res = await verifyHandler(fakeEvent({ method: 'POST', body: { token: token } }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.ok, false, 'an expired token must never verify, even though .consumed is still false');
});

test('verify-session-transfer: validates shape and rejects non-POST/invalid JSON', async function () {
  var handler = require('../netlify/functions/verify-session-transfer').handler;

  var missing = await handler(fakeEvent({ method: 'POST', body: {} }));
  assert.equal(missing.statusCode, 400);
  assert.match(JSON.parse(missing.body).error, /^E3: token_required/);

  var badJson = await handler(fakeEvent({ method: 'POST', body: '{not json' }));
  assert.equal(badJson.statusCode, 400);
  assert.match(JSON.parse(badJson.body).error, /^E2: invalid_json/);

  var wrongMethod = await handler(fakeEvent({ method: 'GET' }));
  assert.equal(wrongMethod.statusCode, 405);
  assert.match(JSON.parse(wrongMethod.body).error, /^E1: method_not_allowed/);
});

// ===== concurrency: two racing consumes of the SAME token =====
//
// Same "the mock Blobs store's operations are still genuinely async, so a
// Promise.all races step-by-step exactly like two concurrent Netlify
// Function invocations would" reasoning as account-store.test.js's own
// concurrency section -- this is what lets this test exercise the real
// blobs-retry two-phase-marker mechanism end-to-end (lib/session-transfer-
// token.js's verifyAndConsumeToken), not just assert the code "looks"
// correct. This is the scenario the header comment on that file explains:
// two different browser contexts (the original webview tab, and the
// freshly-opened external browser) both loading the exact same ?bt= URL
// at nearly the same instant.

test('session-transfer: two concurrent verify+consume calls for the SAME token -- exactly one succeeds, never both, never zero', async function () {
  var account = await registerTestAccount({ username: 'raceruser', password: 'realpassword1', email: 'racer@example.com' });
  var createHandler = require('../netlify/functions/create-session-transfer').handler;
  var verifyHandler = require('../netlify/functions/verify-session-transfer').handler;

  var mint = await createHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { username: account.username, password: account.password } }));
  var token = JSON.parse(mint.body).token;

  var results = await Promise.all([
    verifyHandler(fakeEvent({ method: 'POST', body: { token: token } })),
    verifyHandler(fakeEvent({ method: 'POST', body: { token: token } }))
  ]);
  var bodies = results.map(function (r) { return JSON.parse(r.body); });
  var okCount = bodies.filter(function (b) { return b.ok; }).length;
  assert.equal(okCount, 1, 'exactly one of the two racing consumes must win -- a single-use token must never be honored twice, and a real winner must exist');
});

// ===== lib/session-transfer-token.js directly =====

test('session-transfer-token: createToken/verifyAndConsumeToken round-trip directly (no HTTP handlers involved)', async function () {
  var sessionTransferToken = require('../netlify/functions/lib/session-transfer-token');
  var event = fakeEvent({ method: 'POST' });

  var token = await sessionTransferToken.createToken(event, 'directuser', 'direct@example.com');
  assert.equal(typeof token, 'string');

  var first = await sessionTransferToken.verifyAndConsumeToken(event, token);
  assert.equal(first.ok, true);
  assert.equal(first.username, 'directuser');
  assert.equal(first.email, 'direct@example.com');

  var second = await sessionTransferToken.verifyAndConsumeToken(event, token);
  assert.equal(second.ok, false);
});

test('session-transfer-token: verifyAndConsumeToken rejects an empty/missing token without touching the store at all', async function () {
  var sessionTransferToken = require('../netlify/functions/lib/session-transfer-token');
  var event = fakeEvent({ method: 'POST' });

  var result = await sessionTransferToken.verifyAndConsumeToken(event, '');
  assert.equal(result.ok, false);
  var result2 = await sessionTransferToken.verifyAndConsumeToken(event, null);
  assert.equal(result2.ok, false);
});
