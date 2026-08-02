// test/send-first-dream-email.test.js
//
// Covers the retention-email feature (tracker.html's
// for-product-retention-email-send-user-th-eke9ra item, then
// for-product-activate-automatic-retention-4n74rw):
//   - netlify/functions/lib/first-dream-email-store.js: the durable,
//     per-account, now-atomic "already sent" guard.
//   - netlify/functions/lib/dream-share-token.js: the private-dream view
//     token (create/verify, mismatch/expiry rejection) -- kept, unchanged,
//     as its own independently-functional/tested piece of infra even
//     though it's no longer linked from this email (see
//     send-first-dream-email.js's own header comment on the 2026-07-27
//     link change to profile.html).
//   - netlify/functions/send-first-dream-email.js: validation, the
//     account-store email resolution (never trusts a client-supplied
//     email), the Resend send (mocked, same spy pattern as
//     test/support-feedback.test.js/test/password-reset-account.test.js),
//     the exactly-once-per-account guarantee, video-only scope, per-IP
//     rate limiting, and the profile.html link.
//   - netlify/functions/get-shared-dream.js: valid token renders the
//     dream, wrong/missing/expired token doesn't leak anything.
//
// The AUTOMATIC trigger path (mark-generation-completed.js firing this
// same send with no client involvement at all) has its own dedicated
// coverage in test/automatic-first-dream-email.test.js -- kept separate
// since it exercises a different file/identity-resolution path entirely,
// even though both funnel into the same lib/first-dream-email-sender.js
// core this file also exercises indirectly via the HTTP endpoint.
// Run with: node --test test/

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');

var realFetch = global.fetch;

function withEnv(vars, fn) {
  var previous = {};
  Object.keys(vars).forEach(function (k) { previous[k] = process.env[k]; });
  Object.keys(vars).forEach(function (k) {
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  });
  return Promise.resolve()
    .then(fn)
    .finally(function () {
      Object.keys(previous).forEach(function (k) {
        if (previous[k] === undefined) delete process.env[k];
        else process.env[k] = previous[k];
      });
    });
}

/**
 * Spies on global.fetch (Resend) so tests never make a real network call —
 * same convention as test/support-feedback.test.js's installFetchSpy(),
 * extended (2026-07-27) to also swallow the 'first_dream_email_sent'
 * PostHog capture call lib/first-dream-email-sender.js now fires on every
 * actual send (POSTHOG_KEY is a real, hardcoded value — see
 * js/analytics-config.js/lib/posthog-capture.js's own header comment —
 * so without this, every send here would attempt a REAL network call to
 * PostHog's live endpoint). Only Resend calls are recorded into the
 * returned array — every assertion in this file cares about "how many
 * emails were actually sent," not the separate PostHog analytics fire
 * (which test/automatic-first-dream-email.test.js covers on its own),
 * same split-by-URL convention test/dodo-webhook.test.js's
 * installAnalyticsFetchSpy already established for its own two-vendor fire.
 */
function installFetchSpy(ok) {
  var calls = [];
  global.fetch = async function (url, opts) {
    var urlStr = String(url);
    if (urlStr.indexOf('/capture/') !== -1) {
      // PostHog's capture endpoint -- swallowed, not recorded (see doc
      // comment above).
      return { ok: true, status: 200, json: async function () { return {}; } };
    }
    calls.push({ url: url, body: opts && opts.body ? JSON.parse(opts.body) : null });
    return { ok: ok !== false, status: ok !== false ? 200 : 500, json: async function () { return {}; } };
  };
  return calls;
}

var ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return '10.7.0.' + ipCounter;
}

test.beforeEach(function () {
  global.fetch = realFetch;
  mockBlobs.reset();
  delete require.cache[require.resolve('../netlify/functions/send-first-dream-email')];
  delete require.cache[require.resolve('../netlify/functions/get-shared-dream')];
  delete require.cache[require.resolve('../netlify/functions/register-account')];
  delete require.cache[require.resolve('../netlify/functions/lib/account-store')];
  delete require.cache[require.resolve('../netlify/functions/lib/first-dream-email-store')];
  delete require.cache[require.resolve('../netlify/functions/lib/first-dream-email-sender')];
  delete require.cache[require.resolve('../netlify/functions/lib/dream-share-token')];
  delete require.cache[require.resolve('../netlify/functions/lib/rate-limit')];
  delete process.env.MAX_FIRST_DREAM_EMAILS_PER_IP_PER_DAY;
});
test.after(function () {
  global.fetch = realFetch;
});

var ENV = { RESEND_API_KEY: 'resend-test-key' };

async function registerAccount(username, email) {
  var registerHandler = require('../netlify/functions/register-account').handler;
  var res = await registerHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { username: username, password: 'realpassword1', email: email } }));
  assert.equal(JSON.parse(res.body).ok, true, 'test setup: registration should succeed');
}

function dreamPayload(overrides) {
  return Object.assign({
    username: 'nora',
    password: 'realpassword1',
    dreamId: 'dream-1',
    caption: 'Flying over the ocean',
    style: 'Cinematic',
    videoUrl: 'https://example.com/fake-video.mp4',
    mediaType: 'video'
  }, overrides || {});
}

// ===== lib/first-dream-email-store.js =====

test('first-dream-email-store: markSentOnce succeeds the first time, fails every time after for the same account', async function () {
  var store = require('../netlify/functions/lib/first-dream-email-store');
  var event = fakeEvent({ method: 'POST' });

  var first = await store.markSentOnce(event, 'nora', 'dream-1');
  assert.equal(first.ok, true);

  var second = await store.markSentOnce(event, 'nora', 'dream-1');
  assert.equal(second.ok, false);
  assert.equal(second.alreadySent, true);

  // Even a DIFFERENT dreamId for the same account must not get a second send —
  // this flag is per-account, not per-dream.
  var third = await store.markSentOnce(event, 'NORA', 'dream-2');
  assert.equal(third.ok, false);
  assert.equal(third.alreadySent, true);
});

test('first-dream-email-store: different accounts get independent guards', async function () {
  var store = require('../netlify/functions/lib/first-dream-email-store');
  var event = fakeEvent({ method: 'POST' });

  var alice = await store.markSentOnce(event, 'alice', 'dream-a');
  var bob = await store.markSentOnce(event, 'bob', 'dream-b');
  assert.equal(alice.ok, true);
  assert.equal(bob.ok, true);
});

// CONCURRENCY (the part this task's own instructions called out as "most
// worth getting right"): two genuinely concurrent claim attempts for the
// SAME account must never both win -- same "Promise.all races step-by-
// step exactly like two concurrent Netlify Function invocations would"
// reasoning as test/session-transfer.test.js's own racing-consume test,
// proving lib/blobs-retry.js's read->mutate->write->verify loop actually
// closes this race rather than just asserting the code "looks" atomic.
test('CONCURRENCY: first-dream-email-store: two concurrent markSentOnce calls for the SAME account -- exactly one wins, never both, never neither', async function () {
  var store = require('../netlify/functions/lib/first-dream-email-store');
  var event = fakeEvent({ method: 'POST' });

  var results = await Promise.all([
    store.markSentOnce(event, 'raceraccount', 'dream-race-1'),
    store.markSentOnce(event, 'raceraccount', 'dream-race-2')
  ]);
  var winCount = results.filter(function (r) { return r.ok === true; }).length;
  assert.equal(winCount, 1, 'exactly one of the two racing claims must win -- a real winner must exist, and it must never be both');
});

// ===== lib/dream-share-token.js =====

test('dream-share-token: a valid token resolves the exact dream it was minted for', async function () {
  var dreamShareToken = require('../netlify/functions/lib/dream-share-token');
  var event = fakeEvent({ method: 'POST', headers: { host: 'dreamtube1.netlify.app' } });

  var token = await dreamShareToken.createToken(event, {
    id: 'dream-42', ownerHandle: '@nora', caption: 'A dream', style: 'Anime', videoUrl: 'https://example.com/v.mp4', mediaType: 'video'
  });
  var url = dreamShareToken.buildUrl(event, 'dream-42', token);
  assert.equal(url, 'https://dreamtube1.netlify.app/watch.html?id=dream-42&token=' + token);

  var result = await dreamShareToken.verifyToken(event, 'dream-42', token);
  assert.equal(result.ok, true);
  assert.equal(result.dream.videoUrl, 'https://example.com/v.mp4');
  assert.equal(result.dream.caption, 'A dream');
});

test('dream-share-token: a token verified against the WRONG dreamId is rejected (never leaks the dream)', async function () {
  var dreamShareToken = require('../netlify/functions/lib/dream-share-token');
  var event = fakeEvent({ method: 'POST' });

  var token = await dreamShareToken.createToken(event, { id: 'dream-42', videoUrl: 'https://example.com/v.mp4' });
  var result = await dreamShareToken.verifyToken(event, 'some-other-dream-id', token);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid_or_expired');
});

test('dream-share-token: an unknown token is rejected', async function () {
  var dreamShareToken = require('../netlify/functions/lib/dream-share-token');
  var event = fakeEvent({ method: 'POST' });

  var result = await dreamShareToken.verifyToken(event, 'dream-42', 'not-a-real-token');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid_or_expired');
});

test('dream-share-token: an expired token is rejected', async function () {
  var dreamShareToken = require('../netlify/functions/lib/dream-share-token');
  var event = fakeEvent({ method: 'POST' });

  var token = await dreamShareToken.createToken(event, { id: 'dream-42', videoUrl: 'https://example.com/v.mp4' });
  // Reach into the store the same way other tests here manipulate mock-blobs indirectly --
  // simplest is to verify with a manually-expired record by re-writing it via the Blobs mock.
  var { getStore } = require('@netlify/blobs');
  var store = getStore({ name: dreamShareToken.STORE_NAME });
  var record = await store.get(token, { type: 'json' });
  record.expiresAt = Date.now() - 1000;
  await store.setJSON(token, record);

  var result = await dreamShareToken.verifyToken(event, 'dream-42', token);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid_or_expired');
});

test('dream-share-token: verifying again after a first read still works (revisitable, not single-use)', async function () {
  var dreamShareToken = require('../netlify/functions/lib/dream-share-token');
  var event = fakeEvent({ method: 'POST' });

  var token = await dreamShareToken.createToken(event, { id: 'dream-42', videoUrl: 'https://example.com/v.mp4' });
  var first = await dreamShareToken.verifyToken(event, 'dream-42', token);
  var second = await dreamShareToken.verifyToken(event, 'dream-42', token);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
});

// ===== send-first-dream-email.js =====

test('send-first-dream-email: a real registered account with a verified email gets sent the retention email, linking to profile.html', function () {
  return withEnv(ENV, async function () {
    await registerAccount('nora', 'nora@example.com');
    var sentCalls = installFetchSpy(true);

    var handler = require('../netlify/functions/send-first-dream-email').handler;
    var res = await handler(fakeEvent({
      method: 'POST', ip: nextIp(), headers: { host: 'dreamtube1.netlify.app' },
      body: dreamPayload()
    }));

    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).ok, true);
    assert.equal(sentCalls.length, 1, 'expected exactly one Resend send');
    assert.deepEqual(sentCalls[0].body.to, ['nora@example.com'], 'must send to the ACCOUNT\'S REAL email, resolved server-side');
    assert.match(sentCalls[0].body.subject, /ready/i);
    assert.match(sentCalls[0].body.html, /href="https:\/\/dreamtube1\.netlify\.app\/profile\.html"/, 'body must link to the account\'s own profile page (founder decision 2026-07-27), not a per-dream watch link');
    assert.doesNotMatch(sentCalls[0].body.html, /watch\.html/, 'must not link to the old per-dream watch.html share link anymore');
    assert.match(sentCalls[0].body.html, /create\.html/, 'body must contain the soft "make another" nudge link');
    assert.match(sentCalls[0].body.html, /Flying over the ocean/, 'the client-triggered fallback path still personalizes with the dream\'s own caption');
  });
});

// REAL THUMBNAIL (tracker item for-product-dream-ready-email-real-first-
// qr9fbj, founder request 2026-08-02) -- see lib/first-dream-email-
// sender.js's own "REAL THUMBNAIL" header comment. This client-triggered
// path is the one call site that actually has the dream object (and
// therefore its imageUrl) on hand, so it's the only realistic beneficiary
// of a real thumbnail -- the automatic path's own coverage
// (test/automatic-first-dream-email.test.js) documents why it can't.

test('send-first-dream-email: a dream with a real imageUrl renders an <img> instead of the flat-color banner, resolved to an absolute url', function () {
  return withEnv(ENV, async function () {
    await registerAccount('nora', 'nora@example.com');
    var sentCalls = installFetchSpy(true);

    var handler = require('../netlify/functions/send-first-dream-email').handler;
    await handler(fakeEvent({
      method: 'POST', ip: nextIp(), headers: { host: 'dreamtube1.netlify.app' },
      body: dreamPayload({ imageUrl: '/.netlify/functions/image-file?key=thumb%3Anora%3Adream-1' })
    }));

    assert.equal(sentCalls.length, 1);
    var html = sentCalls[0].body.html;
    assert.match(html, /<img src="https:\/\/dreamtube1\.netlify\.app\/\.netlify\/functions\/image-file\?key=thumb%3Anora%3Adream-1"/, 'a relative durable image url must be resolved to an absolute https:// url an email client can actually load');
    assert.doesNotMatch(html, /background:#[0-9a-fA-F]{6};margin-bottom:18px/, 'the flat-color banner div must not render when a real thumbnail is available');
  });
});

test('send-first-dream-email: an already-absolute imageUrl is used as-is, not double-prefixed', function () {
  return withEnv(ENV, async function () {
    await registerAccount('nora', 'nora@example.com');
    var sentCalls = installFetchSpy(true);

    var handler = require('../netlify/functions/send-first-dream-email').handler;
    await handler(fakeEvent({
      method: 'POST', ip: nextIp(), headers: { host: 'dreamtube1.netlify.app' },
      body: dreamPayload({ imageUrl: 'https://fal.media/files/already-absolute.jpg' })
    }));

    assert.match(sentCalls[0].body.html, /<img src="https:\/\/fal\.media\/files\/already-absolute\.jpg"/);
  });
});

test('send-first-dream-email: no imageUrl (the common case, especially right after generation) falls back to the original flat-color banner', function () {
  return withEnv(ENV, async function () {
    await registerAccount('nora', 'nora@example.com');
    var sentCalls = installFetchSpy(true);

    var handler = require('../netlify/functions/send-first-dream-email').handler;
    await handler(fakeEvent({
      method: 'POST', ip: nextIp(), headers: { host: 'dreamtube1.netlify.app' },
      body: dreamPayload() // no imageUrl field at all
    }));

    var html = sentCalls[0].body.html;
    assert.doesNotMatch(html, /<img/, 'no imageUrl on the dream -- must fall back to the color banner, not an empty/broken <img>');
    assert.match(html, /background:#22405c;margin-bottom:18px/, 'Cinematic style\'s own flat color, unchanged from before this feature');
  });
});

test('lib/first-dream-email-sender.js: absoluteImageUrl resolves a relative durable url against the request host, passes an absolute one through, and returns null with nothing to resolve against', function () {
  var sender = require('../netlify/functions/lib/first-dream-email-sender');
  var event = fakeEvent({ method: 'POST', headers: { host: 'dreamtube1.netlify.app' } });
  assert.equal(sender.absoluteImageUrl(event, '/.netlify/functions/image-file?key=x'), 'https://dreamtube1.netlify.app/.netlify/functions/image-file?key=x');
  assert.equal(sender.absoluteImageUrl(event, 'https://fal.media/x.jpg'), 'https://fal.media/x.jpg');
  assert.equal(sender.absoluteImageUrl(event, null), null);
  assert.equal(sender.absoluteImageUrl(event, ''), null);
  assert.equal(sender.absoluteImageUrl(fakeEvent({ method: 'POST' }), '/relative'), null, 'no host on the event -- nothing safe to resolve a relative url against');
});

test('send-first-dream-email: never trusts a client-supplied email address — always resolves via the account store', function () {
  return withEnv(ENV, async function () {
    await registerAccount('nora', 'real-nora@example.com');
    var sentCalls = installFetchSpy(true);

    var handler = require('../netlify/functions/send-first-dream-email').handler;
    await handler(fakeEvent({
      method: 'POST', ip: nextIp(),
      // Attacker-supplied email field, if the endpoint even accepted one --
      // it doesn't (send-first-dream-email.js has no `email` field in its
      // payload contract at all), but assert the real account's email is
      // what actually gets used regardless of anything else in the body.
      body: Object.assign(dreamPayload(), { email: 'attacker@evil.example' })
    }));

    assert.equal(sentCalls.length, 1);
    assert.deepEqual(sentCalls[0].body.to, ['real-nora@example.com']);
  });
});

test('send-first-dream-email: an account with no verified email on file is a silent no-op, no send attempted', function () {
  return withEnv(ENV, async function () {
    // register-account.js requires a well-formed email, so simulate a
    // legacy/no-email account by writing directly via lib/account-store.js
    // with an empty email, same shape a pre-email-feature account could have.
    var accountStore = require('../netlify/functions/lib/account-store');
    var event = fakeEvent({ method: 'POST' });
    var { getStore } = require('@netlify/blobs');
    var store = getStore({ name: accountStore.STORE_NAME });
    await store.setJSON('u:noemailuser', { username: 'noemailuser', email: '', password: 'x', updatedAt: Date.now() });

    var sentCalls = installFetchSpy(true);
    var handler = require('../netlify/functions/send-first-dream-email').handler;
    var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: dreamPayload({ username: 'noemailuser', password: 'x' }) }));

    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).ok, true);
    assert.equal(sentCalls.length, 0, 'no account email on file -- nothing safe to send to');
  });
});

test('send-first-dream-email: an unknown username fails the password check (E5) -- no send attempted, and this never reveals whether the account exists', function () {
  return withEnv(ENV, async function () {
    var sentCalls = installFetchSpy(true);
    var handler = require('../netlify/functions/send-first-dream-email').handler;
    var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: dreamPayload({ username: 'nobody-registered' }) }));

    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).ok, false);
    assert.match(JSON.parse(res.body).error, /^E5/);
    assert.equal(sentCalls.length, 0);
  });
});

test('send-first-dream-email: a WRONG password for a REAL registered account is rejected (E5), no send attempted, and does NOT poison the exactly-once guard for a later legitimate call', function () {
  return withEnv(ENV, async function () {
    await registerAccount('nora', 'nora@example.com');
    var sentCalls = installFetchSpy(true);
    var handler = require('../netlify/functions/send-first-dream-email').handler;

    // The exact spoofing attempt the review flagged: a bare, correct
    // username with an attacker-guessed (wrong) password -- must never
    // send, and must never poison first-dream-email-store's per-account
    // guard, so the real account can still get its legitimate email later.
    var spoofed = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: dreamPayload({ password: 'attacker-guessed-wrong' }) }));
    assert.equal(spoofed.statusCode, 200);
    assert.equal(JSON.parse(spoofed.body).ok, false);
    assert.match(JSON.parse(spoofed.body).error, /^E5/);
    assert.equal(sentCalls.length, 0, 'a wrong password must never trigger a real send');

    var legit = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: dreamPayload() }));
    assert.equal(JSON.parse(legit.body).ok, true);
    assert.equal(sentCalls.length, 1, 'the real account must still be able to get its legitimate retention email after a failed spoofing attempt');
  });
});

test('send-first-dream-email: exactly once per account -- a second call for the same account (even a different dream) never sends again', function () {
  return withEnv(ENV, async function () {
    await registerAccount('nora', 'nora@example.com');
    var sentCalls = installFetchSpy(true);
    var handler = require('../netlify/functions/send-first-dream-email').handler;

    var first = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: dreamPayload() }));
    assert.equal(JSON.parse(first.body).ok, true);
    assert.equal(sentCalls.length, 1);

    var second = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: dreamPayload({ dreamId: 'dream-2' }) }));
    assert.equal(JSON.parse(second.body).ok, true);
    assert.equal(sentCalls.length, 1, 'a second completion for the same account must not send a second email');
  });
});

test('send-first-dream-email: image mediaType is out of scope -- a no-op, matching FirstVideoCreated\'s own video-only scope', function () {
  return withEnv(ENV, async function () {
    await registerAccount('nora', 'nora@example.com');
    var sentCalls = installFetchSpy(true);
    var handler = require('../netlify/functions/send-first-dream-email').handler;

    var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: dreamPayload({ mediaType: 'image' }) }));
    assert.equal(JSON.parse(res.body).ok, true);
    assert.equal(sentCalls.length, 0);
  });
});

test('send-first-dream-email: missing RESEND_API_KEY is a safe no-op, never an error', function () {
  return withEnv({ RESEND_API_KEY: undefined }, async function () {
    await registerAccount('nora', 'nora@example.com');
    var sentCalls = installFetchSpy(true);
    var handler = require('../netlify/functions/send-first-dream-email').handler;

    var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: dreamPayload() }));
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).ok, true);
    assert.equal(sentCalls.length, 0);
  });
});

test('send-first-dream-email: a Resend rejection is logged but still returns ok -- never blocks the caller', function () {
  return withEnv(ENV, async function () {
    await registerAccount('nora', 'nora@example.com');
    installFetchSpy(false);
    var handler = require('../netlify/functions/send-first-dream-email').handler;
    var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: dreamPayload() }));
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).ok, true);
  });
});

test('send-first-dream-email: missing required fields -> E3', function () {
  return withEnv(ENV, async function () {
    var handler = require('../netlify/functions/send-first-dream-email').handler;
    var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { username: 'nora' } }));
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /^E3/);
  });
});

test('send-first-dream-email: wrong method -> E1', async function () {
  var handler = require('../netlify/functions/send-first-dream-email').handler;
  var res = await handler(fakeEvent({ method: 'GET', ip: nextIp() }));
  assert.equal(res.statusCode, 405);
  assert.match(JSON.parse(res.body).error, /^E1/);
});

test('send-first-dream-email: invalid JSON body -> E2', async function () {
  var handler = require('../netlify/functions/send-first-dream-email').handler;
  var res = await handler({ httpMethod: 'POST', headers: { 'x-nf-client-connection-ip': nextIp() }, body: 'not json', queryStringParameters: {} });
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E2/);
});

test('send-first-dream-email: per-IP rate limit blocks further sends from the same source once exceeded', function () {
  return withEnv(Object.assign({}, ENV, { MAX_FIRST_DREAM_EMAILS_PER_IP_PER_DAY: '2' }), async function () {
    await registerAccount('alice', 'alice@example.com');
    await registerAccount('bob', 'bob@example.com');
    await registerAccount('carol', 'carol@example.com');
    installFetchSpy(true);
    var handler = require('../netlify/functions/send-first-dream-email').handler;
    var ip = nextIp();

    var r1 = await handler(fakeEvent({ method: 'POST', ip: ip, body: dreamPayload({ username: 'alice', dreamId: 'd-alice' }) }));
    var r2 = await handler(fakeEvent({ method: 'POST', ip: ip, body: dreamPayload({ username: 'bob', dreamId: 'd-bob' }) }));
    var r3 = await handler(fakeEvent({ method: 'POST', ip: ip, body: dreamPayload({ username: 'carol', dreamId: 'd-carol' }) }));

    assert.equal(r1.statusCode, 200);
    assert.equal(r2.statusCode, 200);
    assert.equal(r3.statusCode, 429);
  });
});

// ===== get-shared-dream.js =====
//
// send-first-dream-email.js no longer mints a dream-share-token at all
// (see its own header comment on the 2026-07-27 profile.html link
// change) -- these two tests used to go through that endpoint end-to-end,
// but get-shared-dream.js/dream-share-token.js are unchanged, independent
// infra, so they're exercised directly here instead (same shape the
// dream-share-token.js unit tests above already use, one layer up through
// the actual HTTP handler).

test('get-shared-dream: end-to-end -- a minted share token resolves the exact dream it points at', function () {
  return withEnv(ENV, async function () {
    var dreamShareToken = require('../netlify/functions/lib/dream-share-token');
    var event = fakeEvent({ method: 'POST', headers: { host: 'dreamtube1.netlify.app' } });
    var token = await dreamShareToken.createToken(event, {
      id: 'dream-1', ownerHandle: '@nora', caption: 'Flying over the ocean', style: 'Cinematic',
      videoUrl: 'https://example.com/fake-video.mp4', mediaType: 'video'
    });

    var getHandler = require('../netlify/functions/get-shared-dream').handler;
    var res = await getHandler(fakeEvent({ method: 'GET', query: { id: 'dream-1', token: token } }));
    var data = JSON.parse(res.body);
    assert.equal(data.ok, true);
    assert.equal(data.dream.videoUrl, 'https://example.com/fake-video.mp4');
    assert.equal(data.dream.caption, 'Flying over the ocean');
  });
});

test('get-shared-dream: a wrong token for a real id is rejected, no dream leaked', function () {
  return withEnv(ENV, async function () {
    var dreamShareToken = require('../netlify/functions/lib/dream-share-token');
    var event = fakeEvent({ method: 'POST' });
    await dreamShareToken.createToken(event, { id: 'dream-1', videoUrl: 'https://example.com/fake-video.mp4' });

    var getHandler = require('../netlify/functions/get-shared-dream').handler;
    var res = await getHandler(fakeEvent({ method: 'GET', query: { id: 'dream-1', token: 'totally-wrong-token' } }));
    var data = JSON.parse(res.body);
    assert.equal(data.ok, false);
    assert.equal(res.statusCode, 200, 'must not leak via status code either');
  });
});

test('get-shared-dream: missing params -> E2', async function () {
  var getHandler = require('../netlify/functions/get-shared-dream').handler;
  var res = await getHandler(fakeEvent({ method: 'GET', query: {} }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E2/);
});

test('get-shared-dream: wrong method -> E1', async function () {
  var getHandler = require('../netlify/functions/get-shared-dream').handler;
  var res = await getHandler(fakeEvent({ method: 'POST', query: {} }));
  assert.equal(res.statusCode, 405);
  assert.match(JSON.parse(res.body).error, /^E1/);
});
