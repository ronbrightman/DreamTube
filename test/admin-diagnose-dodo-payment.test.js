// test/admin-diagnose-dodo-payment.test.js
//
// Covers netlify/functions/admin-diagnose-dodo-payment.js: the READ-ONLY
// diagnostic built for tracker item
// for-product-dodo-evidence-in-founder-08--04z6ln (see that file's own
// header comment for the full reasoning). Same test conventions as
// test/admin-diagnose-account-duplicates.test.js.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');

var OWNER_EMAIL = 'founder@dreamtube.example';
var TOKEN_PURCHASES_STORE_NAME = 'dreamtube-token-purchases';

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
  delete require.cache[require.resolve('../netlify/functions/admin-diagnose-dodo-payment')];
  delete require.cache[require.resolve('../netlify/functions/lib/account-store')];
  delete require.cache[require.resolve('../netlify/functions/lib/entitlements')];
});

var ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return '10.9.4.' + ipCounter;
}

async function seedOwnerAccount(event, overrides) {
  var accountStore = require('../netlify/functions/lib/account-store');
  var body = Object.assign({ username: 'ronbrightman', password: 'realfounderpw1', email: OWNER_EMAIL }, overrides || {});
  return accountStore.createAccount(event, body);
}

function seedMarker(paymentId, marker) {
  mockBlobs.seed(TOKEN_PURCHASES_STORE_NAME, paymentId, marker);
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

// ===== the actual founder scenario =====

test('POST reports markerExists:false for a payment_id that never reached our handler', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    // No marker seeded at all -- mirrors the real founder-reported case:
    // Dodo fired payment.succeeded but our handler never processed it.

    var spy = spyOnBlobWrites();
    try {
      var handler = require('../netlify/functions/admin-diagnose-dodo-payment').handler;
      var res = await handler(fakeEvent({
        method: 'POST', ip: nextIp(),
        body: { usernameOrEmail: OWNER_EMAIL, password: 'realfounderpw1', paymentIds: ['pay_0NkXXcjgKWjX3MLhfP5xP'] }
      }));
      assert.equal(res.statusCode, 200);
      var body = JSON.parse(res.body);
      assert.equal(body.ok, true);
      assert.equal(body.results.length, 1);
      var r = body.results[0];
      assert.equal(r.paymentId, 'pay_0NkXXcjgKWjX3MLhfP5xP');
      assert.equal(r.markerExists, false);
      assert.equal(r.status, null);
      assert.equal(r.email, null);
      assert.equal(r.tokens, null);
      assert.equal(r.createdAt, null);
    } finally {
      spy.restore();
    }
    assert.deepEqual(spy.nonRateLimitWrites(), [], 'a diagnostic read must never write to any store');
  });
});

test('POST reports a pending marker exactly as stored', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    seedMarker('pay_pending123', { email: 'buyer@example.com', tokens: 500, status: 'pending', claimId: 'claim-1', createdAt: 1735689600000 });

    var handler = require('../netlify/functions/admin-diagnose-dodo-payment').handler;
    var res = await handler(fakeEvent({
      method: 'POST', ip: nextIp(),
      body: { usernameOrEmail: OWNER_EMAIL, password: 'realfounderpw1', paymentIds: ['pay_pending123'] }
    }));
    assert.equal(res.statusCode, 200);
    var r = JSON.parse(res.body).results[0];
    assert.equal(r.markerExists, true);
    assert.equal(r.status, 'pending');
    assert.equal(r.email, 'buyer@example.com');
    assert.equal(r.tokens, 500);
    assert.equal(r.createdAt, 1735689600000);
  });
});

test('POST reports a committed marker exactly as stored', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    seedMarker('pay_committed456', { email: 'buyer2@example.com', tokens: 100, status: 'committed', claimId: 'claim-2', createdAt: 1735776000000 });

    var handler = require('../netlify/functions/admin-diagnose-dodo-payment').handler;
    var res = await handler(fakeEvent({
      method: 'POST', ip: nextIp(),
      body: { usernameOrEmail: OWNER_EMAIL, password: 'realfounderpw1', paymentIds: ['pay_committed456'] }
    }));
    assert.equal(res.statusCode, 200);
    var r = JSON.parse(res.body).results[0];
    assert.equal(r.markerExists, true);
    assert.equal(r.status, 'committed');
    assert.equal(r.email, 'buyer2@example.com');
    assert.equal(r.tokens, 100);
    assert.equal(r.createdAt, 1735776000000);
  });
});

test('POST handles a mixed batch of existing and non-existing payment ids in one call', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    seedMarker('pay_known', { email: 'buyer3@example.com', tokens: 500, status: 'committed', claimId: 'claim-3', createdAt: 1735862400000 });

    var handler = require('../netlify/functions/admin-diagnose-dodo-payment').handler;
    var res = await handler(fakeEvent({
      method: 'POST', ip: nextIp(),
      body: { usernameOrEmail: OWNER_EMAIL, password: 'realfounderpw1', paymentIds: ['pay_known', 'pay_unknown'] }
    }));
    var body = JSON.parse(res.body);
    assert.equal(body.results.length, 2);
    var known = body.results.find(function (r) { return r.paymentId === 'pay_known'; });
    var unknown = body.results.find(function (r) { return r.paymentId === 'pay_unknown'; });
    assert.equal(known.markerExists, true);
    assert.equal(unknown.markerExists, false);
  });
});

// ===== request shape =====

test('POST rejects a missing, non-array, empty, or oversized paymentIds list (400 E7)', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    var handler = require('../netlify/functions/admin-diagnose-dodo-payment').handler;

    var missing = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: OWNER_EMAIL, password: 'realfounderpw1' } }));
    assert.equal(missing.statusCode, 400);
    assert.match(JSON.parse(missing.body).error, /^E7: invalid_payment_ids/);

    var notArray = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: OWNER_EMAIL, password: 'realfounderpw1', paymentIds: 'pay_x' } }));
    assert.equal(notArray.statusCode, 400);
    assert.match(JSON.parse(notArray.body).error, /^E7: invalid_payment_ids/);

    var empty = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: OWNER_EMAIL, password: 'realfounderpw1', paymentIds: [] } }));
    assert.equal(empty.statusCode, 400);
    assert.match(JSON.parse(empty.body).error, /^E7: invalid_payment_ids/);

    var tooMany = new Array(21).fill('pay_x');
    var oversized = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: OWNER_EMAIL, password: 'realfounderpw1', paymentIds: tooMany } }));
    assert.equal(oversized.statusCode, 400);
    assert.match(JSON.parse(oversized.body).error, /^E7: invalid_payment_ids/);

    var blankEntry = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: OWNER_EMAIL, password: 'realfounderpw1', paymentIds: ['pay_ok', '  '] } }));
    assert.equal(blankEntry.statusCode, 400);
    assert.match(JSON.parse(blankEntry.body).error, /^E7: invalid_payment_ids/);
  });
});

test('POST rejects missing fields, invalid JSON, and non-POST methods', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var handler = require('../netlify/functions/admin-diagnose-dodo-payment').handler;

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

test('POST rejects a wrong password for the owner account (403 E5)', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);

    var spy = spyOnBlobWrites();
    try {
      var handler = require('../netlify/functions/admin-diagnose-dodo-payment').handler;
      var res = await handler(fakeEvent({
        method: 'POST', ip: nextIp(),
        body: { usernameOrEmail: OWNER_EMAIL, password: 'totallywrongpw', paymentIds: ['pay_x'] }
      }));
      assert.equal(res.statusCode, 403);
      assert.match(JSON.parse(res.body).error, /^E5: forbidden/);
    } finally {
      spy.restore();
    }
    assert.deepEqual(spy.nonRateLimitWrites(), []);
  });
});

test('POST rejects a real, correct password belonging to a non-owner account (403 E5)', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var accountStore = require('../netlify/functions/lib/account-store');
    var event = fakeEvent({ method: 'POST' });
    await accountStore.createAccount(event, { username: 'randomguy', password: 'randompw123', email: 'random@example.com' });

    var spy = spyOnBlobWrites();
    try {
      var handler = require('../netlify/functions/admin-diagnose-dodo-payment').handler;
      var res = await handler(fakeEvent({
        method: 'POST', ip: nextIp(),
        body: { usernameOrEmail: 'randomguy', password: 'randompw123', paymentIds: ['pay_x'] }
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
    var handler = require('../netlify/functions/admin-diagnose-dodo-payment').handler;
    var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: 'anyone', password: 'whatever123', paymentIds: ['pay_x'] } }));
    assert.equal(res.statusCode, 500);
    assert.match(JSON.parse(res.body).error, /^E2: missing_owner_email/);
  });
});

// ===== rate limiting =====

test('POST exceeding MAX_ADMIN_DIAGNOSE_DODO_PAYMENT_PER_IP_PER_DAY is rejected with 429 E6', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, MAX_ADMIN_DIAGNOSE_DODO_PAYMENT_PER_IP_PER_DAY: '1' }, async function () {
    var handler = require('../netlify/functions/admin-diagnose-dodo-payment').handler;
    var ip = nextIp();

    var first = await handler(fakeEvent({ method: 'POST', ip: ip, body: { usernameOrEmail: 'nobody', password: 'wrongpw123', paymentIds: ['pay_x'] } }));
    assert.equal(first.statusCode, 403);

    var second = await handler(fakeEvent({ method: 'POST', ip: ip, body: { usernameOrEmail: OWNER_EMAIL, password: 'realfounderpw1', paymentIds: ['pay_x'] } }));
    assert.equal(second.statusCode, 429);
    assert.match(JSON.parse(second.body).error, /^E6: rate_limited/);
  });
});

test('POST exceeding MAX_ADMIN_DIAGNOSE_DODO_PAYMENT_PER_IDENTIFIER_PER_DAY is rejected with 429 E6', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, MAX_ADMIN_DIAGNOSE_DODO_PAYMENT_PER_IDENTIFIER_PER_DAY: '1' }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    var handler = require('../netlify/functions/admin-diagnose-dodo-payment').handler;

    var first = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: OWNER_EMAIL, password: 'realfounderpw1', paymentIds: ['pay_x'] } }));
    assert.equal(first.statusCode, 200);

    var second = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: OWNER_EMAIL, password: 'realfounderpw1', paymentIds: ['pay_x'] } }));
    assert.equal(second.statusCode, 429);
    assert.match(JSON.parse(second.body).error, /^E6: rate_limited/);
  });
});
