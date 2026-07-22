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
// directly into localStorage/sessionStorage (the same shortcut
// test/ui-behavioral.test.js's seedResultPage helper already uses for
// result.html), both the cheapest way to verify this (see
// AGENT_POLICY.md's "keep generation-testing cost low" section) and the
// only practical way to construct "this account already has N completed
// dreams" preconditions without actually running N real/mocked
// generations.

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

/** Seeds localStorage with a logged-in account and however many of its own completed dreams the test needs, mirroring test/ui-behavioral.test.js's seedResultPage shape. `firstVideoCreatedFired` lets a test simulate an account that already consumed its one-time flag. */
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
      state.dreams.push(Object.assign({
        ownerHandle: '@' + o.username,
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

/** Sets the "just generated" sessionStorage marker result.html looks for -- same key processing.html writes right before its redirect. Must run on a page already on this origin (sessionStorage is per-tab but still origin-scoped). */
function markJustGenerated(page, dreamId) {
  return page.evaluate(function (id) {
    sessionStorage.setItem('dreamtube_just_generated_id', id);
  }, dreamId);
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
    await markJustGenerated(page, 'dream-first-1');

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

    // Reloading the same result.html page afterwards: the sessionStorage
    // marker was already consumed on first load, so this must not re-fire
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
    await markJustGenerated(page, 'dream-second-2');

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
    // sessionStorage guard, this dream-count-1 + flag-unset combination
    // would look identical to a genuine first-time completion.
    await seedAccount(page, {
      username: 'legacyresultuser',
      email: 'legacy-result@example.com',
      dreams: [{ id: 'dream-legacy-1' }]
    });
    // Deliberately NOT calling markJustGenerated -- an ordinary revisit,
    // not a fresh redirect from processing.html.

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
    await markJustGenerated(page, 'dream-fired-2');

    await page.goto(baseUrl + '/result.html?id=dream-fired-2', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(300);

    assert.equal(fbqTrackCustomCalls(fbqCalls, 'FirstVideoCreated').length, 0, 'the flag being already set must block firing regardless of the marker');
    assert.equal(conversionCalls.filter(function (b) { return b && b.event_name === 'FirstVideoCreated'; }).length, 0);
  } finally {
    await context.close();
  }
});
