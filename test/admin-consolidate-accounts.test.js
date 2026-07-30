// test/admin-consolidate-accounts.test.js
//
// Covers netlify/functions/admin-consolidate-accounts.js: the one-off
// consolidation of the founder's two real accounts
// (u:__probe_throwaway_user__ + u:ronbrightman) into one surviving
// u:ronbrightman record on OWNER_EMAIL — see that file's own extensive
// header comment for the full safety/resumability reasoning this exercises.
// Same test conventions as test/admin-rename-account.test.js. Run with:
// node --test test/

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');

// EXPECTED_RONBRIGHTMAN_OLD_EMAIL in admin-consolidate-accounts.js is a
// hardcoded literal (deliberately -- same one-off-tool reasoning as
// admin-rename-account.js's own SOURCE_USERNAME/TARGET_USERNAME), so this
// test's OLD_DOTTED_EMAIL must match that exact literal for the "fresh run"
// path to be reached at all -- unlike OWNER_EMAIL, which the module reads
// dynamically from process.env and so can be any test value.
var OWNER_EMAIL = 'ronbrightman@example.com';
var OLD_DOTTED_EMAIL = 'ronb.rightman@gmail.com';
var PROBE = '__probe_throwaway_user__';
var RON = 'ronbrightman';
var FEED_STORE = 'dreamtube-feed';
var PROBE_PASSWORD = 'realfounderpw1';
var RON_PASSWORD = 'oldronpw1';

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
  delete require.cache[require.resolve('../netlify/functions/admin-consolidate-accounts')];
  delete require.cache[require.resolve('../netlify/functions/lib/account-store')];
  delete require.cache[require.resolve('../netlify/functions/lib/entitlements')];
});

var ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return '10.9.1.' + ipCounter;
}

async function seedProbeAccount(event, overrides) {
  var accountStore = require('../netlify/functions/lib/account-store');
  var body = Object.assign({ username: PROBE, password: PROBE_PASSWORD, email: OWNER_EMAIL }, overrides || {});
  return accountStore.createAccount(event, body);
}

async function seedRonAccount(event, overrides) {
  var accountStore = require('../netlify/functions/lib/account-store');
  var body = Object.assign({ username: RON, password: RON_PASSWORD, email: OLD_DOTTED_EMAIL }, overrides || {});
  return accountStore.createAccount(event, body);
}

function seedFeed(entries) {
  mockBlobs.seed(FEED_STORE, 'feed-index', entries);
}

async function getFeed() {
  var { getStore } = require('@netlify/blobs');
  return (await getStore(FEED_STORE).get('feed-index', { type: 'json' })) || [];
}

async function seedEntitlement(email, tokens) {
  var entitlements = require('../netlify/functions/lib/entitlements');
  var event = fakeEvent({ method: 'POST' });
  return entitlements.setEntitlement(event, email, { tokens: tokens });
}

async function getEntitlement(email) {
  var entitlements = require('../netlify/functions/lib/entitlements');
  var event = fakeEvent({ method: 'POST' });
  return entitlements.getEntitlement(event, email);
}

function defaultDiagnosedFeed() {
  return [
    { id: 'dqocagbs', ownerHandle: '@' + PROBE, caption: 'probe dream 1', style: 'a', likes: 0, publishedAt: 1 },
    { id: 'dm6bujus', ownerHandle: '@' + PROBE, caption: 'probe dream 2', style: 'b', likes: 0, publishedAt: 2 },
    { id: 'ron-1', ownerHandle: '@' + RON, caption: 'ron dream 1', style: 'c', likes: 0, publishedAt: 3 },
    { id: 'ron-2', ownerHandle: '@' + RON, caption: 'ron dream 2', style: 'd', likes: 0, publishedAt: 4 },
    { id: 'ron-3', ownerHandle: '@' + RON, caption: 'ron dream 3', style: 'e', likes: 0, publishedAt: 5 },
    { id: 'ron-4', ownerHandle: '@' + RON, caption: 'ron dream 4', style: 'f', likes: 0, publishedAt: 6 },
    { id: 'ron-5', ownerHandle: '@' + RON, caption: 'ron dream 5', style: 'g', likes: 0, publishedAt: 7 },
    { id: 'unrelated', ownerHandle: '@someone-else', caption: 'not the founder', style: 'z', likes: 0, publishedAt: 8 }
  ];
}

/** Seeds the exact diagnosed real-data snapshot from the tracker item (scaled to this test's own OWNER_EMAIL/OLD_DOTTED_EMAIL constants): probe = 1860 tokens + 2 published dreams, ronbrightman = 200 tokens + 5 published dreams. */
async function seedDiagnosedSnapshot(event) {
  await seedProbeAccount(event);
  await seedRonAccount(event);
  await seedEntitlement(OWNER_EMAIL, { balance: 1860 });
  await seedEntitlement(OLD_DOTTED_EMAIL, { balance: 200 });
  seedFeed(defaultDiagnosedFeed());
}

function call(body) {
  var handler = require('../netlify/functions/admin-consolidate-accounts').handler;
  return handler(fakeEvent({ method: 'POST', ip: nextIp(), body: body }));
}

// ===== happy path: exactly matches the diagnosed real data =====

test('POST consolidates the two real accounts: rewrites u:ronbrightman (email/password), repoints the OWNER_EMAIL index, tombstones the old email index, deletes the probe record', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedDiagnosedSnapshot(event);

    var res = await call({ usernameOrEmail: OWNER_EMAIL, password: PROBE_PASSWORD });
    assert.equal(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.dryRun, false);
    assert.equal(body.status, 'consolidated');
    assert.equal(body.account.username, RON);
    assert.equal(body.account.email, OWNER_EMAIL);

    var accountStore = require('../netlify/functions/lib/account-store');
    var finalRecord = await accountStore.getByUsername(event, RON);
    assert.ok(finalRecord);
    assert.equal(finalRecord.email, OWNER_EMAIL);
    assert.equal(finalRecord.password, PROBE_PASSWORD, "must carry the PROBE's password, not ronbrightman's old one");

    var probeGone = await accountStore.getByUsername(event, PROBE);
    assert.equal(probeGone, null, 'the probe record must be deleted');

    // Login now resolves the consolidated account by OWNER_EMAIL, by the
    // new password, with the new username.
    var loginByEmail = await accountStore.verifyLogin(event, OWNER_EMAIL, PROBE_PASSWORD);
    assert.equal(loginByEmail.ok, true);
    assert.equal(loginByEmail.record.username, RON);

    // The old dotted email no longer resolves to anything.
    var loginByOldEmail = await accountStore.verifyLogin(event, OLD_DOTTED_EMAIL, RON_PASSWORD);
    assert.equal(loginByOldEmail.ok, false);
    assert.equal(loginByOldEmail.error, 'not_found');

    // The old ronbrightman password no longer works at all (even against
    // the new OWNER_EMAIL identity).
    var loginWithOldPassword = await accountStore.verifyLogin(event, OWNER_EMAIL, RON_PASSWORD);
    assert.equal(loginWithOldPassword.ok, false);
  });
});

test('POST sums both token balances onto OWNER_EMAIL and drains the old dotted email to exactly 0', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedDiagnosedSnapshot(event);

    var res = await call({ usernameOrEmail: OWNER_EMAIL, password: PROBE_PASSWORD });
    var body = JSON.parse(res.body);
    assert.equal(body.tokens.ownerEmailBalanceBefore, 1860);
    assert.equal(body.tokens.oldEmailBalanceBefore, 200);
    assert.equal(body.tokens.newOwnerEmailBalance, 2060);
    assert.equal(body.tokens.oldEmailDrainedToZero, true);

    var ownerEnt = await getEntitlement(OWNER_EMAIL);
    assert.equal(ownerEnt.tokens.balance, 2060);
    var oldEnt = await getEntitlement(OLD_DOTTED_EMAIL);
    assert.equal(oldEnt.tokens.balance, 0, 'the drained record must be zeroed, not left with a residual balance');
  });
});

test('POST retags the probe published dreams onto @ronbrightman, leaves already-correct and unrelated entries untouched', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedDiagnosedSnapshot(event);

    var res = await call({ usernameOrEmail: OWNER_EMAIL, password: PROBE_PASSWORD });
    var body = JSON.parse(res.body);
    assert.equal(body.feed.updatedCount, 2);
    assert.deepEqual(body.feed.dreamIds.sort(), ['dm6bujus', 'dqocagbs']);

    var feed = await getFeed();
    var byId = {};
    feed.forEach(function (d) { byId[d.id] = d; });
    assert.equal(byId['dqocagbs'].ownerHandle, '@' + RON);
    assert.equal(byId['dm6bujus'].ownerHandle, '@' + RON);
    // Already-correctly-tagged ronbrightman dreams stay exactly as they were.
    ['ron-1', 'ron-2', 'ron-3', 'ron-4', 'ron-5'].forEach(function (id) {
      assert.equal(byId[id].ownerHandle, '@' + RON);
    });
    assert.equal(byId['unrelated'].ownerHandle, '@someone-else', 'an unrelated dream must never be touched');

    // All 7 real dreams survive under the one final handle.
    var ronCount = feed.filter(function (d) { return d.ownerHandle === '@' + RON; }).length;
    assert.equal(ronCount, 7);
  });
});

// ===== dryRun =====

test('POST with dryRun:true reports what would happen but writes absolutely nothing', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedDiagnosedSnapshot(event);

    var res = await call({ usernameOrEmail: OWNER_EMAIL, password: PROBE_PASSWORD, dryRun: true });
    assert.equal(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.dryRun, true);
    assert.equal(body.status, 'consolidated');
    assert.equal(body.account.email, OWNER_EMAIL);
    assert.equal(body.tokens.newOwnerEmailBalance, 2060);
    assert.equal(body.feed.updatedCount, 2);

    var accountStore = require('../netlify/functions/lib/account-store');
    var ronStillOld = await accountStore.getByUsername(event, RON);
    assert.equal(ronStillOld.email, OLD_DOTTED_EMAIL, 'dryRun must not actually rewrite the ronbrightman record');
    assert.equal(ronStillOld.password, RON_PASSWORD);
    var probeStill = await accountStore.getByUsername(event, PROBE);
    assert.ok(probeStill, 'dryRun must not delete the probe record');

    var ownerEnt = await getEntitlement(OWNER_EMAIL);
    assert.equal(ownerEnt.tokens.balance, 1860, 'dryRun must not actually credit tokens');
    var oldEnt = await getEntitlement(OLD_DOTTED_EMAIL);
    assert.equal(oldEnt.tokens.balance, 200, 'dryRun must not actually drain tokens');

    var feed = await getFeed();
    var probeDream = feed.filter(function (d) { return d.id === 'dqocagbs'; })[0];
    assert.equal(probeDream.ownerHandle, '@' + PROBE, 'dryRun must not actually rewrite feed data');

    var loginStillOld = await accountStore.verifyLogin(event, OLD_DOTTED_EMAIL, RON_PASSWORD);
    assert.equal(loginStillOld.ok, true, 'dryRun must not affect real login behavior at all');
  });
});

// ===== the critical, non-skippable safety checks =====

test('POST refuses (E7) when the probe account\'s own on-file email is NOT OWNER_EMAIL, and mutates nothing', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedProbeAccount(event, { email: 'someone-else@example.com', password: 'notfounderpw1' });
    await seedRonAccount(event);
    // A real owner account so the auth check itself passes.
    await seedProbeAccount(fakeEvent({ method: 'POST' }), { username: 'ronreal', password: PROBE_PASSWORD, email: OWNER_EMAIL });

    var res = await call({ usernameOrEmail: OWNER_EMAIL, password: PROBE_PASSWORD });
    assert.equal(res.statusCode, 409);
    var body = JSON.parse(res.body);
    assert.equal(body.ok, false);
    assert.match(body.error, /^E7: source_email_mismatch/);

    var accountStore = require('../netlify/functions/lib/account-store');
    var probeStillThere = await accountStore.getByUsername(event, PROBE);
    assert.ok(probeStillThere);
    assert.equal(probeStillThere.email, 'someone-else@example.com');
    var ronUntouched = await accountStore.getByUsername(event, RON);
    assert.equal(ronUntouched.email, OLD_DOTTED_EMAIL, 'must never be touched when the probe check fails');
  });
});

test('POST refuses (E8) when u:ronbrightman does not exist at all -- this tool only resolves an existing conflict, it is not a rename tool', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedProbeAccount(event);

    var res = await call({ usernameOrEmail: OWNER_EMAIL, password: PROBE_PASSWORD });
    assert.equal(res.statusCode, 409);
    var body = JSON.parse(res.body);
    assert.equal(body.ok, false);
    assert.match(body.error, /^E8: ronbrightman_missing/);

    var accountStore = require('../netlify/functions/lib/account-store');
    var probeStillThere = await accountStore.getByUsername(event, PROBE);
    assert.ok(probeStillThere, 'must never touch the probe account when there is nothing to consolidate into');
  });
});

test('POST refuses (E9) when u:ronbrightman exists under a THIRD, unrelated email -- never overwrites a stranger\'s account', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedProbeAccount(event);
    await seedRonAccount(event, { email: 'totally-unrelated@example.com' });

    var res = await call({ usernameOrEmail: OWNER_EMAIL, password: PROBE_PASSWORD });
    assert.equal(res.statusCode, 409);
    var body = JSON.parse(res.body);
    assert.equal(body.ok, false);
    assert.match(body.error, /^E9: ronbrightman_email_mismatch/);
    assert.equal(body.details.actual, 'totally-unrelated@example.com');

    var accountStore = require('../netlify/functions/lib/account-store');
    var ronUntouched = await accountStore.getByUsername(event, RON);
    assert.equal(ronUntouched.email, 'totally-unrelated@example.com', 'must never be touched');
    var probeUntouched = await accountStore.getByUsername(event, PROBE);
    assert.ok(probeUntouched, 'must never be touched either');
  });
});

test('POST refuses (E11 ambiguous_partial_state) when the probe is already gone but ronbrightman\'s email is neither OWNER_EMAIL nor the expected dotted variant', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    // Simulate an anomalous state: no probe record at all, and
    // u:ronbrightman sits on some third email neither expected value.
    await seedRonAccount(event, { email: 'anomalous@example.com', password: 'anomalouspw1' });

    var res = await call({ usernameOrEmail: 'anomalous@example.com', password: 'anomalouspw1' });
    // Auth fails here since that account's email isn't OWNER_EMAIL -- seed
    // a real owner-email account too, distinct from ronbrightman, purely
    // so the credential check can succeed and this test actually exercises
    // the E11 branch rather than E5.
    var ownerAccount = fakeEvent({ method: 'POST' });
    await seedProbeAccount(ownerAccount, { username: 'ownerreal', password: PROBE_PASSWORD, email: OWNER_EMAIL });

    var res2 = await call({ usernameOrEmail: OWNER_EMAIL, password: PROBE_PASSWORD });
    assert.equal(res2.statusCode, 409);
    var body = JSON.parse(res2.body);
    assert.equal(body.ok, false);
    assert.match(body.error, /^E11: ambiguous_partial_state/);
  });
});

test('POST reports status:"nothing_to_do" (200, ok:true) when neither account exists -- auth still required', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    var accountStore = require('../netlify/functions/lib/account-store');
    await accountStore.createAccount(event, { username: 'ownerreal', password: PROBE_PASSWORD, email: OWNER_EMAIL });

    var res = await call({ usernameOrEmail: OWNER_EMAIL, password: PROBE_PASSWORD });
    assert.equal(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.status, 'nothing_to_do');
    assert.equal(body.account, null);
  });
});

// ===== snapshot sanity checks (skippable, unlike the identity checks above) =====

test('POST refuses (E10 snapshot_mismatch) when the probe token balance does not match the diagnosed snapshot, and lists the mismatch', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedDiagnosedSnapshot(event);
    await seedEntitlement(OWNER_EMAIL, { balance: 999 }); // drifted from the diagnosed 1860

    var res = await call({ usernameOrEmail: OWNER_EMAIL, password: PROBE_PASSWORD });
    assert.equal(res.statusCode, 409);
    var body = JSON.parse(res.body);
    assert.equal(body.ok, false);
    assert.match(body.error, /^E10: snapshot_mismatch/);
    var probeMismatch = body.details.filter(function (d) { return d.field === 'probeTokenBalance'; })[0];
    assert.ok(probeMismatch);
    assert.equal(probeMismatch.expected, 1860);
    assert.equal(probeMismatch.actual, 999);

    var accountStore = require('../netlify/functions/lib/account-store');
    assert.ok(await accountStore.getByUsername(event, PROBE), 'must not mutate anything on a snapshot mismatch');
  });
});

test('POST refuses (E10) when the ronbrightman published-dream count does not match the diagnosed snapshot', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedProbeAccount(event);
    await seedRonAccount(event);
    await seedEntitlement(OWNER_EMAIL, { balance: 1860 });
    await seedEntitlement(OLD_DOTTED_EMAIL, { balance: 200 });
    // Only 3 ronbrightman dreams instead of the diagnosed 5.
    seedFeed([
      { id: 'dqocagbs', ownerHandle: '@' + PROBE, caption: 'a', style: 'x', likes: 0, publishedAt: 1 },
      { id: 'dm6bujus', ownerHandle: '@' + PROBE, caption: 'b', style: 'x', likes: 0, publishedAt: 2 },
      { id: 'ron-1', ownerHandle: '@' + RON, caption: 'c', style: 'x', likes: 0, publishedAt: 3 },
      { id: 'ron-2', ownerHandle: '@' + RON, caption: 'd', style: 'x', likes: 0, publishedAt: 4 },
      { id: 'ron-3', ownerHandle: '@' + RON, caption: 'e', style: 'x', likes: 0, publishedAt: 5 }
    ]);

    var res = await call({ usernameOrEmail: OWNER_EMAIL, password: PROBE_PASSWORD });
    assert.equal(res.statusCode, 409);
    var body = JSON.parse(res.body);
    assert.match(body.error, /^E10: snapshot_mismatch/);
    var mismatch = body.details.filter(function (d) { return d.field === 'ronbrightmanDreamCount'; })[0];
    assert.ok(mismatch);
    assert.equal(mismatch.expected, 5);
    assert.equal(mismatch.actual, 3);
  });
});

test('POST with skipSnapshotSanityChecks:true proceeds despite a token/dream-count mismatch -- but NEVER bypasses the email-identity checks', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedDiagnosedSnapshot(event);
    await seedEntitlement(OWNER_EMAIL, { balance: 5000 }); // drifted, e.g. a purchase since diagnosis

    var res = await call({ usernameOrEmail: OWNER_EMAIL, password: PROBE_PASSWORD, skipSnapshotSanityChecks: true });
    assert.equal(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.status, 'consolidated');
    assert.equal(body.tokens.newOwnerEmailBalance, 5200, 'sums whatever the CURRENT drifted balance actually is, not the stale diagnosed number');
  });
});

test('POST with skipSnapshotSanityChecks:true still refuses E7/E8/E9 -- those are never skippable', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedProbeAccount(event, { email: 'someone-else@example.com', password: 'notfounderpw1' });
    await seedRonAccount(event);
    await seedProbeAccount(fakeEvent({ method: 'POST' }), { username: 'ronreal', password: PROBE_PASSWORD, email: OWNER_EMAIL });

    var res = await call({ usernameOrEmail: OWNER_EMAIL, password: PROBE_PASSWORD, skipSnapshotSanityChecks: true });
    assert.equal(res.statusCode, 409);
    assert.match(JSON.parse(res.body).error, /^E7: source_email_mismatch/);
  });
});

// ===== resumability =====

test('POST completes an interrupted prior run: probe still present, u:ronbrightman already updated to OWNER_EMAIL -- finishes cleanly as status:"resumed"', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedProbeAccount(event);
    // Simulate the exact "interrupted right after writing the target
    // record" state described in the header comment: ronbrightman's own
    // record already carries OWNER_EMAIL + the probe's password, but the
    // OWNER_EMAIL index/dotted-index/feed/entitlements/probe-deletion steps
    // never ran.
    var accountStore = require('../netlify/functions/lib/account-store');
    mockBlobs.seed(accountStore.STORE_NAME, 'u:' + RON, {
      username: RON, email: OWNER_EMAIL, password: PROBE_PASSWORD, updatedAt: Date.now(),
      consolidatedFrom: PROBE, consolidatedAt: Date.now(), previousEmail: OLD_DOTTED_EMAIL
    });
    await seedEntitlement(OWNER_EMAIL, { balance: 1860 });
    await seedEntitlement(OLD_DOTTED_EMAIL, { balance: 200 });
    seedFeed(defaultDiagnosedFeed());

    var res = await call({ usernameOrEmail: OWNER_EMAIL, password: PROBE_PASSWORD });
    assert.equal(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.status, 'resumed');
    assert.equal(body.tokens.newOwnerEmailBalance, 2060);
    assert.equal(body.feed.updatedCount, 2);

    var probeGone = await accountStore.getByUsername(event, PROBE);
    assert.equal(probeGone, null, 'the leftover probe record must be cleaned up on resume');
    var byEmail = await accountStore.getByEmail(event, OWNER_EMAIL);
    assert.equal(byEmail.username, RON, 'the email index must now resolve to ronbrightman');
    var ownerEnt = await getEntitlement(OWNER_EMAIL);
    assert.equal(ownerEnt.tokens.balance, 2060);
  });
});

// ===== already_done / idempotency =====

test('POST reports status:"already_done" on a second call, and does NOT double-drain tokens', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedDiagnosedSnapshot(event);

    var first = await call({ usernameOrEmail: OWNER_EMAIL, password: PROBE_PASSWORD });
    assert.equal(JSON.parse(first.body).status, 'consolidated');

    var second = await call({ usernameOrEmail: OWNER_EMAIL, password: PROBE_PASSWORD });
    assert.equal(second.statusCode, 200);
    var body = JSON.parse(second.body);
    assert.equal(body.ok, true);
    assert.equal(body.status, 'already_done');
    assert.equal(body.account.username, RON);
    assert.equal(body.account.email, OWNER_EMAIL);
    assert.equal(body.tokens.newOwnerEmailBalance, 2060, 'a second run must never double-credit the drained balance');

    var ownerEnt = await getEntitlement(OWNER_EMAIL);
    assert.equal(ownerEnt.tokens.balance, 2060, 'balance in storage must still be exactly 2060, not 2260');

    var feed = await getFeed();
    var ronCount = feed.filter(function (d) { return d.ownerHandle === '@' + RON; }).length;
    assert.equal(ronCount, 7, 'feed must not be corrupted by a second, redundant migration pass');
  });
});

test('POST reports status:"already_done" when the accounts were already consolidated by some other means entirely (no probe account, ronbrightman already on OWNER_EMAIL)', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    var accountStore = require('../netlify/functions/lib/account-store');
    await accountStore.createAccount(event, { username: RON, password: PROBE_PASSWORD, email: OWNER_EMAIL });

    var res = await call({ usernameOrEmail: OWNER_EMAIL, password: PROBE_PASSWORD });
    assert.equal(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.status, 'already_done');
    assert.equal(body.account.username, RON);
  });
});

// ===== auth =====

test('POST from a non-owner (correct password, but a real account whose own email is not OWNER_EMAIL) is rejected with 403 E5, mutates nothing', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedDiagnosedSnapshot(event);
    var accountStore = require('../netlify/functions/lib/account-store');
    await accountStore.createAccount(event, { username: 'randomguy', password: 'randompw123', email: 'random@example.com' });

    var res = await call({ usernameOrEmail: 'randomguy', password: 'randompw123' });
    assert.equal(res.statusCode, 403);
    assert.match(JSON.parse(res.body).error, /^E5: forbidden/);

    var probeStillThere = await accountStore.getByUsername(event, PROBE);
    assert.ok(probeStillThere, 'nothing should be touched when auth fails');
  });
});

test('POST with a wrong password is rejected with 403 E5, mutates nothing', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedDiagnosedSnapshot(event);

    var res = await call({ usernameOrEmail: OWNER_EMAIL, password: 'totally-wrong-pw' });
    assert.equal(res.statusCode, 403);
    assert.match(JSON.parse(res.body).error, /^E5: forbidden/);
  });
});

test('POST is rejected with 500 when OWNER_EMAIL is not configured at all, before any credential check', function () {
  return withEnv({ OWNER_EMAIL: undefined }, async function () {
    var res = await call({ usernameOrEmail: 'anyone', password: 'whatever123' });
    assert.equal(res.statusCode, 500);
    assert.match(JSON.parse(res.body).error, /^E2: missing_owner_email/);
  });
});

// ===== rate limiting =====

test('POST exceeding MAX_ADMIN_CONSOLIDATE_ACCOUNTS_PER_IP_PER_DAY is rejected with 429 E6', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, MAX_ADMIN_CONSOLIDATE_ACCOUNTS_PER_IP_PER_DAY: '1' }, async function () {
    var handler = require('../netlify/functions/admin-consolidate-accounts').handler;
    var ip = nextIp();

    var first = await handler(fakeEvent({ method: 'POST', ip: ip, body: { usernameOrEmail: 'nobody', password: 'wrongpw123' } }));
    assert.equal(first.statusCode, 403);

    var second = await handler(fakeEvent({ method: 'POST', ip: ip, body: { usernameOrEmail: OWNER_EMAIL, password: PROBE_PASSWORD } }));
    assert.equal(second.statusCode, 429);
    assert.match(JSON.parse(second.body).error, /^E6: rate_limited/);
  });
});

test('POST exceeding MAX_ADMIN_CONSOLIDATE_ACCOUNTS_PER_IDENTIFIER_PER_DAY throttles repeated guesses against the same account even from rotating IPs', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, MAX_ADMIN_CONSOLIDATE_ACCOUNTS_PER_IDENTIFIER_PER_DAY: '2' }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedProbeAccount(event);

    var first = await call({ usernameOrEmail: OWNER_EMAIL, password: 'guess-one' });
    assert.equal(first.statusCode, 403);
    var second = await call({ usernameOrEmail: OWNER_EMAIL, password: 'guess-two' });
    assert.equal(second.statusCode, 403);

    var third = await call({ usernameOrEmail: OWNER_EMAIL, password: PROBE_PASSWORD });
    assert.equal(third.statusCode, 429, 'a different IP does not bypass the per-identifier cap, even with the correct password');
  });
});

// ===== request shape =====

test('POST rejects missing fields, invalid JSON, and non-POST methods', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var handler = require('../netlify/functions/admin-consolidate-accounts').handler;

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
