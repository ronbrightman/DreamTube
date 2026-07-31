// test/facebook-oauth-callback.test.js
//
// Covers netlify/functions/facebook-oauth-callback.js and
// netlify/functions/facebook-complete-signup.js — the server half of
// Facebook Login (docs/SIGNUP_FACEBOOK_LOGIN_SPEC.md, tracker items
// for-product-priority-founder-2026-07-30--ruzc5u /
// for-product-signup-screen-the-single-big-bkwhbe).
//
// This is genuinely security-sensitive code (real authentication, real
// account creation, real account LINKING), so the coverage here is
// deliberately heavier than a feature of this size would usually get:
// the identity-resolution algorithm gets direct unit-style coverage of
// every branch, plus the CSRF path, the fail-closed paths, and the
// account-takeover shapes that would be the actual consequence of
// getting any of it wrong.
//
// Same conventions as test/check-email.test.js/test/account-store.test.js:
// mock-blobs installed before any handler is required, fakeEvent for the
// Lambda-shaped event, a fresh IP per scenario so rate-limit buckets
// don't collide.
//
// The Facebook Graph API itself is stubbed via a global.fetch spy, the
// same technique test/dodo-webhook.test.js uses to stand in for a
// payment provider's live API — there is no real Meta app to talk to
// (that's blocked on Business Verification, a human track), and there
// would never be one in CI regardless.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');

var APP_ID = '1234567890';
var APP_SECRET = 'test-facebook-app-secret';

var ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return '10.9.0.' + ipCounter;
}

var realFetch = global.fetch;

/**
 * Stands in for graph.facebook.com. `opts`:
 *   token        — the access_token the exchange returns (default 'fb-access-token')
 *   exchangeFails— exchange responds non-2xx
 *   noToken      — exchange responds 200 but with no access_token
 *   profile      — the /me payload ({id, name, email})
 *   profileFails — /me responds non-2xx
 * Returns the recorded call list so tests can assert the exchange really
 * was server-to-server with the secret, not something client-trusted.
 */
function installGraphStub(opts) {
  opts = opts || {};
  var calls = [];
  global.fetch = async function (url) {
    var urlStr = String(url);
    calls.push(urlStr);
    if (urlStr.indexOf('/oauth/access_token') !== -1) {
      if (opts.exchangeFails) return { ok: false, status: 400, json: async function () { return { error: {} }; } };
      return { ok: true, status: 200, json: async function () { return opts.noToken ? {} : { access_token: opts.token || 'fb-access-token' }; } };
    }
    if (urlStr.indexOf('/me?') !== -1) {
      if (opts.profileFails) return { ok: false, status: 400, json: async function () { return { error: {} }; } };
      return { ok: true, status: 200, json: async function () { return opts.profile || {}; } };
    }
    throw new Error('unexpected fetch to ' + urlStr);
  };
  return calls;
}

function freshModules() {
  [
    '../netlify/functions/facebook-oauth-callback',
    '../netlify/functions/facebook-complete-signup',
    '../netlify/functions/lib/account-store',
    '../netlify/functions/lib/session-transfer-token',
    '../netlify/functions/lib/facebook-identity-token',
    '../netlify/functions/verify-session-transfer'
  ].forEach(function (p) { delete require.cache[require.resolve(p)]; });
}

test.beforeEach(function () {
  mockBlobs.reset();
  process.env.FACEBOOK_APP_ID = APP_ID;
  process.env.FACEBOOK_APP_SECRET = APP_SECRET;
  delete process.env.MAX_FACEBOOK_CALLBACKS_PER_IP_PER_DAY;
  delete process.env.MAX_FACEBOOK_COMPLETIONS_PER_IP_PER_DAY;
  installGraphStub({ profile: { id: '777', name: 'Test Person', email: 'default@example.com' } });
  freshModules();
});

test.after(function () {
  delete process.env.FACEBOOK_APP_ID;
  delete process.env.FACEBOOK_APP_SECRET;
  global.fetch = realFetch;
});

/** base64url-encodes a state payload the same way js/facebook-config.js's buildFacebookState does. */
function encodeState(nonce, resume) {
  var json = JSON.stringify({ n: nonce, r: resume === undefined ? 'resume=1&style=Cartoon' : resume });
  return Buffer.from(json, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A well-formed callback GET whose state nonce matches its own cookie (the happy CSRF case). */
function callbackEvent(opts) {
  opts = opts || {};
  var nonce = opts.nonce || 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  var cookieNonce = opts.cookieNonce === undefined ? nonce : opts.cookieNonce;
  var headers = {};
  if (cookieNonce !== null) headers.cookie = 'other=1; dt_fb_state=' + cookieNonce + '; another=2';
  headers.host = 'dreamtube1.netlify.app';
  return fakeEvent({
    method: 'GET',
    ip: opts.ip || nextIp(),
    headers: headers,
    query: Object.assign({ code: 'fb-code-123', state: encodeState(nonce, opts.resume) }, opts.query || {})
  });
}

function locationOf(res) {
  return new URL(res.headers.Location);
}
function paramsOf(res) {
  return locationOf(res).searchParams;
}

// ===================================================================
// Identity resolution — the spec's §3 algorithm, branch by branch
// ===================================================================

test('resolution, brand-new user: creates ONE account with fbUserId, password:null, a derived username, and both secondary indexes', async function () {
  installGraphStub({ profile: { id: '5550001', name: 'Nova Dreamer', email: 'Nova.Dreamer@Example.com' } });
  var handler = require('../netlify/functions/facebook-oauth-callback').handler;
  var accountStore = require('../netlify/functions/lib/account-store');

  var res = await handler(callbackEvent());
  assert.equal(res.statusCode, 302);
  var params = paramsOf(res);
  assert.equal(params.get('fb'), 'signup');
  assert.ok(params.get('bt'), 'a session-transfer token must come back on the redirect');
  assert.equal(params.get('fb_error'), null);

  var evt = fakeEvent({ method: 'GET' });
  var byEmail = await accountStore.getByEmail(evt, 'nova.dreamer@example.com');
  assert.ok(byEmail, 'the account must be findable through the e: index');
  assert.equal(byEmail.username, 'novadreamer');
  assert.equal(byEmail.password, null);
  assert.equal(byEmail.fbUserId, '5550001');

  var byFb = await accountStore.getByFacebookUserId(evt, '5550001');
  assert.ok(byFb, 'the account must be findable through the new f: index');
  assert.equal(byFb.username, 'novadreamer');
});

test('resolution, brand-new user: the minted session-transfer token really resolves to the created account (end-to-end through verify-session-transfer.js)', async function () {
  installGraphStub({ profile: { id: '5550002', name: null, email: 'roundtrip@example.com' } });
  var handler = require('../netlify/functions/facebook-oauth-callback').handler;
  var res = await handler(callbackEvent());
  var token = paramsOf(res).get('bt');

  var verify = require('../netlify/functions/verify-session-transfer').handler;
  var verified = JSON.parse((await verify(fakeEvent({ method: 'POST', body: { token: token } }))).body);
  assert.equal(verified.ok, true);
  assert.equal(verified.username, 'roundtrip');
  assert.equal(verified.email, 'roundtrip@example.com');
});

test('resolution, existing EMAIL account: links fbUserId onto it and logs in — never a second account', async function () {
  var accountStore = require('../netlify/functions/lib/account-store');
  var seedEvt = fakeEvent({ method: 'GET' });
  var created = await accountStore.createAccount(seedEvt, { username: 'alreadyhere', password: 'realpassword1', email: 'already@example.com' });
  assert.equal(created.ok, true);

  installGraphStub({ profile: { id: '5550003', name: 'Already Here', email: 'already@example.com' } });
  var handler = require('../netlify/functions/facebook-oauth-callback').handler;
  var res = await handler(callbackEvent());

  var params = paramsOf(res);
  assert.equal(params.get('fb'), 'login', 'an existing email must be counted as a login, not a signup');
  assert.ok(params.get('bt'));

  var record = await accountStore.getByEmail(seedEvt, 'already@example.com');
  assert.equal(record.username, 'alreadyhere', 'the ORIGINAL account, not a new one');
  assert.equal(record.fbUserId, '5550003', 'the Facebook id is upserted onto the existing record');
  assert.equal(record.password, 'realpassword1', 'the existing password must be left completely untouched');

  // And no duplicate was created under a derived username.
  assert.equal(await accountStore.getByUsername(seedEvt, 'already'), null);
});

test('resolution, returning Facebook user: resolves at the f: index without touching the email index at all, even if their Facebook email has since changed', async function () {
  installGraphStub({ profile: { id: '5550004', name: 'Returning', email: 'first@example.com' } });
  var handler = require('../netlify/functions/facebook-oauth-callback').handler;
  await handler(callbackEvent());

  // Second visit, same Facebook id, DIFFERENT email on the Facebook side.
  installGraphStub({ profile: { id: '5550004', name: 'Returning', email: 'changed@example.com' } });
  var res = await handler(callbackEvent());
  assert.equal(paramsOf(res).get('fb'), 'login');

  var accountStore = require('../netlify/functions/lib/account-store');
  var evt = fakeEvent({ method: 'GET' });
  assert.equal(await accountStore.getByEmail(evt, 'changed@example.com'), null, 'no second account for the changed email');
  var record = await accountStore.getByFacebookUserId(evt, '5550004');
  assert.equal(record.email, 'first@example.com', 'the linked account keeps the email it was created with');
});

test('resolution, no email from Facebook: creates NOTHING and hands back an fb_needs_email marker instead', async function () {
  installGraphStub({ profile: { id: '5550005', name: 'No Email', email: null } });
  var handler = require('../netlify/functions/facebook-oauth-callback').handler;
  var res = await handler(callbackEvent());

  var params = paramsOf(res);
  var marker = params.get('fb_needs_email');
  assert.ok(marker, 'a signed marker must come back');
  assert.equal(params.get('bt'), null, 'no session is granted for an identity with no email');
  assert.equal(params.get('fb'), null);

  // The marker is opaque: the Facebook user id never appears in the URL.
  assert.equal(marker.indexOf('5550005'), -1);
  assert.match(marker, /^[0-9a-f]{64}$/, 'a random, unguessable token — not an encoded payload');
});

test('resolution: a malformed/unusable Facebook id is refused rather than keyed into the store', async function () {
  installGraphStub({ profile: { id: 'not-a-real-id:u:someone', name: null, email: 'weird@example.com' } });
  var handler = require('../netlify/functions/facebook-oauth-callback').handler;
  var res = await handler(callbackEvent());
  assert.equal(paramsOf(res).get('fb_error'), 'server_error');

  var accountStore = require('../netlify/functions/lib/account-store');
  assert.equal(await accountStore.getByEmail(fakeEvent({ method: 'GET' }), 'weird@example.com'), null);
});

test('resolution: username collision retries with a suffix instead of failing or overwriting', async function () {
  var accountStore = require('../netlify/functions/lib/account-store');
  var seedEvt = fakeEvent({ method: 'GET' });
  await accountStore.createAccount(seedEvt, { username: 'collide', password: 'somepassword', email: 'someone-else@example.com' });

  installGraphStub({ profile: { id: '5550006', name: null, email: 'collide@example.com' } });
  var handler = require('../netlify/functions/facebook-oauth-callback').handler;
  var res = await handler(callbackEvent());
  assert.equal(paramsOf(res).get('fb'), 'signup');

  var created = await accountStore.getByEmail(seedEvt, 'collide@example.com');
  assert.match(created.username, /^collide[0-9]{4}$/, 'a fresh suffixed handle, not the taken one');
  var original = await accountStore.getByUsername(seedEvt, 'collide');
  assert.equal(original.email, 'someone-else@example.com', 'the colliding account is untouched');
});

// ===================================================================
// CSRF / fail-closed paths
// ===================================================================

test('CSRF: a state nonce that does not match the first-party cookie fails closed with fb_error=csrf and creates nothing', async function () {
  installGraphStub({ profile: { id: '5550007', name: null, email: 'csrf@example.com' } });
  var handler = require('../netlify/functions/facebook-oauth-callback').handler;
  var res = await handler(callbackEvent({ nonce: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', cookieNonce: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }));

  assert.equal(res.statusCode, 302);
  assert.equal(paramsOf(res).get('fb_error'), 'csrf');
  assert.equal(paramsOf(res).get('bt'), null);
  var accountStore = require('../netlify/functions/lib/account-store');
  assert.equal(await accountStore.getByEmail(fakeEvent({ method: 'GET' }), 'csrf@example.com'), null);
});

test('CSRF: no cookie at all fails closed exactly like a mismatch', async function () {
  var handler = require('../netlify/functions/facebook-oauth-callback').handler;
  var res = await handler(callbackEvent({ cookieNonce: null }));
  assert.equal(paramsOf(res).get('fb_error'), 'csrf');
});

test('CSRF: an unparseable state param fails closed (a state we cannot read is a state we cannot verify)', async function () {
  var handler = require('../netlify/functions/facebook-oauth-callback').handler;
  var res = await handler(fakeEvent({
    method: 'GET',
    ip: nextIp(),
    headers: { host: 'dreamtube1.netlify.app', cookie: 'dt_fb_state=whatever' },
    query: { code: 'fb-code-123', state: '!!!not-base64!!!' }
  }));
  assert.equal(paramsOf(res).get('fb_error'), 'csrf');
});

test('the CSRF cookie is cleared on every outcome, success and failure alike', async function () {
  var handler = require('../netlify/functions/facebook-oauth-callback').handler;
  installGraphStub({ profile: { id: '5550008', name: null, email: 'cookieclear@example.com' } });
  var ok = await handler(callbackEvent());
  assert.match(ok.headers['Set-Cookie'], /^dt_fb_state=; path=\/; max-age=0/);
  var bad = await handler(callbackEvent({ cookieNonce: 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz' }));
  assert.match(bad.headers['Set-Cookie'], /^dt_fb_state=; path=\/; max-age=0/);
});

test('missing server-side FACEBOOK_APP_ID/SECRET fails closed with fb_error=not_configured, before any Graph call', async function () {
  delete process.env.FACEBOOK_APP_SECRET;
  var calls = installGraphStub({ profile: { id: '5550009', name: null, email: 'unconfigured@example.com' } });
  var handler = require('../netlify/functions/facebook-oauth-callback').handler;
  var res = await handler(callbackEvent());
  assert.equal(paramsOf(res).get('fb_error'), 'not_configured');
  assert.equal(calls.length, 0, 'nothing may be sent to Facebook without a configured app');
});

test('a failed code->token exchange fails closed with fb_error=exchange_failed and never calls /me', async function () {
  var calls = installGraphStub({ exchangeFails: true });
  var handler = require('../netlify/functions/facebook-oauth-callback').handler;
  var res = await handler(callbackEvent());
  assert.equal(paramsOf(res).get('fb_error'), 'exchange_failed');
  assert.ok(calls.every(function (u) { return u.indexOf('/me?') === -1; }));
});

test('an exchange that returns 200 but no access_token is still treated as a failure', async function () {
  installGraphStub({ noToken: true });
  var handler = require('../netlify/functions/facebook-oauth-callback').handler;
  var res = await handler(callbackEvent());
  assert.equal(paramsOf(res).get('fb_error'), 'exchange_failed');
});

test('a failed /me call fails closed with fb_error=profile_failed', async function () {
  installGraphStub({ profileFails: true });
  var handler = require('../netlify/functions/facebook-oauth-callback').handler;
  var res = await handler(callbackEvent());
  assert.equal(paramsOf(res).get('fb_error'), 'profile_failed');
});

test('the user cancelling at Facebook comes back as fb_error=denied, not a scary generic failure', async function () {
  var handler = require('../netlify/functions/facebook-oauth-callback').handler;
  var res = await handler(callbackEvent({ query: { error: 'access_denied', code: undefined } }));
  assert.equal(paramsOf(res).get('fb_error'), 'denied');
});

test('cancelling at Facebook does not consume the visitor\'s own daily rate-limit allowance', async function () {
  process.env.MAX_FACEBOOK_CALLBACKS_PER_IP_PER_DAY = '1';
  freshModules();
  installGraphStub({ profile: { id: '5559999', name: null, email: 'aftercancel@example.com' } });
  var handler = require('../netlify/functions/facebook-oauth-callback').handler;
  var ip = nextIp();

  // Three cancels...
  for (var i = 0; i < 3; i++) {
    var cancelled = await handler(callbackEvent({ ip: ip, query: { error: 'access_denied', code: undefined } }));
    assert.equal(paramsOf(cancelled).get('fb_error'), 'denied');
  }
  // ...then a real attempt, which must still be allowed through.
  var real = await handler(callbackEvent({ ip: ip }));
  assert.equal(paramsOf(real).get('fb'), 'signup');
});

test('the token exchange is server-to-server with the app secret, and identity is never read from the query string', async function () {
  var calls = installGraphStub({ profile: { id: '5550010', name: null, email: 'ssrf@example.com' } });
  var handler = require('../netlify/functions/facebook-oauth-callback').handler;
  // A caller trying to assert an identity directly in the URL must gain
  // nothing at all from it.
  await handler(callbackEvent({ query: { fbUserId: '999999', email: 'victim@example.com' } }));

  var exchange = calls.filter(function (u) { return u.indexOf('/oauth/access_token') !== -1; })[0];
  assert.ok(exchange.indexOf('client_secret=' + APP_SECRET) !== -1, 'the exchange must carry the app secret');
  assert.ok(exchange.indexOf('redirect_uri=' + encodeURIComponent('https://dreamtube1.netlify.app/.netlify/functions/facebook-oauth-callback')) !== -1);

  var accountStore = require('../netlify/functions/lib/account-store');
  var evt = fakeEvent({ method: 'GET' });
  assert.equal(await accountStore.getByEmail(evt, 'victim@example.com'), null, 'a URL-supplied email must never create/resolve an account');
  assert.equal(await accountStore.getByFacebookUserId(evt, '999999'), null, 'a URL-supplied Facebook id must never resolve an account');
  assert.ok(await accountStore.getByEmail(evt, 'ssrf@example.com'), 'only what Facebook itself returned is used');
});

// ===================================================================
// Redirect shape / resume params
// ===================================================================

test('the redirect always returns to start.html carrying resume=1 and the funnel params packed into state', async function () {
  installGraphStub({ profile: { id: '5550011', name: null, email: 'resume@example.com' } });
  var handler = require('../netlify/functions/facebook-oauth-callback').handler;
  var res = await handler(callbackEvent({ resume: 'resume=1&style=Cartoon&caption=' + encodeURIComponent('a dream about flying') + '&mode=record' }));

  var url = locationOf(res);
  assert.equal(url.pathname, '/start.html');
  assert.equal(url.searchParams.get('resume'), '1');
  assert.equal(url.searchParams.get('style'), 'Cartoon');
  assert.equal(url.searchParams.get('caption'), 'a dream about flying');
  assert.equal(url.searchParams.get('mode'), 'record');
});

test('even a failure redirect carries resume=1, so a failed sign-in never ejects the visitor out of the funnel entirely', async function () {
  var handler = require('../netlify/functions/facebook-oauth-callback').handler;
  var res = await handler(callbackEvent({ cookieNonce: 'ffffffffffffffffffffffffffffffff', resume: 'resume=1&caption=keepme' }));
  var url = locationOf(res);
  assert.equal(url.pathname, '/start.html');
  assert.equal(url.searchParams.get('resume'), '1');
  assert.equal(url.searchParams.get('caption'), 'keepme');
  assert.equal(url.searchParams.get('fb_error'), 'csrf');
});

test('a stale bt/fb_error already sitting in the resume params is stripped, never echoed forward', async function () {
  installGraphStub({ profile: { id: '5550012', name: null, email: 'stale@example.com' } });
  var handler = require('../netlify/functions/facebook-oauth-callback').handler;
  var res = await handler(callbackEvent({ resume: 'resume=1&bt=STALE_TOKEN&fb_error=csrf&fb_needs_email=STALE_MARKER' }));
  var params = paramsOf(res);
  assert.notEqual(params.get('bt'), 'STALE_TOKEN');
  assert.equal(params.get('fb_error'), null);
  assert.equal(params.get('fb_needs_email'), null);
});

test('non-GET is a plain 405, not a redirect', async function () {
  var handler = require('../netlify/functions/facebook-oauth-callback').handler;
  var res = await handler(fakeEvent({ method: 'POST', ip: nextIp() }));
  assert.equal(res.statusCode, 405);
  assert.match(JSON.parse(res.body).error, /^E1: method_not_allowed/);
});

test('per-IP daily rate limit blocks further callbacks from the same source, same shape as register-account.js', async function () {
  process.env.MAX_FACEBOOK_CALLBACKS_PER_IP_PER_DAY = '2';
  freshModules();
  installGraphStub({ profile: { id: '5550013', name: null, email: 'ratelimit@example.com' } });
  var handler = require('../netlify/functions/facebook-oauth-callback').handler;
  var ip = nextIp();

  var first = await handler(callbackEvent({ ip: ip }));
  assert.notEqual(paramsOf(first).get('fb_error'), 'rate_limited');
  await handler(callbackEvent({ ip: ip }));
  var third = await handler(callbackEvent({ ip: ip }));
  assert.equal(paramsOf(third).get('fb_error'), 'rate_limited');
});

// ===================================================================
// facebook-complete-signup.js — the "needs email" completion
// ===================================================================

/** Runs a no-email callback and returns the fb_needs_email marker it hands back. */
async function markerForNoEmailUser(fbUserId) {
  installGraphStub({ profile: { id: fbUserId, name: 'No Email', email: null } });
  var handler = require('../netlify/functions/facebook-oauth-callback').handler;
  var res = await handler(callbackEvent());
  return paramsOf(res).get('fb_needs_email');
}

test('needs-email completion: a valid marker + a fresh email creates the account and returns a working session-transfer token', async function () {
  var marker = await markerForNoEmailUser('6660001');
  var complete = require('../netlify/functions/facebook-complete-signup').handler;
  var res = await complete(fakeEvent({ method: 'POST', ip: nextIp(), body: { token: marker, email: 'supplied@example.com' } }));
  var body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.created, true);
  assert.ok(body.transferToken);

  var accountStore = require('../netlify/functions/lib/account-store');
  var evt = fakeEvent({ method: 'GET' });
  var record = await accountStore.getByEmail(evt, 'supplied@example.com');
  assert.equal(record.fbUserId, '6660001');
  assert.equal(record.password, null);
  assert.equal(record.username, 'supplied');

  var verify = require('../netlify/functions/verify-session-transfer').handler;
  var verified = JSON.parse((await verify(fakeEvent({ method: 'POST', body: { token: body.transferToken } }))).body);
  assert.equal(verified.ok, true);
  assert.equal(verified.username, 'supplied');
});

test('SECURITY, needs-email completion: an email that already has an account is REFUSED — never linked, never a session', async function () {
  var accountStore = require('../netlify/functions/lib/account-store');
  var seedEvt = fakeEvent({ method: 'GET' });
  await accountStore.createAccount(seedEvt, { username: 'victimuser', password: 'victimpassword', email: 'victim@example.com' });

  var marker = await markerForNoEmailUser('6660002');
  var complete = require('../netlify/functions/facebook-complete-signup').handler;
  var res = await complete(fakeEvent({ method: 'POST', ip: nextIp(), body: { token: marker, email: 'victim@example.com' } }));
  var body = JSON.parse(res.body);

  assert.equal(body.ok, false);
  assert.match(body.error, /^E5: email_taken/);
  assert.equal(body.transferToken, undefined, 'no session may be handed back for someone else\'s email');

  // And the victim's account is entirely untouched — crucially, NOT linked.
  var victim = await accountStore.getByEmail(seedEvt, 'victim@example.com');
  assert.equal(victim.username, 'victimuser');
  assert.equal(victim.password, 'victimpassword');
  assert.equal(victim.fbUserId, undefined, 'an unverified, typed email must never link a Facebook identity onto an existing account');
  assert.equal(await accountStore.getByFacebookUserId(seedEvt, '6660002'), null);
});

test('needs-email completion: a refused (already-taken) email leaves the marker usable, so a real user can correct their address', async function () {
  var accountStore = require('../netlify/functions/lib/account-store');
  await accountStore.createAccount(fakeEvent({ method: 'GET' }), { username: 'takenowner', password: 'pw123456', email: 'taken@example.com' });

  var marker = await markerForNoEmailUser('6660003');
  var complete = require('../netlify/functions/facebook-complete-signup').handler;
  var refused = JSON.parse((await complete(fakeEvent({ method: 'POST', ip: nextIp(), body: { token: marker, email: 'taken@example.com' } }))).body);
  assert.equal(refused.ok, false);

  var retry = JSON.parse((await complete(fakeEvent({ method: 'POST', ip: nextIp(), body: { token: marker, email: 'corrected@example.com' } }))).body);
  assert.equal(retry.ok, true, 'the marker must survive a rejected attempt');
  assert.equal(retry.created, true);
});

test('needs-email completion: the marker is single-use — a replay after a successful creation is refused', async function () {
  var marker = await markerForNoEmailUser('6660004');
  var complete = require('../netlify/functions/facebook-complete-signup').handler;
  var first = JSON.parse((await complete(fakeEvent({ method: 'POST', ip: nextIp(), body: { token: marker, email: 'once@example.com' } }))).body);
  assert.equal(first.ok, true);

  var replay = JSON.parse((await complete(fakeEvent({ method: 'POST', ip: nextIp(), body: { token: marker, email: 'twice@example.com' } }))).body);
  assert.equal(replay.ok, false);
  assert.match(replay.error, /^E6: invalid_or_expired/);

  var accountStore = require('../netlify/functions/lib/account-store');
  assert.equal(await accountStore.getByEmail(fakeEvent({ method: 'GET' }), 'twice@example.com'), null);
});

test('needs-email completion: an unknown/forged marker is refused and creates nothing', async function () {
  var complete = require('../netlify/functions/facebook-complete-signup').handler;
  var res = JSON.parse((await complete(fakeEvent({ method: 'POST', ip: nextIp(), body: { token: 'f'.repeat(64), email: 'forged@example.com' } }))).body);
  assert.equal(res.ok, false);
  assert.match(res.error, /^E6: invalid_or_expired/);
  var accountStore = require('../netlify/functions/lib/account-store');
  assert.equal(await accountStore.getByEmail(fakeEvent({ method: 'GET' }), 'forged@example.com'), null);
});

test('needs-email completion: an expired marker is refused', async function () {
  var identityToken = require('../netlify/functions/lib/facebook-identity-token');
  var evt = fakeEvent({ method: 'GET' });
  var marker = await identityToken.createToken(evt, '6660005', 'Expired');
  mockBlobs.seed(identityToken.STORE_NAME, marker, {
    fbUserId: '6660005', name: 'Expired', createdAt: Date.now() - 3600000,
    expiresAt: Date.now() - 1000, consumed: false, consumedAt: null
  });

  var complete = require('../netlify/functions/facebook-complete-signup').handler;
  var res = JSON.parse((await complete(fakeEvent({ method: 'POST', ip: nextIp(), body: { token: marker, email: 'expired@example.com' } }))).body);
  assert.equal(res.ok, false);
  assert.match(res.error, /^E6: invalid_or_expired/);
});

test('needs-email completion: if that Facebook id got linked elsewhere while the marker was outstanding, it resolves as a LOGIN to that account rather than creating a duplicate', async function () {
  var marker = await markerForNoEmailUser('6660006');

  // Meanwhile, the same Facebook user completes a second round trip that
  // DOES return an email, creating and linking a real account.
  installGraphStub({ profile: { id: '6660006', name: 'Now With Email', email: 'nowemail@example.com' } });
  var handler = require('../netlify/functions/facebook-oauth-callback').handler;
  await handler(callbackEvent());

  var complete = require('../netlify/functions/facebook-complete-signup').handler;
  var res = JSON.parse((await complete(fakeEvent({ method: 'POST', ip: nextIp(), body: { token: marker, email: 'different@example.com' } }))).body);
  assert.equal(res.ok, true);
  assert.equal(res.created, false, 'this is a login to the already-linked account, not a creation');

  var accountStore = require('../netlify/functions/lib/account-store');
  var evt = fakeEvent({ method: 'GET' });
  assert.equal(await accountStore.getByEmail(evt, 'different@example.com'), null, 'no second account for the typed email');

  var verify = require('../netlify/functions/verify-session-transfer').handler;
  var verified = JSON.parse((await verify(fakeEvent({ method: 'POST', body: { token: res.transferToken } }))).body);
  assert.equal(verified.email, 'nowemail@example.com');
});

test('needs-email completion: an unexpected failure is reported as the coded E9, never a bare uncoded string', async function () {
  var marker = await markerForNoEmailUser('6660007');
  var callback = require('../netlify/functions/facebook-oauth-callback');
  var real = callback._internal.createFacebookAccount;
  callback._internal.createFacebookAccount = function () { throw new Error('boom'); };
  try {
    var complete = require('../netlify/functions/facebook-complete-signup').handler;
    var res = await complete(fakeEvent({ method: 'POST', ip: nextIp(), body: { token: marker, email: 'unlucky@example.com' } }));
    assert.equal(res.statusCode, 500);
    var body = JSON.parse(res.body);
    assert.equal(body.ok, false);
    assert.match(body.error, /^E9: unexpected_error/, 'a genuinely unexpected failure must still be a coded error, same scheme as every other branch in this file');
  } finally {
    callback._internal.createFacebookAccount = real;
  }
});

test('needs-email completion: shape errors are rejected before anything else runs', async function () {
  var complete = require('../netlify/functions/facebook-complete-signup').handler;
  assert.equal((await complete(fakeEvent({ method: 'GET', ip: nextIp() }))).statusCode, 405);
  assert.equal((await complete({ httpMethod: 'POST', headers: {}, body: '{nope' })).statusCode, 400);

  var missing = await complete(fakeEvent({ method: 'POST', ip: nextIp(), body: { token: 'abc' } }));
  assert.equal(missing.statusCode, 400);
  assert.match(JSON.parse(missing.body).error, /^E3: missing_fields/);

  var bad = await complete(fakeEvent({ method: 'POST', ip: nextIp(), body: { token: 'abc', email: 'not-an-email' } }));
  assert.equal(bad.statusCode, 400);
  assert.match(JSON.parse(bad.body).error, /^E4: invalid_email/);
});

// ===================================================================
// The client/server `state` contract
// ===================================================================
// js/facebook-config.js builds `state` in the browser and this function
// parses it back on the server. They are two files in two runtimes with
// no shared module between them (no bundler here — see CLAUDE.md), so
// the encoding agreement is exactly the kind of thing that silently
// drifts. These load the real client file and round-trip through the real
// server parser.

/** Loads js/facebook-config.js's pure helpers into this process, with the minimal browser globals they touch. */
function loadClientConfig() {
  var fs = require('node:fs');
  var path = require('node:path');
  var source = fs.readFileSync(path.join(__dirname, '..', 'js', 'facebook-config.js'), 'utf8');
  global.btoa = function (s) { return Buffer.from(s, 'binary').toString('base64'); };
  /* eslint-disable no-new-func */
  return new Function(source + '; return { trimResumeParams: trimResumeParams, buildFacebookState: buildFacebookState, isFacebookLoginConfigured: isFacebookLoginConfigured };')();
}

test('state contract: the client encoder and this function\'s parser agree, including a unicode caption', function () {
  var client = loadClientConfig();
  var caption = 'a dream — with an em dash & Ünïcødé';
  var state = client.buildFacebookState('deadbeefdeadbeefdeadbeefdeadbeef', '?resume=1&style=Cartoon&caption=' + encodeURIComponent(caption));
  var parsed = require('../netlify/functions/facebook-oauth-callback')._internal.parseState(state);

  assert.equal(parsed.nonce, 'deadbeefdeadbeefdeadbeefdeadbeef');
  var resume = new URLSearchParams(parsed.resume);
  assert.equal(resume.get('caption'), caption, 'a unicode caption must survive the base64url round trip byte for byte');
  assert.equal(resume.get('style'), 'Cartoon');
});

test('state contract: the client ships with the feature flag OFF (a real App ID must never be committed by accident)', function () {
  assert.equal(loadClientConfig().isFacebookLoginConfigured(), false);
});

test('state contract: an over-budget resume string drops low-priority params but NEVER the caption or resume=1', function () {
  var client = loadClientConfig();
  var longCaption = 'x'.repeat(4000);
  var trimmed = client.trimResumeParams('?resume=1&style=Cartoon&mode=record&caption=' + longCaption + '&distinct_id=abc&fbc=fb.1.1.2&fbp=fb.1.1.3&types=a,b');
  var params = new URLSearchParams(trimmed);

  assert.equal(params.get('resume'), '1', 'dropping resume=1 would eject the visitor from the funnel entirely');
  assert.equal(params.get('caption'), longCaption, 'dropping the caption would land them back with an empty dream');
  assert.equal(params.get('fbp'), null, 'attribution params are the right things to drop first');
  assert.equal(params.get('distinct_id'), null);
});

test('state contract: a normal-sized resume string is left completely intact', function () {
  var client = loadClientConfig();
  var params = new URLSearchParams(client.trimResumeParams('?resume=1&style=Cartoon&caption=a+short+dream&distinct_id=abc&fbc=fb.1.1.2'));
  assert.deepEqual(Array.from(params.keys()).sort(), ['caption', 'distinct_id', 'fbc', 'resume', 'style']);
});

test('state contract: our own return-trip markers are never carried back out into a new state', function () {
  var client = loadClientConfig();
  var params = new URLSearchParams(client.trimResumeParams('?resume=1&caption=hi&bt=STALE&fb_error=csrf&fb_needs_email=MARKER'));
  assert.equal(params.get('bt'), null);
  assert.equal(params.get('fb_error'), null);
  assert.equal(params.get('fb_needs_email'), null);
  assert.equal(params.get('caption'), 'hi');
});

test('needs-email completion: per-IP daily rate limit applies', async function () {
  process.env.MAX_FACEBOOK_COMPLETIONS_PER_IP_PER_DAY = '1';
  freshModules();
  var marker = await markerForNoEmailUser('6660007');
  var complete = require('../netlify/functions/facebook-complete-signup').handler;
  var ip = nextIp();
  await complete(fakeEvent({ method: 'POST', ip: ip, body: { token: marker, email: 'limited1@example.com' } }));
  var second = await complete(fakeEvent({ method: 'POST', ip: ip, body: { token: marker, email: 'limited2@example.com' } }));
  assert.equal(second.statusCode, 429);
  assert.match(JSON.parse(second.body).error, /^E7: rate_limited/);
});
