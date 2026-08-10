// test/daily-recall-tip-behavioral.test.js
//
// Behavioral coverage for the "daily TIP area" module (tracker item
// auto-retention-sprint-addendum-founder-0-r3i0y9 -- the WhatsApp-channel
// half of that same item is separately tracked/blocked on Meta infra and
// out of scope here). A small, genuinely ambient module (`#recall-tip`)
// riding directly under home.html's ritual module: plain text, no
// button/card/link chrome, a ~14-tip dream-RECALL-only seed list, and a
// DATE-keyed rotation (same tip for every viewer on a given local
// calendar day) rather than the tap-advanced, per-account rotation the
// pre-existing "Tip of the day" section (`#tipsect`/`#tipcard`, tracker
// for-product-build-ship-founder-approved--9ta1j0) already uses --
// see test/home-round4-behavioral.test.js for that section's own
// coverage, deliberately untouched by this build.
//
// Follows this repo's established Playwright/node:test convention (test/
// home-round4-behavioral.test.js's own seedHomeUser/mockTokenStatus/
// mockFeed/blockThirdParty shape) rather than inventing a new one.

var test = require('node:test');
var assert = require('node:assert/strict');
var staticServer = require('./helpers/static-server');

var CHROMIUM_PATH = '/opt/pw-browsers/chromium';
var MOBILE_VIEWPORT = { width: 390, height: 844 };

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

function newMobileContext(extraOpts) {
  return browser.newContext(Object.assign({ viewport: MOBILE_VIEWPORT }, extraOpts || {}));
}

/** Aborts requests to third-party hosts every page here loads -- see CLAUDE.md on this sandbox's outbound network. */
function blockThirdParty(page) {
  return page.route(/fonts\.(googleapis|gstatic)\.com|connect\.facebook\.net|i\.posthog\.com/, function (route) {
    route.abort();
  });
}

function mockTokenStatus(page, status) {
  return page.route('**/.netlify/functions/get-token-status*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(status || { balance: 220, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 2 }) });
  });
}

function mockFeed(page, feed) {
  return page.route('**/.netlify/functions/get-feed*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ feed: feed || [], dreamOfDayId: null }) });
  });
}

/** Seeds a logged-in account directly into localStorage and navigates to home.html -- same shape as test/home-round4-behavioral.test.js's own seedHomeUser. */
async function seedHomeUser(page, opts) {
  opts = opts || {};
  var username = opts.username || 'tester';
  await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function (args) {
    var state = {
      user: { handle: '@' + args.username, username: args.username },
      accounts: {},
      draft: {},
      dreams: args.dreams || []
    };
    state.accounts[args.username] = { password: 'testpass1', email: args.username + '@example.com' };
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, { username: username, dreams: opts.dreams });
  await page.goto(baseUrl + '/home.html', { waitUntil: 'domcontentloaded' });
}

test('home.html: the daily recall-tip module renders a non-empty tip, is genuinely ambient (no button/link semantics), and sits directly under the ritual module, above Tip of the day', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await mockFeed(page, []);
    await seedHomeUser(page, { username: 'recalltiptester1', dreams: [] });
    await page.waitForSelector('#recall-tip', { state: 'visible', timeout: 5000 });

    var tag = await page.locator('#recall-tip').evaluate(function (el) { return el.tagName.toLowerCase(); });
    assert.equal(tag, 'p', 'the module must be plain text, not a button/a element (the founder spec: "clearly not a button")');

    var text = (await page.locator('#recall-tip-text').textContent()).trim();
    assert.ok(text.length > 10, 'expected a real, non-empty tip, got: ' + JSON.stringify(text));

    // DOM order: #ritual, then #recall-tip, then #tipsect (Tip of the day).
    var order = await page.evaluate(function () {
      var main = document.querySelector('#recall-tip').parentElement;
      var ids = Array.prototype.map.call(main.children, function (el) { return el.id; }).filter(Boolean);
      return ids;
    });
    var ritualIdx = order.indexOf('ritual');
    var recallIdx = order.indexOf('recall-tip');
    var tipsectIdx = order.indexOf('tipsect');
    assert.ok(ritualIdx >= 0 && recallIdx > ritualIdx, 'recall-tip must come after the ritual module');
    assert.ok(tipsectIdx > recallIdx, 'recall-tip must come before the existing Tip of the day section');
  } finally {
    await context.close();
  }
});

test('home.html: the recall tip is content distinct from the existing Tip of the day 10-tip list (no verbatim duplicate on-page)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await mockFeed(page, []);
    await seedHomeUser(page, { username: 'recalltiptester2', dreams: [] });
    await page.waitForSelector('#recall-tip', { state: 'visible', timeout: 5000 });
    await page.waitForSelector('#tipsect', { state: 'visible', timeout: 5000 });

    var recallText = (await page.locator('#recall-tip-text').textContent()).trim();
    var existingTipTexts = [];
    for (var i = 0; i < 10; i++) {
      existingTipTexts.push((await page.locator('#tip-text').textContent()).trim());
      await page.click('#tipcard');
      await page.waitForTimeout(200);
    }
    assert.ok(existingTipTexts.indexOf(recallText) === -1, 'the recall-tip text must not literally duplicate one of the existing Tip of the day entries verbatim, got: ' + JSON.stringify(recallText));
  } finally {
    await context.close();
  }
});

test('home.html: the recall tip has no tap affordance -- clicking it does nothing (no navigation, no state change, no click handler wired)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await mockFeed(page, []);
    await seedHomeUser(page, { username: 'recalltiptester3', dreams: [] });
    await page.waitForSelector('#recall-tip', { state: 'visible', timeout: 5000 });

    var before = (await page.locator('#recall-tip-text').textContent()).trim();
    var urlBefore = page.url();
    await page.click('#recall-tip', { force: true });
    await page.waitForTimeout(300);
    var after = (await page.locator('#recall-tip-text').textContent()).trim();
    assert.equal(after, before, 'the tip text must not change on click -- this module is not tap-advanced');
    assert.equal(page.url(), urlBefore, 'clicking the tip must never navigate');
  } finally {
    await context.close();
  }
});

test('home.html: the recall tip rotates DAILY, keyed to the local calendar date, not per-account or per-tap -- two different accounts on the same day see the same tip, and the underlying index formula changes only when the local day changes', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await mockFeed(page, []);
    await seedHomeUser(page, { username: 'recalltiptester4', dreams: [] });
    await page.waitForSelector('#recall-tip', { state: 'visible', timeout: 5000 });
    var firstAccountTip = (await page.locator('#recall-tip-text').textContent()).trim();

    // A second, entirely different account on the same browser/day must see
    // the exact same tip -- proving the rotation is date-keyed, not
    // account-scoped (unlike the existing Tip of the day's tipsSeenIds/
    // tipCurrentId per-account state).
    await seedHomeUser(page, { username: 'recalltiptester5', dreams: [] });
    await page.waitForSelector('#recall-tip', { state: 'visible', timeout: 5000 });
    var secondAccountTip = (await page.locator('#recall-tip-text').textContent()).trim();
    assert.equal(secondAccountTip, firstAccountTip, 'two different accounts on the same local day must see the identical recall tip');

    // The exposed dailyRecallTipIndex(len, now) helper must be a pure
    // function of the local calendar day: two Date objects on the same
    // local day return the same index; a Date 24h later returns the next
    // (wrapping) index.
    var indices = await page.evaluate(function () {
      var len = 14; // mirrors RECALL_TIPS.length at time of writing; the function itself takes len as a param so this stays correct even if the list is resized
      var now = new Date();
      var laterSameDay = new Date(now.getTime());
      laterSameDay.setHours(23, 59, 0, 0);
      var earlierSameDay = new Date(now.getTime());
      earlierSameDay.setHours(0, 1, 0, 0);
      var nextDay = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      return {
        a: window.dailyRecallTipIndex(len, now),
        bSame: window.dailyRecallTipIndex(len, laterSameDay),
        cSame: window.dailyRecallTipIndex(len, earlierSameDay),
        dNextDay: window.dailyRecallTipIndex(len, nextDay)
      };
    });
    assert.equal(typeof indices.a, 'number');
    assert.equal(indices.a, indices.bSame, 'same local calendar day (later clock time) must yield the same index');
    assert.equal(indices.a, indices.cSame, 'same local calendar day (earlier clock time) must yield the same index');
    assert.equal(indices.dNextDay, (indices.a + 1) % 14, 'the next local calendar day must advance the index by exactly one, wrapping at the list length');
  } finally {
    await context.close();
  }
});

test('home.html: the full RECALL_TIPS seed list (source-level) has ~14 recall-focused entries and no medical/therapeutic claim language', function () {
  var fs = require('fs');
  var path = require('path');
  var src = fs.readFileSync(path.join(__dirname, '..', 'home.html'), 'utf8');
  var match = src.match(/var RECALL_TIPS = \[([\s\S]*?)\];/);
  assert.ok(match, 'expected to find the RECALL_TIPS array literal in home.html');
  var arrayBody = match[1];
  // Count entries by counting top-level quoted-string items (each tip is one line).
  var lines = arrayBody.split('\n').map(function (l) { return l.trim(); }).filter(function (l) { return l.length > 0; });
  assert.ok(lines.length >= 12 && lines.length <= 16, 'expected roughly a 14-tip seed list, found ' + lines.length + ' entries');
  var bannedPattern = /\b(cure|diagnos|treat(ment|s)?|therapy|therapeutic|medication|prescri|disorder|insomnia|anxiety|depression|clinical|symptom)\b/i;
  assert.equal(bannedPattern.test(arrayBody), false, 'the seed list source must avoid medical/therapeutic claim language');
});
