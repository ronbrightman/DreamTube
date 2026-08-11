// test/result-crossdevice-deeplink-behavioral.test.js
//
// Real-browser coverage for the CROSS-DEVICE / cleared-storage recovery on
// result.html (founder fix 2026-08-11) — the fix behind the interpretation
// retention emails' CTA. An emailed `result.html?id=<dreamId>&interp=1` link
// opened on a NEW device (or after an in-app-webview localStorage wipe) used
// to dead-end straight to explore.html, because result.html resolves the
// dream ONLY from local state. It now first pulls the signed-in owner's
// server-synced private dreams (dream-sync GET, via
// DreamStore.reconcilePrivateDreamsFromServer) and reloads to the original
// URL — so the dream resolves and the &interp=1 deep link opens the Chamber
// — and only falls through to explore when the dream is genuinely
// unrestorable.
//
// This is the systematic-debugging Phase-4 regression test for that fix:
// run against the pre-fix result.html (synchronous `if(!dream) location.href
// = 'explore.html'`), the success case FAILS — it lands on explore instead
// of recovering the dream.

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

/**
 * Seeds a SIGNED-IN account (with an authToken) that does NOT have the target
 * dream in local state — the cross-device / wiped-storage situation. AUGMENTS
 * the full valid state login.html's own load() already seeded into
 * localStorage (rather than overwriting it with a minimal object) — the store's
 * load() dereferences `parsed.draft.*`, so a minimal replacement blob would
 * throw and fall back to a logged-out seed (same shape as test/interp-
 * analytics-behavioral.test.js's own seedResultPage).
 */
async function seedSignedInWithoutDream(page) {
  await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function () {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@tester', username: 'tester', authToken: 'tok-abc' };
    if (!state.accounts) state.accounts = {};
    state.accounts.tester = { password: 'testpass1', email: 'tester@example.com' };
    state.dreams = []; // the target dream is NOT here (new device)
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  });
}

/** Mocks dream-sync's GET to return `dreams` for this account. */
function mockDreamSync(page, dreams) {
  return page.route('**/.netlify/functions/dream-sync**', function (route) {
    if (route.request().method() === 'GET') {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, dreams: dreams }) });
      return;
    }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
}

function serverDream(id) {
  return {
    id: id,
    ownerHandle: '@tester',
    caption: 'A dream about a glass city',
    storyText: 'I was walking through a city made of glass.',
    style: 'Cinematic',
    videoUrl: 'https://example.com/fake-video.mp4',
    sourceOperationName: 'fal:veo3:' + id,
    isPublished: false,
    updatedAt: Date.now(),
    createdAt: new Date().toISOString()
  };
}

test('cross-device: a signed-in owner opening result.html?id=…&interp=1 for a NOT-local dream recovers it from the server and opens the Chamber (not explore)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockDreamSync(page, [serverDream('d-remote')]);
    // interpret-dream isn't strictly hit by the picker, but mock it so nothing errors.
    await page.route('**/.netlify/functions/interpret-dream', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ questions: [{ id: 'q1', text: 'What is on your mind?', chips: ['Work', 'Home'] }] }) });
    });
    await seedSignedInWithoutDream(page);

    await page.goto(baseUrl + '/result.html?id=d-remote&interp=1', { waitUntil: 'domcontentloaded' });

    // Recovery: server hydrate -> reload -> dream resolves -> &interp=1 opens
    // the Chamber. The persona picker appearing is proof it recovered (a
    // dead-end to explore would never show it).
    await page.waitForSelector('.itp-persona-card[data-key="jung"]', { state: 'visible', timeout: 8000 });
    assert.ok(page.url().indexOf('result.html') !== -1, 'stayed on result.html, did not bounce to explore');
    assert.ok(page.url().indexOf('explore.html') === -1, 'did NOT dead-end to explore');
  } finally {
    await context.close();
  }
});

test('cross-device: when the server has no such dream, it still falls through to explore (honest fallback)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockDreamSync(page, []); // server has nothing to restore
    await seedSignedInWithoutDream(page);

    await page.goto(baseUrl + '/result.html?id=d-missing&interp=1', { waitUntil: 'domcontentloaded' });

    await page.waitForURL(/explore\.html/, { timeout: 8000 });
    assert.ok(page.url().indexOf('explore.html') !== -1, 'fell through to explore when genuinely unrestorable');
  } finally {
    await context.close();
  }
});
