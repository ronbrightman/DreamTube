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
// Three things under test, matching the build task's own acceptance list:
// 1. The toast appears exactly once the first time auto-attach actually
//    attaches the Me character.
// 2. It does not appear again on a later re-attach in the *same* draft
//    (the toast-shown flag is independent of, and stricter than, the
//    existing "already attached" no-op guard -- this is checked by forcing
//    a genuine second attach event, not just retyping still-matching text).
// 3. No toast at all when no Me character exists (mirrors the existing
//    "never attaches without a Me character" case in
//    test/profile-me-character-behavioral.test.js).
//
// Follows that file's own conventions: node:test + real Chromium via
// Playwright (not a project dependency -- resolved from this sandbox's
// global install, see CLAUDE.md), state seeded directly into localStorage,
// and every page.goto wrapped against this sandbox's known intermittent
// outbound-network stalls on third-party hosts.

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
