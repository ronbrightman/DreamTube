// test/interp-none-nudge-enqueue.test.js
//
// Covers the ENQUEUE side of the AUTOMATIC "No meaning yet" interpretation
// retention email (founder-approved 2026-08-12): mark-result-viewed.js's
// maybeEnqueueInterpNoneCandidate. This is the integration between
// mark-result-viewed.js, lib/job-owners.js, lib/account-store.js, and
// lib/interp-none-queue-store.js — deliberately separate from
// test/send-interp-none-nudges.test.js (the DOWNSTREAM decide-and-send half).
//
// Proves: a signed-up user's WATCH of a video dream enqueues a pending "none"
// candidate keyed by operationName; a watch that resolves to NO registered
// account (a pre-signup visitor) does NOT (signed-up users only); an IMAGE
// job does NOT (video-only scope); a watch with no job-owner record does NOT;
// and a re-watch of the same dream does NOT reset the watchedAt clock
// (idempotent enqueue). Run with: node --test test/
//
// SANDBOX LIMITATION: no real Blobs (mock-blobs stands in) — this proves the
// enqueue decision + record shape, not real cross-region Blobs behavior.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var { markInstalledFetchAsTestDouble } = require('./helpers/fetch-double');

var realFetch = global.fetch;
var ipCounter = 0;
function nextIp() { ipCounter += 1; return '10.40.0.' + ipCounter; }

/** PostHog capture (best-effort, from register-account) must not throw on an unexpected fetch — swallow it. */
function installBenignFetchSpy() {
  global.fetch = async function (url) {
    var urlStr = String(url);
    if (urlStr.indexOf('/capture/') !== -1) return { ok: true, status: 200, json: async function () { return {}; } };
    throw new Error('unexpected fetch to ' + urlStr);
  };
  markInstalledFetchAsTestDouble();
}

test.beforeEach(function () {
  global.fetch = realFetch;
  mockBlobs.reset();
  delete require.cache[require.resolve('../netlify/functions/mark-result-viewed')];
  delete require.cache[require.resolve('../netlify/functions/register-account')];
  delete require.cache[require.resolve('../netlify/functions/lib/account-store')];
  delete require.cache[require.resolve('../netlify/functions/lib/job-owners')];
  delete require.cache[require.resolve('../netlify/functions/lib/interp-none-queue-store')];
  delete require.cache[require.resolve('../netlify/functions/lib/rate-limit')];
  delete process.env.MAX_RESULT_VIEW_MARKS_PER_IP_PER_DAY;
  installBenignFetchSpy();
});
test.after(function () {
  global.fetch = realFetch;
});

async function registerAccount(username, email) {
  var registerHandler = require('../netlify/functions/register-account').handler;
  var res = await registerHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { username: username, password: 'realpassword1', email: email } }));
  assert.equal(JSON.parse(res.body).ok, true, 'test setup: registration should succeed');
}

async function seedJobOwner(operationName, email, mediaType) {
  var jobOwners = require('../netlify/functions/lib/job-owners');
  await jobOwners.recordJobOwner(fakeEvent({ method: 'POST' }), operationName, email, mediaType);
}

function watch(operationName) {
  var handler = require('../netlify/functions/mark-result-viewed').handler;
  return handler(fakeEvent({ method: 'POST', ip: nextIp(), headers: { host: 'dreamtube1.netlify.app' }, body: { operationName: operationName } }));
}

async function pendingNone(operationName) {
  var queueStore = require('../netlify/functions/lib/interp-none-queue-store');
  return queueStore.getPending(fakeEvent({}), operationName);
}

test('a signed-up user\'s WATCH of a video dream ENQUEUES a pending "none" candidate', async function () {
  await registerAccount('noneuser', 'noneuser@sample.io');
  var op = 'mock:1:none-enqueue-1';
  await seedJobOwner(op, 'noneuser@sample.io', 'video');

  var res = await watch(op);
  assert.equal(res.statusCode, 200);

  var record = await pendingNone(op);
  assert.ok(record, 'a pending "none" candidate must be enqueued on watch');
  assert.equal(record.operationName, op);
  assert.equal(record.username, 'noneuser');
  assert.equal(record.email, 'noneuser@sample.io');
  assert.equal(typeof record.watchedAt, 'number');
});

test('a WATCH with NO registered account (a pre-signup visitor) does NOT enqueue — signed-up users only', async function () {
  var op = 'mock:1:none-noacct';
  await seedJobOwner(op, 'stranger@sample.io', 'video'); // never registered

  var res = await watch(op);
  assert.equal(res.statusCode, 200);
  assert.equal(await pendingNone(op), null, 'no account -> no candidate');
});

test('an IMAGE job does NOT enqueue — video-only scope', async function () {
  await registerAccount('imgnone', 'imgnone@sample.io');
  var op = 'mock:1:none-img';
  await seedJobOwner(op, 'imgnone@sample.io', 'image');

  await watch(op);
  assert.equal(await pendingNone(op), null, 'image media type -> no candidate');
});

test('a WATCH with NO job-owner record does NOT enqueue (owner cannot be resolved)', async function () {
  await registerAccount('noowner-n', 'noowner-n@sample.io');
  var op = 'mock:1:none-noowner';
  // No seedJobOwner call.
  await watch(op);
  assert.equal(await pendingNone(op), null, 'no owner record -> no candidate');
});

test('a RE-WATCH of the same dream does NOT reset the watchedAt clock (idempotent enqueue)', async function () {
  await registerAccount('rewatch', 'rewatch@sample.io');
  var op = 'mock:1:none-rewatch';
  await seedJobOwner(op, 'rewatch@sample.io', 'video');

  await watch(op);
  var first = await pendingNone(op);
  assert.ok(first, 'first watch enqueues');
  var firstWatchedAt = first.watchedAt;

  // A moment later, the user watches the SAME dream again.
  await new Promise(function (r) { setTimeout(r, 5); });
  await watch(op);
  var second = await pendingNone(op);
  assert.ok(second, 'still enqueued');
  assert.equal(second.watchedAt, firstWatchedAt, 're-watch must NOT push the ~10-min clock forward (onlyIfNew CAS)');
});
