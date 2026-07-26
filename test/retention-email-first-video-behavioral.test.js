// test/retention-email-first-video-behavioral.test.js
//
// Real browser-driven coverage for the retention-email client call sites
// (tracker.html's for-product-retention-email-send-user-th-eke9ra item) —
// complements test/send-first-dream-email.test.js's server-side unit
// coverage by proving the actual pages fire (or correctly don't fire) the
// request at the right moment, and that watch.html (the emailed link's
// landing page) genuinely renders a dream via a share token with no login.
// Follows test/first-video-created-behavioral.test.js's seedAccount/
// markJustGenerated conventions exactly, since this fires from the same
// choke point.

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

/** Same seeding shape as test/first-video-created-behavioral.test.js's seedAccount. */
async function seedAccount(page, opts) {
  await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function (o) {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@' + o.username, username: o.username };
    if (!state.accounts) state.accounts = {};
    state.accounts[o.username] = { password: 'testpass1', email: o.email || null };
    if (o.firstVideoCreatedFired) state.accounts[o.username].firstVideoCreatedFired = true;
    if (!state.dreams) state.dreams = [];
    (o.dreams || []).forEach(function (d) {
      state.dreams.push(Object.assign({
        ownerHandle: '@' + o.username,
        caption: 'A test dream',
        style: 'Cinematic',
        videoUrl: 'https://example.com/fake-video.mp4',
        isPublished: false,
        likes: 0, likedByMe: false, dur: '0:08'
      }, d));
    });
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, opts);
}

function markJustGenerated(page, dreamId) {
  return page.evaluate(function (id) {
    sessionStorage.setItem('dreamtube_just_generated_id', id);
  }, dreamId);
}

/** Intercepts POST to send-first-dream-email, recording each parsed body and fulfilling with a harmless 200. */
function captureSendFirstDreamEmail(page) {
  var calls = [];
  return page.route('**/.netlify/functions/send-first-dream-email', function (route) {
    var body = null;
    try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) { /* leave null */ }
    calls.push(body);
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  }).then(function () { return calls; });
}

test('result.html: a brand-new account\'s first-ever completed dream triggers the retention-email request exactly once, with the dream\'s own data', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var emailCalls = await captureSendFirstDreamEmail(page);

    await seedAccount(page, {
      username: 'retentionuser',
      email: 'retention@example.com',
      dreams: [{ id: 'dream-ret-1', caption: 'Flying over mountains', style: 'Anime' }]
    });
    await markJustGenerated(page, 'dream-ret-1');

    await page.goto(baseUrl + '/result.html?id=dream-ret-1', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(300);

    assert.equal(emailCalls.length, 1, 'expected exactly one send-first-dream-email request');
    assert.equal(emailCalls[0].username, 'retentionuser');
    assert.equal(emailCalls[0].dreamId, 'dream-ret-1');
    assert.equal(emailCalls[0].caption, 'Flying over mountains');
    assert.equal(emailCalls[0].style, 'Anime');
    assert.equal(emailCalls[0].videoUrl, 'https://example.com/fake-video.mp4');
    assert.equal(emailCalls[0].mediaType, 'video');

    // A reload must not re-fire -- same guard as FirstVideoCreated itself.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(300);
    assert.equal(emailCalls.length, 1, 'a reload of the same first video must not re-trigger the retention email request');
  } finally {
    await context.close();
  }
});

test('result.html: a second completed dream never triggers the retention-email request', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var emailCalls = await captureSendFirstDreamEmail(page);

    await seedAccount(page, {
      username: 'retentionseconduser',
      email: 'retention2@example.com',
      dreams: [{ id: 'dream-ret-2a' }, { id: 'dream-ret-2b' }]
    });
    await markJustGenerated(page, 'dream-ret-2b');

    await page.goto(baseUrl + '/result.html?id=dream-ret-2b', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(300);

    assert.equal(emailCalls.length, 0, 'a 2nd/Nth dream must never trigger the retention email request');
  } finally {
    await context.close();
  }
});

test('watch.html: a valid share token renders the dream video and caption, no login required', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);

    await page.route('**/.netlify/functions/get-shared-dream*', function (route) {
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ ok: true, dream: { id: 'dream-x', caption: 'A watched dream', style: 'Realistic', videoUrl: 'https://example.com/watch-video.mp4', mediaType: 'video' } })
      });
    });

    await page.goto(baseUrl + '/watch.html?id=dream-x&token=faketoken123', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#ready-view[style*="flex"]', { timeout: 5000 }).catch(function(){});
    await page.waitForTimeout(200);

    var videoSrc = await page.$eval('#ready-video', function (el) { return el.src; });
    var caption = await page.$eval('#ready-caption', function (el) { return el.textContent; });
    assert.equal(videoSrc, 'https://example.com/watch-video.mp4');
    assert.equal(caption, 'A watched dream');

    // "Make another dream" nudges to create.html -- a logged-out visitor
    // (this test's browser context never logged in) gets create.html's own
    // existing login gate bouncing them to login.html, same as any other
    // logged-out visit to create.html; that's correct, pre-existing
    // behavior, not something this page changes.
    await Promise.all([
      page.waitForURL(/create\.html|login\.html/, { timeout: 5000 }).catch(function(){}),
      page.click('#make-another-btn')
    ]);
    assert.match(page.url(), /create\.html|login\.html/);
  } finally {
    await context.close();
  }
});

test('watch.html: an invalid/expired token shows a clear error, not a broken page', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);

    await page.route('**/.netlify/functions/get-shared-dream*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'E3: invalid_or_expired' }) });
    });

    await page.goto(baseUrl + '/watch.html?id=dream-x&token=badtoken', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(300);

    var errorVisible = await page.$eval('#error-view', function (el) { return getComputedStyle(el).display !== 'none'; });
    assert.equal(errorVisible, true);
  } finally {
    await context.close();
  }
});
