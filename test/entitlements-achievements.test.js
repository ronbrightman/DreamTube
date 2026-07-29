// test/entitlements-achievements.test.js
//
// Direct unit coverage for lib/entitlements.js's applyAchievementGrant/
// applyAchievementGrantOnce — the achievement/milestone grant ledger built
// for tracker item for-product-build-server-side-achievemen-begfnb
// (infrastructure for the homepage's upcoming milestone rewards). Mirrors
// entitlements-refund.test.js's/entitlements-token-purchases.test.js's own
// coverage shape closely, since this reuses the exact same two-phase-marker
// discipline: an OUTER claimId-based marker (ACHIEVEMENT_GRANTS_STORE_NAME,
// keyed by `email::achievementId`) serializes concurrent callers before any
// of them touch the entitlement record's balance/capabilities, and an INNER
// per-record `achievements` map (folded into the same write as the
// balance/capability effect) makes a resumed/interrupted grant safe too.
//
// The single most important property this file proves: calling
// applyAchievementGrant twice (sequentially OR concurrently) for the same
// (email, achievementId) pair must only ever apply the reward once — a
// double-grant would be exactly the "trivially farmable" hazard this
// mechanism exists to close. The concurrency tests below are what catch a
// regression of that class of bug (the same class entitlements-refund.
// test.js's own header comment documents an earlier draft of refunds
// actually shipped with, before the outer marker existed).
//
// This mechanism ships NO real achievement ids/grant sizes to production —
// every test below calls applyAchievementGrant directly, the same "test-only
// trigger" posture the tracker item's own instructions call out as fine.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var entitlements = require('../netlify/functions/lib/entitlements');

test.beforeEach(function () {
  mockBlobs.reset();
});

/** Direct read against the mock Blobs store, for asserting on the outer marker's own persisted shape. */
async function mockBlobsRead(storeName, key) {
  return require('@netlify/blobs').getStore({ name: storeName }).get(key, { type: 'json' });
}

/**
 * Seeds an email with an existing, zero-balance token record before a grant
 * — isolates a test's balance assertion to just the grant being tested,
 * instead of also having to account for the separate 220-token
 * first-ever-read signup grant syncTokens applies automatically. Same
 * helper as entitlements-refund.test.js's own seedZeroBalance.
 */
async function seedZeroBalance(email) {
  await entitlements.setEntitlement({}, email, { tokens: { balance: 0, lastClaimAt: Date.now() } });
}

// ----- Basic idempotent grant application: tokens type -----

test('grants tokens onto a fresh email and reports granted:true', async function () {
  await seedZeroBalance('ach1@example.com');
  var result = await entitlements.applyAchievementGrant({}, 'ach1@example.com', 'streak_7day', { type: 'tokens', amount: 20 });
  assert.equal(result.ok, true);
  assert.equal(result.granted, true);
  assert.equal(result.balance, 20);

  var record = await entitlements.getEntitlement({}, 'ach1@example.com');
  assert.equal(record.tokens.balance, 20);
  assert.ok(record.achievements.streak_7day);
  assert.equal(record.achievements.streak_7day.type, 'tokens');
  assert.equal(record.achievements.streak_7day.amount, 20);
  assert.ok(record.achievements.streak_7day.grantedAt > 0);

  var marker = await mockBlobsRead(entitlements.ACHIEVEMENT_GRANTS_STORE_NAME, entitlements.achievementGrantMarkerKey('ach1@example.com', 'streak_7day'));
  assert.equal(marker.status, 'committed');
});

test('a second sequential call for the SAME achievement id does not double-grant', async function () {
  await seedZeroBalance('ach2@example.com');
  var first = await entitlements.applyAchievementGrant({}, 'ach2@example.com', 'streak_7day', { type: 'tokens', amount: 20 });
  var second = await entitlements.applyAchievementGrant({}, 'ach2@example.com', 'streak_7day', { type: 'tokens', amount: 20 });
  assert.equal(first.granted, true);
  assert.equal(second.granted, false, 'a repeat call for an already-granted achievement must report granted:false, not grant again');

  var record = await entitlements.getEntitlement({}, 'ach2@example.com');
  assert.equal(record.tokens.balance, 20, 'balance must reflect exactly one grant, not two -- this is the exact double-grant hazard the fix exists to close');
});

test('a DIFFERENT achievement id for the same email grants again (dedup is per achievement id, not per email)', async function () {
  await seedZeroBalance('ach3@example.com');
  await entitlements.applyAchievementGrant({}, 'ach3@example.com', 'streak_7day', { type: 'tokens', amount: 20 });
  await entitlements.applyAchievementGrant({}, 'ach3@example.com', 'streak_30day', { type: 'tokens', amount: 10 });
  var record = await entitlements.getEntitlement({}, 'ach3@example.com');
  assert.equal(record.tokens.balance, 30);
  assert.ok(record.achievements.streak_7day);
  assert.ok(record.achievements.streak_30day);
});

// ----- Capability-type grants -----

test('grants a capability onto a fresh email and reports granted:true, leaving the token balance untouched', async function () {
  await seedZeroBalance('ach4@example.com');
  var result = await entitlements.applyAchievementGrant({}, 'ach4@example.com', 'first_repeat_theme', { type: 'capability', capability: 'free_reedit', count: 1 });
  assert.equal(result.granted, true);
  assert.deepEqual(result.capabilities, { free_reedit: 1 });

  var record = await entitlements.getEntitlement({}, 'ach4@example.com');
  assert.equal(record.tokens.balance, 0, 'a capability grant must not touch the token balance');
  assert.deepEqual(record.capabilities, { free_reedit: 1 });
  assert.equal(record.achievements.first_repeat_theme.type, 'capability');
  assert.equal(record.achievements.first_repeat_theme.capability, 'free_reedit');
  assert.equal(record.achievements.first_repeat_theme.count, 1);
});

test('capability counts from different achievements accumulate additively for the SAME capability', async function () {
  await seedZeroBalance('ach5@example.com');
  await entitlements.applyAchievementGrant({}, 'ach5@example.com', 'milestone_a', { type: 'capability', capability: 'free_lens', count: 1 });
  await entitlements.applyAchievementGrant({}, 'ach5@example.com', 'milestone_b', { type: 'capability', capability: 'free_lens', count: 2 });
  var record = await entitlements.getEntitlement({}, 'ach5@example.com');
  assert.equal(record.capabilities.free_lens, 3);
});

test('different capabilities are tracked independently', async function () {
  await seedZeroBalance('ach6@example.com');
  await entitlements.applyAchievementGrant({}, 'ach6@example.com', 'm1', { type: 'capability', capability: 'free_reedit', count: 1 });
  await entitlements.applyAchievementGrant({}, 'ach6@example.com', 'm2', { type: 'capability', capability: 'free_image', count: 2 });
  var record = await entitlements.getEntitlement({}, 'ach6@example.com');
  assert.deepEqual(record.capabilities, { free_reedit: 1, free_image: 2 });
});

test('a repeat call for an already-granted capability achievement does not double-count the capability', async function () {
  await seedZeroBalance('ach7@example.com');
  await entitlements.applyAchievementGrant({}, 'ach7@example.com', 'm1', { type: 'capability', capability: 'free_reedit', count: 1 });
  var second = await entitlements.applyAchievementGrant({}, 'ach7@example.com', 'm1', { type: 'capability', capability: 'free_reedit', count: 1 });
  assert.equal(second.granted, false);
  var record = await entitlements.getEntitlement({}, 'ach7@example.com');
  assert.equal(record.capabilities.free_reedit, 1);
});

// ----- Interaction with the existing token-balance read/write paths -----

test('a tokens-type achievement grant preserves lastClaimAt/streak (never resets the daily-claim cooldown)', async function () {
  var email = 'ach8@example.com';
  var lastClaimAt = Date.now() - 1000;
  await entitlements.setEntitlement({}, email, { tokens: { balance: 50, lastClaimAt: lastClaimAt, streak: 4 } });
  await entitlements.applyAchievementGrant({}, email, 'streak_7day', { type: 'tokens', amount: 20 });
  var record = await entitlements.getEntitlement({}, email);
  assert.equal(record.tokens.balance, 70);
  assert.equal(record.tokens.lastClaimAt, lastClaimAt);
  assert.equal(record.tokens.streak, 4);
});

test('an achievement grant composes correctly with a prior daily claim and a subsequent spend', async function () {
  var email = 'ach9@example.com';
  // Zero balance with a lastClaimAt safely past the cooldown (NOT
  // Date.now() like seedZeroBalance's usual shape, which would make
  // claimDailyTokens's own cooldown check SKIP the claim below entirely) --
  // this test specifically wants a genuine, successful claim to compose
  // with the achievement grant and the spend.
  await entitlements.setEntitlement({}, email, { tokens: { balance: 0, lastClaimAt: Date.now() - (entitlements.CLAIM_COOLDOWN_MS + 60000), streak: 1 } });
  var claimResult = await entitlements.claimDailyTokens({}, email); // NOT a first-ever claim (lastClaimAt already existed) -- the normal DAILY_CLAIM_AMOUNT (20), not the 100 first-claim bonus
  assert.equal(claimResult.claimed, true);
  assert.equal(claimResult.amountClaimed, entitlements.DAILY_CLAIM_AMOUNT);
  await entitlements.applyAchievementGrant({}, email, 'streak_7day', { type: 'tokens', amount: 20 });
  await entitlements.spendTokens({}, email, 30);
  var record = await entitlements.getEntitlement({}, email);
  assert.equal(record.tokens.balance, 10); // 0 + 20 (claim) + 20 (achievement) - 30 (spend)
});

test('an achievement grant does not corrupt appliedTokenPackPaymentIds/refundedJobIds (each mechanism keeps its own separate bookkeeping)', async function () {
  var email = 'ach10@example.com';
  await seedZeroBalance(email);
  await entitlements.creditTokenPackOnce({}, email, 'pay_1', 100);
  await entitlements.applyAchievementGrant({}, email, 'streak_7day', { type: 'tokens', amount: 20 });
  var record = await entitlements.getEntitlement({}, email);
  // creditTokenPackOnce applies Token Economy C's +50% first-purchase bonus:
  // 100 * 1.5 = 150, then +20 for the achievement = 170.
  assert.equal(record.tokens.balance, 170);
  assert.deepEqual(record.appliedTokenPackPaymentIds, []);
  assert.ok(record.achievements.streak_7day);
});

test("applyAchievementGrantOnce bases the new balance on syncTokens' own returned value, not a stale independent re-read", async function () {
  // Same three-call sequence entitlements-refund.test.js's own equivalent
  // test documents for refundTokenAmountOnce (identical structure --
  // syncTokens then retryingWrite, both against STORE_NAME): call #1 is
  // syncTokens' own getEntitlement (sees nothing, brand-new email); call #2
  // is that same first-ever-read branch's internal setEntitlement
  // existing-read, persisting the signup grant; call #3 is
  // applyAchievementGrantOnce's own retryingWrite `read()` for its first
  // attempt -- the one this test actually targets, simulated as landing
  // BEFORE the signup grant's write (from call #2) has propagated to it.
  mockBlobs.setReadOverride(entitlements.STORE_NAME, function (key, callIndex) {
    if (callIndex === 3) {
      return { value: { email: key, tokens: { balance: 0, lastClaimAt: Date.now() - 100000 } } };
    }
    return null; // fall through to the real stored value for every other call
  });

  try {
    var result = await entitlements.applyAchievementGrantOnce({}, 'achstaleread@example.com', 'streak_7day', { type: 'tokens', amount: 20 });
    assert.equal(result.ok, true);

    var record = await entitlements.getEntitlement({}, 'achstaleread@example.com');
    assert.equal(record.tokens.balance, 220 + 20, "balance must be 220 (Token Economy C's INITIAL_GRANT, from syncTokens' own in-memory return value) + 20 (this grant) -- a buggy re-read-based implementation would compute 0 + 20 = 20 here, silently discarding the signup grant that had just landed");
  } finally {
    mockBlobs.clearReadOverride(entitlements.STORE_NAME);
  }
});

// ----- Validation -----

test('an invalid grantSpec (unrecognized type) throws immediately, before any Blobs I/O', async function () {
  await assert.rejects(
    entitlements.applyAchievementGrant({}, 'achinvalid1@example.com', 'streak_7day', { type: 'bogus' }),
    /grantSpec\.type must be "tokens" or "capability"/
  );
  var record = await entitlements.getEntitlement({}, 'achinvalid1@example.com');
  assert.equal(record, null, 'an invalid grantSpec must not create any record at all');
});

test('a "tokens" grantSpec missing a positive numeric amount throws', async function () {
  await assert.rejects(
    entitlements.applyAchievementGrant({}, 'achinvalid2@example.com', 'streak_7day', { type: 'tokens', amount: 0 }),
    /requires a positive numeric amount/
  );
  await assert.rejects(
    entitlements.applyAchievementGrant({}, 'achinvalid2@example.com', 'streak_7day', { type: 'tokens' }),
    /requires a positive numeric amount/
  );
});

test('a "capability" grantSpec missing a capability name or positive count throws', async function () {
  await assert.rejects(
    entitlements.applyAchievementGrant({}, 'achinvalid3@example.com', 'm1', { type: 'capability', count: 1 }),
    /requires a non-empty capability name/
  );
  await assert.rejects(
    entitlements.applyAchievementGrant({}, 'achinvalid3@example.com', 'm1', { type: 'capability', capability: 'free_reedit', count: 0 }),
    /requires a positive numeric count/
  );
});

test('an empty/missing email is a safe no-op (never throws, never touches any balance)', async function () {
  var result = await entitlements.applyAchievementGrant({}, '', 'streak_7day', { type: 'tokens', amount: 20 });
  assert.deepEqual(result, { ok: false, granted: false });
});

test('a missing/non-string achievement id is a safe no-op', async function () {
  var result = await entitlements.applyAchievementGrant({}, 'achbadid@example.com', '', { type: 'tokens', amount: 20 });
  assert.deepEqual(result, { ok: false, granted: false });
  var record = await entitlements.getEntitlement({}, 'achbadid@example.com');
  assert.equal(record, null);
});

// ----- The real regression test: genuine concurrency, not sequential -----

test('two CONCURRENT calls for the SAME achievement id grant exactly once between them, not twice', async function () {
  var email = 'achrace1@example.com';
  await seedZeroBalance(email);

  // Promise.all starts both calls before either awaits through to
  // completion, interleaving at each internal await point exactly the way
  // two near-simultaneous triggers of the same milestone would (e.g. two
  // tabs open on the same account both crossing the streak threshold at
  // once).
  var results = await Promise.all([
    entitlements.applyAchievementGrant({}, email, 'streak_7day', { type: 'tokens', amount: 20 }),
    entitlements.applyAchievementGrant({}, email, 'streak_7day', { type: 'tokens', amount: 20 })
  ]);

  var grantedCount = results.filter(function (r) { return r.granted; }).length;
  assert.equal(grantedCount, 1, 'exactly one of the two concurrent calls should report granted:true');

  var record = await entitlements.getEntitlement({}, email);
  assert.equal(record.tokens.balance, 20, 'a genuinely concurrent double-trigger must still only grant tokens once');
});

test('three CONCURRENT calls for the SAME achievement id still grant exactly once', async function () {
  var email = 'achrace2@example.com';
  await seedZeroBalance(email);

  var results = await Promise.all([
    entitlements.applyAchievementGrant({}, email, 'streak_7day', { type: 'tokens', amount: 20 }),
    entitlements.applyAchievementGrant({}, email, 'streak_7day', { type: 'tokens', amount: 20 }),
    entitlements.applyAchievementGrant({}, email, 'streak_7day', { type: 'tokens', amount: 20 })
  ]);

  var grantedCount = results.filter(function (r) { return r.granted; }).length;
  assert.equal(grantedCount, 1);

  var record = await entitlements.getEntitlement({}, email);
  assert.equal(record.tokens.balance, 20);
});

test('two CONCURRENT calls for the SAME capability achievement id still only count the capability once', async function () {
  var email = 'achrace3@example.com';
  await seedZeroBalance(email);

  var results = await Promise.all([
    entitlements.applyAchievementGrant({}, email, 'first_repeat_theme', { type: 'capability', capability: 'free_reedit', count: 1 }),
    entitlements.applyAchievementGrant({}, email, 'first_repeat_theme', { type: 'capability', capability: 'free_reedit', count: 1 })
  ]);

  var grantedCount = results.filter(function (r) { return r.granted; }).length;
  assert.equal(grantedCount, 1);

  var record = await entitlements.getEntitlement({}, email);
  assert.equal(record.capabilities.free_reedit, 1);
});

test('concurrent grants on DIFFERENT achievement ids for the same email both go through the dedup guard independently (both granted:true)', async function () {
  var email = 'achracediff@example.com';
  await seedZeroBalance(email);

  var results = await Promise.all([
    entitlements.applyAchievementGrant({}, email, 'streak_7day', { type: 'tokens', amount: 20 }),
    entitlements.applyAchievementGrant({}, email, 'first_repeat_theme', { type: 'capability', capability: 'free_reedit', count: 1 })
  ]);

  assert.equal(results[0].granted, true);
  assert.equal(results[1].granted, true);

  var record = await entitlements.getEntitlement({}, email);
  assert.equal(record.tokens.balance, 20);
  assert.equal(record.capabilities.free_reedit, 1);
});

// ----- Cross-function concurrency: a genuinely concurrent claimDailyTokens
// write on the SAME email must survive applyAchievementGrantOnce's own
// retry loop, not get reverted (tracker item
// entitlements-js-retryingwrite-balance-mu-qxm1ih) -----
//
// The tests above this section all prove applyAchievementGrant's OWN
// idempotency (double-grant prevention). This section proves something
// different and was the actual review finding that shipped alongside the
// achievement-ledger PR (see applyAchievementGrantOnce's own doc comment):
// applyAchievementGrantOnce used to capture `syncedTokens` ONCE, before its
// retryingWrite loop, then reuse that single snapshot's
// balance/lastClaimAt/streak verbatim on EVERY retry attempt inside
// `mutate` -- instead of re-deriving those fields from THAT attempt's own
// fresh `rec.tokens`, the way `nextCapabilities` already correctly did. A
// SEQUENTIAL test (`await` one call, then the other) can never catch this
// class of bug: by the time the second call's own outer `syncTokens` runs,
// the first call is long finished and already visible, so both the old,
// buggy code and the fixed code compute the identical (correct) result --
// there is nothing to distinguish them. The bug only surfaces when a
// genuinely concurrent write from a DIFFERENT function lands on this SAME
// email's record sometime between applyAchievementGrantOnce's own outer
// syncTokens snapshot and one of its own LATER retry attempts actually
// succeeding -- exactly the "second/third attempt is a NORMAL, expected
// occurrence" scenario blobs-retry.js's own header comment describes, not
// a contrived edge case.
//
// The test below uses Promise.all to fire a REAL, genuinely concurrent
// claimDailyTokens call racing applyAchievementGrant on the SAME email,
// with a mockBlobs read override that intercepts applyAchievementGrantOnce's
// own OUTER `syncTokens()` read specifically (identified by inspecting the
// call stack for `applyAchievementGrantOnce`, so it never interferes with
// claimDailyTokens' own, completely separate reads/writes against the same
// store) and forces it to see the PRE-claim state -- exactly mimicking what
// a real Blobs propagation lag would produce if the concurrent claim's
// write hadn't reached that read yet, deterministically instead of leaving
// it to chance timing. Everything AFTER that one forced read (the
// retryingWrite loop's own read/write/verify) sees REAL data, including
// whatever the genuinely concurrent claim has by then actually written.
// This exercises precisely the bug this fix closes: the pre-fix code always
// built its new `tokens` off that one forced-stale `syncedTokens` snapshot,
// no matter how fresh the retryingWrite loop's own read was; the fix
// prefers that attempt's own fresh read instead (see
// baseTokensForAttempt's own doc comment for the exact rule). This test
// FAILS against the pre-fix code (the concurrent claim's lastClaimAt/
// streak get silently reverted, and its +20 balance is lost) and PASSES
// against the fix -- verified by hand against a git HEAD copy of
// lib/entitlements.js (the pre-fix version) during development of this fix.

test("a genuinely concurrent claimDailyTokens write is NOT reverted by applyAchievementGrantOnce's own retry loop (real concurrency, not sequential awaits)", async function () {
  var email = 'achraceclaim@example.com';
  var pastCooldown = Date.now() - (entitlements.CLAIM_COOLDOWN_MS + 60000);
  // A pre-existing, already-claimed-before account (NOT seedZeroBalance's
  // usual just-created shape) -- this test specifically wants a normal
  // (non-first-ever, non-bonus) +20 claim to compose with the achievement
  // grant, isolating the assertion to the exact race this fix closes.
  await entitlements.setEntitlement({}, email, { tokens: { balance: 100, lastClaimAt: pastCooldown, streak: 3 }, firstClaimAt: pastCooldown - 1000 });

  var forcedOnce = false;
  mockBlobs.setReadOverride(entitlements.STORE_NAME, function (key) {
    if (forcedOnce) return null;
    // The FIRST STORE_NAME read whose call stack passes through
    // applyAchievementGrantOnce is its own outer `syncTokens()` call (that
    // function's first thing it does) -- this deliberately targets THAT
    // read, not the retryingWrite loop's own read/verify further down,
    // which are left untouched (return null falls through to real data).
    if (new Error().stack.indexOf('applyAchievementGrantOnce') !== -1) {
      forcedOnce = true;
      // A snapshot matching the PRE-claim state -- simulates syncTokens'
      // own read landing before the concurrent claim's write has
      // propagated to it, exactly the real Blobs propagation-lag hazard
      // this file's own header comment (on lib/entitlements.js) documents.
      return { value: { email: key, tokens: { balance: 100, lastClaimAt: pastCooldown, streak: 3 } } };
    }
    return null;
  });

  var results;
  try {
    // Promise.all, not two sequential awaits -- see this section's own
    // header comment for why sequential awaits can never exercise this bug
    // class.
    results = await Promise.all([
      entitlements.applyAchievementGrant({}, email, 'race_ach', { type: 'tokens', amount: 50 }),
      entitlements.claimDailyTokens({}, email)
    ]);
  } finally {
    mockBlobs.clearReadOverride(entitlements.STORE_NAME);
  }

  assert.equal(results[0].granted, true, 'the achievement grant must still succeed despite needing a real retry');
  assert.equal(results[1].claimed, true, 'the concurrent claim must still succeed too');

  var record = await entitlements.getEntitlement({}, email);
  assert.equal(record.tokens.balance, 100 + entitlements.DAILY_CLAIM_AMOUNT + 50, 'both the claim (+20) and the achievement grant (+50) must land -- the bug this fix closes would silently discard the claim, leaving only 100 + 50 = 150');
  assert.notEqual(record.tokens.lastClaimAt, pastCooldown, "the concurrent claim's fresh lastClaimAt must survive -- the bug this fix closes would silently revert it back to the pre-claim value");
  assert.equal(record.tokens.streak, 4, 'the concurrent claim\'s bumped streak (3 -> 4) must survive, not get reverted back to 3');
});

// ----- Interrupted-grant resume -----

test('a marker left "pending" with the effect NOT yet applied (applyAchievementGrantOnce never ran) resumes and completes the grant exactly once', async function () {
  var email = 'achinterrupted1@example.com';
  await seedZeroBalance(email);

  mockBlobs.seed(entitlements.ACHIEVEMENT_GRANTS_STORE_NAME, entitlements.achievementGrantMarkerKey(email, 'streak_7day'), {
    email: email,
    achievementId: 'streak_7day',
    grantSpec: { type: 'tokens', amount: 20 },
    status: 'pending',
    claimId: 'stale-claim-from-interrupted-attempt',
    createdAt: Date.now() - 5000
  });

  var result = await entitlements.applyAchievementGrant({}, email, 'streak_7day', { type: 'tokens', amount: 20 });
  assert.equal(result.granted, true, 'a resumed pending marker with no applied effect must complete the grant and report granted:true');

  var record = await entitlements.getEntitlement({}, email);
  assert.equal(record.tokens.balance, 20, 'the balance must reflect exactly one grant');
});

test('a marker left "pending" where the effect was ALREADY applied (only the flip-to-committed write was interrupted) does not double-grant on resume', async function () {
  var email = 'achinterrupted2@example.com';

  // Simulates: an earlier attempt's applyAchievementGrantOnce actually
  // succeeded (balance already bumped, achievementId recorded in the
  // ledger) but the marker never got flipped to 'committed'.
  await entitlements.setEntitlement({}, email, {
    tokens: { balance: 20, lastClaimAt: Date.now() },
    achievements: { streak_7day: { grantedAt: Date.now() - 5000, type: 'tokens', amount: 20 } }
  });
  mockBlobs.seed(entitlements.ACHIEVEMENT_GRANTS_STORE_NAME, entitlements.achievementGrantMarkerKey(email, 'streak_7day'), {
    email: email,
    achievementId: 'streak_7day',
    grantSpec: { type: 'tokens', amount: 20 },
    status: 'pending',
    claimId: 'stale-claim-from-interrupted-attempt-2',
    createdAt: Date.now() - 5000
  });

  var result = await entitlements.applyAchievementGrant({}, email, 'streak_7day', { type: 'tokens', amount: 20 });
  assert.equal(result.granted, true, 'resuming a pending marker whose effect was already applied should still report granted:true (finishing the interrupted work) -- not an error');

  var record = await entitlements.getEntitlement({}, email);
  assert.equal(record.tokens.balance, 20, 'the balance must NOT be granted a second time -- this is the double-grant hazard the fix exists to close');
});

test('a marker already "committed" is a genuine repeat trigger and is never resumed (granted:false, no change to balance)', async function () {
  var email = 'achcommitted1@example.com';
  await entitlements.setEntitlement({}, email, {
    tokens: { balance: 20, lastClaimAt: Date.now() },
    achievements: { streak_7day: { grantedAt: Date.now() - 60000, type: 'tokens', amount: 20 } }
  });
  mockBlobs.seed(entitlements.ACHIEVEMENT_GRANTS_STORE_NAME, entitlements.achievementGrantMarkerKey(email, 'streak_7day'), {
    email: email,
    achievementId: 'streak_7day',
    grantSpec: { type: 'tokens', amount: 20 },
    status: 'committed',
    claimId: 'old-claim',
    createdAt: Date.now() - 60000,
    creditedAt: Date.now() - 59000
  });

  var result = await entitlements.applyAchievementGrant({}, email, 'streak_7day', { type: 'tokens', amount: 20 });
  assert.equal(result.granted, false, 'a committed marker means this achievement was already fully processed -- a repeat trigger must be a no-op');

  var record = await entitlements.getEntitlement({}, email);
  assert.equal(record.tokens.balance, 20, 'balance must be untouched by a repeat trigger of an already-committed achievement');
});

test('applyAchievementGrantOnce is idempotent per (email, achievementId) when called directly twice', async function () {
  var email = 'achdirectamount@example.com';
  await seedZeroBalance(email);

  var first = await entitlements.applyAchievementGrantOnce({}, email, 'streak_7day', { type: 'tokens', amount: 20 });
  var second = await entitlements.applyAchievementGrantOnce({}, email, 'streak_7day', { type: 'tokens', amount: 20 });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true, 'a second call for the same achievementId must still report ok:true (already applied) without granting again');

  var record = await entitlements.getEntitlement({}, email);
  assert.equal(record.tokens.balance, 20, 'balance must reflect exactly one grant despite two calls');
});

// ----- Exhaustion must throw -----

test('genuine exhaustion writing the initial pending marker (verify never confirms a winner) throws instead of silently returning granted:false', async function () {
  var email = 'achexhaustion1@example.com';
  await seedZeroBalance(email);

  mockBlobs.setReadOverride(entitlements.ACHIEVEMENT_GRANTS_STORE_NAME, function () {
    return { value: undefined };
  });

  try {
    await assert.rejects(
      entitlements.applyAchievementGrant({}, email, 'streak_7day', { type: 'tokens', amount: 20 }),
      /exhausted attempts writing the pending marker/,
      'genuine exhaustion writing the initial pending marker must throw, not silently return granted:false with nothing durably recorded and no future retry'
    );
  } finally {
    mockBlobs.clearReadOverride(entitlements.ACHIEVEMENT_GRANTS_STORE_NAME);
  }
});

test("genuine exhaustion applying the grant effect (applyAchievementGrantOnce's own retry loop) throws too", async function () {
  var email = 'achexhaustion2@example.com';
  await seedZeroBalance(email);
  mockBlobs.seed(entitlements.ACHIEVEMENT_GRANTS_STORE_NAME, entitlements.achievementGrantMarkerKey(email, 'streak_7day'), {
    email: email, achievementId: 'streak_7day', grantSpec: { type: 'tokens', amount: 20 }, status: 'pending', claimId: 'stale', createdAt: Date.now() - 5000
  });

  mockBlobs.setReadOverride(entitlements.STORE_NAME, function () {
    return { value: undefined };
  });

  try {
    await assert.rejects(
      entitlements.applyAchievementGrant({}, email, 'streak_7day', { type: 'tokens', amount: 20 }),
      /exhausted attempts granting achievement/,
      'genuine exhaustion applying the grant effect must throw too, not leave the marker pending forever with no way to resume'
    );
  } finally {
    mockBlobs.clearReadOverride(entitlements.STORE_NAME);
  }
});

test('genuine exhaustion flipping the marker to committed (bookkeeping-only failure, effect already landed) also throws', async function () {
  var email = 'achexhaustion3@example.com';
  await seedZeroBalance(email);
  mockBlobs.seed(entitlements.ACHIEVEMENT_GRANTS_STORE_NAME, entitlements.achievementGrantMarkerKey(email, 'streak_7day'), {
    email: email, achievementId: 'streak_7day', grantSpec: { type: 'tokens', amount: 20 }, status: 'pending', claimId: 'stale', createdAt: Date.now() - 5000
  });

  // Let the very first read through (the outer marker lookup that
  // discovers the seeded 'pending' marker and lets the grant effect proceed
  // normally) -- every read after that belongs to the flip-to-committed
  // attempt itself, simulated as permanently stale.
  mockBlobs.setReadOverride(entitlements.ACHIEVEMENT_GRANTS_STORE_NAME, function (key, callIndex) {
    if (callIndex === 1) return null; // real value
    return { value: undefined };
  });

  try {
    await assert.rejects(
      entitlements.applyAchievementGrant({}, email, 'streak_7day', { type: 'tokens', amount: 20 }),
      /exhausted attempts flipping the marker/,
      'genuine exhaustion flipping the marker to committed must throw, not silently leave it pending forever'
    );
  } finally {
    mockBlobs.clearReadOverride(entitlements.ACHIEVEMENT_GRANTS_STORE_NAME);
  }

  // The grant effect itself must still be correct despite the flip failing
  // to confirm -- this specific failure mode is bookkeeping-only.
  var record = await entitlements.getEntitlement({}, email);
  assert.equal(record.tokens.balance, 20, 'the grant effect must still have landed even though the flip-to-committed write could not be confirmed');
});
