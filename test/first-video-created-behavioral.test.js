// test/first-video-created-behavioral.test.js
//
// Real browser-driven coverage for the "first video created" conversion
// event added alongside docs/EVENT_TAXONOMY.md — result.html's fire-once
// call site, js/store.js's markFirstVideoCreatedIfEligible() guard, and
// js/analytics-config.js's fireMetaConversion(..., custom: true) branch
// (fbq('trackCustom', ...) instead of fbq('track', ...)). The server-side
// half (track-conversion.js accepting 'FirstVideoCreated') has direct
// unit coverage in test/meta-capi.test.js; this file exists specifically
// to prove the real page fires the right calls at the right moment, and
// — just as important — does NOT fire them on a reload of the same first
// video, on a second/third video, or on an ordinary revisit of a
// pre-existing dream from before this feature shipped. Follows
// test/meta-capi-behavioral.test.js's installFbqRecorder/
// captureTrackConversion pattern.
//
// PostHog assertion note: the firing IIFE runs synchronously as part of
// result.html's own inline <script>, which finishes executing before
// page.goto's 'domcontentloaded' resolves — there is no later event (like
// a button click, the way test/ui-behavioral.test.js's pricing-screen
// test has one) to wait for before installing a page.evaluate()
// monkeypatch on posthog.capture, so a post-navigation wrap would always
// miss the very call this suite needs to observe. Instead this reads
// window.posthog directly: PostHog's own inline stub snippet (every
// page's <head>) makes window.posthog literally BE the pending-call queue
// array (each capture()/identify()/etc. call is `array.push([name, ...])`
// onto itself) until the real array.js bundle loads and drains it — which
// never happens here since blockThirdParty() aborts that request. So the
// queue is directly, reliably inspectable after page.goto resolves, no
// monkeypatching required.
//
// No real generation call anywhere in this file — state is seeded
// directly into localStorage (the same shortcut
// test/ui-behavioral.test.js's seedResultPage helper already uses for
// result.html), both the cheapest way to verify this (see
// AGENT_POLICY.md's "keep generation-testing cost low" section) and the
// only practical way to construct "this account already has N completed
// dreams" preconditions without actually running N real/mocked
// generations.
//
// "Just generated" marker note (2026-07-27 update, tracker.html's
// result-htmls-firstvideocreated-still-dep-qfg48t): result.html's guard #1
// used to be a synchronous sessionStorage read/consume; it's now an async
// POST to /.netlify/functions/consume-generation-marker, keyed by the
// dream's own `sourceOperationName` field, NOT its dreamId (a review
// finding -- dream ids are already public elsewhere in this app, so
// keying the marker on them let an unauthenticated caller plant one for
// any dreamId they merely knew/guessed; operationName is server-issued
// and never exposed anywhere in the UI -- see js/store.js's
// wasOperationJustCompleted and finalizeDream doc comments, and
// netlify/functions/lib/generation-completion-store.js's header comment,
// for the full mechanics). seedAccount below stamps a deterministic
// `sourceOperationName` ('op-for-' + the dream's id) onto every seeded
// dream unless a test overrides it. mockConsumeMarker mocks the
// consume-generation-marker route instead of writing to sessionStorage
// directly, returning `matched: true` only for the operationName the test
// wants to simulate as freshly completed — passing `null` returns
// `matched: false`, simulating "no durable marker was ever set for this
// dream" (an ordinary revisit).

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

/** Same recorder as test/meta-capi-behavioral.test.js -- must be installed on the context before any page.goto(). */
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

/** Reads every posthog.capture(name, props) call made during this page load straight out of the PostHog stub's own pending-call queue -- see the file header comment for why this is more reliable here than a monkeypatch. */
function readPostHogCaptureCalls(page) {
  return page.evaluate(function () {
    var queue = (window.posthog && typeof window.posthog.slice === 'function') ? window.posthog.slice() : [];
    return queue.filter(function (entry) { return entry[0] === 'capture'; }).map(function (entry) { return { name: entry[1], props: entry[2] }; });
  });
}

/** Seeds localStorage with a logged-in account and however many of its own completed dreams the test needs, mirroring test/ui-behavioral.test.js's seedResultPage shape. `firstVideoCreatedFired` lets a test simulate an account that already consumed its one-time flag. Every seeded dream gets a deterministic `sourceOperationName` ('op-for-' + its id) unless the test overrides it (e.g. `sourceOperationName: null` to simulate a legacy dream from before this field existed). */
async function seedAccount(page, opts) {
  await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function (o) {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@' + o.username, username: o.username };
    if (!state.accounts) state.accounts = {};
    state.accounts[o.username] = { password: 'testpass1', email: o.email || null };
    if (o.firstVideoCreatedFired) state.accounts[o.username].firstVideoCreatedFired = true;
    if (!state.dreams) state.dreams = [];
    (o.dreams || []).forEach(function (d) {
      var merged = Object.assign({
        ownerHandle: '@' + o.username,
        caption: 'A test dream',
        style: 'Cinematic',
        videoUrl: 'https://example.com/fake-video.mp4',
        isPublished: false,
        likes: 0, likedByMe: false, dur: '0:08'
      }, d);
      if (merged.sourceOperationName === undefined) merged.sourceOperationName = 'op-for-' + merged.id;
      state.dreams.push(merged);
    });
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, opts);
}

/**
 * Mocks POST /.netlify/functions/consume-generation-marker -- the durable,
 * server-side replacement for the old sessionStorage
 * `dreamtube_just_generated_id` marker (see file header comment).
 * Fulfills `matched: true` exactly ONCE, only for a request whose
 * `operationName` equals `justCompletedOperationName` -- every call after
 * that first match (a reload, or any other request) gets `matched: false`,
 * the same exactly-once consumption the real consume-generation-marker.js/
 * generation-completion-store.js enforce server-side (see
 * test/generation-completion-marker.test.js for direct unit coverage of
 * that). Pass `null` to always return `matched: false`, simulating "no
 * durable marker was ever set for this dream" -- an ordinary revisit.
 * Must be installed before the page.goto to result.html, since the check
 * runs as part of that page's own inline script on load.
 */
function mockConsumeMarker(page, justCompletedOperationName) {
  var consumed = false;
  return page.route('**/.netlify/functions/consume-generation-marker', function (route) {
    var body = null;
    try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) { /* leave null */ }
    var matched = !consumed && !!(justCompletedOperationName && body && body.operationName === justCompletedOperationName);
    if (matched) consumed = true;
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ matched: matched }) });
  });
}

function fbqTrackCustomCalls(fbqCalls, eventName) {
  return fbqCalls.filter(function (args) { return args[0] === 'trackCustom' && args[1] === eventName; });
}

test('result.html: a brand-new account\'s first-ever completed dream, opened fresh off processing.html, fires FirstVideoCreated on all three vendors exactly once, and a reload does not re-fire it', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var fbqCalls = await installFbqRecorder(context);
    var page = await context.newPage();
    await blockThirdParty(page);
    var conversionCalls = await captureTrackConversion(page);

    await seedAccount(page, {
      username: 'freshuser',
      email: 'fresh@example.com',
      dreams: [{ id: 'dream-first-1' }]
    });
    await mockConsumeMarker(page, 'op-for-dream-first-1');

    await page.goto(baseUrl + '/result.html?id=dream-first-1', { waitUntil: 'domcontentloaded' });
    // fireMetaConversion's CAPI POST is fire-and-forget (js/analytics-config.js
    // never awaits it) -- give it a moment to actually land on the intercepted
    // route before asserting on conversionCalls below.
    await page.waitForTimeout(300);

    var trackCustomCalls = fbqTrackCustomCalls(fbqCalls, 'FirstVideoCreated');
    assert.equal(trackCustomCalls.length, 1, 'expected exactly one fbq trackCustom FirstVideoCreated call');
    var eventId = trackCustomCalls[0][3] && trackCustomCalls[0][3].eventID;
    assert.ok(eventId, 'the trackCustom call should carry an eventID');

    var firstVideoConversions = conversionCalls.filter(function (body) { return body && body.event_name === 'FirstVideoCreated'; });
    assert.equal(firstVideoConversions.length, 1, 'expected exactly one FirstVideoCreated POST to track-conversion');
    assert.equal(firstVideoConversions[0].event_id, eventId, 'track-conversion event_id must match the fbq trackCustom call\'s eventID, so Meta can dedupe them');
    assert.equal(firstVideoConversions[0].email, 'fresh@example.com');
    assert.deepEqual(firstVideoConversions[0].custom_data, { style: 'Cinematic' }, 'style is sent, never the dream caption');

    var phCalls = await readPostHogCaptureCalls(page);
    var firstVideoPhCalls = phCalls.filter(function (c) { return c.name === 'first_video_created'; });
    assert.equal(firstVideoPhCalls.length, 1, 'expected exactly one posthog.capture(\'first_video_created\', ...) call');
    assert.equal(firstVideoPhCalls[0].props.style, 'Cinematic');

    // Reloading the same result.html page afterwards: the durable marker
    // was already consumed on first load, so this must not re-fire
    // on any vendor even though the dream count is still 1.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(300);
    assert.equal(fbqTrackCustomCalls(fbqCalls, 'FirstVideoCreated').length, 1, 'a reload of the same first video must not re-fire the Pixel event');
    assert.equal(conversionCalls.filter(function (b) { return b && b.event_name === 'FirstVideoCreated'; }).length, 1, 'a reload of the same first video must not re-fire the CAPI event');
    var phCallsAfterReload = await readPostHogCaptureCalls(page);
    assert.equal(phCallsAfterReload.filter(function (c) { return c.name === 'first_video_created'; }).length, 0, 'a reload gets a fresh PostHog queue (new page load) and must not queue a new first_video_created call either');
  } finally {
    await context.close();
  }
});

test('result.html: an account\'s second completed dream never fires FirstVideoCreated, even with a fresh "just generated" marker', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var fbqCalls = await installFbqRecorder(context);
    var page = await context.newPage();
    await blockThirdParty(page);
    var conversionCalls = await captureTrackConversion(page);

    // Two completed dreams already on the account -- this is not a
    // first-ever video no matter which one the marker points at.
    await seedAccount(page, {
      username: 'seconduser',
      email: 'second@example.com',
      dreams: [{ id: 'dream-second-1' }, { id: 'dream-second-2' }]
    });
    await mockConsumeMarker(page, 'op-for-dream-second-2');

    await page.goto(baseUrl + '/result.html?id=dream-second-2', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(300);

    assert.equal(fbqTrackCustomCalls(fbqCalls, 'FirstVideoCreated').length, 0, 'a 2nd/Nth dream must never fire the Pixel FirstVideoCreated event');
    assert.equal(conversionCalls.filter(function (b) { return b && b.event_name === 'FirstVideoCreated'; }).length, 0, 'a 2nd/Nth dream must never POST FirstVideoCreated to track-conversion');
    var phCalls = await readPostHogCaptureCalls(page);
    assert.equal(phCalls.filter(function (c) { return c.name === 'first_video_created'; }).length, 0, 'a 2nd/Nth dream must never fire the PostHog event either');
  } finally {
    await context.close();
  }
});

test('result.html: a pre-existing single-dream account (predates this feature) revisited with no "just generated" marker does not fire FirstVideoCreated', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var fbqCalls = await installFbqRecorder(context);
    var page = await context.newPage();
    await blockThirdParty(page);
    var conversionCalls = await captureTrackConversion(page);

    // firstVideoCreatedFired is deliberately left unset here -- this
    // simulates a real pre-existing account from before this feature
    // shipped, which never had the chance to set that flag. Without the
    // durable-marker guard, this dream-count-1 + flag-unset combination
    // would look identical to a genuine first-time completion.
    await seedAccount(page, {
      username: 'legacyresultuser',
      email: 'legacy-result@example.com',
      dreams: [{ id: 'dream-legacy-1' }]
    });
    // matched:false for everything -- an ordinary revisit, not a fresh
    // redirect from processing.html.
    await mockConsumeMarker(page, null);

    await page.goto(baseUrl + '/result.html?id=dream-legacy-1', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(300);

    assert.equal(fbqTrackCustomCalls(fbqCalls, 'FirstVideoCreated').length, 0, 'an ordinary revisit of a pre-existing single dream must not fire the Pixel event');
    assert.equal(conversionCalls.filter(function (b) { return b && b.event_name === 'FirstVideoCreated'; }).length, 0, 'an ordinary revisit of a pre-existing single dream must not POST to track-conversion');
    var phCalls = await readPostHogCaptureCalls(page);
    assert.equal(phCalls.filter(function (c) { return c.name === 'first_video_created'; }).length, 0, 'an ordinary revisit of a pre-existing single dream must not fire the PostHog event either');
  } finally {
    await context.close();
  }
});

test('result.html: the account-level flag persists -- once fired, a brand-new dream added later (making it the 2nd overall) still does not re-fire even with a fresh marker', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var fbqCalls = await installFbqRecorder(context);
    var page = await context.newPage();
    await blockThirdParty(page);
    var conversionCalls = await captureTrackConversion(page);

    await seedAccount(page, {
      username: 'firedalreadyuser',
      email: 'fired-already@example.com',
      firstVideoCreatedFired: true,
      dreams: [{ id: 'dream-fired-1' }, { id: 'dream-fired-2' }]
    });
    await mockConsumeMarker(page, 'op-for-dream-fired-2');

    await page.goto(baseUrl + '/result.html?id=dream-fired-2', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(300);

    assert.equal(fbqTrackCustomCalls(fbqCalls, 'FirstVideoCreated').length, 0, 'the flag being already set must block firing regardless of the marker');
    assert.equal(conversionCalls.filter(function (b) { return b && b.event_name === 'FirstVideoCreated'; }).length, 0);
  } finally {
    await context.close();
  }
});

// ===== PostHog sanity-check event: first_video_result_view =====
// tracker.html's result-htmls-firstvideocreated-still-dep-qfg48t item --
// "add a PostHog sanity check comparing FirstVideoCreated count vs
// first-video result.html views so the undercount visibly closes." This
// event is independent of BOTH FirstVideoCreated guards (the durable
// marker AND the fire-once account flag) -- it fires whenever the render
// looks like the account's only completed video, whether or not the
// conversion event itself actually fires.

test('result.html: fires the first_video_result_view PostHog sanity-check event on a fresh first-video render, alongside first_video_created', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var fbqCalls = await installFbqRecorder(context);
    var page = await context.newPage();
    await blockThirdParty(page);
    await captureTrackConversion(page);

    await seedAccount(page, {
      username: 'sanitycheckuser',
      email: 'sanity@example.com',
      dreams: [{ id: 'dream-sanity-1' }]
    });
    await mockConsumeMarker(page, 'op-for-dream-sanity-1');

    await page.goto(baseUrl + '/result.html?id=dream-sanity-1', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(300);

    var phCalls = await readPostHogCaptureCalls(page);
    var viewCalls = phCalls.filter(function (c) { return c.name === 'first_video_result_view'; });
    assert.equal(viewCalls.length, 1, 'expected exactly one posthog.capture(\'first_video_result_view\', ...) call');
    assert.equal(viewCalls[0].props.style, 'Cinematic');
    assert.equal(phCalls.filter(function (c) { return c.name === 'first_video_created'; }).length, 1, 'the real KPI event should also have fired on this genuinely fresh completion');
  } finally {
    await context.close();
  }
});

test('result.html: fires first_video_result_view on an ORDINARY REVISIT of a pre-existing single dream too -- unlike first_video_created, this sanity-check signal is not gated on the durable marker or the fire-once flag', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var fbqCalls = await installFbqRecorder(context);
    var page = await context.newPage();
    await blockThirdParty(page);
    await captureTrackConversion(page);

    await seedAccount(page, {
      username: 'sanitycheckrevisituser',
      email: 'sanity-revisit@example.com',
      dreams: [{ id: 'dream-sanity-revisit-1' }]
    });
    // No durable marker set -- an ordinary revisit, exactly like the
    // "pre-existing single-dream account" test above.
    await mockConsumeMarker(page, null);

    await page.goto(baseUrl + '/result.html?id=dream-sanity-revisit-1', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(300);

    var phCalls = await readPostHogCaptureCalls(page);
    assert.equal(phCalls.filter(function (c) { return c.name === 'first_video_result_view'; }).length, 1, 'the sanity-check view event should still fire even without a durable "just completed" marker -- it measures VIEWS, not conversions');
    assert.equal(phCalls.filter(function (c) { return c.name === 'first_video_created'; }).length, 0, 'the real KPI event must still correctly NOT fire for this ordinary revisit');
    assert.equal(fbqTrackCustomCalls(fbqCalls, 'FirstVideoCreated').length, 0);
  } finally {
    await context.close();
  }
});

test('result.html: does NOT fire first_video_result_view for an account\'s 2nd/Nth completed dream', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await installFbqRecorder(context);
    var page = await context.newPage();
    await blockThirdParty(page);
    await captureTrackConversion(page);

    await seedAccount(page, {
      username: 'sanitycheckseconduser',
      email: 'sanity-second@example.com',
      dreams: [{ id: 'dream-sanity-2a' }, { id: 'dream-sanity-2b' }]
    });
    await mockConsumeMarker(page, 'op-for-dream-sanity-2b');

    await page.goto(baseUrl + '/result.html?id=dream-sanity-2b', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(300);

    var phCalls = await readPostHogCaptureCalls(page);
    assert.equal(phCalls.filter(function (c) { return c.name === 'first_video_result_view'; }).length, 0, 'an account with more than one completed dream is not a "first video" view, regardless of which dream is open');
  } finally {
    await context.close();
  }
});

// ===== End-to-end: the REAL processing.html -> result.html redirect flow =====
// Every test above seeds state directly and jumps straight to result.html
// (the cheapest way to exercise its own guard logic in isolation, per this
// file's header comment). This test instead drives the actual page flow
// the durable marker exists to survive: processing.html's
// attachTaskHandlers calls DreamStore.markGenerationJustCompleted(dream.sourceOperationName)
// (POSTing to mark-generation-completed), then redirects to
// result.html?id=..., which reads that same dream's sourceOperationName
// back off localStorage and calls
// DreamStore.wasOperationJustCompleted(dream.sourceOperationName)
// (POSTing to consume-generation-marker) before firing. No real fal.ai
// call (generate-video/video-status are mocked to complete immediately,
// per AGENT_POLICY.md's "keep generation-testing cost low" section) --
// this is pure plumbing verification, not generation-quality verification.
// This test mocks the mark/consume ROUTES directly (like every test
// above), so it does NOT exercise mark-generation-completed.js's own
// verifyOperationCompleted logic -- that's covered by
// test/generation-completion-marker.test.js's unit tests instead.

/** Mocks a generation that completes immediately with a fake video, and captures the operationName processing.html's mark-generation-completed call carries -- reused by consume-generation-marker's own mock below so the two endpoints agree on the same operationName, exactly like the real operationName-keyed Blobs store would. */
function mockGenerationCompletesImmediately(page) {
  var state = { markedOperationName: null, consumedOnce: false };
  return Promise.all([
    page.route('**/.netlify/functions/generate-video', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'fal:fal-ai/veo3.1/fast:test-op' }) });
    }),
    page.route('**/.netlify/functions/video-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, videoUrl: 'https://example.com/fake-e2e-video.mp4' }) });
    }),
    page.route('**/.netlify/functions/mark-generation-completed', function (route) {
      var body = null;
      try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) { /* leave null */ }
      if (body && body.operationName) state.markedOperationName = body.operationName;
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    }),
    page.route('**/.netlify/functions/consume-generation-marker', function (route) {
      var body = null;
      try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) { /* leave null */ }
      var matched = !state.consumedOnce && !!state.markedOperationName && !!body && body.operationName === state.markedOperationName;
      if (matched) state.consumedOnce = true;
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ matched: matched }) });
    }),
    page.route('**/.netlify/functions/get-feed', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ feed: [], dreamOfDayId: null }) });
    })
  ]).then(function () { return state; });
}

/** Seeds a logged-in account with a caption+style draft and no completed dreams yet, landing on processing.html's normal fresh-generation path -- mirrors test/wait-screen-reassurance-and-inapp-nudge-behavioral.test.js's seedAccountWithDraft. */
async function seedAccountWithDraft(page, opts) {
  await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function (o) {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@' + o.username, username: o.username };
    if (!state.accounts) state.accounts = {};
    state.accounts[o.username] = { password: 'testpass1', email: o.email || null };
    if (!state.dreams) state.dreams = [];
    state.draft = { caption: 'A dream about flying over the city', style: 'Cinematic', mediaType: 'video', sourceDreamId: null, restore: false, characterIds: [], cameraView: null, sceneryTime: null, sceneryPlace: null, sourceImageUrl: null };
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, opts);
}

test('end-to-end: a brand-new account\'s real processing.html -> result.html redirect fires FirstVideoCreated via the durable server-side marker, with no sessionStorage involved at all', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var fbqCalls = await installFbqRecorder(context);
    var page = await context.newPage();
    await blockThirdParty(page);
    var conversionCalls = await captureTrackConversion(page);
    var markerState = await mockGenerationCompletesImmediately(page);

    await seedAccountWithDraft(page, { username: 'e2emarkeruser', email: 'e2e-marker@example.com' });
    await page.goto(baseUrl + '/processing.html', { waitUntil: 'domcontentloaded' });

    await page.waitForURL(/result\.html\?id=/, { timeout: 8000 });
    await page.waitForTimeout(400);

    assert.ok(markerState.markedOperationName, 'processing.html should have POSTed the completed generation\'s operationName to mark-generation-completed before redirecting');
    assert.match(page.url(), /result\.html\?id=/, 'should have redirected to result.html for the freshly-completed dream');

    var trackCustomCalls = fbqTrackCustomCalls(fbqCalls, 'FirstVideoCreated');
    assert.equal(trackCustomCalls.length, 1, 'the real processing.html -> result.html flow should fire FirstVideoCreated exactly once via the durable marker round-trip');
    assert.equal(conversionCalls.filter(function (b) { return b && b.event_name === 'FirstVideoCreated'; }).length, 1);

    var phCalls = await readPostHogCaptureCalls(page);
    assert.equal(phCalls.filter(function (c) { return c.name === 'first_video_created'; }).length, 1);
    assert.equal(phCalls.filter(function (c) { return c.name === 'first_video_result_view'; }).length, 1, 'the sanity-check view event should also have fired alongside the real KPI event');
  } finally {
    await context.close();
  }
});
