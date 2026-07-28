// test/split-prompttext-storytext-behavioral.test.js
//
// Real browser-driven coverage for tracker item
// for-product-split-prompttext-storytext-f-yt5kc7 — the chip-based
// dream-builder flow (create.html's "Build it", js/wizard-chips.js's
// assembleCaption) was showing its own camera-direction/style-modifier
// prompt text ("medium tracking shot of a stranger, walking through a
// foggy forest...") to the user as their own dream, and feeding that same
// text to interpret-dream.js. This fix splits `promptText` (generation-
// only) from `storyText` (human-readable, shown everywhere a human looks,
// fed to interpretation).
//
// Covers, end to end, exactly what this tracker item's own QA section asks
// for:
//   1. Chips, NO free text: style.html's preview card shows a real
//      human-readable story (never camera/lighting/style jargon), the
//      actual generate-video.js POST body still carries the full
//      engineered prompt, the saved dream's displayed caption/story on
//      result.html is the human-readable version, and
//      interpret-dream.js's request carries the story text, not the
//      prompt.
//   2. Chips WITH free text: the user's own words are preserved byte-for-
//      byte as storyText (founder amendment — never rewritten, never
//      composed with chip context), while promptText still carries the
//      full chip-assembled prompt (with the free text appended, unchanged
//      from before this fix).
//   3. Write-it: unchanged/no-op — storyText === promptText === the
//      user's own typed text, exactly as before this feature existed.
//
// Follows this repo's established browser-test conventions exactly (see
// test/image-generation-style-toggle-behavioral.test.js/
// test/wizard-ui-behavioral.test.js): static-server.js (no real Netlify
// Functions runtime), page.route() for every function endpoint touched,
// blockThirdParty() for this sandbox's flaky outbound network. Zero real
// fal.ai/OpenRouter cost — every LLM/generation call is intercepted.

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

async function safeGoto(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  } catch (e) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  }
}

function mockTokenStatus(page) {
  return page.route('**/.netlify/functions/get-token-status*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ balance: 1000, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 10 }) });
  });
}

async function seedLoggedInUserAt(page, username, path) {
  await safeGoto(page, baseUrl + '/login.html');
  await page.evaluate(function (u) {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@' + u, username: u };
    if (!state.accounts) state.accounts = {};
    state.accounts[u] = { password: 'testpass1', email: u + '@example.com' };
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, username);
  await safeGoto(page, baseUrl + path);
}

/** Drives create.html's "Build it" chip flow through every step, tapping only chips (no typing unless freeText is given), landing on style.html. */
async function reachStyleScreenViaChips(page, freeText) {
  await page.click('#choice-build');
  await page.waitForSelector('#build-subject-skip');
  await page.click('[data-build-subj-other="stranger"]');
  await page.click('#build-subject-continue');

  await page.waitForSelector('#build-setting-skip');
  await page.click('[data-build-time="Night"]');
  await page.click('[data-build-place="nature"]');
  await page.click('#build-setting-continue');

  await page.waitForSelector('#build-action-continue');
  await page.click('[data-build-action="exploring"]');
  await page.click('#build-action-continue');

  await page.waitForSelector('#build-mood-skip');
  await page.click('[data-build-mood="mysterious"]');
  await page.click('#build-mood-continue');

  await page.waitForSelector('#build-freetext-skip');
  if (freeText) {
    await page.fill('#build-freetext-input', freeText);
    await page.click('#build-freetext-continue');
  } else {
    await page.click('#build-freetext-skip');
  }
  await page.waitForSelector('.style-card[data-style="Cartoon"]', { timeout: 5000 });
}

function mockGenerateAndPoll(page) {
  var generateVideoCalls = [];
  page.route('**/.netlify/functions/generate-video', function (route) {
    var body = JSON.parse(route.request().postData() || '{}');
    generateVideoCalls.push(body);
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'fal:fake-model:test-op-1' }) });
  });
  page.route('**/.netlify/functions/video-status*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, videoUrl: 'https://example.com/fake-video.mp4' }) });
  });
  page.route('https://example.com/fake-video.mp4', function (route) {
    route.fulfill({ status: 200, contentType: 'video/mp4', body: Buffer.from('x') });
  });
  return generateVideoCalls;
}

// ---------------------------------------------------------------------
// 1. Chips, NO free text
// ---------------------------------------------------------------------
test('chips-only (no free text): style.html preview shows a human story (never prompt-speak), generate-video.js still gets the full engineered prompt, the saved dream displays the human story, and interpretation is called with the story text', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);

    var MOCK_LLM_STORY = 'I was a stranger exploring a misty forest at night, feeling uneasy.';
    var rewriteCalls = [];
    await page.route('**/.netlify/functions/rewrite-dream-story', function (route) {
      var body = JSON.parse(route.request().postData() || '{}');
      rewriteCalls.push(body);
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ storyText: MOCK_LLM_STORY }) });
    });
    var generateVideoCalls = mockGenerateAndPoll(page);
    var interpretCalls = [];
    await page.route('**/.netlify/functions/interpret-dream', function (route) {
      var body = JSON.parse(route.request().postData() || '{}');
      interpretCalls.push(body);
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ interpretation: 'A reflection at least forty characters long, easily.' }) });
    });

    await seedLoggedInUserAt(page, 'chipnotext', '/create.html');
    await reachStyleScreenViaChips(page, null);

    // ----- (a) Preview shows a real human-readable story, not prompt-speak -----
    await page.waitForSelector('#style-recap-card[style*="block"]', { timeout: 3000 });
    var recapBeforeRewrite = await page.textContent('#style-recap-text');
    assert.ok(recapBeforeRewrite.length > 0, 'recap must never be blank');
    assert.doesNotMatch(recapBeforeRewrite, /tracking shot|aerial|crane shot|close-up shot|POV shot/i, 'recap must never contain camera-direction language');
    assert.doesNotMatch(recapBeforeRewrite, /dreamlike\.?$/i, 'recap must never contain the prompt-engineering style suffix');

    // The opportunistic LLM rewrite should have fired and (per the mocked
    // fast response) upgraded the recap before Generate is tapped.
    await page.waitForFunction(function (expected) {
      var el = document.getElementById('style-recap-text');
      return el && el.textContent === expected;
    }, MOCK_LLM_STORY, { timeout: 3000 });
    assert.equal(rewriteCalls.length, 1);
    // The rewrite call's OWN input must be the engineered prompt (camera
    // direction included) -- never a raw chip dump missing that context.
    assert.match(rewriteCalls[0].promptText, /of a stranger,/);
    assert.match(rewriteCalls[0].promptText, /exploring/);

    await page.click('.style-card[data-style="Cartoon"]');
    await page.click('#generate-btn');

    await page.waitForURL('**/result.html?id=*', { timeout: 15000, waitUntil: 'domcontentloaded' });

    // ----- (c) generate-video.js's actual POST body still carries the full engineered prompt -----
    assert.equal(generateVideoCalls.length, 1);
    assert.match(generateVideoCalls[0].caption, /of a stranger,/, 'the wire caption sent to generation must still be the engineered promptText');
    assert.match(generateVideoCalls[0].caption, /mysterious mood/);
    assert.doesNotMatch(generateVideoCalls[0].caption, new RegExp(MOCK_LLM_STORY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the human story text must never leak into the generation prompt');

    // ----- (b) the saved dream's displayed caption/story is the human-readable version -----
    var dream = await page.evaluate(function () {
      var id = new URLSearchParams(location.search).get('id');
      var raw = JSON.parse(localStorage.getItem('dreamtube_state_v1'));
      return raw.dreams.filter(function (d) { return d.id === id; })[0];
    });
    assert.equal(dream.storyText, MOCK_LLM_STORY);
    assert.equal(dream.caption, MOCK_LLM_STORY, 'dream.caption (the legacy/back-compat display field) must equal storyText for a new dream');
    assert.match(dream.promptText, /of a stranger,/, 'dream.promptText must keep the full engineered prompt');
    assert.equal(await page.textContent('#result-quote'), '"' + MOCK_LLM_STORY + '"');

    // ----- (d) interpretation is called with the story text, never the prompt -----
    await page.click('#interp-cta-btn');
    await page.waitForSelector('#interp-ready:not([style*="display: none"])', { timeout: 5000 });
    assert.equal(interpretCalls.length, 1);
    assert.equal(interpretCalls[0].caption, MOCK_LLM_STORY);
  } finally {
    await context.close();
  }
});

test('chips-only (no free text), LLM rewrite fails: falls back to the deterministic template, never blocks or slows generation', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);

    await page.route('**/.netlify/functions/rewrite-dream-story', function (route) {
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'E605: llm_request_failed' }) });
    });
    var generateVideoCalls = mockGenerateAndPoll(page);

    await seedLoggedInUserAt(page, 'chiprewritefail', '/create.html');
    await reachStyleScreenViaChips(page, null);

    await page.waitForSelector('#style-recap-card[style*="block"]', { timeout: 3000 });
    var recap = await page.textContent('#style-recap-text');
    assert.match(recap, /^I was/, 'deterministic fallback must still read as a plain first-person sentence');
    assert.doesNotMatch(recap, /tracking shot|aerial|crane shot|light,|dreamlike/i);

    // Generation must proceed immediately -- never gated on the failed rewrite.
    await page.click('.style-card[data-style="Cartoon"]');
    await page.click('#generate-btn');
    await page.waitForURL('**/result.html?id=*', { timeout: 15000, waitUntil: 'domcontentloaded' });
    assert.equal(generateVideoCalls.length, 1);

    var dream = await page.evaluate(function () {
      var id = new URLSearchParams(location.search).get('id');
      var raw = JSON.parse(localStorage.getItem('dreamtube_state_v1'));
      return raw.dreams.filter(function (d) { return d.id === id; })[0];
    });
    assert.equal(dream.storyText, recap);
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------
// 2. Chips WITH free text -- founder amendment: verbatim, never rewritten
// ---------------------------------------------------------------------
test('chips WITH free text: the user\'s own words are preserved byte-for-byte as storyText (never rewritten, never composed with chip context), while the engineered prompt still carries both', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);

    var rewriteCalls = [];
    await page.route('**/.netlify/functions/rewrite-dream-story', function (route) {
      rewriteCalls.push(true);
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ storyText: 'should never be used' }) });
    });
    var generateVideoCalls = mockGenerateAndPoll(page);

    var FREE_TEXT = 'There was also a talking cat who knew my name.';
    await seedLoggedInUserAt(page, 'chipwithtext', '/create.html');
    await reachStyleScreenViaChips(page, FREE_TEXT);

    // Recap shows the user's own words, unaltered -- no rewrite call at all.
    await page.waitForSelector('#style-recap-card[style*="block"]', { timeout: 3000 });
    assert.equal(await page.textContent('#style-recap-text'), FREE_TEXT);
    assert.equal(rewriteCalls.length, 0, 'the LLM rewrite must never be called when the user typed their own free text');

    await page.click('.style-card[data-style="Cartoon"]');
    await page.click('#generate-btn');
    await page.waitForURL('**/result.html?id=*', { timeout: 15000, waitUntil: 'domcontentloaded' });

    assert.equal(generateVideoCalls.length, 1);
    // promptText: chip context + the free text appended, unchanged shape from before this fix.
    assert.match(generateVideoCalls[0].caption, /of a stranger,/);
    assert.match(generateVideoCalls[0].caption, new RegExp(FREE_TEXT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'));

    var dream = await page.evaluate(function () {
      var id = new URLSearchParams(location.search).get('id');
      var raw = JSON.parse(localStorage.getItem('dreamtube_state_v1'));
      return raw.dreams.filter(function (d) { return d.id === id; })[0];
    });
    assert.equal(dream.storyText, FREE_TEXT, 'storyText must be EXACTLY the user\'s free text -- no chip-derived context woven in');
    assert.equal(dream.caption, FREE_TEXT);
    assert.notEqual(dream.promptText, FREE_TEXT, 'promptText must remain the full engineered string, distinct from the plain story');
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------
// 3. Write-it -- unchanged/no-op
// ---------------------------------------------------------------------
test('Write-it: unchanged/no-op -- storyText === promptText === the user\'s own typed text, exactly as before this feature', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);

    var rewriteCalls = [];
    await page.route('**/.netlify/functions/rewrite-dream-story', function (route) {
      rewriteCalls.push(true);
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ storyText: 'should never be used' }) });
    });
    var generateVideoCalls = mockGenerateAndPoll(page);

    var WRITE_TEXT = 'I was walking through my childhood home and every room was a different color.';
    await seedLoggedInUserAt(page, 'writeittester', '/create.html');
    await page.click('#choice-write');
    await page.fill('#dream-text', WRITE_TEXT);
    await page.click('#write-continue');
    await page.waitForSelector('.style-card[data-style="Cartoon"]', { timeout: 5000 });

    await page.waitForSelector('#style-recap-card[style*="block"]', { timeout: 3000 });
    assert.equal(await page.textContent('#style-recap-text'), WRITE_TEXT);
    assert.equal(rewriteCalls.length, 0, 'Write-it must never trigger the LLM rewrite path');

    await page.click('.style-card[data-style="Cartoon"]');
    await page.click('#generate-btn');
    await page.waitForURL('**/result.html?id=*', { timeout: 15000, waitUntil: 'domcontentloaded' });

    assert.equal(generateVideoCalls.length, 1);
    assert.equal(generateVideoCalls[0].caption, WRITE_TEXT, 'Write-it\'s generation prompt is exactly the typed text, unchanged from before this feature');

    var dream = await page.evaluate(function () {
      var id = new URLSearchParams(location.search).get('id');
      var raw = JSON.parse(localStorage.getItem('dreamtube_state_v1'));
      return raw.dreams.filter(function (d) { return d.id === id; })[0];
    });
    assert.equal(dream.storyText, WRITE_TEXT);
    assert.equal(dream.promptText, WRITE_TEXT);
    assert.equal(dream.caption, WRITE_TEXT);
    assert.equal(await page.textContent('#result-quote'), '"' + WRITE_TEXT + '"');
  } finally {
    await context.close();
  }
});
