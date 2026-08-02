// test/admin-backfill-media-rehost.test.js
//
// Covers netlify/functions/admin-backfill-media-rehost.js — tracker item
// for-product-owner-media-library-page-fou-1fwxaw (Part 2): the owner-only,
// real-password-gated backfill sweep that re-hosts existing private +
// published dreams still only on fal. Same test conventions as
// test/admin-diagnose-account-duplicates.test.js/
// test/admin-restore-founder-email.test.js.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');

var OWNER_EMAIL = 'founder@dreamtube.example';
var OWNER_PASSWORD = 'realfounderpw1';

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

var ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return '10.44.3.' + ipCounter;
}

test.beforeEach(function () {
  mockBlobs.reset();
  delete require.cache[require.resolve('../netlify/functions/admin-backfill-media-rehost')];
  delete require.cache[require.resolve('../netlify/functions/lib/account-store')];
  delete require.cache[require.resolve('../netlify/functions/lib/dream-store')];
  delete require.cache[require.resolve('../netlify/functions/lib/entitlements')];
});

async function seedOwnerAccount(event) {
  var accountStore = require('../netlify/functions/lib/account-store');
  return accountStore.createAccount(event, { username: 'ronbrightman', password: OWNER_PASSWORD, email: OWNER_EMAIL });
}

function realMediaFetch(bytes, contentType) {
  return {
    ok: true, status: 200,
    headers: { get: function (n) { return n.toLowerCase() === 'content-type' ? (contentType || null) : null; } },
    arrayBuffer: async function () { return bytes; }
  };
}

async function seedPrivateDream(username, dream) {
  var dreamStore = require('../netlify/functions/lib/dream-store');
  return dreamStore.upsertPrivateDream({}, username, dream);
}

function seedFeed(records) {
  mockBlobs.seed('dreamtube-feed', 'feed-index', records);
}

function backfillRequest(overrides) {
  return { method: 'POST', ip: nextIp(), body: Object.assign({ usernameOrEmail: OWNER_EMAIL, password: OWNER_PASSWORD }, overrides || {}) };
}

test('sweeps a private dream still on fal, re-hosts it, and persists the durable url onto the account\'s private dream store', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    await seedPrivateDream('dreamer1', {
      id: 'dream-1', ownerHandle: '@dreamer1', caption: 'x', style: 'Cinematic',
      videoUrl: 'https://fal.media/files/still-alive.mp4', mediaType: 'video', createdAt: Date.now()
    });

    var bytes = new ArrayBuffer(6);
    global.fetch = async function () { return realMediaFetch(bytes, 'video/mp4'); };

    var handler = require('../netlify/functions/admin-backfill-media-rehost').handler;
    var res = await handler(fakeEvent(backfillRequest()));
    assert.equal(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.phase, 'accounts');
    assert.equal(body.rehosted, 1);
    assert.equal(body.scannedAccounts, 1);

    var dreamStore = require('../netlify/functions/lib/dream-store');
    var dreams = await dreamStore.getPrivateDreams({}, 'dreamer1');
    assert.equal(dreams[0].videoUrl, '/.netlify/functions/video-file?key=dream-1%3Avideo');
  });
});

test('idempotent: running the sweep twice does not re-download or double-count an already-durable dream', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    await seedPrivateDream('dreamer2', {
      id: 'dream-2', ownerHandle: '@dreamer2', caption: 'x', style: 'Cinematic',
      videoUrl: 'https://fal.media/files/still-alive-2.mp4', mediaType: 'video', createdAt: Date.now()
    });

    var fetchCalls = 0;
    global.fetch = async function () { fetchCalls++; return realMediaFetch(new ArrayBuffer(4), 'video/mp4'); };

    var handler = require('../netlify/functions/admin-backfill-media-rehost').handler;
    var first = await handler(fakeEvent(backfillRequest()));
    assert.equal(JSON.parse(first.body).rehosted, 1);
    assert.equal(fetchCalls, 1);

    var second = await handler(fakeEvent(backfillRequest()));
    var secondBody = JSON.parse(second.body);
    assert.equal(secondBody.rehosted, 0, 'nothing left to re-host -- already durable from the first sweep');
    assert.equal(secondBody.alreadyDurable, 1);
    assert.equal(fetchCalls, 1, 'the second sweep must not re-download the same media');
  });
});

test('a dream already durably hosted is reported alreadyDurable, not re-processed', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    await seedPrivateDream('dreamer3', {
      id: 'dream-3', ownerHandle: '@dreamer3', caption: 'x', style: 'Cinematic',
      videoUrl: '/.netlify/functions/video-file?key=already-durable', mediaType: 'video', createdAt: Date.now()
    });
    global.fetch = async function () { throw new Error('must not fetch an already-durable dream'); };

    var handler = require('../netlify/functions/admin-backfill-media-rehost').handler;
    var res = await handler(fakeEvent(backfillRequest()));
    var body = JSON.parse(res.body);
    assert.equal(body.rehosted, 0);
    assert.equal(body.alreadyDurable, 1);
  });
});

test('a dream with no media at all is counted as skippedNoMedia, not an error', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    await seedPrivateDream('dreamer4', { id: 'dream-4', ownerHandle: '@dreamer4', caption: 'x', style: 'Cinematic', createdAt: Date.now() });

    var handler = require('../netlify/functions/admin-backfill-media-rehost').handler;
    var res = await handler(fakeEvent(backfillRequest()));
    var body = JSON.parse(res.body);
    assert.equal(body.skippedNoMedia, 1);
    assert.equal(body.rehosted, 0);
  });
});

test('a failed re-host (download fails) is counted as failed and leaves the dream\'s url untouched', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    await seedPrivateDream('dreamer5', {
      id: 'dream-5', ownerHandle: '@dreamer5', caption: 'x', style: 'Cinematic',
      videoUrl: 'https://fal.media/files/gone.mp4', mediaType: 'video', createdAt: Date.now()
    });
    global.fetch = async function () { return { ok: false, status: 404 }; };

    var handler = require('../netlify/functions/admin-backfill-media-rehost').handler;
    var res = await handler(fakeEvent(backfillRequest()));
    var body = JSON.parse(res.body);
    assert.equal(body.failed, 1);
    assert.equal(body.rehosted, 0);

    var dreamStore = require('../netlify/functions/lib/dream-store');
    var dreams = await dreamStore.getPrivateDreams({}, 'dreamer5');
    assert.equal(dreams[0].videoUrl, 'https://fal.media/files/gone.mp4', 'the original url is left in place -- a failed sweep never corrupts the record');
  });
});

test('a dream with BOTH imageUrl and videoUrl (turn-image-into-video) re-hosts each field independently', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    await seedPrivateDream('dreamer6', {
      id: 'dream-6', ownerHandle: '@dreamer6', caption: 'x', style: 'Cinematic',
      videoUrl: 'https://fal.media/files/v6.mp4', imageUrl: 'https://fal.media/files/i6.png',
      mediaType: 'video', createdAt: Date.now()
    });
    global.fetch = async function () { return realMediaFetch(new ArrayBuffer(4), 'video/mp4'); };

    var handler = require('../netlify/functions/admin-backfill-media-rehost').handler;
    var res = await handler(fakeEvent(backfillRequest()));
    var body = JSON.parse(res.body);
    assert.equal(body.rehosted, 2);
    assert.equal(body.scannedMediaItems, 2);

    var dreamStore = require('../netlify/functions/lib/dream-store');
    var dreams = await dreamStore.getPrivateDreams({}, 'dreamer6');
    assert.equal(dreams[0].videoUrl, '/.netlify/functions/video-file?key=dream-6%3Avideo');
    assert.equal(dreams[0].imageUrl, '/.netlify/functions/image-file?key=dream-6%3Aimage');
  });
});

test('pagination: accounts phase reports a nextCursor of "feed" once every account is scanned, and the feed phase completes the sweep', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    await seedPrivateDream('a1', { id: 'da1', ownerHandle: '@a1', caption: 'x', style: 'y', videoUrl: 'https://fal.media/a1.mp4', createdAt: Date.now() });
    await seedPrivateDream('a2', { id: 'da2', ownerHandle: '@a2', caption: 'x', style: 'y', videoUrl: 'https://fal.media/a2.mp4', createdAt: Date.now() });
    seedFeed([{ id: 'feed-1', ownerHandle: '@feedowner', caption: 'x', style: 'y', videoUrl: 'https://fal.media/feed1.mp4', publishedAt: Date.now() }]);
    global.fetch = async function () { return realMediaFetch(new ArrayBuffer(4), 'video/mp4'); };

    var handler = require('../netlify/functions/admin-backfill-media-rehost').handler;

    // Page 1: only 1 account per call.
    var page1 = JSON.parse((await handler(fakeEvent(backfillRequest({ limit: 1 })))).body);
    assert.equal(page1.phase, 'accounts');
    assert.equal(page1.done, false);
    assert.equal(page1.scannedAccounts, 1);
    assert.equal(page1.nextCursor, '1');

    // Page 2: the second (and last) account -- nextCursor advances to 'feed'.
    var page2 = JSON.parse((await handler(fakeEvent(backfillRequest({ limit: 1, cursor: page1.nextCursor })))).body);
    assert.equal(page2.phase, 'accounts');
    assert.equal(page2.scannedAccounts, 1);
    assert.equal(page2.nextCursor, 'feed');
    assert.equal(page2.done, false);

    // Feed phase: completes the sweep.
    var feedPage = JSON.parse((await handler(fakeEvent(backfillRequest({ cursor: 'feed' })))).body);
    assert.equal(feedPage.phase, 'feed');
    assert.equal(feedPage.done, true);
    assert.equal(feedPage.rehosted, 1);

    // Real feed store record was actually updated.
    var { getStore } = require('@netlify/blobs');
    var feed = await getStore('dreamtube-feed').get('feed-index', { type: 'json' });
    assert.equal(feed[0].videoUrl, '/.netlify/functions/video-file?key=feed-1%3Avideo');
  });
});

// ===== auth / request shape (same bar as every sibling admin-*.js tool) =====

test('POST rejects missing fields, invalid JSON, invalid limit, and non-POST methods', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var handler = require('../netlify/functions/admin-backfill-media-rehost').handler;

    var wrongMethod = await handler(fakeEvent({ method: 'GET' }));
    assert.equal(wrongMethod.statusCode, 405);

    var badJson = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: '{not json' }));
    assert.equal(badJson.statusCode, 400);
    assert.match(JSON.parse(badJson.body).error, /^E3: invalid_json/);

    var missing = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: 'someone' } }));
    assert.equal(missing.statusCode, 400);
    assert.match(JSON.parse(missing.body).error, /^E4: missing_fields/);

    var badLimit = await handler(fakeEvent(backfillRequest({ limit: -5 })));
    assert.equal(badLimit.statusCode, 400);
    assert.match(JSON.parse(badLimit.body).error, /^E7: invalid_limit/);

    var tooBigLimit = await handler(fakeEvent(backfillRequest({ limit: 99999 })));
    assert.equal(tooBigLimit.statusCode, 400);
    assert.match(JSON.parse(tooBigLimit.body).error, /^E7: invalid_limit/);
  });
});

test('POST rejects a real, correct password belonging to a non-owner account (403 E5), and never writes anything', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var accountStore = require('../netlify/functions/lib/account-store');
    var event = fakeEvent({ method: 'POST' });
    await accountStore.createAccount(event, { username: 'randomguy', password: 'randompw123', email: 'random@example.com' });
    await seedPrivateDream('victim', { id: 'dv', ownerHandle: '@victim', caption: 'x', style: 'y', videoUrl: 'https://fal.media/v.mp4', createdAt: Date.now() });

    var handler = require('../netlify/functions/admin-backfill-media-rehost').handler;
    var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: 'randomguy', password: 'randompw123' } }));
    assert.equal(res.statusCode, 403);
    assert.match(JSON.parse(res.body).error, /^E5: forbidden/);

    var dreamStore = require('../netlify/functions/lib/dream-store');
    var dreams = await dreamStore.getPrivateDreams({}, 'victim');
    assert.equal(dreams[0].videoUrl, 'https://fal.media/v.mp4', 'a rejected auth attempt must never touch any dream data');
  });
});

test('is rejected with 500 when OWNER_EMAIL is not configured, before any credential check', function () {
  return withEnv({ OWNER_EMAIL: undefined }, async function () {
    var handler = require('../netlify/functions/admin-backfill-media-rehost').handler;
    var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: 'anyone', password: 'whatever123' } }));
    assert.equal(res.statusCode, 500);
    assert.match(JSON.parse(res.body).error, /^E2: missing_owner_email/);
  });
});

test('POST exceeding MAX_ADMIN_BACKFILL_MEDIA_REHOST_PER_IP_PER_DAY is rejected with 429 E6', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, MAX_ADMIN_BACKFILL_MEDIA_REHOST_PER_IP_PER_DAY: '1' }, async function () {
    var handler = require('../netlify/functions/admin-backfill-media-rehost').handler;
    var ip = nextIp();

    var first = await handler(fakeEvent({ method: 'POST', ip: ip, body: { usernameOrEmail: 'nobody', password: 'wrongpw123' } }));
    assert.equal(first.statusCode, 403);

    var second = await handler(fakeEvent({ method: 'POST', ip: ip, body: { usernameOrEmail: OWNER_EMAIL, password: OWNER_PASSWORD } }));
    assert.equal(second.statusCode, 429);
    assert.match(JSON.parse(second.body).error, /^E6: rate_limited/);
  });
});
