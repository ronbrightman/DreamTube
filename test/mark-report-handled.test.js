// test/mark-report-handled.test.js
//
// Covers netlify/functions/mark-report-handled.js (the write side of
// moderation-x7q4.html's dismiss control — tracker item
// for-product-build-the-moderation-review--sbf5ol) and
// lib/moderation-store.js's markHandled: owner-only write, missing-id/
// not-found/forbidden rejections, and the one-way-signal idempotency
// (marking an already-handled report handled again is a no-op that never
// clobbers the original dismissedAt). Same conventions as
// test/report-dream.test.js/test/admin-paywall-toggle.test.js.
// Run with: node --test test/

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');

var OWNER_EMAIL = 'founder@dreamtube.example';
var ENV = { OWNER_EMAIL: OWNER_EMAIL };

function withEnv(vars, fn) {
  var previous = {};
  Object.keys(vars).forEach(function (k) { previous[k] = process.env[k]; });
  Object.keys(vars).forEach(function (k) {
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  });
  return Promise.resolve()
    .then(fn)
    .finally(function () {
      Object.keys(previous).forEach(function (k) {
        if (previous[k] === undefined) delete process.env[k];
        else process.env[k] = previous[k];
      });
    });
}

test.beforeEach(function () {
  mockBlobs.reset();
  delete require.cache[require.resolve('../netlify/functions/mark-report-handled')];
  delete require.cache[require.resolve('../netlify/functions/report-dream')];
  delete require.cache[require.resolve('../netlify/functions/get-moderation-reports')];
  delete require.cache[require.resolve('../netlify/functions/lib/moderation-store')];
});

/** Files one real report via report-dream.js and returns its stored id. */
async function fileReport(ip, body) {
  var reportHandler = require('../netlify/functions/report-dream').handler;
  await reportHandler(fakeEvent({ method: 'POST', ip: ip, body: body }));
  var moderationStore = require('../netlify/functions/lib/moderation-store');
  var reports = await moderationStore.getReports(fakeEvent({ method: 'GET' }));
  return reports[reports.length - 1].id;
}

test('owner POST marks a report handled and a second read reflects it (persists)', function () {
  return withEnv(ENV, async function () {
    var id = await fileReport('5.5.5.1', { dreamId: 'd-handle-1', reason: 'flagged' });

    var handler = require('../netlify/functions/mark-report-handled').handler;
    var res = await handler(fakeEvent({ method: 'POST', body: { id: id, email: OWNER_EMAIL } }));
    assert.equal(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.equal(body.report.handled, true);
    assert.ok(body.report.dismissedAt);

    var getHandler = require('../netlify/functions/get-moderation-reports').handler;
    var getRes = await getHandler(fakeEvent({ method: 'GET', query: { email: OWNER_EMAIL } }));
    var reports = JSON.parse(getRes.body).reports;
    var stored = reports.filter(function (r) { return r.id === id; })[0];
    assert.equal(stored.handled, true, 'a fresh read must reflect the handled marker (real persistence, not just the write response)');
    assert.ok(stored.dismissedAt);
  });
});

test('marking an already-handled report handled again is a no-op that does not change dismissedAt', function () {
  return withEnv(ENV, async function () {
    var id = await fileReport('5.5.5.2', { dreamId: 'd-handle-2' });
    var handler = require('../netlify/functions/mark-report-handled').handler;

    var first = await handler(fakeEvent({ method: 'POST', body: { id: id, email: OWNER_EMAIL } }));
    var firstDismissedAt = JSON.parse(first.body).report.dismissedAt;

    var second = await handler(fakeEvent({ method: 'POST', body: { id: id, email: OWNER_EMAIL } }));
    assert.equal(second.statusCode, 200);
    var secondDismissedAt = JSON.parse(second.body).report.dismissedAt;
    assert.equal(secondDismissedAt, firstDismissedAt, 'a second mark-handled call must not overwrite the original dismissedAt');
  });
});

test('a report id that does not exist is rejected with 404/E6', function () {
  return withEnv(ENV, async function () {
    var handler = require('../netlify/functions/mark-report-handled').handler;
    var res = await handler(fakeEvent({ method: 'POST', body: { id: 'no-such-report', email: OWNER_EMAIL } }));
    assert.equal(res.statusCode, 404);
    assert.match(JSON.parse(res.body).error, /^E6: report_not_found/);
  });
});

test('a non-owner email is rejected with 403 and does not mark the report handled', function () {
  return withEnv(ENV, async function () {
    var id = await fileReport('5.5.5.3', { dreamId: 'd-handle-3' });
    var handler = require('../netlify/functions/mark-report-handled').handler;

    var res = await handler(fakeEvent({ method: 'POST', body: { id: id, email: 'someone-else@example.com' } }));
    assert.equal(res.statusCode, 403);
    assert.match(JSON.parse(res.body).error, /^E5: forbidden/);

    var getHandler = require('../netlify/functions/get-moderation-reports').handler;
    var getRes = await getHandler(fakeEvent({ method: 'GET', query: { email: OWNER_EMAIL } }));
    var stored = JSON.parse(getRes.body).reports.filter(function (r) { return r.id === id; })[0];
    assert.notEqual(stored.handled, true, 'a rejected request must never mark the report handled');
  });
});

test('a missing id is rejected with 400/E4 before the owner check even matters', function () {
  return withEnv(ENV, async function () {
    var handler = require('../netlify/functions/mark-report-handled').handler;
    var res = await handler(fakeEvent({ method: 'POST', body: { email: OWNER_EMAIL } }));
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /^E4: missing_id/);
  });
});

test('invalid JSON is rejected with 400/E3', function () {
  return withEnv(ENV, async function () {
    var handler = require('../netlify/functions/mark-report-handled').handler;
    var res = await handler(fakeEvent({ method: 'POST', body: '{not json' }));
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /^E3: invalid_json/);
  });
});

test('a non-POST method is rejected with 405', function () {
  return withEnv(ENV, async function () {
    var handler = require('../netlify/functions/mark-report-handled').handler;
    var res = await handler(fakeEvent({ method: 'GET' }));
    assert.equal(res.statusCode, 405);
    assert.match(JSON.parse(res.body).error, /^E1: method_not_allowed/);
  });
});

test('rejects with 500 when OWNER_EMAIL is not configured at all', function () {
  return withEnv({ OWNER_EMAIL: undefined }, async function () {
    var handler = require('../netlify/functions/mark-report-handled').handler;
    var res = await handler(fakeEvent({ method: 'POST', body: { id: 'anything', email: 'anyone@example.com' } }));
    assert.equal(res.statusCode, 500);
    assert.match(JSON.parse(res.body).error, /^E2: missing_owner_email/);
  });
});

// ===== lib/moderation-store.js: markHandled directly =====

test('lib/moderation-store.js markHandled: returns null for an id that does not exist', function () {
  return withEnv(ENV, async function () {
    var moderationStore = require('../netlify/functions/lib/moderation-store');
    var result = await moderationStore.markHandled(fakeEvent({ method: 'GET' }), 'nope');
    assert.equal(result, null);
  });
});

test('lib/moderation-store.js markHandled: leaves every OTHER report untouched', function () {
  return withEnv(ENV, async function () {
    var idA = await fileReport('5.5.5.4', { dreamId: 'd-untouched-a' });
    var idB = await fileReport('5.5.5.5', { dreamId: 'd-untouched-b' });

    var moderationStore = require('../netlify/functions/lib/moderation-store');
    await moderationStore.markHandled(fakeEvent({ method: 'GET' }), idA);

    var reports = await moderationStore.getReports(fakeEvent({ method: 'GET' }));
    var reportA = reports.filter(function (r) { return r.id === idA; })[0];
    var reportB = reports.filter(function (r) { return r.id === idB; })[0];
    assert.equal(reportA.handled, true);
    assert.notEqual(reportB.handled, true, 'an unrelated report must never be marked handled as a side effect');
  });
});
