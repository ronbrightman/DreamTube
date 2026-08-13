// test/private-dream-sync-webview-vanish.test.js
//
// Regression coverage for the E304 dream_sync_unconfirmed / P0 "dream
// vanish" residual (tracker item for-product-p0-data-loss-founder-repro-0-
// 6bzvv1; instrumentation tracker for-product-track-avg-video-generation-t-
// 2ci8ue). The 7b7828c fix added retry-with-backoff + a load-time sweep,
// but confirmed (via reproduction) two remaining gaps that hit this app's
// single biggest cohort — FB/IG in-app-webview users, whose localStorage is
// wiped BETWEEN sessions (see lib/dream-store.js's header) and who often do
// exactly ONE short session:
//
//   1. The retry budget was 3 attempts within ~3.3s, then it gave up
//      server-side persistence for the whole page load and relied ENTIRELY
//      on a LATER page load's sweep to recover. A webview user who closes
//      the app before that later load never gets it, and the wipe takes the
//      dream. The budget is now extended so an OPEN page rides out a much
//      longer transient window within the single session the user gives us
//      and actually CONFIRMS (flips syncConfirmed, stops re-firing E304).
//
//   2. Nothing pushed the dream as the tab actually went away. A
//      pagehide/visibilitychange->hidden navigator.sendBeacon flush is now
//      the last-chance guaranteed-delivery push of any still-unconfirmed
//      private dream, so its DATA reaches the server even when no later
//      page load will ever happen.
//
// Both tests below drive the REAL app (finalizeDream -> syncPrivateDream-
// BestEffort -> /.netlify/functions/dream-sync) on home.html?generate=1,
// against a passwordless-shaped account (password:null, emailVerified:false,
// a real minted token) — the exact funnel/paid cohort the E304s concentrate
// in. Reproduction confirmed a passwordless account with a valid token syncs
// identically to a password account (dream-sync does not gate on
// emailVerified), so the shape is not the issue — the recovery WINDOW is.

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

function mockGenerationCompletesImmediately(page) {
  return Promise.all([
    page.route('**/.netlify/functions/generate-video', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'fal:fal-ai/veo3.1/fast:op' }) });
    }),
    page.route('**/.netlify/functions/video-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, videoUrl: 'https://example.com/x.mp4' }) });
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
 * Mocks dream-sync.js. The first `failCount` upsert attempts for EVERY
 * dream id come back as a real server-side 500 (E8 sync_write_failed) — a
 * genuine transient outage — before succeeding. Counts every upsert POST
 * received, including navigator.sendBeacon ones (a beacon is an ordinary
 * POST as far as the function is concerned).
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

/** Passwordless-shaped account (password:null, emailVerified:false) with a real minted token + a caption+style draft, landing on home.html's ?generate=1 fresh-generation path. */
async function seedPasswordlessAccountWithDraft(page, opts) {
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
    state.accounts[o.username] = { password: null, email: o.email || null, emailVerified: false, createdAt: Date.now() };
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    localStorage.setItem('dreamtube_feed_backfill_v1_done', '1');
  }, opts);
}

test('extended retry budget: a transient outage that outlasts the old 3-attempt/~3.3s burst still CONFIRMS within a single open page — no later page load needed', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockGenerationCompletesImmediately(page);
    // Fail the first 3 attempts (the ENTIRE pre-fix budget) — the 4th, only
    // reachable via the extended budget, succeeds. Pre-fix this dream would
    // have been given up on after attempt 3 and left permanently unconfirmed
    // (E304) unless a *later* page load happened.
    var sync = mockDreamSync(page, 3);

    await seedPasswordlessAccountWithDraft(page, { username: 'ronb1234', email: 'ron@example.com', authToken: 'valid-pwless-token' });
    await safeGoto(page, baseUrl + '/home.html?generate=1');
    await page.waitForSelector('#d0-video.ready', { timeout: 8000 });

    var localDream = await page.evaluate(function () { return window.DreamStore.getMyDreams()[0]; });
    assert.equal(localDream.caption, 'Ziv is dancing');

    // NO navigation to a second page anywhere in this test — the confirmation
    // must happen on this one open page via the extended in-page retry.
    var confirmed = await settle(function () {
      return (sync.serverDreams[localDream.id] && sync.serverDreams[localDream.id].caption === 'Ziv is dancing');
    }, { timeout: 20000, interval: 50 });
    assert.ok(confirmed, 'the dream must still reach the server after 3 real transient failures via the extended in-page retry — without any later page load');
    assert.ok(sync.upsertCallsById[localDream.id] >= 4, 'must have retried past the old 3-attempt budget (>=4 attempts observed)');

    var confirmedLocally = await settle(async function () {
      var d = await page.evaluate(function (id) {
        return window.DreamStore.getMyDreams().find(function (x) { return x.id === id; });
      }, localDream.id);
      return d && d.syncConfirmed === true;
    }, { timeout: 3000, interval: 25 });
    assert.ok(confirmedLocally, 'syncConfirmed must flip true once the extended retry finally lands — so E304 stops re-firing');
  } finally {
    await context.close();
  }
});

test('pagehide beacon: a dream still unconfirmed when the webview tab goes away gets a last-chance sendBeacon push to the server', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockGenerationCompletesImmediately(page);
    // Fail the fetch-path attempts long enough that the dream is still
    // unconfirmed during the quiet window between retries (attempt 3 lands
    // at ~3.3s, attempt 4 not until ~11.3s), then let the beacon's own POST
    // succeed so we can see its data land server-side.
    var sync = mockDreamSync(page, 3);

    await seedPasswordlessAccountWithDraft(page, { username: 'ronb1234', email: 'ron@example.com', authToken: 'valid-pwless-token' });
    await safeGoto(page, baseUrl + '/home.html?generate=1');
    await page.waitForSelector('#d0-video.ready', { timeout: 8000 });
    var localDream = await page.evaluate(function () { return window.DreamStore.getMyDreams()[0]; });

    // Let the first 3 fetch attempts fire and fail (~3.3s), landing us in the
    // quiet window before attempt 4 — the dream is unconfirmed and NOT yet on
    // the server.
    await settle(function () { return (sync.upsertCallsById[localDream.id] || 0) >= 3; }, { timeout: 8000, interval: 25 });
    await new Promise(function (r) { setTimeout(r, 500); });
    assert.ok(!sync.serverDreams[localDream.id], 'precondition: dream not yet on server (still failing) when the tab goes away');
    var beforeCount = sync.upsertCallsById[localDream.id] || 0;

    // The webview tab goes away — fire pagehide (mobile webviews frequently
    // deliver this / visibilitychange rather than a clean unload).
    await page.evaluate(function () { window.dispatchEvent(new Event('pagehide')); });

    var beaconLanded = await settle(function () {
      return (sync.upsertCallsById[localDream.id] || 0) > beforeCount && !!sync.serverDreams[localDream.id];
    }, { timeout: 4000, interval: 25 });
    assert.ok(beaconLanded, 'the pagehide beacon must send one more upsert for the unconfirmed dream, delivering its data to the server as the tab closes');
  } finally {
    await context.close();
  }
});
