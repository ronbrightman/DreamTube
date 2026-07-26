// test/first-video-created-explore-resume-behavioral.test.js
//
// Regression coverage for tracker.html's
// for-product-make-firstvideocreated-relia-5i9o0t: explore.html's
// resume-completion path (a generation left running when the user
// navigated away from processing.html, picked back up via
// DreamStore.resumePendingJob() and finished right here instead --
// see the "Your dream is ready!" toast) used to finish a user's dream
// WITHOUT ever routing them through result.html, so the
// FirstVideoCreated conversion event (Meta Pixel + CAPI + PostHog) never
// fired for that account at all -- and, because
// DreamStore.markFirstVideoCreatedIfEligible() gates on the account
// having EXACTLY ONE completed dream, that account could never get a
// second chance: by the time a 2nd video existed, the eligibility check
// would correctly (but permanently) decline to fire retroactively for
// the 1st.
//
// The fix: explore.html now calls the same
// markFirstVideoCreatedIfEligible + fireMetaConversion/track pairing
// result.html already used, from resumePendingJob().then() (see
// explore.html's fireFirstVideoCreatedIfEligible()). This file proves:
//   1. a pending job that completes on explore.html fires FirstVideoCreated
//      exactly once, on all three vendors, for a brand-new account's
//      genuine first video.
//   2. hitting BOTH landing paths for what should count as one "first"
//      video (explore.html's resume path fires it, then the user later
//      opens result.html for that same now-not-actually-fresh dream) does
//      not double-fire -- the shared account-level flag in js/store.js
//      is the single source of truth, same as
//      test/first-video-created-behavioral.test.js's own "flag persists"
//      case for the result.html-only path.
//   3. an account's SECOND completed dream resuming on explore.html does
//      not fire the event (mirrors test/first-video-created-behavioral.test.js's
//      equivalent result.html case).
//
// result.html's own existing behavior (fire-once, no regression from this
// change) is covered by test/first-video-created-behavioral.test.js,
// unmodified by this work -- re-run alongside this file for full coverage.
//
// Follows test/first-video-created-behavioral.test.js's and
// test/logout-clears-pendingjob-behavioral.test.js's conventions:
// installFbqRecorder/captureTrackConversion/readPostHogCaptureCalls for
// the three vendors, and a seeded pendingJob + a mocked video-status.js
// route (no real fal.ai call -- this is pure plumbing/analytics
// verification, not generation-quality verification, so mocking is the
// correct default per AGENT_POLICY.md's "keep generation-testing cost
// low" section, not just the cheaper option).

var test = require('node:test');
var assert = require('node:assert/strict');
var staticServer = require('./helpers/static-server');

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

/** Aborts requests to third-party hosts every page here loads (fonts, PostHog, Meta Pixel's real CDN script) -- see CLAUDE.md on this sandbox's outbound network. fbq/posthog stubs still work after this -- see meta-capi-behavioral.test.js's own comment on the same helper. */
function blockThirdParty(page) {
  return page.route(/fonts\.(googleapis|gstatic)\.com|connect\.facebook\.net|i\.posthog\.com/, function (route) {
    route.abort();
  });
}

/** Same recorder as test/meta-capi-behavioral.test.js / test/first-video-created-behavioral.test.js -- must be installed on the context before any page.goto(). */
async function installFbqRecorder(context) {
  var calls = [];
  await context.exposeBinding('__recordFbqCall', function (source, args) {
    calls.push(args);
  });
  await context.addInitScript(function () {
    var wrapped = null;
    Object.defineProperty(window, 'fbq', {
      configurable: true,
      get: function () { return wrapped; },
      set: function (fn) {
        wrapped = function () {
          try { window.__recordFbqCall(Array.prototype.slice.call(arguments)); } catch (e) { /* recording must never break the real fbq call below */ }
          return fn.apply(this, arguments);
        };
      }
    });
  });
  return calls;
}

/** Intercepts every POST to track-conversion, recording each parsed body and fulfilling with a 200 success response. */
function captureTrackConversion(page) {
  var calls = [];
  return page.route('**/.netlify/functions/track-conversion', function (route) {
    var body = null;
    try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) { /* leave null */ }
    calls.push(body);
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
  }).then(function () { return calls; });
}

/** Reads every posthog.capture(name, props) call made during this page load straight out of the PostHog stub's own pending-call queue -- see test/first-video-created-behavioral.test.js's file header for why this is more reliable here than a monkeypatch. */
function readPostHogCaptureCalls(page) {
  return page.evaluate(function () {
    var queue = (window.posthog && typeof window.posthog.slice === 'function') ? window.posthog.slice() : [];
    return queue.filter(function (entry) { return entry[0] === 'capture'; }).map(function (entry) { return { name: entry[1], props: entry[2] }; });
  });
}

function fbqTrackCustomCalls(fbqCalls, eventName) {
  return fbqCalls.filter(function (args) { return args[0] === 'trackCustom' && args[1] === eventName; });
}

/** Intercepts video-status.js so DreamStore.resumePendingJob()'s poll resolves immediately with a fake finished video, with no real fal.ai call. */
function mockVideoStatusDone(page, videoUrl) {
  return page.route('**/.netlify/functions/video-status*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, videoUrl: videoUrl || 'https://example.com/fake-resumed-video.mp4' }) });
  });
}

/** Empty shared feed -- explore.html's loadFeed() call is incidental to this file's actual subject (the resume-completion analytics firing), so it's given a clean, fast-resolving response rather than left to 404 against the static test server. */
function mockEmptyFeed(page) {
  return page.route('**/.netlify/functions/get-feed', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ feed: [], dreamOfDayId: null }) });
  });
}

/**
 * Seeds localStorage as if `username` is logged in, with however many of
 * their own already-completed dreams the test needs (mirrors
 * test/first-video-created-behavioral.test.js's seedAccount), PLUS a real
 * in-flight pendingJob for THIS SAME account (mirrors
 * test/logout-clears-pendingjob-behavioral.test.js's
 * seedLoggedInWithPendingJob shape) that explore.html's
 * DreamStore.resumePendingJob() call will pick up and resume on load.
 */
async function seedAccountWithPendingJob(page, opts) {
  await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function (o) {
    var handle = '@' + o.username;
    var state = {
      user: { handle: handle, username: o.username },
      accounts: {},
      draft: { caption: '', style: null, sourceDreamId: null, restore: false, characterIds: [], cameraView: null, sceneryTime: null, sceneryPlace: null, mediaType: null, sourceImageUrl: null },
      dreams: [],
      pendingJob: {
        operationName: 'mock:req-' + o.username,
        startedAt: Date.now(),
        caption: 'a dream in flight',
        style: o.pendingStyle || 'Cinematic',
        sourceDreamId: null,
        mediaType: 'video',
        notify: false,
        ownerHandle: handle
      },
      charactersByUser: {},
      likedIds: {}
    };
    state.accounts[o.username] = { password: 'testpass1', email: o.email || null };
    if (o.firstVideoCreatedFired) state.accounts[o.username].firstVideoCreatedFired = true;
    (o.dreams || []).forEach(function (d) {
      state.dreams.push(Object.assign({
        ownerHandle: handle,
        caption: 'A test dream',
        style: 'Cinematic',
        videoUrl: 'https://example.com/fake-video.mp4',
        isPublished: false,
        likes: 0, likedByMe: false, dur: '0:08'
      }, d));
    });
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, opts);
}

/** Sets the "just generated" sessionStorage marker result.html looks for -- same key processing.html writes right before its redirect. */
function markJustGenerated(page, dreamId) {
  return page.evaluate(function (id) {
    sessionStorage.setItem('dreamtube_just_generated_id', id);
  }, dreamId);
}

test('explore.html: a brand-new account whose ONLY pending job completes via the resume-completion path fires FirstVideoCreated exactly once, on all three vendors', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var fbqCalls = await installFbqRecorder(context);
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockEmptyFeed(page);
    await mockVideoStatusDone(page);
    var conversionCalls = await captureTrackConversion(page);

    // No completed dreams yet -- the in-flight pendingJob (seeded below)
    // will become this account's first-ever completed dream the moment
    // it resolves on explore.html.
    await seedAccountWithPendingJob(page, {
      username: 'exploreresumeuser',
      email: 'explore-resume@example.com',
      pendingStyle: 'Cinematic',
      dreams: []
    });

    await page.goto(baseUrl + '/explore.html', { waitUntil: 'domcontentloaded' });
    // resumePendingJob() polls video-status once (mocked to resolve
    // 'done' immediately) then runs finalizeDream + the toast + the
    // analytics call -- give the promise chain a moment to settle before
    // asserting, same margin test/first-video-created-behavioral.test.js
    // gives fireMetaConversion's fire-and-forget CAPI POST.
    await page.waitForTimeout(500);

    var trackCustomCalls = fbqTrackCustomCalls(fbqCalls, 'FirstVideoCreated');
    assert.equal(trackCustomCalls.length, 1, 'expected exactly one fbq trackCustom FirstVideoCreated call from the resume-completion path');
    var eventId = trackCustomCalls[0][3] && trackCustomCalls[0][3].eventID;
    assert.ok(eventId, 'the trackCustom call should carry an eventID');

    var firstVideoConversions = conversionCalls.filter(function (body) { return body && body.event_name === 'FirstVideoCreated'; });
    assert.equal(firstVideoConversions.length, 1, 'expected exactly one FirstVideoCreated POST to track-conversion');
    assert.equal(firstVideoConversions[0].event_id, eventId, 'track-conversion event_id must match the fbq trackCustom call\'s eventID, so Meta can dedupe them');
    assert.equal(firstVideoConversions[0].email, 'explore-resume@example.com');
    assert.deepEqual(firstVideoConversions[0].custom_data, { style: 'Cinematic' }, 'style is sent, never the dream caption');

    var phCalls = await readPostHogCaptureCalls(page);
    var firstVideoPhCalls = phCalls.filter(function (c) { return c.name === 'first_video_created'; });
    assert.equal(firstVideoPhCalls.length, 1, 'expected exactly one posthog.capture(\'first_video_created\', ...) call');
    assert.equal(firstVideoPhCalls[0].props.style, 'Cinematic');

    // Sanity check: the account really did gain the flag (this is the
    // same guard result.html's own path relies on), so a later, unrelated
    // page load can't accidentally re-fire it.
    var flagSet = await page.evaluate(function () {
      var state = JSON.parse(localStorage.getItem('dreamtube_state_v1'));
      return !!(state.accounts['exploreresumeuser'] && state.accounts['exploreresumeuser'].firstVideoCreatedFired);
    });
    assert.equal(flagSet, true, 'markFirstVideoCreatedIfEligible should have persisted the account-level flag');
  } finally {
    await context.close();
  }
});

test('explore.html: an account\'s SECOND completed dream resuming on explore.html never fires FirstVideoCreated', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var fbqCalls = await installFbqRecorder(context);
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockEmptyFeed(page);
    await mockVideoStatusDone(page);
    var conversionCalls = await captureTrackConversion(page);

    // Already has one completed dream -- the pendingJob resolving here is
    // this account's SECOND video, not its first.
    await seedAccountWithPendingJob(page, {
      username: 'exploreresumesecond',
      email: 'explore-resume-second@example.com',
      dreams: [{ id: 'dream-existing-1' }]
    });

    await page.goto(baseUrl + '/explore.html', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);

    assert.equal(fbqTrackCustomCalls(fbqCalls, 'FirstVideoCreated').length, 0, 'a 2nd completed dream resuming on explore.html must never fire the Pixel event');
    assert.equal(conversionCalls.filter(function (b) { return b && b.event_name === 'FirstVideoCreated'; }).length, 0, 'a 2nd completed dream resuming on explore.html must never POST FirstVideoCreated to track-conversion');
    var phCalls = await readPostHogCaptureCalls(page);
    assert.equal(phCalls.filter(function (c) { return c.name === 'first_video_created'; }).length, 0, 'a 2nd completed dream resuming on explore.html must never fire the PostHog event either');
  } finally {
    await context.close();
  }
});

test('cross-path: an account whose first video completes via explore.html\'s resume path, then later opens result.html for that same dream, does not double-fire FirstVideoCreated', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var fbqCalls = await installFbqRecorder(context);
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockEmptyFeed(page);
    await mockVideoStatusDone(page);
    var conversionCalls = await captureTrackConversion(page);

    await seedAccountWithPendingJob(page, {
      username: 'crosspathuser',
      email: 'cross-path@example.com',
      dreams: []
    });

    // Leg 1: the pending job completes on explore.html -- this is the
    // account's genuine first-ever video, so this must fire the event
    // (same assertion as the first test above, kept lighter here since
    // the full shape is already covered there).
    await page.goto(baseUrl + '/explore.html', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);
    assert.equal(fbqTrackCustomCalls(fbqCalls, 'FirstVideoCreated').length, 1, 'leg 1 (explore.html resume) should have fired FirstVideoCreated once');

    // Find the dream id explore.html's resume just created, so leg 2 can
    // revisit result.html for that SAME dream, exactly as if the user had
    // tapped into it from their own feed/profile afterwards.
    var dreamId = await page.evaluate(function () {
      var state = JSON.parse(localStorage.getItem('dreamtube_state_v1'));
      var mine = state.dreams.filter(function (d) { return d.ownerHandle === '@crosspathuser'; });
      return mine.length ? mine[0].id : null;
    });
    assert.ok(dreamId, 'sanity check: the resumed job should have produced a real completed dream');

    // Leg 2: the user later opens result.html for that same dream. The
    // "just generated" sessionStorage marker IS set here, deliberately --
    // this test exists to prove the shared account-level
    // markFirstVideoCreatedIfEligible flag (set by leg 1) is what blocks
    // the re-fire, not result.html's separate, unrelated sessionStorage
    // guard. Without setting this marker, result.html's own guard would
    // return early before ever reaching markFirstVideoCreatedIfEligible,
    // and the "no double-fire" assertion below would pass for the wrong
    // reason -- it would stop catching a real regression in the
    // account-level flag's own cross-path sufficiency. Passing the
    // sessionStorage guard through to the eligibility check is exactly
    // what makes this a genuine test of that flag.
    await markJustGenerated(page, dreamId);
    await page.goto(baseUrl + '/result.html?id=' + dreamId, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);

    assert.equal(fbqTrackCustomCalls(fbqCalls, 'FirstVideoCreated').length, 1, 'visiting result.html afterwards for the same already-counted dream must not add a second fbq trackCustom call, even past the sessionStorage guard');
    assert.equal(conversionCalls.filter(function (b) { return b && b.event_name === 'FirstVideoCreated'; }).length, 1, 'visiting result.html afterwards for the same already-counted dream must not add a second CAPI POST, even past the sessionStorage guard');
  } finally {
    await context.close();
  }
});
