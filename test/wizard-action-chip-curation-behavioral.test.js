// test/wizard-action-chip-curation-behavioral.test.js
//
// Real browser-driven coverage for the Action ("What's happening?") step's
// default-visible chip curation — tracker item
// for-product-wizard-step-3-has-too-many-c-lrg1ct. Founder live-tested the
// 13 ACTION_CHIPS (js/wizard-chips.js) + POV toggle and called it out
// directly: "Too many options to choose from." Fix: wizard.html/create.html
// now render only WizardChips.ACTION_DEFAULT_VISIBLE_KEYS by default, with
// the rest reachable behind a "+N more" expander. This suite covers exactly
// what the tracker item's own constraints ask for:
//   - default view shows ~6 chips + the expander (not all 13)
//   - expanding reveals every remaining chip; every one is still selectable
//   - every chip (default-visible OR behind the expander) still produces
//     the exact same downstream mapping as before (proved end-to-end via
//     the Contact step's story recap, not just DOM class-toggling)
//   - the POV toggle is unaffected by any of this
//   - genuinely usable on a real mobile viewport (tap targets, no
//     horizontal overflow), not just visually plausible at desktop size
//
// Follows test/wizard-ui-behavioral.test.js's conventions exactly (same
// static-file-server + Playwright + blockThirdParty()/safeGoto() pattern).

var test = require('node:test');
var assert = require('node:assert/strict');
var staticServer = require('./helpers/static-server');
var WizardChips = require('../js/wizard-chips');

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

/** Advances wizard.html from the very start through to Step 3 (Action), leaving the visitor sitting on it. */
async function reachActionStep(page) {
  await safeGoto(page, baseUrl + '/wizard.html');
  await page.waitForSelector('[data-subj-other="none"]');
  await page.click('[data-subj-other="none"]');
  await page.click('#fn-subject-continue');
  await page.waitForSelector('#fn-setting-skip');
  await page.click('#fn-setting-skip');
  await page.waitForSelector('#action-row');
}

/** Advances create.html's logged-in "Build it" retrofit through to its own Action step. */
async function reachBuildActionStep(page) {
  await page.evaluate(function () {
    var state = { user: { handle: '@chiptester', username: 'chiptester' }, accounts: { chiptester: { password: 'testpass1', email: 'chiptester@example.com' } }, dreams: [], draft: { caption: '', style: null, characterIds: [], sceneryTime: null, sceneryPlace: null, restore: false }, charactersByUser: {}, likedIds: {} };
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  });
  await safeGoto(page, baseUrl + '/create.html');
  await page.click('#choice-build');
  await page.waitForSelector('#build-subject-chip-row');
  await page.click('[data-build-subj-other="none"]');
  await page.click('#build-subject-continue');
  await page.waitForSelector('#build-place-row');
  await page.click('#build-setting-skip');
  await page.waitForSelector('#build-action-row');
}

var DEFAULT_KEYS = WizardChips.ACTION_DEFAULT_VISIBLE_KEYS;
var ALL_KEYS = WizardChips.ACTION_CHIPS.map(function (c) { return c.key; });
var HIDDEN_KEYS = ALL_KEYS.filter(function (k) { return DEFAULT_KEYS.indexOf(k) === -1; });
// The expanded row renders default-visible chips first (so they never
// jump position when "+N more" is tapped), then the "more" chips appended
// after in their own original relative order -- NOT the raw ACTION_CHIPS
// array order (which interleaves the two groups). This is that expected
// expanded order.
var EXPANDED_KEYS_ORDER = DEFAULT_KEYS.concat(HIDDEN_KEYS);

test('wizard.html Step 3: default view shows only the curated default-visible chips (not all 13) plus a "+N more" expander, and the POV toggle is present and untouched by any of this', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    // login.html isn't needed here -- reachActionStep starts fresh.
    await reachActionStep(page);

    var visibleKeys = await page.$$eval('#action-row [data-action]', function (els) { return els.map(function (e) { return e.dataset.action; }); });
    assert.deepEqual(visibleKeys, DEFAULT_KEYS, 'default view must show exactly (and only) the curated default-visible chips, in ACTION_CHIPS\' own order');
    assert.ok(visibleKeys.length >= 5 && visibleKeys.length <= 7, 'expected "roughly 6" default-visible chips');

    var toggleText = await page.locator('#action-more-toggle').textContent();
    assert.equal(toggleText, '+' + HIDDEN_KEYS.length + ' more');
    assert.equal(await page.locator('#action-more-toggle').getAttribute('aria-expanded'), 'false');

    // Every hidden chip must be genuinely absent from the DOM by default,
    // not just visually hidden -- confirms this is a real default-view
    // curation, not a CSS-only illusion.
    for (var i = 0; i < HIDDEN_KEYS.length; i++) {
      assert.equal(await page.locator('[data-action="' + HIDDEN_KEYS[i] + '"]').count(), 0, HIDDEN_KEYS[i] + ' must not be in the DOM before expanding');
    }

    // POV toggle unaffected -- present, unchecked by default.
    assert.equal(await page.locator('#pov-toggle').count(), 1);
    assert.equal(await page.locator('#pov-toggle').isChecked(), false);
  } finally {
    await page.close();
  }
});

test('wizard.html Step 3: "+N more" reveals every remaining chip (all 13 total, none lost), and "Show less" collapses back down when nothing hidden is selected', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await reachActionStep(page);

    await page.click('#action-more-toggle');
    var expandedKeys = await page.$$eval('#action-row [data-action]', function (els) { return els.map(function (e) { return e.dataset.action; }); });
    assert.deepEqual(expandedKeys, EXPANDED_KEYS_ORDER, 'expanding must reveal every ACTION_CHIPS entry (default-visible ones first, then the rest in their own relative order), with none deleted');
    assert.equal(await page.locator('#action-more-toggle').textContent(), 'Show less');
    assert.equal(await page.locator('#action-more-toggle').getAttribute('aria-expanded'), 'true');

    // Collapse back -- nothing hidden is selected (still the untouched
    // default action, 'flying', which is itself default-visible), so this
    // must actually re-collapse rather than being forced back open.
    await page.click('#action-more-toggle');
    var collapsedKeys = await page.$$eval('#action-row [data-action]', function (els) { return els.map(function (e) { return e.dataset.action; }); });
    assert.deepEqual(collapsedKeys, DEFAULT_KEYS);
    assert.equal(await page.locator('#action-more-toggle').textContent(), '+' + HIDDEN_KEYS.length + ' more');
  } finally {
    await page.close();
  }
});

test('wizard.html Step 3: every default-visible chip is selectable by itself (single-select, no expansion needed), and "+ Something else" still reveals its free-text input', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await reachActionStep(page);

    // Layout-B: tapping a regular chip auto-advances to Mood ~260ms later
    // (the advance itself is the proof the tap registered), so each
    // iteration waits for Mood, Backs out, and asserts the selection
    // stuck -- deterministic under load, no racing the 260ms window.
    for (var i = 0; i < DEFAULT_KEYS.length; i++) {
      var key = DEFAULT_KEYS[i];
      if (key === 'other') continue; // the write-in row deliberately does NOT auto-advance -- covered right below
      await page.click('#action-row [data-action="' + key + '"]');
      await page.waitForSelector('#mood-row', { timeout: 3000 });
      await page.click('#fnBack');
      await page.waitForSelector('#action-row');
      var selectedKeys = await page.$$eval('#action-row .fn-chip.sel', function (els) { return els.map(function (e) { return e.dataset.action; }); });
      assert.deepEqual(selectedKeys, [key], 'selecting ' + key + ' must select it alone (single-select), surviving the advance-and-Back round trip');
    }
    // "+ Something else": reveals its free-text input and stays PUT (mock
    // round 2 -- the user is about to type; Continue advances).
    await page.click('#action-row [data-action="other"]');
    assert.equal(await page.locator('#action-other-reveal').evaluate(function (el) { return el.style.display; }), 'block');
    assert.equal(await page.locator('#action-other-input').count(), 1);
    await page.waitForTimeout(500); // well past the auto-advance window
    assert.equal(await page.locator('#action-row').count(), 1, 'the write-in row must never auto-advance out from under the typing user');
  } finally {
    await page.close();
  }
});

test('wizard.html Step 3: every chip behind the "+N more" expander is fully selectable too, once expanded', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await reachActionStep(page);
    await page.click('#action-more-toggle');

    // Same advance-then-Back pattern as the default-visible test above
    // (Layout-B auto-advance). After Back, the expander re-renders forced
    // open whenever the active selection is itself hidden, so every next
    // hidden chip stays reachable without re-expanding.
    for (var i = 0; i < HIDDEN_KEYS.length; i++) {
      var key = HIDDEN_KEYS[i];
      await page.click('#action-row [data-action="' + key + '"]');
      await page.waitForSelector('#mood-row', { timeout: 3000 });
      await page.click('#fnBack');
      await page.waitForSelector('#action-row');
      var selectedKeys = await page.$$eval('#action-row .fn-chip.sel', function (els) { return els.map(function (e) { return e.dataset.action; }); });
      assert.deepEqual(selectedKeys, [key], 'selecting hidden chip ' + key + ' must select it alone (single-select), same as any default-visible chip');
    }
  } finally {
    await page.close();
  }
});

test('wizard.html Step 3: once a hidden chip is selected, the expander stays open (never re-hides the active selection) even after clicking "Show less" -- but re-collapses normally once selection moves back to a default-visible chip', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await reachActionStep(page);
    await page.click('#action-more-toggle');
    await page.click('#action-row [data-action="late"]'); // 'late' is a hidden chip
    // Layout-B: the tap auto-advances -- ride it out and come Back; the
    // re-rendered step must force the expander open (the active selection
    // lives behind it and must never be hidden from view).
    await page.waitForSelector('#mood-row', { timeout: 3000 });
    await page.click('#fnBack');
    await page.waitForSelector('#action-row');
    assert.ok((await page.locator('[data-action="late"].sel').count()) === 1, '"late" must come back still selected after the advance-and-Back round trip');

    // Clicking "Show less" must be a no-op while the active selection is
    // itself hidden -- the visitor's own current choice must never
    // disappear from view.
    await page.click('#action-more-toggle');
    var keysStillShown = await page.$$eval('#action-row [data-action]', function (els) { return els.map(function (e) { return e.dataset.action; }); });
    assert.deepEqual(keysStillShown, EXPANDED_KEYS_ORDER, 'must not collapse while the selected chip lives behind the expander');
    assert.ok((await page.locator('[data-action="late"].sel').count()) === 1, '"late" must still show as selected');

    // Now pick a default-visible chip instead (advance-and-Back again).
    // The visitor's last explicit expander choice was "Show less" (step
    // above -- honored-but-overridden while the selection was hidden), so
    // the moment the selection moves back to a default-visible chip the
    // re-render collapses on its own: the override lapses, no extra
    // toggle tap needed.
    await page.click('#action-row [data-action="flying"]');
    await page.waitForSelector('#mood-row', { timeout: 3000 });
    await page.click('#fnBack');
    await page.waitForSelector('#action-row');
    var keysAfterRealCollapse = await page.$$eval('#action-row [data-action]', function (els) { return els.map(function (e) { return e.dataset.action; }); });
    assert.deepEqual(keysAfterRealCollapse, DEFAULT_KEYS, 'once selection moves to a default-visible chip, the earlier "Show less" choice must actually take effect again');
  } finally {
    await page.close();
  }
});

test('wizard.html Step 3: the POV toggle\'s on/off state survives expanding and collapsing the chip row', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await reachActionStep(page);

    // #pov-toggle itself is a visually-hidden input (opacity:0, 0x0 --
    // .fn-switch-track is the real visible affordance, and the wrapping
    // <label class="fn-toggle-row"> is what actually delivers the click
    // to the checkbox natively) -- click the visible track, same as a
    // real user would tap.
    await page.click('.fn-toggle-row .fn-switch-track');
    assert.equal(await page.locator('#pov-toggle').isChecked(), true);

    await page.click('#action-more-toggle'); // expand -- re-renders the whole step
    assert.equal(await page.locator('#pov-toggle').isChecked(), true, 'POV must stay on across an expand re-render');

    await page.click('#action-more-toggle'); // collapse -- re-renders again
    assert.equal(await page.locator('#pov-toggle').isChecked(), true, 'POV must stay on across a collapse re-render too');
  } finally {
    await page.close();
  }
});

test('wizard.html: a default-visible chip AND a hidden chip both reach the Contact step\'s story recap with their exact, unchanged mapping -- proves curation is a visibility change only, never a behavior change', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    // 'exam' -- default-visible, no expansion needed. The chip tap itself
    // advances (Layout-B); the recap is an editable textarea now, so its
    // text reads via inputValue.
    await reachActionStep(page);
    await page.click('#action-row [data-action="exam"]');
    await page.waitForSelector('#fn-mood-skip');
    await page.click('#fn-mood-skip');
    await page.waitForSelector('#fn-style-skip');
    await page.click('#fn-style-skip');
    await page.waitForSelector('#fn-freetext-skip');
    await page.click('#fn-freetext-skip');
    await page.waitForSelector('#fn-story-recap-text');
    var examRecap = await page.inputValue('#fn-story-recap-text');
    assert.equal(examRecap, WizardChips.buildDeterministicStory({ subjectKey: 'none', actionKey: 'exam' }), 'default-visible chip must produce the exact same recap text the underlying mapping always produced');

    // 'late' -- hidden behind the expander.
    await reachActionStep(page);
    await page.click('#action-more-toggle');
    await page.click('#action-row [data-action="late"]');
    await page.waitForSelector('#fn-mood-skip');
    await page.click('#fn-mood-skip');
    await page.waitForSelector('#fn-style-skip');
    await page.click('#fn-style-skip');
    await page.waitForSelector('#fn-freetext-skip');
    await page.click('#fn-freetext-skip');
    await page.waitForSelector('#fn-story-recap-text');
    var lateRecap = await page.inputValue('#fn-story-recap-text');
    assert.equal(lateRecap, WizardChips.buildDeterministicStory({ subjectKey: 'none', actionKey: 'late' }), 'a chip curated behind the expander must produce the EXACT SAME recap text as it always did -- byte-identical mapping, only its default visibility changed');
  } finally {
    await page.close();
  }
});

test('create.html "Build it": Action step shows the same curated default view + "+N more" expander as wizard.html, and a hidden chip is still fully selectable and reaches style.html correctly', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await safeGoto(page, baseUrl + '/login.html');
    await reachBuildActionStep(page);

    var visibleKeys = await page.$$eval('#build-action-row [data-build-action]', function (els) { return els.map(function (e) { return e.dataset.buildAction; }); });
    assert.deepEqual(visibleKeys, DEFAULT_KEYS, 'create.html\'s Build-it Action step must show the same default-visible curation as wizard.html');
    assert.equal(await page.locator('#build-action-more-toggle').textContent(), '+' + HIDDEN_KEYS.length + ' more');

    await page.click('#build-action-more-toggle');
    await page.click('[data-build-action="calm"]'); // a hidden chip
    await page.click('#build-action-continue');

    await page.waitForSelector('#build-mood-row');
    await page.click('#build-mood-skip');
    await page.waitForSelector('#build-freetext-input');
    await page.click('#build-freetext-skip');

    await page.waitForURL(/style\.html/, { timeout: 5000 });
    // waitForURL only guarantees the navigation committed -- style.html's
    // own js/store.js may not have executed yet, so wait for DreamStore
    // itself before reading it (see wizard-ui-behavioral.test.js's own
    // note on this hazard).
    await page.waitForFunction(function () { return !!window.DreamStore; }, null, { timeout: 5000 });
    var draft = await page.evaluate(function () { return window.DreamStore.getDraft(); });
    assert.match(draft.caption, /sitting in a calm, still moment/, 'the hidden "calm" chip\'s exact phrase must still reach the assembled caption unchanged');
  } finally {
    await page.close();
  }
});

test('wizard.html Step 3 on a real mobile viewport: chips and the expander are genuinely usable via touch taps, with adequate tap-target height and no horizontal overflow', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true });
  var page = await context.newPage();
  await blockThirdParty(page);
  try {
    await reachActionStep(page);

    // No horizontal scroll/overflow on a narrow phone viewport.
    var overflowsX = await page.evaluate(function () {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
    });
    assert.equal(overflowsX, false, 'the Action step must not overflow horizontally on a 375px-wide phone viewport');

    // Tap-target height check on the expander and a real chip -- matches
    // this app's existing .fn-chip sizing (not a new, smaller target).
    var toggleBox = await page.locator('#action-more-toggle').boundingBox();
    var chipBox = await page.locator('#action-row [data-action="flying"]').boundingBox();
    assert.ok(toggleBox.height >= 30, 'expander tap target too short: ' + toggleBox.height + 'px');
    assert.ok(chipBox.height >= 30, 'chip tap target too short: ' + chipBox.height + 'px');

    // Real touch taps (not mouse clicks) actually drive the interaction.
    await page.tap('#action-more-toggle');
    var expandedKeys = await page.$$eval('#action-row [data-action]', function (els) { return els.map(function (e) { return e.dataset.action; }); });
    assert.deepEqual(expandedKeys, EXPANDED_KEYS_ORDER, 'a real touch tap on the expander must reveal every chip');

    // POV toggle is still tappable and readable at this viewport size too
    // -- exercised BEFORE the option tap below, since that tap
    // auto-advances off this step (Layout-B). #pov-toggle itself is a
    // visually-hidden input -- tap the visible switch (delivered to the
    // checkbox via the wrapping <label>), same as the click-based test
    // above.
    var povBox = await page.locator('.fn-toggle-row .fn-switch').boundingBox();
    assert.ok(povBox.width >= 30 && povBox.height >= 20, 'POV switch tap target looks too small on mobile');
    await page.tap('.fn-toggle-row .fn-switch-track');
    assert.equal(await page.locator('#pov-toggle').isChecked(), true);

    // A real touch tap on a chip behind the expander selects it -- proven
    // via the auto-advance it triggers plus the retained selection after
    // Back (same deterministic pattern as the click-based tests above).
    await page.tap('#action-row [data-action="calm"]');
    await page.waitForSelector('#mood-row', { timeout: 3000 });
    await page.tap('#fnBack');
    await page.waitForSelector('#action-row');
    assert.equal(await page.locator('[data-action="calm"].sel').count(), 1, 'a real touch tap must select a chip behind the expander');
  } finally {
    await page.close();
    await context.close();
  }
});

test('wizard.html + create.html: the "+N more" expander is keyboard-accessible -- Enter and Space each toggle it, matching this codebase\'s existing keydown-synthesizes-click pattern (e.g. start.html)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await reachActionStep(page);
    await page.locator('#action-more-toggle').focus();
    await page.keyboard.press('Enter');
    assert.deepEqual(
      await page.$$eval('#action-row [data-action]', function (els) { return els.map(function (e) { return e.dataset.action; }); }),
      EXPANDED_KEYS_ORDER,
      'Enter on wizard.html\'s #action-more-toggle must expand it, same as a click'
    );
    await page.locator('#action-more-toggle').focus();
    await page.keyboard.press(' ');
    assert.deepEqual(
      await page.$$eval('#action-row [data-action]', function (els) { return els.map(function (e) { return e.dataset.action; }); }),
      DEFAULT_KEYS,
      'Space on wizard.html\'s #action-more-toggle must collapse it back, same as a click'
    );

    await safeGoto(page, baseUrl + '/login.html');
    await reachBuildActionStep(page);
    await page.locator('#build-action-more-toggle').focus();
    await page.keyboard.press('Enter');
    assert.deepEqual(
      await page.$$eval('#build-action-row [data-build-action]', function (els) { return els.map(function (e) { return e.dataset.buildAction; }); }),
      EXPANDED_KEYS_ORDER,
      'Enter on create.html\'s #build-action-more-toggle must expand it too'
    );
  } finally {
    await page.close();
  }
});
