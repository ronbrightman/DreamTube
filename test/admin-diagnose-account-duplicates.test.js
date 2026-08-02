// test/admin-diagnose-account-duplicates.test.js
//
// Covers netlify/functions/admin-diagnose-account-duplicates.js: the
// READ-ONLY diagnostic built for tracker item
// for-product-urgent-email-dedup-integrity-iys5fb (see that file's own
// header comment for the full reasoning). Same test conventions as
// test/admin-diagnose-rename-conflict.test.js.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');

var OWNER_EMAIL = 'founder@dreamtube.example';

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
  delete require.cache[require.resolve('../netlify/functions/admin-diagnose-account-duplicates')];
  delete require.cache[require.resolve('../netlify/functions/lib/account-store')];
  delete require.cache[require.resolve('../netlify/functions/lib/entitlements')];
});

var ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return '10.9.3.' + ipCounter;
}

async function seedAccount(event, overrides) {
  var accountStore = require('../netlify/functions/lib/account-store');
  var body = Object.assign({ username: 'ronbrightman', password: 'realfounderpw1', email: OWNER_EMAIL }, overrides || {});
  return accountStore.createAccount(event, body);
}

/** Seeds a raw "u:<username>" record directly, bypassing createAccount's own email-uniqueness check -- same helper shape as admin-diagnose-rename-conflict.test.js's seedRawAccountRecord, used to reproduce a real pre-existing two-usernames-one-email state. */
function seedRawAccountRecord(username, email, password) {
  var accountStore = require('../netlify/functions/lib/account-store');
  var key = accountStore.normalizeUsername(username);
  var normalizedEmail = require('../netlify/functions/lib/entitlements').normalizeEmail(email);
  mockBlobs.seed(accountStore.STORE_NAME, 'u:' + key, { username: key, email: normalizedEmail, password: password, updatedAt: Date.now() });
  mockBlobs.seed(accountStore.STORE_NAME, 'e:' + normalizedEmail, key);
}

function spyOnBlobWrites() {
  var blobsModule = require('@netlify/blobs');
  var originalGetStore = blobsModule.getStore;
  var writes = [];
  blobsModule.getStore = function (opts) {
    var storeName = typeof opts === 'string' ? opts : opts.name;
    var s = originalGetStore(opts);
    var originalSetJSON = s.setJSON;
    var originalDelete = s.delete;
    s.setJSON = function (key, value) {
      writes.push({ store: storeName, key: key, op: 'setJSON' });
      return originalSetJSON(key, value);
    };
    s.delete = function (key) {
      writes.push({ store: storeName, key: key, op: 'delete' });
      return originalDelete(key);
    };
    return s;
  };
  return {
    writes: writes,
    restore: function () { blobsModule.getStore = originalGetStore; },
    nonRateLimitWrites: function () {
      return writes.filter(function (w) { return w.store !== 'dreamtube-rate-limits'; });
    }
  };
}

test('POST detects a real duplicate: two usernames sharing one email, only the index target reads as non-duplicate', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedAccount(event);
    var SHARED_EMAIL = 'shared-user@example.com';
    // Two raw accounts sharing one email -- the second write (accountB)
    // wins the "e:" index, matching real Blobs' last-write-wins shape.
    seedRawAccountRecord('accounta', SHARED_EMAIL, 'pwa');
    seedRawAccountRecord('accountb', SHARED_EMAIL, 'pwb');

    var spy = spyOnBlobWrites();
    try {
      var handler = require('../netlify/functions/admin-diagnose-account-duplicates').handler;
      var res = await handler(fakeEvent({
        method: 'POST', ip: nextIp(),
        body: { usernameOrEmail: OWNER_EMAIL, password: 'realfounderpw1', usernames: ['accounta', 'accountb'] }
      }));
      assert.equal(res.statusCode, 200);
      var body = JSON.parse(res.body);
      assert.equal(body.ok, true);
      assert.equal(body.results.length, 2);

      var a = body.results.find(function (r) { return r.requestedUsername === 'accounta'; });
      var b = body.results.find(function (r) { return r.requestedUsername === 'accountb'; });

      assert.equal(a.exists, true);
      assert.equal(a.email, SHARED_EMAIL);
      assert.equal(a.emailIndexTarget, 'accountb', 'the index currently resolves to the LAST-written account');
      assert.equal(a.likelyDuplicate, true, 'accountA exists, has this email, but the index points elsewhere -- proof of duplication');

      assert.equal(b.exists, true);
      assert.equal(b.emailIndexTarget, 'accountb');
      assert.equal(b.likelyDuplicate, false, 'accountB IS what the index resolves to -- not flagged against itself');
    } finally {
      spy.restore();
    }
    assert.deepEqual(spy.nonRateLimitWrites(), [], 'a diagnostic read must never write to any store');
  });
});

test('POST reports exists:false with no fabricated data for a username that does not exist', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedAccount(event);

    var handler = require('../netlify/functions/admin-diagnose-account-duplicates').handler;
    var res = await handler(fakeEvent({
      method: 'POST', ip: nextIp(),
      body: { usernameOrEmail: OWNER_EMAIL, password: 'realfounderpw1', usernames: ['nosuchuser'] }
    }));
    var body = JSON.parse(res.body);
    assert.equal(body.results[0].exists, false);
    assert.equal(body.results[0].email, null);
    assert.equal(body.results[0].likelyDuplicate, false);
  });
});

test('POST reports likelyDuplicate:false for a genuinely unique account (no shared email)', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedAccount(event);
    var accountStore = require('../netlify/functions/lib/account-store');
    await accountStore.createAccount(event, { username: 'soloaccount', password: 'solopw123', email: 'solo@example.com' });

    var handler = require('../netlify/functions/admin-diagnose-account-duplicates').handler;
    var res = await handler(fakeEvent({
      method: 'POST', ip: nextIp(),
      body: { usernameOrEmail: OWNER_EMAIL, password: 'realfounderpw1', usernames: ['soloaccount'] }
    }));
    var body = JSON.parse(res.body);
    assert.equal(body.results[0].exists, true);
    assert.equal(body.results[0].emailIndexTarget, 'soloaccount');
    assert.equal(body.results[0].likelyDuplicate, false);
  });
});

// ===== request shape =====

test('POST rejects a missing, non-array, empty, or oversized usernames list (400 E7)', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedAccount(event);
    var handler = require('../netlify/functions/admin-diagnose-account-duplicates').handler;

    var missing = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: OWNER_EMAIL, password: 'realfounderpw1' } }));
    assert.equal(missing.statusCode, 400);
    assert.match(JSON.parse(missing.body).error, /^E7: invalid_usernames/);

    var notArray = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: OWNER_EMAIL, password: 'realfounderpw1', usernames: 'accounta' } }));
    assert.equal(notArray.statusCode, 400);
    assert.match(JSON.parse(notArray.body).error, /^E7: invalid_usernames/);

    var empty = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: OWNER_EMAIL, password: 'realfounderpw1', usernames: [] } }));
    assert.equal(empty.statusCode, 400);
    assert.match(JSON.parse(empty.body).error, /^E7: invalid_usernames/);

    var tooMany = new Array(21).fill('x');
    var oversized = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: OWNER_EMAIL, password: 'realfounderpw1', usernames: tooMany } }));
    assert.equal(oversized.statusCode, 400);
    assert.match(JSON.parse(oversized.body).error, /^E7: invalid_usernames/);

    var blankEntry = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: OWNER_EMAIL, password: 'realfounderpw1', usernames: ['ok', '  '] } }));
    assert.equal(blankEntry.statusCode, 400);
    assert.match(JSON.parse(blankEntry.body).error, /^E7: invalid_usernames/);
  });
});

test('POST rejects missing fields, invalid JSON, and non-POST methods', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var handler = require('../netlify/functions/admin-diagnose-account-duplicates').handler;

    var missing = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: 'someone' } }));
    assert.equal(missing.statusCode, 400);
    assert.match(JSON.parse(missing.body).error, /^E4: missing_fields/);

    var badJson = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: '{not json' }));
    assert.equal(badJson.statusCode, 400);
    assert.match(JSON.parse(badJson.body).error, /^E3: invalid_json/);

    var wrongMethod = await handler(fakeEvent({ method: 'GET' }));
    assert.equal(wrongMethod.statusCode, 405);
    assert.match(JSON.parse(wrongMethod.body).error, /^E1: method_not_allowed/);
  });
});

// ===== auth =====

test('POST rejects a real, correct password belonging to a non-owner account (403 E5)', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var accountStore = require('../netlify/functions/lib/account-store');
    var event = fakeEvent({ method: 'POST' });
    await accountStore.createAccount(event, { username: 'randomguy', password: 'randompw123', email: 'random@example.com' });

    var spy = spyOnBlobWrites();
    try {
      var handler = require('../netlify/functions/admin-diagnose-account-duplicates').handler;
      var res = await handler(fakeEvent({
        method: 'POST', ip: nextIp(),
        body: { usernameOrEmail: 'randomguy', password: 'randompw123', usernames: ['accounta'] }
      }));
      assert.equal(res.statusCode, 403);
      assert.match(JSON.parse(res.body).error, /^E5: forbidden/);
    } finally {
      spy.restore();
    }
    assert.deepEqual(spy.nonRateLimitWrites(), []);
  });
});

test('POST is rejected with 500 when OWNER_EMAIL is not configured, before any credential check', function () {
  return withEnv({ OWNER_EMAIL: undefined }, async function () {
    var handler = require('../netlify/functions/admin-diagnose-account-duplicates').handler;
    var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: 'anyone', password: 'whatever123', usernames: ['a'] } }));
    assert.equal(res.statusCode, 500);
    assert.match(JSON.parse(res.body).error, /^E2: missing_owner_email/);
  });
});

// ===== rate limiting =====

test('POST exceeding MAX_ADMIN_DIAGNOSE_ACCOUNT_DUPLICATES_PER_IP_PER_DAY is rejected with 429 E6', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, MAX_ADMIN_DIAGNOSE_ACCOUNT_DUPLICATES_PER_IP_PER_DAY: '1' }, async function () {
    var handler = require('../netlify/functions/admin-diagnose-account-duplicates').handler;
    var ip = nextIp();

    var first = await handler(fakeEvent({ method: 'POST', ip: ip, body: { usernameOrEmail: 'nobody', password: 'wrongpw123', usernames: ['a'] } }));
    assert.equal(first.statusCode, 403);

    var second = await handler(fakeEvent({ method: 'POST', ip: ip, body: { usernameOrEmail: OWNER_EMAIL, password: 'realfounderpw1', usernames: ['a'] } }));
    assert.equal(second.statusCode, 429);
    assert.match(JSON.parse(second.body).error, /^E6: rate_limited/);
  });
});
