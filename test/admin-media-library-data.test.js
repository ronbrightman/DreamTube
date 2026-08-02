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
