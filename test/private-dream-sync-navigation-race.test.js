// test/private-dream-sync-navigation-race.test.js
//
// Regression coverage for tracker item
// for-product-p0-data-loss-founder-repro-0-6bzvv1 (P0: a real, token-
// charged generation — "Ziv is dancing" — completed (confirmed by a real
// PostHog video_created event) but was completely absent from the
// founder's account when checked from a FRESH PRIVATE TAB, i.e. absent
// from the server-side dream-sync store, even though his other dreams
// were fine).
//
// INVESTIGATION NOTE (honest-uncertainty — see the build session's own
// report for the full writeup): the working theory going in was a direct
// write-side mirror of the ALREADY-CONFIRMED tracker item nsbbg5 race (an
// in-flight fetch aborted by same-tab navigation to a different page,
// or the tab/app being closed outright). Directly probing this sandbox's
// real Chromium/Playwright network behavior showed that does NOT reliably
// reproduce a genuine SERVER-SIDE loss the way it does for nsbbg5's GET:
// a page.route()-intercepted POST still gets delivered to (and processed
// by) the mock even after the requesting page has navigated away or been
// closed, by the time the real app's own DOM has updated to show the
// completed dream — Netlify Functions/AWS Lambda invocations, once a
// request has actually been dispatched, generally keep running to
// completion server-side regardless of what happens to the client
// afterward. So while this remains a plausible contributing factor in
// principle (and the fix below hardens against it regardless — see the
// first test), it could NOT be reproduced as a reliable, deterministic
// cause of genuine data loss in this harness.
//
// What COULD be confirmed, deterministically and without any timing
// dependence at all, is the mechanism the second test below covers:
// js/store.js's own attemptLocalLogin has always documented that a real,
// pre-existing, already-"signed in" account's session can legitimately
// end up with `state.user.authToken: null` (not just a brand-new offline
// signup) whenever the real server-side login call couldn't be reached
// at that moment. syncPrivateDreamBestEffort correctly (and
// intentionally) no-ops without an authToken — but pre-fix, a dream
// created during exactly that window stayed permanently, silently
// unsynced even after the SAME session's authToken later came back,
// because nothing ever revisited it: reconcilePrivateDreamsFromServer's
// own catch-up push only runs off a fresh login, and an
// already-"signed in" session has no natural reason to log out and back
// in again just because a token quietly reappeared. This fully explains
// every symptom of the real incident (a real, charged completion; would
// be present locally on the originating device; absent from a fresh
// device's login; other, properly-synced dreams unaffected) with no race
// timing required — this is the best-supported, reproduced mechanism
// this investigation found, though it cannot be 100% confirmed as THE
// exact cause of the founder's own incident without production log/
// localStorage access this sandbox does not have.
//
// Regardless of which (or both, or neither) applied to the real
// incident, js/store.js's syncPrivateDreamBestEffort was genuinely
// fire-and-forget with zero retry and zero confirmation tracking before
// this fix — an independently real gap. Both tests below exercise the
// fix: retry-with-backoff for a genuine transient failure, and a
// load-time sweep (retryUnconfirmedPrivateDreamSyncs) that catches up
// any dream whose sync was never confirmed, the next time ANY page loads
// with a real authToken on file — no login/logout required.

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

async function safeGoto(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  } catch (e) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  }
}

/** Mocks a generation that completes immediately with a fake video — same shape as test/first-video-created-behavioral.test.js's mockGenerationCompletesImmediately, trimmed to what this file needs. */
function mockGenerationCompletesImmediately(page) {
  return Promise.all([
    page.route('**/.netlify/functions/generate-video', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'fal:fal-ai/veo3.1/fast:ziv-dancing-op' }) });
    }),
    page.route('**/.netlify/functions/video-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, videoUrl: 'https://example.com/ziv-dancing.mp4' }) });
    }),
    page.route('**/.netlify/functions/mark-generation-completed', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    }),
    page.route('**/.netlify/functions/consume-generation-marker', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ matched: false }) });
    }),
    page.route('**/.netlify/functions/get-feed', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ feed: [], dreamOfDayId: null }) });
    })
  ]);
}

/**
 * Mocks dream-sync.js with an in-memory "server" store shared across every
 * page in this browser CONTEXT (a real Netlify Blobs store is likewise
 * shared across every page/device for the same account). Records every
 * upsert POST actually received, per dream id. The first `failCount`
 * upsert attempts for EVERY dream id come back as a genuine server-side
 * 500 (dream-sync.js's own real E8: sync_write_failed shape) — a real,
 * if rare, transient failure, not a network/connectivity blip — before
 * succeeding normally.
 */
function mockDreamSync(page, failCount) {
  var upsertCallsById = {};
  var serverDreams = {};
  page.route('**/.netlify/functions/dream-sync*', function (route) {
    var req = route.request();
    if (req.method() === 'GET') {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, dreams: Object.keys(serverDreams).map(function (k) { return serverDreams[k]; }) }) });
      return;
    }
    var body = JSON.parse(req.postData());
    if (body.action === 'delete') {
      delete serverDreams[body.dreamId];
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      return;
    }
    var id = body.dream.id;
    upsertCallsById[id] = (upsertCallsById[id] || 0) + 1;
    if (failCount && upsertCallsById[id] <= failCount) {
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'E8: sync_write_failed' }) });
      return;
    }
    serverDreams[id] = body.dream;
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  return { upsertCallsById: upsertCallsById, serverDreams: serverDreams };
}

/** Seeds a logged-in account with a real authToken and a caption+style draft, landing on home.html's `?generate=1` fresh-generation path -- mirrors test/first-video-created-behavioral.test.js's seedAccountWithDraft, extended with authToken (dream-sync is a no-op without one). */
async function seedAccountWithDraft(page, opts) {
  await safeGoto(page, baseUrl + '/login.html');
  await page.evaluate(function (o) {
    var state = {
      user: { handle: '@' + o.username, username: o.username, authToken: o.authToken },
      accounts: {},
      dreams: [],
      pendingJob: null,
      charactersByUser: {},
      likedIds: {},
      blockedByUser: {},
      draft: { caption: 'Ziv is dancing', storyText: 'Ziv is dancing', style: 'Realistic', mediaType: 'video', sourceDreamId: null, restore: false, characterIds: [], cameraView: null, sceneryTime: null, sceneryPlace: null, sourceImageUrl: null, audioOn: false, musicStyle: null }
    };
    state.accounts[o.username] = { password: 'testpass1', email: o.email || null };
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    localStorage.setItem('dreamtube_feed_backfill_v1_done', '1');
  }, opts);
}

test('regression (6bzvv1): a real transient server-side sync failure (E8) is retried automatically instead of being silently swallowed', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockGenerationCompletesImmediately(page);
    // Fails the first 2 attempts for every dream id, succeeds the 3rd --
    // exercises the full retry budget (PRIVATE_DREAM_SYNC_RETRY_DELAYS_MS
    // has exactly 2 backoff slots -> 3 attempts total).
    var sync = mockDreamSync(page, 2);

    await seedAccountWithDraft(page, { username: 'ronbrightman', email: 'ron@example.com', authToken: 'real-founder-token' });
    await safeGoto(page, baseUrl + '/home.html?generate=1');
    await page.waitForSelector('#d0-video.ready', { timeout: 8000 });

    var localDream = await page.evaluate(function () { return window.DreamStore.getMyDreams()[0]; });
    assert.equal(localDream.caption, 'Ziv is dancing');

    var confirmed = await settle(function () {
      return (sync.serverDreams[localDream.id] && sync.serverDreams[localDream.id].caption === 'Ziv is dancing');
    }, { timeout: 8000, interval: 25 });
    assert.ok(confirmed, 'a dream must still reach the server after two real transient sync failures, via this page\'s own retry -- not silently dropped the way a bare .catch() with no retry would drop it');
    assert.ok(sync.upsertCallsById[localDream.id] >= 3, 'must have actually retried (at least 3 attempts observed), not just gotten lucky on the first try');

    var confirmedLocally = await settle(async function () {
      var d = await page.evaluate(function (id) {
        return window.DreamStore.getMyDreams().find(function (x) { return x.id === id; });
      }, localDream.id);
      return d && d.syncConfirmed === true;
    }, { timeout: 2000, interval: 25 });
    assert.ok(confirmedLocally, 'the dream\'s own local syncConfirmed flag must flip true once the retry actually succeeds');
  } finally {
    await context.close();
  }
});

test('regression (6bzvv1): a dream generated while state.user.authToken is null never even attempts a sync, but reaches the server automatically once a later page load has a real token on file', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockGenerationCompletesImmediately(page);
    var sync = mockDreamSync(page, 0);

    // Same account, but authToken:null -- exactly attemptLocalLogin's own
    // documented local-only-fallback shape (a real, pre-existing account
    // whose real server-side login call couldn't be reached at that
    // moment), not a special/contrived state.
    await seedAccountWithDraft(page, { username: 'ronbrightman', email: 'ron@example.com', authToken: null });
    await safeGoto(page, baseUrl + '/home.html?generate=1');
    await page.waitForSelector('#d0-video.ready', { timeout: 8000 });

    var localDream = await page.evaluate(function () { return window.DreamStore.getMyDreams()[0]; });
    assert.equal(localDream.caption, 'Ziv is dancing', 'sanity: the dream is still created locally -- tokens were still charged, the video still exists');

    // Give any errant sync attempt a moment, then confirm none was ever
    // even ATTEMPTED -- this isn't a race, it's a deterministic guard.
    await new Promise(function (r) { setTimeout(r, 300); });
    assert.equal(sync.upsertCallsById[localDream.id] || 0, 0, 'no authToken on file must mean dream-sync is never even called for this dream');
    assert.equal(localDream.syncConfirmed, false, 'the dream must be marked not-yet-confirmed so a later opportunity knows to retry it');

    // Later, this SAME session's authToken comes back -- e.g. the next
    // real, server-reachable login (attemptLocalLogin's own doc comment
    // names this as the expected eventual recovery), simulated directly
    // here the same lightweight way seedAccountWithDraft already seeds
    // state, since the actual mechanism that repairs authToken isn't what
    // this test is about.
    await page.evaluate(function () {
      var raw = localStorage.getItem('dreamtube_state_v1');
      var s = JSON.parse(raw);
      s.user.authToken = 'real-founder-token';
      localStorage.setItem('dreamtube_state_v1', JSON.stringify(s));
    });

    // An entirely ORDINARY subsequent page load -- no explicit login()
    // call, no logout, nothing special.
    await safeGoto(page, baseUrl + '/explore.html');

    var confirmed = await settle(function () {
      return (sync.serverDreams[localDream.id] && sync.serverDreams[localDream.id].caption === 'Ziv is dancing');
    }, { timeout: 6000, interval: 25 });
    assert.ok(confirmed, 'once a real authToken is on file, the previously-stuck dream must reach the server on the very next ordinary page load -- no fresh login required');
  } finally {
    await context.close();
  }
});
