// test/record-mode-behavioral.test.js
//
// Real browser-driven coverage for the Record-it handoff from the
// marketing funnel (dreamtube-growth) into this app's start.html/
// create.html — tracker item for-product-funnel-is-getting-its-own-co-pihldm.
// Growth-confirmed contract: the funnel's redirectToApp() for the
// Record-it path sends the standard resume params (recall/types/
// motivations) PLUS an additive optional query param mode=record, and
// WITHOUT caption/style (nothing has been recorded yet). start.html reads
// this as isRecordMode and:
//   1. skips the generate-during-signup call entirely on screen 13's
//      Continue (there's no real caption to submit a billed generation
//      for), and
//   2. redirects to create.html?record=1 instead of home.html once the
//      funnel's final screen (14 -- the former standalone confirmation
//      screen 15 was folded into it, tracker item
//      for-product-funnel-handoff-screens-theme-5ttymn) completes (there's
//      no generation in flight to show/poll for; every other completion
//      path lands on home.html directly since processing.html was removed,
//      tracker item for-product-funnel-ending-v2-founder-ins-tfuu0q).
// create.html, in turn, auto-invokes its existing startRecordingUI() (the
// same function the #choice-record card's own click handler calls) when
// ?record=1 is present, landing the visitor directly in the mic-recording
// UI with zero extra taps.
//
// Follows test/meta-capi-behavioral.test.js's and
// test/image-generation-style-toggle-behavioral.test.js's conventions:
// real Chromium via Playwright against this repo's static file server
// (test/helpers/static-server.js), page.route() interception in place of
// any real Netlify Functions runtime, node:test/assert. No real fal.ai
// generation or transcription cost anywhere in this file.

var test = require('node:test');
var assert = require('node:assert/strict');
var staticServer = require('./helpers/static-server');
var signupFlow = require('./helpers/signup-flow');

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

/** Aborts requests to third-party hosts every page here loads (fonts, PostHog, Meta Pixel's real CDN script) -- see CLAUDE.md on this sandbox's outbound network. */
function blockThirdParty(page) {
  return page.route(/fonts\.(googleapis|gstatic)\.com|connect\.facebook\.net|i\.posthog\.com/, function (route) {
    route.abort();
  });
}

/**
 * Records every POST to start-pending-generation (the generate-during-signup
 * call) without letting it hang -- fulfills as a definitive failure (no
 * pendingId) since these tests care about whether the call fires at all, not
 * the generate-during-signup mechanism itself (see test/ui-behavioral.test.js
 * for that coverage).
 *
 * Because this always fails, and getOrStartPendingGeneration's own reuse
 * guard deliberately allows retrying a definitively-failed attempt (see that
 * function's doc comment in start.html/wizard.html -- "nothing was spent on
 * a failed attempt... retrying a failure is safe/correct, not a
 * double-spend risk"), a normal (non-record-mode) run through this helper
 * can legitimately fire TWO calls, not one: once when screen 13's email step
 * captures (tracker item for-product-signup-email-micro-step-foun-ns8uve),
 * and again on the password step's own submit, since the email-step attempt
 * "definitively failed" and is therefore eligible for exactly this kind of
 * retry. Record mode (isRecordMode) skips the call entirely at BOTH points,
 * so it's unaffected -- see this helper's mode=record callers below, which
 * assert a hard zero, not a range.
 */
function trackPendingGenerationCalls(page) {
  var calls = [];
  return page.route('**/.netlify/functions/start-pending-generation', function (route) {
    calls.push(true);
    route.fulfill({ status: 402, contentType: 'application/json', body: JSON.stringify({ error: 'E7: insufficient_tokens' }) });
  }).then(function () { return calls; });
}

test('start.html: a mode=record visitor\'s signup never calls start-pending-generation, and completing the funnel redirects to create.html?record=1 (not processing.html)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var pendingGenerationCalls = await trackPendingGenerationCalls(page);

    // Same base resume params a Build/Write handoff would carry (recall/
    // types/motivations), but deliberately no caption/style -- nothing has
    // been recorded yet -- plus the additive mode=record flag.
    await page.goto(
      baseUrl + '/start.html?resume=1&signup=unified&mode=record&recall=vividly&types=flying,falling&motivations=' + encodeURIComponent('Turn them into videos'),
      { waitUntil: 'domcontentloaded' }
    );

    // As of 2026-07-31 (tracker item
    // for-product-urgent-founder-screenshots-i-g64gjp), the funnel's former
    // characters screen and "preparing" transition screen have both been
    // removed outright -- the funnel tail starts directly on screen 13.
    await page.waitForSelector('#fn-email', { timeout: 5000 });
    await signupFlow.advanceToPasswordStep(page, 'record-mode-behavioral@example.com');
    await page.fill('#fn-password', 'longenoughpassword1');
    await page.click('#fn-s13-continue');

    // Screen 14 (token intro) rendering confirms signup succeeded.
    await page.waitForSelector('#fn-s14-continue', { timeout: 5000 });
    assert.equal(pendingGenerationCalls.length, 0, 'mode=record must never call start-pending-generation -- there is no real caption to submit a billed generation for');

    // Screen 14's Continue now completes the funnel directly -- the former
    // standalone confirmation screen 15 was folded into it (tracker item
    // for-product-funnel-handoff-screens-theme-5ttymn), so there's no
    // separate screen to click through anymore.
    await page.click('#fn-s14-continue');

    await page.waitForURL('**/create.html?record=1', { timeout: 8000, waitUntil: 'domcontentloaded' });
    assert.match(page.url(), /create\.html\?record=1$/, 'mode=record must redirect into create.html\'s Record UI, not home.html');

    // Still no start-pending-generation call anywhere in the whole flow.
    assert.equal(pendingGenerationCalls.length, 0, 'still zero start-pending-generation calls after the full mode=record flow completes');
  } finally {
    await context.close();
  }
});

test('start.html: a normal (no mode=record) Build/Write visitor is completely unchanged -- generate-during-signup still fires and completing the funnel still redirects to home.html', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var pendingGenerationCalls = await trackPendingGenerationCalls(page);

    await page.goto(
      baseUrl + '/start.html?resume=1&signup=unified&style=Cartoon&caption=' + encodeURIComponent('Flying over the ocean at sunset'),
      { waitUntil: 'domcontentloaded' }
    );

    // As of 2026-07-31 (tracker item
    // for-product-urgent-founder-screenshots-i-g64gjp), the funnel's former
    // characters screen and "preparing" transition screen have both been
    // removed outright -- the funnel tail starts directly on screen 13.
    await page.waitForSelector('#fn-email', { timeout: 5000 });
    await signupFlow.advanceToPasswordStep(page, 'normal-mode-behavioral@example.com');
    await page.fill('#fn-password', 'longenoughpassword1');
    await page.click('#fn-s13-continue');

    await page.waitForSelector('#fn-s14-continue', { timeout: 5000 });
    assert.ok(pendingGenerationCalls.length >= 1, 'a normal Build/Write signup must still fire at least one start-pending-generation call (this helper always fails the call, so the email-step capture + password-step retry can legitimately both fire -- see trackPendingGenerationCalls\' own doc comment)');

    // Screen 14's Continue now completes the funnel directly -- see the
    // matching comment in the mode=record test above.
    await page.click('#fn-s14-continue');

    await page.waitForURL('**/home.html**', { timeout: 8000, waitUntil: 'domcontentloaded' });
    assert.match(page.url(), /home\.html/, 'a normal Build/Write funnel completion must still redirect to home.html (tracker item for-product-funnel-ending-v2-founder-ins-tfuu0q -- processing.html removed)');
  } finally {
    await context.close();
  }
});

/** Installs a minimal fake navigator.mediaDevices.getUserMedia + window.MediaRecorder before any page script runs, so create.html's real startRecordingUI() (unchanged by this feature) can run end to end without touching a real microphone. Records whether getUserMedia was actually invoked. */
async function installMediaRecorderMock(context) {
  await context.addInitScript(function () {
    window.__getUserMediaCalls = 0;
    var fakeStream = { getTracks: function () { return []; } };
    if (!navigator.mediaDevices) navigator.mediaDevices = {};
    navigator.mediaDevices.getUserMedia = function () {
      window.__getUserMediaCalls++;
      return Promise.resolve(fakeStream);
    };
    function FakeMediaRecorder(stream, opts) {
      this.stream = stream;
      this.state = 'inactive';
      this.mimeType = (opts && opts.mimeType) || 'audio/webm';
      this._listeners = {};
    }
    FakeMediaRecorder.prototype.addEventListener = function (evt, cb) {
      this._listeners[evt] = this._listeners[evt] || [];
      this._listeners[evt].push(cb);
    };
    FakeMediaRecorder.prototype.start = function () { this.state = 'recording'; };
    FakeMediaRecorder.prototype.stop = function () {
      this.state = 'inactive';
      (this._listeners.stop || []).forEach(function (cb) { cb(); });
    };
    FakeMediaRecorder.isTypeSupported = function () { return true; };
    window.MediaRecorder = FakeMediaRecorder;
  });
}

async function seedLoggedInUserAt(page, username, path) {
  await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function (u) {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@' + u, username: u };
    if (!state.accounts) state.accounts = {};
    state.accounts[u] = { password: 'testpass1', email: u + '@example.com' };
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, username);
  await page.goto(baseUrl + path, { waitUntil: 'domcontentloaded' });
}

test('create.html: ?record=1 auto-invokes the mic-record flow (startRecordingUI) on load, skipping the Build/Write/Record choice screen', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await installMediaRecorderMock(context);
    var page = await context.newPage();
    await blockThirdParty(page);

    await seedLoggedInUserAt(page, 'recordparamtester', '/create.html?record=1');

    await page.waitForSelector('#create-record[style*="display: flex"]', { timeout: 5000 });

    var getUserMediaCalls = await page.evaluate(function () { return window.__getUserMediaCalls; });
    assert.equal(getUserMediaCalls, 1, 'landing on create.html?record=1 must call getUserMedia exactly once, with no extra tap');

    var selectDisplay = await page.locator('#create-select').evaluate(function (el) { return getComputedStyle(el).display; });
    assert.equal(selectDisplay, 'none', 'the Build/Write/Record choice screen must be hidden -- the visitor lands directly in Record');

    var heading = await page.textContent('#create-heading');
    assert.equal(heading, 'Record your dream');
  } finally {
    await context.close();
  }
});

test('create.html: without ?record=1, a normal visit still shows the Build/Write/Record choice screen and never calls getUserMedia', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await installMediaRecorderMock(context);
    var page = await context.newPage();
    await blockThirdParty(page);

    await seedLoggedInUserAt(page, 'norecordparamtester', '/create.html');

    await page.waitForSelector('#choice-record', { timeout: 5000 });
    var selectDisplay = await page.locator('#create-select').evaluate(function (el) { return getComputedStyle(el).display; });
    assert.notEqual(selectDisplay, 'none', 'without ?record=1 the choice screen must still show, unchanged');

    var getUserMediaCalls = await page.evaluate(function () { return window.__getUserMediaCalls; });
    assert.equal(getUserMediaCalls, 0, 'without ?record=1, getUserMedia must never be called automatically');
  } finally {
    await context.close();
  }
});

// ===========================================================================
// Logged-out ?record=1 round-trip through login.html — tracker item
// for-product-speak-path-from-the-wizard-e-ycos08 (found via the new
// Layout-B wizard's entry chooser, whose Speak card is create.html?record=1
// same as this file's other tests, but the gap is pre-existing and equally
// reachable from any other ?record=1 deep-link, not specific to that
// branch). Before this fix, create.html's sign-in guard bounced a
// logged-out visitor to a bare 'login.html' with no ?next= at all, so the
// record intent was silently dropped -- post-login they landed on the
// ordinary Build/Write/Record choice screen instead of recording.
// ===========================================================================

test('create.html: a logged-out ?record=1 visit round-trips the record intent through login.html\'s own ?next= mechanism and starts recording post-login', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await installMediaRecorderMock(context);
    var page = await context.newPage();
    await blockThirdParty(page);

    await page.goto(baseUrl + '/create.html?record=1', { waitUntil: 'domcontentloaded' });
    await page.waitForURL(function (url) { return url.pathname === '/login.html'; }, { timeout: 5000, waitUntil: 'domcontentloaded' });
    assert.equal(
      new URL(page.url()).searchParams.get('next'),
      '/create.html?record=1',
      'the logged-out redirect must carry the full record=1 intent as ?next=, not drop it'
    );

    await page.evaluate(function () {
      var raw = localStorage.getItem('dreamtube_state_v1');
      var state = raw ? JSON.parse(raw) : {};
      if (!state.accounts) state.accounts = {};
      state.accounts.speakroundtriptester = { password: 'testpass1', email: 'speakroundtriptester@example.com' };
      localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.fill('#login-username', 'speakroundtriptester');
    await page.fill('#login-password', 'testpass1');
    await page.click('#login-submit');

    await page.waitForURL(function (url) { return url.pathname === '/create.html' && url.searchParams.get('record') === '1'; }, { timeout: 5000, waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#create-record[style*="display: flex"]', { timeout: 5000 });
    var getUserMediaCalls = await page.evaluate(function () { return window.__getUserMediaCalls; });
    assert.equal(getUserMediaCalls, 1, 'landing back on create.html?record=1 post-login must actually start recording, with no extra tap');
  } finally {
    await context.close();
  }
});

test('create.html: a logged-out plain visit (no ?record=1) still redirects to login.html with the plain path as ?next=', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.goto(baseUrl + '/create.html', { waitUntil: 'domcontentloaded' });
    await page.waitForURL(function (url) { return url.pathname === '/login.html'; }, { timeout: 5000, waitUntil: 'domcontentloaded' });
    assert.equal(new URL(page.url()).searchParams.get('next'), '/create.html', 'a plain logged-out visit must still land back on plain create.html, not a login.html without ?next= at all');
  } finally {
    await context.close();
  }
});

// ===========================================================================
// Bug fix coverage — tracker item
// for-product-bug-founder-high-record-it-f-8ng0nf (founder repro,
// 2026-07-26 night): "click Record it in the growth funnel -> recording
// appears skipped entirely." All the handoff wiring above already worked
// (mode=record -> isRecordMode -> create.html?record=1 -> startRecordingUI);
// the actual bug was start.html's record-mode screens (11, 13, and the
// former standalone 15, now folded into 14 -- tracker item
// for-product-funnel-handoff-screens-theme-5ttymn) showing unchanged copy
// that lied about a dream already being in progress ("Your dream is coming
// together", "we'll email you your dream the moment it's ready", "Building
// your first dream now") when, in record mode, nothing has been recorded
// yet at that point — recording only happens after this, app-side on
// create.html. Fixed by making that copy record-mode-aware. (Screen 11
// itself was later removed outright, 2026-07-31, tracker item
// for-product-urgent-founder-screenshots-i-g64gjp -- the copy assertions
// below now only cover screens 13/14, which are still live.)
//
// This covers the FULL chain end to end in one test (funnel handoff ->
// start.html signup in record mode -> create.html?record=1 -> the record
// panel/mic-open behavior actually reachable) plus the record-mode copy
// itself, on a mobile FB/IG-in-app-webview-sized viewport per
// FOUNDER_PRINCIPLES.md's "Paid traffic is mobile, mostly the FB/IG
// in-app webview ... smoke-test the real funnel" standing rule — the two
// earlier tests in this file cover the same chain in two separate halves
// (default desktop viewport, no copy assertions); this one is the single
// continuous mobile repro of the founder's own bug report.
// ===========================================================================

/** iPhone 12/13-sized viewport — a common real-world FB/IG in-app-browser width, matching this repo's other mobile-webview-sized viewport tests (e.g. test/ui-behavioral.test.js's 375px/320px result.html checks). */
var MOBILE_WEBVIEW_VIEWPORT = { width: 390, height: 844 };

test('record-it funnel full chain on a mobile webview viewport: mode=record handoff -> start.html signup (honest record-mode copy, no false "dream in progress" claims) -> create.html?record=1 -> record panel + mic actually reachable', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_WEBVIEW_VIEWPORT });
  try {
    await installMediaRecorderMock(context);
    var page = await context.newPage();
    await blockThirdParty(page);
    var pendingGenerationCalls = await trackPendingGenerationCalls(page);

    await page.goto(
      baseUrl + '/start.html?resume=1&signup=unified&mode=record&recall=vividly&types=flying&motivations=' + encodeURIComponent('Turn them into videos'),
      { waitUntil: 'domcontentloaded' }
    );

    // The former screen 11 ("preparing" transition) -- which used to need
    // record-mode-aware copy here so it didn't falsely claim a dream was
    // already coming together -- was removed outright 2026-07-31 (tracker
    // item for-product-urgent-founder-screenshots-i-g64gjp), so there is no
    // longer any such copy to assert on; the funnel tail lands directly on
    // screen 13.
    //
    // Screen 13 (email capture) must not claim a dream already exists /
    // is just waiting to be emailed -- it must say recording comes next.
    await page.waitForSelector('#fn-email', { timeout: 5000 });
    var screen13Text = await page.evaluate(function () { return document.getElementById('fnScreen').textContent; });
    assert.doesNotMatch(screen13Text, /where should we send your first dream/i, 'record mode must not ask where to "send your first dream" -- no dream exists yet');
    assert.doesNotMatch(screen13Text, /we.?ll email you your dream the moment it.?s ready/i, 'record mode\'s reassurance must not read as if a dream already exists, waiting only on email delivery');
    assert.match(screen13Text, /record your dream/i, 'record mode\'s screen 13 must say the visitor will record their dream');
    await signupFlow.advanceToPasswordStep(page, 'record-mode-mobile-behavioral@example.com');
    await page.fill('#fn-password', 'longenoughpassword1');
    await page.click('#fn-s13-continue');

    await page.waitForSelector('#fn-s14-continue', { timeout: 5000 });
    assert.equal(pendingGenerationCalls.length, 0, 'record mode must never call start-pending-generation -- there is no real caption to submit a billed generation for');

    // Screen 14 (now also carrying the former standalone screen 15's
    // confirmation beat -- tracker item
    // for-product-funnel-handoff-screens-theme-5ttymn) must not claim a
    // dream is already being built -- recording (the actual first step)
    // hasn't happened yet.
    var screen14Text = await page.evaluate(function () { return document.getElementById('fnScreen').textContent; });
    assert.doesNotMatch(screen14Text, /building your first dream now/i, 'record mode must not claim a dream is already being built -- recording (the real first step) has not happened yet');
    assert.match(screen14Text, /record your dream/i, 'record mode\'s screen 14 must point the visitor at recording next, not a dream already in progress');
    await page.click('#fn-s14-continue');

    // Full handoff into create.html's Record UI, with the mic flow actually
    // reachable (real startRecordingUI() call, mocked media only).
    await page.waitForURL('**/create.html?record=1', { timeout: 8000, waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#create-record[style*="display: flex"]', { timeout: 5000 });

    var getUserMediaCalls = await page.evaluate(function () { return window.__getUserMediaCalls; });
    assert.equal(getUserMediaCalls, 1, 'landing on create.html?record=1 after the full record-it chain must actually open the mic, with no extra tap');

    var heading = await page.textContent('#create-heading');
    assert.equal(heading, 'Record your dream');

    assert.equal(pendingGenerationCalls.length, 0, 'still zero start-pending-generation calls after the full record-it chain completes');
  } finally {
    await context.close();
  }
});

test('start.html: a normal (no mode=record) visitor still sees the original screen 13/14 copy unchanged, on the same mobile webview viewport', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_WEBVIEW_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);

    await page.goto(
      baseUrl + '/start.html?resume=1&signup=unified&style=Cartoon&caption=' + encodeURIComponent('Flying over the ocean at sunset'),
      { waitUntil: 'domcontentloaded' }
    );

    // The former screen 11 ("preparing" transition) was removed outright
    // 2026-07-31 (tracker item for-product-urgent-founder-screenshots-i-
    // g64gjp) -- the funnel tail now lands directly on screen 13.
    await page.waitForSelector('#fn-email', { timeout: 5000 });
    var screen13Text = await page.evaluate(function () { return document.getElementById('fnScreen').textContent; });
    assert.match(screen13Text, /where should we send your first dream/i, 'a normal (non-record) visitor must still see the original screen 13 headline, unchanged');
    await signupFlow.advanceToPasswordStep(page, 'normal-mode-mobile-behavioral@example.com');
    await page.fill('#fn-password', 'longenoughpassword1');
    await page.click('#fn-s13-continue');

    await page.waitForSelector('#fn-s14-continue', { timeout: 5000 });
    // The former standalone screen 15's confirmation copy now renders as
    // part of screen 14 itself (tracker item
    // for-product-funnel-handoff-screens-theme-5ttymn), so it's checked
    // here, before Continue navigates away.
    var screen14Text = await page.evaluate(function () { return document.getElementById('fnScreen').textContent; });
    assert.match(screen14Text, /building your first dream now/i, 'a normal (non-record) visitor must still see the original screen 15 confirmation copy, now folded into screen 14, unchanged');
    await page.click('#fn-s14-continue');
  } finally {
    await context.close();
  }
});

// ===========================================================================
// Round 9 (08-07 live bug hunt #4): a brand-new visitor who picked "Speak
// it" on wizard.html's entry chooser used to land here on a "Welcome back"
// LOGIN wall — returning-user framing for someone with no account, signup
// demoted to a footer link. login.html now defaults a record-intent
// arrival (?next=/create.html?record=1) WITH no local account history into
// its existing signup mode, with recording-framed copy. Presentation only:
// same fields, same DreamStore calls, same toggle — the round-trip test
// above (which seeds an account first, so it keeps login-first) is the
// proof the auth flow itself is untouched.
// ===========================================================================

test('login.html: a record-intent arrival on a FRESH browser (no account history) renders signup-first with recording-framed copy, login one tap away — while the same arrival WITH account history keeps "Welcome back" login-first', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);

    // Fresh browser, record intent -> signup-first, recording framing.
    await page.goto(baseUrl + '/login.html?next=' + encodeURIComponent('/create.html?record=1'), { waitUntil: 'domcontentloaded' });
    assert.match(await page.locator('#auth-heading').textContent(), /Sign up to record your dream/, 'a fresh record-intent visitor must see recording-framed SIGNUP copy, never "Welcome back"');
    assert.equal(await page.locator('#login-email').isVisible(), true, 'signup mode (email field) must be the default for this arrival');
    assert.match(await page.locator('#auth-toggle').textContent(), /Already have an account/, 'login must stay one tap away as the secondary path');
    // The toggle still swaps to plain login mode — auth flow untouched.
    await page.click('#auth-toggle');
    assert.match(await page.locator('#auth-heading').textContent(), /Welcome back/, 'toggling to login must show the normal login copy');

    // Same arrival with existing local account history -> login-first,
    // exactly as before round 9 (that device plausibly IS a returning user).
    await page.evaluate(function () {
      var raw = localStorage.getItem('dreamtube_state_v1');
      var state = raw ? JSON.parse(raw) : {};
      if (!state.accounts) state.accounts = {};
      state.accounts.historyholder = { password: 'testpass1', email: 'historyholder@example.com' };
      localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    });
    await page.goto(baseUrl + '/login.html?next=' + encodeURIComponent('/create.html?record=1'), { waitUntil: 'domcontentloaded' });
    assert.match(await page.locator('#auth-heading').textContent(), /Welcome back/, 'a device with account history keeps the login-first default');

    // A plain, no-intent login visit is byte-identical to before.
    await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
    assert.match(await page.locator('#auth-heading').textContent(), /Welcome back/, 'plain login.html is unchanged');
  } finally {
    await context.close();
  }
});
