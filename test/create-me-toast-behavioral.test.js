// test/create-me-toast-behavioral.test.js
//
// Regression coverage for tracker item
// decide-silent-vs-one-time-toast-when-dre-ul3uv9 (Direction B, per
// docs/UNIFIED_IDENTITY_SPEC.md section 3c): create.html's existing
// self-reference auto-attach (typing "I"/"me"/the Me character's own name
// into #dream-text silently adds the saved Me character to the draft) now
// also shows a one-time toast the first time it actually fires per draft --
// "Added your Me character since you mentioned yourself" -- reusing the
// same #toast/.toast/.toast.show markup and showToast() pattern
// profile.html already has (see that page's own showToast()).
//
// Things under test, matching the build task's own acceptance list:
// 1. The toast appears exactly once the first time auto-attach actually
//    attaches the Me character (Write flow).
// 2. It does not appear again on a later re-attach in the *same* draft
//    (the toast-shown flag is independent of, and stricter than, the
//    existing "already attached" no-op guard -- this is checked by forcing
//    a genuine second attach event, not just retyping still-matching text).
// 3. No toast at all when no Me character exists (mirrors the existing
//    "never attaches without a Me character" case in
//    test/profile-me-character-behavioral.test.js).
// 4. The Record flow (transcription-success handler) also actually shows
//    the toast, not just performs the attach -- added after review caught
//    that create.html:~1408-1409 originally called
//    autoSelectSelfIfMentioned() and then `location.href = 'style.html'`
//    synchronously on the very next line, with zero delay, so the toast's
//    classList mutation never got a chance to paint before the page
//    unloaded. The fix makes autoSelectSelfIfMentioned() report whether it
//    just fired the toast, and only then holds navigation for
//    ME_TOAST_NAV_DELAY_MS (matching showToast()'s own 2200ms display
//    window) before navigating on -- every other Record submission
//    (no mention / already attached / no Me character) is unaffected and
//    navigates immediately, same as before.
// 5. The Record flow's "no toast" cases (no mention, no Me character)
//    still navigate to style.html promptly -- confirms the fix adds zero
//    delay for anyone who never triggers the toast.
//
// Follows test/profile-me-character-behavioral.test.js's and
// test/record-mode-behavioral.test.js's own conventions: node:test + real
// Chromium via Playwright (not a project dependency -- resolved from this
// sandbox's global install, see CLAUDE.md), state seeded directly into
// localStorage, page.route() mocks in place of a real Netlify Functions
// runtime for the Record flow's transcribe-audio/transcribe-status calls
// (mirroring test/record-mode-behavioral.test.js's own
// installMediaRecorderMock for getUserMedia/MediaRecorder), and every
// page.goto wrapped against this sandbox's known intermittent outbound-
// network stalls on third-party hosts.

var test = require('node:test');
var assert = require('node:assert/strict');
var staticServer = require('./helpers/static-server');

var CHROMIUM_PATH = '/opt/pw-browsers/chromium';
var EXPECTED_TOAST_TEXT = 'Added your Me character since you mentioned yourself';

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

/** Aborts requests to third-party hosts every page here loads (fonts, PostHog, Meta Pixel) -- none are needed for what these tests check, and this sandbox's outbound network can intermittently stall on them (see CLAUDE.md). */
function blockThirdParty(page) {
  return page.route(/fonts\.(googleapis|gstatic)\.com|connect\.facebook\.net|i\.posthog\.com/, function (route) {
    route.abort();
  });
}

/** Wraps page.goto so a transient network stall on a blocked-in-vain third-party request doesn't crash the whole run -- see CLAUDE.md's environment-quirk note. */
async function safeGoto(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  } catch (e) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  }
}

/**
 * Seeds js/store.js's localStorage state with a logged-in "tester" account
 * and (optionally) an existing self character, then leaves the page on
 * login.html having just done so. Mirrors
 * test/profile-me-character-behavioral.test.js's seedUser.
 */
async function seedUser(page, selfCharacter) {
  await safeGoto(page, baseUrl + '/login.html');
  await page.evaluate(function (selfCharacter) {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@tester', username: 'tester' };
    if (!state.accounts) state.accounts = {};
    state.accounts.tester = { password: 'testpass1', email: 'tester@example.com' };
    if (!state.charactersByUser) state.charactersByUser = {};
    state.charactersByUser.tester = selfCharacter ? [selfCharacter] : [];
    if (!state.dreams) state.dreams = [];
    if (!state.draft) {
      state.draft = { caption: '', style: null, sourceDreamId: null, restore: false, characterIds: [], cameraView: null, sceneryTime: null, sceneryPlace: null };
    } else {
      state.draft.characterIds = [];
      state.draft.caption = '';
    }
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, selfCharacter || null);
}

/** Reads the raw DreamStore state back out of localStorage for direct assertions. Mirrors test/profile-me-character-behavioral.test.js's readState. */
function readState(page) {
  return page.evaluate(function () {
    return JSON.parse(localStorage.getItem('dreamtube_state_v1'));
  });
}

/**
 * Installs a MutationObserver on #toast's class attribute before any page
 * script runs, counting leading-edge "off -> on" transitions of the
 * `.show` class rather than trusting a single waitForSelector snapshot --
 * this is what lets the tests assert "exactly once" / "never again"
 * precisely instead of just "at least once by the time we happened to
 * check". Exposes window.__toastShowCount and window.__lastToastText.
 */
function installToastCounter(page) {
  return page.addInitScript(function () {
    window.__toastShowCount = 0;
    window.__lastToastText = null;
    var wasShowing = false;
    function attach() {
      var toastEl = document.getElementById('toast');
      if (!toastEl) return;
      var obs = new MutationObserver(function () {
        var isShowing = toastEl.classList.contains('show');
        if (isShowing && !wasShowing) {
          window.__toastShowCount++;
          window.__lastToastText = toastEl.textContent;
        }
        wasShowing = isShowing;
      });
      obs.observe(toastEl, { attributes: true, attributeFilter: ['class'] });
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', attach);
    } else {
      attach();
    }
  });
}

/**
 * Installs a minimal fake navigator.mediaDevices.getUserMedia + window.MediaRecorder
 * before any page script runs, so create.html's real startRecordingUI()/
 * stop-record flow can run end to end without a real microphone. Same
 * shape as test/record-mode-behavioral.test.js's own installMediaRecorderMock,
 * scoped to a single page (via page.addInitScript) rather than a context,
 * since this file's other tests use browser.newPage() directly.
 */
function installMediaRecorderMock(page) {
  return page.addInitScript(function () {
    var fakeStream = { getTracks: function () { return []; } };
    if (!navigator.mediaDevices) navigator.mediaDevices = {};
    navigator.mediaDevices.getUserMedia = function () {
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

/**
 * Mocks the Record flow's real transcription calls (transcribe-audio.js
 * submits and returns an operationName, transcribe-status.js is polled
 * until done) so the flow completes instantly with a fixed transcript --
 * no fal.ai cost, no local Netlify Functions runtime needed (mirrors
 * test/profile-me-character-behavioral.test.js's mockGenerateAvatar).
 */
function mockTranscription(page, transcript) {
  return Promise.all([
    page.route('**/.netlify/functions/transcribe-audio', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'test-op-1' }) });
    }),
    page.route('**/.netlify/functions/transcribe-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, transcript: transcript }) });
    })
  ]);
}

/** Drives create.html's real Record flow from the choice screen through to the review screen's "Continue" tap: click Record, wait for the mic UI, stop, wait for the review screen, click Continue. */
async function recordAndSubmit(page) {
  await page.click('#choice-record');
  await page.waitForSelector('#stop-record');
  await page.click('#stop-record');
  await page.waitForSelector('#review-continue:not([disabled])');
  await page.click('#review-continue');
}

test('create.html: shows a one-time toast the first time dream text auto-attaches the Me character, and not again on a later re-attach in the same draft', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await installToastCounter(page);
    await seedUser(page, { id: 'cself-toast1', name: 'Riley', isSelf: true, description: 'short brown hair' });
    await safeGoto(page, baseUrl + '/create.html');
    await page.click('#choice-write');
    await page.click('#adv-toggle');

    // No toast element rendering visibly yet, and nothing attached.
    assert.equal(await page.evaluate(function () { return window.__toastShowCount; }), 0);
    var draftBefore = await page.evaluate(function () { return DreamStore.getDraft().characterIds; });
    assert.equal(draftBefore.length, 0);

    // First trigger: typing "I" auto-attaches the Me character.
    await page.fill('#dream-text', 'I was flying over a neon city at night.');
    await page.waitForSelector('#toast.show');
    assert.equal(await page.locator('#toast').textContent(), EXPECTED_TOAST_TEXT);
    var draftAfterFirst = await page.evaluate(function () { return DreamStore.getDraft().characterIds; });
    assert.deepEqual(draftAfterFirst, ['cself-toast1']);
    assert.equal(await page.evaluate(function () { return window.__toastShowCount; }), 1);
    assert.equal(await page.evaluate(function () { return window.__lastToastText; }), EXPECTED_TOAST_TEXT);

    // Toast auto-hides on its own (matches profile.html's 2200ms timeout).
    await page.waitForSelector('#toast:not(.show)');

    // Continuing to type more text that still matches "I" must not re-fire
    // it -- covers "not on every keystroke that still matches".
    await page.fill('#dream-text', 'I was flying over a neon city at night, and I saw the ocean below.');
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate(function () { return window.__toastShowCount; }), 1, 'must not re-fire while still attached from the same match');

    // Force a genuine second attach event within the same draft (simulating
    // the user removing the character chip, then mentioning themself again)
    // -- this is the case that distinguishes the toast-shown flag from the
    // pre-existing "already attached" no-op guard alone.
    await page.evaluate(function () { DreamStore.setDraft({ characterIds: [] }); });
    await page.fill('#dream-text', '');
    await page.fill('#dream-text', 'Me again, flying over the same neon city.');
    await page.waitForFunction(function () {
      return (DreamStore.getDraft().characterIds || []).indexOf('cself-toast1') !== -1;
    });
    var draftAfterSecond = await page.evaluate(function () { return DreamStore.getDraft().characterIds; });
    assert.deepEqual(draftAfterSecond, ['cself-toast1'], 'the character must genuinely re-attach');
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate(function () { return window.__toastShowCount; }), 1, 'toast must fire only once per draft, even across a real second attach');
  } finally {
    await page.close();
  }
});

test('create.html: no toast when no Me character exists, even though "I"/"me" is in the dream text', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await installToastCounter(page);
    await seedUser(page, null); // no self character at all
    await safeGoto(page, baseUrl + '/create.html');
    await page.click('#choice-write');
    await page.click('#adv-toggle');

    await page.fill('#dream-text', 'I walked through a quiet forest and met an old friend.');
    await page.waitForTimeout(300);

    var draftIds = await page.evaluate(function () { return DreamStore.getDraft().characterIds || []; });
    assert.deepEqual(draftIds, [], 'nothing to attach -- no Me character exists yet');
    assert.equal(await page.evaluate(function () { return window.__toastShowCount; }), 0, 'no toast without a Me character to attach');
    assert.equal(await page.locator('#toast.show').count(), 0);
  } finally {
    await page.close();
  }
});

test('create.html Record flow: the transcription-success handler also shows the one-time toast (not just the attach), and holds navigation until it is actually visible', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await installToastCounter(page);
    await installMediaRecorderMock(page);
    await seedUser(page, { id: 'cself-toast-rec', name: 'Morgan', isSelf: true, description: 'curly hair' });
    await safeGoto(page, baseUrl + '/create.html');
    await mockTranscription(page, 'I flew over the mountains at dawn.');

    await page.click('#choice-record');
    await page.waitForSelector('#stop-record');
    await page.click('#stop-record');
    await page.waitForSelector('#review-continue:not([disabled])');
    await page.click('#review-continue');

    // This is the exact regression review caught: previously
    // location.href = 'style.html' ran synchronously on the very next line
    // after the attach, with no delay -- so the toast's classList mutation
    // never got a chance to be visible before the page unloaded. If that
    // bug were still present, this selector would either time out (page
    // navigated away, #toast no longer exists in this document) or resolve
    // only after navigation already started.
    await page.waitForSelector('#toast.show', { timeout: 5000 });
    assert.match(page.url(), /create\.html/, 'must still be on create.html while the toast is visible -- navigation must not have already happened');
    assert.equal(await page.locator('#toast').textContent(), EXPECTED_TOAST_TEXT);
    assert.equal(await page.evaluate(function () { return window.__toastShowCount; }), 1);

    // The attach itself was never blocked by this fix -- draft persists
    // through to style.html once navigation does happen.
    await page.waitForURL('**/style.html', { timeout: 6000 });
    var state = await readState(page);
    assert.deepEqual(state.draft.characterIds, ['cself-toast-rec']);
  } finally {
    await page.close();
  }
});

test('create.html Record flow: a transcript with no self-mention (Me character exists but unmentioned) navigates to style.html immediately, with no artificial delay and no toast', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await installToastCounter(page);
    await installMediaRecorderMock(page);
    await seedUser(page, { id: 'cself-toast-rec2', name: 'Morgan', isSelf: true, description: 'curly hair' });
    await safeGoto(page, baseUrl + '/create.html');
    await mockTranscription(page, 'A dragon flew across the sky and breathed fire.');

    await page.click('#choice-record');
    await page.waitForSelector('#stop-record');
    await page.click('#stop-record');
    await page.waitForSelector('#review-continue:not([disabled])');
    await page.click('#review-continue');

    // No self-mention -- must reach style.html quickly, with no
    // ME_TOAST_NAV_DELAY_MS-style hold-up added by this fix.
    await page.waitForURL('**/style.html', { timeout: 1500 });
    var state = await readState(page);
    assert.deepEqual(state.draft.characterIds || [], [], 'nothing should have been attached -- no self-mention in the transcript');
    assert.equal(await page.evaluate(function () { return window.__toastShowCount; }), 0, 'no toast when nothing was attached');
  } finally {
    await page.close();
  }
});
