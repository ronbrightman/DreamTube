// test/tracker-speak-behavioral.test.js
//
// Real browser-driven regression coverage for tracker.html's "Read aloud"
// button (tracker item for-product-tracker-add-a-text-to-speech-wq7nzo):
// "add a play button on tracker.html items so he can hear an item read
// aloud instead of reading a long thread. Use the browser SpeechSynthesis
// API (no backend/cost). Read the title + latest comments." See
// tracker.html's SPEECH_SUPPORTED/speakingId/buildSpeechText/
// handleSpeakToggle for the implementation.
//
// Real speech synthesis can't meaningfully run inside a headless test
// browser, so these tests stub window.speechSynthesis /
// SpeechSynthesisUtterance in the test's own page.addInitScript(),
// following the same style as this file's installMediaRecorderMock
// (test/record-mode-behavioral.test.js) for MediaRecorder/getUserMedia —
// the closest existing precedent in this repo for mocking a browser API
// this suite can't exercise for real. Follows the same node:test +
// Playwright + static-file-server convention, and the same
// skip-if-unavailable guard, as test/tracker-behavioral.test.js.

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

function blockThirdParty(page) {
  return page.route(/fonts\.(googleapis|gstatic)\.com|connect\.facebook\.net|i\.posthog\.com/, function (route) {
    route.abort();
  });
}

var OWNER_EMAIL = 'owner@example.com';

var SEED_ITEMS = [
  {
    id: 'item-a', category: 'task', title: 'Item A', detail: 'Detail A explains what item A is.',
    priority: 'medium', done: false, createdAt: null, doneAt: null, startedAt: null,
    comments: [
      { author: 'claude', text: 'First comment on A.', timestamp: '2026-07-01T10:00:00.000Z' },
      { author: 'ron', text: 'Most recent comment on A.', timestamp: '2026-07-02T10:00:00.000Z' }
    ]
  },
  {
    id: 'item-b', category: 'task', title: 'Item B', detail: 'Detail B explains what item B is.',
    priority: 'medium', done: false, createdAt: null, doneAt: null, startedAt: null,
    comments: [
      { author: 'ron', text: 'Only comment on B.', timestamp: '2026-07-01T10:00:00.000Z' }
    ]
  },
  {
    id: 'item-c', category: 'task', title: 'Item C', detail: 'Detail C explains what item C is.',
    priority: 'medium', done: false, createdAt: null, doneAt: null, startedAt: null,
    comments: []
  }
];

/**
 * Installs a fake window.speechSynthesis + SpeechSynthesisUtterance before
 * any page script runs, same technique/placement as
 * record-mode-behavioral.test.js's installMediaRecorderMock. Records every
 * speak()'d utterance's text plus a running cancel() count on `window`, and
 * keeps a handle to the most recently spoken utterance so a test can fire
 * its onend/onerror manually (there is no real speech to wait on).
 */
async function installSpeechSynthesisMock(context) {
  await context.addInitScript(function () {
    window.__speakCalls = [];
    window.__cancelCalls = 0;
    window.__lastUtterance = null;

    function FakeUtterance(text) {
      this.text = text;
      this.onend = null;
      this.onerror = null;
    }

    var fakeSpeechSynthesis = {
      speak: function (utterance) {
        window.__speakCalls.push(utterance.text);
        window.__lastUtterance = utterance;
      },
      cancel: function () {
        window.__cancelCalls++;
      }
    };

    // window.speechSynthesis is a read-only [SameObject] IDL attribute in
    // real engines, and window.SpeechSynthesisUtterance is the interface's
    // constructor property -- a plain `window.speechSynthesis = ...`
    // assignment silently no-ops against the real getter-only property in
    // sloppy-mode script (no throw, no effect), leaving tracker.html
    // talking to the REAL browser SpeechSynthesis with our FakeUtterance
    // instances, which then throws
    // "Failed to execute 'speak' on 'SpeechSynthesis': parameter 1 is not
    // of type 'SpeechSynthesisUtterance'" the moment it's actually
    // exercised. Object.defineProperty with configurable:true reliably
    // overrides both, same fix used below for the "unsupported" test.
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: FakeUtterance, configurable: true });
    Object.defineProperty(window, 'speechSynthesis', { value: fakeSpeechSynthesis, configurable: true });
  });
}

/** Same seedOwnerAndGoToTracker as tracker-behavioral.test.js, parameterized on SEED_ITEMS above (which include comments, unlike that file's plain seed set) so these tests can assert on the exact spoken text. */
async function seedOwnerAndGoToTracker(page) {
  await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function (email) {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@owner', username: 'owner' };
    if (!state.accounts) state.accounts = {};
    state.accounts.owner = { password: 'ownerpass1', email: email };
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, OWNER_EMAIL);

  await page.route('**/.netlify/functions/admin-paywall-toggle**', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ isOwner: true }) });
  });
  await page.route('**/.netlify/functions/get-tracker-items', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: SEED_ITEMS }) });
  });

  await page.goto(baseUrl + '/tracker.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#tracker-content[style*="display: block"]', { timeout: 5000 });
}

test('clicking an item\'s Read aloud button speaks title + detail + its latest comment (not older ones)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await installSpeechSynthesisMock(context);
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedOwnerAndGoToTracker(page);

    await page.click('[data-id="item-a"] .tracker-speak-btn');

    var calls = await page.evaluate(function () { return window.__speakCalls; });
    assert.equal(calls.length, 1, 'speak() must be called exactly once');
    assert.match(calls[0], /Item A/, 'spoken text must include the item title');
    assert.match(calls[0], /Detail A explains what item A is/, 'spoken text must include the item detail');
    assert.match(calls[0], /Most recent comment on A/, 'spoken text must include the latest comment');
    assert.doesNotMatch(calls[0], /First comment on A/, 'spoken text must NOT include an older comment, only the latest');

    var pressed = await page.getAttribute('[data-id="item-a"] .tracker-speak-btn', 'aria-pressed');
    assert.equal(pressed, 'true', 'the button must show a pressed/playing state immediately after speak() is triggered');
  } finally {
    await context.close();
  }
});

test('clicking a different item\'s Read aloud button while one is playing cancels the first and starts the second', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await installSpeechSynthesisMock(context);
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedOwnerAndGoToTracker(page);

    await page.click('[data-id="item-a"] .tracker-speak-btn');
    var pressedA1 = await page.getAttribute('[data-id="item-a"] .tracker-speak-btn', 'aria-pressed');
    assert.equal(pressedA1, 'true', 'item A must be playing after its own button is clicked');

    await page.click('[data-id="item-b"] .tracker-speak-btn');

    var cancelCalls = await page.evaluate(function () { return window.__cancelCalls; });
    assert.ok(cancelCalls >= 1, 'speechSynthesis.cancel() must be called when switching to a different item');

    var calls = await page.evaluate(function () { return window.__speakCalls; });
    assert.equal(calls.length, 2, 'speak() must have been called once for A, once for B');
    assert.match(calls[1], /Item B/, 'the second speak() call must be for item B');

    var pressedA2 = await page.getAttribute('[data-id="item-a"] .tracker-speak-btn', 'aria-pressed');
    var pressedB = await page.getAttribute('[data-id="item-b"] .tracker-speak-btn', 'aria-pressed');
    assert.equal(pressedA2, 'false', 'item A must no longer show as playing once B has started');
    assert.equal(pressedB, 'true', 'item B must now show as playing');
  } finally {
    await context.close();
  }
});

test('clicking the same item\'s Read aloud button again while it is playing stops it (no second speak() call)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await installSpeechSynthesisMock(context);
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedOwnerAndGoToTracker(page);

    await page.click('[data-id="item-a"] .tracker-speak-btn');
    await page.click('[data-id="item-a"] .tracker-speak-btn');

    var calls = await page.evaluate(function () { return window.__speakCalls; });
    assert.equal(calls.length, 1, 'a second click on the SAME playing item must stop it, not start a new utterance');

    var cancelCalls = await page.evaluate(function () { return window.__cancelCalls; });
    assert.ok(cancelCalls >= 1, 'cancel() must be called to stop the currently playing item');

    var pressed = await page.getAttribute('[data-id="item-a"] .tracker-speak-btn', 'aria-pressed');
    assert.equal(pressed, 'false', 'the button must revert to not-playing once stopped');
  } finally {
    await context.close();
  }
});

test('the playing state reverts to not-playing when the utterance\'s onend fires naturally', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await installSpeechSynthesisMock(context);
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedOwnerAndGoToTracker(page);

    await page.click('[data-id="item-a"] .tracker-speak-btn');
    var pressedWhilePlaying = await page.getAttribute('[data-id="item-a"] .tracker-speak-btn', 'aria-pressed');
    assert.equal(pressedWhilePlaying, 'true');

    // Simulate the browser finishing speech on its own -- no real speech
    // to wait on, so the mocked utterance's onend is invoked directly.
    await page.evaluate(function () { window.__lastUtterance.onend(); });

    await page.waitForFunction(function () {
      var btn = document.querySelector('[data-id="item-a"] .tracker-speak-btn');
      return btn && btn.getAttribute('aria-pressed') === 'false';
    }, { timeout: 5000 });

    var isSpeakingClass = await page.evaluate(function () {
      var btn = document.querySelector('[data-id="item-a"] .tracker-speak-btn');
      return btn.classList.contains('is-speaking');
    });
    assert.equal(isSpeakingClass, false, 'the is-speaking visual class must be removed once onend fires');
  } finally {
    await context.close();
  }
});

test('the playing state reverts to not-playing when the utterance\'s onerror fires (mirrors the onend path)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await installSpeechSynthesisMock(context);
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedOwnerAndGoToTracker(page);

    await page.click('[data-id="item-a"] .tracker-speak-btn');
    var pressedWhilePlaying = await page.getAttribute('[data-id="item-a"] .tracker-speak-btn', 'aria-pressed');
    assert.equal(pressedWhilePlaying, 'true');

    // Simulate the browser failing mid-speech -- onerror shares onend's
    // reset logic, but nothing else in this suite actually triggers it.
    await page.evaluate(function () { window.__lastUtterance.onerror(); });

    await page.waitForFunction(function () {
      var btn = document.querySelector('[data-id="item-a"] .tracker-speak-btn');
      return btn && btn.getAttribute('aria-pressed') === 'false';
    }, { timeout: 5000 });

    var isSpeakingClass = await page.evaluate(function () {
      var btn = document.querySelector('[data-id="item-a"] .tracker-speak-btn');
      return btn.classList.contains('is-speaking');
    });
    assert.equal(isSpeakingClass, false, 'the is-speaking visual class must be removed once onerror fires');
  } finally {
    await context.close();
  }
});

test('deleting the item currently being read aloud stops the speech, not just the UI', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await installSpeechSynthesisMock(context);
    var page = await context.newPage();
    await blockThirdParty(page);
    page.on('dialog', function (dialog) { dialog.accept(); });

    var deleteCalled = false;
    await page.route('**/.netlify/functions/delete-tracker-item', function (route) {
      deleteCalled = true;
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await seedOwnerAndGoToTracker(page);

    await page.click('[data-id="item-a"] .tracker-speak-btn');
    var cancelCallsBeforeDelete = await page.evaluate(function () { return window.__cancelCalls; });
    assert.equal(cancelCallsBeforeDelete, 1, 'sanity: speak() already issued its own leading cancel() call');

    await page.click('[data-id="item-a"] .tracker-delete-btn');
    await page.waitForFunction(function () { return document.querySelector('[data-id="item-a"]') === null; }, { timeout: 5000 });

    var cancelCallsAfterDelete = await page.evaluate(function () { return window.__cancelCalls; });
    assert.equal(cancelCallsAfterDelete, cancelCallsBeforeDelete + 1, 'deleting the currently-speaking item must call speechSynthesis.cancel() again, not just remove its UI');
    assert.equal(deleteCalled, true, 'sanity: the delete itself still went through');
  } finally {
    await context.close();
  }
});

test('an item with no comments still speaks its title + detail only, with no error', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await installSpeechSynthesisMock(context);
    var page = await context.newPage();
    await blockThirdParty(page);

    // Only uncaught JS exceptions are the real signal here -- console
    // 'error' also picks up the blockThirdParty route.abort() noise (fonts/
    // analytics requests every page on this site makes), which is expected
    // and unrelated to this feature, same as every other test in this
    // suite that uses blockThirdParty.
    var pageErrors = [];
    page.on('pageerror', function (err) { pageErrors.push(String(err)); });

    await seedOwnerAndGoToTracker(page);

    await page.click('[data-id="item-c"] .tracker-speak-btn');

    var calls = await page.evaluate(function () { return window.__speakCalls; });
    assert.equal(calls.length, 1);
    assert.match(calls[0], /Item C/, 'spoken text must include the title');
    assert.match(calls[0], /Detail C explains what item C is/, 'spoken text must include the detail');
    assert.doesNotMatch(calls[0], /Latest comment/, 'an item with no comments must not mention a latest comment at all');

    assert.deepEqual(pageErrors, [], 'no uncaught page error for an item with no comments');
  } finally {
    await context.close();
  }
});

test('when window.speechSynthesis is unavailable, no Read aloud button is rendered and nothing errors', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    // Deliberately do NOT install the speechSynthesis mock -- instead force
    // it to be entirely absent, matching a browser/embedded context with no
    // Web Speech API at all (see tracker.html's SPEECH_SUPPORTED guard).
    // Object.defineProperty (not `delete`) because window.speechSynthesis
    // is a getter-backed [SameObject] property in real engines -- a plain
    // `delete` can silently no-op and leave the real object in place.
    await context.addInitScript(function () {
      Object.defineProperty(window, 'speechSynthesis', { value: undefined, configurable: true });
      Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: undefined, configurable: true });
    });
    var page = await context.newPage();
    await blockThirdParty(page);

    var pageErrors = [];
    page.on('pageerror', function (err) { pageErrors.push(String(err)); });

    await seedOwnerAndGoToTracker(page);

    var speakBtnCount = await page.locator('.tracker-speak-btn').count();
    assert.equal(speakBtnCount, 0, 'no Read aloud button should render at all when speechSynthesis is unsupported');
    assert.deepEqual(pageErrors, [], 'no uncaught page error when speechSynthesis is unsupported');
  } finally {
    await context.close();
  }
});
