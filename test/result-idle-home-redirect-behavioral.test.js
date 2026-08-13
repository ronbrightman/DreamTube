// test/result-idle-home-redirect-behavioral.test.js
//
// Founder 08-13 "redirect to the post-video-watch path too". The result page
// is a terminal dead end: the data showed ~40% of visitors watch their
// finished (looping) dream and then leave the app without doing anything.
// result.html now has a passive-bounce catch (see its idleHomeRedirect IIFE):
// if the OWNER sits on the page with ZERO interaction for a grace window while
// the dream is watchable, they are redirected to the home hub. ANY interaction
// permanently disarms it, so an engaged user is never yanked away. The grace
// window is 30s in production but overridable via ?idlems=<ms> for tests only.
//
// Follows test/result-scroll-lock-behavioral.test.js's seedResultPage/
// blockThirdParty conventions.

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

/** Seeds a logged-in owner + one finished video dream, then opens result.html with a short idle window. */
async function seedResultPage(page, dreamId, query, extra) {
  await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function (args) {
    var id = args.id, extra = args.extra || {};
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@tester', username: 'tester' };
    if (!state.accounts) state.accounts = {};
    state.accounts.tester = { password: 'testpass1', email: 'tester@example.com' };
    if (!state.dreams) state.dreams = [];
    state.dreams.push(Object.assign({
      id: id,
      ownerHandle: '@tester',
      caption: 'A test dream about flying over mountains',
      storyText: 'I was flying over mountains, free and calm.',
      style: 'Cinematic',
      videoUrl: 'https://example.com/fake-video.mp4',
      isPublished: false,
      createdAt: new Date().toISOString()
    }, extra));
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, { id: dreamId, extra: extra });
  await page.goto(baseUrl + '/result.html?id=' + dreamId + (query || ''), { waitUntil: 'domcontentloaded' });
}

test('result.html: an OWNER who sits idle on their finished dream is redirected to the home hub (passive-bounce catch)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedResultPage(page, 'd-idle-redirect', '&idlems=500');
    // The finished video dream is watchable (its src is set); with no
    // interaction, the idle timer fires and lands them on home.html.
    await page.waitForURL(/\/home\.html/, { timeout: 6000 });
  } finally {
    await context.close();
  }
});

test('result.html: ANY interaction disarms the idle redirect — an engaged user is never yanked to home', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedResultPage(page, 'd-idle-engaged', '&idlems=800');
    // Interact once, well inside the window, then wait past it: must stay put.
    await page.waitForSelector('#dreamvideo-frame', { timeout: 5000 });
    await page.mouse.click(30, 30);
    await page.waitForTimeout(1600); // > idlems; the one interaction should have permanently disarmed it
    assert.match(new URL(page.url()).pathname, /\/result\.html$/, 'an interacted-with result page must NOT auto-redirect');
  } finally {
    await context.close();
  }
});

test('result.html: a NON-owner viewing a shared dream is never idle-redirected (only the owner is)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    // Owned by someone else -> isMyDream is false -> the redirect never arms.
    await seedResultPage(page, 'd-idle-shared', '&idlems=400', { ownerHandle: '@someone-else' });
    await page.waitForTimeout(1400); // > idlems
    assert.match(new URL(page.url()).pathname, /\/result\.html$/, 'a shared-dream viewer (non-owner) must stay on the result page');
  } finally {
    await context.close();
  }
});
