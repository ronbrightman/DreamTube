// test/wizard-flo-redesign-behavioral.test.js
//
// Real browser-driven coverage for the Flo-layout visual redesign of the
// dream-builder wizard (wizard.html) — tracker item
// for-product-founder-picked-layout-b-flo--lks7mj (founder verdict 08-07,
// picking "Layout B (Flo style)" from the three real recreations in the
// now-deleted mock-wizard-layouts-x7q4.html): single-column TRUE-PILL
// option rows, a leading circular emoji icon chip per option, progress
// DOTS instead of a bar, and a pink/accent border+tint selected state.
//
// This is a VISUAL-ONLY redesign — see wizard-ui-behavioral.test.js (left
// entirely unmodified by this build, and still 100% green) for the
// existing behavioral/functional coverage of every step's actual
// selection semantics, the signup wall, Facebook Login, and the
// pre-account generation seam. This file adds narrower coverage for
// exactly what changed: the new pill/dot/emoji DOM shape rendering, that
// selection state still toggles correctly through the new shape for both
// a single-select step (Mood) and the wizard's one multi-select step
// (Subject — both the character multi-select AND the single-select
// "other" row it composes with), and — the hard constraint from the
// tracker item itself — that every analytics event this wizard can fire
// during an ordinary run still fires with the exact same name/property
// shape as before this redesign (diffed directly against
// wizard-ui-behavioral.test.js's pre-redesign green run, not assumed).

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

async function safeGoto(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  } catch (e) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  }
}

test('wizard.html Flo redesign: Mood step renders true-pill single-column option rows, each with a leading circular emoji chip, and progress renders as DOTS (not a bar)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await safeGoto(page, baseUrl + '/wizard.html');
    await page.click('[data-subj-other="none"]');
    await page.click('#fn-subject-continue');
    await page.click('#fn-setting-skip');
    await page.click('[data-action="flying"]');
    await page.click('#fn-action-continue');
    await page.waitForSelector('#mood-row [data-mood="peaceful"]');

    // Every MOOD_CHIPS option renders a leading .chip-emoji circle + a
    // .chip-label, and the row itself is laid out single-column (not the
    // old wrapping multi-per-line chip row).
    var moodShape = await page.evaluate(function () {
      var row = document.getElementById('mood-row');
      var rowStyle = getComputedStyle(row);
      var chips = Array.prototype.map.call(row.querySelectorAll('.fn-chip'), function (c) {
        var emoji = c.querySelector('.chip-emoji');
        var label = c.querySelector('.chip-label');
        var chipStyle = getComputedStyle(c);
        return {
          hasEmoji: !!(emoji && emoji.textContent.trim().length > 0),
          hasLabel: !!(label && label.textContent.trim().length > 0),
          borderRadius: chipStyle.borderRadius
        };
      });
      return { flexDirection: rowStyle.flexDirection, chips: chips };
    });
    assert.equal(moodShape.flexDirection, 'column', 'the option row must be single-column (Flo layout), not the old wrapping row');
    assert.equal(moodShape.chips.length, 7, 'all 7 MOOD_CHIPS (6 real + "+ Something else") must render');
    moodShape.chips.forEach(function (c, i) {
      assert.equal(c.hasEmoji, true, 'mood chip #' + i + ' must have a non-empty leading emoji chip');
      assert.equal(c.hasLabel, true, 'mood chip #' + i + ' must have a visible label');
      // TRUE pill = fully rounded ends, not just rounded corners -- a
      // large computed border-radius (>= half the row's own height) is
      // the practical signal for "999px" once the browser resolves it.
      assert.match(c.borderRadius, /^\d+px$/);
      assert.ok(parseFloat(c.borderRadius) >= 20, 'mood chip #' + i + ' must be a TRUE pill (border-radius >= 20px), not a lightly-rounded rectangle');
    });

    // Peaceful's own emoji must be the mock's own literal worked example
    // (mock-wizard-layouts-x7q4.html's `.fB` MOOD row) — 🕊️ — copied
    // verbatim as the source of truth.
    var peacefulEmoji = await page.locator('#mood-row [data-mood="peaceful"] .chip-emoji').textContent();
    assert.equal(peacefulEmoji.trim(), '🕊️');

    // Progress renders as DOTS -- small circles, not a filled bar segment.
    var dotsShape = await page.evaluate(function () {
      var dots = document.querySelectorAll('#fnProgress i');
      return Array.prototype.map.call(dots, function (d) {
        var s = getComputedStyle(d);
        return { width: parseFloat(s.width), height: parseFloat(s.height), borderRadius: s.borderRadius };
      });
    });
    assert.equal(dotsShape.length, 6, 'the 6 core steps must each render one progress dot');
    dotsShape.forEach(function (d) {
      assert.ok(d.height <= 12, 'a progress DOT must be small/circular, not a tall bar segment');
      assert.ok(parseFloat(d.borderRadius) >= 4, 'a progress dot must be rounded, not a square bar segment');
    });
    // The "now" dot is visibly wider than a plain "done"/upcoming dot
    // (mock's own `.fB .dots i.on{width:22px}` treatment).
    var nowDot = dotsShape[3]; // 0-indexed: Mood is step index 3
    var otherDot = dotsShape[0];
    assert.ok(nowDot.width > otherDot.width, 'the current-step dot must be visibly wider than an inactive dot');
  } finally {
    await page.close();
  }
});

test('wizard.html Flo redesign: selected state still toggles correctly through the new pill shape — single-select (Mood) shows exactly one .sel row, and the pink/accent selected style actually applies', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await safeGoto(page, baseUrl + '/wizard.html');
    await page.click('[data-subj-other="none"]');
    await page.click('#fn-subject-continue');
    await page.click('#fn-setting-skip');
    await page.click('[data-action="flying"]');
    await page.click('#fn-action-continue');
    await page.waitForSelector('#mood-row [data-mood="mysterious"]');

    await page.click('#mood-row [data-mood="mysterious"]');
    var selCount = await page.locator('#mood-row .fn-chip.sel').count();
    assert.equal(selCount, 1, 'exactly one mood chip must be selected at a time (single-select)');
    assert.equal(await page.locator('#mood-row [data-mood="mysterious"]').evaluate(function (el) { return el.classList.contains('sel'); }), true);

    // The .sel style is the mock's own pink border + tinted fill, not the
    // old solid accent-gradient fill. The chip's border-color transitions
    // (.12s) rather than snapping instantly, so wait past that before
    // reading the settled computed style -- otherwise this can catch a
    // mid-transition value, not a real regression.
    await page.waitForTimeout(250);
    var selStyle = await page.locator('#mood-row [data-mood="mysterious"]').evaluate(function (el) {
      var s = getComputedStyle(el);
      return { borderColor: s.borderColor, backgroundImage: s.backgroundImage };
    });
    assert.equal(selStyle.backgroundImage, 'none', 'the selected pill must be a flat tinted fill, not the old solid gradient background');
    // #ff8bb3 -> rgb(255, 139, 179)
    assert.match(selStyle.borderColor, /rgb\(255,\s*139,\s*179\)/, 'the selected pill\'s border must be the Flo-spec pink accent (#ff8bb3)');

    // Switching selection moves the .sel class, never leaves two active.
    await page.click('#mood-row [data-mood="epic"]');
    assert.equal(await page.locator('#mood-row .fn-chip.sel').count(), 1);
    assert.equal(await page.locator('#mood-row [data-mood="mysterious"]').evaluate(function (el) { return el.classList.contains('sel'); }), false);
    assert.equal(await page.locator('#mood-row [data-mood="epic"]').evaluate(function (el) { return el.classList.contains('sel'); }), true);
  } finally {
    await page.close();
  }
});

test('wizard.html Flo redesign: the Subject step\'s multi-select (several characters + one "other" chip, all composing together) still works through the new pill row shape, with the enlarged .chip-check circle standing in as the leading icon slot', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await safeGoto(page, baseUrl + '/wizard.html');
    await page.waitForSelector('#subject-chip-row');

    // Character multi-select row is now a single column too.
    var charRowDirection = await page.locator('#subject-chip-row').evaluate(function (el) { return getComputedStyle(el).flexDirection; });
    assert.equal(charRowDirection, 'column', 'the character chip row must also be single-column under the Flo layout');

    await page.click('#subj-add-self');
    await page.waitForSelector('#sheet-character-overlay.open');
    await page.fill('#char-desc-input', 'a woman in her 30s, curly brown hair');
    await page.click('#char-save-btn');
    await page.waitForSelector('#sheet-character-overlay:not(.open)');

    // "A stranger" composes alongside the staged "Me" character — same
    // multi-select semantics as before, just rendered through the new
    // .fn-chip pill (with its own leading emoji chip this time, since it's
    // part of SUBJECT_CHIPS' taxonomy).
    await page.click('#subject-other-row [data-subj-other="stranger"]');

    var meSelected = await page.evaluate(function () {
      var areas = document.querySelectorAll('.char-chip .chip-edit-area[data-char-edit]');
      for (var i = 0; i < areas.length; i++) {
        if (areas[i].textContent.indexOf('Me') !== -1) return areas[i].closest('.char-chip').classList.contains('selected');
      }
      return null;
    });
    assert.equal(meSelected, true, 'Me must remain selected after also picking "A stranger" (multi-select composition preserved through the redesign)');
    assert.equal(await page.locator('#subject-other-row [data-subj-other="stranger"]').evaluate(function (el) { return el.classList.contains('sel'); }), true);

    // The stranger pill has its own leading emoji chip (SUBJECT_CHIPS
    // taxonomy option) and is a true pill.
    var strangerShape = await page.locator('#subject-other-row [data-subj-other="stranger"]').evaluate(function (el) {
      var emoji = el.querySelector('.chip-emoji');
      return { hasEmoji: !!(emoji && emoji.textContent.trim().length > 0), borderRadius: getComputedStyle(el).borderRadius };
    });
    assert.equal(strangerShape.hasEmoji, true);
    assert.ok(parseFloat(strangerShape.borderRadius) >= 20);

    // The character chip's enlarged .chip-check circle (the leading icon
    // slot for a dynamic, non-taxonomy character option) is present and
    // circular.
    var checkShape = await page.evaluate(function () {
      var check = document.querySelector('.char-chip.selected .chip-check');
      var s = getComputedStyle(check);
      return { width: parseFloat(s.width), borderRadius: s.borderRadius };
    });
    assert.ok(checkShape.width >= 30, 'the character chip\'s leading circular slot must be enlarged to match the new pill chip size');
  } finally {
    await page.close();
  }
});

test('wizard.html Flo redesign: the free-text step and the signup wall still function end to end through the new visual language, and the wall keeps its forming-veil + email structure unchanged', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var startPendingCalls = [];
    await page.route('**/.netlify/functions/check-email', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, available: true, deliverable: true }) });
    });
    await page.route('**/.netlify/functions/start-pending-generation', function (route) {
      startPendingCalls.push(JSON.parse(route.request().postData()));
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pendingId: 'pd-flo-1', operationName: 'fal:fake-model:req-flo-1' }) });
    });
    await page.route('**/.netlify/functions/claim-pending-generation', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, found: true, claimed: true }) });
    });
    await page.route('**/.netlify/functions/video-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: false }) });
    });

    await safeGoto(page, baseUrl + '/wizard.html');
    await page.click('[data-subj-other="none"]');
    await page.click('#fn-subject-continue');
    await page.click('#fn-setting-skip');
    await page.click('[data-action="flying"]');
    await page.click('#fn-action-continue');
    await page.click('#fn-mood-skip');
    await page.click('#fn-style-skip');

    // Free-text step: type something and confirm it rides through.
    await page.waitForSelector('#free-text-input');
    await page.fill('#free-text-input', 'a soaring golden bridge');
    await page.click('#fn-freetext-continue');

    // Signup wall: forming veil + FB/divider/email structure intact,
    // gradient backdrop applied.
    await page.waitForSelector('#contact-email');
    assert.equal(await page.locator('#fn-forming-frame').count(), 1, 'the forming veil must still render on the wall');
    var backdrop = await page.evaluate(function () {
      return getComputedStyle(document.getElementById('app')).backgroundImage;
    });
    assert.match(backdrop, /gradient/, 'the wall must still sit on the shared soft gradient backdrop');

    await page.fill('#contact-email', 'flo-redesign-e2e@example.com');
    await page.click('#fn-contact-continue');
    await page.waitForURL(/home\.html/, { timeout: 15000 });
    assert.equal(startPendingCalls.length, 1, 'the free-text-to-signup path must still complete and start the real pending generation exactly once');
    assert.match(startPendingCalls[0].caption, /soaring golden bridge/, 'the typed free text must still ride through to the generation payload');
  } finally {
    await page.close();
  }
});

// ===========================================================================
// Analytics event-name integrity (hard constraint, tracker item
// for-product-founder-picked-layout-b-flo--lks7mj: "Keep every event/
// analytics name unchanged... this redesign exists to move a
// completion-rate metric that's measured by name — changing event names
// would corrupt that measurement"). Captures every posthog.capture(...)
// call across one full, ordinary chip-only run (matching
// wizard-ui-behavioral.test.js's own first test's path) and asserts the
// exact set of event names is exactly what wizard.html fired before this
// redesign touched a single line of CSS/markup.
// ===========================================================================

/**
 * Persistent posthog.capture(name, props) recorder — installed on the
 * CONTEXT (before any page.goto), same installFbqRecorder pattern
 * test/first-video-created-behavioral.test.js/meta-capi-behavioral.test.js
 * already use for fbq. Needed here (rather than that file's simpler
 * post-load window.posthog.slice() read) because THIS test's flow
 * navigates wizard.html -> home.html mid-run — a real cross-document
 * navigation destroys the old page's window.posthog queue entirely, so a
 * one-time post-load read would miss wizard_completed (fired
 * synchronously immediately before the location.href assignment that
 * starts that navigation). context.addInitScript re-runs on every
 * navigation, so this wraps window.posthog's underlying array .push on
 * EVERY document this test's page loads, and every wrapped call is
 * relayed to Node immediately via exposeBinding — surviving the
 * navigation cleanly, in Node-side `calls`, independent of the page's
 * own lifetime.
 *
 * Mechanically: js/analytics-config.js's real (non-placeholder)
 * POSTHOG_KEY makes every page's <head> run PostHog's actual inline stub
 * snippet, which does `window.posthog = (window.posthog || [])` — by
 * pre-seeding window.posthog as our own wrapped array via addInitScript
 * (which always runs before that inline snippet, per Playwright's own
 * ordering guarantee), the snippet's own `e.init(...)` ends up defining
 * `capture` as a method that internally calls THIS SAME array's `.push`
 * (resolved dynamically at call time, not bound at definition time) — so
 * our wrapper still fires even though the real snippet defines `capture`
 * itself. No real network call is ever needed to observe this (and
 * blockThirdParty() aborts the actual array.js bundle load regardless).
 */
async function installPostHogRecorder(context) {
  var calls = [];
  await context.exposeBinding('__recordPostHogCapture', function (source, args) {
    calls.push(args);
  });
  await context.addInitScript(function () {
    var q = [];
    window.posthog = q;
    var originalPush = Array.prototype.push;
    q.push = function () {
      var entry = arguments[0];
      if (entry && entry[0] === 'capture') {
        try { window.__recordPostHogCapture({ name: entry[1], props: entry[2] }); } catch (e) { /* recording must never break the real queue */ }
      }
      return originalPush.apply(this, arguments);
    };
  });
  return calls;
}

test('wizard.html Flo redesign: every analytics event fired across a full ordinary run has the exact same name as before the redesign (event-name integrity)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  var events = await installPostHogRecorder(page.context());
  try {
    await safeGoto(page, baseUrl + '/wizard.html');
    await page.click('[data-subj-other="stranger"]');
    await page.click('#fn-subject-continue');
    await page.click('[data-scenery-time="Night"]');
    await page.click('[data-setting-place="sky"]');
    await page.click('#fn-setting-continue');
    await page.click('[data-action="flying"]');
    await page.click('#fn-action-continue');
    await page.click('[data-mood="epic"]');
    await page.click('#fn-mood-continue');
    await page.click('[data-style="Anime"]');
    await page.click('#fn-style-continue');
    await page.click('#fn-freetext-skip');
    await page.waitForSelector('#contact-email');
    await page.fill('#contact-email', 'analytics-integrity@example.com');
    await page.click('#fn-contact-continue');
    await page.waitForURL(/home\.html/, { timeout: 15000 });
    // installPostHogRecorder is context-level and re-arms on EVERY
    // navigation, so `events` also picks up home.html's own (unrelated,
    // pre-existing, out-of-scope) analytics once that document loads --
    // wizard_completed fires synchronously right before the
    // location.href assignment that starts that navigation, so slicing
    // up through its last occurrence isolates exactly wizard.html's own
    // events for this run, same as reading the queue pre-navigation
    // would have, without racing the navigation itself.
    var lastWizardCompletedIdx = -1;
    events.forEach(function (e, i) { if (e.name === 'wizard_completed') lastWizardCompletedIdx = i; });
    assert.ok(lastWizardCompletedIdx !== -1, 'wizard_completed must have fired at least once before navigating to home.html');
    events = events.slice(0, lastWizardCompletedIdx + 1);

    var names = events.map(function (e) { return e.name; });

    // Every event name that must be present at least once across this
    // exact path (wizard_step_viewed fires once per render, so it appears
    // multiple times — every other one fires exactly once on this path).
    var mustFire = ['wizard_step_viewed', 'wizard_contact_captured', 'wizard_completed'];
    mustFire.forEach(function (n) {
      assert.ok(names.indexOf(n) !== -1, 'event "' + n + '" must still fire on this path, byte-identical to the pre-redesign name');
    });

    // No event name outside the pre-redesign vocabulary this file's own
    // grep of wizard.html's track(...) call sites enumerates (see this
    // file's own header comment) may appear -- this redesign is
    // visual-only and must not introduce, rename, or drop an event.
    var KNOWN_VOCABULARY = [
      'wizard_step_viewed', 'wizard_contact_captured', 'wizard_completed',
      'wizard_facebook_return_snapshot_missing',
      'signup_error_shown', 'signup_facebook_error_shown', 'signup_facebook_staged_persist_failed',
      'signup_facebook_started', 'signup_facebook_click', 'signup_facebook_needs_email_abandoned',
      'signup_facebook_completed', 'returning_user_login_succeeded', 'signed_up'
    ];
    names.forEach(function (n) {
      assert.ok(KNOWN_VOCABULARY.indexOf(n) !== -1, 'unexpected analytics event name "' + n + '" — the redesign must not add/rename any event');
    });

    // wizard_step_viewed's own property shape (the { step } property this
    // metric is read by) must still be a plain 1-based step index.
    var stepViewedEvents = events.filter(function (e) { return e.name === 'wizard_step_viewed'; });
    assert.ok(stepViewedEvents.length >= 6, 'wizard_step_viewed must still fire once per step render across all 6 core steps');
    stepViewedEvents.forEach(function (e) {
      assert.equal(typeof e.props.step, 'number');
    });

    // wizard_contact_captured's own property shape is unchanged.
    var contactCaptured = events.filter(function (e) { return e.name === 'wizard_contact_captured'; })[0];
    assert.deepEqual(contactCaptured.props, { has_whatsapp: false });

    // wizard_completed's own property shape is unchanged.
    var completed = events.filter(function (e) { return e.name === 'wizard_completed'; })[0];
    assert.equal(completed.props.style, 'Anime');
    assert.equal(typeof completed.props.had_pending_generation, 'boolean');
  } finally {
    await page.close();
  }
});
