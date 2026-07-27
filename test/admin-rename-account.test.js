// test/admin-rename-account.test.js
//
// Covers netlify/functions/admin-rename-account.js: the one-off,
// hardcoded __probe_throwaway_user__ -> ronbrightman account rename (see
// that file's own extensive header comment for the full safety/resumability
// reasoning this exercises). Same test conventions as
// test/account-store.test.js / test/owner-topup-tokens.test.js. Run with:
// node --test test/

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
  delete require.cache[require.resolve('../netlify/functions/admin-rename-account')];
  delete require.cache[require.resolve('../netlify/functions/lib/account-store')];
});

var ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return '10.9.0.' + ipCounter;
}

/** Seeds the throwaway founder account directly via the lib, same shape the real incident left behind — createAccount has no E10 suspicious-username guard (that check lives only in register-account.js, added after this incident), so this reproduces the actual pre-fix state. */
async function seedSourceAccount(event, overrides) {
  var accountStore = require('../netlify/functions/lib/account-store');
  var body = Object.assign({ username: SOURCE, password: 'realfounderpw1', email: OWNER_EMAIL }, overrides || {});
  return accountStore.createAccount(event, body);
}

function seedFeed(entries) {
  mockBlobs.seed(FEED_STORE, 'feed-index', entries);
}

async function getFeed() {
  var { getStore } = require('@netlify/blobs');
  return (await getStore(FEED_STORE).get('feed-index', { type: 'json' })) || [];
}

// ===== normal successful rename =====

test('POST renames the throwaway account to ronbrightman: writes the new record, repoints the email index, and removes the old record', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedSourceAccount(event);

    var handler = require('../netlify/functions/admin-rename-account').handler;
    var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: OWNER_EMAIL, password: 'realfounderpw1' } }));
    assert.equal(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.dryRun, false);
    assert.equal(body.status, 'renamed');
    assert.equal(body.account.username, TARGET);
    assert.equal(body.account.email, OWNER_EMAIL.toLowerCase());

    var accountStore = require('../netlify/functions/lib/account-store');
    var newRecord = await accountStore.getByUsername(event, TARGET);
    assert.ok(newRecord);
    assert.equal(newRecord.username, TARGET);
    assert.equal(newRecord.email, OWNER_EMAIL.toLowerCase());
    assert.equal(newRecord.password, 'realfounderpw1', 'password must carry over unchanged');

    var oldRecord = await accountStore.getByUsername(event, SOURCE);
    assert.equal(oldRecord, null, 'the old u: record must be removed');

    // Login now resolves the NEW username, by username or by email.
    var loginByNewUsername = await accountStore.verifyLogin(event, TARGET, 'realfounderpw1');
    assert.equal(loginByNewUsername.ok, true);
    var loginByEmail = await accountStore.verifyLogin(event, OWNER_EMAIL, 'realfounderpw1');
    assert.equal(loginByEmail.ok, true);
    assert.equal(loginByEmail.record.username, TARGET);

    // The old username no longer resolves server-side at all.
    var loginByOldUsername = await accountStore.verifyLogin(event, SOURCE, 'realfounderpw1');
    assert.equal(loginByOldUsername.ok, false);
    assert.equal(loginByOldUsername.error, 'not_found');
  });
});

test('POST also migrates feed entries published under the old @__probe_throwaway_user__ handle to @ronbrightman, leaving unrelated entries untouched', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedSourceAccount(event);
    seedFeed([
      { id: 'dream-1', ownerHandle: '@' + SOURCE, caption: 'a', style: 'x', likes: 3, publishedAt: 1 },
      { id: 'dream-2', ownerHandle: '@someone-else', caption: 'b', style: 'y', likes: 1, publishedAt: 2 },
      { id: 'dream-3', ownerHandle: '@' + SOURCE, caption: 'c', style: 'z', likes: 0, publishedAt: 3 }
    ]);

    var handler = require('../netlify/functions/admin-rename-account').handler;
    var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: OWNER_EMAIL, password: 'realfounderpw1' } }));
    var body = JSON.parse(res.body);
    assert.equal(body.feed.updatedCount, 2);
    assert.deepEqual(body.feed.dreamIds.sort(), ['dream-1', 'dream-3']);

    var feed = await getFeed();
    var byId = {};
    feed.forEach(function (d) { byId[d.id] = d; });
    assert.equal(byId['dream-1'].ownerHandle, '@' + TARGET);
    assert.equal(byId['dream-3'].ownerHandle, '@' + TARGET);
    assert.equal(byId['dream-2'].ownerHandle, '@someone-else', 'an unrelated dream must never be touched');
  });
});

test('POST with no matching feed entries reports updatedCount:0 and makes no feed write', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedSourceAccount(event);
    seedFeed([{ id: 'dream-9', ownerHandle: '@nobody-related', caption: 'a', style: 'x', likes: 0, publishedAt: 1 }]);

    var handler = require('../netlify/functions/admin-rename-account').handler;
    var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: OWNER_EMAIL, password: 'realfounderpw1' } }));
    var body = JSON.parse(res.body);
    assert.equal(body.feed.updatedCount, 0);

    var feed = await getFeed();
    assert.equal(feed[0].ownerHandle, '@nobody-related');
  });
});

// ===== the critical safety check: source email must match the owner =====

test('POST refuses (E7) when the source account\'s own on-file email is NOT the owner\'s email, and mutates nothing', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    // A completely different real account happens to sit under the exact
    // throwaway username for some other reason -- must never be renamed.
    await seedSourceAccount(event, { email: 'someone-else@example.com', password: 'notfounderpw1' });

    var handler = require('../netlify/functions/admin-rename-account').handler;
    // Authenticate as the REAL owner via a separate, correctly-owned
    // account, so the auth check itself passes and this exercises the
    // rename-time safety check, not the auth check.
    await seedSourceAccount(fakeEvent({ method: 'POST' }), { username: 'ronreal', password: 'realfounderpw1', email: OWNER_EMAIL });

    var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: OWNER_EMAIL, password: 'realfounderpw1' } }));
    assert.equal(res.statusCode, 409);
    var body = JSON.parse(res.body);
    assert.equal(body.ok, false);
    assert.match(body.error, /^E7: source_email_mismatch/);

    var accountStore = require('../netlify/functions/lib/account-store');
    var stillThere = await accountStore.getByUsername(event, SOURCE);
    assert.ok(stillThere, 'the mismatched source account must be untouched');
    assert.equal(stillThere.email, 'someone-else@example.com');
    var targetMissing = await accountStore.getByUsername(event, TARGET);
    assert.equal(targetMissing, null, 'nothing should have been written under the target username');
  });
});

// ===== target already taken by an unrelated account =====

test('POST refuses (E8) when u:ronbrightman already exists under a DIFFERENT email, and mutates nothing', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedSourceAccount(event);
    var accountStore = require('../netlify/functions/lib/account-store');
    await accountStore.createAccount(event, { username: TARGET, password: 'unrelatedpw1', email: 'unrelated@example.com' });

    var handler = require('../netlify/functions/admin-rename-account').handler;
    var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: OWNER_EMAIL, password: 'realfounderpw1' } }));
    assert.equal(res.statusCode, 409);
    var body = JSON.parse(res.body);
    assert.equal(body.ok, false);
    assert.match(body.error, /^E8: target_taken/);

    var target = await accountStore.getByUsername(event, TARGET);
    assert.equal(target.email, 'unrelated@example.com', 'the unrelated existing target account must be untouched');
    var source = await accountStore.getByUsername(event, SOURCE);
    assert.ok(source, 'the source account must still be there, untouched');
  });
});

// ===== resumability: target exists with the SAME email (a prior interrupted run) =====

test('POST completes an interrupted prior run: source still present, target already exists with the SAME email -- finishes cleanly as status:"resumed" instead of refusing', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedSourceAccount(event);
    // Simulate the exact "interrupted after writing the target record, but
    // before updating the index / deleting the source" state described in
    // the file's own header comment.
    var accountStore = require('../netlify/functions/lib/account-store');
    mockBlobs.seed(accountStore.STORE_NAME, 'u:' + TARGET, {
      username: TARGET, email: OWNER_EMAIL.toLowerCase(), password: 'realfounderpw1', updatedAt: Date.now()
    });

    var handler = require('../netlify/functions/admin-rename-account').handler;
    var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: OWNER_EMAIL, password: 'realfounderpw1' } }));
    assert.equal(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.status, 'resumed');

    var source = await accountStore.getByUsername(event, SOURCE);
    assert.equal(source, null, 'the leftover source record must be cleaned up on resume');
    var byEmail = await accountStore.getByEmail(event, OWNER_EMAIL);
    assert.equal(byEmail.username, TARGET, 'the email index must now resolve to the new username');
  });
});

// ===== already done / never existed =====

test('POST reports status:"already_done" (200, ok:true) when the source is already gone and the target already exists -- not a confusing error', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    var accountStore = require('../netlify/functions/lib/account-store');
    await accountStore.createAccount(event, { username: TARGET, password: 'realfounderpw1', email: OWNER_EMAIL });

    var handler = require('../netlify/functions/admin-rename-account').handler;
    var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: OWNER_EMAIL, password: 'realfounderpw1' } }));
    assert.equal(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.status, 'already_done');
    assert.equal(body.account.username, TARGET);
  });
});

test('POST reports status:"nothing_to_do" (200, ok:true) when neither the source nor the target account exists -- auth still required', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    var accountStore = require('../netlify/functions/lib/account-store');
    // An account under a different username, just so the owner has SOME
    // real account to authenticate with -- the source/target usernames
    // themselves are untouched by this seed.
    await accountStore.createAccount(event, { username: 'ronreal', password: 'realfounderpw1', email: OWNER_EMAIL });

    var handler = require('../netlify/functions/admin-rename-account').handler;
    var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: OWNER_EMAIL, password: 'realfounderpw1' } }));
    assert.equal(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.status, 'nothing_to_do');
    assert.equal(body.account, null);
  });
});

// ===== dryRun =====

test('POST with dryRun:true reports what would happen but writes nothing at all', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedSourceAccount(event);
    seedFeed([{ id: 'dream-1', ownerHandle: '@' + SOURCE, caption: 'a', style: 'x', likes: 0, publishedAt: 1 }]);

    var handler = require('../netlify/functions/admin-rename-account').handler;
    var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: OWNER_EMAIL, password: 'realfounderpw1', dryRun: true } }));
    assert.equal(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.dryRun, true);
    assert.equal(body.status, 'renamed');
    assert.equal(body.account.username, TARGET);
    assert.equal(body.feed.updatedCount, 1, 'dryRun still reports what WOULD be updated');

    var accountStore = require('../netlify/functions/lib/account-store');
    assert.equal(await accountStore.getByUsername(event, TARGET), null, 'dryRun must not actually write the target record');
    var stillSource = await accountStore.getByUsername(event, SOURCE);
    assert.ok(stillSource, 'dryRun must not delete the source record');

    var feed = await getFeed();
    assert.equal(feed[0].ownerHandle, '@' + SOURCE, 'dryRun must not actually rewrite feed data');
  });
});

// ===== auth =====

test('POST from a non-owner (correct password, but a real account whose own email is not OWNER_EMAIL) is rejected with 403 E5, mutates nothing', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedSourceAccount(event);
    var accountStore = require('../netlify/functions/lib/account-store');
    await accountStore.createAccount(event, { username: 'randomguy', password: 'randompw123', email: 'random@example.com' });

    var handler = require('../netlify/functions/admin-rename-account').handler;
    var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: 'randomguy', password: 'randompw123' } }));
    assert.equal(res.statusCode, 403);
    assert.match(JSON.parse(res.body).error, /^E5: forbidden/);

    var stillThere = await accountStore.getByUsername(event, SOURCE);
    assert.ok(stillThere, 'nothing should be touched when auth fails');
  });
});

test('POST with a wrong password is rejected with 403 E5, mutates nothing', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedSourceAccount(event);

    var handler = require('../netlify/functions/admin-rename-account').handler;
    var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: OWNER_EMAIL, password: 'totally-wrong-pw' } }));
    assert.equal(res.statusCode, 403);
    assert.match(JSON.parse(res.body).error, /^E5: forbidden/);

    var accountStore = require('../netlify/functions/lib/account-store');
    var stillThere = await accountStore.getByUsername(event, SOURCE);
    assert.ok(stillThere);
  });
});

test('POST with no matching account at all is rejected with 403 E5', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var handler = require('../netlify/functions/admin-rename-account').handler;
    var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: 'nobody-registered', password: 'whatever123' } }));
    assert.equal(res.statusCode, 403);
    assert.match(JSON.parse(res.body).error, /^E5: forbidden/);
  });
});

test('POST is rejected with 500 when OWNER_EMAIL is not configured at all, before any credential check', function () {
  return withEnv({ OWNER_EMAIL: undefined }, async function () {
    var handler = require('../netlify/functions/admin-rename-account').handler;
    var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: 'anyone', password: 'whatever123' } }));
    assert.equal(res.statusCode, 500);
    assert.match(JSON.parse(res.body).error, /^E2: missing_owner_email/);
  });
});

// ===== rate limiting =====

test('POST exceeding MAX_ADMIN_RENAME_ACCOUNT_PER_IP_PER_DAY is rejected with 429 E6, independent of whether the credentials are even valid', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, MAX_ADMIN_RENAME_ACCOUNT_PER_IP_PER_DAY: '1' }, async function () {
    var handler = require('../netlify/functions/admin-rename-account').handler;
    var ip = nextIp();

    var first = await handler(fakeEvent({ method: 'POST', ip: ip, body: { usernameOrEmail: 'nobody', password: 'wrongpw123' } }));
    assert.equal(first.statusCode, 403); // the one allowed attempt still reaches the credential check

    var second = await handler(fakeEvent({ method: 'POST', ip: ip, body: { usernameOrEmail: OWNER_EMAIL, password: 'realfounderpw1' } }));
    assert.equal(second.statusCode, 429);
    var body = JSON.parse(second.body);
    assert.equal(body.ok, false);
    assert.match(body.error, /^E6: rate_limited/);
  });
});

test('POST exceeding MAX_ADMIN_RENAME_ACCOUNT_PER_IDENTIFIER_PER_DAY throttles repeated guesses against the SAME account even from rotating IPs', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, MAX_ADMIN_RENAME_ACCOUNT_PER_IDENTIFIER_PER_DAY: '2' }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedSourceAccount(event);
    var handler = require('../netlify/functions/admin-rename-account').handler;

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
    var handler = require('../netlify/functions/admin-rename-account').handler;

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
