// test/wait-screen-reassurance-and-inapp-nudge-behavioral.test.js
//
// Real browser-driven coverage for two tracker items, built together off
// one founder-approved design mock per that mock's own instruction not to
// double-build them separately (docs/design/inapp-browser-nudge.html,
// branch claude/manager-onboarding-xcq4ul, Frame 1 ONLY):
//
//  - for-product-wait-screen-reassurance-duri-ofoag1: "during the ~90s
//    video generation wait, add rotating reassurance copy + a visible
//    progress indicator so first-timers do not think it is stuck." A
//    rotating reassurance checklist (#proc-checklist) and an indeterminate
//    progress-bar sweep already existed on processing.html before this
//    tracker item was filed (added 2026-07-21, see git history) — the
//    actual gap was a "how much longer, roughly" indicator, which neither
//    existing piece provided. This adds a small, honest-effort "~Ns left"
//    countdown (processing.html's startTimeEstimate/updateTimeLabel)
//    alongside the pre-existing checklist, without duplicating it.
//
//  - for-product-build-post-signup-fb-ig-in-a-oognuc: a dismissible,
//    post-signup-only nudge card shown when the visitor is inside
//    Instagram's or Facebook's own in-app browser, pointing them at their
//    real browser (processing.html's initInAppNudge). Frame 2 of the mock
//    (a result.html banner) was rejected by the founder and redesign is
//    pending with him — nothing from Frame 2 is built or tested here.
//
// Follows test/image-generation-turn-into-video-behavioral.test.js's
// seed-via-localStorage + page.route() network-stub conventions, and
// test/ui-behavioral.test.js's page.clock pattern for deterministically
// advancing timers without a real wait.

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

/** Aborts requests to third-party hosts every page here loads -- see CLAUDE.md on this sandbox's outbound network, and every other *-behavioral.test.js's identical helper. */
function blockThirdParty(page) {
  return page.route(/fonts\.(googleapis|gstatic)\.com|connect\.facebook\.net|i\.posthog\.com/, function (route) {
    route.abort();
  });
}

/** Seeds a logged-in account with a caption+style draft and no pendingJob, landing on processing.html's normal fresh-generation path (not a resumed job). Mirrors first-video-created-behavioral.test.js's seedAccount / image-generation-turn-into-video-behavioral.test.js's seedAccountWithDream, generalized to a draft instead of a finished dream. */
async function seedAccountWithDraft(page, opts) {
  await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function (o) {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@' + o.username, username: o.username };
    if (!state.accounts) state.accounts = {};
    state.accounts[o.username] = { password: 'testpass1', email: o.email || (o.username + '@example.com') };
    if (!state.dreams) state.dreams = [];
    state.draft = Object.assign({ caption: 'A dream about flying over the city', style: 'Cinematic', mediaType: 'video' }, o.draft || {});
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, opts);
}

/** Mocks a generation that never completes for the lifetime of the test (video-status always reports done:false) -- keeps processing.html parked on the wait screen so its rotating/ticking UI, and the nudge card underneath it, can be observed without racing the real 350ms post-completion redirect to result.html. */
function mockNeverFinishingGeneration(page) {
  return Promise.all([
    page.route('**/.netlify/functions/generate-video', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'fal:fal-ai/veo3.1/fast/test-op' }) });
    }),
    page.route('**/.netlify/functions/video-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: false }) });
    })
  ]);
}

var IG_ANDROID_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/119.0.0.0 Mobile Safari/537.36 Instagram 302.0.0.23.114 Android (33/13; 420dpi; 1080x2246; google/redfin/redfin:13; en_US; 538815920)';
var FB_IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/400.0.0.0.100;FBBV/1;FBDV/iPhone14,2;FBMD/iPhone;FBSN/iOS;FBSV/16.0;FBSS/3;FBID/phone;FBLC/en_US]';
var NORMAL_ANDROID_CHROME_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36';
var NORMAL_IOS_SAFARI_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';

test('processing.html: reassurance checklist copy and the new time-left label both change over a simulated wait, not just render once statically', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockNeverFinishingGeneration(page);
    await page.clock.install({ time: Date.now() });

    await seedAccountWithDraft(page, { username: 'reassureuser' });
    await page.goto(baseUrl + '/processing.html', { waitUntil: 'domcontentloaded' });

    var initialChecklist = await page.textContent('#proc-checklist');
    var initialTimeLabel = await page.textContent('#proc-time-label');
    assert.match(initialTimeLabel, /~\d+s left/, 'expected an initial "~Ns left" estimate under the bar');

    // Advance 20s -- the checklist's 5s ticks should have moved past the
    // very first step, and the time label should have counted down.
    await page.clock.fastForward(20000);
    var midChecklist = await page.textContent('#proc-checklist');
    var midTimeLabel = await page.textContent('#proc-time-label');
    assert.notEqual(midChecklist, initialChecklist, 'reassurance checklist copy must change/grow over the wait, not stay static');
    assert.notEqual(midTimeLabel, initialTimeLabel, 'time-left label must count down over the wait, not stay static');

    // Advance well past the ~90s video estimate -- must land on the
    // "Almost there" fallback, never a stuck-looking negative/zero number.
    await page.clock.fastForward(90000);
    var lateTimeLabel = await page.textContent('#proc-time-label');
    assert.match(lateTimeLabel, /almost there/i, 'once the estimate is exceeded the label should read "Almost there…", never a negative/zero number');
    assert.doesNotMatch(lateTimeLabel, /-\d/, 'must never show a negative countdown');
  } finally {
    await context.close();
  }
});

test('processing.html: the time-left estimate resets on retry after a failure, instead of continuing to count down from the original attempt', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.clock.install({ time: Date.now() });

    var attempt = 0;
    await page.route('**/.netlify/functions/generate-video', function (route) {
      attempt++;
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'fal:fal-ai/veo3.1/fast/test-op-' + attempt }) });
    });
    await page.route('**/.netlify/functions/video-status*', function (route) {
      if (attempt === 1) { route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ error: 'E399: forced_test_failure' }) }); return; }
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: false }) });
    });

    await seedAccountWithDraft(page, { username: 'retryresetuser' });
    await page.goto(baseUrl + '/processing.html', { waitUntil: 'domcontentloaded' });

    await page.waitForSelector('#proc-fail', { state: 'visible', timeout: 5000 });
    await page.clock.fastForward(45000);
    await page.click('#retry-btn');

    await page.waitForSelector('#proc-live', { state: 'visible', timeout: 5000 });
    var resetLabel = await page.textContent('#proc-time-label');
    assert.match(resetLabel, /~(8[5-9]|90)s left/, 'a fresh retry should restart the countdown near the full ~90s estimate, not continue from the failed attempt\'s elapsed time (got: ' + resetLabel + ')');
  } finally {
    await context.close();
  }
});

test('processing.html: the FB/IG in-app-browser nudge shows for Instagram\'s UA and Facebook\'s UA, naming the right host app, but never for a normal browser UA', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }

  async function checkNudgeFor(userAgent, expectHost) {
    var context = await browser.newContext({ userAgent: userAgent });
    try {
      var page = await context.newPage();
      await blockThirdParty(page);
      await mockNeverFinishingGeneration(page);
      await seedAccountWithDraft(page, { username: 'nudgeua' + Math.random().toString(36).slice(2, 8) });
      await page.goto(baseUrl + '/processing.html', { waitUntil: 'domcontentloaded' });

      if (expectHost) {
        await page.waitForSelector('#proc-nudge-card', { state: 'visible', timeout: 5000 });
        var title = await page.textContent('#proc-nudge-title');
        assert.match(title, new RegExp(expectHost), 'nudge header must name the actual detected host app (' + expectHost + '), got: ' + title);
        // REVIEW FIX: assert on the VISIBLE-ONLY hint-text span, not the
        // whole #proc-nudge-hint container -- textContent() on the
        // container would also pick up text from the aria-hidden replica
        // below, so a check against the container can't actually tell
        // apart "the accessible sentence carries the instruction" from
        // "only the hidden replica does." The literal label MUST be in
        // this visible sentence for a screen-reader user to get it at all.
        var hintTextOnly = await page.textContent('#proc-nudge-hint-text');
        assert.match(hintTextOnly, new RegExp(expectHost), 'the host name must appear in the lead-in sentence regardless of host');
        assert.match(hintTextOnly, /Open in external browser/i, 'the literal instruction must be in the ACCESSIBLE sentence itself, not only inside the aria-hidden visual replica');

        // for-product-nudge-polish-founder-show-a--x72003: a static visual
        // replica of the actual host-app menu row (icon + label, styled
        // like a system menu item) must render alongside the text hint --
        // not just plain text describing what to look for. It is purely
        // decorative (the accessible sentence above already carries the
        // same instruction), so it must stay aria-hidden.
        var replicaVisible = await page.locator('#proc-nudge-menu-replica').isVisible();
        assert.equal(replicaVisible, true, 'the static menu-row replica must actually render, not just the plain-text hint');
        var replicaAriaHidden = await page.locator('#proc-nudge-menu-replica').getAttribute('aria-hidden');
        assert.equal(replicaAriaHidden, 'true', 'the decorative replica must stay aria-hidden since its info is already in the accessible sentence above');
        var replicaLabel = await page.textContent('#proc-nudge-menu-replica .menu-row-replica-label');
        assert.match(replicaLabel, /Open in external browser/i, 'the replica\'s label must show the exact menu-row wording to look for');
        var replicaIconHtml = await page.locator('#proc-nudge-menu-replica-icon').innerHTML();
        assert.match(replicaIconHtml, /<svg/, 'the replica must include an icon (not just bare text) to visually read as a system menu row');
      } else {
        assert.equal(await page.locator('#proc-nudge-card').isVisible(), false, 'a normal browser UA must never show the in-app nudge');
      }
    } finally {
      await context.close();
    }
  }

  await checkNudgeFor(IG_ANDROID_UA, 'Instagram');
  await checkNudgeFor(FB_IOS_UA, 'Facebook');
  await checkNudgeFor(NORMAL_ANDROID_CHROME_UA, null);
  await checkNudgeFor(NORMAL_IOS_SAFARI_UA, null);
});

test('processing.html: the menu-row replica does not overflow the nudge card on a narrow mobile viewport', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ userAgent: IG_ANDROID_UA, viewport: { width: 320, height: 568 } });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockNeverFinishingGeneration(page);
    await seedAccountWithDraft(page, { username: 'nudgenarrow' + Math.random().toString(36).slice(2, 8) });
    await page.goto(baseUrl + '/processing.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#proc-nudge-menu-replica', { state: 'visible', timeout: 5000 });

    var cardBox = await page.locator('#proc-nudge-card').boundingBox();
    var replicaBox = await page.locator('#proc-nudge-menu-replica').boundingBox();
    assert.ok(cardBox && replicaBox, 'both the nudge card and the menu-row replica must have a real layout box at 320px width');
    assert.ok(replicaBox.x >= cardBox.x - 1 && (replicaBox.x + replicaBox.width) <= (cardBox.x + cardBox.width) + 1,
      'the menu-row replica must not overflow the nudge card horizontally at a 320px viewport');

    var hasHorizontalScroll = await page.evaluate(function () {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth;
    });
    assert.equal(hasHorizontalScroll, false, 'the page must not gain horizontal scroll from the new replica at a narrow viewport');
  } finally {
    await context.close();
  }
});

test('processing.html: dismissing the in-app nudge hides it immediately and it never shows again on a later visit in the same browser', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ userAgent: IG_ANDROID_UA });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockNeverFinishingGeneration(page);
    await seedAccountWithDraft(page, { username: 'dismissuser' });
    await page.goto(baseUrl + '/processing.html', { waitUntil: 'domcontentloaded' });

    await page.waitForSelector('#proc-nudge-card', { state: 'visible', timeout: 5000 });
    await page.click('#proc-nudge-dismiss');
    assert.equal(await page.locator('#proc-nudge-card').isVisible(), false, 'the card must hide immediately on dismiss');

    var dismissedFlag = await page.evaluate(function () { return DreamStore.getInAppNudgeDismissed(); });
    assert.equal(dismissedFlag, true, 'dismissal must be durably recorded via DreamStore.getInAppNudgeDismissed');

    // A later visit -- reload the same wait screen -- must not resurrect it,
    // even though the UA is still the same in-app browser and generation is
    // (per the mock) still in flight.
    await page.reload({ waitUntil: 'domcontentloaded' });
    assert.equal(await page.locator('#proc-nudge-card').isVisible(), false, 'a later visit in the same browser must never show the nudge again once dismissed');
  } finally {
    await context.close();
  }
});

test('processing.html: on an Android in-app browser, the "Open in my browser" button attempts an intent:// URL targeting Chrome, preserving the current page\'s URL', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ userAgent: IG_ANDROID_UA });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockNeverFinishingGeneration(page);
    await seedAccountWithDraft(page, { username: 'androidopenuser' });
    await page.goto(baseUrl + '/processing.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#proc-nudge-card', { state: 'visible', timeout: 5000 });

    var pageUrl = page.url();
    var intentUrl = await page.evaluate(function () { return buildAndroidChromeIntentUrl(); });
    assert.match(intentUrl, /^intent:\/\//, 'must be an intent:// URL');
    assert.match(intentUrl, /scheme=https/, 'must force the https scheme so Chrome opens the real page, not the intent scheme');
    assert.match(intentUrl, /package=com\.android\.chrome/, 'must target Chrome specifically');
    assert.match(intentUrl, /end;?$/, 'must be a well-formed intent URL, terminated with end');
    assert.ok(intentUrl.indexOf(encodeURIComponent(pageUrl)) !== -1, 'must carry a browser_fallback_url pointing back at the current page for devices without Chrome');
    assert.ok(pageUrl.replace(/^https?:\/\//, '') && intentUrl.indexOf(pageUrl.replace(/^https?:\/\//, '').split('#')[0].split('?')[0].split('/')[0]) !== -1, 'must target the current page\'s own host');
  } finally {
    await context.close();
  }
});

test('processing.html: on iOS, the "Open in my browser" button never attempts a scheme that would silently fail -- it stays on the page and emphasizes the host-app hint line instead', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ userAgent: FB_IOS_UA });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockNeverFinishingGeneration(page);
    await seedAccountWithDraft(page, { username: 'iosopenuser' });
    await page.goto(baseUrl + '/processing.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#proc-nudge-card', { state: 'visible', timeout: 5000 });

    await page.click('#proc-nudge-open-btn');
    // Give any (incorrect) navigation attempt a moment to have happened.
    await page.waitForTimeout(200);
    assert.match(page.url(), /processing\.html/, 'clicking the button on iOS must never navigate away from the wait screen');

    var hintHasEmphasis = await page.evaluate(function () {
      return document.getElementById('proc-nudge-hint').classList.contains('proc-nudge-hint-emph');
    });
    assert.equal(hintHasEmphasis, true, 'clicking the button on iOS should emphasize the hint line, since there is no reliable programmatic escape there');
  } finally {
    await context.close();
  }
});

test('processing.html: a signed-out visitor (even with an Instagram UA) is redirected to login.html before any wait screen or nudge card renders', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ userAgent: IG_ANDROID_UA });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    // No seedAccountWithDraft call -- no user, no draft, nothing in
    // localStorage at all for this fresh context.
    await page.goto(baseUrl + '/processing.html', { waitUntil: 'domcontentloaded' });
    await page.waitForURL('**/login.html', { timeout: 5000 });
    assert.match(page.url(), /login\.html/, 'a signed-out visitor must never reach the rendered wait screen, so the nudge can never show mid-funnel');
  } finally {
    await context.close();
  }
});
