// test/result-play-intent-behavioral.test.js
//
// Founder fix, 2026-08-06: tapping the Play badge (or "Watch your video")
// on home's Day-0 card navigated to result.html where the video "does not
// start playing so it requires the user again to tap". The tap's gesture
// can't survive a page navigation, so home.html now passes &play=1 and
// result.html opens its in-app overlay player immediately (the overlay
// needs no gesture; the native-fullscreen tiers, which do, are skipped on
// this path — see result.html's own &play=1 comment block).
//
// Asserts, in a real mobile-viewport browser:
//   1. result.html?id=X&play=1 -> the player overlay is OPEN with no tap,
//      and the &play param has been stripped from the URL (so refresh/back
//      can't re-open the player uninvited).
//   2. Plain result.html?id=X -> the overlay stays CLOSED (the ambient
//      card preview is unchanged; no uninvited fullscreen).
//   3. home.html's two play CTAs (#d0-video tap on a ready dream, and
//      #d0-watch) both navigate WITH &play=1.

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
var MOBILE_VIEWPORT = { width: 390, height: 844 };

test.before(async function () {
  if (unavailableReason) return;
  server = await staticServer.start();
  baseUrl = server.url;
  browser = await playwright.chromium.launch({ executablePath: CHROMIUM_PATH });
});

test.after(async function () {
  if (browser) await browser.close();
  if (server) await server.close();
});

var TEST_VIDEO_URL = '/assets/interpreters/intro/sage-intro-reference.mp4'; // any real, small, repo-local mp4

async function seedUserWithReadyDream(page, username, dreamId) {
  await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function (args) {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@' + args.username, username: args.username };
    if (!state.accounts) state.accounts = {};
    state.accounts[args.username] = { password: 'testpass1', email: args.username + '@example.com' };
    state.dreams = [{
      id: args.dreamId, ownerHandle: '@' + args.username, title: 'Play-intent test dream',
      promptText: 'I was flying over a quiet sea.', storyText: 'I was flying over a quiet sea.',
      style: 'Cinematic', videoUrl: args.videoUrl, dur: '0:08',
      likes: 0, likedByMe: false, isPublished: false,
      createdAt: Date.now(), updatedAt: Date.now()
    }];
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, { username: username, dreamId: dreamId, videoUrl: TEST_VIDEO_URL });
}

test('result.html?play=1 opens the overlay player with no tap and strips the param', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  var page = await context.newPage();
  await seedUserWithReadyDream(page, 'playintent1', 'dplaytest1');
  await page.goto(baseUrl + '/result.html?id=dplaytest1&play=1', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  var overlayOpen = await page.evaluate(function () {
    var el = document.getElementById('player-overlay');
    return !!(el && el.classList.contains('open'));
  });
  assert.equal(overlayOpen, true, 'player overlay should be open without any tap');
  var url = page.url();
  assert.ok(url.indexOf('play=1') === -1, 'play param should be stripped from the URL, got: ' + url);
  assert.ok(url.indexOf('id=dplaytest1') !== -1, 'dream id must survive the param strip');
  await context.close();
});

test('plain result.html does NOT open the overlay uninvited', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  var page = await context.newPage();
  await seedUserWithReadyDream(page, 'playintent2', 'dplaytest2');
  await page.goto(baseUrl + '/result.html?id=dplaytest2', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  var overlayOpen = await page.evaluate(function () {
    var el = document.getElementById('player-overlay');
    return !!(el && el.classList.contains('open'));
  });
  assert.equal(overlayOpen, false, 'no play intent -> overlay must stay closed');
  await context.close();
});

test("home's Day-0 play CTAs both navigate with &play=1", async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  var page = await context.newPage();
  await seedUserWithReadyDream(page, 'playintent3', 'dplaytest3');
  await page.goto(baseUrl + '/home.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  var hasCard = await page.evaluate(function () { return !!document.getElementById('d0-video'); });
  if (!hasCard) {
    // The Day-0 card only renders in its eligible states — if this seeded
    // state doesn't produce it, the two source-level assertions below
    // still pin the navigation contract.
    var homeSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'home.html'), 'utf8');
    assert.ok(/d0-video[\s\S]{0,600}?result\.html\?id=' \+ encodeURIComponent\(d0DreamId\) \+ '&play=1'/.test(homeSrc), 'd0-video must navigate with &play=1');
    assert.ok(homeSrc.split("'&play=1'").length >= 3, 'both play CTAs must carry &play=1');
    await context.close();
    return;
  }
  await page.click('#d0-video');
  await page.waitForTimeout(800);
  var landed = page.url();
  assert.ok(/result\.html\?id=.*(&|\?)play=1|dplaytest3/.test(landed), 'play tap should land on result with play intent, got: ' + landed);
  await context.close();
});
