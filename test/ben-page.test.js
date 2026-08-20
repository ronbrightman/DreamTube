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

/**
 * Waits for the countdown to stop tweening, by polling until two
 * consecutive reads agree. Deliberately NOT a fixed sleep: a sleep long
 * enough to be safe here keeps this file's browser alive for seconds
 * longer than it needs, and `node --test` runs test FILES in parallel —
 * that idle browser was measurably starving the other browser-driven
 * suites into their own timeouts (two of them failed reproducibly when
 * this file used sleeps, and passed once it stopped).
 */
async function settled(page) {
  // Clear the marker first, so this always compares two reads taken AFTER
  // the change being waited on. Leaving a value behind from the previous
  // settle made the very first poll match it and return early, reading the
  // countdown mid-tween — which is exactly how the "a perfect day takes two
  // days off" test saw the pre-tick number and failed.
  await page.evaluate(function () { window.__benLastNum = undefined; });
  await page.waitForFunction(function () {
    var current = document.querySelector('#num').textContent;
    var previous = window.__benLastNum;
    window.__benLastNum = current;
    return previous === current;
  }, null, { polling: 100, timeout: 10000 });
}

/** Ticks one box on the selected day and waits for the write to round-trip, by watching the credit total reach `expectedCredits`. */
async function tick(page, field, expectedCredits) {
  await page.click('.tg[data-k="' + field + '"]');
  await page.waitForFunction(function (expected) {
    return document.querySelector('#st-c').textContent === String(expected);
  }, expectedCredits, { timeout: 10000 });
  await settled(page);
}

async function selectDay(page, dateKey) {
  await page.click('.cell[data-d="' + dateKey + '"]');
  await page.waitForFunction(function (key) {
    var cell = document.querySelector('.cell[data-d="' + key + '"]');
    return cell && cell.classList.contains('sel');
  }, dateKey, { timeout: 5000 });
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
  await settled(page);
  return page;
}

test('the perfect-pace line is exactly ceil(remaining / 3) days out, on the date it names', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await openTracker({});

  var remaining = Number(await page.textContent('#num'));
  var paceText = await page.textContent('.pace .v');
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

  var perfect = parseHebrewDate(await page.textContent('.pace .v'));
  var actual = parseHebrewDate(await page.textContent('#st-f'));

  assert.ok(perfect <= actual, 'ticking everything can never finish later than the current pace');
  assert.ok(perfect <= new Date(2027, 2, 24), 'and never later than the 13th birthday it counts down to');

  await page.close();
});

test('ticking both of today\'s boxes takes exactly two days off, and the perfect-pace line follows', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await openTracker({});

  var before = Number(await page.textContent('#num'));
  var paceBefore = parseHebrewDate(await page.textContent('.pace .v'));

  await tick(page, 's', 1);
  await tick(page, 'r', 2);

  var after = Number(await page.textContent('#num'));
  assert.equal(after, before - 2, 'screen-time plus reading is two days, no more and no less');
  assert.equal(await page.textContent('#st-c'), '2');

  var paceText = await page.textContent('.pace .v');
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
  assert.equal(firstInt(await page.textContent('.pace .v')), Math.ceil(remaining / 3));

  await page.close();
});

test('every tick changes the perfect-pace block, including the two in three that leave its date alone', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }

  // The bug this covers, reported by the founder on 2026-08-20: ticking
  // "read" on an earlier day "barely changes" the perfect-pace line. It is
  // real and inherent — a tick takes ONE day off the count while that line
  // is quantised to three-day steps, so its DATE only moves on every third
  // tick. What must never happen is a tick that changes nothing at all on
  // screen, because a child who ticks a box and sees no response concludes
  // the page is broken. So this asserts the whole block, not the date: no
  // tick may leave it identical.
  var seeded = {};
  for (var i = 1; i <= 3; i++) {
    // Screen-time only, so each of these days still has a reading box to tick.
    seeded[localKey(addDays(today(), -i))] = { s: true, r: false };
  }
  var page = await openTracker(seeded);

  var seenDates = [];
  var previousBlock = await page.textContent('#pace');
  for (var day = 1; day <= 3; day++) {
    await selectDay(page, localKey(addDays(today(), -day)));
    await tick(page, 'r', 3 + day);

    var block = await page.textContent('#pace');
    assert.notEqual(block, previousBlock,
      'tick ' + day + ' left the perfect-pace block byte-identical — that is the "nothing happened" bug');
    previousBlock = block;

    var toNext = Number(await page.getAttribute('#pace-next', 'data-ticks'));
    assert.ok(toNext >= 1 && toNext <= 3, 'the countdown to the next day-shift stays inside one three-day step, got ' + toNext);
    seenDates.push(localKey(parseHebrewDate(await page.textContent('.pace .v'))));
  }

  // Three ticks is exactly one three-day step, so the date must have moved
  // earlier over the run — the ticks are not merely cosmetic.
  assert.ok(seenDates[2] < seenDates[0], 'three ticks must pull the projected date at least a day earlier');

  await page.close();
});

test('the countdown to the next day-shift lands on 1 exactly when the next tick moves the date', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var seeded = {};
  for (var i = 1; i <= 3; i++) seeded[localKey(addDays(today(), -i))] = { s: true, r: false };
  var page = await openTracker(seeded);

  // Tick reading on earlier days until the block promises the date is one
  // tick away, then take that tick and hold it to its word.
  var moved = false;
  for (var day = 1; day <= 3 && !moved; day++) {
    var promisedOneAway = (await page.getAttribute('#pace-next', 'data-ticks')) === '1';
    var dateBefore = parseHebrewDate(await page.textContent('.pace .v'));

    await selectDay(page, localKey(addDays(today(), -day)));
    await tick(page, 'r', 3 + day);

    var dateAfter = parseHebrewDate(await page.textContent('.pace .v'));
    if (promisedOneAway) {
      assert.equal(localKey(dateAfter), localKey(addDays(dateBefore, -1)),
        'the block said one more tick would pull the date in by a day, so it must have');
      moved = true;
    } else {
      assert.equal(localKey(dateAfter), localKey(dateBefore),
        'and while it says more than one tick is needed, the date must hold still');
    }
  }
  assert.ok(moved, 'three ticks span a full three-day step, so the promise must have come due within them');

  await page.close();
});
