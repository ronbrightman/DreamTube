// test/report-dream.test.js
//
// Covers the new public-feed-safety report flow (tracker item
// for-product-public-feed-safety-in-app-re-ppuw77):
//   - report-dream.js: validation, persistence to lib/moderation-store.js,
//     per-IP rate limiting.
//   - get-moderation-reports.js: owner-only read.
//   - lib/moderation-store.js: appendReport idempotency (same shape as
//     test/support-feedback.test.js's identical support-store.js coverage).
// Run with: node --test test/

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');

var OWNER_EMAIL = 'founder@dreamtube.example';

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
  delete require.cache[require.resolve('../netlify/functions/report-dream')];
  delete require.cache[require.resolve('../netlify/functions/get-moderation-reports')];
  delete require.cache[require.resolve('../netlify/functions/lib/moderation-store')];
  delete require.cache[require.resolve('../netlify/functions/lib/rate-limit')];
});

var ENV = { OWNER_EMAIL: OWNER_EMAIL };

// ===== report-dream.js =====

test('report-dream: a valid report with a reason is persisted', function () {
  return withEnv(ENV, async function () {
    var handler = require('../netlify/functions/report-dream').handler;
    var res = await handler(fakeEvent({
      method: 'POST',
      ip: '1.1.1.1',
      body: {
        dreamId: 'd-1',
        dreamOwnerHandle: '@alice',
        dreamCaption: 'A dream about flying',
        reporterHandle: '@bob',
        reason: 'This is disturbing content'
      }
    }));
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true });

    var moderationStore = require('../netlify/functions/lib/moderation-store');
    var reports = await moderationStore.getReports(fakeEvent({ method: 'GET' }));
    assert.equal(reports.length, 1);
    assert.equal(reports[0].dreamId, 'd-1');
    assert.equal(reports[0].dreamOwnerHandle, '@alice');
    assert.equal(reports[0].dreamCaption, 'A dream about flying');
    assert.equal(reports[0].reporterHandle, '@bob');
    assert.equal(reports[0].reason, 'This is disturbing content');
    assert.ok(reports[0].id);
    assert.ok(reports[0].createdAt);
  });
});

test('report-dream: reason is optional -- omitting it (or a logged-out reporterHandle) stores null, not a fabricated value', function () {
  return withEnv(ENV, async function () {
    var handler = require('../netlify/functions/report-dream').handler;
    var res = await handler(fakeEvent({
      method: 'POST',
      ip: '1.1.1.2',
      body: { dreamId: 'd-2', dreamOwnerHandle: '@alice', dreamCaption: 'caption' }
    }));
    assert.equal(res.statusCode, 200);

    var moderationStore = require('../netlify/functions/lib/moderation-store');
    var reports = await moderationStore.getReports(fakeEvent({ method: 'GET' }));
    assert.equal(reports[0].reason, null);
    assert.equal(reports[0].reporterHandle, null);
  });
});

test('report-dream: a whitespace-only reason is normalized to null', function () {
  return withEnv(ENV, async function () {
    var handler = require('../netlify/functions/report-dream').handler;
    await handler(fakeEvent({ method: 'POST', ip: '1.1.1.3', body: { dreamId: 'd-3', reason: '   ' } }));

    var moderationStore = require('../netlify/functions/lib/moderation-store');
    var reports = await moderationStore.getReports(fakeEvent({ method: 'GET' }));
    assert.equal(reports[0].reason, null);
  });
});

test('report-dream: rejects missing dreamId, an over-length reason, invalid JSON, and non-POST methods', function () {
  return withEnv(ENV, async function () {
    var handler = require('../netlify/functions/report-dream').handler;

    var noDreamId = await handler(fakeEvent({ method: 'POST', ip: '2.2.2.1', body: { reason: 'hi' } }));
    assert.equal(noDreamId.statusCode, 400);
    assert.match(JSON.parse(noDreamId.body).error, /^E3: dream_id_required/);

    var tooLongReason = await handler(fakeEvent({ method: 'POST', ip: '2.2.2.2', body: { dreamId: 'd-x', reason: 'x'.repeat(501) } }));
    assert.equal(tooLongReason.statusCode, 400);
    assert.match(JSON.parse(tooLongReason.body).error, /^E4: reason_too_long/);

    var badJson = await handler(fakeEvent({ method: 'POST', ip: '2.2.2.3', body: '{not json' }));
    assert.equal(badJson.statusCode, 400);
    assert.match(JSON.parse(badJson.body).error, /^E2: invalid_json/);

    var wrongMethod = await handler(fakeEvent({ method: 'GET' }));
    assert.equal(wrongMethod.statusCode, 405);
    assert.match(JSON.parse(wrongMethod.body).error, /^E1: method_not_allowed/);
  });
});

test('report-dream: per-IP daily cap rejects further reports with 429/E5 once exceeded', function () {
  return withEnv(Object.assign({ MAX_REPORTS_PER_IP_PER_DAY: '2' }, ENV), async function () {
    var handler = require('../netlify/functions/report-dream').handler;
    var ip = '3.3.3.3';
    var body = { dreamId: 'd-capped' };

    var first = await handler(fakeEvent({ method: 'POST', ip: ip, body: body }));
    assert.equal(first.statusCode, 200);
    var second = await handler(fakeEvent({ method: 'POST', ip: ip, body: body }));
    assert.equal(second.statusCode, 200);
    var third = await handler(fakeEvent({ method: 'POST', ip: ip, body: body }));
    assert.equal(third.statusCode, 429);
    assert.match(JSON.parse(third.body).error, /^E5: rate_limited/);
  });
});

// ===== lib/moderation-store.js: appendReport idempotency =====
//
// Same reasoning as test/support-feedback.test.js's identical
// appendMessage coverage: calling appendReport twice with the SAME entry
// id (simulating a retry after a verify-read false negative) must never
// duplicate the report.
test('lib/moderation-store.js appendReport: calling it twice with the SAME entry id never duplicates the report', async function () {
  var moderationStore = require('../netlify/functions/lib/moderation-store');
  var event = fakeEvent({ method: 'GET' });

  var entry = {
    id: 'fixed-test-report-id-123',
    dreamId: 'd-idempotency',
    dreamOwnerHandle: '@alice',
    dreamCaption: 'caption',
    reporterHandle: null,
    reason: 'this must only ever appear once',
    createdAt: new Date().toISOString()
  };

  await moderationStore.appendReport(event, entry);
  await moderationStore.appendReport(event, entry);

  var reports = await moderationStore.getReports(event);
  var matching = reports.filter(function (r) { return r.id === 'fixed-test-report-id-123'; });
  assert.equal(matching.length, 1, 'the same entry id must be persisted exactly once, never duplicated by a retry');
});

// ===== get-moderation-reports.js =====

test('get-moderation-reports: the owner can read back everything filed; a non-owner (or no email) is forbidden', function () {
  return withEnv(ENV, async function () {
    var reportHandler = require('../netlify/functions/report-dream').handler;
    await reportHandler(fakeEvent({ method: 'POST', ip: '4.4.4.1', body: { dreamId: 'd-reader-test', reason: 'read me back' } }));

    var getHandler = require('../netlify/functions/get-moderation-reports').handler;

    var ownerRes = await getHandler(fakeEvent({ method: 'GET', query: { email: ' Founder@DreamTube.example ' } }));
    assert.equal(ownerRes.statusCode, 200);
    var ownerBody = JSON.parse(ownerRes.body);
    assert.equal(ownerBody.reports.length, 1);
    assert.equal(ownerBody.reports[0].reason, 'read me back');

    var strangerRes = await getHandler(fakeEvent({ method: 'GET', query: { email: 'someone-else@example.com' } }));
    assert.equal(strangerRes.statusCode, 403);
    assert.match(JSON.parse(strangerRes.body).error, /^E3: forbidden/);

    var noEmailRes = await getHandler(fakeEvent({ method: 'GET' }));
    assert.equal(noEmailRes.statusCode, 403);
  });
});

test('get-moderation-reports: rejects with 500 when OWNER_EMAIL is not configured, and 405 on a non-GET method', function () {
  return withEnv({ OWNER_EMAIL: undefined }, async function () {
    var getHandler = require('../netlify/functions/get-moderation-reports').handler;
    var res = await getHandler(fakeEvent({ method: 'GET', query: { email: 'anyone@example.com' } }));
    assert.equal(res.statusCode, 500);
    assert.match(JSON.parse(res.body).error, /^E2: missing_owner_email/);
  });
});

test('get-moderation-reports: rejects a non-GET method with 405', function () {
  return withEnv(ENV, async function () {
    var getHandler = require('../netlify/functions/get-moderation-reports').handler;
    var res = await getHandler(fakeEvent({ method: 'POST', body: {} }));
    assert.equal(res.statusCode, 405);
    assert.match(JSON.parse(res.body).error, /^E1: method_not_allowed/);
  });
});
