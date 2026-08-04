// test/dream-webhook.test.js
//
// Covers netlify/functions/dream-webhook.js (fal.ai's queue webhook
// callback — the abandoned-dream re-engagement's event-driven trigger)
// and netlify/functions/lib/fal-webhook-verify.js's ED25519 signature
// verification, using a real locally-generated Ed25519 keypair standing
// in for fal's own JWKS (fetchJwks() is monkeypatched below rather than
// hitting the real https://rest.alpha.fal.ai/.well-known/jwks.json in
// every test run).

var test = require('node:test');
var assert = require('node:assert/strict');
var crypto = require('crypto');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var falWebhookVerify = require('../netlify/functions/lib/fal-webhook-verify');
var pendingDreams = require('../netlify/functions/lib/pending-dreams');
var handler = require('../netlify/functions/dream-webhook').handler;

var realFetch = global.fetch;

// ----- A real Ed25519 test keypair, standing in for one of fal's JWKS entries -----
var keyPair = crypto.generateKeyPairSync('ed25519');
function publicJwk() {
  var jwk = keyPair.publicKey.export({ format: 'jwk' });
  return { kty: 'OKP', crv: 'Ed25519', x: jwk.x };
}

function signRequest(requestId, userId, timestamp, rawBody) {
  var bodyHash = crypto.createHash('sha256').update(Buffer.from(rawBody, 'utf8')).digest('hex');
  var message = Buffer.from([requestId, userId, timestamp, bodyHash].join('\n'), 'utf8');
  var signature = crypto.sign(null, message, keyPair.privateKey);
  return signature.toString('hex');
}

function webhookEvent(opts) {
  var bodyObj = opts.bodyObj;
  var rawBody = JSON.stringify(bodyObj);
  var timestamp = String(opts.timestamp || Math.floor(Date.now() / 1000));
  var requestId = opts.requestId || 'req-1';
  var userId = opts.userId || 'user-1';
  var signature = opts.badSignature ? 'deadbeef'.repeat(16) : signRequest(requestId, userId, timestamp, rawBody);
  return {
    httpMethod: 'POST',
    headers: {
      host: 'dreamtube1.netlify.app',
      'X-Fal-Webhook-Request-Id': requestId,
      'X-Fal-Webhook-User-Id': userId,
      'X-Fal-Webhook-Timestamp': timestamp,
      'X-Fal-Webhook-Signature': signature
    },
    queryStringParameters: opts.query || {},
    body: rawBody
  };
}

test.beforeEach(function () {
  mockBlobs.reset();
  falWebhookVerify.resetJwksCacheForTests();
  global.fetch = async function (url) {
    if (String(url).indexOf('jwks') !== -1) {
      return { ok: true, status: 200, json: async function () { return { keys: [publicJwk()] }; } };
    }
    // Resend / WhatsApp calls in these tests -- default to a harmless OK.
    return { ok: true, status: 200, json: async function () { return {}; } };
  };
  delete process.env.RESEND_API_KEY;
});
test.after(function () { global.fetch = realFetch; });

// ----- lib/fal-webhook-verify.js unit coverage -----

test('verifySignature: valid signature verifies true', function () {
  var body = JSON.stringify({ status: 'OK' });
  var ts = Math.floor(Date.now() / 1000);
  var sig = signRequest('r1', 'u1', String(ts), body);
  var result = falWebhookVerify.verifySignature(
    { 'x-fal-webhook-request-id': 'r1', 'x-fal-webhook-user-id': 'u1', 'x-fal-webhook-timestamp': String(ts), 'x-fal-webhook-signature': sig },
    body, [publicJwk()], ts
  );
  assert.equal(result.ok, true);
});

test('verifySignature: tampered body fails verification', function () {
  var body = JSON.stringify({ status: 'OK' });
  var ts = Math.floor(Date.now() / 1000);
  var sig = signRequest('r1', 'u1', String(ts), body);
  var result = falWebhookVerify.verifySignature(
    { 'x-fal-webhook-request-id': 'r1', 'x-fal-webhook-user-id': 'u1', 'x-fal-webhook-timestamp': String(ts), 'x-fal-webhook-signature': sig },
    JSON.stringify({ status: 'ERROR' }), [publicJwk()], ts
  );
  assert.equal(result.ok, false);
});

test('verifySignature: timestamp too far in the past/future fails (replay protection)', function () {
  var body = JSON.stringify({ status: 'OK' });
  var ts = Math.floor(Date.now() / 1000) - 1000; // > 300s skew
  var sig = signRequest('r1', 'u1', String(ts), body);
  var result = falWebhookVerify.verifySignature(
    { 'x-fal-webhook-request-id': 'r1', 'x-fal-webhook-user-id': 'u1', 'x-fal-webhook-timestamp': String(ts), 'x-fal-webhook-signature': sig },
    body, [publicJwk()], Math.floor(Date.now() / 1000)
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'timestamp_out_of_range');
});

test('verifySignature: missing headers fails cleanly, no throw', function () {
  var result = falWebhookVerify.verifySignature({}, '{}', [publicJwk()]);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'missing_signature_headers');
});

// ----- dream-webhook.js handler coverage -----

test('wrong method -> E1', async function () {
  var res = await handler({ httpMethod: 'GET', headers: {}, queryStringParameters: {} });
  assert.equal(res.statusCode, 405);
});

test('missing pendingId -> E2', async function () {
  var res = await handler(webhookEvent({ bodyObj: { status: 'OK' }, query: {} }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E2:/);
});

test('bad signature -> E3, rejected before any record is touched', async function () {
  var res = await handler(webhookEvent({ bodyObj: { status: 'OK' }, query: { pendingId: 'pd123' }, badSignature: true }));
  assert.equal(res.statusCode, 401);
  assert.match(JSON.parse(res.body).error, /^E3:/);
});

test('unknown pendingId -> still 200 (idempotent ack), nothing to notify', async function () {
  var res = await handler(webhookEvent({ bodyObj: { status: 'OK', payload: { video: { url: 'https://x/v.mp4' } } }, query: { pendingId: 'does-not-exist' } }));
  assert.equal(res.statusCode, 200);
});

test('successful completion: marks the record ready+notified and sends the ready email with a real claim link', async function () {
  var record = await pendingDreams.create({}, { email: 'claimant@example.com', caption: 'a dream', style: 'Cinematic' });
  process.env.RESEND_API_KEY = 'test-resend-key';
  var sentTo = null, sentHtml = null;
  global.fetch = async function (url, opts) {
    if (String(url).indexOf('jwks') !== -1) return { ok: true, status: 200, json: async function () { return { keys: [publicJwk()] }; } };
    if (String(url).indexOf('resend.com') !== -1) {
      var body = JSON.parse(opts.body);
      sentTo = body.to;
      sentHtml = body.html;
      return { ok: true, status: 200, json: async function () { return { id: 'email-1' }; } };
    }
    return { ok: true, status: 200, json: async function () { return {}; } };
  };

  var res = await handler(webhookEvent({
    bodyObj: { status: 'OK', payload: { video: { url: 'https://cdn.fal/finished.mp4' } } },
    query: { pendingId: record.id }
  }));
  assert.equal(res.statusCode, 200);

  var updated = await pendingDreams.get({}, record.id);
  assert.equal(updated.status, 'notified');
  assert.equal(updated.videoUrl, 'https://cdn.fal/finished.mp4');
  assert.ok(updated.readyAt);
  assert.ok(updated.notifiedAt);

  assert.deepEqual(sentTo, ['claimant@example.com']);
  assert.match(sentHtml, /claim-dream\.html\?pending=/);
  assert.match(sentHtml, new RegExp(record.id));

  // DESIGN + UNSUBSCRIBE (tracker item
  // for-product-email-redesign-unsubscribe-l-16ysmp): this is one of the
  // two retention/marketing sends in scope -- night-aesthetic shell (logo
  // header) and a real, working unsubscribe link.
  assert.match(sentHtml, /<img src="https:\/\/dreamtube1\.netlify\.app\/assets\/logo-v4\.png"/, 'redesigned template must carry the app\'s own logo in its header');
  assert.match(sentHtml, /\/\.netlify\/functions\/unsubscribe-email\?email=claimant%40example\.com&amp;token=[0-9a-f]{64}/, 'redesigned template must carry a real, per-recipient unsubscribe link');
});

// SUPPRESSION (tracker item for-product-email-redesign-unsubscribe-l-16ysmp):
// this is the second of the two retention/marketing senders in scope --
// end-to-end proof the abandoned-dream webhook itself actually skips a
// real send for a suppressed email (see test/send-first-dream-email.test.js
// for the first-dream-retention-email sender's own equivalent coverage).
test('an unsubscribed (suppressed) email is skipped by the webhook -- no Resend call, but the rest of the flow (re-host, markNotified) still completes', async function () {
  var record = await pendingDreams.create({}, { email: 'unsubscribed@example.com', caption: 'a dream', style: 'Cinematic' });
  var emailSuppressionStore = require('../netlify/functions/lib/email-suppression-store');
  await emailSuppressionStore.suppress({}, 'unsubscribed@example.com');

  process.env.RESEND_API_KEY = 'test-resend-key';
  var emailCalls = 0;
  global.fetch = async function (url) {
    if (String(url).indexOf('jwks') !== -1) return { ok: true, status: 200, json: async function () { return { keys: [publicJwk()] }; } };
    if (String(url).indexOf('resend.com') !== -1) { emailCalls++; }
    return { ok: true, status: 200, json: async function () { return {}; } };
  };

  var res = await handler(webhookEvent({
    bodyObj: { status: 'OK', payload: { video: { url: 'https://cdn.fal/finished.mp4' } } },
    query: { pendingId: record.id }
  }));
  assert.equal(res.statusCode, 200);
  assert.equal(emailCalls, 0, 'a suppressed email must never actually be sent to');

  var updated = await pendingDreams.get({}, record.id);
  assert.equal(updated.status, 'notified', 'the rest of the webhook flow (re-host, markNotified) must still complete normally even when the email itself is skipped');
  assert.equal(updated.videoUrl, 'https://cdn.fal/finished.mp4');
});

test('an already-claimed record (real signup finished first) records the video but sends NO email', async function () {
  var record = await pendingDreams.create({}, { email: 'already-signed-up@example.com', caption: 'a dream', style: 'Cinematic' });
  await pendingDreams.markClaimed({}, record.id);
  process.env.RESEND_API_KEY = 'test-resend-key';
  var emailCalls = 0;
  global.fetch = async function (url) {
    if (String(url).indexOf('jwks') !== -1) return { ok: true, status: 200, json: async function () { return { keys: [publicJwk()] }; } };
    if (String(url).indexOf('resend.com') !== -1) { emailCalls++; }
    return { ok: true, status: 200, json: async function () { return {}; } };
  };

  var res = await handler(webhookEvent({
    bodyObj: { status: 'OK', payload: { video: { url: 'https://cdn.fal/finished.mp4' } } },
    query: { pendingId: record.id }
  }));
  assert.equal(res.statusCode, 200);
  assert.equal(emailCalls, 0);

  var updated = await pendingDreams.get({}, record.id);
  assert.equal(updated.status, 'claimed'); // never downgraded back to 'ready'
  assert.equal(updated.videoUrl, 'https://cdn.fal/finished.mp4');
});

test('a fal ERROR status marks the record failed, no email sent', async function () {
  var record = await pendingDreams.create({}, { email: 'failure@example.com', caption: 'a dream', style: 'Cinematic' });
  process.env.RESEND_API_KEY = 'test-resend-key';
  var emailCalls = 0;
  global.fetch = async function (url) {
    if (String(url).indexOf('jwks') !== -1) return { ok: true, status: 200, json: async function () { return { keys: [publicJwk()] }; } };
    if (String(url).indexOf('resend.com') !== -1) { emailCalls++; }
    return { ok: true, status: 200, json: async function () { return {}; } };
  };

  var res = await handler(webhookEvent({
    bodyObj: { status: 'ERROR', error: 'content_policy_violation', payload: {} },
    query: { pendingId: record.id }
  }));
  assert.equal(res.statusCode, 200);
  assert.equal(emailCalls, 0);
  var updated = await pendingDreams.get({}, record.id);
  assert.equal(updated.status, 'failed');
  assert.match(updated.failedReason, /content_policy_violation/);
});

test('a duplicate delivery for an already-notified record is a harmless no-op (idempotent), does not re-send', async function () {
  var record = await pendingDreams.create({}, { email: 'dup@example.com', caption: 'a dream', style: 'Cinematic' });
  await pendingDreams.markReady({}, record.id, 'https://cdn.fal/v.mp4');
  await pendingDreams.markNotified({}, record.id);
  process.env.RESEND_API_KEY = 'test-resend-key';
  var emailCalls = 0;
  global.fetch = async function (url) {
    if (String(url).indexOf('jwks') !== -1) return { ok: true, status: 200, json: async function () { return { keys: [publicJwk()] }; } };
    if (String(url).indexOf('resend.com') !== -1) { emailCalls++; }
    return { ok: true, status: 200, json: async function () { return {}; } };
  };

  var res = await handler(webhookEvent({
    bodyObj: { status: 'OK', payload: { video: { url: 'https://cdn.fal/v.mp4' } } },
    query: { pendingId: record.id }
  }));
  assert.equal(res.statusCode, 200);
  assert.equal(emailCalls, 0);
});

test('missing RESEND_API_KEY: still marks ready/notified, logs and skips the email rather than failing the webhook ack', async function () {
  var record = await pendingDreams.create({}, { email: 'no-resend-key@example.com', caption: 'a dream', style: 'Cinematic' });
  // RESEND_API_KEY deliberately left unset (see beforeEach's delete).
  var res = await handler(webhookEvent({
    bodyObj: { status: 'OK', payload: { video: { url: 'https://cdn.fal/v.mp4' } } },
    query: { pendingId: record.id }
  }));
  assert.equal(res.statusCode, 200);
  var updated = await pendingDreams.get({}, record.id);
  assert.equal(updated.status, 'notified');
});

// ----- Best-effort re-host (tracker item
// for-product-owner-media-library-page-fou-1fwxaw): this webhook is a
// GENUINELY SEPARATE completion path from video-status.js's checkFalStatus
// (see this file's own header comment) and must independently re-host the
// video it receives directly in the payload, keyed by the fal request_id. -----

test('a successful completion re-hosts the video and stores the DURABLE url on the pending record, not fal\'s raw one', async function () {
  var record = await pendingDreams.create({}, { email: 'rehost@example.com', caption: 'a dream', style: 'Cinematic' });
  var bytes = new ArrayBuffer(12);
  global.fetch = async function (url) {
    if (String(url).indexOf('jwks') !== -1) return { ok: true, status: 200, json: async function () { return { keys: [publicJwk()] }; } };
    if (String(url) === 'https://cdn.fal/finished.mp4') {
      return {
        ok: true, status: 200,
        headers: { get: function (name) { return name.toLowerCase() === 'content-type' ? 'video/mp4' : null; } },
        arrayBuffer: async function () { return bytes; }
      };
    }
    return { ok: true, status: 200, json: async function () { return {}; } };
  };

  var res = await handler(webhookEvent({
    bodyObj: { status: 'OK', request_id: 'req-webhook-rehost-1', payload: { video: { url: 'https://cdn.fal/finished.mp4' } } },
    query: { pendingId: record.id }
  }));
  assert.equal(res.statusCode, 200);

  var updated = await pendingDreams.get({}, record.id);
  assert.equal(updated.videoUrl, '/.netlify/functions/video-file?key=req-webhook-rehost-1');

  var { getStore } = require('@netlify/blobs');
  var stored = await getStore({ name: 'dreamtube-videos' }).getWithMetadata('req-webhook-rehost-1');
  assert.equal(stored.data, bytes);
});

test('when the re-host download fails, the pending record still gets fal\'s raw url -- never blocks the webhook ack or the claim flow', async function () {
  var record = await pendingDreams.create({}, { email: 'rehostfail@example.com', caption: 'a dream', style: 'Cinematic' });
  global.fetch = async function (url) {
    if (String(url).indexOf('jwks') !== -1) return { ok: true, status: 200, json: async function () { return { keys: [publicJwk()] }; } };
    if (String(url) === 'https://cdn.fal/finished.mp4') return { ok: false, status: 500 };
    return { ok: true, status: 200, json: async function () { return {}; } };
  };

  var res = await handler(webhookEvent({
    bodyObj: { status: 'OK', request_id: 'req-webhook-rehost-fail', payload: { video: { url: 'https://cdn.fal/finished.mp4' } } },
    query: { pendingId: record.id }
  }));
  assert.equal(res.statusCode, 200);

  var updated = await pendingDreams.get({}, record.id);
  assert.equal(updated.videoUrl, 'https://cdn.fal/finished.mp4');
});

test('an already-claimed record also gets the RE-HOSTED url in its bookkeeping-only update', async function () {
  var record = await pendingDreams.create({}, { email: 'claimedrehost@example.com', caption: 'a dream', style: 'Cinematic' });
  await pendingDreams.markClaimed({}, record.id);
  var bytes = new ArrayBuffer(6);
  global.fetch = async function (url) {
    if (String(url).indexOf('jwks') !== -1) return { ok: true, status: 200, json: async function () { return { keys: [publicJwk()] }; } };
    if (String(url) === 'https://cdn.fal/finished.mp4') {
      return {
        ok: true, status: 200,
        headers: { get: function (name) { return name.toLowerCase() === 'content-type' ? 'video/mp4' : null; } },
        arrayBuffer: async function () { return bytes; }
      };
    }
    return { ok: true, status: 200, json: async function () { return {}; } };
  };

  var res = await handler(webhookEvent({
    bodyObj: { status: 'OK', request_id: 'req-webhook-rehost-claimed', payload: { video: { url: 'https://cdn.fal/finished.mp4' } } },
    query: { pendingId: record.id }
  }));
  assert.equal(res.statusCode, 200);

  var updated = await pendingDreams.get({}, record.id);
  assert.equal(updated.status, 'claimed');
  assert.equal(updated.videoUrl, '/.netlify/functions/video-file?key=req-webhook-rehost-claimed');
});
