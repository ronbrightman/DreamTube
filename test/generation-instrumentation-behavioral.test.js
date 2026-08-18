// test/generation-instrumentation-behavioral.test.js
//
// Real browser-driven coverage for tracker item
// for-product-track-avg-video-generation-t-2ci8ue's INSTRUMENTATION half
// (founder ask, 2026-08-10: "track average video/image generation time
// (+alert if any single job exceeds 3 minutes) and the true fail/vanish
// rate" — both were completely unmeasurable before this build: live
// PostHog data showed tokens_refunded firing 0 times against 205
// video_created over 60 days, and no generation-duration, poll-timeout, or
// vanish event existed at all).
//
// UPDATE (2026-08-18, recovery-UX part (a)): pollUntilDone's E301
// poll-timeout path itself changed — the first time the poll budget is
// exhausted while a job is still genuinely just not-done-yet, it now gets
// ONE extension (MAX_POLL_MS * 2) before actually giving up, firing a new
// 'generation_slow_retry' event at the moment of that extension (see
// js/store.js's own doc comment on pollUntilDone). The E301
// generation_failed test below was updated in place for the new timing
// (an E301 now only fires after BOTH the original and extended budgets are
// exhausted), and a new test proves a job that recovers within the
// extended budget completes normally rather than being killed early. Also
// affected: home.html's generic-technical-failure branch now shows the
// persistent GenerationFailPanel instead of a toast (recovery-UX part
// (b)) — every '.toast.show' wait in this file for a plain technical
// failure was updated to '#gfp-root'; see
// test/generation-fail-panel-behavioral.test.js for that panel's own
// dedicated coverage.
//
// Four new/changed signals, each covered below:
//   1. 'video_created' gains a `duration_ms` property (js/store.js's
//      finalizeDream) — Date.now() minus startGeneration's own hoisted
//      `startedAt`.
//   2. 'generation_slow' — a NEW event, fired alongside video_created only
//      when duration_ms crosses the founder's own explicit 3-minute
//      (180000ms) threshold. Boundary-tested just-under and just-over.
//   3. 'generation_failed' — a NEW event, fired from TWO independent choke
//      points so every real terminal-failure shape is covered: (a)
//      startGeneration's own outer .catch (a real fal-reported error, e.g.
//      E205, and a client-side poll timeout, E301 — both proven here), and
//      (b) attemptPrivateDreamSync's own terminal give-up (the E304
//      "vanish" shape — the observable pattern behind the P0 data-loss
//      incident, tracker item for-product-p0-data-loss-founder-repro-0-
//      6bzvv1, fix merged as commit 7b7828c — this event OBSERVES that
//      shape recurring, it does not re-fix the sync mechanism itself).
//      Also proves generation_failed is deliberately SKIPPED for a stale/
//      superseded edit's late failure (already silently ignored elsewhere
//      in the app — see js/store.js's own isStaleEdit doc comment).
//   4. 'generation_slow_retry' — a NEW event (recovery-UX part (a)), fired
//      the moment pollUntilDone extends a job's poll budget once instead of
//      rejecting with E301 immediately. Proven to fire exactly once even
//      when the job goes on to time out for real, and exactly once when it
//      goes on to genuinely complete within the extended budget.
//
// Follows test/phase1-product-events-behavioral.test.js's
// readPostHogCaptureCalls approach, test/auto-refund-behavioral.test.js's
// seedLoggedInWithPendingJob (a resumed pendingJob is the cheapest way to
// reach pollUntilDone/startGeneration's failure paths without a real
// fal.ai call — no mock-mode submission plumbing needed either, since a
// resume never re-submits), and test/private-dream-sync-navigation-
// race.test.js's mockDreamSync/mockGenerationCompletesImmediately for the
// vanish-shape coverage. No real generation call anywhere in this file —
// every generate-video/video-status/dream-sync endpoint is mocked via
// page.route(), per AGENT_POLICY.md's "keep generation-testing cost low"
// guidance.

var test = require('node:test');
var assert = require('node:assert/strict');
var staticServer = require('./helpers/static-server');
var settle = require('./helpers/settle').settle;

var CHROMIUM_PATH = '/opt/pw-browsers/chromium';

var playwright = null;
var unavailableReason = null;
try {
  playwright = require('playwright');
} catch (e1) {
  try {
    playwright = require('/opt/node22/lib/node_modules/playwright');
  } catch (e2) {
    unavailableReason = 'Playwright is not resolvable in this environment (' + e2.message + ')';
  }
}

var server = null;
var browser = null;
var baseUrl = null;

test.before(async function () {
  if (unavailableReason) return;
  server = await staticServer.start();
  baseUrl = server.url;
  try {
    browser = await playwright.chromium.launch({ executablePath: CHROMIUM_PATH });
  } catch (e) {
    unavailableReason = 'Could not launch Chromium at ' + CHROMIUM_PATH + ': ' + e.message;
  }
});

test.after(async function () {
  if (browser) await browser.close();
  if (server) await server.close();
});

function blockThirdParty(page) {
  return page.route(/fonts\.(googleapis|gstatic)\.com|connect\.facebook\.net|i\.posthog\.com/, function (route) {
    route.abort();
  });
}

/** Wraps page.goto with 'domcontentloaded' (not the default 'load') and tolerates a transient nav failure -- see CLAUDE.md's known environment quirk. */
async function safeGoto(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  } catch (e) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  }
}

/** Same PostHog-stub-queue read as test/phase1-product-events-behavioral.test.js -- see that file's header comment for why this is more reliable here than a monkeypatch. */
function readPostHogCaptureCalls(page) {
  return page.evaluate(function () {
    var queue = (window.posthog && typeof window.posthog.slice === 'function') ? window.posthog.slice() : [];
    return queue.filter(function (entry) { return entry[0] === 'capture'; }).map(function (entry) { return { name: entry[1], props: entry[2] }; });
  });
}

/** Same shape as test/auto-refund-behavioral.test.js's own seedLoggedInWithPendingJob, extended with an explicit `startedAt` override so tests can control elapsed_ms/duration_ms deterministically without real (or virtual-clock) waiting. Navigates to login.html first (needed before any page.evaluate can touch localStorage at all) rather than requiring every call site to do it. */
async function seedLoggedInWithPendingJob(page, username, password, email, opts) {
  opts = opts || {};
  await safeGoto(page, baseUrl + '/login.html');
  await page.evaluate(function (args) {
    var handle = '@' + args.username;
    var pendingJob = {
      operationName: (args.mediaType === 'image' ? 'fal:fal-ai/flux/dev:' : 'fal:fal-ai/veo3.1/fast:') + 'req-' + args.username,
      startedAt: args.startedAt,
      caption: args.username + '\'s in-flight dream',
      style: 'Cinematic',
      sourceDreamId: null,
      mediaType: args.mediaType || 'video',
      modelUsed: args.modelUsed || null,
      ownerHandle: handle,
      notify: false
    };
    var state = {
      user: { handle: handle, username: args.username },
      accounts: {},
      draft: { caption: '', style: null, sourceDreamId: null, restore: false, characterIds: [], cameraView: null, sceneryTime: null, sceneryPlace: null, mediaType: null, sourceImageUrl: null },
      dreams: [],
      pendingJob: pendingJob,
      charactersByUser: {},
      likedIds: {}
    };
    state.accounts[args.username] = { password: args.password, email: args.email };
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, { username: username, password: password, email: email, mediaType: opts.mediaType, startedAt: opts.startedAt || Date.now(), modelUsed: opts.modelUsed });

  await safeGoto(page, baseUrl + '/login.html');
}

// ===== duration_ms on video_created =====

test('video_created: carries a numeric duration_ms computed from the job\'s own startedAt', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var startedAt = Date.now() - 45000; // 45s ago
    await seedLoggedInWithPendingJob(page, 'durationuser', 'durationuserpassword1', 'durationuser@example.com', { startedAt: startedAt });
    await page.route('**/.netlify/functions/video-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, videoUrl: 'https://example.com/duration.mp4' }) });
    });

    await safeGoto(page, baseUrl + '/home.html');
    await page.waitForSelector('#d0-video.ready', { timeout: 8000 });

    var calls = await readPostHogCaptureCalls(page);
    var videoCreated = calls.filter(function (c) { return c.name === 'video_created'; });
    assert.equal(videoCreated.length, 1);
    var durationMs = videoCreated[0].props.duration_ms;
    assert.equal(typeof durationMs, 'number');
    // Real wall-clock elapses a little more between seeding and resolution
    // -- assert a generous lower/upper band around the ~45s the job was
    // seeded to have already been running, rather than an exact figure.
    assert.ok(durationMs >= 45000 && durationMs < 55000, 'expected duration_ms roughly 45000+, got ' + durationMs);
  } finally {
    await page.close();
  }
});

// ===== generation_slow threshold (180000ms), boundary-tested =====

test('generation_slow: does NOT fire when duration_ms is just under the 3-minute threshold', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    // 170s ago -- resolves almost immediately, landing well under 180000ms.
    await seedLoggedInWithPendingJob(page, 'slowunderuser', 'slowunderuserpassword1', 'slowunderuser@example.com', { startedAt: Date.now() - 170000 });
    await page.route('**/.netlify/functions/video-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, videoUrl: 'https://example.com/under.mp4' }) });
    });

    await safeGoto(page, baseUrl + '/home.html');
    await page.waitForSelector('#d0-video.ready', { timeout: 8000 });

    var calls = await readPostHogCaptureCalls(page);
    var videoCreated = calls.filter(function (c) { return c.name === 'video_created'; });
    assert.equal(videoCreated.length, 1);
    assert.ok(videoCreated[0].props.duration_ms < 180000, 'sanity: duration_ms must genuinely be under the threshold, got ' + videoCreated[0].props.duration_ms);
    var slowCalls = calls.filter(function (c) { return c.name === 'generation_slow'; });
    assert.equal(slowCalls.length, 0, 'a generation that finished under 3 minutes must never fire generation_slow');
  } finally {
    await page.close();
  }
});

test('generation_slow: DOES fire when duration_ms crosses the 3-minute threshold, carrying style/mediaType/modelUsed/duration_ms', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    // 190s ago -- resolves almost immediately, landing well over 180000ms.
    await seedLoggedInWithPendingJob(page, 'slowoveruser', 'slowoveruserpassword1', 'slowoveruser@example.com', { startedAt: Date.now() - 190000, modelUsed: 'veo3.1-lite' });
    await page.route('**/.netlify/functions/video-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, videoUrl: 'https://example.com/over.mp4' }) });
    });

    await safeGoto(page, baseUrl + '/home.html');
    await page.waitForSelector('#d0-video.ready', { timeout: 8000 });

    var calls = await readPostHogCaptureCalls(page);
    var videoCreated = calls.filter(function (c) { return c.name === 'video_created'; });
    assert.equal(videoCreated.length, 1);
    assert.ok(videoCreated[0].props.duration_ms > 180000, 'sanity: duration_ms must genuinely be over the threshold, got ' + videoCreated[0].props.duration_ms);

    var slowCalls = calls.filter(function (c) { return c.name === 'generation_slow'; });
    assert.equal(slowCalls.length, 1, 'a generation that finished over 3 minutes must fire generation_slow exactly once');
    assert.equal(slowCalls[0].props.style, 'Cinematic');
    assert.equal(slowCalls[0].props.mediaType, 'video');
    assert.equal(slowCalls[0].props.modelUsed, 'veo3.1-lite');
    assert.equal(slowCalls[0].props.duration_ms, videoCreated[0].props.duration_ms, 'generation_slow\'s own duration_ms must match the paired video_created\'s figure exactly, same job');
  } finally {
    await page.close();
  }
});

// ===== generation_failed: real fal error (E205) =====

test('generation_failed: fires on a real fal-reported error (E205), with reason/mediaType/elapsed_ms/model', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var startedAt = Date.now() - 12000; // 12s ago
    await seedLoggedInWithPendingJob(page, 'failfaluser', 'failfaluserpassword1', 'failfaluser@example.com', { startedAt: startedAt, modelUsed: 'veo3.1-lite' });
    await page.route('**/.netlify/functions/video-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, error: 'E205: generation_failed: FAILED' }) });
    });

    await safeGoto(page, baseUrl + '/home.html');
    // A plain technical failure now surfaces as the persistent
    // GenerationFailPanel (recovery-UX part (b)), not a toast -- see
    // test/generation-fail-panel-behavioral.test.js for that panel's own
    // dedicated coverage.
    await page.waitForSelector('#gfp-root', { state: 'visible', timeout: 8000 });

    var calls = await readPostHogCaptureCalls(page);
    var failedCalls = calls.filter(function (c) { return c.name === 'generation_failed'; });
    assert.equal(failedCalls.length, 1, 'expected exactly one generation_failed capture for the one real fal-reported failure');
    assert.equal(failedCalls[0].props.reason, 'E205: generation_failed: FAILED');
    assert.equal(failedCalls[0].props.mediaType, 'video');
    assert.equal(failedCalls[0].props.model, 'veo3.1-lite');
    assert.equal(typeof failedCalls[0].props.elapsed_ms, 'number');
    assert.ok(failedCalls[0].props.elapsed_ms >= 12000, 'expected elapsed_ms roughly 12000+, got ' + failedCalls[0].props.elapsed_ms);
  } finally {
    await page.close();
  }
});

test('generation_failed: the image path reports mediaType:\'image\' too (image-status.js, E508)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await seedLoggedInWithPendingJob(page, 'failimguser', 'failimguserpassword1', 'failimguser@example.com', { startedAt: Date.now() - 5000, mediaType: 'image' });
    await page.route('**/.netlify/functions/image-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, error: 'E508: no_image_in_response' }) });
    });

    await safeGoto(page, baseUrl + '/home.html');
    await page.waitForSelector('#gfp-root', { state: 'visible', timeout: 8000 });

    var calls = await readPostHogCaptureCalls(page);
    var failedCalls = calls.filter(function (c) { return c.name === 'generation_failed'; });
    assert.equal(failedCalls.length, 1);
    assert.equal(failedCalls[0].props.reason, 'E508: no_image_in_response');
    assert.equal(failedCalls[0].props.mediaType, 'image');
    // generate-image.js never reports a rotation-eligible modelUsed at all
    // (see js/store.js's own doc comment) -- null here is the honest,
    // never-fabricated value, not a gap.
    assert.equal(failedCalls[0].props.model, null);
  } finally {
    await page.close();
  }
});

// ===== generation_failed: client-side poll timeout (E301) =====

test('generation_failed: fires on a client-side poll timeout (E301) -- only AFTER the one-time recovery-UX extension (part (a)) is exhausted too, no fal response needed at all', { timeout: 30000 }, async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    // 21 minutes ago -- already past BOTH the original MAX_POLL_MS (10 min)
    // AND the one-time extended budget (MAX_POLL_MS * 2 = 20 min) a
    // genuinely-still-polling job now gets before this actually fires
    // (recovery-UX part (a), tracker item for-product-track-avg-video-
    // generation-t-2ci8ue -- see js/store.js's pollUntilDone). The very
    // first poll() breach still only EXTENDS (never rejects immediately the
    // instant MAX_POLL_MS alone is crossed); only the NEXT tick
    // (POLL_INTERVAL_MS later), still past the now-doubled budget, finally
    // rejects with E301 for real -- exercised in real wall-clock time here
    // (one real ~10s POLL_INTERVAL_MS wait), not faked.
    var startedAt = Date.now() - (21 * 60 * 1000);
    await seedLoggedInWithPendingJob(page, 'failtimeoutuser', 'failtimeoutuserpassword1', 'failtimeoutuser@example.com', { startedAt: startedAt });
    var statusCallCount = 0;
    await page.route('**/.netlify/functions/video-status*', function (route) {
      statusCallCount++;
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: false }) });
    });

    await safeGoto(page, baseUrl + '/home.html');
    await page.waitForSelector('#gfp-root', { state: 'visible', timeout: 20000 });

    assert.equal(statusCallCount, 0, 'a job already past the full 21-minute extended budget at load time must never issue a real network call -- both the original and extended budget checks happen synchronously before any fetch');

    var calls = await readPostHogCaptureCalls(page);
    var retryCalls = calls.filter(function (c) { return c.name === 'generation_slow_retry'; });
    assert.equal(retryCalls.length, 1, 'the one-time extension must fire generation_slow_retry exactly once, before the eventual real timeout');
    assert.equal(retryCalls[0].props.mediaType, 'video');
    assert.ok(retryCalls[0].props.elapsed_ms >= 21 * 60 * 1000, 'expected generation_slow_retry elapsed_ms roughly 1260000+, got ' + retryCalls[0].props.elapsed_ms);

    var failedCalls = calls.filter(function (c) { return c.name === 'generation_failed'; });
    assert.equal(failedCalls.length, 1, 'exactly one final E301 generation_failed, not one per extension tick');
    assert.equal(failedCalls[0].props.reason, 'E301: generation_timeout');
    assert.equal(failedCalls[0].props.mediaType, 'video');
    assert.ok(failedCalls[0].props.elapsed_ms >= 21 * 60 * 1000, 'expected elapsed_ms roughly 1260000+, got ' + failedCalls[0].props.elapsed_ms);
  } finally {
    await page.close();
  }
});

test('pollUntilDone: a job past the ORIGINAL 10-minute budget but still under the extended 20-minute one gets the one-time extension and then genuinely completes -- not killed early', { timeout: 30000 }, async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    // 10 minutes + 5 seconds ago -- past the original MAX_POLL_MS (10 min)
    // on the very first poll() check, but comfortably under the extended
    // 20-minute budget. The first breach extends (fires
    // generation_slow_retry) instead of rejecting; the NEXT tick
    // (POLL_INTERVAL_MS later, ~10min15s elapsed) is still under the
    // extended budget, so it proceeds to actually fetch video-status and
    // resolves normally -- proving a job that's simply still running past
    // the old 10-minute ceiling is no longer killed outright.
    var startedAt = Date.now() - (10 * 60 * 1000 + 5000);
    await seedLoggedInWithPendingJob(page, 'extendrecoveruser', 'extendrecoveruserpassword1', 'extendrecoveruser@example.com', { startedAt: startedAt });
    var statusCallCount = 0;
    await page.route('**/.netlify/functions/video-status*', function (route) {
      statusCallCount++;
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, videoUrl: 'https://example.com/extended-recovery.mp4' }) });
    });

    await safeGoto(page, baseUrl + '/home.html');
    await page.waitForSelector('#d0-video.ready', { timeout: 20000 });

    assert.ok(statusCallCount >= 1, 'the extended poll must have actually reached video-status and resolved, not given up');

    var calls = await readPostHogCaptureCalls(page);
    var retryCalls = calls.filter(function (c) { return c.name === 'generation_slow_retry'; });
    assert.equal(retryCalls.length, 1, 'the one-time extension must have fired exactly once on the way to this successful completion');

    var failedCalls = calls.filter(function (c) { return c.name === 'generation_failed'; });
    assert.equal(failedCalls.length, 0, 'a job that goes on to genuinely complete within the extended budget must never fire generation_failed');

    var videoCreated = calls.filter(function (c) { return c.name === 'video_created'; });
    assert.equal(videoCreated.length, 1, 'the job must complete normally and fire video_created despite the earlier extension');
  } finally {
    await page.close();
  }
});

// ===== generation_failed: deliberately skipped for a stale/superseded edit =====

test('generation_failed: a STALE, superseded edit\'s late failure never fires it -- that attempt is already silently ignored elsewhere, firing here would double-count against the same dream\'s live attempt', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var pageA = await context.newPage();
    var pageB = await context.newPage();
    await blockThirdParty(pageA);
    await blockThirdParty(pageB);

    var dreamId = 'd-stale-genfail-1';
    var opA = 'mock:req-stale-genfail-a';
    var opB = 'mock:req-stale-genfail-b';

    // Page A: dream's room, mid-regeneration via job A (first edit).
    // video-status held open (never auto-fulfilled) until job B has
    // already landed, then fulfilled as a FAILURE -- same shape
    // test/edit-regeneration-forming-state-behavioral.test.js's own stale-
    // completion-guard test uses, just with job A failing instead of
    // succeeding late.
    var routeA = null;
    await pageA.route('**/.netlify/functions/video-status*', function (route) {
      var url = decodeURIComponent(route.request().url());
      if (url.indexOf(opA) !== -1) { routeA = route; return; }
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: false }) });
    });
    await safeGoto(pageA, baseUrl + '/login.html');
    await pageA.evaluate(function (o) {
      var handle = '@' + o.username;
      var state = {
        user: { handle: handle, username: o.username },
        accounts: {},
        draft: {},
        dreams: [{
          id: o.dreamId, ownerHandle: handle,
          caption: 'original', storyText: 'original', style: 'Cinematic', mediaType: 'video',
          videoUrl: 'https://example.com/original.mp4', isPublished: false, likes: 0
        }],
        pendingJob: {
          operationName: o.opA, startedAt: Date.now(), caption: 'edit A text', storyText: 'edit A text',
          style: 'Cinematic', sourceDreamId: o.dreamId, mediaType: 'video', notify: false, ownerHandle: handle
        }
      };
      state.accounts[o.username] = { password: 'testpass1', email: o.username + '@example.com' };
      localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    }, { username: 'staleGenfailTester', dreamId: dreamId, opA: opA });
    await safeGoto(pageA, baseUrl + '/result.html?id=' + dreamId);
    await pageA.waitForSelector('#dreamvideo-frame.regenerating', { timeout: 5000 });
    await settle(function () { return routeA !== null; }, { timeout: 5000 });

    // Page B: a second, newer edit of the SAME dream completes normally
    // before job A ever resolves -- takes over the account's single
    // pendingJob slot.
    await pageB.route('**/.netlify/functions/generate-video', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: opB, modelUsed: 'veo3.1-lite' }) });
    });
    await pageB.route('**/.netlify/functions/video-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, videoUrl: 'https://example.com/edit-b.mp4' }) });
    });
    await safeGoto(pageB, baseUrl + '/profile.html');
    var afterB = await pageB.evaluate(function (id) {
      return DreamStore.startDreamEdit(id, { promptText: 'edit B prompt', storyText: 'edit B text', deltaLength: 10 });
    }, dreamId);
    assert.equal(afterB.videoUrl, 'https://example.com/edit-b.mp4', 'sanity: job B (the newer edit) must win');

    // NOW let job A (the superseded, stale first edit) finally FAIL.
    routeA.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, error: 'E205: generation_failed: FAILED' }) });
    await pageA.waitForTimeout(400);

    var callsA = await readPostHogCaptureCalls(pageA);
    var failedCallsA = callsA.filter(function (c) { return c.name === 'generation_failed'; });
    assert.equal(failedCallsA.length, 0, 'a superseded, stale completion\'s late failure must never fire generation_failed -- the newer attempt (job B) already succeeded and is the only real outcome for this dream');
  } finally {
    await context.close();
  }
});

// ===== generation_failed: the E304 "vanish" shape (dream-sync exhausted retries) =====

/** Mocks a generation that completes immediately with a fake video -- same shape as test/private-dream-sync-navigation-race.test.js's own mockGenerationCompletesImmediately. */
function mockGenerationCompletesImmediately(page) {
  return Promise.all([
    page.route('**/.netlify/functions/generate-video', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'fal:fal-ai/veo3.1/fast:vanish-op' }) });
    }),
    page.route('**/.netlify/functions/video-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, videoUrl: 'https://example.com/vanish.mp4' }) });
    }),
    page.route('**/.netlify/functions/mark-generation-completed', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    }),
    page.route('**/.netlify/functions/consume-generation-marker', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ matched: false }) });
    }),
    page.route('**/.netlify/functions/get-feed', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ feed: [], dreamOfDayId: null }) });
    })
  ]);
}

/** Every dream-sync upsert attempt for every id comes back as a genuine server-side 500 -- exhausts attemptPrivateDreamSync's full local retry budget (PRIVATE_DREAM_SYNC_RETRY_DELAYS_MS = [800, 2500, 8000, 20000, 45000], 6 attempts total over ~76.3s -- extended from the original [800, 2500]/3-attempt/~3.3s budget by commit 3ae4fe7, "Harden private-dream sync for the webview/funnel cohort", to give an open page a real chance to ride out a longer transient dream-sync outage instead of giving up after ~3s) every single time. */
function mockDreamSyncAlwaysFails(page) {
  var upsertCallsById = {};
  page.route('**/.netlify/functions/dream-sync*', function (route) {
    var req = route.request();
    if (req.method() === 'GET') {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, dreams: [] }) });
      return;
    }
    var body = JSON.parse(req.postData());
    var id = body.dream && body.dream.id;
    if (id) upsertCallsById[id] = (upsertCallsById[id] || 0) + 1;
    route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'E8: sync_write_failed' }) });
  });
  return upsertCallsById;
}

async function seedAccountWithDraft(page, opts) {
  await safeGoto(page, baseUrl + '/login.html');
  await page.evaluate(function (o) {
    var state = {
      user: { handle: '@' + o.username, username: o.username, authToken: o.authToken },
      accounts: {},
      dreams: [],
      pendingJob: null,
      charactersByUser: {},
      likedIds: {},
      blockedByUser: {},
      draft: { caption: 'A dream that will vanish', storyText: 'A dream that will vanish', style: 'Realistic', mediaType: 'video', sourceDreamId: null, restore: false, characterIds: [], cameraView: null, sceneryTime: null, sceneryPlace: null, sourceImageUrl: null, audioOn: false, musicStyle: null }
    };
    state.accounts[o.username] = { password: 'testpass1', email: o.email || null };
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    localStorage.setItem('dreamtube_feed_backfill_v1_done', '1');
  }, opts);
}

test('generation_failed: fires reason:\'E304: dream_sync_unconfirmed\' once a completed generation\'s dream-sync retries are fully exhausted (the P0 "vanish" bug\'s own observable shape)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockGenerationCompletesImmediately(page);
    var upsertCallsById = mockDreamSyncAlwaysFails(page);

    await seedAccountWithDraft(page, { username: 'vanishuser', email: 'vanishuser@example.com', authToken: 'real-vanish-token' });
    await safeGoto(page, baseUrl + '/home.html?generate=1');
    await page.waitForSelector('#d0-video.ready', { timeout: 8000 });

    var localDream = await page.evaluate(function () { return window.DreamStore.getMyDreams()[0]; });
    assert.equal(localDream.caption, 'A dream that will vanish', 'sanity: the dream itself was created locally -- generation genuinely succeeded, only its sync is failing');

    // Wait out the full local retry budget (800ms + 2500ms + 8000ms +
    // 20000ms + 45000ms scheduled delays = ~76.3s, plus the 6 real network
    // round trips themselves -- see PRIVATE_DREAM_SYNC_RETRY_DELAYS_MS in
    // js/store.js) for this dream's id specifically.
    var exhausted = await settle(function () {
      return (upsertCallsById[localDream.id] || 0) >= 6;
    }, { timeout: 85000, interval: 100 });
    assert.ok(exhausted, 'expected all 6 upsert attempts to have been made');
    // Give the final failed attempt's own .then/.catch a moment to run the
    // give-up branch and fire the event.
    await page.waitForTimeout(300);

    var confirmedLocally = await page.evaluate(function (id) {
      var d = window.DreamStore.getMyDreams().find(function (x) { return x.id === id; });
      return d && d.syncConfirmed;
    }, localDream.id);
    assert.equal(confirmedLocally, false, 'sanity: this dream must genuinely still be unconfirmed -- every upsert attempt failed');

    var calls = await readPostHogCaptureCalls(page);
    var failedCalls = calls.filter(function (c) { return c.name === 'generation_failed' && c.props.reason === 'E304: dream_sync_unconfirmed'; });
    assert.equal(failedCalls.length, 1, 'expected exactly one E304 generation_failed capture once the local retry budget is exhausted');
    assert.equal(failedCalls[0].props.mediaType, 'video');
    assert.equal(typeof failedCalls[0].props.elapsed_ms, 'number');
    assert.ok(failedCalls[0].props.elapsed_ms >= 0);
    assert.equal(failedCalls[0].props.dreamId, localDream.id, 'the E304 fire must carry the specific dream\'s id, so repeated fires against the same still-unconfirmed dream can be deduped downstream to a true distinct-dream count');
  } finally {
    await context.close();
  }
});
