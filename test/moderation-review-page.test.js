// test/moderation-review-page.test.js
//
// Real browser coverage for moderation-x7q4.html (tracker item
// for-product-build-the-moderation-review--sbf5ol): the owner-email-gate,
// newest-first listing, dream vs comment report field rendering, and the
// Mark handled control's persistence + optimistic-update behavior. The
// underlying endpoints (get-moderation-reports.js/mark-report-handled.js)
// are covered at the handler level in test/report-dream.test.js and
// test/mark-report-handled.test.js — this file only proves the PAGE wires
// up to them correctly. Playwright resolution/skip convention and the
// owner-email seeding shape match test/media-library-page.test.js/
// test/tracker-reviewed-behavioral.test.js's own header comments.

var test = require('node:test');
var assert = require('node:assert/strict');
var staticServer = require('./helpers/static-server');

var CHROMIUM_PATH = '/opt/pw-browsers/chromium';
var MOBILE_VIEWPORT = { width: 390, height: 844 };

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

var OWNER_EMAIL = 'founder@dreamtube.example';

/** Seeds a logged-in account with a real email on file (mirrors media-library-page.test.js's own seedUser). */
async function seedUser(page, email) {
  await safeGoto(page, baseUrl + '/login.html');
  await page.evaluate(function (theEmail) {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@owner', username: 'owner' };
    if (!state.accounts) state.accounts = {};
    state.accounts.owner = { password: 'ownerpass1', email: theEmail };
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, email);
}

var DREAM_REPORT = {
  id: 'r-dream-1', dreamId: 'd-1', dreamOwnerHandle: '@alice', dreamCaption: 'A dream about flying over mountains',
  reporterHandle: '@bob', reason: 'This is disturbing content', targetType: 'dream',
  commentId: null, commentText: null, commentAuthorHandle: null,
  createdAt: '2026-08-01T10:00:00.000Z', handled: false, dismissedAt: null
};
var COMMENT_REPORT = {
  id: 'r-comment-1', dreamId: 'd-2', dreamOwnerHandle: '@carol', dreamCaption: 'A dream about the ocean',
  reporterHandle: null, reason: null, targetType: 'comment',
  commentId: 'c-1', commentText: 'this is spam content', commentAuthorHandle: '@spammer',
  createdAt: '2026-08-05T10:00:00.000Z', handled: false, dismissedAt: null
};
var HANDLED_REPORT = {
  id: 'r-handled-1', dreamId: 'd-3', dreamOwnerHandle: '@dave', dreamCaption: 'An older dream',
  reporterHandle: '@eve', reason: 'old reason', targetType: 'dream',
  commentId: null, commentText: null, commentAuthorHandle: null,
  createdAt: '2026-07-01T10:00:00.000Z', handled: true, dismissedAt: '2026-07-02T10:00:00.000Z'
};

function mockReportsEndpoint(page, reports) {
  return page.route('**/.netlify/functions/get-moderation-reports*', function (route) {
    var url = new URL(route.request().url());
    if (url.searchParams.get('email') !== OWNER_EMAIL) {
      route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'E3: forbidden' }) });
      return;
    }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ reports: reports }) });
  });
}

test('redirects to login when no account is signed in at all', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage({ viewport: MOBILE_VIEWPORT });
  await blockThirdParty(page);
  await safeGoto(page, baseUrl + '/moderation-x7q4.html');
  await page.waitForURL(/login\.html/, { timeout: 5000 });
  await page.close();
});

test('a non-owner email is rejected: the page shows the unauthorized state, never the report list', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage({ viewport: MOBILE_VIEWPORT });
  await blockThirdParty(page);
  await mockReportsEndpoint(page, [DREAM_REPORT]);
  await seedUser(page, 'not-the-owner@example.com');
  await safeGoto(page, baseUrl + '/moderation-x7q4.html');

  await page.waitForSelector('#mod-unauthorized', { state: 'visible', timeout: 5000 });
  var contentVisible = await page.isVisible('#mod-content');
  assert.equal(contentVisible, false, 'the report list must never render for a non-owner');
  await page.close();
});

test('the owner sees reports listed newest-first, and dream vs comment reports render their own correct fields', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage({ viewport: MOBILE_VIEWPORT });
  await blockThirdParty(page);
  // COMMENT_REPORT is newest (Aug 5), DREAM_REPORT next (Aug 1), HANDLED_REPORT oldest (Jul 1).
  await mockReportsEndpoint(page, [DREAM_REPORT, HANDLED_REPORT, COMMENT_REPORT]);
  await seedUser(page, OWNER_EMAIL);
  await safeGoto(page, baseUrl + '/moderation-x7q4.html');

  await page.waitForSelector('#mod-content', { state: 'visible', timeout: 5000 });

  var ids = await page.locator('.tracker-item').evaluateAll(function (els) { return els.map(function (e) { return e.getAttribute('data-id'); }); });
  assert.deepEqual(ids, ['r-comment-1', 'r-dream-1', 'r-handled-1'], 'reports must render newest-first by createdAt');

  var totalStat = await page.locator('#mod-summary .mod-stat-num').first().textContent();
  assert.equal(totalStat.trim(), '3');

  // Dream report fields: dream id/caption, reporter handle, reason, dream badge.
  var dreamCard = page.locator('.tracker-item[data-id="r-dream-1"]');
  var dreamText = await dreamCard.textContent();
  assert.match(dreamText, /Dream report/);
  assert.match(dreamText, /d-1/);
  assert.match(dreamText, /A dream about flying over mountains/);
  assert.match(dreamText, /@bob/, 'reporter handle must render');
  assert.match(dreamText, /This is disturbing content/, 'reason must render');

  // Comment report fields: comment badge, comment text/author, "anonymous" reporter.
  var commentCard = page.locator('.tracker-item[data-id="r-comment-1"]');
  var commentText = await commentCard.textContent();
  assert.match(commentText, /Comment report/);
  assert.match(commentText, /this is spam content/, 'comment text must render');
  assert.match(commentText, /@spammer/, 'comment author handle must render');
  assert.match(commentText, /anonymous/, 'a null reporterHandle must render as "anonymous"');

  await page.close();
});

test('a handled report shows a Handled marker (no Mark handled button) and visually separates from unhandled ones', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage({ viewport: MOBILE_VIEWPORT });
  await blockThirdParty(page);
  await mockReportsEndpoint(page, [DREAM_REPORT, HANDLED_REPORT]);
  await seedUser(page, OWNER_EMAIL);
  await safeGoto(page, baseUrl + '/moderation-x7q4.html');
  await page.waitForSelector('#mod-content', { state: 'visible', timeout: 5000 });

  var handledCard = page.locator('.tracker-item[data-id="r-handled-1"]');
  var handledTag = await handledCard.locator('.mod-handled-tag').count();
  assert.equal(handledTag, 1, 'a handled report shows the Handled tag');
  var handledBtn = await handledCard.locator('.mod-dismiss-btn').count();
  assert.equal(handledBtn, 0, 'a handled report must not show the Mark handled button');
  var handledClass = await handledCard.evaluate(function (el) { return el.classList.contains('mod-handled'); });
  assert.equal(handledClass, true, 'a handled report gets the visual-separation class');

  var unhandledCard = page.locator('.tracker-item[data-id="r-dream-1"]');
  var unhandledBtn = await unhandledCard.locator('.mod-dismiss-btn').count();
  assert.equal(unhandledBtn, 1, 'an unhandled report shows the Mark handled button');
  var unhandledClass = await unhandledCard.evaluate(function (el) { return el.classList.contains('mod-handled'); });
  assert.equal(unhandledClass, false);

  await page.close();
});

test('clicking Mark handled persists — a second page load shows the report already handled', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage({ viewport: MOBILE_VIEWPORT });
  await blockThirdParty(page);

  // Server-side truth this fake maintains across the two page loads below —
  // mirrors real mark-report-handled.js/get-moderation-reports.js behavior
  // (a real POST followed by a real GET reflecting it) without needing an
  // actual Netlify Functions runtime.
  var serverReports = [Object.assign({}, DREAM_REPORT)];
  await page.route('**/.netlify/functions/get-moderation-reports*', function (route) {
    var url = new URL(route.request().url());
    if (url.searchParams.get('email') !== OWNER_EMAIL) {
      route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'E3: forbidden' }) });
      return;
    }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ reports: serverReports }) });
  });
  await page.route('**/.netlify/functions/mark-report-handled', function (route) {
    var body = JSON.parse(route.request().postData() || '{}');
    var report = serverReports.filter(function (r) { return r.id === body.id; })[0];
    if (report) {
      report.handled = true;
      report.dismissedAt = report.dismissedAt || '2026-08-06T00:00:00.000Z';
    }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ report: report }) });
  });

  await seedUser(page, OWNER_EMAIL);
  await safeGoto(page, baseUrl + '/moderation-x7q4.html');
  await page.waitForSelector('#mod-content', { state: 'visible', timeout: 5000 });

  await page.click('.tracker-item[data-id="r-dream-1"] .mod-dismiss-btn');
  await page.waitForSelector('.tracker-item[data-id="r-dream-1"] .mod-handled-tag', { timeout: 5000 });

  // Reload the page entirely — a fresh GET must show it as already handled,
  // proving this is real server-side persistence, not just optimistic
  // client-side state that would vanish on reload.
  await safeGoto(page, baseUrl + '/moderation-x7q4.html');
  await page.waitForSelector('#mod-content', { state: 'visible', timeout: 5000 });
  var handledTagAfterReload = await page.locator('.tracker-item[data-id="r-dream-1"] .mod-handled-tag').count();
  assert.equal(handledTagAfterReload, 1, 'a second page load must show the report as already handled');
  var dismissBtnAfterReload = await page.locator('.tracker-item[data-id="r-dream-1"] .mod-dismiss-btn').count();
  assert.equal(dismissBtnAfterReload, 0);

  await page.close();
});

test('a failed Mark handled request reverts the button (no false "handled" state) and shows an error', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage({ viewport: MOBILE_VIEWPORT });
  await blockThirdParty(page);
  await mockReportsEndpoint(page, [DREAM_REPORT]);
  await page.route('**/.netlify/functions/mark-report-handled', function (route) {
    route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) });
  });
  await seedUser(page, OWNER_EMAIL);
  await safeGoto(page, baseUrl + '/moderation-x7q4.html');
  await page.waitForSelector('#mod-content', { state: 'visible', timeout: 5000 });

  await page.click('.tracker-item[data-id="r-dream-1"] .mod-dismiss-btn');
  await page.waitForSelector('#mod-error:not(:empty)', { timeout: 5000 });

  var stillHasButton = await page.locator('.tracker-item[data-id="r-dream-1"] .mod-dismiss-btn').count();
  assert.equal(stillHasButton, 1, 'a failed mark-handled attempt must leave the button in place, not silently show Handled');
  var falseHandledTag = await page.locator('.tracker-item[data-id="r-dream-1"] .mod-handled-tag').count();
  assert.equal(falseHandledTag, 0);

  await page.close();
});

test('an empty reports list shows the empty-state message, not a blank list', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage({ viewport: MOBILE_VIEWPORT });
  await blockThirdParty(page);
  await mockReportsEndpoint(page, []);
  await seedUser(page, OWNER_EMAIL);
  await safeGoto(page, baseUrl + '/moderation-x7q4.html');

  await page.waitForSelector('#mod-empty', { state: 'visible', timeout: 5000 });
  var cardCount = await page.locator('.tracker-item').count();
  assert.equal(cardCount, 0);

  await page.close();
});
