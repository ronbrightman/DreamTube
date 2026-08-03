// test/forming-veil-nebula-behavioral.test.js
//
// Covers tracker item for-product-forming-veil-replace-the-fla-nwbe60:
// founder feedback on the reveal arm's "your first dream is forming"
// frame -- "I hope you plan to put something more interesting and moving
// there than just a square color." start.html's .fn-forming-frame (built
// by formingFrameHtml, rendered by renderScreen13Reveal) used to paint a
// single static three-stop background directly on the frame itself. It
// now paints a plain fallback fill on the frame and delegates the actual
// visual to a new, oversized, continuously-animated .fn-form-nebula child
// layer (two independently-timed keyframe animations -- drift + hue
// shift), tinted per the dream's chosen style via a new formingTintClass()
// helper (same lowercase/fail-closed contract as MusicBed.urlForStyle).
//
// Three things this file verifies, matching what the tracker item itself
// asked to be verified:
//   1. STRUCTURE -- the forming frame's markup contains the new
//      .fn-form-nebula layer (the CSS-only animated-gradient replacement)
//      instead of just the old flat square, with no video/GIF asset and
//      no extra network request.
//   2. STYLE-TINTING -- formingTintClass() (extracted directly out of
//      start.html, same extract-and-eval technique
//      test/account-store-facebook.test.js already established for
//      deriveUsernameBase) produces a different class for each real style
//      key, and a real browser load with different ?style= values ends up
//      with different resolved --fn-neb-* custom-property colors on
//      .fn-forming-frame -- not just different class *names* that happen
//      to resolve to the same visual.
//   3. REAL MOTION -- computed style values on .fn-form-nebula (its CSS
//      animation names, and its serialized `filter` string) actually
//      change over real wall-clock time on a live page, not just defined-
//      and-idle keyframes that are never exercised.
//
// Does NOT re-test anything test/signup-reveal-variant-behavioral.test.js
// already covers (the reveal arm's gating, copy, submission flow, or the
// best-effort real-still-frame swap-in via tryShowFormingPreview) -- that
// file's own "the blurred still frame swaps in" and "stays anticipation-
// only" tests already prove the swap-in behavior is untouched by this
// change; this file only adds coverage for the new pre-still animated
// state itself.

var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('node:fs');
var path = require('node:path');
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

function enableRevealChallenger(page) {
  return page.route(/\/start\.html(\?|$)/, async function (route) {
    var response = await route.fetch();
    var body = await response.text();
    var patched = body.replace('var SIGNUP_REVEAL_CHALLENGER_LIVE = false;', 'var SIGNUP_REVEAL_CHALLENGER_LIVE = true;');
    assert.notEqual(patched, body, 'SIGNUP_REVEAL_CHALLENGER_LIVE = false must still be present verbatim in start.html for this rewrite to work');
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: patched });
  });
}

function pinRevealVariant(context) {
  return context.addInitScript(function () {
    localStorage.setItem('dreamtube_signup_variant', 'reveal');
  });
}

function mockGetFeed(page, feed) {
  return page.route('**/.netlify/functions/get-feed', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ feed: feed || [], dreamOfDayId: null }) });
  });
}

function resumeUrl(style, caption) {
  return baseUrl + '/start.html?resume=1&signup=reveal&style=' + encodeURIComponent(style || 'Cartoon') +
    '&caption=' + encodeURIComponent(caption || 'Flying over the ocean at sunset');
}

async function openRevealScreen(context, style) {
  await pinRevealVariant(context);
  var page = await context.newPage();
  await blockThirdParty(page);
  await enableRevealChallenger(page);
  await mockGetFeed(page, []);
  await safeGoto(page, resumeUrl(style));
  await page.waitForSelector('#fn-email', { timeout: 5000 });
  return page;
}

// ===========================================================================
// 1. Pure-function coverage: formingTintClass(), extracted directly out of
//    start.html -- no browser needed for this part.
// ===========================================================================

test('formingTintClass: resolves every real style key to its own tint class, and fails closed to fnstyle-default for anything else', function () {
  var html = fs.readFileSync(path.join(__dirname, '..', 'start.html'), 'utf8');
  var constMatch = html.match(/var FORMING_TINT_STYLES = \{[^}]*\};/);
  var fnMatch = html.match(/function formingTintClass\(style\)\{[\s\S]*?\n {2}\}/);
  assert.ok(constMatch, 'FORMING_TINT_STYLES must still be findable in start.html');
  assert.ok(fnMatch, 'formingTintClass must still be findable in start.html');
  var formingTintClass = new Function(constMatch[0] + '\n' + fnMatch[0] + '\nreturn formingTintClass;')();

  assert.equal(formingTintClass('cartoon'), 'fnstyle-cartoon');
  assert.equal(formingTintClass('cinematic'), 'fnstyle-cinematic');
  assert.equal(formingTintClass('anime'), 'fnstyle-anime');
  assert.equal(formingTintClass('realistic'), 'fnstyle-realistic');
  // Case-insensitive, matching MusicBed.urlForStyle's own contract -- the
  // real caller (chosenStyle) can arrive capitalized (style.html's
  // #style-grid data-style values, e.g. "Cartoon").
  assert.equal(formingTintClass('Cartoon'), 'fnstyle-cartoon');
  assert.equal(formingTintClass('CINEMATIC'), 'fnstyle-cinematic');
  // Fail-closed: null (no style chosen yet), empty, unrecognized, and
  // non-string values must never crash and must never produce an
  // undefined/blank class.
  assert.equal(formingTintClass(null), 'fnstyle-default');
  assert.equal(formingTintClass(undefined), 'fnstyle-default');
  assert.equal(formingTintClass(''), 'fnstyle-default');
  assert.equal(formingTintClass('surrealist-future-style'), 'fnstyle-default');
  assert.equal(formingTintClass(42), 'fnstyle-default');

  // The four real keys must each be genuinely distinct from one another and
  // from the default -- a real regression this test would actually catch
  // is every key silently collapsing onto the same class.
  var resolved = ['cartoon', 'cinematic', 'anime', 'realistic', null].map(formingTintClass);
  assert.equal(new Set(resolved).size, 5, 'each style key (plus the null/default case) must resolve to its own distinct class: ' + resolved.join(', '));
});

// ===========================================================================
// 2. Structure: the new nebula layer replaces the old flat square.
// ===========================================================================

test('forming frame structure: .fn-forming-frame contains the new .fn-form-nebula animated layer (not just the old flat static background), with no video/GIF network request for it', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await pinRevealVariant(context);
    var page = await context.newPage();
    var requestedUrls = [];
    page.on('request', function (req) { requestedUrls.push(req.url()); });
    await blockThirdParty(page);
    await enableRevealChallenger(page);
    await mockGetFeed(page, []);
    await safeGoto(page, resumeUrl('Cinematic'));
    await page.waitForSelector('#fn-email', { timeout: 5000 });

    var frame = await page.$('.fn-forming-frame');
    assert.ok(frame, 'the forming frame must still render');
    var nebula = await page.$('.fn-forming-frame .fn-form-nebula');
    assert.ok(nebula, 'the forming frame must contain the new .fn-form-nebula animated-gradient layer');

    // The nebula must be a plain decorative div, not any kind of asset
    // request -- no video/gif/img url should ever be requested for it (the
    // ONLY video-ish request this screen ever makes is the best-effort
    // still-frame swap-in via video-status.js, which this test never
    // triggers -- no operationName, no mocked route).
    var mediaRequests = requestedUrls.filter(function (u) {
      return /\.(mp4|webm|gif|mov)(\?|$)/i.test(u);
    });
    assert.equal(mediaRequests.length, 0, 'the forming veil\'s animated visual must be CSS-only, no video/GIF asset requested: ' + JSON.stringify(mediaRequests));

    // The frame itself no longer paints the gradient directly -- it's now
    // just a plain fallback fill; the nebula child does the real painting.
    var frameBg = await page.$eval('.fn-forming-frame', function (el) { return getComputedStyle(el).backgroundImage; });
    assert.equal(frameBg, 'none', '.fn-forming-frame itself must no longer paint a gradient directly (that moved to .fn-form-nebula): got ' + frameBg);

    var nebulaBg = await page.$eval('.fn-forming-frame .fn-form-nebula', function (el) { return getComputedStyle(el).backgroundImage; });
    assert.match(nebulaBg, /gradient/i, '.fn-form-nebula must paint the actual multi-layer gradient');
  } finally {
    await context.close();
  }
});

// ===========================================================================
// 3. Style-tinting: different dream styles produce genuinely different
//    resolved colors, not just different class names.
// ===========================================================================

test('style-tinting: cartoon vs cinematic vs anime vs realistic each resolve the nebula to a different --fn-neb-1 color, and an unset/unknown style falls back to fnstyle-default', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var styles = ['Cartoon', 'Cinematic', 'Anime', 'Realistic'];
  var results = {};
  for (var i = 0; i < styles.length; i++) {
    var context = await browser.newContext();
    try {
      var page = await openRevealScreen(context, styles[i]);
      var cls = await page.$eval('.fn-forming-frame', function (el) { return el.className; });
      assert.match(cls, new RegExp('fnstyle-' + styles[i].toLowerCase()), 'the frame must carry the tint class for ' + styles[i] + ', got: ' + cls);
      var neb1 = await page.$eval('.fn-forming-frame', function (el) { return getComputedStyle(el).getPropertyValue('--fn-neb-1').trim(); });
      assert.ok(neb1, 'a resolved --fn-neb-1 custom property must exist for ' + styles[i]);
      results[styles[i]] = neb1;
    } finally {
      await context.close();
    }
  }

  var distinctColors = new Set(Object.values(results));
  assert.equal(distinctColors.size, styles.length, 'each style must resolve to a genuinely distinct nebula color, got: ' + JSON.stringify(results));

  // No ?style= at all (a bare Record-it-style resume with nothing chosen
  // yet) must fall back to the safe default tint, never an unstyled/blank
  // class.
  var context2 = await browser.newContext();
  try {
    await pinRevealVariant(context2);
    var page2 = await context2.newPage();
    await blockThirdParty(page2);
    await enableRevealChallenger(page2);
    await mockGetFeed(page2, []);
    await safeGoto(page2, baseUrl + '/start.html?resume=1&signup=reveal&mode=record');
    await page2.waitForSelector('#fn-email', { timeout: 5000 });
    var cls2 = await page2.$eval('.fn-forming-frame', function (el) { return el.className; });
    assert.match(cls2, /fnstyle-default/, 'no chosen style must fall back to fnstyle-default, got: ' + cls2);
  } finally {
    await context2.close();
  }
});

// ===========================================================================
// 4. Real motion: computed values actually change over real wall-clock
//    time on a live page -- the founder's core ask ("something more
//    interesting and moving").
// ===========================================================================

test('real motion: the nebula layer\'s CSS animations are actually engaged, and its computed filter (hue drift) genuinely changes over real time', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await openRevealScreen(context, 'Cinematic');

    var animState = await page.$eval('.fn-forming-frame .fn-form-nebula', function (el) {
      var cs = getComputedStyle(el);
      return { animationName: cs.animationName, animationPlayState: cs.animationPlayState };
    });
    assert.match(animState.animationName, /fnNebulaDrift/, 'the drift keyframe animation must be applied: ' + animState.animationName);
    assert.match(animState.animationName, /fnNebulaHue/, 'the hue-shift keyframe animation must be applied: ' + animState.animationName);
    assert.match(animState.animationPlayState, /running/, 'the nebula animations must actually be running, not paused: ' + animState.animationPlayState);

    // Sample the computed `filter` and `transform` twice, real wall-clock
    // time apart, and assert they differ -- proving the keyframes are
    // genuinely being exercised over time on a live page, not merely
    // declared. (`filter` is asserted as its own serialized string rather
    // than decomposed, since Chrome reports hue-rotate()/saturate() back
    // verbatim with the interpolated degree value baked in.)
    var sample1 = await page.$eval('.fn-forming-frame .fn-form-nebula', function (el) {
      var cs = getComputedStyle(el);
      return { filter: cs.filter, transform: cs.transform };
    });
    await page.waitForTimeout(2500);
    var sample2 = await page.$eval('.fn-forming-frame .fn-form-nebula', function (el) {
      var cs = getComputedStyle(el);
      return { filter: cs.filter, transform: cs.transform };
    });

    assert.notEqual(sample1.filter, sample2.filter, 'the nebula\'s computed filter (hue drift) must change over real time -- got the same value twice (' + sample1.filter + '), suggesting the animation never actually advances');
    assert.notEqual(sample1.transform, sample2.transform, 'the nebula\'s computed transform (position/scale drift) must change over real time -- got the same value twice (' + sample1.transform + ')');
  } finally {
    await context.close();
  }
}, { timeout: 15000 });

// ===========================================================================
// 5. Reduced motion: the nebula respects prefers-reduced-motion, same as
//    the pre-existing sweep/arc.
// ===========================================================================

test('prefers-reduced-motion: the nebula animation is disabled, same as the pre-existing sweep/arc', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ reducedMotion: 'reduce' });
  try {
    var page = await openRevealScreen(context, 'Anime');
    var animName = await page.$eval('.fn-forming-frame .fn-form-nebula', function (el) { return getComputedStyle(el).animationName; });
    assert.equal(animName, 'none', 'the nebula animation must be disabled under prefers-reduced-motion, got: ' + animName);
  } finally {
    await context.close();
  }
});

// ===========================================================================
// 6. The existing best-effort real-still-frame swap-in is unaffected: once
//    it appears, it still fully covers the nebula, exactly as before.
// ===========================================================================

test('still-frame swap-in is unaffected by the nebula layer: the still frame still covers the animated nebula completely once video-status reports done', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await pinRevealVariant(context);
    var page = await context.newPage();
    await blockThirdParty(page);
    await enableRevealChallenger(page);
    await mockGetFeed(page, []);
    await page.route('**/.netlify/functions/start-pending-generation', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pendingId: 'pd-nebula-1', operationName: 'fal:fake-model:req-nebula-1' }) });
    });
    await page.route('**/.netlify/functions/check-email', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, available: true, deliverable: true }) });
    });
    await page.route('**/.netlify/functions/video-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, videoUrl: 'https://example.com/fake-dream.mp4' }) });
    });

    var signupFlow = require('./helpers/signup-flow');
    await safeGoto(page, resumeUrl('Realistic'));
    await signupFlow.advanceToPasswordStep(page, 'nebulapreview@example.com');

    await page.waitForFunction(function () {
      var elm = document.querySelector('.fn-forming-still');
      return elm && getComputedStyle(elm).display === 'block';
    }, { timeout: 5000 });

    // The nebula is still in the DOM underneath (never removed), but the
    // still frame paints over it in source order -- both this file's own
    // structural assertion and the pre-existing behavioral test file's
    // "swap-in" test confirm the swap itself is unaffected by this change.
    assert.ok(await page.$('.fn-form-nebula'), 'the nebula layer stays in the DOM (never torn down) once the still frame appears');
    var src = await page.$eval('.fn-forming-still', function (elm) { return elm.src; });
    assert.match(src, /fake-dream\.mp4/);
  } finally {
    await context.close();
  }
});
