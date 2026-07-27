// test/faq-section-behavioral.test.js
//
// Real browser-driven coverage for the new static FAQ section in
// profile.html's Settings sheet (tracker.html's idea-faq-section item):
// a fixed list of Q&A rows (#faq-list .faq-item), each independently
// expandable via its own .faq-question tap, mirroring the open/close +
// rotating-chevron accordion shape create.html's #adv-section already
// uses, just one row per question instead of one shared panel. Purely
// static content — no backend involvement — so these tests only need to
// verify rendering and the expand/collapse interaction, not any network
// call.
//
// Follows test/support-feedback-behavioral.test.js's conventions: node:test
// + real Chromium via Playwright, state seeded directly into localStorage,
// every page.goto wrapped against this sandbox's known intermittent
// third-party-host network stalls.

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

/** Mocks the real admin-paywall-toggle GET the page fires on load to decide whether to show owner tools — always answers isOwner:false so tests never depend on OWNER_EMAIL config. */
function mockOwnerCheck(page) {
  return page.route('**/.netlify/functions/admin-paywall-toggle*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: false, source: 'env-default', isOwner: false }) });
  });
}

/** Mocks the real get-token-status GET so the token chip doesn't hang on a real network call. */
function mockTokenStatus(page) {
  return page.route('**/.netlify/functions/get-token-status*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ balance: 220, nextGrantAt: Date.now() + 3600000, dailyGrantAmount: 20 }) });
  });
}

/** Seeds a logged-in "tester" account, matching support-feedback-behavioral.test.js's own seed helper. */
async function seedUser(page) {
  await safeGoto(page, baseUrl + '/login.html');
  await page.evaluate(function () {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@tester', username: 'tester' };
    if (!state.accounts) state.accounts = {};
    state.accounts.tester = { password: 'testpass1', email: 'tester@example.com', createdAt: Date.now() - 3 * 86400000 };
    state.dreams = [];
    if (!state.charactersByUser) state.charactersByUser = {};
    state.charactersByUser.tester = [];
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  });
}

var EXPECTED_QUESTIONS = [
  'What is DreamTube?',
  'How do tokens work?',
  'My generation failed. Do I get my tokens back?',
  'How long does a video take to generate?',
  "Can I edit a dream after it's made?",
  'What\'s "Advanced"?',
  'Can I use my own photo?',
  'Is my dream public or private?',
  'Can I delete a dream, or my account?',
  "Something's wrong / I have another question"
];

test('profile.html Settings: FAQ section renders with the expected questions, all collapsed by default', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  await mockOwnerCheck(page);
  await mockTokenStatus(page);
  try {
    await seedUser(page);
    await safeGoto(page, baseUrl + '/profile.html');

    await page.click('#account-btn');
    await page.waitForSelector('#sheet-account-overlay.open');

    var sectionLabels = await page.locator('#sheet-account-overlay .section-label').allTextContents();
    assert.ok(sectionLabels.indexOf('FAQ') !== -1, JSON.stringify(sectionLabels));

    var questions = await page.locator('#faq-list .faq-question').allTextContents();
    var normalizedQuestions = questions.map(function (q) { return q.replace(/\s+/g, ' ').trim(); });
    assert.deepEqual(normalizedQuestions, EXPECTED_QUESTIONS);

    var items = page.locator('#faq-list .faq-item');
    assert.equal(await items.count(), EXPECTED_QUESTIONS.length);
    // Every answer starts hidden, and no item carries the .open class.
    var answers = page.locator('#faq-list .faq-answer');
    for (var i = 0; i < EXPECTED_QUESTIONS.length; i++) {
      assert.equal(await answers.nth(i).isVisible(), false, 'answer ' + i + ' should start collapsed');
    }
    var openCount = await page.locator('#faq-list .faq-item.open').count();
    assert.equal(openCount, 0);
  } finally {
    await page.close();
  }
});

test('profile.html Settings: clicking a FAQ question reveals its own answer without affecting other items, and clicking again collapses it', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  await mockOwnerCheck(page);
  await mockTokenStatus(page);
  try {
    await seedUser(page);
    await safeGoto(page, baseUrl + '/profile.html');
    await page.click('#account-btn');
    await page.waitForSelector('#sheet-account-overlay.open');

    var firstItem = page.locator('#faq-list .faq-item[data-faq-index="0"]');
    var secondItem = page.locator('#faq-list .faq-item[data-faq-index="1"]');

    await firstItem.locator('.faq-question').click();
    await page.waitForSelector('#faq-list .faq-item[data-faq-index="0"] .faq-answer', { state: 'visible' });
    assert.match(await firstItem.locator('.faq-answer').textContent(), /AI-generated video/);
    // A different, untapped item stays collapsed.
    assert.equal(await secondItem.locator('.faq-answer').isVisible(), false);
    assert.equal(await secondItem.evaluate(function (el) { return el.classList.contains('open'); }), false);

    // Opening the second item leaves the first one open too (independent, not single-select).
    await secondItem.locator('.faq-question').click();
    await page.waitForSelector('#faq-list .faq-item[data-faq-index="1"] .faq-answer', { state: 'visible' });
    assert.match(await secondItem.locator('.faq-answer').textContent(), /220 free/);
    assert.equal(await firstItem.locator('.faq-answer').isVisible(), true, 'opening a second item must not close the first');

    // Tapping the first question again collapses just that one.
    await firstItem.locator('.faq-question').click();
    await page.waitForFunction(function () {
      var item = document.querySelector('#faq-list .faq-item[data-faq-index="0"]');
      return item && !item.classList.contains('open');
    });
    assert.equal(await firstItem.locator('.faq-answer').isVisible(), false);
    assert.equal(await secondItem.locator('.faq-answer').isVisible(), true, 'collapsing the first item must not affect the second');
  } finally {
    await page.close();
  }
});

test('profile.html Settings: the account-deletion FAQ answer describes the real, live Danger zone flow, not the old "flagged/unconfirmed" placeholder', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  await mockOwnerCheck(page);
  await mockTokenStatus(page);
  try {
    await seedUser(page);
    await safeGoto(page, baseUrl + '/profile.html');
    await page.click('#account-btn');
    await page.waitForSelector('#sheet-account-overlay.open');

    var deletionItem = page.locator('#faq-list .faq-item[data-faq-index="8"]');
    await deletionItem.locator('.faq-question').click();
    await page.waitForSelector('#faq-list .faq-item[data-faq-index="8"] .faq-answer', { state: 'visible' });
    var answerText = await deletionItem.locator('.faq-answer').textContent();

    assert.match(answerText, /Danger zone/);
    assert.match(answerText, /Delete account/);
    assert.doesNotMatch(answerText, /FLAGGED/i);
    assert.doesNotMatch(answerText, /doesn't appear to exist/i);
  } finally {
    await page.close();
  }
});

test('profile.html Settings: FAQ reflects the image-generation option and its real, lower token cost, not the stale "every generation costs 100" claim', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  await mockOwnerCheck(page);
  await mockTokenStatus(page);
  try {
    await seedUser(page);
    await safeGoto(page, baseUrl + '/profile.html');
    await page.click('#account-btn');
    await page.waitForSelector('#sheet-account-overlay.open');

    var whatIsItem = page.locator('#faq-list .faq-item[data-faq-index="0"]');
    await whatIsItem.locator('.faq-question').click();
    await page.waitForSelector('#faq-list .faq-item[data-faq-index="0"] .faq-answer', { state: 'visible' });
    var whatIsAnswer = await whatIsItem.locator('.faq-answer').textContent();
    assert.match(whatIsAnswer, /image/i, 'DreamTube can also generate a still image, not just video -- the FAQ should say so');

    var tokensItem = page.locator('#faq-list .faq-item[data-faq-index="1"]');
    await tokensItem.locator('.faq-question').click();
    await page.waitForSelector('#faq-list .faq-item[data-faq-index="1"] .faq-answer', { state: 'visible' });
    var tokensAnswer = await tokensItem.locator('.faq-answer').textContent();
    assert.match(tokensAnswer, /100 tokens/, 'a video generation must still be described as costing 100 tokens');
    assert.match(tokensAnswer, /10\b/, 'an image generation costs 10 tokens (style.html/generate-image.js IMAGE_TOKEN_COST) -- the FAQ must not claim every generation costs the same 100');
    assert.doesNotMatch(tokensAnswer, /Every generation.*100 tokens/i, 'must not claim a single flat cost for every generation now that image generation is cheaper');

    // result.html's own regenerateAgainCost() charges IMAGE_TOKEN_COST (10)
    // for an image-type dream's regenerate, not VIDEO_TOKEN_COST (100) --
    // review round-1 finding: this answer was missed in the first pass and
    // still claimed a flat 100 for every regenerate.
    var editItem = page.locator('#faq-list .faq-item[data-faq-index="4"]');
    await editItem.locator('.faq-question').click();
    await page.waitForSelector('#faq-list .faq-item[data-faq-index="4"] .faq-answer', { state: 'visible' });
    var editAnswer = await editItem.locator('.faq-answer').textContent();
    assert.match(editAnswer, /100 tokens/, 'a video regenerate must still be described as costing 100 tokens');
    assert.match(editAnswer, /10\b/, 'an image regenerate costs 10 tokens, same as generate-image.js\'s cost -- the FAQ must not claim a flat 100 for every regenerate');

    // generate-image.js's flux/dev model is pure text-to-image -- a photo
    // is never sent to or used by it (docs/IMAGE_GENERATION_SPEC.md #7.5).
    // Review round-1 finding: the photo FAQ answer overclaimed this works
    // for image generation the same as video.
    var photoItem = page.locator('#faq-list .faq-item[data-faq-index="6"]');
    await photoItem.locator('.faq-question').click();
    await page.waitForSelector('#faq-list .faq-item[data-faq-index="6"] .faq-answer', { state: 'visible' });
    var photoAnswer = await photoItem.locator('.faq-answer').textContent();
    assert.match(photoAnswer, /video/i, 'the self-photo answer must clarify this applies to video generation');
    assert.match(photoAnswer, /image.*text|text.*image/i, 'the self-photo answer must clarify image generation is text-only and does not use a photo');
  } finally {
    await page.close();
  }
});
