// test/admin-diagnose-rename-conflict.test.js
//
// Covers netlify/functions/admin-diagnose-rename-conflict.js: the READ-ONLY
// sibling of admin-rename-account.js's rename tool, built for tracker.html's
// for-product-rename-dry-run-refused-u-ron-rd0sm9 item (see that file's own
// header comment for the full reasoning). Same test conventions as
// test/admin-rename-account.test.js. Run with: node --test test/

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');

var OWNER_EMAIL = 'founder@dreamtube.example';
var SOURCE = '__probe_throwaway_user__';
var TARGET = 'ronbrightman';
var FEED_STORE = 'dreamtube-feed';

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
  delete require.cache[require.resolve('../netlify/functions/admin-diagnose-rename-conflict')];
  delete require.cache[require.resolve('../netlify/functions/lib/account-store')];
  delete require.cache[require.resolve('../netlify/functions/lib/entitlements')];
});

var ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return '10.9.1.' + ipCounter;
}

/** Seeds an account directly via the lib, same helper shape as admin-rename-account.test.js. */
async function seedAccount(event, overrides) {
  var accountStore = require('../netlify/functions/lib/account-store');
  var body = Object.assign({ username: SOURCE, password: 'realfounderpw1', email: OWNER_EMAIL }, overrides || {});
  return accountStore.createAccount(event, body);
}

/**
 * Seeds a raw "u:<username>" record directly into the mock store, bypassing
 * account-store.js's createAccount (and its own email-uniqueness check
 * entirely) -- needed to reproduce the exact real-world shape this
 * diagnostic exists to inspect: TWO account records sharing the SAME email,
 * something createAccount itself would refuse to create today but which can
 * genuinely exist in production from before that uniqueness check existed
 * (see account-store.js's own header comment on pre-existing, independently
 * created same-username-different-device accounts for the same class of
 * historical gap). Also writes the "e:" index to point at this username,
 * matching whatever the last real write actually left behind.
 */
function seedRawAccountRecord(username, email, password) {
  var accountStore = require('../netlify/functions/lib/account-store');
  var key = accountStore.normalizeUsername(username);
  var normalizedEmail = require('../netlify/functions/lib/entitlements').normalizeEmail(email);
  mockBlobs.seed(accountStore.STORE_NAME, 'u:' + key, { username: key, email: normalizedEmail, password: password, updatedAt: Date.now() });
  mockBlobs.seed(accountStore.STORE_NAME, 'e:' + normalizedEmail, key);
}

function seedFeed(entries) {
  mockBlobs.seed(FEED_STORE, 'feed-index', entries);
}

function seedTokens(email, tokens) {
  var entitlements = require('../netlify/functions/lib/entitlements');
  var key = entitlements.normalizeEmail(email);
  mockBlobs.seed(entitlements.STORE_NAME, key, { email: key, tokens: tokens });
}

/**
 * Wraps @netlify/blobs' getStore so every setJSON/delete call across every
 * store is recorded, regardless of which store name it targets. Used to
 * assert this endpoint's core promise -- that it makes literally zero
 * writes to the account/feed/entitlement data it diagnoses -- independent
 * of the rate-limiter's own bookkeeping writes (a deliberate, documented
 * exception -- see the function's own header comment's "RATE LIMITING"
 * section), which this spy also records but callers can filter out by
 * store name.
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
    /** Writes to stores OTHER than the rate-limiter's own bookkeeping store. */
    nonRateLimitWrites: function () {
      return writes.filter(function (w) { return w.store !== 'dreamtube-rate-limits'; });
    }
  };
}

// ===== core diagnosis: both accounts genuinely the founder's own =====

test('POST reports both accounts accurately (distinct emails/data) and makes zero writes to account/feed/entitlement data', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    // The probe account: founder's real account under the accidental
    // throwaway username, one published dream, some tokens.
    await seedAccount(event, { username: SOURCE, email: OWNER_EMAIL, password: 'realfounderpw1' });
    // The pre-existing ronbrightman account: same founder, different data --
    // exactly the scenario the tracker item hypothesizes (auto-derived from
    // the email local-part at an earlier signup). Seeded as a raw record
    // (see seedRawAccountRecord's own doc comment) since createAccount
    // itself refuses two accounts sharing one email -- this reproduces a
    // real pre-existing state, not a state this codebase's normal signup
    // flow could create today.
    seedRawAccountRecord(TARGET, OWNER_EMAIL, 'olderpw2');

    seedFeed([
      { id: 'dream-1', ownerHandle: '@' + SOURCE, caption: 'a', style: 'x', likes: 3, publishedAt: 1 },
      { id: 'dream-2', ownerHandle: '@' + TARGET, caption: 'b', style: 'y', likes: 1, publishedAt: 2 },
      { id: 'dream-3', ownerHandle: '@' + TARGET, caption: 'c', style: 'z', likes: 0, publishedAt: 3 },
      { id: 'dream-4', ownerHandle: '@someone-else', caption: 'd', style: 'w', likes: 0, publishedAt: 4 }
    ]);
    seedTokens(OWNER_EMAIL, { balance: 150, lastGrantAt: Date.now() });

    var spy = spyOnBlobWrites();
    try {
      var handler = require('../netlify/functions/admin-diagnose-rename-conflict').handler;
      // Authenticate with the TARGET account's own password -- the "e:"
      // email index currently points at TARGET (the more recent raw write,
      // matching real Blobs' last-write-wins shape), so that's the record
      // verifyLogin's email-lookup path actually resolves to and checks
      // the password against. This is itself a real, useful observation
      // the diagnostic surfaces (see emailIndex.rawTarget below) -- it's
      // exactly why account-login.js/this endpoint accept EITHER a real
      // username OR an email, so the founder can always get in with
      // whichever account's password he actually remembers.
      var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: OWNER_EMAIL, password: 'olderpw2' } }));
      assert.equal(res.statusCode, 200);
      var body = JSON.parse(res.body);
      assert.equal(body.ok, true);
      assert.equal(body.ownerEmail, OWNER_EMAIL.toLowerCase());

      assert.equal(body.accounts.probe.exists, true);
      assert.equal(body.accounts.probe.username, SOURCE);
      assert.equal(body.accounts.probe.email, OWNER_EMAIL.toLowerCase());
      assert.equal(body.accounts.probe.publishedDreamCount, 1);
      assert.deepEqual(body.accounts.probe.publishedDreamIds, ['dream-1']);
      assert.equal(body.accounts.probe.tokenBalance, 150, 'both accounts share the same email-keyed entitlement record');

      assert.equal(body.accounts.target.exists, true);
      assert.equal(body.accounts.target.username, TARGET);
      assert.equal(body.accounts.target.email, OWNER_EMAIL.toLowerCase());
      assert.equal(body.accounts.target.publishedDreamCount, 2);
      assert.deepEqual(body.accounts.target.publishedDreamIds.sort(), ['dream-2', 'dream-3']);

      assert.equal(body.emailIndex.key, 'e:' + OWNER_EMAIL.toLowerCase());
      // The index was last written by whichever createAccount call ran
      // second (TARGET) -- confirms this reads the RAW current index value.
      assert.equal(body.emailIndex.rawTarget, TARGET);
      assert.ok(body.emailIndex.resolvesToRecord);
      assert.equal(body.emailIndex.resolvesToRecord.username, TARGET);
    } finally {
      spy.restore();
    }

    // Zero writes anywhere -- not even the rate-limit bookkeeping store,
    // since this test doesn't push any limiter over its threshold, but the
    // real assertion that matters is nonRateLimitWrites being empty.
    assert.deepEqual(spy.nonRateLimitWrites(), [], 'the diagnostic must never write to account/feed/entitlement data');

    // Confirm nothing actually changed in the stores themselves too, as a
    // second, independent check beyond the write-spy.
    var accountStore = require('../netlify/functions/lib/account-store');
    var probeAfter = await accountStore.getByUsername(event, SOURCE);
    var targetAfter = await accountStore.getByUsername(event, TARGET);
    assert.ok(probeAfter && targetAfter, 'both accounts must still exist, untouched');
    assert.equal(probeAfter.username, SOURCE);
    assert.equal(targetAfter.username, TARGET);
  });
});

// ===== distinct, unrelated real accounts (the "not actually founder's" case) =====

test('POST reports different emails when u:ronbrightman genuinely belongs to someone else, still making zero writes', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedAccount(event, { username: SOURCE, email: OWNER_EMAIL, password: 'realfounderpw1' });
    var accountStore = require('../netlify/functions/lib/account-store');
    await accountStore.createAccount(event, { username: TARGET, email: 'unrelated-real-user@example.com', password: 'someoneelsepw' });
    seedTokens(OWNER_EMAIL, { balance: 40, lastGrantAt: Date.now() });
    seedTokens('unrelated-real-user@example.com', { balance: 999, lastGrantAt: Date.now() });

    var spy = spyOnBlobWrites();
    try {
      var handler = require('../netlify/functions/admin-diagnose-rename-conflict').handler;
      var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: OWNER_EMAIL, password: 'realfounderpw1' } }));
      assert.equal(res.statusCode, 200);
      var body = JSON.parse(res.body);

      assert.equal(body.accounts.probe.email, OWNER_EMAIL.toLowerCase());
      assert.equal(body.accounts.probe.tokenBalance, 40);
      assert.equal(body.accounts.target.email, 'unrelated-real-user@example.com', 'must accurately report the OTHER real user\'s own email -- this is exactly what the diagnostic exists to surface');
      assert.equal(body.accounts.target.tokenBalance, 999);
      assert.notEqual(body.accounts.probe.email, body.accounts.target.email);

      // The email index for the OWNER's own email still resolves to the
      // probe account (createAccount never touched ronbrightman's e: index
      // with the owner's email -- they're different emails).
      assert.equal(body.emailIndex.rawTarget, SOURCE);
    } finally {
      spy.restore();
    }
    assert.deepEqual(spy.nonRateLimitWrites(), []);
  });
});

// ===== missing accounts =====

test('POST reports exists:false for whichever hardcoded account is missing, with no fabricated data', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var accountStore = require('../netlify/functions/lib/account-store');
    var event = fakeEvent({ method: 'POST' });
    await accountStore.createAccount(event, { username: 'ronreal', password: 'realfounderpw1', email: OWNER_EMAIL });

    var handler = require('../netlify/functions/admin-diagnose-rename-conflict').handler;
    var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: OWNER_EMAIL, password: 'realfounderpw1' } }));
    assert.equal(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.equal(body.accounts.probe.exists, false);
    assert.equal(body.accounts.probe.username, SOURCE);
    assert.equal(body.accounts.target.exists, false);
    assert.equal(body.accounts.target.username, TARGET);
    assert.equal(body.emailIndex.rawTarget, 'ronreal');
  });
});

// ===== auth: rejects a bare email claim, wrong password, missing owner config =====

test('POST rejects a real, correct password belonging to a non-owner account (403 E5), mutating nothing', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var accountStore = require('../netlify/functions/lib/account-store');
    var event = fakeEvent({ method: 'POST' });
    await seedAccount(event);
    await accountStore.createAccount(event, { username: 'randomguy', password: 'randompw123', email: 'random@example.com' });

    var spy = spyOnBlobWrites();
    try {
      var handler = require('../netlify/functions/admin-diagnose-rename-conflict').handler;
      var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: 'randomguy', password: 'randompw123' } }));
      assert.equal(res.statusCode, 403);
      assert.match(JSON.parse(res.body).error, /^E5: forbidden/);
    } finally {
      spy.restore();
    }
    assert.deepEqual(spy.nonRateLimitWrites(), [], 'a rejected auth attempt must not write anything either');
  });
});

test('POST rejects a wrong password against a real account (403 E5) -- confirms this is NOT a bare client-trusted-email check', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedAccount(event);

    var handler = require('../netlify/functions/admin-diagnose-rename-conflict').handler;
    var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: OWNER_EMAIL, password: 'totally-wrong-pw' } }));
    assert.equal(res.statusCode, 403);
    assert.match(JSON.parse(res.body).error, /^E5: forbidden/);
  });
});

test('POST rejects an identifier claiming to be the owner\'s email with no matching account at all (403 E5) -- proves a bare email claim is never sufficient', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var handler = require('../netlify/functions/admin-diagnose-rename-conflict').handler;
    // No account exists anywhere -- verifyLogin can never succeed no matter
    // what password is supplied, since there is nothing to check it against.
    var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: OWNER_EMAIL, password: 'whatever-password' } }));
    assert.equal(res.statusCode, 403);
    assert.match(JSON.parse(res.body).error, /^E5: forbidden/);
  });
});

test('POST is rejected with 500 when OWNER_EMAIL is not configured, before any credential check', function () {
  return withEnv({ OWNER_EMAIL: undefined }, async function () {
    var handler = require('../netlify/functions/admin-diagnose-rename-conflict').handler;
    var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: 'anyone', password: 'whatever123' } }));
    assert.equal(res.statusCode, 500);
    assert.match(JSON.parse(res.body).error, /^E2: missing_owner_email/);
  });
});

// ===== rate limiting (the one accepted Blobs-write exception) =====

test('POST exceeding MAX_ADMIN_DIAGNOSE_RENAME_CONFLICT_PER_IP_PER_DAY is rejected with 429 E6', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, MAX_ADMIN_DIAGNOSE_RENAME_CONFLICT_PER_IP_PER_DAY: '1' }, async function () {
    var handler = require('../netlify/functions/admin-diagnose-rename-conflict').handler;
    var ip = nextIp();

    var first = await handler(fakeEvent({ method: 'POST', ip: ip, body: { usernameOrEmail: 'nobody', password: 'wrongpw123' } }));
    assert.equal(first.statusCode, 403);

    var second = await handler(fakeEvent({ method: 'POST', ip: ip, body: { usernameOrEmail: OWNER_EMAIL, password: 'realfounderpw1' } }));
    assert.equal(second.statusCode, 429);
    assert.match(JSON.parse(second.body).error, /^E6: rate_limited/);
  });
});

test('POST exceeding MAX_ADMIN_DIAGNOSE_RENAME_CONFLICT_PER_IDENTIFIER_PER_DAY throttles repeated guesses against the same account from rotating IPs', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, MAX_ADMIN_DIAGNOSE_RENAME_CONFLICT_PER_IDENTIFIER_PER_DAY: '2' }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedAccount(event);
    var handler = require('../netlify/functions/admin-diagnose-rename-conflict').handler;

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
    var handler = require('../netlify/functions/admin-diagnose-rename-conflict').handler;

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
