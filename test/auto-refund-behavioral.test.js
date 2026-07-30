// test/auto-refund-behavioral.test.js
//
// Real browser-driven coverage for the auto-refund tracker item
// idea-auto-refund-policy's CLIENT side (founder-approved 2026-07-26): the
// server-side crediting/idempotency guarantee itself is covered by
// test/entitlements-refund.test.js and test/video-status-refund.test.js/
// test/image-status-refund.test.js (unit + handler-level, both run
// against real fal.ai/PostHog fetch stubs) — this file proves the two
// wiring changes those tests can't reach on their own:
//
//   1. js/store.js's pollUntilDone actually sends `email` on the
//      video-status.js/image-status.js poll request (the refund can't be
//      credited to the right account without it).
//   2. processing.html's failure screen shows "Your tokens were
//      returned." exactly when (and only when) the poll response actually
//      carried `tokensRefunded: true` — never assumed client-side just
//      because generation failed at all.
//
// Follows test/logout-clears-pendingjob-behavioral.test.js's/test/image-
// generation-turn-into-video-behavioral.test.js's conventions: a plain
// static file server (no real Netlify Functions runtime), page.route()
// to stand in for video-status.js, blockThirdParty() for this sandbox's
// flaky outbound network, and safeGoto() to tolerate a transient nav
// failure. A pendingJob is seeded directly into localStorage (mirroring
// seedLoggedInWithPendingJob) so processing.html's runGeneration() takes
// the RESUME path straight into pollUntilDone — no need to also mock
// generate-video.js's submission step, since a resume never re-submits.

var test = require('node:test');
var assert = require('node:assert/strict');
var staticServer = require('./helpers/static-server');
var settle = require('./helpers/settle').settle;

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

/** Same shape as logout-clears-pendingjob-behavioral.test.js's own seedLoggedInWithPendingJob, generalized to accept a mediaType so this file can seed either a video or image resume job. */
async function seedLoggedInWithPendingJob(page, username, password, email, opts) {
  opts = opts || {};
  await page.evaluate(function (args) {
    var handle = '@' + args.username;
    var pendingJob = {
      operationName: (args.mediaType === 'image' ? 'fal:fal-ai/flux/dev:' : 'fal:fal-ai/veo3.1/fast:') + 'req-' + args.username,
      startedAt: Date.now(),
      caption: args.username + '\'s in-flight dream',
      style: 'Cinematic',
      sourceDreamId: null,
      mediaType: args.mediaType || 'video',
      ownerHandle: handle,
      notify: false
    };
    var state = {
      user: { handle: handle, username: args.username },
      accounts: {},
      draft: { caption: '', style: null, sourceDreamId: null, restore: false, characterIds: [], cameraView: null, sceneryTime: null, sceneryPlace: null, mediaType: null, sourceImageUrl: null },
      dreams: [],
      pendingJob: pendingJob,
      charactersByUser: {},
      likedIds: {}
    };
    state.accounts[args.username] = { password: args.password, email: args.email };
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, { username: username, password: password, email: email, mediaType: opts.mediaType });

  await safeGoto(page, baseUrl + '/login.html');
}

test('processing.html: a refund-eligible generation failure (tokensRefunded:true from video-status.js) shows "Your tokens were returned." and video-status.js received the account email', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await safeGoto(page, baseUrl + '/login.html');
    await seedLoggedInWithPendingJob(page, 'refundshown', 'refundshownpassword1', 'refundshown@example.com');

    var videoStatusCalls = [];
    await page.route('**/.netlify/functions/video-status*', function (route) {
      var url = new URL(route.request().url());
      videoStatusCalls.push({ email: url.searchParams.get('email'), name: url.searchParams.get('name') });
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, error: 'E205: generation_failed: FAILED', tokensRefunded: true }) });
    });

    await safeGoto(page, baseUrl + '/processing.html');
    await page.waitForSelector('#proc-fail', { state: 'visible', timeout: 8000 });

    await settle(function () { return videoStatusCalls.length >= 1; });
    assert.equal(videoStatusCalls.length, 1);
    assert.equal(videoStatusCalls[0].email, 'refundshown@example.com', 'video-status.js must receive the logged-in account\'s email so a refund can be credited to the right balance');
    assert.equal(videoStatusCalls[0].name, 'fal:fal-ai/veo3.1/fast:req-refundshown');

    var refundCopyVisible = await page.locator('#proc-fail-refund').isVisible();
    assert.equal(refundCopyVisible, true, 'the "Your tokens were returned." copy must show when the server reported tokensRefunded:true');
    var refundCopyText = await page.textContent('#proc-fail-refund');
    assert.match(refundCopyText, /Your tokens were returned\./);

    // The underlying failure reason must still render too -- this is an
    // addition to the existing failure screen, not a replacement of it.
    var reasonVisible = await page.locator('#proc-fail-reason').isVisible();
    assert.equal(reasonVisible, true);
  } finally {
    await page.close();
  }
});

test('processing.html: a generation failure WITHOUT a server-reported refund does not show "Your tokens were returned."', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await safeGoto(page, baseUrl + '/login.html');
    await seedLoggedInWithPendingJob(page, 'refundnotshown', 'refundnotshownpassword1', 'refundnotshown@example.com');

    await page.route('**/.netlify/functions/video-status*', function (route) {
      // A transport-level hiccup (E204-class) -- not refund-eligible, so
      // video-status.js itself would never set tokensRefunded here either;
      // this simulates that real response shape directly.
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, error: 'E204: status_check_failed' }) });
    });

    await safeGoto(page, baseUrl + '/processing.html');
    await page.waitForSelector('#proc-fail', { state: 'visible', timeout: 8000 });

    var refundCopyVisible = await page.locator('#proc-fail-refund').isVisible();
    assert.equal(refundCopyVisible, false, 'the refund copy must not be assumed just because generation failed -- only the server\'s tokensRefunded flag can show it');
  } finally {
    await page.close();
  }
});

test('processing.html: the refund copy also works for the image path (image-status.js)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await safeGoto(page, baseUrl + '/login.html');
    await seedLoggedInWithPendingJob(page, 'refundimage', 'refundimagepassword1', 'refundimage@example.com', { mediaType: 'image' });

    var imageStatusCalls = [];
    await page.route('**/.netlify/functions/image-status*', function (route) {
      var url = new URL(route.request().url());
      imageStatusCalls.push({ email: url.searchParams.get('email') });
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, error: 'E508: no_image_in_response', tokensRefunded: true }) });
    });

    await safeGoto(page, baseUrl + '/processing.html');
    await page.waitForSelector('#proc-fail', { state: 'visible', timeout: 8000 });

    await settle(function () { return imageStatusCalls.length >= 1; });
    assert.equal(imageStatusCalls.length, 1);
    assert.equal(imageStatusCalls[0].email, 'refundimage@example.com');
    assert.equal(await page.locator('#proc-fail-refund').isVisible(), true);
  } finally {
    await page.close();
  }
});

test('processing.html: the refund copy from an earlier failure does not linger into a later, unrelated failure ("Try Again")', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await safeGoto(page, baseUrl + '/login.html');
    await seedLoggedInWithPendingJob(page, 'refundresets', 'refundresetspassword1', 'refundresets@example.com');

    await page.route('**/.netlify/functions/video-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, error: 'E205: generation_failed: FAILED', tokensRefunded: true }) });
    });

    await safeGoto(page, baseUrl + '/processing.html');
    await page.waitForSelector('#proc-fail', { state: 'visible', timeout: 8000 });
    assert.equal(await page.locator('#proc-fail-refund').isVisible(), true, 'sanity check: the first failure shows the refund copy');

    // Tapping "Try Again" re-runs generation as a FRESH submission (the
    // resumed pendingJob was cleared on the earlier failure) -- mock a
    // NON-refund-eligible failure on the resubmit and confirm the copy
    // from the PREVIOUS failure doesn't linger into this new one.
    await page.route('**/.netlify/functions/generate-video', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'fal:fal-ai/veo3.1/fast:req-retry' }) });
    });
    await page.route('**/.netlify/functions/get-token-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ balance: 1000, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 10 }) });
    });
    await page.unroute('**/.netlify/functions/video-status*');
    await page.route('**/.netlify/functions/video-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, error: 'E204: status_check_failed' }) });
    });

    await page.click('#retry-btn');
    await page.waitForSelector('#proc-fail', { state: 'visible', timeout: 8000 });
    assert.equal(await page.locator('#proc-fail-refund').isVisible(), false, 'the refund copy from the earlier failure must not linger into an unrelated later failure');
  } finally {
    await page.close();
  }
});
