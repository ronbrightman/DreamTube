// test/admin-resend-dedup-card-behavioral.test.js
//
// Real browser coverage for the "Resend send-log diagnostic" card on
// admin.html (tracker item for-product-add-a-one-tap-admin-html-run-s58738,
// a one-tap runner for netlify/functions/admin-diagnose-resend-sends.js —
// see that function's own header comment for the full request/response
// contract this card wires up to, and for the tracker items it exists to
// settle). The diagnostic ENDPOINT itself is covered at the handler level
// (test/admin-diagnose-resend-sends.test.js) — this file only proves the
// CARD builds the right request (recipient parsing, default date window,
// field validation) and renders the response honestly (per-recipient
// counts/sends, the scan-coverage footer, every documented error code).
// Login-gate + owner-check mocking pattern mirrors test/media-library-page.test.js.

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

/** Seeds a logged-in account with a real email on file — enough for the client-side owner gate to unlock #admin-content (mirrors media-library-page.test.js's own seedUser). */
async function seedUser(page) {
  await safeGoto(page, baseUrl + '/login.html');
  await page.evaluate(function () {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@owner', username: 'owner' };
    if (!state.accounts) state.accounts = {};
    state.accounts.owner = { password: 'ownerpass1', email: 'founder@dreamtube.example' };
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  });
}

/** admin.html's own owner gate: a GET to admin-paywall-toggle with isOwner:true unlocks #admin-content. */
function mockOwnerGate(page) {
  return page.route('**/.netlify/functions/admin-paywall-toggle*', function (route) {
    if (route.request().method() !== 'GET') { route.continue(); return; }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: false, source: 'env', isOwner: true }) });
  });
}

async function openUnlockedAdmin(page) {
  await mockOwnerGate(page);
  await seedUser(page);
  await safeGoto(page, baseUrl + '/admin.html');
  await page.waitForSelector('#admin-content', { state: 'visible', timeout: 5000 });
}

var SAMPLE_RESPONSE = {
  ok: true,
  results: {
    'moreece@example.com': {
      count: 3,
      sends: [
        { createdAt: '2026-08-01 10:03:12.674981+00', subject: 'Your first dream is ready!' },
        { createdAt: '2026-08-01 10:03:15.100000+00', subject: 'Your first dream is ready!' },
        { createdAt: '2026-08-02 09:00:00.000000+00', subject: 'Your first dream is ready!' }
      ]
    },
    'demia@example.com': { count: 0, sends: [] }
  },
  totalEmailsScanned: 342,
  pagesFetched: 4,
  truncated: false
};

test('the since/until fields are pre-filled with a sensible default window on load (since = 2026-08-01, until = non-empty/real)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage({ viewport: MOBILE_VIEWPORT });
  await blockThirdParty(page);
  await openUnlockedAdmin(page);

  var since = await page.inputValue('#admin-resend-since');
  var until = await page.inputValue('#admin-resend-until');
  assert.equal(since, '2026-08-01T00:00:00Z');
  assert.ok(until, 'until is pre-filled, not left blank');
  assert.ok(!isNaN(Date.parse(until)), 'until is a real parseable date');

  await page.close();
});

test('submitting sends the parsed recipient list (comma- and newline-separated) plus the date window in the request body', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage({ viewport: MOBILE_VIEWPORT });
  await blockThirdParty(page);
  await openUnlockedAdmin(page);

  var requestBodies = [];
  await page.route('**/.netlify/functions/admin-diagnose-resend-sends', function (route) {
    try { requestBodies.push(JSON.parse(route.request().postData())); } catch (e) { /* ignore */ }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_RESPONSE) });
  });

  await page.fill('#admin-resend-source', 'ronbrightman');
  await page.fill('#admin-resend-password', 'realfounderpw1');
  await page.fill('#admin-resend-recipients', 'moreece@example.com, dtsexton18@example.com\ndemia@example.com');
  await page.click('#admin-resend-submit');
  await page.waitForSelector('#admin-resend-result', { state: 'visible', timeout: 5000 });

  assert.equal(requestBodies.length, 1);
  assert.deepEqual(requestBodies[0].recipientEmails, ['moreece@example.com', 'dtsexton18@example.com', 'demia@example.com']);
  assert.equal(requestBodies[0].usernameOrEmail, 'ronbrightman');
  assert.equal(requestBodies[0].password, 'realfounderpw1');
  assert.equal(requestBodies[0].sinceISO, '2026-08-01T00:00:00Z');
  assert.ok(requestBodies[0].untilISO);

  await page.close();
});

test('a successful response renders per-recipient counts, each send\'s timestamp and subject, and the scan-coverage footer', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage({ viewport: MOBILE_VIEWPORT });
  await blockThirdParty(page);
  await openUnlockedAdmin(page);

  await page.route('**/.netlify/functions/admin-diagnose-resend-sends', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_RESPONSE) });
  });

  await page.fill('#admin-resend-source', 'ronbrightman');
  await page.fill('#admin-resend-password', 'realfounderpw1');
  await page.fill('#admin-resend-recipients', 'moreece@example.com, demia@example.com');
  await page.click('#admin-resend-submit');
  await page.waitForSelector('#admin-resend-result', { state: 'visible', timeout: 5000 });

  var resultText = await page.locator('#admin-resend-result').textContent();
  assert.match(resultText, /moreece@example\.com — 3 send\(s\)/);
  assert.match(resultText, /2026-08-01 10:03:12\.674981\+00 — "Your first dream is ready!"/);
  assert.match(resultText, /2026-08-02 09:00:00\.000000\+00 — "Your first dream is ready!"/);
  assert.match(resultText, /demia@example\.com — 0 send\(s\)/);
  assert.match(resultText, /Scanned 342 email\(s\) across 4 page\(s\)\./);
  assert.doesNotMatch(resultText, /TRUNCATED/);

  await page.close();
});

test('a truncated response surfaces the truncation warning in the footer', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage({ viewport: MOBILE_VIEWPORT });
  await blockThirdParty(page);
  await openUnlockedAdmin(page);

  var truncatedResponse = Object.assign({}, SAMPLE_RESPONSE, { truncated: true });
  await page.route('**/.netlify/functions/admin-diagnose-resend-sends', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(truncatedResponse) });
  });

  await page.fill('#admin-resend-source', 'ronbrightman');
  await page.fill('#admin-resend-password', 'realfounderpw1');
  await page.fill('#admin-resend-recipients', 'moreece@example.com');
  await page.click('#admin-resend-submit');
  await page.waitForSelector('#admin-resend-result', { state: 'visible', timeout: 5000 });

  var resultText = await page.locator('#admin-resend-result').textContent();
  assert.match(resultText, /TRUNCATED at the safety page cap, results may be incomplete/);

  await page.close();
});

test('a wrong password (E5) shows a plain-English error and never reveals the result panel', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage({ viewport: MOBILE_VIEWPORT });
  await blockThirdParty(page);
  await openUnlockedAdmin(page);

  await page.route('**/.netlify/functions/admin-diagnose-resend-sends', function (route) {
    route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'E5: forbidden' }) });
  });

  await page.fill('#admin-resend-source', 'ronbrightman');
  await page.fill('#admin-resend-password', 'wrongpassword');
  await page.fill('#admin-resend-recipients', 'moreece@example.com');
  await page.click('#admin-resend-submit');
  await page.waitForSelector('#admin-resend-error:not(:empty)', { timeout: 5000 });

  var errText = await page.locator('#admin-resend-error').textContent();
  assert.match(errText, /couldn.t verify/i);
  var resultVisible = await page.isVisible('#admin-resend-result');
  assert.equal(resultVisible, false);

  await page.close();
});

test('a dynamic-detail error code (E10 resend_api_error) surfaces its actual detail text, not just the bare code', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage({ viewport: MOBILE_VIEWPORT });
  await blockThirdParty(page);
  await openUnlockedAdmin(page);

  await page.route('**/.netlify/functions/admin-diagnose-resend-sends', function (route) {
    route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'E10: resend_api_error: 401 Unauthorized' }) });
  });

  await page.fill('#admin-resend-source', 'ronbrightman');
  await page.fill('#admin-resend-password', 'realfounderpw1');
  await page.fill('#admin-resend-recipients', 'moreece@example.com');
  await page.click('#admin-resend-submit');
  await page.waitForSelector('#admin-resend-error:not(:empty)', { timeout: 5000 });

  // Only the leading "E10: " code prefix is stripped (same house pattern as
  // the E6 rate-limit copy elsewhere on this page) — the rest of the
  // server's own message (including the "resend_api_error:" sub-label) is
  // shown verbatim rather than re-parsed further.
  var errText = await page.locator('#admin-resend-error').textContent();
  assert.equal(errText.trim(), 'resend_api_error: 401 Unauthorized');

  await page.close();
});

test('submitting with no recipients is blocked client-side with no request sent', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage({ viewport: MOBILE_VIEWPORT });
  await blockThirdParty(page);
  await openUnlockedAdmin(page);

  var requestCount = 0;
  await page.route('**/.netlify/functions/admin-diagnose-resend-sends', function (route) {
    requestCount++;
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_RESPONSE) });
  });

  await page.fill('#admin-resend-source', 'ronbrightman');
  await page.fill('#admin-resend-password', 'realfounderpw1');
  // Recipients field left empty.
  await page.click('#admin-resend-submit');
  await page.waitForSelector('#admin-resend-error:not(:empty)', { timeout: 5000 });

  var errText = await page.locator('#admin-resend-error').textContent();
  assert.match(errText, /at least one recipient/i);
  assert.equal(requestCount, 0, 'no request was made when client-side validation already caught the problem');

  await page.close();
});

test('submitting with more than 20 recipients is blocked client-side with no request sent', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage({ viewport: MOBILE_VIEWPORT });
  await blockThirdParty(page);
  await openUnlockedAdmin(page);

  var requestCount = 0;
  await page.route('**/.netlify/functions/admin-diagnose-resend-sends', function (route) {
    requestCount++;
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_RESPONSE) });
  });

  var manyEmails = [];
  for (var i = 0; i < 21; i++) manyEmails.push('user' + i + '@example.com');

  await page.fill('#admin-resend-source', 'ronbrightman');
  await page.fill('#admin-resend-password', 'realfounderpw1');
  await page.fill('#admin-resend-recipients', manyEmails.join('\n'));
  await page.click('#admin-resend-submit');
  await page.waitForSelector('#admin-resend-error:not(:empty)', { timeout: 5000 });

  var errText = await page.locator('#admin-resend-error').textContent();
  assert.match(errText, /no more than 20/i);
  assert.equal(requestCount, 0);

  await page.close();
});
