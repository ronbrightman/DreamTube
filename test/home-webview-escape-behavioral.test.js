// test/home-webview-escape-behavioral.test.js
//
// Real browser-driven coverage for home.html's webview-escape card (ORPHAN
// (b), rehomed from processing.html's #proc-nudge-card when tracker item
// for-product-funnel-ending-v2-founder-ins-tfuu0q removed that page) — an
// elevated state of the existing "Add DreamTube to your phone" quiet row,
// shown only when DreamStore.detectInAppWebviewHost() detects a real FB/IG
// in-app browser UA, per home-mock5-day0-x7q4.html's .webview-card design.
//
// The Android-intent://-URL / iOS-copy-link-with-persistent-note mechanics
// (the real escape ACTIONS, ported verbatim from processing.html's own
// initInAppNudge/buildAndroidChromeIntentUrl/copyLinkForBrowser) have their
// own dedicated coverage in test/session-transfer-behavioral.test.js
// (alongside the ?bt= session-transfer token round trip those actions
// carry) — this file covers the simpler, NEW-to-home.html part: the card's
// own show/hide gating and its mutual exclusivity with the plain "Add to
// phone" row underneath it. Unlike the old processing.html nudge card,
// this one has no dismiss-to-chip mechanic (mock5's own design has no X on
// .webview-card) — that behavior was a deliberate simplification, not
// moved here; see this task's own build notes for the reasoning.
//
// Follows test/pwa-stage0-behavioral.test.js's/test/a2hs-install-nudge-
// journey-behavioral.test.js's established conventions (same UA constants,
// same blockThirdParty/safeGoto/seedUser shape).

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

var IG_ANDROID_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/119.0.0.0 Mobile Safari/537.36 Instagram 302.0.0.23.114 Android (33/13; 420dpi; 1080x2246; google/redfin/redfin:13; en_US; 538815920)';
var FB_IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/400.0.0.0.100;FBBV/1;FBDV/iPhone14,2;FBMD/iPhone;FBSN/iOS;FBSV/16.0;FBSS/3;FBID/phone;FBLC/en_US]';
var NORMAL_ANDROID_CHROME_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36';

/** Seeds a logged-in account directly into localStorage, mirroring every other behavioral test's seedUser. */
async function seedUser(page, username) {
  await safeGoto(page, baseUrl + '/login.html');
  await page.evaluate(function (u) {
    var state = {
      user: { handle: '@' + u, username: u },
      accounts: {},
      draft: { caption: '', style: null, sourceDreamId: null, restore: false, characterIds: [], cameraView: null, sceneryTime: null, sceneryPlace: null, mediaType: null, sourceImageUrl: null },
      dreams: [],
      pendingJob: null,
      charactersByUser: {},
      likedIds: {}
    };
    state.accounts[u] = { password: 'testpass1', email: u + '@example.com' };
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, username);
}

async function checkCardFor(userAgent, expectHost) {
  var context = await browser.newContext(userAgent ? { userAgent: userAgent } : {});
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var username = 'webviewcard' + Math.random().toString(36).slice(2, 8);
    await seedUser(page, username);
    await safeGoto(page, baseUrl + '/home.html');

    if (expectHost) {
      await page.waitForSelector('#webview-card', { state: 'visible', timeout: 5000 });
      var title = await page.textContent('#webview-card-title');
      assert.match(title, new RegExp(expectHost), 'the webview card must name the actual detected host app (' + expectHost + '), got: ' + title);
      // Mutual exclusivity: the plain "Add to phone" row must stay hidden
      // whenever the elevated webview card is showing.
      assert.equal(await page.locator('#install-qrow').isVisible(), false, 'the plain install row must never show alongside the elevated webview card');
    } else {
      assert.equal(await page.locator('#webview-card').isVisible(), false, 'a normal browser UA must never show the webview-escape card');
    }
  } finally {
    await context.close();
  }
}

test('home.html: the webview-escape card shows for Instagram\'s UA and Facebook\'s UA, naming the right host app, and hides the plain install row while it does', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  await checkCardFor(IG_ANDROID_UA, 'Instagram');
  await checkCardFor(FB_IOS_UA, 'Facebook');
});

test('home.html: the webview-escape card never shows for a normal browser UA', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  await checkCardFor(NORMAL_ANDROID_CHROME_UA, null);
});
