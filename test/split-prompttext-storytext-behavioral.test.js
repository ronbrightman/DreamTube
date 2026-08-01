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
//   4. Review round 1 finding: result.html's Edit Dream sheet -> "Generate
//      Again", UNTOUCHED, must resubmit the dream's ORIGINAL engineered
//      promptText (camera/lighting language intact) — not silently rebuild
//      the generation prompt from the plain story sentence just because
//      edit-text now displays that instead of the old technical caption.
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
  // "exploring" lives behind the "+N more" expander (tracker item
  // for-product-wizard-step-3-has-too-many-c-lrg1ct curated the default-
  // visible action chips down to a shorter list) -- expand it first.
  await page.click('#build-action-more-toggle');
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

/**
 * After a fresh generation completes on home.html (tracker item
 * for-product-funnel-ending-v2-founder-ins-tfuu0q -- ALL creation now
 * lands home first, with generation happening in the background, instead
 * of auto-redirecting straight to result.html?id=* the way processing.html
 * used to), this waits for that generation to finish, resolves the
 * just-created dream's id from the current user's own dreams (newest
 * first), then navigates to result.html?id=<id> itself so every existing
 * result.html-specific assertion below (recap text, Edit sheet,
 * interpretation, etc.) keeps working completely unchanged. Two possible
 * "done" signals, either of which means the same thing: an ordinary
 * account's My-dreams row generating tile flipping to a real tile, OR (for
 * a genuinely brand-new test account -- day-0, tracker item for-product-
 * build-ship-founder-go-08-01--ags710) the embedded #day0-card's own video
 * frame flipping to `.ready` instead, since that account's My-dreams row
 * stays hidden entirely in that state.
 */
async function waitForHomeGenerationThenOpenResult(page) {
  await page.waitForURL('**/home.html**', { timeout: 15000, waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#dreams-row .dream-row-tile:not(.generating), #d0-video.ready', { timeout: 15000 });
  var dreamId = await page.evaluate(function () {
    var raw = JSON.parse(localStorage.getItem('dreamtube_state_v1'));
    var handle = raw.user && raw.user.handle;
    var mine = (raw.dreams || []).filter(function (d) { return d.ownerHandle === handle; });
    mine.sort(function (a, b) { return new Date(b.createdAt) - new Date(a.createdAt); });
    return mine[0] && mine[0].id;
  });
  await safeGoto(page, baseUrl + '/result.html?id=' + dreamId);
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
    // Interpretation Wave 1 (docs/INTERPRETATION_WAVE1_SPEC.md): interpret-
    // dream.js now takes { caption, personaKey, mode }, not the old plain
    // { caption, style } shape -- only the mode:"reading" calls are what
    // this test cares about (whether the human storyText, never
    // promptText, reaches the LLM); mode:"questions" gets a trivial empty
    // response so js/interpret-experience.js's own silent-fallback
    // (spec §3.2) skips straight past it.
    var interpretReadingCalls = [];
    await page.route('**/.netlify/functions/interpret-dream', function (route) {
      var body = JSON.parse(route.request().postData() || '{}');
      if (body.mode === 'questions') {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ questions: [] }) });
        return;
      }
      interpretReadingCalls.push(body);
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
    await settle(function () { return rewriteCalls.length >= 1; });
    assert.equal(rewriteCalls.length, 1);
    // The rewrite call's OWN input must be the engineered prompt (camera
    // direction included) -- never a raw chip dump missing that context.
    assert.match(rewriteCalls[0].promptText, /of a stranger,/);
    assert.match(rewriteCalls[0].promptText, /exploring/);

    await page.click('.style-card[data-style="Cartoon"]');
    await page.click('#generate-btn');

    await waitForHomeGenerationThenOpenResult(page);

    // ----- (c) generate-video.js's actual POST body still carries the full engineered prompt -----
    await settle(function () { return generateVideoCalls.length >= 1; });
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
    await page.click('.itp-persona-card[data-key="jung"]');
    await page.waitForSelector('#itp-reading-text', { state: 'visible', timeout: 5000 });
    await settle(function () { return interpretReadingCalls.length >= 1; });
    assert.equal(interpretReadingCalls.length, 1);
    assert.equal(interpretReadingCalls[0].caption, MOCK_LLM_STORY);
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
    await waitForHomeGenerationThenOpenResult(page);
    await settle(function () { return generateVideoCalls.length >= 1; });
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
    await waitForHomeGenerationThenOpenResult(page);

    await settle(function () { return generateVideoCalls.length >= 1; });
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
    await waitForHomeGenerationThenOpenResult(page);

    await settle(function () { return generateVideoCalls.length >= 1; });
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

// ---------------------------------------------------------------------
// 4. Review round 1 finding: Edit Dream / Generate Again, UNTOUCHED,
//    must preserve the original engineered promptText (camera/lighting
//    language), not silently rebuild it from the plain story sentence.
// ---------------------------------------------------------------------
test('result.html "Edit Dream" -> "Generate Again", with ZERO edits, resubmits the ORIGINAL engineered promptText (camera/lighting language intact), not just the plain story sentence', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await page.route('**/.netlify/functions/rewrite-dream-story', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ storyText: 'I was a stranger exploring a misty forest at night, feeling uneasy.' }) });
    });
    var generateVideoCalls = mockGenerateAndPoll(page);

    await seedLoggedInUserAt(page, 'regenpreserve', '/create.html');
    await reachStyleScreenViaChips(page, null);
    await page.click('.style-card[data-style="Cartoon"]');
    await page.click('#generate-btn');
    await waitForHomeGenerationThenOpenResult(page);

    await settle(function () { return generateVideoCalls.length >= 1; });
    assert.equal(generateVideoCalls.length, 1);
    var originalPrompt = generateVideoCalls[0].caption;
    assert.match(originalPrompt, /of a stranger,/, 'sanity check: the original generation prompt has the engineered camera-direction language');

    // Open the Edit sheet and tap Generate Again WITHOUT touching edit-text
    // at all -- the exact repro steps from the review finding.
    // #open-edit-sheet now opens the new edit-delta sheet by default (docs/
    // EDIT_MECHANISM_SPEC.md) — "Start over instead" reaches the OLD full
    // mini-wizard sheet (#edit-text/#edit-generate-again) this test covers.
    await page.click('#open-edit-sheet');
    await page.waitForSelector('#sheet-edit-delta-overlay.open', { timeout: 3000 });
    await page.click('#delta-start-over-link');
    await page.waitForSelector('#sheet-edit-overlay.open', { timeout: 3000 });
    var editTextValue = await page.inputValue('#edit-text');
    // The box shows the plain human story (post-split), never the old
    // technical prompt -- this IS the intended display fix; the bug is
    // what happens to GENERATION when this box goes untouched.
    assert.doesNotMatch(editTextValue, /of a stranger,/);
    await page.click('#edit-generate-again');

    await waitForHomeGenerationThenOpenResult(page);

    await settle(function () { return generateVideoCalls.length >= 2; });
    assert.equal(generateVideoCalls.length, 2, 'Generate Again must actually resubmit');
    assert.equal(generateVideoCalls[1].caption, originalPrompt, 'an UNEDITED Generate Again must resend the exact original engineered prompt, camera/lighting/style language intact -- not silently rebuild it from the plain story text');

    var dream = await page.evaluate(function () {
      var id = new URLSearchParams(location.search).get('id');
      var raw = JSON.parse(localStorage.getItem('dreamtube_state_v1'));
      return raw.dreams.filter(function (d) { return d.id === id; })[0];
    });
    assert.equal(dream.promptText, originalPrompt, 'the regenerated dream\'s own stored promptText must also still be the full engineered string');
    assert.equal(dream.storyText, editTextValue, 'the displayed story must stay the plain human sentence, unaffected by promptText being preserved');
  } finally {
    await context.close();
  }
});

test('result.html "Edit Dream" -> "Generate Again", WITH a real edit, sends the edited text as both the new promptText and storyText (no automatic camera-language enrichment on a fresh user-authored edit -- matches Write-it/Record-it precedent)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await page.route('**/.netlify/functions/rewrite-dream-story', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ storyText: 'I was a stranger exploring a misty forest at night, feeling uneasy.' }) });
    });
    var generateVideoCalls = mockGenerateAndPoll(page);

    await seedLoggedInUserAt(page, 'regenedit', '/create.html');
    await reachStyleScreenViaChips(page, null);
    await page.click('.style-card[data-style="Cartoon"]');
    await page.click('#generate-btn');
    await waitForHomeGenerationThenOpenResult(page);
    await settle(function () { return generateVideoCalls.length >= 1; });
    assert.equal(generateVideoCalls.length, 1);

    var EDITED_TEXT = 'I was flying over a golden city, feeling joyful.';
    // #open-edit-sheet now opens the new edit-delta sheet by default (docs/
    // EDIT_MECHANISM_SPEC.md) — "Start over instead" reaches the OLD full
    // mini-wizard sheet (#edit-text/#edit-generate-again) this test covers.
    await page.click('#open-edit-sheet');
    await page.waitForSelector('#sheet-edit-delta-overlay.open', { timeout: 3000 });
    await page.click('#delta-start-over-link');
    await page.waitForSelector('#sheet-edit-overlay.open', { timeout: 3000 });
    await page.fill('#edit-text', EDITED_TEXT);
    await page.click('#edit-generate-again');
    await waitForHomeGenerationThenOpenResult(page);

    await settle(function () { return generateVideoCalls.length >= 2; });
    assert.equal(generateVideoCalls.length, 2);
    assert.equal(generateVideoCalls[1].caption, EDITED_TEXT, 'a REAL edit becomes the new promptText verbatim, no chip re-enrichment');

    var dream = await page.evaluate(function () {
      var id = new URLSearchParams(location.search).get('id');
      var raw = JSON.parse(localStorage.getItem('dreamtube_state_v1'));
      return raw.dreams.filter(function (d) { return d.id === id; })[0];
    });
    assert.equal(dream.promptText, EDITED_TEXT);
    assert.equal(dream.storyText, EDITED_TEXT);
    assert.equal(dream.caption, EDITED_TEXT);
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------
// 5. Review round 1 finding: wizard.html implements its own SEPARATE
//    storyText computation (computeStoryText/storyRewriteToken) rather
//    than sharing style.html's -- a second independent implementation is
//    exactly where a subtle divergence hides, so it needs its own real,
//    end-to-end coverage, not just create.html's.
// ---------------------------------------------------------------------
test('wizard.html: chips-only (no free text) pre-signup flow produces a human-readable storyText, opportunistically upgraded by the LLM rewrite, carried all the way through start-pending-generation.js and into the finished dream', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var MOCK_LLM_STORY = 'I was a stranger flying through a stormy sky, feeling epic.';
    var rewriteCalls = [];
    await page.route('**/.netlify/functions/rewrite-dream-story', function (route) {
      var body = JSON.parse(route.request().postData() || '{}');
      rewriteCalls.push(body);
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ storyText: MOCK_LLM_STORY }) });
    });
    var startPendingCalls = [];
    await page.route('**/.netlify/functions/start-pending-generation', function (route) {
      startPendingCalls.push(JSON.parse(route.request().postData()));
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pendingId: 'pd-storytext-1', operationName: 'fal:fake-model:req-storytext-1' }) });
    });
    await page.route('**/.netlify/functions/claim-pending-generation', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, found: true }) });
    });
    await page.route('**/.netlify/functions/video-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, videoUrl: 'https://example.com/fake-video.mp4' }) });
    });
    await page.route('https://example.com/fake-video.mp4', function (route) {
      route.fulfill({ status: 200, contentType: 'video/mp4', body: Buffer.from('x') });
    });

    await safeGoto(page, baseUrl + '/wizard.html');
    await page.click('[data-subj-other="stranger"]');
    await page.click('#fn-subject-continue');
    await page.click('#fn-setting-skip');
    await page.click('[data-action="flying"]');
    await page.click('#fn-action-continue');
    await page.click('[data-mood="epic"]');
    await page.click('#fn-mood-continue');
    await page.click('#fn-style-skip');
    await page.click('#fn-freetext-skip');

    // Contact step is wizard.html's own preview moment -- recap must show
    // a real human sentence immediately (deterministic template), then
    // upgrade once the mocked LLM rewrite resolves.
    await page.waitForSelector('#fn-story-recap-card[style*="block"]', { timeout: 3000 });
    var recapBeforeRewrite = await page.textContent('#fn-story-recap-text');
    assert.ok(recapBeforeRewrite.length > 0, 'recap must never be blank');
    assert.doesNotMatch(recapBeforeRewrite, /tracking shot|aerial|crane shot|close-up shot|POV shot|dreamlike/i);
    await page.waitForFunction(function (expected) {
      var el = document.getElementById('fn-story-recap-text');
      return el && el.textContent === expected;
    }, MOCK_LLM_STORY, { timeout: 3000 });
    await settle(function () { return rewriteCalls.length >= 1; });
    assert.equal(rewriteCalls.length, 1);
    assert.match(rewriteCalls[0].promptText, /of a stranger,/, 'the rewrite call\'s own input must be the engineered prompt, camera direction included');

    await page.fill('#contact-email', 'wizard-storytext@example.com');
    await page.click('#fn-contact-continue');

    // start-pending-generation.js's own payload must carry BOTH: the full
    // engineered prompt as `caption`, and the human story as `storyText`.
    await page.waitForFunction(function () { return document.getElementById('fn-username') !== null; }, null, { timeout: 5000 });
    await settle(function () { return startPendingCalls.length >= 1; });
    assert.equal(startPendingCalls.length, 1);
    assert.match(startPendingCalls[0].caption, /of a stranger,/, 'the wire caption sent to start-pending-generation must still be the engineered promptText');
    assert.equal(startPendingCalls[0].storyText, MOCK_LLM_STORY);

    await page.fill('#fn-username', 'wizardstorytext');
    await page.fill('#fn-password', 'longenoughpassword1');
    await page.click('#fn-signup-continue');

    await waitForHomeGenerationThenOpenResult(page);
    var dream = await page.evaluate(function () {
      var id = new URLSearchParams(location.search).get('id');
      var raw = JSON.parse(localStorage.getItem('dreamtube_state_v1'));
      return raw.dreams.filter(function (d) { return d.id === id; })[0];
    });
    assert.equal(dream.storyText, MOCK_LLM_STORY);
    assert.equal(dream.caption, MOCK_LLM_STORY, 'the legacy/back-compat display field must equal storyText for a new dream');
    assert.match(dream.promptText, /of a stranger,/, 'promptText must keep the full engineered prompt');
    assert.equal(await page.textContent('#result-quote'), '"' + MOCK_LLM_STORY + '"');
  } finally {
    await page.close();
  }
});

test('wizard.html: chips WITH free text -- the pending-generation payload carries the user\'s own words verbatim as storyText, and the LLM rewrite is never called', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var rewriteCalls = [];
    await page.route('**/.netlify/functions/rewrite-dream-story', function (route) {
      rewriteCalls.push(true);
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ storyText: 'should never be used' }) });
    });
    var startPendingCalls = [];
    await page.route('**/.netlify/functions/start-pending-generation', function (route) {
      startPendingCalls.push(JSON.parse(route.request().postData()));
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pendingId: 'pd-storytext-2', operationName: 'fal:fake-model:req-storytext-2' }) });
    });

    var FREE_TEXT = 'A dragon showed me the way home.';
    await safeGoto(page, baseUrl + '/wizard.html');
    await page.click('[data-subj-other="none"]');
    await page.click('#fn-subject-continue');
    await page.click('#fn-setting-skip');
    await page.click('[data-action="flying"]');
    await page.click('#fn-action-continue');
    await page.click('#fn-mood-skip');
    await page.click('#fn-style-skip');
    await page.fill('#free-text-input', FREE_TEXT);
    await page.click('#fn-freetext-continue');

    await page.waitForSelector('#fn-story-recap-card[style*="block"]', { timeout: 3000 });
    assert.equal(await page.textContent('#fn-story-recap-text'), FREE_TEXT);
    assert.equal(rewriteCalls.length, 0, 'the LLM rewrite must never be called when the user typed their own free text');

    await page.fill('#contact-email', 'wizard-freetext@example.com');
    await page.click('#fn-contact-continue');
    // start-pending-generation.js doesn't render anything client-observable
    // until the Signup screen appears -- wait for that instead of polling
    // the Node-side array from inside the page (waitForFunction's
    // predicate runs IN the browser, which can't see startPendingCalls).
    await page.waitForFunction(function () { return document.getElementById('fn-username') !== null; }, null, { timeout: 5000 });
    await settle(function () { return startPendingCalls.length >= 1; });
    assert.equal(startPendingCalls.length, 1);
    assert.equal(startPendingCalls[0].storyText, FREE_TEXT);
    assert.match(startPendingCalls[0].caption, new RegExp(FREE_TEXT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), 'promptText keeps the chip context + free text appended, unchanged shape');
  } finally {
    await page.close();
  }
});

// ---------------------------------------------------------------------
// 6. Review round 1 finding: claim-dream.html (the abandoned-dream claim
//    path) must also show/carry storyText, not caption/promptText.
// ---------------------------------------------------------------------
test('claim-dream.html: the ready-view caption shows storyText (not the engineered promptText), and saving the claimed dream carries storyText/promptText through onto the local dream record', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);

    var ENGINEERED_CAPTION = 'aerial wide shot of a stranger, flying through an open sky, epic awe-inspiring mood, golden-hour rim light, Cinematic style, dreamlike.';
    var HUMAN_STORY = 'I was a stranger flying through a golden sky, feeling epic.';
    await page.route('**/.netlify/functions/verify-pending-claim', function (route) {
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          ok: true, pendingId: 'pd-claim-1', email: 'claimtester@example.com',
          caption: ENGINEERED_CAPTION, storyText: HUMAN_STORY, style: 'Cinematic',
          videoUrl: 'https://example.com/fake-video.mp4', status: 'ready'
        })
      });
    });
    await page.route('**/.netlify/functions/claim-pending-generation', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, found: true }) });
    });
    await page.route('https://example.com/fake-video.mp4', function (route) {
      route.fulfill({ status: 200, contentType: 'video/mp4', body: Buffer.from('x') });
    });

    // Already logged in, with the SAME email the pending record was sent
    // to (so the one-tap "Save to my account" path is wired -- see
    // claim-dream.html's own emailMatches gate).
    await safeGoto(page, baseUrl + '/login.html');
    await page.evaluate(function () {
      var raw = localStorage.getItem('dreamtube_state_v1');
      var state = raw ? JSON.parse(raw) : {};
      state.user = { handle: '@claimtester', username: 'claimtester' };
      if (!state.accounts) state.accounts = {};
      state.accounts.claimtester = { password: 'testpass1', email: 'claimtester@example.com' };
      localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    });
    await safeGoto(page, baseUrl + '/claim-dream.html?pending=pd-claim-1&token=faketoken123');

    await page.waitForSelector('#ready-view[style*="flex"]', { timeout: 5000 });
    assert.equal(await page.textContent('#ready-caption'), HUMAN_STORY, 'the ready-view caption must show storyText, never the engineered promptText');

    await page.click('#save-to-account-btn');
    await page.waitForURL(/result\.html\?id=/, { timeout: 5000 });

    var dream = await page.evaluate(function () {
      var id = new URLSearchParams(location.search).get('id');
      var raw = JSON.parse(localStorage.getItem('dreamtube_state_v1'));
      return raw.dreams.filter(function (d) { return d.id === id; })[0];
    });
    assert.equal(dream.storyText, HUMAN_STORY);
    assert.equal(dream.caption, HUMAN_STORY);
    assert.equal(dream.promptText, ENGINEERED_CAPTION, 'the claimed dream must keep the full engineered prompt as promptText');
    assert.equal(await page.textContent('#result-quote'), '"' + HUMAN_STORY + '"');
  } finally {
    await context.close();
  }
});
