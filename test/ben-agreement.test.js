// test/ben-agreement.test.js
//
// Covers netlify/functions/ben-agreement.js and its
// lib/ben-agreement-store.js — the family agreement tracker behind
// ben/index.html, served at /ben. Run with: node --test test/

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var handler = require('../netlify/functions/ben-agreement').handler;
var benAgreementStore = require('../netlify/functions/lib/ben-agreement-store');

// Every date this suite writes has to stay inside the endpoint's own
// MIN_DATE..UTC-tomorrow window. That window's lower edge is fixed but its
// upper edge moves with the wall clock, so the only three dates guaranteed
// valid on every future run are the agreement's own start date and the two
// derived from now — anything like "three days ago" was still in the
// future when this agreement began and would have failed the day it was
// written.
var AGREEMENT_START = '2026-08-17';

function utcDay(offsetDays) {
  return new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function post(body, ip) {
  return handler(fakeEvent({ method: 'POST', body: body, ip: ip || '203.0.113.1' }));
}

test.beforeEach(function () {
  mockBlobs.reset();
});

test('GET on a never-written store returns an empty record rather than null', async function () {
  var res = await handler(fakeEvent({ method: 'GET' }));
  assert.equal(res.statusCode, 200);
  var payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.days, {});
  assert.equal(payload.updatedAt, null);
});

test('rejects a verb that is neither GET nor POST', async function () {
  var res = await handler(fakeEvent({ method: 'DELETE' }));
  assert.equal(res.statusCode, 405);
  assert.match(JSON.parse(res.body).error, /E1/);
});

test('E2 invalid_json on a malformed body', async function () {
  var res = await handler(fakeEvent({ method: 'POST', body: 'not json' }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /E2/);
});

test('E3 invalid_date rejects a malformed date, a day before the agreement started, and a future day -- and writes nothing', async function () {
  var cases = ['17/8/2026', '2026-8-17', '2026-02-31', '2026-08-16', '2030-01-01'];
  for (var i = 0; i < cases.length; i++) {
    var res = await post({ date: cases[i], field: 's', value: true });
    assert.equal(res.statusCode, 400, cases[i] + ' should be rejected');
    assert.match(JSON.parse(res.body).error, /E3/, cases[i] + ' should be E3');
  }
  var record = await benAgreementStore.readRecord(fakeEvent({}));
  assert.deepEqual(record.days, {}, 'a rejected date must never reach the store');
});

test('E3 accepts tomorrow, because both phones run three hours ahead of UTC', async function () {
  var res = await post({ date: utcDay(1), field: 's', value: true });
  assert.equal(res.statusCode, 200);
});

test('E4 invalid_field and E5 invalid_value reject anything but the two known flags and a real boolean', async function () {
  var badField = await post({ date: utcDay(0), field: 'screen', value: true });
  assert.equal(badField.statusCode, 400);
  assert.match(JSON.parse(badField.body).error, /E4/);

  var badValue = await post({ date: utcDay(0), field: 's', value: 'yes' });
  assert.equal(badValue.statusCode, 400);
  assert.match(JSON.parse(badValue.body).error, /E5/);
});

test('a tick is stored and handed straight back, and a later GET agrees', async function () {
  var date = utcDay(0);
  var res = await post({ date: date, field: 'r', value: true });
  assert.equal(res.statusCode, 200);
  var payload = JSON.parse(res.body);
  assert.deepEqual(payload.days[date], { s: false, r: true });
  assert.ok(payload.updatedAt, 'a write stamps updatedAt');

  var read = JSON.parse((await handler(fakeEvent({ method: 'GET' }))).body);
  assert.deepEqual(read.days[date], { s: false, r: true });
});

test('two flags on the same day merge instead of overwriting each other', async function () {
  var date = AGREEMENT_START;
  await post({ date: date, field: 's', value: true });
  var res = await post({ date: date, field: 'r', value: true });
  assert.deepEqual(JSON.parse(res.body).days[date], { s: true, r: true });
});

test("one person's tick does not erase a day the other person already ticked", async function () {
  var benDay = utcDay(0);
  var ronDay = AGREEMENT_START;
  await post({ date: benDay, field: 's', value: true }, '203.0.113.10');
  await post({ date: ronDay, field: 'r', value: true }, '203.0.113.20');

  var read = JSON.parse((await handler(fakeEvent({ method: 'GET' }))).body);
  assert.deepEqual(read.days[benDay], { s: true, r: false });
  assert.deepEqual(read.days[ronDay], { s: false, r: true });
});

test('un-ticking the last flag drops the day entirely rather than storing an all-false entry', async function () {
  var date = utcDay(0);
  await post({ date: date, field: 's', value: true });
  await post({ date: date, field: 'r', value: true });

  var stillThere = await post({ date: date, field: 's', value: false });
  assert.deepEqual(JSON.parse(stillThere.body).days[date], { s: false, r: true });

  var res = await post({ date: date, field: 'r', value: false });
  assert.equal(Object.prototype.hasOwnProperty.call(JSON.parse(res.body).days, date), false);
});

test('setting a flag to the value it already holds is a no-op, not a toggle', async function () {
  var date = utcDay(0);
  await post({ date: date, field: 's', value: true });
  var res = await post({ date: date, field: 's', value: true });
  assert.deepEqual(JSON.parse(res.body).days[date], { s: true, r: false });
});

test('E7 rate_limited once one IP is past its daily write budget, and the store is left untouched', async function () {
  var rateLimit = require('../netlify/functions/lib/rate-limit');
  var ip = '203.0.113.99';
  // Park the day's counter above the endpoint's own limit directly, rather
  // than issuing 400 real writes to get there — same store and key scheme
  // checkAndIncrement itself uses.
  await rateLimit.writeMarker(fakeEvent({ ip: ip }), 'ben-agreement-write:' + utcDay(0) + ':' + ip, 500);

  var res = await post({ date: utcDay(0), field: 's', value: true }, ip);
  assert.equal(res.statusCode, 429);
  assert.match(JSON.parse(res.body).error, /E7/);

  var record = await benAgreementStore.readRecord(fakeEvent({}));
  assert.deepEqual(record.days, {}, 'a rate-limited request must never reach the store');
});
