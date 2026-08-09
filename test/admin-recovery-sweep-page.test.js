// test/admin-recovery-sweep-page.test.js
//
// Real browser coverage for admin-recovery-sweep.html (the owner-only
// one-tap runner for admin-backfill-media-rehost.js, tracker item
// for-product-close-the-recovery-backfill--9chzb4: "run sweep to
// completion, recover what is recoverable, one-line closure"). The
// backend endpoint's own accounts/feed pagination, idempotency, and
// per-field re-host outcome logic is covered at the handler level
// (test/admin-backfill-media-rehost.test.js) — this file proves the PAGE
// drives that endpoint's cursor loop to completion, accumulates counts
// across every page (not just the last page's numbers), and reports
// failures honestly. Playwright resolution/skip convention and
// static-server pattern mirror test/audit-lost-generations-page.test.js
// closely (the sibling owner-tool page this one was built to match).

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

// Three-page sweep exercising both phases the real endpoint documents in
// its own header comment: two accounts-phase pages (an in-progress cursor,
// then the last accounts page handing off to the feed phase via the
// literal cursor 'feed'), then one feed-phase page that finally reports
// done:true. Mirrors admin-backfill-media-rehost.js's own response shape
// exactly (phase, scannedAccounts, scannedMediaItems, rehosted,
// alreadyDurable, skippedNoMedia, failed, nextCursor, done).
var ACCOUNTS_PAGE_1 = { ok: true, phase: 'accounts', scannedAccounts: 25, scannedMediaItems: 40, rehosted: 10, alreadyDurable: 20, skippedNoMedia: 5, failed: 2, totalAccounts: 35, nextCursor: '25', done: false };
var ACCOUNTS_PAGE_2 = { ok: true, phase: 'accounts', scannedAccounts: 10, scannedMediaItems: 15, rehosted: 3, alreadyDurable: 5, skippedNoMedia: 2, failed: 1, totalAccounts: 35, nextCursor: 'feed', done: false };
var FEED_PAGE = { ok: true, phase: 'feed', scannedAccounts: 0, scannedMediaItems: 8, rehosted: 2, alreadyDurable: 4, skippedNoMedia: 1, failed: 0, nextCursor: null, done: true };

function mockSweepSequence(page, pages) {
  var callIndex = 0;
  return page.route('**/.netlify/functions/admin-backfill-media-rehost', function (route) {
    var response = pages[Math.min(callIndex, pages.length - 1)];
    callIndex++;
    if (typeof response === 'function') response = response(callIndex);
    route.fulfill({ status: response.status || 200, contentType: 'application/json', body: JSON.stringify(response.body || response) });
  });
}

test('a full multi-page sweep (accounts page 1 -> accounts page 2 -> feed) accumulates totals across every page and stops once done:true, never just showing the last page\'s numbers', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage({ viewport: MOBILE_VIEWPORT });
  await blockThirdParty(page);
  var requestBodies = [];
  page.on('request', function (req) {
    if (req.url().indexOf('admin-backfill-media-rehost') !== -1) {
      try { requestBodies.push(JSON.parse(req.postData())); } catch (e) { /* ignore */ }
    }
  });
  await mockSweepSequence(page, [ACCOUNTS_PAGE_1, ACCOUNTS_PAGE_2, FEED_PAGE]);
  await safeGoto(page, baseUrl + '/admin-recovery-sweep.html');

  await page.fill('#pw', 'realownerpassword');
  await page.click('#run');
  await page.waitForSelector('#out.show', { timeout: 5000 });

  // Totals across all three pages, NOT just FEED_PAGE's own numbers.
  assert.equal((await page.locator('#recovered').textContent()).trim(), '15', '10 + 3 + 2 rehosted across every page');
  assert.equal((await page.locator('#durable').textContent()).trim(), '29', '20 + 5 + 4 already durable across every page');
  assert.equal((await page.locator('#lost').textContent()).trim(), '3', '2 + 1 + 0 failed across every page');
  assert.equal((await page.locator('#skipped').textContent()).trim(), '8', '5 + 2 + 1 skipped-no-media across every page');
  assert.equal((await page.locator('#accounts').textContent()).trim(), '35', '25 + 10 + 0 accounts scanned across every page');
  assert.equal((await page.locator('#items').textContent()).trim(), '63', '40 + 15 + 8 media items scanned across every page');

  var verdict = await page.locator('#verdict').textContent();
  assert.match(verdict, /3 item\(s\) could not be recovered/, 'the failed total surfaces in the final verdict, not just the row');

  // The loop actually paged: 3 real calls, the middle one carrying the
  // first page's own nextCursor, the last one carrying the literal 'feed'
  // cursor the accounts phase hands off with.
  assert.equal(requestBodies.length, 3);
  assert.equal(requestBodies[0].cursor, undefined, 'first call starts the sweep with no cursor');
  assert.equal(requestBodies[1].cursor, '25', 'second call resumes from the first page\'s own nextCursor');
  assert.equal(requestBodies[2].cursor, 'feed', 'third call is the feed-phase handoff');

  // The password never changes across pages, and the endpoint is always
  // called against the one hardcoded owner account (mirroring
  // audit-x7q4.html's own auth shape).
  requestBodies.forEach(function (body) {
    assert.equal(body.password, 'realownerpassword');
    assert.equal(body.usernameOrEmail, 'ronbrightman@gmail.com');
  });

  await page.close();
});

test('a wrong password (E5 from the real endpoint) shows a plain-English error and never reveals the results panel', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage({ viewport: MOBILE_VIEWPORT });
  await blockThirdParty(page);
  await page.route('**/.netlify/functions/admin-backfill-media-rehost', function (route) {
    route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'E5: forbidden' }) });
  });
  await safeGoto(page, baseUrl + '/admin-recovery-sweep.html');

  await page.fill('#pw', 'wrongpassword');
  await page.click('#run');
  await page.waitForSelector('#err:not(:empty)', { timeout: 5000 });

  var errText = await page.locator('#err').textContent();
  assert.match(errText, /wrong password/i);
  var outVisible = await page.isVisible('#out.show');
  assert.equal(outVisible, false);
  var progressVisible = await page.isVisible('.progress.show');
  assert.equal(progressVisible, false, 'the in-progress line clears back out on failure rather than sticking around');
  var btnText = await page.locator('#run').textContent();
  assert.equal(btnText.trim(), 'Run the sweep', 'the button re-enables with its normal label after a failure');

  await page.close();
});

test('a failure mid-sweep (E6 rate-limited, on the SECOND page after a successful first page) is shown honestly rather than silently stopping or showing a false-success panel', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage({ viewport: MOBILE_VIEWPORT });
  await blockThirdParty(page);
  var callIndex = 0;
  await page.route('**/.netlify/functions/admin-backfill-media-rehost', function (route) {
    callIndex++;
    if (callIndex === 1) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ACCOUNTS_PAGE_1) });
    } else {
      route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'E6: rate_limited: too many attempts from this network today, try again tomorrow' }) });
    }
  });
  await safeGoto(page, baseUrl + '/admin-recovery-sweep.html');

  await page.fill('#pw', 'realownerpassword');
  await page.click('#run');
  await page.waitForSelector('#err:not(:empty)', { timeout: 5000 });

  var errText = await page.locator('#err').textContent();
  assert.match(errText, /rate limited/i);
  var outVisible = await page.isVisible('#out.show');
  assert.equal(outVisible, false, 'a mid-sweep failure must never show a final summary panel — partial totals are not the real closing numbers');
  assert.equal(callIndex, 2, 'the loop made it through the first successful page before hitting the failure on the second');

  await page.close();
});
