// test/admin-reset-account-markers.test.js
//
// Covers netlify/functions/admin-reset-account-markers.js: the owner-only
// "genuine fresh start" testing tool (founder-authorized 2026-08-08). Proves
// (1) the owner-password gate (403 without/with a wrong password, and for a
// valid-but-non-owner login), (2) that it clears exactly the named once-ever
// markers a re-signup needs cleared (the token-init-grant marker, the
// install/verify-email achievement markers, and the entitlement record), (3)
// that a re-signup after a reset genuinely re-grants the 170 base + re-earns
// the bonuses, and (4) — critically — that a NORMAL entitlement deletion
// (delete-account.js's own teardown) still LEAVES the token-init-grant
// marker behind, which is what stops a real user from delete-then-re-signup
// farming the base grant. Same mock-blobs + owner-account conventions as
// test/admin-diagnose-account-duplicates.test.js.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var { getStore, connectLambda } = require('@netlify/blobs');

var entitlements = require('../netlify/functions/lib/entitlements');
var rateLimit = require('../netlify/functions/lib/rate-limit');

var OWNER_EMAIL = 'founder@dreamtube.example';
var OWNER_PASSWORD = 'realfounderpw1';
var INSTALL_ID = 'home_install_verified';
var VERIFY_ID = 'email_verified_bonus';

function withEnv(vars, fn) {
  var previous = {};
  Object.keys(vars).forEach(function (k) { previous[k] = process.env[k]; });
  Object.keys(vars).forEach(function (k) {
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  });
  return Promise.resolve().then(fn).finally(function () {
    Object.keys(previous).forEach(function (k) {
      if (previous[k] === undefined) delete process.env[k];
      else process.env[k] = previous[k];
    });
  });
}

var ipCounter = 0;
function nextIp() { ipCounter += 1; return '10.9.7.' + ipCounter; }

test.beforeEach(function () { mockBlobs.reset(); });

async function seedOwner(event) {
  var accountStore = require('../netlify/functions/lib/account-store');
  return accountStore.createAccount(event, { username: 'ronbrightman', password: OWNER_PASSWORD, email: OWNER_EMAIL });
}

/** Materializes a full set of once-ever markers for `email`: the 170-token base grant (writes the token-init-grant marker + record), plus the install and verify-email achievement grants (each writes its outer marker + bumps balance). */
async function seedFullAccountState(event, email) {
  await entitlements.getTokenStatus(event, email); // -> 170, writes token-init-grant marker
  await entitlements.applyAchievementGrant(event, email, INSTALL_ID, { type: 'tokens', amount: 20 });
  await entitlements.applyAchievementGrant(event, email, VERIFY_ID, { type: 'tokens', amount: 20 });
}

async function readInitMarker(event, email) {
  return rateLimit.readMarker(event, 'token-init-grant:' + entitlements.normalizeEmail(email));
}

async function readAchievementMarker(event, email, achievementId) {
  connectLambda(event);
  var m = await getStore({ name: entitlements.ACHIEVEMENT_GRANTS_STORE_NAME })
    .get(entitlements.achievementGrantMarkerKey(email, achievementId), { type: 'json' });
  return m || null; // normalize a missing key's undefined to null for strict asserts
}

function handler() {
  return require('../netlify/functions/admin-reset-account-markers').handler;
}

// ---------- Owner-password gate ----------

test('a wrong password for the owner login is rejected 403, and clears nothing', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var ev = fakeEvent({ method: 'POST' });
    await seedOwner(ev);
    var target = 'testacct@example.com';
    await seedFullAccountState(ev, target);

    var res = await handler()(fakeEvent({
      method: 'POST', ip: nextIp(),
      body: { usernameOrEmail: OWNER_EMAIL, password: 'wrong-password', targetEmail: target }
    }));
    assert.equal(res.statusCode, 403);
    assert.equal(JSON.parse(res.body).error, 'E5: forbidden');

    // Nothing was cleared.
    assert.ok(await readInitMarker(ev, target), 'the token-init-grant marker must survive a rejected reset');
    assert.ok(await entitlements.getEntitlement(ev, target), 'the entitlement record must survive a rejected reset');
  });
});

test('a valid login that is NOT the owner is rejected 403', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var ev = fakeEvent({ method: 'POST' });
    await seedOwner(ev);
    var accountStore = require('../netlify/functions/lib/account-store');
    await accountStore.createAccount(ev, { username: 'someuser', password: 'userpw12345', email: 'someuser@example.com' });

    var res = await handler()(fakeEvent({
      method: 'POST', ip: nextIp(),
      body: { usernameOrEmail: 'someuser', password: 'userpw12345', targetEmail: 'anyone@example.com' }
    }));
    assert.equal(res.statusCode, 403, 'a real, correct login that is not the owner account must still be forbidden');
  });
});

test('a missing targetEmail (or password) is a 400 missing_fields, not a silent no-op', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var ev = fakeEvent({ method: 'POST' });
    await seedOwner(ev);
    var res = await handler()(fakeEvent({
      method: 'POST', ip: nextIp(),
      body: { usernameOrEmail: OWNER_EMAIL, password: OWNER_PASSWORD }
    }));
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error, 'E4: missing_fields');
  });
});

// ---------- Clears exactly the named markers ----------

test('a valid owner reset clears the token-init-grant marker, both named achievement markers, and the entitlement record', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var ev = fakeEvent({ method: 'POST' });
    await seedOwner(ev);
    var target = 'testacct@example.com';
    await seedFullAccountState(ev, target);

    // Sanity: everything the reset should clear genuinely exists first.
    assert.ok(await readInitMarker(ev, target), 'precondition: token-init-grant marker exists');
    assert.ok(await readAchievementMarker(ev, target, INSTALL_ID), 'precondition: install achievement marker exists');
    assert.ok(await readAchievementMarker(ev, target, VERIFY_ID), 'precondition: verify-email achievement marker exists');
    assert.ok(await entitlements.getEntitlement(ev, target), 'precondition: entitlement record exists');

    var res = await handler()(fakeEvent({
      method: 'POST', ip: nextIp(),
      body: { usernameOrEmail: OWNER_EMAIL, password: OWNER_PASSWORD, targetEmail: target }
    }));
    assert.equal(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.targetEmail, target);

    assert.equal(await readInitMarker(ev, target), null, 'the token-init-grant marker must be cleared');
    assert.equal(await readAchievementMarker(ev, target, INSTALL_ID), null, 'the install achievement marker must be cleared');
    assert.equal(await readAchievementMarker(ev, target, VERIFY_ID), null, 'the verify-email achievement marker must be cleared');
    assert.equal(await entitlements.getEntitlement(ev, target), null, 'the entitlement record must be cleared');
  });
});

// ---------- Re-signup after a reset genuinely re-grants ----------

test('after a reset, a re-signup genuinely re-grants the 170 base and re-earns the install bonus', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var ev = fakeEvent({ method: 'POST' });
    await seedOwner(ev);
    var target = 'testacct@example.com';
    await seedFullAccountState(ev, target);

    await handler()(fakeEvent({
      method: 'POST', ip: nextIp(),
      body: { usernameOrEmail: OWNER_EMAIL, password: OWNER_PASSWORD, targetEmail: target }
    }));

    // Re-signup: a fresh first-ever read re-materializes the base grant.
    var status = await entitlements.getTokenStatus(fakeEvent({ ip: nextIp() }), target);
    assert.equal(status.balance, 170, 'a fresh read after the reset re-grants the full 170 base, not an echoed/stale value');

    // And the install bonus is claimable again (its outer marker AND the
    // record's inner achievements ledger were both cleared).
    var regrant = await entitlements.applyAchievementGrant(fakeEvent({ ip: nextIp() }), target, INSTALL_ID, { type: 'tokens', amount: 20 });
    assert.equal(regrant.granted, true, 'the install bonus must be re-earnable after a reset');
    assert.equal(regrant.balance, 190, '170 re-granted base + 20 re-earned install bonus');
  });
});

// ---------- The anti-farm invariant: a NORMAL deletion leaves the marker ----------

test('a NORMAL entitlement deletion (delete-account.js teardown) LEAVES the token-init-grant marker — so a re-signup cannot re-farm the base grant', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var ev = fakeEvent({ method: 'POST' });
    var target = 'realuser@example.com';
    await seedFullAccountState(ev, target);

    // The token-ledger half of a real account deletion (delete-account.js
    // calls exactly this) — deliberately NOT the reset endpoint.
    await entitlements.deleteEntitlement(ev, target);

    // The record is gone, but the anti-farm marker survives.
    assert.equal(await entitlements.getEntitlement(ev, target), null, 'the record itself is deleted, as expected');
    assert.ok(await readInitMarker(ev, target), 'the token-init-grant marker MUST survive a normal deletion — this is the anti-farm protection');

    // A re-read therefore does NOT re-grant a fresh 170 record: the surviving
    // marker routes it into the echo path, which writes nothing new (contrast
    // the reset test above, where the same read re-grants).
    var ev2 = fakeEvent({ ip: nextIp() });
    await entitlements.getTokenStatus(ev2, target);
    assert.equal(await entitlements.getEntitlement(ev2, target), null, 'a normal-deletion re-read must not materialize a brand-new full grant record (marker echo, no re-grant)');
  });
});

// ---------- Method guard ----------

test('a non-POST request is rejected 405', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var res = await handler()(fakeEvent({ method: 'GET' }));
    assert.equal(res.statusCode, 405);
  });
});
