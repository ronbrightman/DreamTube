// test/resend-bounce-webhook.test.js
//
// Covers netlify/functions/resend-bounce-webhook.js and
// netlify/functions/lib/resend-webhook-verify.js — the "Bounced first
// sends flag the address as bad" half of tracker item
// for-product-build-passwordless-signup-fo-at2fko.
//
// Same technique test/dream-webhook.test.js uses for fal's ED25519
// webhook signature (lib/fal-webhook-verify.js): compute a REAL,
// correctly-shaped Svix/HMAC-SHA256 signature locally with a known test
// secret, so the tests exercise the actual verification algorithm end to
// end rather than stubbing it away — there's no real Resend webhook
// secret available in this sandbox (see resend-bounce-webhook.js's own
// header comment on why), but the algorithm itself (Svix's own
// documented, standard HMAC-SHA256 construction) needs no live account to
// test against.
// Run with: node --test test/

var test = require('node:test');
var assert = require('node:assert/strict');
var crypto = require('crypto');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var resendWebhookVerify = require('../netlify/functions/lib/resend-webhook-verify');

var TEST_SECRET_RAW = crypto.randomBytes(24); // the actual HMAC key
var TEST_SECRET = 'whsec_' + TEST_SECRET_RAW.toString('base64');

/** Builds a real, correctly-signed Svix-style webhook request for `body` (a JS object, JSON-stringified). Returns { rawBody, headers }. */
function signRequest(body, opts) {
  opts = opts || {};
  var rawBody = JSON.stringify(body);
  var svixId = opts.svixId || 'msg_test123';
  var svixTimestamp = String(opts.timestamp || Math.floor(Date.now() / 1000));
  var signedContent = svixId + '.' + svixTimestamp + '.' + rawBody;
  var signature = crypto.createHmac('sha256', TEST_SECRET_RAW).update(signedContent, 'utf8').digest('base64');
  var svixSignature = opts.signatureOverride || ('v1,' + signature);
  return {
    rawBody: rawBody,
    headers: {
      'svix-id': svixId,
      'svix-timestamp': svixTimestamp,
      'svix-signature': svixSignature
    }
  };
}

function bouncedPayload(overrides) {
  return Object.assign({
    type: 'email.bounced',
    created_at: new Date().toISOString(),
    data: Object.assign({
      email_id: 'test-email-id',
      to: ['bounced@example.com'],
      from: 'DreamTube <dreams@dreamtube.life>',
      subject: 'Your DreamTube verification code',
      bounce: { type: 'Permanent', subType: 'Suppressed', message: 'hard bounce' }
    }, overrides && overrides.data)
  }, overrides && overrides.type ? { type: overrides.type } : {});
}

test.beforeEach(function () {
  mockBlobs.reset();
});

// ===== lib/resend-webhook-verify.js — pure algorithm coverage =====

test('resend-webhook-verify: a correctly-signed request verifies true', function () {
  var signed = signRequest({ hello: 'world' });
  var result = resendWebhookVerify.verifySignature(signed.headers, signed.rawBody, TEST_SECRET);
  assert.equal(result.ok, true);
});

test('resend-webhook-verify: a tampered body fails verification', function () {
  var signed = signRequest({ hello: 'world' });
  var result = resendWebhookVerify.verifySignature(signed.headers, '{"hello":"tampered"}', TEST_SECRET);
  assert.equal(result.ok, false);
});

test('resend-webhook-verify: the wrong secret fails verification', function () {
  var signed = signRequest({ hello: 'world' });
  var wrongSecret = 'whsec_' + crypto.randomBytes(24).toString('base64');
  var result = resendWebhookVerify.verifySignature(signed.headers, signed.rawBody, wrongSecret);
  assert.equal(result.ok, false);
});

test('resend-webhook-verify: a stale timestamp outside the clock-skew window is rejected', function () {
  var staleTimestamp = Math.floor(Date.now() / 1000) - resendWebhookVerify.MAX_CLOCK_SKEW_SECONDS - 60;
  var signed = signRequest({ hello: 'world' }, { timestamp: staleTimestamp });
  var result = resendWebhookVerify.verifySignature(signed.headers, signed.rawBody, TEST_SECRET);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'timestamp_out_of_range');
});

test('resend-webhook-verify: missing signature headers are rejected', function () {
  var result = resendWebhookVerify.verifySignature({}, '{}', TEST_SECRET);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'missing_signature_headers');
});

test('resend-webhook-verify: a multi-signature svix-signature header (key rotation) verifies if ANY entry matches', function () {
  var signed = signRequest({ hello: 'world' });
  var fakeOldSig = 'v1,' + Buffer.from('not-the-real-signature').toString('base64');
  signed.headers['svix-signature'] = fakeOldSig + ' ' + signed.headers['svix-signature'];
  var result = resendWebhookVerify.verifySignature(signed.headers, signed.rawBody, TEST_SECRET);
  assert.equal(result.ok, true);
});

test('resend-webhook-verify: missing/malformed secret is rejected without throwing', function () {
  var signed = signRequest({ hello: 'world' });
  var result = resendWebhookVerify.verifySignature(signed.headers, signed.rawBody, 'not-a-whsec-secret');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'missing_or_malformed_secret');
});

// ===== resend-bounce-webhook.js — the handler end to end =====

test('resend-bounce-webhook: a correctly-signed hard-bounce (Permanent) event flags the matching account', async function () {
  process.env.RESEND_WEBHOOK_SECRET = TEST_SECRET;
  var accountStore = require('../netlify/functions/lib/account-store');
  await accountStore.createAccount(fakeEvent({ method: 'POST' }), { username: 'toby', password: null, email: 'bounced@example.com', emailVerified: false });

  var signed = signRequest(bouncedPayload());
  var handler = require('../netlify/functions/resend-bounce-webhook').handler;
  var res = await handler(fakeEvent({ method: 'POST', headers: signed.headers, body: signed.rawBody }));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).ok, true);

  var record = await accountStore.getByUsername(fakeEvent({ method: 'POST' }), 'toby');
  assert.equal(record.emailBounced, true);

  delete process.env.RESEND_WEBHOOK_SECRET;
});

test('resend-bounce-webhook: a Transient (soft) bounce does NOT flag the account -- only a hard/Permanent bounce counts', async function () {
  process.env.RESEND_WEBHOOK_SECRET = TEST_SECRET;
  var accountStore = require('../netlify/functions/lib/account-store');
  await accountStore.createAccount(fakeEvent({ method: 'POST' }), { username: 'uma', password: null, email: 'soft-bounce@example.com', emailVerified: false });

  var signed = signRequest(bouncedPayload({ data: { bounce: { type: 'Transient', subType: 'General', message: 'mailbox full' } } }));
  var handler = require('../netlify/functions/resend-bounce-webhook').handler;
  var res = await handler(fakeEvent({ method: 'POST', headers: signed.headers, body: signed.rawBody }));
  assert.equal(res.statusCode, 200);

  var record = await accountStore.getByUsername(fakeEvent({ method: 'POST' }), 'uma');
  assert.equal(record.emailBounced, undefined, 'a soft/transient bounce must never flag the address as bad');

  delete process.env.RESEND_WEBHOOK_SECRET;
});

test('resend-bounce-webhook: an event type other than email.bounced is acknowledged and ignored', async function () {
  process.env.RESEND_WEBHOOK_SECRET = TEST_SECRET;
  var payload = { type: 'email.delivered', data: { to: ['someone@example.com'] } };
  var signed = signRequest(payload);
  var handler = require('../netlify/functions/resend-bounce-webhook').handler;
  var res = await handler(fakeEvent({ method: 'POST', headers: signed.headers, body: signed.rawBody }));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).ignored, true);
  delete process.env.RESEND_WEBHOOK_SECRET;
});

test('resend-bounce-webhook: a bounce for an address with no matching account is a harmless no-op, not an error', async function () {
  process.env.RESEND_WEBHOOK_SECRET = TEST_SECRET;
  var signed = signRequest(bouncedPayload({ data: { to: ['nobody-registered@example.com'] } }));
  var handler = require('../netlify/functions/resend-bounce-webhook').handler;
  var res = await handler(fakeEvent({ method: 'POST', headers: signed.headers, body: signed.rawBody }));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).ok, true);
  delete process.env.RESEND_WEBHOOK_SECRET;
});

test('resend-bounce-webhook: a tampered/unsigned request is rejected with 401, never processed', async function () {
  process.env.RESEND_WEBHOOK_SECRET = TEST_SECRET;
  var accountStore = require('../netlify/functions/lib/account-store');
  await accountStore.createAccount(fakeEvent({ method: 'POST' }), { username: 'vera', password: null, email: 'forged@example.com', emailVerified: false });

  var signed = signRequest(bouncedPayload({ data: { to: ['forged@example.com'] } }));
  var handler = require('../netlify/functions/resend-bounce-webhook').handler;
  // Tamper with the body AFTER signing -- the signature no longer matches.
  var res = await handler(fakeEvent({ method: 'POST', headers: signed.headers, body: signed.rawBody.replace('Permanent', 'Transient') }));
  assert.equal(res.statusCode, 401);

  var record = await accountStore.getByUsername(fakeEvent({ method: 'POST' }), 'vera');
  assert.equal(record.emailBounced, undefined, 'an unverified/forged request must never be able to flag an account');

  delete process.env.RESEND_WEBHOOK_SECRET;
});

test('resend-bounce-webhook: missing RESEND_WEBHOOK_SECRET -> 500 E2; non-POST -> 405 E1', async function () {
  delete process.env.RESEND_WEBHOOK_SECRET;
  var handler = require('../netlify/functions/resend-bounce-webhook').handler;
  var res = await handler(fakeEvent({ method: 'POST', body: '{}' }));
  assert.equal(res.statusCode, 500);
  assert.match(JSON.parse(res.body).error, /^E2: missing_webhook_secret/);

  var wrongMethod = await handler(fakeEvent({ method: 'GET' }));
  assert.equal(wrongMethod.statusCode, 405);
});
