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
var accountStore = require('../netlify/functions/lib/account-store');
var dreamStore = require('../netlify/functions/lib/dream-store');
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
  assert.match(sentHtml, /<img src="https:\/\/dreamtube\.life\/assets\/logo-v4\.png"/, 'redesigned template must carry the app\'s own logo in its header');
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

// ===== SERVER-SIDE DURABLE PERSIST (E304 dream_sync_unconfirmed / P0 vanish) =====
//
// When a funnel generation completes AND its email resolves to a real account,
// dream-webhook.js now persists the finished video into that account's durable
// private-dream store itself — so a wiped/closed FB-IG-webview client that
// never confirmed its own dream-sync can no longer lose the (already-billed)
// video. reconcilePrivateDreamsFromServer pulls it back on the user's next
// load. Best-effort: it must never break the webhook's own markReady/notify/ack.

test('completion for a REGISTERED account persists a durable private-dream server-side', async function () {
  await accountStore.createAccount({}, { username: 'dreamer', email: 'dreamer@example.com', password: 'pw' });
  var record = await pendingDreams.create({}, {
    email: 'dreamer@example.com', caption: 'engineered prompt', storyText: 'I flew over a city',
    style: 'Cinematic', operationName: 'fal:veo/x:req-persist-1'
  });
  var res = await handler(webhookEvent({
    bodyObj: { status: 'OK', payload: { video: { url: 'https://cdn.fal/finished.mp4' } } },
    query: { pendingId: record.id }
  }));
  assert.equal(res.statusCode, 200);

  var dreams = await dreamStore.getPrivateDreams({}, 'dreamer');
  assert.equal(dreams.length, 1, 'the finished video is now durably attached to the account server-side');
  var d = dreams[0];
  assert.equal(d.sourceOperationName, 'fal:veo/x:req-persist-1');
  assert.equal(d.ownerHandle, '@dreamer');
  assert.equal(d.videoUrl, 'https://cdn.fal/finished.mp4');
  assert.equal(d.mediaType, 'video');
  assert.equal(d.dur, '0:08');
  assert.equal(d.caption, 'I flew over a city', 'human-readable storyText maps to caption (matches finalizeDream)');
  assert.equal(d.storyText, 'I flew over a city');
  assert.equal(d.promptText, 'engineered prompt', 'the engineered caption maps to promptText');
  assert.equal(d.isPublished, false);
  assert.equal(d.mood, null, "a field the server can't know at completion stays null, never fabricated");
  assert.equal(d.id, dreamStore.serverDreamId('fal:veo/x:req-persist-1'));
});

test('completion for an email with NO account yet persists NOTHING and never throws (webhook still acks + notifies)', async function () {
  var record = await pendingDreams.create({}, {
    email: 'not-registered@example.com', caption: 'p', storyText: 'a dream',
    style: 'Cinematic', operationName: 'fal:veo/x:req-persist-2'
  });
  process.env.RESEND_API_KEY = 'test-resend-key';
  var res = await handler(webhookEvent({
    bodyObj: { status: 'OK', payload: { video: { url: 'https://cdn.fal/finished.mp4' } } },
    query: { pendingId: record.id }
  }));
  assert.equal(res.statusCode, 200, 'webhook still acks normally');
  var updated = await pendingDreams.get({}, record.id);
  assert.equal(updated.status, 'notified', 'the normal webhook flow (ready/notify + email) still completes');
  // No account -> no username to key by -> nothing durable persisted.
  var dreams = await dreamStore.getPrivateDreams({}, accountStore.normalizeUsername('not-registered@example.com'));
  assert.equal(dreams.length, 0);
});

test('the already-claimed branch also persists the durable dream for the (now registered) account', async function () {
  await accountStore.createAccount({}, { username: 'claimer', email: 'claimer@example.com', password: 'pw' });
  var record = await pendingDreams.create({}, {
    email: 'claimer@example.com', caption: 'p', storyText: 'claimed dream',
    style: 'Cinematic', operationName: 'fal:veo/x:req-persist-3'
  });
  await pendingDreams.markClaimed({}, record.id);
  var res = await handler(webhookEvent({
    bodyObj: { status: 'OK', payload: { video: { url: 'https://cdn.fal/finished.mp4' } } },
    query: { pendingId: record.id }
  }));
  assert.equal(res.statusCode, 200);
  var updated = await pendingDreams.get({}, record.id);
  assert.equal(updated.status, 'claimed', 'never downgraded back to ready');
  var dreams = await dreamStore.getPrivateDreams({}, 'claimer');
  assert.equal(dreams.length, 1);
  assert.equal(dreams[0].videoUrl, 'https://cdn.fal/finished.mp4');
  assert.equal(dreams[0].sourceOperationName, 'fal:veo/x:req-persist-3');
});

test('a completion with no operationName on the pending record persists nothing, without throwing', async function () {
  await accountStore.createAccount({}, { username: 'noop', email: 'noop@example.com', password: 'pw' });
  var record = await pendingDreams.create({}, {
    email: 'noop@example.com', caption: 'p', storyText: 'a dream', style: 'Cinematic'
    // operationName deliberately omitted (defaults null)
  });
  var res = await handler(webhookEvent({
    bodyObj: { status: 'OK', payload: { video: { url: 'https://cdn.fal/finished.mp4' } } },
    query: { pendingId: record.id }
  }));
  assert.equal(res.statusCode, 200);
  var dreams = await dreamStore.getPrivateDreams({}, 'noop');
  assert.equal(dreams.length, 0, 'no operation to dedup/key by -> nothing persisted (never an un-dedup-able record)');
});

test('DEDUP end-to-end: a client dream-sync for the SAME operation after the webhook persist converges to ONE journal entry', async function () {
  await accountStore.createAccount({}, { username: 'conv', email: 'conv@example.com', password: 'pw' });
  var op = 'fal:veo/x:req-persist-4';
  var record = await pendingDreams.create({}, {
    email: 'conv@example.com', caption: 'p', storyText: 'converging dream', style: 'Cinematic', operationName: op
  });
  await handler(webhookEvent({
    bodyObj: { status: 'OK', payload: { video: { url: 'https://cdn.fal/finished.mp4' } } },
    query: { pendingId: record.id }
  }));
  // The client (finally, on a later load) syncs its OWN copy of the same generation,
  // under its own random id and with a richer mood field.
  await dreamStore.upsertPrivateDream({}, 'conv', {
    id: 'd-client-random', ownerHandle: '@conv', sourceOperationName: op,
    caption: 'converging dream', style: 'Cinematic', mediaType: 'video',
    videoUrl: 'https://cdn.fal/finished.mp4', mood: 'dreamy', updatedAt: Date.now()
  });
  var dreams = await dreamStore.getPrivateDreams({}, 'conv');
  assert.equal(dreams.length, 1, 'server persist + client sync of one generation = one dream, never two');
  assert.equal(dreams[0].id, 'd-client-random', 'the client copy wins');
  assert.equal(dreams[0].mood, 'dreamy', 'the richer client field lands');
});

// ===== SERVER-SIDE RECOVERY-EMAIL ENQUEUE (E304 / vanish recovery, founder-approved) =====
//
// The "unwatched dream" nudge — the email whose link opens the user's REAL
// browser (not the FB/IG in-app webview) where the durably-saved video waits —
// was enqueued ONLY client-side (home.html -> mark-generation-completed). A
// webview user who leaves before home.html loads never enqueued it. The webhook
// (fal's own completion) now ALSO enqueues it in the already-claimed branch,
// needing no surviving client. Convergence to exactly ONE nudge is guaranteed
// by unwatchedDreamNudgeStore.markPending's onlyIfNew CAS keyed by operationName.

test('the claimed branch ENQUEUES the recovery nudge server-side — no client mark-generation-completed needed', async function () {
  var jobOwners = require('../netlify/functions/lib/job-owners');
  var nudgeStore = require('../netlify/functions/lib/unwatched-dream-nudge-store');
  await accountStore.createAccount({}, { username: 'recov', email: 'recov@example.com', password: 'pw' });
  var op = 'fal:veo/x:req-nudge-1';
  var record = await pendingDreams.create({}, {
    email: 'recov@example.com', caption: 'p', storyText: 'a recoverable dream', style: 'Cinematic', operationName: op
  });
  // Funnel job-owner binding (recorded at submission time in real life), keyed to
  // this pending record so the nudge's own readyAt-overlap guard reads it.
  await jobOwners.recordJobOwner({}, op, 'recov@example.com', 'video', record.id);
  await pendingDreams.markClaimed({}, record.id); // signed up, but the client never fired mark-generation-completed

  var res = await handler(webhookEvent({
    bodyObj: { status: 'OK', payload: { video: { url: 'https://cdn.fal/finished.mp4' } } },
    query: { pendingId: record.id }
  }));
  assert.equal(res.statusCode, 200);

  var nudge = await nudgeStore.getPending({}, op);
  assert.ok(nudge, 'the webhook must enqueue the recovery nudge even with no client completion call');
  assert.equal(nudge.username, 'recov');
  assert.equal(nudge.email, 'recov@example.com');
});

test('CONVERGENCE: a later client mark-generation-completed enqueue for the SAME operation does NOT double-enqueue (one nudge)', async function () {
  var jobOwners = require('../netlify/functions/lib/job-owners');
  var nudgeStore = require('../netlify/functions/lib/unwatched-dream-nudge-store');
  var markGenerationCompleted = require('../netlify/functions/mark-generation-completed');
  await accountStore.createAccount({}, { username: 'conv2', email: 'conv2@example.com', password: 'pw' });
  var op = 'fal:veo/x:req-nudge-2';
  var record = await pendingDreams.create({}, {
    email: 'conv2@example.com', caption: 'p', storyText: 'a dream', style: 'Cinematic', operationName: op
  });
  await jobOwners.recordJobOwner({}, op, 'conv2@example.com', 'video', record.id);
  await pendingDreams.markClaimed({}, record.id);

  // 1) Webhook enqueues (server-side).
  await handler(webhookEvent({
    bodyObj: { status: 'OK', payload: { video: { url: 'https://cdn.fal/finished.mp4' } } },
    query: { pendingId: record.id }
  }));
  var first = await nudgeStore.getPending({}, op);
  assert.ok(first, 'server-side enqueue landed');

  // 2) The client (finally) fires its own enqueue for the SAME operation.
  await markGenerationCompleted.maybeEnqueueUnwatchedNudge({ headers: {} }, op);

  // Still exactly one pending nudge, unchanged — the onlyIfNew CAS made the
  // second enqueue a harmless no-op (never a second nudge, never a double-send).
  var second = await nudgeStore.getPending({}, op);
  assert.ok(second, 'the nudge is still pending');
  assert.equal(second.triggeredAt, first.triggeredAt, 'the second enqueue did not overwrite/re-create the pending nudge');
});
