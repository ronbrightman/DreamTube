// test/admin-repair-feed-likes.test.js
//
// Covers netlify/functions/admin-repair-feed-likes.js — the one-off repair
// endpoint for tracker item for-product-likes-vanish-from-feed-video-fyqks0
// (see that file's own header comment, and like-dream.js's own STALE-READ
// CLOBBER FIX comment, for the full incident this restores). Same test
// conventions as test/admin-restore-founder-email.test.js.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var { getStore } = require('@netlify/blobs');

var OWNER_EMAIL = 'ronbrightman@example.com';
var OWNER_USERNAME = 'ronbrightman';
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

test.beforeEach(function () {
  mockBlobs.reset();
  delete require.cache[require.resolve('../netlify/functions/admin-repair-feed-likes')];
  delete require.cache[require.resolve('../netlify/functions/lib/account-store')];
  delete require.cache[require.resolve('../netlify/functions/lib/entitlements')];
});

var ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return '10.9.3.' + ipCounter;
}

async function seedOwnerAccount(event) {
  var accountStore = require('../netlify/functions/lib/account-store');
  return accountStore.createAccount(event, { username: OWNER_USERNAME, password: OWNER_PASSWORD, email: OWNER_EMAIL });
}

async function seedFeed(dreams) {
  var store = getStore('dreamtube-feed');
  await store.setJSON('feed-index', dreams);
}

function call(method, params) {
  var handler = require('../netlify/functions/admin-repair-feed-likes').handler;
  if (method === 'GET') {
    return handler(fakeEvent({ method: 'GET', ip: nextIp(), query: params }));
  }
  return handler(fakeEvent({ method: 'POST', ip: nextIp(), body: params }));
}

// ===== the actual repair =====

test('POST applies +1 to each of the 3 target dreams, leaving unrelated dreams untouched', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    await seedFeed([
      { id: 'dvkt5z2x', ownerHandle: '@ben', likes: 2 },
      { id: 'dztocy69', ownerHandle: '@richard', likes: 2 },
      { id: 'dioart8a', ownerHandle: '@ben', likes: 1 },
      { id: 'unrelated-dream', ownerHandle: '@someone', likes: 7 }
    ]);

    var res = await call('POST', { usernameOrEmail: OWNER_USERNAME, password: OWNER_PASSWORD });
    assert.equal(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.dryRun, false);

    var byId = {};
    body.repairs.forEach(function (r) { byId[r.id] = r; });
    assert.equal(byId['dvkt5z2x'].likesBefore, 2);
    assert.equal(byId['dvkt5z2x'].likesAfter, 3);
    assert.equal(byId['dztocy69'].likesBefore, 2);
    assert.equal(byId['dztocy69'].likesAfter, 3);
    assert.equal(byId['dioart8a'].likesBefore, 1);
    assert.equal(byId['dioart8a'].likesAfter, 2);

    var store = getStore('dreamtube-feed');
    var finalFeed = await store.get('feed-index', { type: 'json' });
    function likesOf(id) { return finalFeed.filter(function (d) { return d.id === id; })[0].likes; }
    assert.equal(likesOf('dvkt5z2x'), 3);
    assert.equal(likesOf('dztocy69'), 3);
    assert.equal(likesOf('dioart8a'), 2);
    assert.equal(likesOf('unrelated-dream'), 7, 'an unrelated dream in the same feed array must be untouched');
  });
});

test('POST is idempotent: calling it a second time does not apply a second +1', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    await seedFeed([
      { id: 'dvkt5z2x', ownerHandle: '@ben', likes: 2 },
      { id: 'dztocy69', ownerHandle: '@richard', likes: 2 },
      { id: 'dioart8a', ownerHandle: '@ben', likes: 1 }
    ]);

    var first = await call('POST', { usernameOrEmail: OWNER_USERNAME, password: OWNER_PASSWORD });
    assert.equal(JSON.parse(first.body).ok, true);

    var second = await call('POST', { usernameOrEmail: OWNER_USERNAME, password: OWNER_PASSWORD });
    var secondBody = JSON.parse(second.body);
    assert.equal(secondBody.ok, true);
    secondBody.repairs.forEach(function (r) {
      assert.equal(r.alreadyRepaired, true, r.id + ' must be reported already repaired on the second call');
    });

    var store = getStore('dreamtube-feed');
    var finalFeed = await store.get('feed-index', { type: 'json' });
    function likesOf(id) { return finalFeed.filter(function (d) { return d.id === id; })[0].likes; }
    assert.equal(likesOf('dvkt5z2x'), 3, 'must still be exactly ONE +1 applied, not two');
    assert.equal(likesOf('dztocy69'), 3);
    assert.equal(likesOf('dioart8a'), 2);
  });
});

test('a target dream missing from the feed is reported found:false and does not error the whole request', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    await seedFeed([
      { id: 'dvkt5z2x', ownerHandle: '@ben', likes: 2 }
      // dztocy69 and dioart8a deliberately absent
    ]);

    var res = await call('POST', { usernameOrEmail: OWNER_USERNAME, password: OWNER_PASSWORD });
    var body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    var byId = {};
    body.repairs.forEach(function (r) { byId[r.id] = r; });
    assert.equal(byId['dvkt5z2x'].found, true);
    assert.equal(byId['dvkt5z2x'].likesAfter, 3);
    assert.equal(byId['dztocy69'].found, false);
    assert.equal(byId['dioart8a'].found, false);
  });
});

test('none of the 3 target dreams present -> reports all found:false, no write performed', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    await seedFeed([{ id: 'unrelated', ownerHandle: '@x', likes: 5 }]);

    var res = await call('POST', { usernameOrEmail: OWNER_USERNAME, password: OWNER_PASSWORD });
    var body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    body.repairs.forEach(function (r) { assert.equal(r.found, false); });

    var store = getStore('dreamtube-feed');
    var finalFeed = await store.get('feed-index', { type: 'json' });
    assert.equal(finalFeed.length, 1, 'the feed must be untouched -- no spurious write');
    assert.equal(finalFeed[0].likes, 5);
  });
});

// ===== GET: read-only preview, never mutates =====

test('GET reports what a repair WOULD do, without writing anything', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    await seedFeed([
      { id: 'dvkt5z2x', ownerHandle: '@ben', likes: 2 },
      { id: 'dztocy69', ownerHandle: '@richard', likes: 2 },
      { id: 'dioart8a', ownerHandle: '@ben', likes: 1 }
    ]);

    var res = await call('GET', { usernameOrEmail: OWNER_USERNAME, password: OWNER_PASSWORD });
    var body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.dryRun, true);
    var byId = {};
    body.repairs.forEach(function (r) { byId[r.id] = r; });
    assert.equal(byId['dvkt5z2x'].likesAfter, 3, 'GET must report what a repair would produce');

    var store = getStore('dreamtube-feed');
    var stillUnrepaired = await store.get('feed-index', { type: 'json' });
    assert.equal(stillUnrepaired.filter(function (d) { return d.id === 'dvkt5z2x'; })[0].likes, 2, 'GET must never write anything');
  });
});

test('GET after a real POST repair reports already_repaired for all 3', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    await seedFeed([
      { id: 'dvkt5z2x', ownerHandle: '@ben', likes: 2 },
      { id: 'dztocy69', ownerHandle: '@richard', likes: 2 },
      { id: 'dioart8a', ownerHandle: '@ben', likes: 1 }
    ]);
    await call('POST', { usernameOrEmail: OWNER_USERNAME, password: OWNER_PASSWORD });

    var res = await call('GET', { usernameOrEmail: OWNER_USERNAME, password: OWNER_PASSWORD });
    var body = JSON.parse(res.body);
    body.repairs.forEach(function (r) { assert.equal(r.alreadyRepaired, true); });
  });
});

// ===== auth / refusals =====

test('rejects the wrong password with E5', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    var res = await call('POST', { usernameOrEmail: OWNER_USERNAME, password: 'totally-wrong' });
    assert.equal(res.statusCode, 403);
    assert.equal(JSON.parse(res.body).error, 'E5: forbidden');
  });
});

test('rejects a real account whose own email is not OWNER_EMAIL', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var accountStore = require('../netlify/functions/lib/account-store');
    var event = fakeEvent({ method: 'POST' });
    await accountStore.createAccount(event, { username: 'someone-else', password: 'someoneelsepw1', email: 'someone-else@example.com' });

    var res = await call('POST', { usernameOrEmail: 'someone-else', password: 'someoneelsepw1' });
    assert.equal(res.statusCode, 403);
    assert.equal(JSON.parse(res.body).error, 'E5: forbidden');
  });
});

test('rejects a non-GET/POST method', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var handler = require('../netlify/functions/admin-repair-feed-likes').handler;
    var res = await handler(fakeEvent({ method: 'DELETE', ip: nextIp() }));
    assert.equal(res.statusCode, 405);
  });
});

test('500s cleanly when OWNER_EMAIL is not configured', function () {
  return withEnv({ OWNER_EMAIL: undefined }, async function () {
    var res = await call('POST', { usernameOrEmail: OWNER_USERNAME, password: OWNER_PASSWORD });
    assert.equal(res.statusCode, 500);
    assert.equal(JSON.parse(res.body).error, 'E2: missing_owner_email');
  });
});

test('400s on missing fields', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var res = await call('POST', { usernameOrEmail: OWNER_USERNAME });
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error, 'E4: missing_fields');
  });
});

// ===== rate limiting =====

test('rate-limits repeated attempts per identifier', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, MAX_ADMIN_REPAIR_FEED_LIKES_PER_IDENTIFIER_PER_DAY: '2' }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);

    var handler = require('../netlify/functions/admin-repair-feed-likes').handler;
    var sameIp = nextIp();
    var attempt = function () {
      return handler(fakeEvent({ method: 'POST', ip: sameIp, body: { usernameOrEmail: OWNER_USERNAME, password: 'wrong-pw' } }));
    };
    await attempt();
    await attempt();
    var third = await attempt();
    assert.equal(third.statusCode, 429);
    assert.match(JSON.parse(third.body).error, /E6: rate_limited/);
  });
});
