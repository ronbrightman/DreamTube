// test/send-winback-batch.test.js
//
// Covers netlify/functions/send-winback-batch.js (the owner-gated, hard-
// capped win-back batch sender) plus its two libs (lib/winback-email-
// sender.js's send choke point + lib/winback-email-store.js's once-ever CAS
// marker). Same test shape as test/send-unwatched-dream-nudges.test.js:
// global.fetch is spied (split by URL — Resend vs PostHog) and
// test/helpers/mock-blobs.js stands in for Blobs, so this proves the
// selection/cap/dedup/exclusion/owner-gating LOGIC and the exact Resend
// request built, NOT a real delivered email. No real email is ever sent.
//
// Proven safeguards:
//   - the HARD CAP is enforced (never sends more than `limit`);
//   - suppressed/unsubscribed recipients are skipped;
//   - the once-ever CAS marker prevents a second send to the same account
//     across two batch runs (and at the sender choke point directly);
//   - founder + test/@example.com addresses are excluded;
//   - lapsed selection (recently-updated accounts are not sent);
//   - owner-gating (non-owner email -> 403, plus method/limit/config guards).
//
// Run with: node --test test/

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var { markInstalledFetchAsTestDouble } = require('./helpers/fetch-double');

var { getStore } = require('@netlify/blobs');
var emailSuppressionStore = require('../netlify/functions/lib/email-suppression-store');
var winbackStore = require('../netlify/functions/lib/winback-email-store');
var winbackSender = require('../netlify/functions/lib/winback-email-sender');
var sendWinback = require('../netlify/functions/send-winback-batch');

var realFetch = global.fetch;
var OWNER = 'ronbrightman@gmail.com';
var DAY_MS = 24 * 60 * 60 * 1000;

/** Same split-by-URL fetch spy shape as the sibling email tests. */
function installFetchSpy() {
  var resendCalls = [];
  var posthogCalls = [];
  global.fetch = async function (url, opts) {
    var urlStr = String(url);
    var body = opts && opts.body ? JSON.parse(opts.body) : null;
    if (urlStr.indexOf('api.resend.com') !== -1) {
      resendCalls.push({ url: urlStr, body: body, headers: (opts && opts.headers) || {} });
      return { ok: true, status: 200, json: async function () { return {}; } };
    }
    if (urlStr.indexOf('/capture/') !== -1) {
      posthogCalls.push({ url: urlStr, body: body });
      return { ok: true, status: 200, json: async function () { return {}; } };
    }
    throw new Error('unexpected fetch to ' + urlStr);
  };
  markInstalledFetchAsTestDouble();
  return { resendCalls: resendCalls, posthogCalls: posthogCalls };
}

/** Seeds an account record directly into the mock 'dreamtube-accounts' store with an explicit updatedAt (so we can control lapsed-ness). */
async function seedAccount(fields) {
  var username = String(fields.username).trim().toLowerCase();
  var email = fields.email === undefined ? (username + '@real-user.com') : String(fields.email).trim().toLowerCase();
  var record = {
    username: username,
    email: email,
    password: 'pw',
    updatedAt: fields.updatedAt,
    emailVerified: true
  };
  var s = getStore({ name: 'dreamtube-accounts' });
  await s.setJSON('u:' + username, record);
  if (email) await s.setJSON('e:' + email, username);
  return record;
}

/** A lapsed timestamp (older than the 30-day default window). */
function lapsedTs() { return Date.now() - 40 * DAY_MS; }
/** A fresh timestamp (inside the window — not lapsed). */
function freshTs() { return Date.now() - 5 * DAY_MS; }

test.beforeEach(function () {
  global.fetch = realFetch;
  mockBlobs.reset();
  process.env.RESEND_API_KEY = 'resend-test-key';
  process.env.OWNER_EMAIL = OWNER;
  delete process.env.WINBACK_LAPSED_DAYS;
});

test.afterEach(function () {
  global.fetch = realFetch;
});

// ===== HARD CAP =====

test('hard cap: with more eligible users than `limit`, sends at most `limit` and never more', async function () {
  var spy = installFetchSpy();
  for (var i = 0; i < 5; i++) {
    await seedAccount({ username: 'lapsed' + i, email: 'lapsed' + i + '@real-user.com', updatedAt: lapsedTs() });
  }

  var summary = await sendWinback.selectAndSend(fakeEvent({ method: 'POST' }), { limit: 2, ownerEmail: OWNER });

  assert.equal(summary.selected, 2, 'selects exactly the cap');
  assert.equal(summary.sent, 2, 'sends exactly the cap');
  assert.equal(spy.resendCalls.length, 2, 'Resend called at most `limit` times');
  assert.ok(spy.resendCalls.length <= 2, 'never exceeds the cap');
});

test('hard cap: absolute ceiling of 50 is applied by the handler even if a larger limit is requested', async function () {
  installFetchSpy();
  var event = fakeEvent({ method: 'POST', body: { email: OWNER, limit: 500 } });
  var res = await sendWinback.handler(event);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).limit, 50, 'clamped to the 50 ceiling');
});

// ===== SUPPRESSION =====

test('suppressed/unsubscribed users are skipped and never sent', async function () {
  var spy = installFetchSpy();
  await seedAccount({ username: 'unsub', email: 'unsub@real-user.com', updatedAt: lapsedTs() });
  await emailSuppressionStore.suppress(fakeEvent({ method: 'POST' }), 'unsub@real-user.com', 'user_unsubscribed');

  var summary = await sendWinback.selectAndSend(fakeEvent({ method: 'POST' }), { limit: 10, ownerEmail: OWNER });

  assert.equal(summary.sent, 0);
  assert.equal(summary.skipped.suppressed, 1);
  assert.equal(spy.resendCalls.length, 0, 'no send to a suppressed recipient');
});

// ===== DEDUP (once-ever marker across runs) =====

test('dedup: the same account is never sent twice across two batch runs', async function () {
  var spy = installFetchSpy();
  await seedAccount({ username: 'once', email: 'once@real-user.com', updatedAt: lapsedTs() });

  var first = await sendWinback.selectAndSend(fakeEvent({ method: 'POST' }), { limit: 10, ownerEmail: OWNER });
  assert.equal(first.sent, 1, 'first run sends');

  var second = await sendWinback.selectAndSend(fakeEvent({ method: 'POST' }), { limit: 10, ownerEmail: OWNER });
  assert.equal(second.sent, 0, 'second run sends nothing');
  assert.equal(second.skipped.already_sent, 1, 'second run skips the already-sent account at selection');

  assert.equal(spy.resendCalls.length, 1, 'exactly one Resend call across both runs');
});

test('dedup at the send choke point: the CAS marker blocks a second send even if selection is bypassed', async function () {
  var spy = installFetchSpy();
  var event = fakeEvent({ method: 'POST' });

  var a = await winbackSender.sendIfEligible(event, { username: 'choke', email: 'choke@real-user.com', ownerEmail: OWNER });
  assert.equal(a.sent, true);

  var b = await winbackSender.sendIfEligible(event, { username: 'choke', email: 'choke@real-user.com', ownerEmail: OWNER });
  assert.equal(b.sent, false);
  assert.equal(b.skipped, 'already_sent');

  assert.equal(spy.resendCalls.length, 1, 'the once-ever CAS claim prevents the second send');
});

test('dedup: a failed send releases the claim so a later run can retry', async function () {
  var event = fakeEvent({ method: 'POST' });
  // First attempt: Resend rejects -> the sender must release the claim.
  global.fetch = async function (url) {
    if (String(url).indexOf('api.resend.com') !== -1) return { ok: false, status: 500, json: async function () { return {}; } };
    return { ok: true, status: 200, json: async function () { return {}; } };
  };
  markInstalledFetchAsTestDouble();
  var a = await winbackSender.sendIfEligible(event, { username: 'retry', email: 'retry@real-user.com', ownerEmail: OWNER });
  assert.equal(a.sent, false);
  assert.equal(a.skipped, 'resend_rejected');
  assert.equal(await winbackStore.hasSentWinback(event, 'retry'), false, 'claim released after a failed send');

  // Second attempt: Resend accepts -> now it sends.
  var spy = installFetchSpy();
  var b = await winbackSender.sendIfEligible(event, { username: 'retry', email: 'retry@real-user.com', ownerEmail: OWNER });
  assert.equal(b.sent, true);
  assert.equal(spy.resendCalls.length, 1);
});

// ===== FOUNDER / TEST EXCLUSION =====

test('founder + test/@example.com addresses are excluded', async function () {
  var spy = installFetchSpy();
  await seedAccount({ username: 'founder', email: OWNER, updatedAt: lapsedTs() });
  await seedAccount({ username: 'exampleuser', email: 'someone@example.com', updatedAt: lapsedTs() });
  await seedAccount({ username: 'testguy', email: 'qa@test.dreamtube.life', updatedAt: lapsedTs() });

  var summary = await sendWinback.selectAndSend(fakeEvent({ method: 'POST' }), { limit: 10, ownerEmail: OWNER });

  assert.equal(summary.sent, 0);
  assert.equal(summary.skipped.excluded, 3);
  assert.equal(spy.resendCalls.length, 0);
});

test('isExcludedEmail rule covers the founder, owner, and common test shapes', function () {
  assert.equal(winbackSender.isExcludedEmail(OWNER), true);
  assert.equal(winbackSender.isExcludedEmail('owner@company.com', 'owner@company.com'), true);
  assert.equal(winbackSender.isExcludedEmail('a@example.com'), true);
  assert.equal(winbackSender.isExcludedEmail('a@example.org'), true);
  assert.equal(winbackSender.isExcludedEmail('test@dreamtube.life'), true);
  assert.equal(winbackSender.isExcludedEmail('qa@test.foo.com'), true);
  assert.equal(winbackSender.isExcludedEmail(''), true);
  assert.equal(winbackSender.isExcludedEmail('real.person@gmail.com'), false);
});

// ===== LAPSED SELECTION =====

test('recently-active accounts are not lapsed and are skipped', async function () {
  var spy = installFetchSpy();
  await seedAccount({ username: 'freshuser', email: 'fresh@real-user.com', updatedAt: freshTs() });
  await seedAccount({ username: 'lapseduser', email: 'lapsed@real-user.com', updatedAt: lapsedTs() });

  var summary = await sendWinback.selectAndSend(fakeEvent({ method: 'POST' }), { limit: 10, ownerEmail: OWNER });

  assert.equal(summary.sent, 1, 'only the lapsed user is sent');
  assert.equal(summary.skipped.not_lapsed, 1);
  assert.equal(spy.resendCalls.length, 1);
});

test('accounts with an unknown (missing) age are skipped, not sent', async function () {
  var spy = installFetchSpy();
  await seedAccount({ username: 'noage', email: 'noage@real-user.com', updatedAt: undefined });

  var summary = await sendWinback.selectAndSend(fakeEvent({ method: 'POST' }), { limit: 10, ownerEmail: OWNER });

  assert.equal(summary.sent, 0);
  assert.equal(summary.skipped.unknown_age, 1);
  assert.equal(spy.resendCalls.length, 0);
});

test('accounts with no email are skipped', async function () {
  var spy = installFetchSpy();
  await seedAccount({ username: 'noemail', email: '', updatedAt: lapsedTs() });

  var summary = await sendWinback.selectAndSend(fakeEvent({ method: 'POST' }), { limit: 10, ownerEmail: OWNER });

  assert.equal(summary.sent, 0);
  assert.equal(summary.skipped.no_email, 1);
  assert.equal(spy.resendCalls.length, 0);
});

// ===== APPROVED COPY =====

test('the sent email carries the exact approved subject/copy + one-click unsubscribe headers', async function () {
  var spy = installFetchSpy();
  await seedAccount({ username: 'copyuser', email: 'copy@real-user.com', updatedAt: lapsedTs() });

  await sendWinback.selectAndSend(fakeEvent({ method: 'POST' }), { limit: 10, ownerEmail: OWNER });

  assert.equal(spy.resendCalls.length, 1);
  var body = spy.resendCalls[0].body;
  assert.equal(body.subject, 'Your next dream is waiting 🌙');
  assert.ok(body.html.indexOf('never really end') !== -1, 'line 1 copy present');
  assert.ok(body.html.indexOf('turn it into a video you can keep') !== -1, 'line 2 copy present');
  assert.ok(body.html.indexOf('Make a new dream') !== -1, 'CTA label present');
  // One-tap login (founder 2026-08-15): the CTA now points at the email-login
  // endpoint carrying a single-use token, redirecting (signed in) to create.html.
  assert.ok(body.html.indexOf('/.netlify/functions/email-login') !== -1, 'CTA routes through the one-tap email-login endpoint');
  assert.ok(body.html.indexOf('elt=') !== -1, 'CTA carries a single-use email-login token');
  assert.ok(body.html.indexOf('dest=%2Fcreate.html') !== -1, 'the login redirect lands the user on the canonical create page');
  assert.ok(body.html.indexOf('Sweet dreams') !== -1, 'sign-off present');
  assert.ok(body.html.indexOf('Unsubscribe') !== -1, 'footer unsubscribe link present');
  assert.ok(body.headers && body.headers['List-Unsubscribe'], 'RFC 8058 List-Unsubscribe header present');
});

test('a winback_email_sent PostHog event fires on a real send', async function () {
  var spy = installFetchSpy();
  await seedAccount({ username: 'telemetry', email: 'tele@real-user.com', updatedAt: lapsedTs() });

  await sendWinback.selectAndSend(fakeEvent({ method: 'POST' }), { limit: 10, ownerEmail: OWNER });

  var sentEvents = spy.posthogCalls.filter(function (c) { return c.body && c.body.event === 'winback_email_sent'; });
  assert.equal(sentEvents.length, 1);
  assert.equal(sentEvents[0].body.distinct_id, 'telemetry');
});

// ===== OWNER GATING + INPUT VALIDATION =====

test('owner-gating: a non-owner email is rejected with 403 and sends nothing', async function () {
  var spy = installFetchSpy();
  await seedAccount({ username: 'victim', email: 'victim@real-user.com', updatedAt: lapsedTs() });

  var res = await sendWinback.handler(fakeEvent({ method: 'POST', body: { email: 'attacker@evil.com', limit: 10 } }));
  assert.equal(res.statusCode, 403);
  assert.equal(spy.resendCalls.length, 0, 'a forbidden request never sends');
});

test('owner-gating: a matching owner email is accepted', async function () {
  installFetchSpy();
  var res = await sendWinback.handler(fakeEvent({ method: 'POST', body: { email: OWNER } }));
  assert.equal(res.statusCode, 200);
  var summary = JSON.parse(res.body);
  assert.equal(summary.ok, true);
  assert.equal(summary.limit, 10, 'default limit is 10');
});

test('a non-POST verb is rejected with 405', async function () {
  var res = await sendWinback.handler(fakeEvent({ method: 'GET' }));
  assert.equal(res.statusCode, 405);
});

test('a missing OWNER_EMAIL configuration is rejected with 500', async function () {
  delete process.env.OWNER_EMAIL;
  var res = await sendWinback.handler(fakeEvent({ method: 'POST', body: { email: OWNER } }));
  assert.equal(res.statusCode, 500);
});

test('invalid JSON is rejected with 400', async function () {
  var res = await sendWinback.handler(fakeEvent({ method: 'POST', body: 'not json' }));
  assert.equal(res.statusCode, 400);
});

test('an invalid limit (non-positive-integer) is rejected with 400', async function () {
  var zero = await sendWinback.handler(fakeEvent({ method: 'POST', body: { email: OWNER, limit: 0 } }));
  assert.equal(zero.statusCode, 400);
  var frac = await sendWinback.handler(fakeEvent({ method: 'POST', body: { email: OWNER, limit: 3.5 } }));
  assert.equal(frac.statusCode, 400);
  var str = await sendWinback.handler(fakeEvent({ method: 'POST', body: { email: OWNER, limit: '5' } }));
  assert.equal(str.statusCode, 400);
});
