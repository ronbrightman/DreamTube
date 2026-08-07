// test/like-dream.test.js
//
// Covers netlify/functions/like-dream.js's existing like/unlike behavior
// PLUS the new 'like_given'/'like_received' PostHog events added for Phase
// 1 reporting instrumentation (tracker item
// for-product-phase-1-reporting-instrument-kjlh46) — this is "the single
// choke-point that already knows the dream, the owner, and the delta" the
// tracker item calls out. Mocks global.fetch for the outbound PostHog
// capture calls, same convention as test/dodo-webhook.test.js's own
// installAnalyticsFetchSpy.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var { getStore } = require('@netlify/blobs');
var handler = require('../netlify/functions/like-dream').handler;

var realFetch = global.fetch;
// See test/helpers/fetch-double.js -- marks this file's own fetch double so
// lib/posthog-capture.js's test-process guard lets its analytics fires reach it.
var { markInstalledFetchAsTestDouble } = require('./helpers/fetch-double');

function installPostHogSpy(opts) {
  opts = opts || {};
  var calls = [];
  global.fetch = async function (url, init) {
    var urlStr = String(url);
    if (urlStr.indexOf('/capture/') === -1) throw new Error('unexpected fetch to ' + urlStr);
    calls.push({ url: urlStr, body: init && init.body ? JSON.parse(init.body) : null });
    if (opts.fails) return { ok: false, status: 500, json: async function () { return {}; }, text: async function () { return 'down'; } };
    return { ok: true, status: 200, json: async function () { return {}; }, text: async function () { return 'ok'; } };
  };
  markInstalledFetchAsTestDouble();
  return calls;
}

test.beforeEach(function () {
  mockBlobs.reset();
});

test.after(function () {
  global.fetch = realFetch;
});

async function seedFeedDream(dream) {
  var store = getStore('dreamtube-feed');
  var feed = (await store.get('feed-index', { type: 'json' })) || [];
  feed.push(Object.assign({ likes: 0 }, dream));
  await store.setJSON('feed-index', feed);
}

function postEvent(body) {
  return fakeEvent({ method: 'POST', body: body });
}

test('wrong method -> 405', async function () {
  var res = await handler(fakeEvent({ method: 'GET' }));
  assert.equal(res.statusCode, 405);
});

test('invalid JSON -> 400', async function () {
  var res = await handler(fakeEvent({ method: 'POST', body: 'not json' }));
  assert.equal(res.statusCode, 400);
});

test('missing id -> 400', async function () {
  var res = await handler(postEvent({ delta: 1 }));
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, 'id_required');
});

test('unknown dream id -> 404', async function () {
  var res = await handler(postEvent({ id: 'does-not-exist', delta: 1 }));
  assert.equal(res.statusCode, 404);
});

test('a real like (+1) still increments the shared count as before, and fires like_given + like_received', async function () {
  await seedFeedDream({ id: 'dream-1', ownerHandle: '@owner1', likes: 5 });
  var calls = installPostHogSpy();

  var res = await handler(postEvent({ id: 'dream-1', delta: 1, likerHandle: '@liker1' }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.likes, 6, 'the like count itself must be unaffected by any of the new analytics wiring');

  assert.equal(calls.length, 2, 'expected exactly one like_given + one like_received call');
  var givenCall = calls.filter(function (c) { return c.body.event === 'like_given'; })[0];
  var receivedCall = calls.filter(function (c) { return c.body.event === 'like_received'; })[0];
  assert.ok(givenCall, 'like_given must fire');
  assert.ok(receivedCall, 'like_received must fire');
  assert.equal(givenCall.body.distinct_id, 'liker1', 'like_given distinct_id must be the LIKER, with the leading @ stripped');
  assert.equal(receivedCall.body.distinct_id, 'owner1', 'like_received distinct_id must be the dream OWNER, with the leading @ stripped');
  assert.equal(givenCall.body.properties.dreamId, 'dream-1');
  assert.equal(receivedCall.body.properties.dreamId, 'dream-1');
});

test('unliking (delta -1) still decrements the shared count as before, but fires NEITHER like_given nor like_received', async function () {
  await seedFeedDream({ id: 'dream-2', ownerHandle: '@owner2', likes: 5 });
  var calls = installPostHogSpy();

  var res = await handler(postEvent({ id: 'dream-2', delta: -1, likerHandle: '@liker2' }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.likes, 4);
  assert.equal(calls.length, 0, 'an unlike must never fire like_given or like_received');
});

test('the shared count never goes negative, same pre-existing guarantee, unaffected by the analytics addition', async function () {
  await seedFeedDream({ id: 'dream-3', ownerHandle: '@owner3', likes: 0 });
  installPostHogSpy();
  var res = await handler(postEvent({ id: 'dream-3', delta: -1, likerHandle: '@liker3' }));
  var body = JSON.parse(res.body);
  assert.equal(body.likes, 0);
});

test('a dream liked by its own owner (self-like) fires BOTH events on the same distinct_id -- not specially handled, an honest reflection of what happened', async function () {
  await seedFeedDream({ id: 'dream-4', ownerHandle: '@selfliker', likes: 0 });
  var calls = installPostHogSpy();
  await handler(postEvent({ id: 'dream-4', delta: 1, likerHandle: '@selfliker' }));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.distinct_id, 'selfliker');
  assert.equal(calls[1].body.distinct_id, 'selfliker');
});

test('missing likerHandle (logged-out/legacy caller): like_received still fires for the owner, like_given is skipped', async function () {
  await seedFeedDream({ id: 'dream-5', ownerHandle: '@owner5', likes: 0 });
  var calls = installPostHogSpy();
  var res = await handler(postEvent({ id: 'dream-5', delta: 1 })); // no likerHandle at all
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.event, 'like_received');
  assert.equal(calls[0].body.distinct_id, 'owner5');
});

test('a PostHog failure never blocks the like itself or the 200 response', async function () {
  await seedFeedDream({ id: 'dream-6', ownerHandle: '@owner6', likes: 2 });
  installPostHogSpy({ fails: true });
  var res = await handler(postEvent({ id: 'dream-6', delta: 1, likerHandle: '@liker6' }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.likes, 3, 'the like itself must land even though PostHog is down');
});

test('a plain (non-@-prefixed) handle is used as-is for distinct_id (stripHandle is a no-op without a leading @)', async function () {
  await seedFeedDream({ id: 'dream-7', ownerHandle: 'owner7', likes: 0 });
  var calls = installPostHogSpy();
  await handler(postEvent({ id: 'dream-7', delta: 1, likerHandle: 'liker7' }));
  var givenCall = calls.filter(function (c) { return c.body.event === 'like_given'; })[0];
  var receivedCall = calls.filter(function (c) { return c.body.event === 'like_received'; })[0];
  assert.equal(givenCall.body.distinct_id, 'liker7');
  assert.equal(receivedCall.body.distinct_id, 'owner7');
});

// ============================================================================
// CONCURRENCY — the founder-confirmed stale-read clobber (tracker item
// for-product-likes-vanish-from-feed-video-fyqks0)
// ----------------------------------------------------------------------------
// like-dream.js used to do a plain whole-array read -> mutate one dream's
// `likes` IN PLACE -> write-back with NO retry/verify at all. Two genuinely
// concurrent likes on the SAME dream let both calls read the same
// pre-increment `likes` value before either writes, so the second call's
// write silently clobbers the first's increment — confirmed live via
// PostHog like_given vs. the actual feed count (three documented cases, see
// the tracker item).
//
// A PLAIN Promise.all race (the technique test/tracker.test.js's own "two
// concurrent updateItem calls" CONCURRENCY block uses successfully for an
// analogous whole-array RMW) does NOT reliably reproduce this specific bug
// against test/helpers/mock-blobs.js's fake store, for a subtle reason
// worth documenting rather than silently working around: the fake store's
// get()/setJSON() never clone -- store.get() hands back the exact SAME
// in-memory array/object reference on every call until the next setJSON()
// replaces it. The OLD like-dream.js mutated that shared reference directly
// (`feed[idx].likes = ...`) rather than building a fresh array/object (the
// copy-on-write discipline tracker-store.js's updateItem, entitlements.js's
// creditTokenPackAmountOnce, and pending-dreams.js's tryTransition all
// already follow, and this fix now adopts too). Under this specific mock,
// mutating the shared reference in place means a second concurrent caller's
// later read of "the same key" incidentally already reflects the first
// caller's in-place mutation, even though its own local variable was
// assigned before that mutation happened — so the bug perversely
// self-corrects under this mock's aliasing, even though it demonstrably
// does NOT self-correct against real Netlify Blobs (which always
// deserializes a fresh, independent object on every get()). The three plain
// Promise.all tests below are still valid, honest regression coverage for
// the FIX (which never mutates in place, so they pass for the right
// reason) — but see the "FORCED, deterministic race" test further down for
// the one that actually distinguishes old vs. new: it breaks the mock's
// reference-sharing explicitly, mirroring the real Netlify Blobs semantics
// every read/write actually has, using the same setReadOverride/
// setWriteOverride technique test/entitlements-token-purchases.test.js and
// test/automatic-first-dream-email.test.js already use for hazards a plain
// synchronous Map can't otherwise reproduce.
// ============================================================================

test('CONCURRENCY: two concurrent delta:1 likes on the SAME dream both land -- the count reflects both, neither clobbers the other', async function () {
  await seedFeedDream({ id: 'dream-race-1', ownerHandle: '@owner-race1', likes: 10 });
  installPostHogSpy();

  var results = await Promise.all([
    handler(postEvent({ id: 'dream-race-1', delta: 1, likerHandle: '@likerA' })),
    handler(postEvent({ id: 'dream-race-1', delta: 1, likerHandle: '@likerB' }))
  ]);

  results.forEach(function (res) { assert.equal(res.statusCode, 200); });

  var store = getStore('dreamtube-feed');
  var finalFeed = await store.get('feed-index', { type: 'json' });
  var finalDream = finalFeed.filter(function (d) { return d.id === 'dream-race-1'; })[0];
  assert.equal(finalDream.likes, 12, 'both concurrent likes must be reflected (10 + 1 + 1) -- a clobbered write would leave this at 11');
});

test('CONCURRENCY: repeated trials stay consistent (rules out a lucky single pass)', async function () {
  installPostHogSpy();
  for (var i = 0; i < 10; i++) {
    var id = 'dream-race-loop-' + i;
    await seedFeedDream({ id: id, ownerHandle: '@owner-loop', likes: 0 });
    var results = await Promise.all([
      handler(postEvent({ id: id, delta: 1, likerHandle: '@likerA' })),
      handler(postEvent({ id: id, delta: 1, likerHandle: '@likerB' }))
    ]);
    results.forEach(function (res) { assert.equal(res.statusCode, 200); });

    var store = getStore('dreamtube-feed');
    var finalFeed = await store.get('feed-index', { type: 'json' });
    var finalDream = finalFeed.filter(function (d) { return d.id === id; })[0];
    assert.equal(finalDream.likes, 2, 'trial ' + i + ': both concurrent likes must land');
  }
});

test('CONCURRENCY: three concurrent delta:1 likes on the same dream all land', async function () {
  await seedFeedDream({ id: 'dream-race-3', ownerHandle: '@owner-race3', likes: 0 });
  installPostHogSpy();

  var results = await Promise.all([
    handler(postEvent({ id: 'dream-race-3', delta: 1, likerHandle: '@likerA' })),
    handler(postEvent({ id: 'dream-race-3', delta: 1, likerHandle: '@likerB' })),
    handler(postEvent({ id: 'dream-race-3', delta: 1, likerHandle: '@likerC' }))
  ]);
  results.forEach(function (res) { assert.equal(res.statusCode, 200); });

  var store = getStore('dreamtube-feed');
  var finalFeed = await store.get('feed-index', { type: 'json' });
  var finalDream = finalFeed.filter(function (d) { return d.id === 'dream-race-3'; })[0];
  assert.equal(finalDream.likes, 3, 'all three concurrent likes must land');
});

/**
 * Installs the real-Blobs-fidelity fix described in the CONCURRENCY block's
 * header comment above: every get() against `storeName` returns a fresh,
 * independent deep clone of whatever was actually most recently written
 * (or the value present at install time, for reads before any write),
 * instead of the mock's default shared-reference behavior. Tracks "what
 * was actually written" via setWriteOverride (which still lets the real
 * write happen -- it only OBSERVES the value, via a falsy return) rather
 * than needing raw access to the mock's private store map. This is what
 * makes two concurrent handler() calls behave like two genuinely separate
 * Netlify Function invocations reading a real, physically deserialized
 * Blobs value, instead of accidentally sharing one in-process object.
 * Callers MUST call the returned `uninstall()` when done (mirrors every
 * other override's clear pattern).
 */
function installIndependentReadsForStore(storeName) {
  var groundTruth = null;
  mockBlobs.setWriteOverride(storeName, function (key, value) {
    groundTruth = value;
    return false; // let the real write proceed
  });
  mockBlobs.setReadOverride(storeName, function () {
    return { value: JSON.parse(JSON.stringify(groundTruth)) };
  });
  return {
    seedGroundTruth: function (value) { groundTruth = value; },
    uninstall: function () {
      mockBlobs.clearReadOverride(storeName);
      mockBlobs.clearWriteOverride(storeName);
    }
  };
}

test('CONCURRENCY (FORCED, deterministic race -- the actual negative-proof test): two concurrent delta:1 likes, with reads forced to behave like real independently-deserialized Blobs reads, both land -- neither clobbers the other', async function () {
  await seedFeedDream({ id: 'dream-race-forced', ownerHandle: '@owner-forced', likes: 10 });
  installPostHogSpy();

  var override = installIndependentReadsForStore('dreamtube-feed');
  override.seedGroundTruth([{ id: 'dream-race-forced', ownerHandle: '@owner-forced', likes: 10 }]);

  try {
    var results = await Promise.all([
      handler(postEvent({ id: 'dream-race-forced', delta: 1, likerHandle: '@likerA' })),
      handler(postEvent({ id: 'dream-race-forced', delta: 1, likerHandle: '@likerB' }))
    ]);
    results.forEach(function (res) { assert.equal(res.statusCode, 200); });
  } finally {
    override.uninstall();
  }

  var store = getStore('dreamtube-feed');
  var finalFeed = await store.get('feed-index', { type: 'json' });
  var finalDream = finalFeed.filter(function (d) { return d.id === 'dream-race-forced'; })[0];
  assert.equal(finalDream.likes, 12, 'both concurrent likes must be reflected (10 + 1 + 1) against a store whose reads behave like real, independently-deserialized Netlify Blobs reads -- this is the test that actually fails against the pre-fix whole-array-RMW-with-no-retry implementation (final lands at 11, one like clobbered) and passes once like-dream.js retries+verifies via lib/blobs-retry.js');
});

// A false-negative verify (our own just-written likes count not yet
// visible to the verify-read) must NOT double-apply the delta on retry --
// see lib/blobs-retry.js's own header comment on why a naive "read
// current, add delta" mutate is unsafe under its retry contract. This
// mirrors test/entitlements-token-purchases.test.js's own stale-read
// regression test for creditTokenPackAmountOnce.
test('a verify-read that falsely reports our own just-applied write as invisible does not double-apply the delta on retry', async function () {
  await seedFeedDream({ id: 'dream-false-negative', ownerHandle: '@owner-fn', likes: 5 });
  installPostHogSpy();

  // Force the FIRST verify-read (the read right after the write) to look
  // stale (still showing the pre-write feed), so the loop retries. The
  // retry's own fresh read then sees the real, already-incremented state.
  // A mutate that blindly recomputed "current + delta" from that fresh
  // read would double-apply here (5 -> 6 -> 7); the fix must recognize its
  // own already-applied write and not add the delta twice.
  var callCount = 0;
  mockBlobs.setReadOverride('dreamtube-feed', function (key, callIndex) {
    callCount++;
    // Only intercept the SECOND get() call against this store for this
    // request (the first is the loop's own initial `read`, which must see
    // the real seeded state; the second is the write's immediate
    // verify-read) -- fall through to the real value everywhere else,
    // including every subsequent attempt's read/verify.
    if (callIndex === 2) {
      return { value: [{ id: 'dream-false-negative', ownerHandle: '@owner-fn', likes: 5 }] };
    }
    return null;
  });

  try {
    var res = await handler(postEvent({ id: 'dream-false-negative', delta: 1, likerHandle: '@liker-fn' }));
    assert.equal(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.equal(body.likes, 6, 'a false-negative verify must not cause the delta to be applied twice');
  } finally {
    mockBlobs.clearReadOverride('dreamtube-feed');
  }

  var store = getStore('dreamtube-feed');
  var finalFeed = await store.get('feed-index', { type: 'json' });
  var finalDream = finalFeed.filter(function (d) { return d.id === 'dream-false-negative'; })[0];
  assert.equal(finalDream.likes, 6, 'the persisted count must also be 6, not 7');
});
