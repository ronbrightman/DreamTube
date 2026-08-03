// test/admin-postpack-data.test.js
//
// Covers netlify/functions/admin-postpack-data.js — tracker item
// for-product-instagram-tiktok-auto-postin-cahr76, Manager's SPEC v1
// (manual-export MVP). Same test conventions as
// test/admin-media-library-data.test.js (its own owner-gate/rate-limit
// shape is duplicated from that file, mirrored here identically).

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
  return '10.66.4.' + ipCounter;
}

test.beforeEach(function () {
  mockBlobs.reset();
  delete require.cache[require.resolve('../netlify/functions/admin-postpack-data')];
  delete require.cache[require.resolve('../netlify/functions/lib/account-store')];
  delete require.cache[require.resolve('../netlify/functions/lib/postpack-store')];
});

async function seedOwnerAccount(event) {
  var accountStore = require('../netlify/functions/lib/account-store');
  return accountStore.createAccount(event, { username: 'ronbrightman', password: OWNER_PASSWORD, email: OWNER_EMAIL });
}

function seedPackItems(items) {
  mockBlobs.seed('dreamtube-postpack-items', 'items', items);
}

function dataRequest(overrides) {
  return { method: 'POST', ip: nextIp(), body: Object.assign({ usernameOrEmail: OWNER_EMAIL, password: OWNER_PASSWORD }, overrides || {}) };
}

test('returns every stored pack item, newest-built-first', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    var now = Date.now();
    seedPackItems([
      { id: 'd1:instagram', dreamId: 'd1', channel: 'instagram', ownerHandle: '@alice', mediaType: 'video', mediaUrl: 'https://fal.media/a.mp4', caption: 'x', hashtags: ['#DreamTube'], builtAt: now - 5000 },
      { id: 'd2:tiktok', dreamId: 'd2', channel: 'tiktok', ownerHandle: '@bob', mediaType: 'image', mediaUrl: 'https://fal.media/b.png', caption: 'y', hashtags: ['#DreamTube'], builtAt: now }
    ]);

    var handler = require('../netlify/functions/admin-postpack-data').handler;
    var res = await handler(fakeEvent(dataRequest()));
    assert.equal(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.items.length, 2);
    assert.equal(body.items[0].id, 'd2:tiktok', 'newest builtAt first');
    assert.equal(body.items[1].id, 'd1:instagram');
  });
});

test('an empty pack store returns an empty items array, not an error', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);

    var handler = require('../netlify/functions/admin-postpack-data').handler;
    var res = await handler(fakeEvent(dataRequest()));
    var body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.deepEqual(body.items, []);
  });
});

test('POST rejects missing fields, invalid JSON, and non-POST methods', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var handler = require('../netlify/functions/admin-postpack-data').handler;

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

    var handler = require('../netlify/functions/admin-postpack-data').handler;
    var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: 'randomguy', password: 'randompw123' } }));
    assert.equal(res.statusCode, 403);
    assert.match(JSON.parse(res.body).error, /^E5: forbidden/);
  });
});

test('is rejected with 500 when OWNER_EMAIL is not configured, before any credential check', function () {
  return withEnv({ OWNER_EMAIL: undefined }, async function () {
    var handler = require('../netlify/functions/admin-postpack-data').handler;
    var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: 'anyone', password: 'whatever123' } }));
    assert.equal(res.statusCode, 500);
    assert.match(JSON.parse(res.body).error, /^E2: missing_owner_email/);
  });
});

test('POST exceeding MAX_ADMIN_POSTPACK_DATA_PER_IP_PER_DAY is rejected with 429 E6', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, MAX_ADMIN_POSTPACK_DATA_PER_IP_PER_DAY: '1' }, async function () {
    var handler = require('../netlify/functions/admin-postpack-data').handler;
    var ip = nextIp();

    var first = await handler(fakeEvent({ method: 'POST', ip: ip, body: { usernameOrEmail: 'nobody', password: 'wrongpw123' } }));
    assert.equal(first.statusCode, 403);

    var second = await handler(fakeEvent({ method: 'POST', ip: ip, body: { usernameOrEmail: OWNER_EMAIL, password: OWNER_PASSWORD } }));
    assert.equal(second.statusCode, 429);
    assert.match(JSON.parse(second.body).error, /^E6: rate_limited/);
  });
});
