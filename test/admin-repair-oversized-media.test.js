// test/admin-repair-oversized-media.test.js
//
// Covers netlify/functions/admin-repair-oversized-media.js — tracker item
// for-product-urgent-reopen-video-repair-p-cyp8np: the owner-only,
// real-password-gated repair sweep for durable media records written
// BEFORE for-product-urgent-founder-repro-on-drea-uq3a36's SIZE fix
// shipped (so their Blobs metadata has no byteLength at all). Same test
// conventions as test/admin-backfill-media-rehost.test.js, this tool's
// closest precedent.

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
  return '10.55.4.' + ipCounter;
}

test.beforeEach(function () {
  mockBlobs.reset();
  delete require.cache[require.resolve('../netlify/functions/admin-repair-oversized-media')];
  delete require.cache[require.resolve('../netlify/functions/lib/account-store')];
  delete require.cache[require.resolve('../netlify/functions/lib/dream-store')];
  delete require.cache[require.resolve('../netlify/functions/lib/entitlements')];
  delete require.cache[require.resolve('../netlify/functions/lib/media-rehost')];
});

async function seedOwnerAccount(event) {
  var accountStore = require('../netlify/functions/lib/account-store');
  return accountStore.createAccount(event, { username: 'ronbrightman', password: OWNER_PASSWORD, email: OWNER_EMAIL });
}

async function seedPrivateDream(username, dream) {
  var dreamStore = require('../netlify/functions/lib/dream-store');
  return dreamStore.upsertPrivateDream({}, username, dream);
}

function seedFeed(records) {
  mockBlobs.seed('dreamtube-feed', 'feed-index', records);
}

function repairRequest(overrides) {
  return { method: 'POST', ip: nextIp(), body: Object.assign({ usernameOrEmail: OWNER_EMAIL, password: OWNER_PASSWORD }, overrides || {}) };
}

/** Writes a durable video-file record directly into the (mocked) Blobs video store, bypassing rehostBestEffort entirely -- the exact shape pre-SIZE-fix code produced (metadata-only, no byteLength/sourceUrl). Returns the durable url a dream record would carry. */
async function seedLegacyDurableVideo(key, bytes) {
  var { getStore } = require('@netlify/blobs');
  await getStore({ name: 'dreamtube-videos' }).set(key, bytes, { metadata: { contentType: 'video/mp4' } });
  return '/.netlify/functions/video-file?key=' + encodeURIComponent(key);
}

async function seedLegacyDurableImage(key, bytes) {
  var { getStore } = require('@netlify/blobs');
  await getStore({ name: 'dreamtube-images' }).set(key, bytes, { metadata: { contentType: 'image/jpeg' } });
  return '/.netlify/functions/image-file?key=' + encodeURIComponent(key);
}

function realMediaFetch(bytes, contentType) {
  return {
    ok: true, status: 200,
    headers: { get: function (n) { return n.toLowerCase() === 'content-type' ? (contentType || null) : null; } },
    arrayBuffer: async function () { return bytes; }
  };
}

// Two fal endpoints get hit in sequence for a real repair: .../status then
// .../<requestId> (see video-status.js's own checkFalStatus, mirrored
// here). `falQueue` sets up canned status+result JSON responses.
function falFetchMock(falQueue) {
  var calls = [];
  return {
    calls: calls,
    fetch: async function (url, opts) {
      calls.push(url);
      var isStatusCall = url.indexOf('/status') !== -1;
      var entry = falQueue.shift();
      if (!entry) throw new Error('unexpected extra fal fetch: ' + url);
      if (entry.httpStatus === 404) {
        return { ok: false, status: 404, text: async function () { return ''; } };
      }
      return {
        ok: true, status: 200,
        text: async function () { return JSON.stringify(isStatusCall ? entry.status : entry.result); }
      };
    }
  };
}

test('backfills byteLength-only metadata for a legacy record whose real stored size is already safe -- no fal call at all', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    var url = await seedLegacyDurableVideo('dream-safe:video', new ArrayBuffer(10));
    await seedPrivateDream('dreamer1', {
      id: 'dream-safe', ownerHandle: '@dreamer1', caption: 'x', style: 'y',
      videoUrl: url, mediaType: 'video', createdAt: Date.now()
    });

    global.fetch = async function () { throw new Error('must not call fal for an already-safe record'); };

    var handler = require('../netlify/functions/admin-repair-oversized-media').handler;
    var res = await handler(fakeEvent(repairRequest()));
    assert.equal(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.backfilledMetadataOnly, 1);
    assert.equal(body.repairedViaFal, 0);
    assert.equal(body.failed, 0);

    var { getStore } = require('@netlify/blobs');
    var stored = await getStore({ name: 'dreamtube-videos' }).getWithMetadata('dream-safe:video');
    assert.equal(stored.metadata.byteLength, 10);
    assert.equal(stored.metadata.contentType, 'video/mp4', 'existing metadata fields are preserved, not clobbered');
  });
});

test('a genuinely oversized legacy record is repaired via a real fresh fal re-fetch, ending up with sourceUrl+byteLength', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, FAL_KEY: 'test-fal-key' }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);

    var MAX = require('../netlify/functions/lib/media-rehost').MAX_STREAMABLE_BYTES;
    var url = await seedLegacyDurableVideo('req-broken-1:video', new ArrayBuffer(MAX + 5));
    await seedPrivateDream('dreamer2', {
      id: 'dream-broken', ownerHandle: '@dreamer2', caption: 'x', style: 'y',
      videoUrl: url, mediaType: 'video', createdAt: Date.now(),
      sourceOperationName: 'fal:fal-ai/veo3.1/fast/image-to-video:req-broken-1'
    });

    var fal = falFetchMock([
      { status: { status: 'COMPLETED' } },
      { result: { video: { url: 'https://fal.media/files/fresh-broken-1.mp4' } } }
    ]);
    var freshBytes = new ArrayBuffer(6);
    global.fetch = async function (url, opts) {
      if (typeof url === 'string' && url.indexOf('queue.fal.run') !== -1) return fal.fetch(url, opts);
      return realMediaFetch(freshBytes, 'video/mp4');
    };

    var handler = require('../netlify/functions/admin-repair-oversized-media').handler;
    var res = await handler(fakeEvent(repairRequest()));
    var body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.repairedViaFal, 1);
    assert.equal(body.failed, 0);

    var { getStore } = require('@netlify/blobs');
    var stored = await getStore({ name: 'dreamtube-videos' }).getWithMetadata('req-broken-1:video');
    assert.equal(stored.metadata.byteLength, 6);
    assert.equal(stored.metadata.sourceUrl, 'https://fal.media/files/fresh-broken-1.mp4');
    assert.equal(fal.calls.length, 2, 'status then result -- exactly the pattern video-status.js\'s checkFalStatus uses');
  });
});

test('fal no longer having the result (expired/deleted) is reported as failed/fal_result_gone, not a crash', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, FAL_KEY: 'test-fal-key' }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);

    var MAX = require('../netlify/functions/lib/media-rehost').MAX_STREAMABLE_BYTES;
    var url = await seedLegacyDurableVideo('req-gone:video', new ArrayBuffer(MAX + 1));
    await seedPrivateDream('dreamer3', {
      id: 'dream-gone', ownerHandle: '@dreamer3', caption: 'x', style: 'y',
      videoUrl: url, mediaType: 'video', createdAt: Date.now(),
      sourceOperationName: 'fal:fal-ai/veo3.1/fast:req-gone'
    });

    global.fetch = async function (url) {
      if (typeof url === 'string' && url.indexOf('queue.fal.run') !== -1) {
        return { ok: false, status: 404, text: async function () { return ''; } };
      }
      throw new Error('must not fetch media bytes when fal has nothing');
    };

    var handler = require('../netlify/functions/admin-repair-oversized-media').handler;
    var res = await handler(fakeEvent(repairRequest()));
    var body = JSON.parse(res.body);
    assert.equal(res.statusCode, 200, 'a real, expected outcome -- never a 500');
    assert.equal(body.failed, 1);
    assert.equal(body.repairedViaFal, 0);
    var detail = body.details.find(function (d) { return d.key === 'req-gone:video'; });
    assert.equal(detail.reason, 'fal_result_gone');

    // The stale oversized bytes are left untouched -- a failed repair must not corrupt what's on file.
    var { getStore } = require('@netlify/blobs');
    var stored = await getStore({ name: 'dreamtube-videos' }).getWithMetadata('req-gone:video');
    assert.equal(stored.metadata.byteLength, undefined);
  });
});

test('a genuinely oversized record with no (or malformed) sourceOperationName fails with a clear reason, no fal call attempted', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, FAL_KEY: 'test-fal-key' }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);

    var MAX = require('../netlify/functions/lib/media-rehost').MAX_STREAMABLE_BYTES;
    var url = await seedLegacyDurableVideo('req-no-op:video', new ArrayBuffer(MAX + 1));
    await seedPrivateDream('dreamer4', {
      id: 'dream-no-op', ownerHandle: '@dreamer4', caption: 'x', style: 'y',
      videoUrl: url, mediaType: 'video', createdAt: Date.now()
      // no sourceOperationName at all
    });

    global.fetch = async function () { throw new Error('must not call fal without a usable sourceOperationName'); };

    var handler = require('../netlify/functions/admin-repair-oversized-media').handler;
    var res = await handler(fakeEvent(repairRequest()));
    var body = JSON.parse(res.body);
    assert.equal(body.failed, 1);
    var detail = body.details.find(function (d) { return d.key === 'req-no-op:video'; });
    assert.equal(detail.reason, 'missing_or_invalid_source_operation_name');
  });
});

test('an already-fixed record (byteLength already on file) is reported alreadyFixed and is never re-measured or re-fetched', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    var { getStore } = require('@netlify/blobs');
    await getStore({ name: 'dreamtube-videos' }).set('req-fixed:video', new ArrayBuffer(10), {
      metadata: { contentType: 'video/mp4', byteLength: 10 }
    });
    await seedPrivateDream('dreamer5', {
      id: 'dream-fixed', ownerHandle: '@dreamer5', caption: 'x', style: 'y',
      videoUrl: '/.netlify/functions/video-file?key=req-fixed%3Avideo', mediaType: 'video', createdAt: Date.now()
    });

    global.fetch = async function () { throw new Error('must not fetch anything for an already-fixed record'); };

    var handler = require('../netlify/functions/admin-repair-oversized-media').handler;
    var res = await handler(fakeEvent(repairRequest()));
    var body = JSON.parse(res.body);
    assert.equal(body.alreadyFixed, 1);
    assert.equal(body.backfilledMetadataOnly, 0);
    assert.equal(body.repairedViaFal, 0);
  });
});

test('a record still on fal (not yet durably hosted at all) is not a candidate here -- skippedNoDurableMedia, left to admin-backfill-media-rehost.js', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    await seedPrivateDream('dreamer6', {
      id: 'dream-still-fal', ownerHandle: '@dreamer6', caption: 'x', style: 'y',
      videoUrl: 'https://fal.media/files/still-on-fal.mp4', mediaType: 'video', createdAt: Date.now()
    });
    global.fetch = async function () { throw new Error('must not touch a still-on-fal url -- out of scope for this tool'); };

    var handler = require('../netlify/functions/admin-repair-oversized-media').handler;
    var res = await handler(fakeEvent(repairRequest()));
    var body = JSON.parse(res.body);
    // Both fields count as "no durable media": videoUrl is still on fal (not a
    // candidate for THIS tool), imageUrl is simply absent.
    assert.equal(body.skippedNoDurableMedia, 2);
    assert.equal(body.scannedMediaItems, 0);
  });
});

test('a dream with no media at all is counted skippedNoDurableMedia, not an error', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    await seedPrivateDream('dreamer7', { id: 'dream-empty', ownerHandle: '@dreamer7', caption: 'x', style: 'y', createdAt: Date.now() });

    var handler = require('../netlify/functions/admin-repair-oversized-media').handler;
    var res = await handler(fakeEvent(repairRequest()));
    var body = JSON.parse(res.body);
    assert.equal(body.skippedNoDurableMedia, 2, 'both videoUrl and imageUrl fields are absent');
    assert.equal(body.failed, 0);
  });
});

test('dryRun measures and classifies but performs no writes and calls fal for nothing', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, FAL_KEY: 'test-fal-key' }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    var MAX = require('../netlify/functions/lib/media-rehost').MAX_STREAMABLE_BYTES;

    var safeUrl = await seedLegacyDurableVideo('dry-safe:video', new ArrayBuffer(5));
    var bigUrl = await seedLegacyDurableImage('dry-big:image', new ArrayBuffer(MAX + 1));
    await seedPrivateDream('dreamer8', { id: 'dream-dry-safe', ownerHandle: '@dreamer8', caption: 'x', style: 'y', videoUrl: safeUrl, createdAt: Date.now() });
    await seedPrivateDream('dreamer9', {
      id: 'dream-dry-big', ownerHandle: '@dreamer9', caption: 'x', style: 'y', imageUrl: bigUrl, createdAt: Date.now(),
      sourceOperationName: 'fal:fal-ai/flux/dev:req-dry-big'
    });

    global.fetch = async function () { throw new Error('dryRun must never call fetch -- not fal, not Blobs media re-download'); };

    var handler = require('../netlify/functions/admin-repair-oversized-media').handler;
    var res = await handler(fakeEvent(repairRequest({ dryRun: true })));
    var body = JSON.parse(res.body);
    assert.equal(body.dryRun, true);
    assert.equal(body.backfilledMetadataOnly, 1);
    assert.equal(body.repairedViaFal, 1);

    // Nothing was actually written -- both records still have no byteLength on file.
    var { getStore } = require('@netlify/blobs');
    var safeStored = await getStore({ name: 'dreamtube-videos' }).getWithMetadata('dry-safe:video');
    assert.equal(safeStored.metadata.byteLength, undefined, 'dryRun must not backfill metadata for real');
    var bigStored = await getStore({ name: 'dreamtube-images' }).getWithMetadata('dry-big:image');
    assert.equal(bigStored.metadata.byteLength, undefined, 'dryRun must not write anything for the oversized candidate either');
    assert.equal(bigStored.metadata.sourceUrl, undefined);
  });
});

test('targetDreamIds restricts the sweep to exactly the named dreams, leaving every other candidate untouched', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    var targetUrl = await seedLegacyDurableVideo('target-dream:video', new ArrayBuffer(3));
    var otherUrl = await seedLegacyDurableVideo('other-dream:video', new ArrayBuffer(3));
    await seedPrivateDream('dreamerA', { id: 'target-dream', ownerHandle: '@a', caption: 'x', style: 'y', videoUrl: targetUrl, createdAt: Date.now() });
    await seedPrivateDream('dreamerB', { id: 'other-dream', ownerHandle: '@b', caption: 'x', style: 'y', videoUrl: otherUrl, createdAt: Date.now() });

    var handler = require('../netlify/functions/admin-repair-oversized-media').handler;
    var res = await handler(fakeEvent(repairRequest({ targetDreamIds: ['target-dream'] })));
    var body = JSON.parse(res.body);
    assert.equal(body.backfilledMetadataOnly, 1);

    var { getStore } = require('@netlify/blobs');
    var targetStored = await getStore({ name: 'dreamtube-videos' }).getWithMetadata('target-dream:video');
    assert.equal(targetStored.metadata.byteLength, 3);
    var otherStored = await getStore({ name: 'dreamtube-videos' }).getWithMetadata('other-dream:video');
    assert.equal(otherStored.metadata.byteLength, undefined, 'a record not in targetDreamIds must be left completely untouched');
  });
});

test('targetKeys restricts the sweep to exactly the named Blobs keys (a separate identifier space from dream ids -- e.g. the fal-requestId-shaped key a real broken record is reported by)', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    var targetUrl = await seedLegacyDurableVideo('019fc2e9-2f8d-7dc0-8ce7-7efd3acf0d2f', new ArrayBuffer(3));
    var otherUrl = await seedLegacyDurableVideo('some-other-key', new ArrayBuffer(3));
    await seedPrivateDream('dreamerX', { id: 'd49us2fm', ownerHandle: '@x', caption: 'x', style: 'y', videoUrl: targetUrl, createdAt: Date.now() });
    await seedPrivateDream('dreamerY', { id: 'dm7noea6', ownerHandle: '@y', caption: 'x', style: 'y', videoUrl: otherUrl, createdAt: Date.now() });

    var handler = require('../netlify/functions/admin-repair-oversized-media').handler;
    var res = await handler(fakeEvent(repairRequest({ targetKeys: ['019fc2e9-2f8d-7dc0-8ce7-7efd3acf0d2f'] })));
    var body = JSON.parse(res.body);
    assert.equal(body.backfilledMetadataOnly, 1);

    var { getStore } = require('@netlify/blobs');
    var targetStored = await getStore({ name: 'dreamtube-videos' }).getWithMetadata('019fc2e9-2f8d-7dc0-8ce7-7efd3acf0d2f');
    assert.equal(targetStored.metadata.byteLength, 3);
    var otherStored = await getStore({ name: 'dreamtube-videos' }).getWithMetadata('some-other-key');
    assert.equal(otherStored.metadata.byteLength, undefined, 'a key not in targetKeys must be left completely untouched, even though its owning dream was scanned');
  });
});

test('a durable url with an unreadable blob behind it (metadata present, data missing) is reported blobMissing, not a crash', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    await seedPrivateDream('dreamerC', {
      id: 'dream-ghost', ownerHandle: '@c', caption: 'x', style: 'y',
      videoUrl: '/.netlify/functions/video-file?key=ghost-key', createdAt: Date.now()
    });
    // No blob ever written under "ghost-key" -- getMetadata returns null.

    var handler = require('../netlify/functions/admin-repair-oversized-media').handler;
    var res = await handler(fakeEvent(repairRequest()));
    var body = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);
    assert.equal(body.blobMissing, 1);
  });
});

test('sweeps the published feed too, in the feed phase', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    var url = await seedLegacyDurableVideo('feed-item:video', new ArrayBuffer(7));
    seedFeed([{ id: 'feed-item', ownerHandle: '@feedowner', caption: 'x', style: 'y', videoUrl: url, publishedAt: Date.now() }]);

    var handler = require('../netlify/functions/admin-repair-oversized-media').handler;
    var res = await handler(fakeEvent(repairRequest({ cursor: 'feed' })));
    var body = JSON.parse(res.body);
    assert.equal(body.phase, 'feed');
    assert.equal(body.done, true);
    assert.equal(body.backfilledMetadataOnly, 1);

    var { getStore } = require('@netlify/blobs');
    var stored = await getStore({ name: 'dreamtube-videos' }).getWithMetadata('feed-item:video');
    assert.equal(stored.metadata.byteLength, 7);
  });
});

test('pagination: nextCursor advances from an accounts offset to "feed", same shape as admin-backfill-media-rehost.js', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    var url1 = await seedLegacyDurableVideo('p1:video', new ArrayBuffer(2));
    var url2 = await seedLegacyDurableVideo('p2:video', new ArrayBuffer(2));
    await seedPrivateDream('pa1', { id: 'p1', ownerHandle: '@pa1', caption: 'x', style: 'y', videoUrl: url1, createdAt: Date.now() });
    await seedPrivateDream('pa2', { id: 'p2', ownerHandle: '@pa2', caption: 'x', style: 'y', videoUrl: url2, createdAt: Date.now() });

    var handler = require('../netlify/functions/admin-repair-oversized-media').handler;
    var page1 = JSON.parse((await handler(fakeEvent(repairRequest({ limit: 1 })))).body);
    assert.equal(page1.phase, 'accounts');
    assert.equal(page1.done, false);
    assert.equal(page1.nextCursor, '1');

    var page2 = JSON.parse((await handler(fakeEvent(repairRequest({ limit: 1, cursor: page1.nextCursor })))).body);
    assert.equal(page2.nextCursor, 'feed');

    var feedPage = JSON.parse((await handler(fakeEvent(repairRequest({ cursor: 'feed' })))).body);
    assert.equal(feedPage.done, true);
  });
});

// ===== auth / request shape (same bar as every sibling admin-*.js tool) =====

test('POST rejects missing fields, invalid JSON, invalid limit, and non-POST methods', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var handler = require('../netlify/functions/admin-repair-oversized-media').handler;

    var wrongMethod = await handler(fakeEvent({ method: 'GET' }));
    assert.equal(wrongMethod.statusCode, 405);

    var badJson = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: '{not json' }));
    assert.equal(badJson.statusCode, 400);
    assert.match(JSON.parse(badJson.body).error, /^E3: invalid_json/);

    var missing = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: 'someone' } }));
    assert.equal(missing.statusCode, 400);
    assert.match(JSON.parse(missing.body).error, /^E4: missing_fields/);

    var badLimit = await handler(fakeEvent(repairRequest({ limit: -5 })));
    assert.equal(badLimit.statusCode, 400);
    assert.match(JSON.parse(badLimit.body).error, /^E7: invalid_limit/);

    var tooBigLimit = await handler(fakeEvent(repairRequest({ limit: 99999 })));
    assert.equal(tooBigLimit.statusCode, 400);
    assert.match(JSON.parse(tooBigLimit.body).error, /^E7: invalid_limit/);
  });
});

test('POST rejects a real, correct password belonging to a non-owner account (403 E5), and never writes anything', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var accountStore = require('../netlify/functions/lib/account-store');
    var event = fakeEvent({ method: 'POST' });
    await accountStore.createAccount(event, { username: 'randomguy', password: 'randompw123', email: 'random@example.com' });
    var url = await seedLegacyDurableVideo('victim:video', new ArrayBuffer(4));
    await seedPrivateDream('victim', { id: 'dv', ownerHandle: '@victim', caption: 'x', style: 'y', videoUrl: url, createdAt: Date.now() });

    var handler = require('../netlify/functions/admin-repair-oversized-media').handler;
    var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: 'randomguy', password: 'randompw123' } }));
    assert.equal(res.statusCode, 403);
    assert.match(JSON.parse(res.body).error, /^E5: forbidden/);

    var { getStore } = require('@netlify/blobs');
    var stored = await getStore({ name: 'dreamtube-videos' }).getWithMetadata('victim:video');
    assert.equal(stored.metadata.byteLength, undefined, 'a rejected auth attempt must never touch any media record');
  });
});

test('is rejected with 500 when OWNER_EMAIL is not configured, before any credential check', function () {
  return withEnv({ OWNER_EMAIL: undefined }, async function () {
    var handler = require('../netlify/functions/admin-repair-oversized-media').handler;
    var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: 'anyone', password: 'whatever123' } }));
    assert.equal(res.statusCode, 500);
    assert.match(JSON.parse(res.body).error, /^E2: missing_owner_email/);
  });
});

test('POST exceeding MAX_ADMIN_REPAIR_OVERSIZED_MEDIA_PER_IP_PER_DAY is rejected with 429 E6', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, MAX_ADMIN_REPAIR_OVERSIZED_MEDIA_PER_IP_PER_DAY: '1' }, async function () {
    var handler = require('../netlify/functions/admin-repair-oversized-media').handler;
    var ip = nextIp();

    var first = await handler(fakeEvent({ method: 'POST', ip: ip, body: { usernameOrEmail: 'nobody', password: 'wrongpw123' } }));
    assert.equal(first.statusCode, 403);

    var second = await handler(fakeEvent({ method: 'POST', ip: ip, body: { usernameOrEmail: OWNER_EMAIL, password: OWNER_PASSWORD } }));
    assert.equal(second.statusCode, 429);
    assert.match(JSON.parse(second.body).error, /^E6: rate_limited/);
  });
});

test('a genuinely oversized record with no FAL_KEY configured fails with a clear missing_fal_key reason, no crash', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, FAL_KEY: undefined }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    var MAX = require('../netlify/functions/lib/media-rehost').MAX_STREAMABLE_BYTES;
    var url = await seedLegacyDurableVideo('no-key:video', new ArrayBuffer(MAX + 1));
    await seedPrivateDream('dreamerD', {
      id: 'dream-no-key', ownerHandle: '@d', caption: 'x', style: 'y', videoUrl: url, createdAt: Date.now(),
      sourceOperationName: 'fal:fal-ai/veo3.1/fast:req-no-key'
    });

    var handler = require('../netlify/functions/admin-repair-oversized-media').handler;
    var res = await handler(fakeEvent(repairRequest()));
    var body = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);
    assert.equal(body.failed, 1);
    var detail = body.details.find(function (d) { return d.key === 'no-key:video'; });
    assert.equal(detail.reason, 'missing_fal_key');
  });
});
