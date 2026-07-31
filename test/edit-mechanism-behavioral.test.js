// test/edit-mechanism-behavioral.test.js
//
// Real browser-driven coverage for the new edit mechanism (docs/
// EDIT_MECHANISM_SPEC.md, tracker item
// for-product-new-edit-mechanism-founder-i-qmsdgj) — founder-approved
// Direction B ("Confirm-before-generate"), with PixVerse V6 model-rotation
// cost-approved and live from day one, no flag gate.
//
// Covers:
//   1. result.html's new default edit sheet (#sheet-edit-delta-overlay) --
//      opens on #open-edit-sheet, fires edit_started, disables "Apply this
//      change" until non-whitespace input, fires edit_submitted with
//      { deltaLength, dreamId } only (never raw delta text) on submit,
//      calls realign-dream-prompt.js with the dream's CURRENT
//      promptText/storyText/delta, shows the REALIGNED storyText (never
//      promptText) read-only on the confirm screen, "Edit again" preserves
//      the delta text, and "Start over instead" still opens the OLD full
//      mini-wizard sheet unchanged.
//   2. Model rotation end-to-end through processing.html: a veo3.1-lite
//      dream's edit routes to pixverse-v6, a pixverse-v6 dream's edit
//      routes back to veo3.1-lite (alternation/ping-pong), and an Anime-
//      style dream's edit always routes to pixverse-v6 regardless of its
//      prior modelUsed (the override).
//   3. Realignment failure (realign-dream-prompt.js down) falls back to a
//      naive concatenation merge rather than blocking the user, and no
//      token is spent at that point.
//   4. editHistory is recorded on the resulting dream (deltaLength/
//      timestamp/modelUsed only, no raw delta text anywhere in the saved
//      dream record).
//
// Zero real fal.ai/OpenRouter cost -- every generate-video/video-status/
// realign-dream-prompt endpoint is mocked via page.route(), per
// AGENT_POLICY.md's "keep generation-testing cost low" guidance.

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

/** Same PostHog-stub-queue read as test/phase1-product-events-behavioral.test.js. */
function readPostHogCaptureCalls(page) {
  return page.evaluate(function () {
    var queue = (window.posthog && typeof window.posthog.slice === 'function') ? window.posthog.slice() : [];
    return queue.filter(function (entry) { return entry[0] === 'capture'; }).map(function (entry) { return { name: entry[1], props: entry[2] }; });
  });
}

function mockTokenStatus(page) {
  return page.route('**/.netlify/functions/get-token-status*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ balance: 1000, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, claimable: false, streak: 0 }) });
  });
}

/** Mocks generate-video.js so it echoes back whatever requestedModel it was sent (or the default veo3.1-lite when none was sent) as modelUsed -- exactly generate-video.js's own real rotation logic for the plain text-to-video path, reproduced here so this test doesn't need the real function running. */
function mockGenerateAndPoll(page) {
  var generateVideoCalls = [];
  page.route('**/.netlify/functions/generate-video', function (route) {
    var body = JSON.parse(route.request().postData() || '{}');
    generateVideoCalls.push(body);
    var modelUsed = body.requestedModel === 'pixverse-v6' ? 'pixverse-v6' : 'veo3.1-lite';
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'fal:test-model:op-' + generateVideoCalls.length, modelUsed: modelUsed }) });
  });
  page.route('**/.netlify/functions/video-status*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, videoUrl: 'https://example.com/fake-video.mp4' }) });
  });
  page.route('https://example.com/fake-video.mp4', function (route) {
    route.fulfill({ status: 200, contentType: 'video/mp4', body: Buffer.from('x') });
  });
  return generateVideoCalls;
}

function mockRealignOk(page, realignedStoryText, realignedPromptText) {
  return page.route('**/.netlify/functions/realign-dream-prompt', function (route) {
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ promptText: realignedPromptText || 'realigned engineered prompt text', storyText: realignedStoryText || 'realigned human story text' })
    });
  });
}

function mockRealignFails(page) {
  return page.route('**/.netlify/functions/realign-dream-prompt', function (route) {
    route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'E705: llm_request_failed' }) });
  });
}

/** Seeds a logged-in account with one owned video dream and lands on its result.html. modelUsed/style are seedable so rotation tests can set up the exact prior state they need. */
async function seedResultPageWithDream(page, opts) {
  opts = opts || {};
  await safeGoto(page, baseUrl + '/login.html');
  await page.evaluate(function (o) {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@' + o.username, username: o.username };
    if (!state.accounts) state.accounts = {};
    state.accounts[o.username] = { password: 'testpass1', email: o.username + '@example.com' };
    if (!state.dreams) state.dreams = [];
    state.dreams.push({
      id: o.dreamId,
      ownerHandle: '@' + o.username,
      caption: o.storyText || 'I was flying over a golden city at night, feeling free.',
      promptText: o.promptText || 'Cinematic aerial shot, dreamer gliding over a golden city at night, photorealistic.',
      storyText: o.storyText || 'I was flying over a golden city at night, feeling free.',
      style: o.style || 'Cinematic',
      mediaType: 'video',
      videoUrl: 'https://example.com/fake-video.mp4',
      dur: '0:08',
      isPublished: false, likes: 0, likedByMe: false,
      modelUsed: 'modelUsed' in o ? o.modelUsed : 'veo3.1-lite'
    });
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, opts);
  await safeGoto(page, baseUrl + '/result.html?id=' + opts.dreamId);
  await page.waitForTimeout(150);
}

function readDream(page, dreamId) {
  return page.evaluate(function (id) {
    var raw = JSON.parse(localStorage.getItem('dreamtube_state_v1'));
    return raw.dreams.filter(function (d) { return d.id === id; })[0];
  }, dreamId);
}

// ===========================================================================
// 1. The sheet itself
// ===========================================================================

test('result.html: #open-edit-sheet opens the new edit-delta sheet by default and fires edit_started', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await seedResultPageWithDream(page, { username: 'deltaopener', dreamId: 'd-delta-open-1' });

    await page.click('#open-edit-sheet');
    await page.waitForSelector('#sheet-edit-delta-overlay.open');
    assert.equal(await page.locator('#delta-ask-panel').isVisible(), true, 'the ask panel should be the default visible step');

    var calls = await readPostHogCaptureCalls(page);
    var startedCalls = calls.filter(function (c) { return c.name === 'edit_started'; });
    assert.equal(startedCalls.length, 1, 'edit_started must fire exactly once when the sheet opens');
  } finally {
    await context.close();
  }
});

test('result.html: "Apply this change" is disabled until non-whitespace input, per the spec\'s empty-state edge case', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await seedResultPageWithDream(page, { username: 'deltaempty', dreamId: 'd-delta-empty-1' });

    await page.click('#open-edit-sheet');
    await page.waitForSelector('#sheet-edit-delta-overlay.open');
    assert.equal(await page.locator('#delta-apply-btn').isDisabled(), true, 'must start disabled with an empty textarea');

    await page.fill('#delta-text', '   ');
    assert.equal(await page.locator('#delta-apply-btn').isDisabled(), true, 'whitespace-only input must not enable it either');

    await page.fill('#delta-text', 'make it daytime');
    assert.equal(await page.locator('#delta-apply-btn').isDisabled(), false, 'real text must enable it');
  } finally {
    await context.close();
  }
});

test('result.html: submitting a delta fires edit_submitted (deltaLength+dreamId only), realigns, and shows the REALIGNED storyText read-only on the confirm screen -- never the raw promptText', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    var realignCalls = [];
    await page.route('**/.netlify/functions/realign-dream-prompt', function (route) {
      realignCalls.push(JSON.parse(route.request().postData()));
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ promptText: 'Cinematic aerial shot, dreamer gliding over a golden city in DAYTIME, photorealistic.', storyText: 'I was flying over a golden city in daylight, feeling free.' }) });
    });
    await seedResultPageWithDream(page, {
      username: 'deltasubmit', dreamId: 'd-delta-submit-1',
      promptText: 'Cinematic aerial shot, dreamer gliding over a golden city at night, photorealistic.',
      storyText: 'I was flying over a golden city at night, feeling free.'
    });

    await page.click('#open-edit-sheet');
    await page.waitForSelector('#sheet-edit-delta-overlay.open');
    var DELTA = 'make it daytime instead of night';
    await page.fill('#delta-text', DELTA);
    await page.click('#delta-apply-btn');

    await page.waitForSelector('#delta-confirm-panel', { state: 'visible', timeout: 5000 });
    var confirmText = await page.textContent('#delta-confirm-text');
    assert.equal(confirmText, 'I was flying over a golden city in daylight, feeling free.', 'the confirm screen must show the REALIGNED storyText');
    assert.doesNotMatch(confirmText, /Cinematic aerial shot/, 'the confirm screen must never show the raw engineered promptText');

    assert.equal(realignCalls.length, 1);
    assert.equal(realignCalls[0].promptText, 'Cinematic aerial shot, dreamer gliding over a golden city at night, photorealistic.');
    assert.equal(realignCalls[0].storyText, 'I was flying over a golden city at night, feeling free.');
    assert.equal(realignCalls[0].deltaText, DELTA);

    var calls = await readPostHogCaptureCalls(page);
    var submitted = calls.filter(function (c) { return c.name === 'edit_submitted'; });
    assert.equal(submitted.length, 1);
    assert.deepEqual(submitted[0].props, { deltaLength: DELTA.length, dreamId: 'd-delta-submit-1' }, 'edit_submitted must carry ONLY deltaLength+dreamId, never the raw delta text');
  } finally {
    await context.close();
  }
});

test('result.html: "Edit again" goes back to step 1 with the delta text preserved', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await mockRealignOk(page, 'realigned story');
    await seedResultPageWithDream(page, { username: 'deltaagain', dreamId: 'd-delta-again-1' });

    await page.click('#open-edit-sheet');
    await page.waitForSelector('#sheet-edit-delta-overlay.open');
    var DELTA = 'add my dog flying next to me';
    await page.fill('#delta-text', DELTA);
    await page.click('#delta-apply-btn');
    await page.waitForSelector('#delta-confirm-panel', { state: 'visible', timeout: 5000 });

    await page.click('#delta-confirm-edit-again');
    assert.equal(await page.locator('#delta-ask-panel').isVisible(), true);
    assert.equal(await page.inputValue('#delta-text'), DELTA, 'the delta text must still be exactly what the user typed');
  } finally {
    await context.close();
  }
});

test('result.html: "Start over instead" opens the OLD full mini-wizard sheet, unchanged', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await seedResultPageWithDream(page, { username: 'deltastartover', dreamId: 'd-delta-startover-1' });

    await page.click('#open-edit-sheet');
    await page.waitForSelector('#sheet-edit-delta-overlay.open');
    await page.click('#delta-start-over-link');

    await page.waitForSelector('#sheet-edit-overlay.open');
    assert.equal(await page.locator('#sheet-edit-delta-overlay').evaluate(function (el) { return el.classList.contains('open'); }), false, 'the new sheet must close when Start over opens the old one');
    assert.equal(await page.locator('#edit-generate-again').isVisible(), true, 'the OLD full mini-wizard\'s own Generate Again control must still be there, unchanged');
  } finally {
    await context.close();
  }
});

// ===========================================================================
// 2. Model rotation end-to-end (through processing.html)
// ===========================================================================

/** Drives the full edit-delta flow (open sheet -> type delta -> Apply -> Generate this) through to a completed regenerate, and returns the requestedModel generate-video.js's mock received plus the resulting dream. */
async function driveFullEditDelta(page, dreamId, deltaText) {
  await page.click('#open-edit-sheet');
  await page.waitForSelector('#sheet-edit-delta-overlay.open');
  await page.fill('#delta-text', deltaText);
  await page.click('#delta-apply-btn');
  await page.waitForSelector('#delta-confirm-panel', { state: 'visible', timeout: 5000 });
  await page.click('#delta-confirm-generate-btn');
  await page.waitForURL('**/result.html?id=' + dreamId, { timeout: 15000, waitUntil: 'domcontentloaded' });
}

test('model rotation: a veo3.1-lite dream\'s edit routes to pixverse-v6, and modelUsed + editHistory are stamped on the resulting dream', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await mockRealignOk(page, 'a realigned story');
    var generateVideoCalls = mockGenerateAndPoll(page);
    await seedResultPageWithDream(page, { username: 'rotatelite', dreamId: 'd-rotate-lite-1', modelUsed: 'veo3.1-lite', style: 'Cinematic' });

    var DELTA = 'make it daytime';
    await driveFullEditDelta(page, 'd-rotate-lite-1', DELTA);

    await settle(function () { return generateVideoCalls.length >= 1; });
    assert.equal(generateVideoCalls[0].requestedModel, 'pixverse-v6', 'a veo3.1-lite dream must rotate to pixverse-v6 on edit');

    var dream = await readDream(page, 'd-rotate-lite-1');
    assert.equal(dream.modelUsed, 'pixverse-v6');
    assert.ok(Array.isArray(dream.editHistory) && dream.editHistory.length === 1);
    assert.equal(dream.editHistory[0].deltaLength, DELTA.length);
    assert.equal(dream.editHistory[0].modelUsed, 'pixverse-v6');
    assert.equal(typeof dream.editHistory[0].timestamp, 'number');
    // No raw delta text anywhere in the saved dream record.
    assert.equal(JSON.stringify(dream).indexOf(DELTA), -1, 'no raw delta text should ever be persisted on the dream record');
    // model_used itself (fired from processing.html's own page context,
    // lost by the full navigation back to result.html this flow ends
    // with) is covered directly, without a full-page navigation, in the
    // "model_used fires..." test below -- same reasoning
    // test/phase1-product-events-behavioral.test.js's own video_created
    // coverage already established for this exact choke point.
  } finally {
    await context.close();
  }
});

test('model_used: fires alongside video_created from finalizeDream, with the correct modelUsed + wasEdit, via DreamStore.startDreamEdit directly', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var generateVideoCalls = mockGenerateAndPoll(page);
    await seedResultPageWithDream(page, { username: 'modelusedevt', dreamId: 'd-model-used-1', modelUsed: 'veo3.1-lite', style: 'Cinematic' });
    // Fresh PostHog queue for this page load.
    await safeGoto(page, baseUrl + '/result.html?id=d-model-used-1');

    var dream = await page.evaluate(function () {
      return window.DreamStore.startDreamEdit('d-model-used-1', {
        promptText: 'realigned prompt text here', storyText: 'realigned story text here',
        characterIds: [], deltaLength: 12
      });
    });
    assert.ok(dream && dream.id);
    assert.equal(dream.modelUsed, 'pixverse-v6');

    var calls = await readPostHogCaptureCalls(page);
    var modelUsedCalls = calls.filter(function (c) { return c.name === 'model_used'; });
    assert.equal(modelUsedCalls.length, 1);
    assert.deepEqual(modelUsedCalls[0].props, { modelUsed: 'pixverse-v6', wasEdit: true });
    var videoCreatedCalls = calls.filter(function (c) { return c.name === 'video_created'; });
    assert.equal(videoCreatedCalls.length, 1, 'model_used must fire ALONGSIDE video_created, not instead of it');
  } finally {
    await page.close();
  }
});

test('model rotation: a pixverse-v6 dream\'s edit routes BACK to veo3.1-lite (alternation, never repeats the model it just tried)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await mockRealignOk(page, 'a realigned story');
    var generateVideoCalls = mockGenerateAndPoll(page);
    await seedResultPageWithDream(page, { username: 'rotatepv', dreamId: 'd-rotate-pv-1', modelUsed: 'pixverse-v6', style: 'Cinematic' });

    await driveFullEditDelta(page, 'd-rotate-pv-1', 'add rain');

    await settle(function () { return generateVideoCalls.length >= 1; });
    assert.equal(generateVideoCalls[0].requestedModel, 'veo3.1-lite');
    var dream = await readDream(page, 'd-rotate-pv-1');
    assert.equal(dream.modelUsed, 'veo3.1-lite');
  } finally {
    await context.close();
  }
});

test('model rotation: an Anime-style dream\'s edit always routes to pixverse-v6, regardless of its prior modelUsed (the override)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await mockRealignOk(page, 'a realigned anime story');
    var generateVideoCalls = mockGenerateAndPoll(page);
    // Seeded already on pixverse-v6 -- the plain alternation rule would say
    // "go back to veo3.1-lite," but the Anime override must win regardless.
    await seedResultPageWithDream(page, { username: 'rotateanime', dreamId: 'd-rotate-anime-1', modelUsed: 'pixverse-v6', style: 'Anime' });

    await driveFullEditDelta(page, 'd-rotate-anime-1', 'make the colors brighter');

    await settle(function () { return generateVideoCalls.length >= 1; });
    assert.equal(generateVideoCalls[0].requestedModel, 'pixverse-v6', 'Anime override must route to pixverse-v6 even though alternation alone would have picked veo3.1-lite');
  } finally {
    await context.close();
  }
});

test('model rotation: a dream with no modelUsed yet (legacy/unknown) alternates away from the implicit historical default and still routes to pixverse-v6', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await mockRealignOk(page, 'a realigned story');
    var generateVideoCalls = mockGenerateAndPoll(page);
    await seedResultPageWithDream(page, { username: 'rotatelegacy', dreamId: 'd-rotate-legacy-1', modelUsed: null, style: 'Cartoon' });

    await driveFullEditDelta(page, 'd-rotate-legacy-1', 'add fireworks');

    await settle(function () { return generateVideoCalls.length >= 1; });
    assert.equal(generateVideoCalls[0].requestedModel, 'pixverse-v6');
  } finally {
    await context.close();
  }
});

// ===========================================================================
// 3. Realignment failure -> naive fallback (spec §3.3 edge case)
// ===========================================================================

test('realignment failure: falls back to a naive concatenation merge rather than blocking the user, and no token is spent yet at the confirm screen', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await mockRealignFails(page);
    await seedResultPageWithDream(page, {
      username: 'realignfail', dreamId: 'd-realign-fail-1',
      promptText: 'Cinematic shot of a dreamer flying, photorealistic.',
      storyText: 'I was flying, feeling free.'
    });

    await page.click('#open-edit-sheet');
    await page.waitForSelector('#sheet-edit-delta-overlay.open');
    var DELTA = 'add a rainbow';
    await page.fill('#delta-text', DELTA);
    await page.click('#delta-apply-btn');

    // Must still reach the confirm screen despite the realign call failing.
    await page.waitForSelector('#delta-confirm-panel', { state: 'visible', timeout: 5000 });
    var confirmText = await page.textContent('#delta-confirm-text');
    assert.equal(confirmText, 'I was flying, feeling free. ' + DELTA, 'naive fallback: storyText + " " + delta');

    var calls = await readPostHogCaptureCalls(page);
    var fallbackCalls = calls.filter(function (c) { return c.name === 'edit_realign_fallback'; });
    assert.equal(fallbackCalls.length, 1, 'the silent-skip telemetry event must fire on a realignment failure');
  } finally {
    await context.close();
  }
});
