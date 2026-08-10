// test/create-record-inapp-webview-guard-behavioral.test.js
//
// Real browser-driven coverage for tracker item
// for-product-bug-founder-high-record-it-s-6ewhb4 (founder repro,
// 2026-07-27, via the real Meta ad link): "Record it" still doesn't work.
// An earlier fix (for-product-bug-founder-high-record-it-f-8ng0nf) already
// corrected start.html's dishonest record-mode copy on screens 11/13/15, but
// never touched whether the actual microphone capture on create.html
// succeeds. Root cause: create.html's startRecordingUI() calls
// navigator.mediaDevices.getUserMedia({audio:true}) unconditionally, either
// auto-triggered on load via ?record=1 (the funnel's Record-it handoff) or
// from a direct #choice-record click — and Meta ad clicks very commonly
// open inside Instagram's/Facebook's own in-app browser (a WebView), which
// is well known to block or badly restrict getUserMedia regardless of page
// code, with no detection anywhere upstream. The existing .catch() then
// shows "allow it in your browser settings" — misleading advice inside a
// webview with no such settings toggle.
//
// This fix reuses processing.html's established in-app-webview detection/
// escape convention (own per-page copy of detectInAppHost()/
// buildAndroidChromeIntentUrl(), same UA-token detection), gating INSIDE
// startRecordingUI() so both call sites (the #choice-record click handler
// and the ?record=1 auto-trigger) are covered by one guard: when an in-app
// webview is detected, getUserMedia must never be called at all, and a
// guard panel (#create-record-blocked) steers the visitor to their real
// browser or to Write instead.
//
// FOLLOW-UP (tracker for-product-founder-solution-for-record--111tp1,
// founder decision 2026-07-27): showing the blocked panel from a manual tap
// turned out not to be the right default -- with two working alternatives
// (Build it / Write it) sitting right on the same choice screen, the
// founder's call was "capability-detect and HIDE, don't handhold." So the
// way into Record it is omitted entirely from the choice screen's initial
// render whenever detectInAppHost() finds an in-app webview -- it's simply
// not there to tap. The #create-record-blocked guard panel itself is
// UNCHANGED and still lives inside startRecordingUI() -- it's just no
// longer reachable via a manual tap once that entry point is hidden. It's
// kept for the one case hiding it can't cover: a direct ?record=1 deep-link
// landing straight in a webview, where the choice screen (and therefore the
// now-hidden entry point) is never shown at all -- the auto-trigger below
// still calls startRecordingUI() directly, hits the same guard, and still
// needs *something* on screen instead of a silent getUserMedia failure.
//
// UPDATED (tracker item for-product-unify-create-html-to-questio-lif350):
// the question-first redesign replaced the old three visible Build/Write/
// Record cards with a six-tile chooser plus a secondary "Speak it instead"
// link (#q-speak) -- #choice-record is now a permanently-hidden legacy
// element that link dispatches into (see create.html's own #create-select
// markup comment), so THIS guard's visible surface is #q-speak now, not
// #choice-record directly. renderQuestionFirst() gates #q-speak's very
// presence in the rendered HTML with the exact same detectInAppHost() check
// the old card used -- same guard, new surface.
//
// Follows test/record-mode-behavioral.test.js's installMediaRecorderMock/
// seedLoggedInUserAt conventions for exercising create.html's record flow
// without touching a real microphone, and
// test/wait-screen-reassurance-and-inapp-nudge-behavioral.test.js's
// newContext({ userAgent }) convention for simulating an in-app browser.

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

/** Aborts requests to third-party hosts every page here loads -- see CLAUDE.md on this sandbox's outbound network, and every other *-behavioral test file's identical helper. */
function blockThirdParty(page) {
  return page.route(/fonts\.(googleapis|gstatic)\.com|connect\.facebook\.net|i\.posthog\.com/, function (route) {
    route.abort();
  });
}

var IG_ANDROID_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/119.0.0.0 Mobile Safari/537.36 Instagram 302.0.0.23.114 Android (33/13; 420dpi; 1080x2246; google/redfin/redfin:13; en_US; 538815920)';
var FB_IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/400.0.0.0.100;FBBV/1;FBDV/iPhone14,2;FBMD/iPhone;FBSN/iOS;FBSV/16.0;FBSS/3;FBID/phone;FBLC/en_US]';
var NORMAL_ANDROID_CHROME_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36';

/** Installs a minimal fake navigator.mediaDevices.getUserMedia + window.MediaRecorder before any page script runs (mirrors test/record-mode-behavioral.test.js's own helper), so create.html's real startRecordingUI() can run end to end without touching a real microphone, while recording whether getUserMedia was ever actually invoked. */
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

// ===========================================================================
// ?record=1 auto-trigger path
// ===========================================================================

test('create.html?record=1: a normal (non-in-app) browser UA is completely unchanged -- getUserMedia is still attempted automatically', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ userAgent: NORMAL_ANDROID_CHROME_UA });
  try {
    await installMediaRecorderMock(context);
    var page = await context.newPage();
    await blockThirdParty(page);

    await seedLoggedInUserAt(page, 'normalautoguard', '/create.html?record=1');

    await page.waitForSelector('#create-record[style*="display: flex"]', { timeout: 5000 });
    var getUserMediaCalls = await page.evaluate(function () { return window.__getUserMediaCalls; });
    assert.equal(getUserMediaCalls, 1, 'a normal browser UA must still auto-call getUserMedia exactly once -- this guard must not change the working case');

    var blockedDisplay = await page.locator('#create-record-blocked').evaluate(function (el) { return getComputedStyle(el).display; });
    assert.equal(blockedDisplay, 'none', 'the in-app-webview guard panel must never show for a normal browser UA');
  } finally {
    await context.close();
  }
});

test('create.html?record=1: an Instagram in-app-webview UA never calls getUserMedia -- the guard panel shows instead, naming Instagram', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ userAgent: IG_ANDROID_UA });
  try {
    await installMediaRecorderMock(context);
    var page = await context.newPage();
    await blockThirdParty(page);

    await seedLoggedInUserAt(page, 'igautoguard', '/create.html?record=1');

    await page.waitForSelector('#create-record-blocked[style*="display: flex"]', { timeout: 5000 });
    var getUserMediaCalls = await page.evaluate(function () { return window.__getUserMediaCalls; });
    assert.equal(getUserMediaCalls, 0, 'an Instagram in-app webview must NEVER call getUserMedia -- it is well known to be blocked/restricted there');

    var recordDisplay = await page.locator('#create-record').evaluate(function (el) { return getComputedStyle(el).display; });
    assert.equal(recordDisplay, 'none', 'the real mic-recording panel must not be shown when the guard is active');

    var title = await page.textContent('#rec-inapp-title');
    assert.match(title, /Instagram/, 'the guard panel must name the actually-detected host app (Instagram)');
    var body = await page.textContent('#rec-inapp-body');
    assert.match(body, /Instagram/, 'the guard body copy must also name the host app');
    assert.doesNotMatch(body, /allow it in your browser settings/i, 'must not show the old, misleading "allow it in your browser settings" copy -- there is no such toggle inside a webview');

    var heading = await page.textContent('#create-heading');
    assert.equal(heading, 'Record your dream');

    // for-product-nudge-polish-founder-show-a--x72003: same static
    // menu-row-replica visual (icon + "Open in external browser" label)
    // that processing.html's nudge card uses, so this reads as one
    // consistent product component rather than a second implementation.
    // REVIEW FIX: assert on the VISIBLE-ONLY hint-text span (the literal
    // instruction must be accessible, not only inside the aria-hidden
    // decorative replica below).
    var hintTextOnly = await page.textContent('#rec-inapp-hint-text');
    assert.match(hintTextOnly, /Instagram/, 'the lead-in sentence must still name the host app');
    assert.match(hintTextOnly, /Open in external browser/i, 'the literal instruction must be in the ACCESSIBLE sentence itself, not only inside the aria-hidden visual replica');
    var replicaVisible = await page.locator('#rec-inapp-menu-replica').isVisible();
    assert.equal(replicaVisible, true, 'the static menu-row replica must render inside the record-blocked panel too');
    var replicaAriaHidden = await page.locator('#rec-inapp-menu-replica').getAttribute('aria-hidden');
    assert.equal(replicaAriaHidden, 'true', 'the decorative replica must stay aria-hidden since its info is already in the accessible sentence above');
    var replicaLabel = await page.textContent('#rec-inapp-menu-replica .menu-row-replica-label');
    assert.match(replicaLabel, /Open in external browser/i);
    var replicaIconHtml = await page.locator('#rec-inapp-menu-replica-icon').innerHTML();
    assert.match(replicaIconHtml, /<svg/, 'the replica must include an icon, not just bare text');
  } finally {
    await context.close();
  }
});

test('create.html?record=1: a Facebook in-app-webview UA (iOS) never calls getUserMedia -- the guard panel names Facebook and offers a Write-it-instead fallback', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ userAgent: FB_IOS_UA });
  try {
    await installMediaRecorderMock(context);
    var page = await context.newPage();
    await blockThirdParty(page);

    await seedLoggedInUserAt(page, 'fbautoguard', '/create.html?record=1');

    await page.waitForSelector('#create-record-blocked[style*="display: flex"]', { timeout: 5000 });
    var getUserMediaCalls = await page.evaluate(function () { return window.__getUserMediaCalls; });
    assert.equal(getUserMediaCalls, 0, 'a Facebook in-app webview must never call getUserMedia');

    var title = await page.textContent('#rec-inapp-title');
    assert.match(title, /Facebook/, 'the guard panel must name Facebook specifically, not a generic message');

    // Same static menu-row-replica visual as the Instagram case above --
    // must render for Facebook too, since the founder's ask is for one
    // consistent visual pattern across both hosts (see this file's
    // Instagram test for the fuller comment).
    var hintTextOnly = await page.textContent('#rec-inapp-hint-text');
    assert.match(hintTextOnly, /Facebook/, 'the lead-in sentence must name Facebook here, not a hardcoded Instagram');
    var replicaVisible = await page.locator('#rec-inapp-menu-replica').isVisible();
    assert.equal(replicaVisible, true, 'the static menu-row replica must render for the Facebook host case too');
    var replicaLabel = await page.textContent('#rec-inapp-menu-replica .menu-row-replica-label');
    assert.match(replicaLabel, /Open in external browser/i);

    // "Write it instead" must be a real, working fallback -- consistent with
    // this page's existing choice options -- not a dead end.
    await page.click('#rec-inapp-write-btn');
    var writeDisplay = await page.locator('#create-write').evaluate(function (el) { return getComputedStyle(el).display; });
    assert.equal(writeDisplay, 'flex', '"Write it instead" must actually switch into the Write panel');
    var blockedDisplayAfter = await page.locator('#create-record-blocked').evaluate(function (el) { return getComputedStyle(el).display; });
    assert.equal(blockedDisplayAfter, 'none', 'the guard panel must hide once Write it instead is chosen');
  } finally {
    await context.close();
  }
});

test('create.html?record=1: on Android, the guard panel\'s "Open in my browser" button targets an intent:// Chrome URL preserving ?record=1, so the visitor lands back in a working record flow', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ userAgent: IG_ANDROID_UA });
  try {
    await installMediaRecorderMock(context);
    var page = await context.newPage();
    await blockThirdParty(page);

    await seedLoggedInUserAt(page, 'androidopenguard', '/create.html?record=1');
    await page.waitForSelector('#create-record-blocked[style*="display: flex"]', { timeout: 5000 });

    var pageUrl = page.url();
    var intentUrl = await page.evaluate(function () { return buildAndroidChromeIntentUrl(); });
    assert.match(intentUrl, /^intent:\/\//, 'must be an intent:// URL');
    assert.match(intentUrl, /package=com\.android\.chrome/, 'must target Chrome specifically');
    assert.ok(intentUrl.indexOf(encodeURIComponent(pageUrl)) !== -1, 'must carry a browser_fallback_url pointing back at the current ?record=1 URL, so re-opening lands right back in the record flow');
    assert.ok(intentUrl.indexOf('record%3D1') !== -1 || intentUrl.indexOf('record=1') !== -1, 'the preserved fallback URL must still carry ?record=1');
  } finally {
    await context.close();
  }
});

test('create.html?record=1: on iOS, the button is a real "Copy link for your browser" action (not the old fake "Open in my browser") -- clicking it never navigates away, copies the link, and still emphasizes the host-app-menu hint as a fallback -- round-2 founder fix, tracker item for-product-webview-notify-escape-nudge--5yray5', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ userAgent: FB_IOS_UA, permissions: ['clipboard-read', 'clipboard-write'] });
  try {
    await installMediaRecorderMock(context);
    var page = await context.newPage();
    await blockThirdParty(page);

    await seedLoggedInUserAt(page, 'iosopenguard', '/create.html?record=1');
    await page.waitForSelector('#create-record-blocked[style*="display: flex"]', { timeout: 5000 });

    // ROUND-2 FOUNDER FIX: this button used to unconditionally say "Open in
    // my browser" and do NOTHING on iOS -- a misleading button-shaped
    // element with no real action behind it. Non-Android now gets the same
    // honest "Copy link for your browser" action processing.html's nudge
    // card already had (see test/session-transfer-behavioral.test.js for the
    // full clipboard/?bt=-token round trip coverage of this exact button).
    var btnLabel = await page.textContent('#rec-inapp-open-btn');
    assert.match(btnLabel, /Copy link for your browser/, 'non-Android must show a real, working action label, never the old "Open in my browser" that promised something the click handler could not do');

    await page.click('#rec-inapp-open-btn');
    await page.waitForTimeout(200);
    assert.match(page.url(), /create\.html/, 'clicking the button on iOS must never navigate away from create.html');

    var clipboardText = await page.evaluate(function () { return navigator.clipboard.readText(); });
    assert.match(clipboardText, /create\.html/, 'clicking the button must actually copy the current link -- a real action, not a silent no-op');

    var noteEl = page.locator('#rec-inapp-copied-note');
    await noteEl.waitFor({ state: 'visible', timeout: 2000 });
    assert.match(await noteEl.textContent(), /open your browser/i, 'a persistent instruction must appear telling the visitor exactly what to do next');

    // Assert on the visible-only span, not the whole #rec-inapp-hint
    // container -- the container also contains the aria-hidden decorative
    // replica, so a container-level check can't tell apart "the accessible
    // sentence carries this" from "only the hidden replica does."
    var hintTextOnly = await page.textContent('#rec-inapp-hint-text');
    assert.match(hintTextOnly, /Facebook/, 'the hint must explicitly name the host app\'s own menu');
    assert.match(hintTextOnly, /Open in external browser/i, 'the literal instruction must be in the ACCESSIBLE sentence itself');
    var hintHasEmphasis = await page.evaluate(function () {
      return document.getElementById('rec-inapp-hint').classList.contains('proc-nudge-hint-emph');
    });
    assert.equal(hintHasEmphasis, true, 'clicking the button on iOS should still emphasize the hint line as a fallback');
  } finally {
    await context.close();
  }
});

// ===========================================================================
// Choice-screen "Speak it" visibility (visiting create.html directly, no
// ?record=1) -- per the founder's 2026-07-27 follow-up decision, no way
// into Record it must be offered at all in a detected in-app webview,
// rather than being shown and blocking on click.
//
// UPDATED (tracker item for-product-unify-create-html-to-questio-lif350):
// the question-first redesign replaced the old three Build/Write/Record
// cards with a six-tile chooser + a secondary "Speak it instead" link
// (#q-speak) -- #choice-record itself is now a permanently-hidden legacy
// element #q-speak dispatches into (see create.html's own #create-select
// markup comment), so it is never independently visible/hidden by webview
// UA anymore; renderQuestionFirst() gates #q-speak's very presence in the
// rendered HTML with the exact same detectInAppHost() check the old card
// used (see that function's own doc comment) -- these tests now assert on
// #q-speak instead, the real, currently-shipped surface of this guard.
// ===========================================================================

test('create.html: without ?record=1, a normal browser UA still offers "Speak it instead", and tapping it calls getUserMedia unchanged', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ userAgent: NORMAL_ANDROID_CHROME_UA });
  try {
    await installMediaRecorderMock(context);
    var page = await context.newPage();
    await blockThirdParty(page);

    await seedLoggedInUserAt(page, 'normalclickguard', '/create.html');
    await page.waitForSelector('#q-speak', { timeout: 5000 });
    assert.equal(await page.locator('#q-speak').isVisible(), true, 'a normal browser UA must still offer "Speak it instead"');

    await page.click('#q-speak');
    await page.waitForSelector('#create-record[style*="display: flex"]', { timeout: 5000 });
    var getUserMediaCalls = await page.evaluate(function () { return window.__getUserMediaCalls; });
    assert.equal(getUserMediaCalls, 1, 'a manual Speak-it tap on a normal browser UA must still call getUserMedia, unchanged');
  } finally {
    await context.close();
  }
});

test('create.html: without ?record=1, an Instagram in-app webview UA never renders "Speak it instead" at all -- the six question tiles (Build it/Write it\'s replacement) remain', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ userAgent: IG_ANDROID_UA });
  try {
    await installMediaRecorderMock(context);
    var page = await context.newPage();
    await blockThirdParty(page);

    await seedLoggedInUserAt(page, 'igclickguard', '/create.html');
    await page.waitForSelector('#q-grid', { timeout: 5000 });

    assert.equal(await page.locator('#q-speak').count(), 0, '"Speak it instead" must be hidden entirely inside a detected in-app webview -- not shown-then-blocked');
    assert.equal(await page.locator('#q-grid .q-tile').count(), 6, 'all six question tiles (which route into Build it/Write it) must remain -- they are real, working alternatives');

    var getUserMediaCalls = await page.evaluate(function () { return window.__getUserMediaCalls; });
    assert.equal(getUserMediaCalls, 0, 'with the link hidden, there is no way to trigger getUserMedia from the choice screen at all');

    var blockedDisplay = await page.locator('#create-record-blocked').evaluate(function (el) { return getComputedStyle(el).display; });
    assert.equal(blockedDisplay, 'none', 'the blocked-state panel must not show on its own -- it only ever shows in response to an actual record attempt (the ?record=1 auto-trigger)');
  } finally {
    await context.close();
  }
});

test('create.html: without ?record=1, a Facebook in-app webview UA (iOS) also never renders "Speak it instead"', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ userAgent: FB_IOS_UA });
  try {
    await installMediaRecorderMock(context);
    var page = await context.newPage();
    await blockThirdParty(page);

    await seedLoggedInUserAt(page, 'fbclickguard', '/create.html');
    await page.waitForSelector('#q-grid', { timeout: 5000 });

    assert.equal(await page.locator('#q-speak').count(), 0, '"Speak it instead" must be hidden for Facebook\'s in-app webview too, not just Instagram\'s');
  } finally {
    await context.close();
  }
});

test('create.html?record=1: the guard panel (auto-triggered path) is still reachable via the topbar Back button, returning to the question-first choice screen with "Speak it instead" hidden', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ userAgent: IG_ANDROID_UA });
  try {
    await installMediaRecorderMock(context);
    var page = await context.newPage();
    await blockThirdParty(page);

    // The link-hiding fix means the guard panel can no longer be reached by
    // tapping "Speak it instead" (it's not there to tap) -- the only path
    // left into it is the ?record=1 deep-link auto-trigger, which still
    // calls startRecordingUI() directly and hits the same unchanged guard.
    await seedLoggedInUserAt(page, 'backfromguard', '/create.html?record=1');
    await page.waitForSelector('#create-record-blocked[style*="display: flex"]', { timeout: 5000 });

    await page.click('#create-back');
    var selectDisplay = await page.locator('#create-select').evaluate(function (el) { return getComputedStyle(el).display; });
    assert.notEqual(selectDisplay, 'none', 'Back from the guard panel must return to the choice screen');
    var blockedDisplay = await page.locator('#create-record-blocked').evaluate(function (el) { return getComputedStyle(el).display; });
    assert.equal(blockedDisplay, 'none', 'Back must hide the guard panel');
    var heading = await page.textContent('#create-heading');
    assert.equal(heading, 'New Dream');

    await page.waitForSelector('#q-grid', { timeout: 5000 });
    assert.equal(await page.locator('#q-speak').count(), 0, 'back on the choice screen, "Speak it instead" is still correctly hidden for this in-app webview UA');
  } finally {
    await context.close();
  }
});
