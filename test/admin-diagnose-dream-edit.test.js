// test/admin-diagnose-dream-edit.test.js
//
// Covers netlify/functions/admin-diagnose-dream-edit.js: the READ-ONLY
// diagnostic built for tracker item
// for-product-escalation-founder-still-rep-7xo3cm (see that file's own
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
  delete require.cache[require.resolve('../netlify/functions/admin-diagnose-dream-edit')];
  delete require.cache[require.resolve('../netlify/functions/lib/account-store')];
  delete require.cache[require.resolve('../netlify/functions/lib/dream-store')];
  delete require.cache[require.resolve('../netlify/functions/lib/entitlements')];
});

var ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return '10.9.2.' + ipCounter;
}

async function seedAccount(event, overrides) {
  var accountStore = require('../netlify/functions/lib/account-store');
  var body = Object.assign({ username: 'ronbrightman', password: 'realfounderpw1', email: OWNER_EMAIL }, overrides || {});
  return accountStore.createAccount(event, body);
}

/**
 * Wraps @netlify/blobs' getStore so every setJSON/delete call is recorded,
 * regardless of store name -- same shape admin-diagnose-rename-
 * conflict.test.js's own spyOnBlobWrites uses, to prove this endpoint makes
 * zero writes to the dream-sync store it reads from.
 */
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

test('POST reports the caller\'s own private dreams (newest updatedAt first), including editHistory, with zero writes', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedAccount(event);

    var dreamStore = require('../netlify/functions/lib/dream-store');
    var longStory = 'x'.repeat(200);
    await dreamStore.upsertPrivateDream(event, 'ronbrightman', {
      id: 'dream-old', ownerHandle: '@ronbrightman', storyText: 'an old untouched dream',
      videoUrl: 'https://example.com/old.mp4', mediaType: 'video', updatedAt: 1000
    });
    await dreamStore.upsertPrivateDream(event, 'ronbrightman', {
      id: 'dream-edited', ownerHandle: '@ronbrightman', storyText: longStory,
      videoUrl: 'https://example.com/new.mp4', mediaType: 'video', updatedAt: 5000,
      sourceOperationName: 'fal:req-2',
      editHistory: [{ deltaLength: 12, timestamp: 4000, modelUsed: 'pixverse-v6' }]
    });

    var spy = spyOnBlobWrites();
    try {
      var handler = require('../netlify/functions/admin-diagnose-dream-edit').handler;
      var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: OWNER_EMAIL, password: 'realfounderpw1' } }));
      assert.equal(res.statusCode, 200);
      var body = JSON.parse(res.body);
      assert.equal(body.ok, true);
      assert.equal(body.username, 'ronbrightman');
      assert.equal(body.email, OWNER_EMAIL.toLowerCase());
      assert.equal(body.dreamCount, 2);

      assert.equal(body.dreams[0].id, 'dream-edited', 'the most recently updated dream must lead');
      assert.equal(body.dreams[0].storyText.length, 121, 'must truncate to 120 chars plus the ellipsis char');
      assert.ok(body.dreams[0].storyText.endsWith('…'));
      assert.equal(body.dreams[0].videoUrl, 'https://example.com/new.mp4');
      assert.equal(body.dreams[0].sourceOperationName, 'fal:req-2');
      assert.equal(body.dreams[0].updatedAt, 5000);
      assert.equal(body.dreams[0].updatedAtIso, new Date(5000).toISOString());
      assert.deepEqual(body.dreams[0].editHistory, [{ deltaLength: 12, timestamp: 4000, modelUsed: 'pixverse-v6' }]);

      assert.equal(body.dreams[1].id, 'dream-old');
      assert.equal(body.dreams[1].storyText, 'an old untouched dream', 'short text is never truncated');
      assert.deepEqual(body.dreams[1].editHistory, [], 'a dream never edited has an empty editHistory, not a missing field');
    } finally {
      spy.restore();
    }
    assert.deepEqual(spy.nonRateLimitWrites(), [], 'a diagnostic read must never write to any store');
  });
});

test('POST reports an empty dreams array for an account with no synced private dreams, not an error', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedAccount(event);

    var handler = require('../netlify/functions/admin-diagnose-dream-edit').handler;
    var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: OWNER_EMAIL, password: 'realfounderpw1' } }));
    assert.equal(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.equal(body.dreamCount, 0);
    assert.deepEqual(body.dreams, []);
  });
});

test('POST falls back to caption when storyText is absent (legacy dream shape)', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedAccount(event);
    var dreamStore = require('../netlify/functions/lib/dream-store');
    await dreamStore.upsertPrivateDream(event, 'ronbrightman', {
      id: 'dream-legacy', ownerHandle: '@ronbrightman', caption: 'legacy caption only', mediaType: 'video', updatedAt: 2000
    });

    var handler = require('../netlify/functions/admin-diagnose-dream-edit').handler;
    var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: OWNER_EMAIL, password: 'realfounderpw1' } }));
    var body = JSON.parse(res.body);
    assert.equal(body.dreams[0].storyText, 'legacy caption only');
  });
});

// ===== auth: same bar as every sibling admin diagnostic =====

test('POST rejects a real, correct password belonging to a non-owner account (403 E5)', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var accountStore = require('../netlify/functions/lib/account-store');
    var event = fakeEvent({ method: 'POST' });
    await accountStore.createAccount(event, { username: 'randomguy', password: 'randompw123', email: 'random@example.com' });

    var spy = spyOnBlobWrites();
    try {
      var handler = require('../netlify/functions/admin-diagnose-dream-edit').handler;
      var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: 'randomguy', password: 'randompw123' } }));
      assert.equal(res.statusCode, 403);
      assert.match(JSON.parse(res.body).error, /^E5: forbidden/);
    } finally {
      spy.restore();
    }
    assert.deepEqual(spy.nonRateLimitWrites(), []);
  });
});

test('POST rejects a wrong password against a real owner account (403 E5)', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedAccount(event);
    var handler = require('../netlify/functions/admin-diagnose-dream-edit').handler;
    var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: OWNER_EMAIL, password: 'totally-wrong-pw' } }));
    assert.equal(res.statusCode, 403);
    assert.match(JSON.parse(res.body).error, /^E5: forbidden/);
  });
});

test('POST is rejected with 500 when OWNER_EMAIL is not configured, before any credential check', function () {
  return withEnv({ OWNER_EMAIL: undefined }, async function () {
    var handler = require('../netlify/functions/admin-diagnose-dream-edit').handler;
    var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: 'anyone', password: 'whatever123' } }));
    assert.equal(res.statusCode, 500);
    assert.match(JSON.parse(res.body).error, /^E2: missing_owner_email/);
  });
});

// ===== rate limiting =====

test('POST exceeding MAX_ADMIN_DIAGNOSE_DREAM_EDIT_PER_IP_PER_DAY is rejected with 429 E6', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, MAX_ADMIN_DIAGNOSE_DREAM_EDIT_PER_IP_PER_DAY: '1' }, async function () {
    var handler = require('../netlify/functions/admin-diagnose-dream-edit').handler;
    var ip = nextIp();

    var first = await handler(fakeEvent({ method: 'POST', ip: ip, body: { usernameOrEmail: 'nobody', password: 'wrongpw123' } }));
    assert.equal(first.statusCode, 403);

    var second = await handler(fakeEvent({ method: 'POST', ip: ip, body: { usernameOrEmail: OWNER_EMAIL, password: 'realfounderpw1' } }));
    assert.equal(second.statusCode, 429);
    assert.match(JSON.parse(second.body).error, /^E6: rate_limited/);
  });
});

test('POST exceeding MAX_ADMIN_DIAGNOSE_DREAM_EDIT_PER_IDENTIFIER_PER_DAY throttles repeated guesses against the same account from rotating IPs', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, MAX_ADMIN_DIAGNOSE_DREAM_EDIT_PER_IDENTIFIER_PER_DAY: '2' }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedAccount(event);
    var handler = require('../netlify/functions/admin-diagnose-dream-edit').handler;

    var first = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: OWNER_EMAIL, password: 'guess-one' } }));
    assert.equal(first.statusCode, 403);
    var second = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: OWNER_EMAIL, password: 'guess-two' } }));
    assert.equal(second.statusCode, 403);

    var third = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: OWNER_EMAIL, password: 'realfounderpw1' } }));
    assert.equal(third.statusCode, 429, 'a different IP does not bypass the per-identifier cap, even with the correct password');
    assert.match(JSON.parse(third.body).error, /^E6: rate_limited/);
  });
});

// ===== request shape =====

test('POST rejects missing fields, invalid JSON, and non-POST methods', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var handler = require('../netlify/functions/admin-diagnose-dream-edit').handler;

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
