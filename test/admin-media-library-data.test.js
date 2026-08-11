// test/admin-media-library-data.test.js
//
// Covers netlify/functions/admin-media-library-data.js — tracker item
// for-product-owner-media-library-page-fou-1fwxaw (Part 3's data feed):
// reads the same two real stores admin-backfill-media-rehost.js sweeps and
// classifies every media item through lib/media-status.js's
// classifyMediaUrl, so its counts can never diverge from what the backfill
// sweep actually did. Same test conventions as
// test/admin-diagnose-account-duplicates.test.js.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var mediaStatus = require('../netlify/functions/lib/media-status');

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
  return '10.55.3.' + ipCounter;
}

test.beforeEach(function () {
  mockBlobs.reset();
  delete require.cache[require.resolve('../netlify/functions/admin-media-library-data')];
  delete require.cache[require.resolve('../netlify/functions/lib/account-store')];
  delete require.cache[require.resolve('../netlify/functions/lib/dream-store')];
  delete require.cache[require.resolve('../netlify/functions/lib/entitlements')];
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

function dataRequest(overrides) {
  return { method: 'POST', ip: nextIp(), body: Object.assign({ usernameOrEmail: OWNER_EMAIL, password: OWNER_PASSWORD }, overrides || {}) };
}

test('returns one item per media field, correctly classified, for both private and published dreams', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);

    var now = Date.now();
    await seedPrivateDream('dreamer1', {
      id: 'dream-1', ownerHandle: '@dreamer1', caption: 'x', style: 'y',
      videoUrl: '/.netlify/functions/video-file?key=abc', mediaType: 'video', createdAt: now
    });
    seedFeed([{
      id: 'feed-1', ownerHandle: '@published1', caption: 'x', style: 'y',
      videoUrl: 'https://fal.media/files/still-alive.mp4', mediaType: 'video', publishedAt: now
    }]);

    var handler = require('../netlify/functions/admin-media-library-data').handler;
    var res = await handler(fakeEvent(dataRequest()));
    assert.equal(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.items.length, 2);

    var privateItem = body.items.find(function (it) { return it.dreamId === 'dream-1'; });
    assert.equal(privateItem.status, 're-hosted-durable');
    assert.equal(privateItem.isPublished, false);
    assert.equal(privateItem.ownerHandle, '@dreamer1');

    var publishedItem = body.items.find(function (it) { return it.dreamId === 'feed-1'; });
    assert.equal(publishedItem.status, 'still-on-fal');
    assert.equal(publishedItem.isPublished, true);
    assert.equal(publishedItem.ownerHandle, '@published1');
  });
});

test('a dream with both imageUrl and videoUrl emits two separate items', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    await seedPrivateDream('dreamer2', {
      id: 'dream-2', ownerHandle: '@dreamer2', caption: 'x', style: 'y',
      videoUrl: '/.netlify/functions/video-file?key=v2', imageUrl: '/.netlify/functions/image-file?key=i2',
      mediaType: 'video', createdAt: Date.now()
    });

    var handler = require('../netlify/functions/admin-media-library-data').handler;
    var res = await handler(fakeEvent(dataRequest()));
    var body = JSON.parse(res.body);
    assert.equal(body.items.length, 2);
    assert.ok(body.items.some(function (it) { return it.id === 'dream-2:video'; }));
    assert.ok(body.items.some(function (it) { return it.id === 'dream-2:image'; }));
  });
});

test('a dream with no media at all emits no items', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    await seedPrivateDream('dreamer3', { id: 'dream-3', ownerHandle: '@dreamer3', caption: 'x', style: 'y', createdAt: Date.now() });

    var handler = require('../netlify/functions/admin-media-library-data').handler;
    var res = await handler(fakeEvent(dataRequest()));
    var body = JSON.parse(res.body);
    assert.equal(body.items.length, 0);
  });
});

// ===== storyText (tracker for-product-media-library-founder-08-03--6h7fmv,
// founder: "also show the text they wrote") — the human-readable dream
// description the user actually typed, never the engineered promptText.
// See admin-media-library-data.js's own header comment for the full
// storyText/caption/promptText fallback reasoning. =====

test('a private dream with a distinct storyText returns it verbatim, not the caption', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    await seedPrivateDream('dreamer5', {
      id: 'dream-5', ownerHandle: '@dreamer5', caption: 'engineered caption text', style: 'y',
      promptText: 'engineered caption text', storyText: 'I was flying over a purple ocean.',
      videoUrl: 'https://fal.media/files/five.mp4', mediaType: 'video', createdAt: Date.now()
    });

    var handler = require('../netlify/functions/admin-media-library-data').handler;
    var res = await handler(fakeEvent(dataRequest()));
    var body = JSON.parse(res.body);
    var item = body.items.find(function (it) { return it.dreamId === 'dream-5'; });
    assert.equal(item.storyText, 'I was flying over a purple ocean.');
  });
});

test('a pre-split private dream with no distinct storyText falls back to its caption', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    await seedPrivateDream('dreamer6', {
      id: 'dream-6', ownerHandle: '@dreamer6', caption: 'A pre-split legacy dream, one field did both jobs.', style: 'y',
      videoUrl: 'https://fal.media/files/six.mp4', mediaType: 'video', createdAt: Date.now()
    });

    var handler = require('../netlify/functions/admin-media-library-data').handler;
    var res = await handler(fakeEvent(dataRequest()));
    var body = JSON.parse(res.body);
    var item = body.items.find(function (it) { return it.dreamId === 'dream-6'; });
    assert.equal(item.storyText, 'A pre-split legacy dream, one field did both jobs.');
  });
});

test('a published feed item (no separate storyText field on the wire) uses its caption as storyText', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    seedFeed([{
      id: 'feed-3', ownerHandle: '@pubowner2', caption: 'A published dream about a purple ocean.', style: 'y',
      videoUrl: 'https://fal.media/files/seven.mp4', mediaType: 'video', publishedAt: Date.now()
    }]);

    var handler = require('../netlify/functions/admin-media-library-data').handler;
    var res = await handler(fakeEvent(dataRequest()));
    var body = JSON.parse(res.body);
    var item = body.items.find(function (it) { return it.dreamId === 'feed-3'; });
    assert.equal(item.storyText, 'A published dream about a purple ocean.');
  });
});

test('a dream with no text on file at all (no storyText or caption) returns null, not an empty string', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    await seedPrivateDream('dreamer7', {
      id: 'dream-7', ownerHandle: '@dreamer7', style: 'y',
      videoUrl: 'https://fal.media/files/eight.mp4', mediaType: 'video', createdAt: Date.now()
    });

    var handler = require('../netlify/functions/admin-media-library-data').handler;
    var res = await handler(fakeEvent(dataRequest()));
    var body = JSON.parse(res.body);
    var item = body.items.find(function (it) { return it.dreamId === 'dream-7'; });
    assert.equal(item.storyText, null);
  });
});

test('counts genuinely match lib/media-status.js\'s own classification -- no separate parallel computation', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    var oldTs = mediaStatus.NO_EXPIRY_HEADER_SHIP_AT - (100 * 24 * 60 * 60 * 1000);
    await seedPrivateDream('dreamer4', {
      id: 'dream-4', ownerHandle: '@dreamer4', caption: 'x', style: 'y',
      videoUrl: 'https://fal.media/files/ancient.mp4', mediaType: 'video', createdAt: oldTs
    });

    var handler = require('../netlify/functions/admin-media-library-data').handler;
    var res = await handler(fakeEvent(dataRequest()));
    var body = JSON.parse(res.body);
    var item = body.items[0];
    var directClassification = mediaStatus.classifyMediaUrl('https://fal.media/files/ancient.mp4', oldTs);
    assert.equal(item.status, directClassification.status);
    assert.equal(item.status, 'lost-expired');
  });
});

test('a published feed record with no createdAt falls back to publishedAt for its age estimate', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    seedFeed([{ id: 'feed-2', ownerHandle: '@pubowner', caption: 'x', style: 'y', videoUrl: 'https://fal.media/x.mp4', publishedAt: Date.now() }]);

    var handler = require('../netlify/functions/admin-media-library-data').handler;
    var res = await handler(fakeEvent(dataRequest()));
    var body = JSON.parse(res.body);
    assert.equal(body.items[0].createdAt, body.items[0].createdAt); // sanity: present
    assert.ok(body.items[0].createdAt > 0, 'publishedAt used as the createdAt stand-in');
  });
});

// ===== createdAt stamping (tracker item for-product-media-library-stamp-
// durable--u4oju3, root-cause fix): the actual founder-reported bug -- both
// private and published records now carry a real, durably-stamped
// createdAt going forward. =====

test('a published feed record WITH a real createdAt (post-fix publish-dream.js) uses it, never falling back to publishedAt', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    var realCreatedAt = 1780000000000;
    var muchLaterPublishedAt = realCreatedAt + 5 * 24 * 60 * 60 * 1000; // published 5 days after it was actually made
    seedFeed([{ id: 'feed-4', ownerHandle: '@pubowner3', caption: 'x', style: 'y', videoUrl: 'https://fal.media/z.mp4', createdAt: realCreatedAt, publishedAt: muchLaterPublishedAt }]);

    var handler = require('../netlify/functions/admin-media-library-data').handler;
    var res = await handler(fakeEvent(dataRequest()));
    var body = JSON.parse(res.body);
    var item = body.items.find(function (it) { return it.dreamId === 'feed-4'; });
    assert.equal(item.createdAt, realCreatedAt, 'the real stamped createdAt must win over the later publishedAt approximation');
  });
});

test('a private dream synced with no createdAt (the pre-fix gap) shows unknown time and sinks to the end of a newest-first sort -- exactly the founder-reported symptom, still reproduced for a record this fix genuinely cannot repair', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    // No createdAt at all -- simulates a private dream synced before the
    // dream-sync.js/js/store.js whitelist fix.
    await seedPrivateDream('dreamer8', { id: 'dream-8', ownerHandle: '@dreamer8', caption: 'x', style: 'y', videoUrl: 'https://fal.media/nine.mp4', mediaType: 'video' });

    var handler = require('../netlify/functions/admin-media-library-data').handler;
    var res = await handler(fakeEvent(dataRequest()));
    var body = JSON.parse(res.body);
    var item = body.items.find(function (it) { return it.dreamId === 'dream-8'; });
    assert.equal(item.createdAt, null, 'a genuinely un-derivable pre-fix record must stay unknown, never a fabricated value');
  });
});

test('a HISTORICAL private dream with no createdAt but a real updatedAt falls back to updatedAt (never blank/last in the newest-sort)', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    var realUpdatedAt = 1781500000000;
    // No createdAt (predates createdAt stamping), but a real updatedAt — the
    // exact shape dream-sync.js guarantees for every synced private dream
    // (`out.updatedAt = Date.now()` if missing). Founder report: these old
    // videos showed a blank timestamp and sank to the bottom.
    await seedPrivateDream('dreamer10', { id: 'dream-10', ownerHandle: '@dreamer10', caption: 'x', style: 'y', videoUrl: 'https://fal.media/eleven.mp4', mediaType: 'video', updatedAt: realUpdatedAt });

    var handler = require('../netlify/functions/admin-media-library-data').handler;
    var res = await handler(fakeEvent(dataRequest()));
    var body = JSON.parse(res.body);
    var item = body.items.find(function (it) { return it.dreamId === 'dream-10'; });
    assert.equal(item.createdAt, realUpdatedAt, 'the historical-backfill fallback surfaces updatedAt as the displayable/sortable timestamp');
  });
});

test('a private dream WITH a real createdAt still prefers it over updatedAt', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    var realCreatedAt = 1781000000000;
    var laterUpdatedAt = realCreatedAt + 3 * 24 * 60 * 60 * 1000;
    await seedPrivateDream('dreamer11', { id: 'dream-11', ownerHandle: '@dreamer11', caption: 'x', style: 'y', videoUrl: 'https://fal.media/twelve.mp4', mediaType: 'video', createdAt: realCreatedAt, updatedAt: laterUpdatedAt });

    var handler = require('../netlify/functions/admin-media-library-data').handler;
    var res = await handler(fakeEvent(dataRequest()));
    var body = JSON.parse(res.body);
    var item = body.items.find(function (it) { return it.dreamId === 'dream-11'; });
    assert.equal(item.createdAt, realCreatedAt, 'the real createdAt wins; updatedAt is only the historical fallback');
  });
});

test('a private dream synced WITH a real createdAt (post-fix js/store.js + dream-sync.js) carries it through to the media library data feed', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    var realCreatedAt = 1781000000000;
    await seedPrivateDream('dreamer9', { id: 'dream-9', ownerHandle: '@dreamer9', caption: 'x', style: 'y', videoUrl: 'https://fal.media/ten.mp4', mediaType: 'video', createdAt: realCreatedAt });

    var handler = require('../netlify/functions/admin-media-library-data').handler;
    var res = await handler(fakeEvent(dataRequest()));
    var body = JSON.parse(res.body);
    var item = body.items.find(function (it) { return it.dreamId === 'dream-9'; });
    assert.equal(item.createdAt, realCreatedAt);
  });
});

// ===== auth / request shape =====

test('POST rejects missing fields, invalid JSON, and non-POST methods', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var handler = require('../netlify/functions/admin-media-library-data').handler;

    var wrongMethod = await handler(fakeEvent({ method: 'GET' }));
    assert.equal(wrongMethod.statusCode, 405);

    var badJson = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: '{not json' }));
    assert.equal(badJson.statusCode, 400);
    assert.match(JSON.parse(badJson.body).error, /^E3: invalid_json/);

    var missing = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: 'someone' } }));
    assert.equal(missing.statusCode, 400);
    assert.match(JSON.parse(missing.body).error, /^E4: missing_fields/);
  });
});

test('POST rejects a real, correct password belonging to a non-owner account (403 E5)', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var accountStore = require('../netlify/functions/lib/account-store');
    var event = fakeEvent({ method: 'POST' });
    await accountStore.createAccount(event, { username: 'randomguy', password: 'randompw123', email: 'random@example.com' });
    await seedPrivateDream('victim', { id: 'dv', ownerHandle: '@victim', caption: 'x', style: 'y', videoUrl: 'https://fal.media/v.mp4', createdAt: Date.now() });

    var handler = require('../netlify/functions/admin-media-library-data').handler;
    var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: 'randomguy', password: 'randompw123' } }));
    assert.equal(res.statusCode, 403);
    assert.match(JSON.parse(res.body).error, /^E5: forbidden/);
  });
});

test('is rejected with 500 when OWNER_EMAIL is not configured, before any credential check', function () {
  return withEnv({ OWNER_EMAIL: undefined }, async function () {
    var handler = require('../netlify/functions/admin-media-library-data').handler;
    var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: 'anyone', password: 'whatever123' } }));
    assert.equal(res.statusCode, 500);
    assert.match(JSON.parse(res.body).error, /^E2: missing_owner_email/);
  });
});

test('POST exceeding MAX_ADMIN_MEDIA_LIBRARY_DATA_PER_IP_PER_DAY is rejected with 429 E6', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, MAX_ADMIN_MEDIA_LIBRARY_DATA_PER_IP_PER_DAY: '1' }, async function () {
    var handler = require('../netlify/functions/admin-media-library-data').handler;
    var ip = nextIp();

    var first = await handler(fakeEvent({ method: 'POST', ip: ip, body: { usernameOrEmail: 'nobody', password: 'wrongpw123' } }));
    assert.equal(first.statusCode, 403);

    var second = await handler(fakeEvent({ method: 'POST', ip: ip, body: { usernameOrEmail: OWNER_EMAIL, password: OWNER_PASSWORD } }));
    assert.equal(second.statusCode, 429);
    assert.match(JSON.parse(second.body).error, /^E6: rate_limited/);
  });
});
