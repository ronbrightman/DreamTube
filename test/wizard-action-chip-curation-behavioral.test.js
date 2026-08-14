// test/wizard-action-chip-curation-behavioral.test.js
//
// Real browser-driven coverage for the Action ("What's happening?") step's
// default-visible chip curation — tracker item
// for-product-wizard-step-3-has-too-many-c-lrg1ct. Founder live-tested the
// 13 ACTION_CHIPS (js/wizard-chips.js) + POV toggle and called it out
// directly: "Too many options to choose from." Fix: the Action step renders
// only WizardChips.ACTION_DEFAULT_VISIBLE_KEYS by default, with the rest
// reachable behind a "+N more" expander.
//
// RETARGETED 2026-08-14 (unify-all-creation-flows, founder): this suite used
// to drive wizard.html's OWN chip-build Action step, but that flow is retired
// to a funnel-arrival receiver (a bare wizard.html hit now redirects to /go/),
// so it is no longer user-reachable. The IDENTICAL curation UI is still LIVE on
// create.html's logged-in "Build it" Action step (same WizardChips-driven
// render: #build-action-row / #build-action-more-toggle / #build-pov-toggle),
// so every test below now exercises that live surface. The chip-key mapping
// itself (which chips are default-visible, and each chip's downstream phrase)
// is separately unit-covered in test/wizard-chips.test.js
// (ACTION_DEFAULT_VISIBLE_KEYS subset + per-chip phrase tests).
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

/** Seeds a logged-in account (needs a loaded same-origin page first) and advances create.html's "Build it" retrofit through to its own Action step. */
async function reachBuildActionStep(page) {
  await safeGoto(page, baseUrl + '/login.html');
  await page.evaluate(function () {
    var state = { user: { handle: '@chiptester', username: 'chiptester' }, accounts: { chiptester: { password: 'testpass1', email: 'chiptester@example.com' } }, dreams: [], draft: { caption: '', style: null, characterIds: [], sceneryTime: null, sceneryPlace: null, restore: false }, charactersByUser: {}, likedIds: {} };
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  });
  await safeGoto(page, baseUrl + '/create.html');
  await page.click('#choice-build');
  await page.waitForSelector('#build-subject-chip-row');
  await page.click('[data-build-subj-other="none"]');
  await page.click('#build-subject-continue');
  // 3-question trim (founder 08-13): Subject leads straight to Action — no
  // Setting step in between (it's inferred), same as the funnel.
  await page.waitForSelector('#build-action-row');
}

var DEFAULT_KEYS = WizardChips.ACTION_DEFAULT_VISIBLE_KEYS;
var ALL_KEYS = WizardChips.ACTION_CHIPS.map(function (c) { return c.key; });
var HIDDEN_KEYS = ALL_KEYS.filter(function (k) { return DEFAULT_KEYS.indexOf(k) === -1; });
// The expanded row renders default-visible chips first (so they never jump
// position when "+N more" is tapped), then the "more" chips appended after in
// their own original relative order -- NOT the raw ACTION_CHIPS array order.
var EXPANDED_KEYS_ORDER = DEFAULT_KEYS.concat(HIDDEN_KEYS);

function actionKeys(page) {
  return page.$$eval('#build-action-row [data-build-action]', function (els) { return els.map(function (e) { return e.dataset.buildAction; }); });
}

test('create.html Build Action step: the default view shows only the curated default-visible chips (not all 13) plus a "+N more" expander, and the POV toggle is present and untouched', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await reachBuildActionStep(page);

    var visibleKeys = await actionKeys(page);
    assert.deepEqual(visibleKeys, DEFAULT_KEYS, 'default view must show exactly (and only) the curated default-visible chips, in ACTION_CHIPS\' own order');
    assert.ok(visibleKeys.length >= 5 && visibleKeys.length <= 7, 'expected "roughly 6" default-visible chips');

    var toggleText = await page.locator('#build-action-more-toggle').textContent();
    assert.equal(toggleText, '+' + HIDDEN_KEYS.length + ' more');
    assert.equal(await page.locator('#build-action-more-toggle').getAttribute('aria-expanded'), 'false');

    // Every hidden chip must be genuinely absent from the DOM by default, not
    // just visually hidden -- confirms a real default-view curation.
    for (var i = 0; i < HIDDEN_KEYS.length; i++) {
      assert.equal(await page.locator('#build-action-row [data-build-action="' + HIDDEN_KEYS[i] + '"]').count(), 0, HIDDEN_KEYS[i] + ' must not be in the DOM before expanding');
    }

    // POV toggle unaffected -- present, unchecked by default.
    assert.equal(await page.locator('#build-pov-toggle').count(), 1);
    assert.equal(await page.locator('#build-pov-toggle').isChecked(), false);
  } finally {
    await page.close();
  }
});

test('create.html Build Action step: "+N more" reveals every remaining chip (all 13 total, none lost), and "Show less" collapses back down when nothing hidden is selected', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await reachBuildActionStep(page);

    await page.click('#build-action-more-toggle');
    var expandedKeys = await actionKeys(page);
    assert.deepEqual(expandedKeys, EXPANDED_KEYS_ORDER, 'expanding must reveal every ACTION_CHIPS entry (default-visible first, then the rest in their own relative order), with none deleted');
    assert.equal(await page.locator('#build-action-more-toggle').textContent(), 'Show less');
    assert.equal(await page.locator('#build-action-more-toggle').getAttribute('aria-expanded'), 'true');

    // Collapse back -- nothing hidden is selected (still the untouched default
    // action, itself default-visible), so this must actually re-collapse.
    await page.click('#build-action-more-toggle');
    assert.deepEqual(await actionKeys(page), DEFAULT_KEYS);
    assert.equal(await page.locator('#build-action-more-toggle').textContent(), '+' + HIDDEN_KEYS.length + ' more');
  } finally {
    await page.close();
  }
});

test('create.html Build Action step: a hidden chip (behind "+N more") is fully selectable, and once selected the expander stays open even after "Show less" -- the visitor\'s own current choice is never hidden from view', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await reachBuildActionStep(page);
    await page.click('#build-action-more-toggle');

    // Select a hidden chip -- it selects (single-select), and the expander
    // must NOT re-hide the active selection when "Show less" is clicked.
    var hidden = HIDDEN_KEYS[0];
    await page.click('#build-action-row [data-build-action="' + hidden + '"]');
    assert.equal(await page.locator('#build-action-row [data-build-action="' + hidden + '"].sel').count(), 1, 'the hidden chip must select');

    await page.click('#build-action-more-toggle'); // "Show less" while the selection is hidden
    assert.deepEqual(await actionKeys(page), EXPANDED_KEYS_ORDER, 'must not collapse while the selected chip lives behind the expander -- the visitor\'s own current choice can never disappear from view');
    assert.equal(await page.locator('#build-action-row [data-build-action="' + hidden + '"].sel').count(), 1, 'the hidden chip must still show as selected');
  } finally {
    await page.close();
  }
});

test('create.html Build Action step: the POV toggle\'s on/off state survives expanding and collapsing the chip row', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await reachBuildActionStep(page);

    // #build-pov-toggle is a visually-hidden input inside the POV toggle row
    // (which sits just below the chip row) -- click the visible track
    // (delivered to the checkbox via the wrapping label), same as a real tap.
    await page.click('.fn-toggle-row .fn-switch-track');
    assert.equal(await page.locator('#build-pov-toggle').isChecked(), true);

    await page.click('#build-action-more-toggle'); // expand -- re-renders the whole step
    assert.equal(await page.locator('#build-pov-toggle').isChecked(), true, 'POV must stay on across an expand re-render');

    await page.click('#build-action-more-toggle'); // collapse -- re-renders again
    assert.equal(await page.locator('#build-pov-toggle').isChecked(), true, 'POV must stay on across a collapse re-render too');
  } finally {
    await page.close();
  }
});

test('create.html Build Action step: a default-visible chip AND a hidden chip each reach the assembled draft caption with their exact, unchanged mapping (via style.html) -- proves curation is a visibility change only, never a behavior change', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    // (a) a default-visible chip, no expansion needed.
    await reachBuildActionStep(page);
    await page.click('#build-action-row [data-build-action="exam"]');
    await page.click('#build-action-continue');
    await page.waitForSelector('#build-freetext-input');
    await page.click('#build-freetext-skip');
    await page.waitForURL(/style\.html/, { timeout: 5000 });
    await page.waitForFunction(function () { return !!window.DreamStore; }, null, { timeout: 5000 });
    var examCaption = await page.evaluate(function () { return window.DreamStore.getDraft().caption; });
    // The chip's own phrase (from ACTION_CHIPS) must appear verbatim in the
    // assembled caption -- the mapping is unchanged by the curation.
    var examPhrase = WizardChips.ACTION_CHIPS.filter(function (c) { return c.key === 'exam'; })[0].phrase;
    assert.ok(examCaption.indexOf(examPhrase) !== -1, 'the default-visible "exam" chip\'s exact phrase must reach the assembled caption unchanged');

    // (b) a hidden chip, reached via the expander.
    await reachBuildActionStep(page);
    await page.click('#build-action-more-toggle');
    await page.click('#build-action-row [data-build-action="calm"]');
    await page.click('#build-action-continue');
    await page.waitForSelector('#build-freetext-input');
    await page.click('#build-freetext-skip');
    await page.waitForURL(/style\.html/, { timeout: 5000 });
    await page.waitForFunction(function () { return !!window.DreamStore; }, null, { timeout: 5000 });
    var calmCaption = await page.evaluate(function () { return window.DreamStore.getDraft().caption; });
    var calmPhrase = WizardChips.ACTION_CHIPS.filter(function (c) { return c.key === 'calm'; })[0].phrase;
    assert.ok(calmCaption.indexOf(calmPhrase) !== -1, 'a chip curated behind the expander must reach the caption with the EXACT SAME phrase -- only its default visibility changed');
  } finally {
    await page.close();
  }
});

test('create.html Build Action step on a real mobile viewport: chips and the expander are genuinely usable via touch taps, with adequate tap-target height and no horizontal overflow', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true });
  var page = await context.newPage();
  await blockThirdParty(page);
  try {
    await reachBuildActionStep(page);

    var overflowsX = await page.evaluate(function () {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
    });
    assert.equal(overflowsX, false, 'the Action step must not overflow horizontally on a 375px-wide phone viewport');

    var toggleBox = await page.locator('#build-action-more-toggle').boundingBox();
    var chipBox = await page.locator('#build-action-row [data-build-action="' + DEFAULT_KEYS[0] + '"]').boundingBox();
    assert.ok(toggleBox.height >= 30, 'expander tap target too short: ' + toggleBox.height + 'px');
    assert.ok(chipBox.height >= 30, 'chip tap target too short: ' + chipBox.height + 'px');

    // A real touch tap (not a mouse click) drives the expander.
    await page.tap('#build-action-more-toggle');
    assert.deepEqual(await actionKeys(page), EXPANDED_KEYS_ORDER, 'a real touch tap on the expander must reveal every chip');

    // A real touch tap on a chip behind the expander selects it.
    await page.tap('#build-action-row [data-build-action="calm"]');
    assert.equal(await page.locator('#build-action-row [data-build-action="calm"].sel').count(), 1, 'a real touch tap must select a chip behind the expander');
  } finally {
    await page.close();
    await context.close();
  }
});

test('create.html Build Action step: the "+N more" expander is keyboard-accessible -- Enter and Space each toggle it, matching this codebase\'s existing keydown-synthesizes-click pattern', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await reachBuildActionStep(page);
    await page.locator('#build-action-more-toggle').focus();
    await page.keyboard.press('Enter');
    assert.deepEqual(await actionKeys(page), EXPANDED_KEYS_ORDER, 'Enter on #build-action-more-toggle must expand it, same as a click');

    await page.locator('#build-action-more-toggle').focus();
    await page.keyboard.press(' ');
    assert.deepEqual(await actionKeys(page), DEFAULT_KEYS, 'Space on #build-action-more-toggle must collapse it back, same as a click');
  } finally {
    await page.close();
  }
});
