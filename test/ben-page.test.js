// test/ben-page.test.js
//
// Real browser coverage for ben/index.html (served at /ben) — the family
// agreement tracker's own arithmetic, which lives entirely in the page.
// The endpoint and store behind it are covered at the handler level in
// test/ben-agreement.test.js; this file only proves the numbers the page
// puts in front of a child are right. Playwright resolution/skip
// convention matches every other browser test in this repo (see
// test/media-library-page.test.js's own header comment).
//
// EVERY assertion here is written against the page's OWN rendered output
// rather than a hard-coded expected day count, because the countdown moves
// with the real calendar: "218 days left" is true only today. So the tests
// read the number the page rendered and check the RELATIONSHIPS that must
// hold on any date — a perfect-pace finish is exactly ceil(remaining / 3)
// days out, its date is exactly that many days from today, it can never
// land after the pace actually being kept, and ticking both of a day's
// boxes takes exactly two days off. Those are the agreement's real rules;
// a hard-coded 218 would only be re-stating today's clock.

var test = require('node:test');
var assert = require('node:assert/strict');
var staticServer = require('./helpers/static-server');

var CHROMIUM_PATH = '/opt/pw-browsers/chromium';
var MOBILE_VIEWPORT = { width: 390, height: 844 };

var MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

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

function pad(n) { return n < 10 ? '0' + n : '' + n; }
function localKey(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function today() { var n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); }
function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }

/** Parses the page's own "D בMONTH YYYY" rendering back into a Date, so a test can compare it against a date it computed itself. */
function parseHebrewDate(text) {
  var m = text.match(/(\d{1,2})\s+ב([֐-׿]+)\s+(\d{4})/);
  assert.ok(m, 'expected a Hebrew date inside: ' + text);
  var monthIndex = MONTHS.indexOf(m[2]);
  assert.notEqual(monthIndex, -1, 'unknown Hebrew month in: ' + text);
  return new Date(Number(m[3]), monthIndex, Number(m[1]));
}

function firstInt(text) {
  var m = text.match(/\d+/);
  assert.ok(m, 'expected a number inside: ' + text);
  return Number(m[0]);
}

/**
 * Serves the tracker's endpoint from an in-memory record, so a test can
 * start the page from any state and watch a real tick round-trip. Mirrors
 * the real handler's merge semantics (one flag on one day, an all-false
 * day dropped) — the handler's own version of that is asserted directly in
 * test/ben-agreement.test.js.
 */
function mockAgreementEndpoint(page, seedDays) {
  var days = JSON.parse(JSON.stringify(seedDays || {}));
  return page.route('**/.netlify/functions/ben-agreement', function (route) {
    var request = route.request();
    if (request.method() === 'POST') {
      var body = JSON.parse(request.postData() || '{}');
      var day = Object.assign({ s: false, r: false }, days[body.date]);
      day[body.field] = body.value;
      if (!day.s && !day.r) delete days[body.date]; else days[body.date] = day;
    }
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, days: days, updatedAt: new Date().toISOString() })
    });
  });
}

async function openTracker(seedDays) {
  var page = await browser.newPage({ viewport: MOBILE_VIEWPORT });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, function (route) { route.abort(); });
  await mockAgreementEndpoint(page, seedDays);
  await page.goto(baseUrl + '/ben/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(function () {
    var el = document.querySelector('#num');
    return el && el.textContent !== '—' && !document.querySelector('#pace').hidden;
  }, null, { timeout: 15000 });
  // The countdown tweens to its value; wait for it to settle rather than
  // reading a mid-animation frame.
  await page.waitForTimeout(700);
  return page;
}

test('the perfect-pace line is exactly ceil(remaining / 3) days out, on the date it names', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await openTracker({});

  var remaining = Number(await page.textContent('#num'));
  var paceText = await page.textContent('#pace');
  var paceDays = firstInt(paceText);

  assert.equal(paceDays, Math.ceil(remaining / 3),
    'a day with both boxes ticked advances the count by three, so the finish is ceil(remaining/3) days out');
  assert.equal(localKey(parseHebrewDate(paceText)), localKey(addDays(today(), paceDays)),
    'the date on the line must be exactly that many days from today');

  await page.close();
});

test('the perfect pace never lands after the pace actually being kept, nor after the birthday itself', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await openTracker({});

  var perfect = parseHebrewDate(await page.textContent('#pace'));
  var actual = parseHebrewDate(await page.textContent('#st-f'));

  assert.ok(perfect <= actual, 'ticking everything can never finish later than the current pace');
  assert.ok(perfect <= new Date(2027, 2, 24), 'and never later than the 13th birthday it counts down to');

  await page.close();
});

test('ticking both of today\'s boxes takes exactly two days off, and the perfect-pace line follows', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await openTracker({});

  var before = Number(await page.textContent('#num'));
  var paceBefore = parseHebrewDate(await page.textContent('#pace'));

  await page.click('.tg[data-k="s"]');
  await page.waitForTimeout(400);
  await page.click('.tg[data-k="r"]');
  await page.waitForTimeout(900);

  var after = Number(await page.textContent('#num'));
  assert.equal(after, before - 2, 'screen-time plus reading is two days, no more and no less');
  assert.equal(await page.textContent('#st-c'), '2');

  var paceText = await page.textContent('#pace');
  assert.equal(firstInt(paceText), Math.ceil(after / 3), 'the perfect-pace line recomputes off the new remaining');
  assert.ok(parseHebrewDate(paceText) <= paceBefore, 'and can only ever move earlier');

  await page.close();
});

test('a day already ticked on the server is reflected on load, not just after a click', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var seeded = {};
  seeded[localKey(today())] = { s: true, r: true };
  var page = await openTracker(seeded);

  assert.equal(await page.textContent('#st-c'), '2', 'both of the seeded day\'s flags count');
  assert.equal(await page.getAttribute('.tg[data-k="s"]', 'aria-pressed'), 'true');
  assert.equal(await page.getAttribute('.tg[data-k="r"]', 'aria-pressed'), 'true');

  var remaining = Number(await page.textContent('#num'));
  assert.equal(firstInt(await page.textContent('#pace')), Math.ceil(remaining / 3));

  await page.close();
});
