// test/phase1-product-events-behavioral.test.js
//
// Real browser-driven coverage for three of Phase 1 reporting
// instrumentation's client-side events (tracker item
// for-product-phase-1-reporting-instrument-kjlh46): 'signed_up'
// (js/store.js's commitLocalSignup), 'video_created' (js/store.js's
// finalizeDream, the single choke point every completed generation runs
// through), and 'video_published' (js/store.js's publishDream). The
// server-side events (Purchase from dodo-webhook.js, like_given/
// like_received from like-dream.js) have direct unit coverage in
// test/dodo-webhook.test.js and test/like-dream.test.js instead — no
// browser needed for those.
//
// Follows test/first-video-created-behavioral.test.js's
// readPostHogCaptureCalls approach (reading window.posthog's own pending-
// call queue directly, since blockThirdParty() aborts the real PostHog
// script that would otherwise drain it) and
// test/store-signup-call-sequence-guard-behavioral.test.js's approach of
// calling window.DreamStore methods directly via page.evaluate rather than
// clicking through a full UI flow — cheaper and more direct for exercising
// store.js logic specifically, per AGENT_POLICY.md's "keep generation-
// testing cost low" guidance (no real fal.ai call anywhere here; every
// generate-video/video-status endpoint is mocked via page.route).

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

/** Wraps page.goto with 'domcontentloaded' (not the default 'load') and tolerates a transient nav failure -- see CLAUDE.md's known environment quirk. */
async function safeGoto(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  } catch (e) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  }
}

/** Same PostHog-stub-queue read as test/first-video-created-behavioral.test.js -- see that file's header comment for why this is more reliable here than a monkeypatch. */
function readPostHogCaptureCalls(page) {
  return page.evaluate(function () {
    var queue = (window.posthog && typeof window.posthog.slice === 'function') ? window.posthog.slice() : [];
    return queue.filter(function (entry) { return entry[0] === 'capture'; }).map(function (entry) { return { name: entry[1], props: entry[2] }; });
  });
}

/** Seeds a logged-in account (and however many of its own dreams the test needs) directly into localStorage -- mirrors test/first-video-created-behavioral.test.js's seedAccount. */
async function seedAccount(page, opts) {
  await safeGoto(page, baseUrl + '/login.html');
  await page.evaluate(function (o) {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@' + o.username, username: o.username };
    if (!state.accounts) state.accounts = {};
    state.accounts[o.username] = { password: 'testpass1', email: o.email || (o.username + '@example.com') };
    if (!state.dreams) state.dreams = [];
    (o.dreams || []).forEach(function (d) {
      state.dreams.push(Object.assign({
        ownerHandle: '@' + o.username,
        caption: 'A test dream',
        style: 'Cinematic',
        isPublished: false,
        likes: 0, likedByMe: false
      }, d));
    });
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, opts);
}

// ===== signed_up =====

test('signed_up: DreamStore.signup() fires it exactly once for a brand-new account', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await safeGoto(page, baseUrl + '/login.html');
    // register-account.js isn't served by the static test server (see
    // helpers/static-server.js's own comment) -- store.js's signup()
    // already degrades that to its offline-fallback commitLocalSignup
    // path, which is exactly what fires signed_up, so no route mock is
    // needed here.
    await page.evaluate(function () {
      return window.DreamStore.signup('freshsignupuser', 'testpass1', 'freshsignup@example.com');
    });

    var calls = await readPostHogCaptureCalls(page);
    var signedUpCalls = calls.filter(function (c) { return c.name === 'signed_up'; });
    assert.equal(signedUpCalls.length, 1, 'expected exactly one signed_up capture for a real signup');
  } finally {
    await page.close();
  }
});

test('signed_up: an ordinary login of an existing account never fires it', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await seedAccount(page, { username: 'existingloginuser', email: 'existinglogin@example.com' });
    // Reload so the PostHog stub queue starts fresh, then log in (not sign up).
    await safeGoto(page, baseUrl + '/login.html');
    await page.evaluate(function () {
      return window.DreamStore.login('existingloginuser', 'testpass1');
    });

    var calls = await readPostHogCaptureCalls(page);
    var signedUpCalls = calls.filter(function (c) { return c.name === 'signed_up'; });
    assert.equal(signedUpCalls.length, 0, 'an ordinary login must never fire signed_up -- only an actual new-account creation should');
  } finally {
    await page.close();
  }
});

// ===== video_created =====

function mockGeneration(page, opts) {
  opts = opts || {};
  return Promise.all([
    page.route('**/.netlify/functions/generate-video', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'fal:test:op-' + (opts.suffix || '1') }) });
    }),
    page.route('**/.netlify/functions/video-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, videoUrl: 'https://example.com/fake-video-' + (opts.suffix || '1') + '.mp4' }) });
    }),
    page.route('**/.netlify/functions/publish-dream', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    })
  ]);
}

test('video_created: fires once when a fresh generation completes, with style + mediaType', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await mockGeneration(page);
    await seedAccount(page, { username: 'freshgenuser', email: 'freshgen@example.com' });
    await safeGoto(page, baseUrl + '/login.html'); // fresh PostHog queue

    var dream = await page.evaluate(function () {
      return window.DreamStore.generateVideo('a dream about flying', 'Cinematic', {});
    });
    assert.ok(dream && dream.id, 'generateVideo should resolve with the finalized dream');

    var calls = await readPostHogCaptureCalls(page);
    var videoCreatedCalls = calls.filter(function (c) { return c.name === 'video_created'; });
    assert.equal(videoCreatedCalls.length, 1, 'expected exactly one video_created capture for one completed generation');
    assert.equal(videoCreatedCalls[0].props.style, 'Cinematic');
    assert.equal(videoCreatedCalls[0].props.mediaType, 'video');
  } finally {
    await page.close();
  }
});

test('video_created: fires again on a SECOND completed generation for the same account -- a plain volume counter, not a fire-once KPI', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await mockGeneration(page, { suffix: '2' });
    await seedAccount(page, {
      username: 'seconduservc',
      email: 'seconduservc@example.com',
      dreams: [{ id: 'existing-dream-1', videoUrl: 'https://example.com/existing.mp4', dur: '0:08' }]
    });
    await safeGoto(page, baseUrl + '/login.html');

    await page.evaluate(function () {
      return window.DreamStore.generateVideo('a second dream', 'Anime', {});
    });

    var calls = await readPostHogCaptureCalls(page);
    var videoCreatedCalls = calls.filter(function (c) { return c.name === 'video_created'; });
    assert.equal(videoCreatedCalls.length, 1, 'this account\'s 2nd-ever completed generation must still fire video_created (unlike first_video_created, which would decline here)');
    assert.equal(videoCreatedCalls[0].props.style, 'Anime');
  } finally {
    await page.close();
  }
});

test('video_created: fires again on a regenerate ("Try Again"/Edit Dream) of an existing dream', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await mockGeneration(page, { suffix: 'regen' });
    await seedAccount(page, {
      username: 'regenuser',
      email: 'regenuser@example.com',
      dreams: [{ id: 'dream-to-regen', videoUrl: 'https://example.com/original.mp4', dur: '0:08' }]
    });
    await safeGoto(page, baseUrl + '/login.html');

    await page.evaluate(function () {
      return window.DreamStore.regenerateDream('dream-to-regen', { caption: 'a re-imagined dream', style: 'Noir' });
    });

    var calls = await readPostHogCaptureCalls(page);
    var videoCreatedCalls = calls.filter(function (c) { return c.name === 'video_created'; });
    assert.equal(videoCreatedCalls.length, 1, 'a regenerate is still a completed generation and must fire video_created');
    assert.equal(videoCreatedCalls[0].props.style, 'Noir');
  } finally {
    await page.close();
  }
});

// ===== video_published =====

test('video_published: fires on DreamStore.publishDream() for a not-yet-published dream', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await page.route('**/.netlify/functions/publish-dream', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    await seedAccount(page, {
      username: 'publishuser',
      email: 'publishuser@example.com',
      dreams: [{ id: 'dream-to-publish', videoUrl: 'https://example.com/v.mp4', dur: '0:08', isPublished: false }]
    });
    await safeGoto(page, baseUrl + '/login.html');

    await page.evaluate(function () {
      window.DreamStore.publishDream('dream-to-publish');
    });

    var calls = await readPostHogCaptureCalls(page);
    var publishedCalls = calls.filter(function (c) { return c.name === 'video_published'; });
    assert.equal(publishedCalls.length, 1, 'expected exactly one video_published capture for the actual publish action');
    assert.equal(publishedCalls[0].props.style, 'Cinematic');
  } finally {
    await page.close();
  }
});

test('video_published: does NOT fire again for a dream that is already published (e.g. a redundant publishDream call)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await page.route('**/.netlify/functions/publish-dream', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    await seedAccount(page, {
      username: 'alreadypublisheduser',
      email: 'alreadypublisheduser@example.com',
      dreams: [{ id: 'dream-already-published', videoUrl: 'https://example.com/v.mp4', dur: '0:08', isPublished: true }]
    });
    await safeGoto(page, baseUrl + '/login.html');

    await page.evaluate(function () {
      window.DreamStore.publishDream('dream-already-published');
    });

    var calls = await readPostHogCaptureCalls(page);
    var publishedCalls = calls.filter(function (c) { return c.name === 'video_published'; });
    assert.equal(publishedCalls.length, 0, 'calling publishDream on an already-published dream must not re-fire video_published');
  } finally {
    await page.close();
  }
});
