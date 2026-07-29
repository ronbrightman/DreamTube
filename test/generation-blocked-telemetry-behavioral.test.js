// test/generation-blocked-telemetry-behavioral.test.js
//
// Tracker item for-product-damage-assessment-env-var-ca-rmgaqh, task 1:
// processing.html's generation-failure catch block fired NO PostHog event
// at all for any generation failure, including E109 (the rate-limit
// error a live env-var override -- MAX_GENERATIONS_PER_IP_PER_DAY silently
// stuck at 2 -- made real users hit after just two generations/day). This
// covers the fix: a neutral, always-on 'generation_blocked' event with a
// `reason` property (the parsed error code, e.g. 'E109'), fired from the
// single top-level catch for EVERY generation failure this file handles,
// not gated behind the E109/E409/E110/E410-specific "hide retry button"
// branch -- and confirms it does NOT fire on a successful generation.
//
// Follows test/phase1-product-events-behavioral.test.js's
// readPostHogCaptureCalls approach (reading window.posthog's own pending-
// call queue directly, since blockThirdParty() aborts the real PostHog
// script that would otherwise drain it) and test/wait-screen-
// reassurance-and-inapp-nudge-behavioral.test.js's seedAccountWithDraft +
// page.route() network-stub conventions for landing on processing.html's
// normal fresh-generation path.

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

/** Aborts requests to third-party hosts every page here loads -- see CLAUDE.md on this sandbox's outbound network, and every other *-behavioral.test.js's identical helper. */
function blockThirdParty(page) {
  return page.route(/fonts\.(googleapis|gstatic)\.com|connect\.facebook\.net|i\.posthog\.com/, function (route) {
    route.abort();
  });
}

/** Same PostHog-stub-queue read as test/phase1-product-events-behavioral.test.js -- see that file's header comment for why this is more reliable here than a monkeypatch. */
function readPostHogCaptureCalls(page) {
  return page.evaluate(function () {
    var queue = (window.posthog && typeof window.posthog.slice === 'function') ? window.posthog.slice() : [];
    return queue.filter(function (entry) { return entry[0] === 'capture'; }).map(function (entry) { return { name: entry[1], props: entry[2] }; });
  });
}

/** Seeds a logged-in account with a caption+style draft and no pendingJob, landing on processing.html's normal fresh-generation path -- mirrors test/wait-screen-reassurance-and-inapp-nudge-behavioral.test.js's seedAccountWithDraft. */
async function seedAccountWithDraft(page, opts) {
  await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function (o) {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@' + o.username, username: o.username };
    if (!state.accounts) state.accounts = {};
    state.accounts[o.username] = { password: 'testpass1', email: o.email || (o.username + '@example.com') };
    if (!state.dreams) state.dreams = [];
    state.draft = Object.assign({ caption: 'A dream about flying over the city', style: 'Cinematic', mediaType: 'video' }, o.draft || {});
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, opts);
}

/** Mocks a generation whose submission succeeds but whose poll immediately reports the given "ENNN: reason" error -- the exact shape store.js's pollUntilDone turns into err.message (see js/store.js's data.error handling), which is what reaches processing.html's catch block. */
function mockFailingGeneration(page, errorMessage) {
  return Promise.all([
    page.route('**/.netlify/functions/generate-video', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'fal:fal-ai/veo3.1/fast/test-op-fail' }) });
    }),
    page.route('**/.netlify/functions/video-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ error: errorMessage }) });
    })
  ]);
}

/** Mocks a generation that succeeds end-to-end. */
function mockSuccessfulGeneration(page) {
  return Promise.all([
    page.route('**/.netlify/functions/generate-video', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'fal:fal-ai/veo3.1/fast/test-op-ok' }) });
    }),
    page.route('**/.netlify/functions/video-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, videoUrl: 'https://example.com/fake-video.mp4' }) });
    }),
    page.route('**/.netlify/functions/publish-dream', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    })
  ]);
}

test("generation_blocked: fires with reason='E109' on the exact rate-limit failure this incident's damage-assessment item is about", async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockFailingGeneration(page, 'E109: rate_limited: too many generations from this network today, try again tomorrow');
    await seedAccountWithDraft(page, { username: 'e109blockeduser' });
    await page.goto(baseUrl + '/processing.html', { waitUntil: 'domcontentloaded' });

    await page.waitForSelector('#proc-fail', { state: 'visible', timeout: 5000 });

    var calls = await readPostHogCaptureCalls(page);
    var blockedCalls = calls.filter(function (c) { return c.name === 'generation_blocked'; });
    assert.equal(blockedCalls.length, 1, 'expected exactly one generation_blocked capture for the failed generation');
    assert.equal(blockedCalls[0].props.reason, 'E109', 'reason should be the parsed error code, so someone can later filter to "how many E109s this week"');
  } finally {
    await context.close();
  }
});

test('generation_blocked: also fires for OTHER failure codes this file handles (E112 insufficient-tokens), not just E109 -- the event must be a durable signal for every failure path, not just the rate-limit one', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockFailingGeneration(page, 'E112: insufficient_tokens: not enough tokens to generate a video');
    // E112 specifically opens the token purchase sheet via a
    // getTokenStatus() fetch (see processing.html's catch block) -- mock
    // it to succeed so that convenience fetch doesn't fail-open into a
    // location.href navigation to shop.html, which would tear down the
    // very page.posthog queue this test is about to inspect.
    await page.route('**/.netlify/functions/get-token-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ balance: 0, claimable: false }) });
    });
    await seedAccountWithDraft(page, { username: 'e112blockeduser' });
    await page.goto(baseUrl + '/processing.html', { waitUntil: 'domcontentloaded' });

    await page.waitForSelector('#proc-fail', { state: 'visible', timeout: 5000 });

    var calls = await readPostHogCaptureCalls(page);
    var blockedCalls = calls.filter(function (c) { return c.name === 'generation_blocked'; });
    assert.equal(blockedCalls.length, 1, 'expected exactly one generation_blocked capture for an E112 failure too');
    assert.equal(blockedCalls[0].props.reason, 'E112');
  } finally {
    await context.close();
  }
});

test('generation_blocked: falls back to the raw message as `reason` when the failure does not match the "ENNN: reason" convention', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockFailingGeneration(page, 'totally_unstructured_failure');
    await seedAccountWithDraft(page, { username: 'unstructuredfailuser' });
    await page.goto(baseUrl + '/processing.html', { waitUntil: 'domcontentloaded' });

    await page.waitForSelector('#proc-fail', { state: 'visible', timeout: 5000 });

    var calls = await readPostHogCaptureCalls(page);
    var blockedCalls = calls.filter(function (c) { return c.name === 'generation_blocked'; });
    assert.equal(blockedCalls.length, 1, 'expected exactly one generation_blocked capture even for an unstructured failure message');
    assert.equal(blockedCalls[0].props.reason, 'totally_unstructured_failure', 'reason should fall back to the raw message when it doesn\'t match the ENNN: reason pattern');
  } finally {
    await context.close();
  }
});

test('generation_blocked: does NOT fire on a successful generation', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockSuccessfulGeneration(page);
    await seedAccountWithDraft(page, { username: 'successnoblockeduser' });
    await page.goto(baseUrl + '/processing.html', { waitUntil: 'domcontentloaded' });

    // Successful generations redirect to result.html shortly after
    // finishing -- wait for that navigation as the success signal.
    await page.waitForURL(/result\.html/, { timeout: 8000 });

    var calls = await readPostHogCaptureCalls(page);
    var blockedCalls = calls.filter(function (c) { return c.name === 'generation_blocked'; });
    assert.equal(blockedCalls.length, 0, 'a successful generation must never fire generation_blocked');
  } finally {
    await context.close();
  }
});
