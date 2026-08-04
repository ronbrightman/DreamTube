// test/signup-screen-layout-spacing-behavioral.test.js
//
// Real browser-driven coverage for the vertical-distribution + "or"
// divider fix (tracker item for-product-signup-screen-layout-fixes-f-
// 3hclmj, founder mobile walk 08-03): "SPREAD IT OUT -- everything is
// crammed at the very top of the mobile viewport again" + "ADD AN 'or'
// DIVIDER" between the Facebook button and the email field.
//
// What this file specifically proves, at a real FB/IG in-app-webview-
// sized mobile viewport (390x844, the same convention
// test/facebook-login-signup-behavioral.test.js uses):
//   - .fn-signup-stage's distributed-spacer layout is actually doing
//     something real -- the leftover vertical space is spread as
//     .fn-stage-spacer gaps BETWEEN content blocks, not hoarded below
//     the CTA button (the root-cause bug: a single trailing .fn-spacer
//     used to eat 100% of the leftover space in one place) -- on all
//     three arms this tracker item names: 'unified', 'reveal', and the
//     passwordless wall (including its own "code" step, the "passwordless-
//     code wall" the item explicitly calls out).
//   - the "or" divider (#fn-fb-or-divider) renders between the Facebook
//     button and the email field on 'unified' and 'reveal' (the two arms
//     that render the button at all), and is absent on the passwordless
//     arm, which never renders the Facebook button in the first place.
//
// Playwright itself is NOT a project dependency -- see CLAUDE.md's "No
// test framework is wired in..." section. Every test below skips itself
// with a clear reason if Playwright/the pinned Chromium binary isn't
// resolvable in whatever environment runs `npm test`.

var test = require('node:test');
var assert = require('node:assert/strict');
var staticServer = require('./helpers/static-server');

var CHROMIUM_PATH = '/opt/pw-browsers/chromium';
var MOBILE_WEBVIEW_VIEWPORT = { width: 390, height: 844 };

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

function resumeUrl(variant, caption) {
  return baseUrl + '/start.html?resume=1&signup=' + variant + '&style=Cartoon&caption=' + encodeURIComponent(caption || 'Flying over the ocean at sunset');
}

function mockGetFeed(page, feed) {
  return page.route('**/.netlify/functions/get-feed', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ feed: feed || [], dreamOfDayId: null }) });
  });
}

/** Turns the Facebook Login feature flag ON deterministically, regardless of whatever App ID js/facebook-config.js currently ships with (see test/facebook-login-signup-behavioral.test.js's own identical helper doc comment -- kept as its own copy here rather than a cross-file require, matching this codebase's page-local-helper precedent). */
function configureFacebookApp(page) {
  return page.route('**/js/facebook-config.js', async function (route) {
    var response = await route.fetch();
    var body = await response.text();
    route.fulfill({
      status: 200,
      contentType: 'text/javascript; charset=utf-8',
      body: body.replace(/var FACEBOOK_APP_ID = '[^']*';/, "var FACEBOOK_APP_ID = '1234509876';")
    });
  });
}

/**
 * Measures the .fn-signup-stage layout's real effect: returns the
 * viewport height, the screen element's scrollHeight (so a caller can
 * tell whether content actually fits in one viewport or needs to
 * scroll), each .fn-stage-spacer's rendered height, and how far below
 * the viewport's visible bottom the LAST stage group's bottom edge sits
 * (near-zero/negative means the content fills the screen with no dead
 * zone left after it; a large positive number would mean the old bug --
 * content clustered above a big empty gap -- is back).
 */
function measureStage(page) {
  return page.evaluate(function () {
    var screenEl = document.getElementById('fnScreen');
    var stage = screenEl.querySelector('.fn-signup-stage');
    if (!stage) return null;
    var spacers = Array.prototype.map.call(stage.querySelectorAll('.fn-stage-spacer'), function (s) {
      return s.getBoundingClientRect().height;
    });
    var groups = stage.querySelectorAll('.fn-stage-group');
    var firstTop = groups[0].getBoundingClientRect().top;
    var lastBottom = groups[groups.length - 1].getBoundingClientRect().bottom;
    return {
      viewportHeight: window.innerHeight,
      screenScrollHeight: screenEl.scrollHeight,
      screenClientHeight: screenEl.clientHeight,
      spacerHeights: spacers,
      groupCount: groups.length,
      firstGroupTop: firstTop,
      lastGroupBottom: lastBottom
    };
  });
}

// ===========================================================================
// Vertical distribution -- the "SPREAD IT OUT" half of the tracker item.
// ===========================================================================

[
  { variant: 'unified', configureFb: true, waitSelector: '#fn-email' },
  { variant: 'reveal', configureFb: true, waitSelector: '#fn-email' },
  { variant: 'passwordless', configureFb: false, waitSelector: '#fn-email' }
].forEach(function (scenario) {
  test('screen 13 (' + scenario.variant + ' arm, email step): content is distributed across the real viewport height via .fn-signup-stage, not clustered at the top with dead space below the CTA', async function (t) {
    if (unavailableReason) { t.skip(unavailableReason); return; }
    var context = await browser.newContext({ viewport: MOBILE_WEBVIEW_VIEWPORT });
    try {
      var page = await context.newPage();
      await blockThirdParty(page);
      if (scenario.configureFb) await configureFacebookApp(page);
      // A real, non-empty feed so the proof strip renders too -- the
      // richer, more realistic content case (a few groups, not just
      // headline + field + button), which is also the harder case for a
      // spacer-distribution regression to hide in.
      await mockGetFeed(page, [{ id: 'd1', ownerHandle: 'someone' }, { id: 'd2', ownerHandle: 'someone-else' }]);

      await safeGoto(page, resumeUrl(scenario.variant));
      await page.waitForSelector(scenario.waitSelector, { timeout: 8000 });
      // Let the best-effort getSharedFeed() proof-strip fetch settle so the
      // richer, multi-group content case is actually what gets measured.
      await page.waitForFunction(function () {
        return document.getElementById('fnScreen').querySelector('.fn-proof-strip') !== null;
      }, null, { timeout: 5000 }).catch(function () { /* best-effort -- proceed with whatever rendered */ });

      var m = await measureStage(page);
      assert.ok(m, '.fn-signup-stage must be present on the ' + scenario.variant + ' arm\'s email step');
      assert.ok(m.groupCount >= 3, 'expected several distinct stage groups (headline, proof/reassurance, field, CTA at minimum), got ' + m.groupCount);

      // Only meaningful when content doesn't already need to scroll --
      // on a viewport tall enough to fit everything, real leftover space
      // must exist and be spread across the spacers, not collapsed to
      // zero everywhere but one.
      if (m.screenScrollHeight <= m.screenClientHeight + 2) {
        assert.ok(m.spacerHeights.length >= 2, 'expected at least 2 distribution spacers between 3+ groups');
        var grownSpacers = m.spacerHeights.filter(function (h) { return h > 20; });
        assert.ok(grownSpacers.length >= 1, 'at least one spacer must have grown meaningfully beyond its min-height floor when there is real leftover space, got heights: ' + JSON.stringify(m.spacerHeights));

        // The regression this whole fix targets: content clustered in the
        // top portion of the screen, then one giant dead zone below the
        // CTA. Assert the opposite -- the content itself (first group's
        // top to last group's bottom) spans a healthy majority of the
        // visible screen, i.e. the space is actually being used, not
        // dumped below everything.
        var contentSpan = m.lastGroupBottom - m.firstGroupTop;
        var spanRatio = contentSpan / m.viewportHeight;
        assert.ok(spanRatio > 0.55, 'expected the signup content to span a majority of the viewport height (spread out), got ratio ' + spanRatio.toFixed(2) + ' (span=' + contentSpan + ', viewport=' + m.viewportHeight + ')');
      }
    } finally {
      await context.close();
    }
  });
});

test('screen 13 (passwordless arm, code step): the same distributed-stage layout applies to the "passwordless-code wall" the tracker item names directly', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_WEBVIEW_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockGetFeed(page, []);
    await page.route('**/.netlify/functions/check-email', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, available: true, deliverable: true }) });
    });
    await page.route('**/.netlify/functions/start-pending-generation', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pendingId: 'pd-spacing', operationName: 'fal:fake-model:req-spacing' }) });
    });
    await page.route('**/.netlify/functions/register-account-passwordless', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, created: false, pendingVerification: true }) });
    });

    await safeGoto(page, resumeUrl('passwordless'));
    await page.waitForSelector('#fn-email', { timeout: 8000 });
    await page.fill('#fn-email', 'existingowner@example.com');
    await page.click('#fn-s13-continue');
    await page.waitForSelector('#fn-login-code', { timeout: 8000 });

    var m = await measureStage(page);
    assert.ok(m, '.fn-signup-stage must be present on the passwordless code step ("Check your email")');
    assert.ok(m.groupCount >= 3, 'expected headline+message / code input / actions groups at minimum, got ' + m.groupCount);
    if (m.screenScrollHeight <= m.screenClientHeight + 2) {
      var grownSpacers = m.spacerHeights.filter(function (h) { return h > 20; });
      assert.ok(grownSpacers.length >= 1, 'expected real distributed spacing on the code step too, got heights: ' + JSON.stringify(m.spacerHeights));
    }
  } finally {
    await context.close();
  }
});

// ===========================================================================
// The "or" divider -- the second half of the tracker item. 'unified' and
// 'reveal' both render the Facebook button; the divider must sit directly
// between it and the email field. The passwordless arm never renders the
// Facebook button at all, so no divider either (already covered from the
// Facebook-flag angle in test/facebook-login-signup-behavioral.test.js --
// this is the passwordless-specific negative case named directly by the
// tracker item: "the divider only applies where the Facebook button and
// email field are adjacent").
// ===========================================================================

['unified', 'reveal'].forEach(function (variant) {
  test('screen 13 (' + variant + ' arm): the "or" divider renders between the Facebook button and the email field', async function (t) {
    if (unavailableReason) { t.skip(unavailableReason); return; }
    var context = await browser.newContext({ viewport: MOBILE_WEBVIEW_VIEWPORT });
    try {
      var page = await context.newPage();
      await blockThirdParty(page);
      await configureFacebookApp(page);
      await mockGetFeed(page, []);

      await safeGoto(page, resumeUrl(variant));
      await page.waitForSelector('#fn-fb-continue', { timeout: 8000 });

      var divider = await page.$('#fn-fb-or-divider');
      assert.ok(divider, 'the "or" divider must render on the ' + variant + ' arm once the Facebook button is configured');
      assert.equal((await divider.textContent()).trim().toLowerCase(), 'or');

      var order = await page.evaluate(function () {
        var b = document.getElementById('fn-fb-continue').getBoundingClientRect();
        var d = document.getElementById('fn-fb-or-divider').getBoundingClientRect();
        var e = document.getElementById('fn-email').getBoundingClientRect();
        return b.bottom <= d.top && d.bottom <= e.top;
      });
      assert.equal(order, true, 'the divider must sit strictly between the Facebook button and the email field');
    } finally {
      await context.close();
    }
  });
});

test('screen 13 (passwordless arm): no "or" divider anywhere -- this arm never renders the Facebook button at all', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_WEBVIEW_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await configureFacebookApp(page); // even with the flag ON, this arm's own renderer never calls facebookSignupButtonHtml()
    await mockGetFeed(page, []);

    await safeGoto(page, resumeUrl('passwordless'));
    await page.waitForSelector('#fn-email', { timeout: 8000 });

    assert.equal(await page.$('#fn-fb-continue'), null, 'the passwordless arm must never render the Facebook button');
    assert.equal(await page.$('#fn-fb-or-divider'), null, 'the passwordless arm must never render the "or" divider either');
  } finally {
    await context.close();
  }
});
