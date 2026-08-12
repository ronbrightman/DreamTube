// test/interp-unread-nudge-enqueue.test.js
//
// Covers the ENQUEUE side of the AUTOMATIC flagship "Unread meanings"
// interpretation retention email (founder-approved 2026-08-12): interpret-
// dream.js's maybeEnqueueInterpUnreadCandidate. This is the integration between
// interpret-dream.js, lib/job-owners.js, lib/account-store.js, and lib/interp-
// unread-queue-store.js — deliberately separate from test/send-interp-unread-
// nudges.test.js (the DOWNSTREAM decide-and-send half).
//
// Proves: a signed-up user's FIRST reading on a video dream enqueues a pending
// "unread" candidate keyed by operationName; a reading that resolves to NO
// registered account (a pre-signup visitor) does NOT (signed-up users only); an
// IMAGE job does NOT (video-only scope); a reading with no job-owner record does
// NOT; a SECOND reading on the same dream does NOT reset the firstReadAt clock
// (idempotent enqueue); AND a full mode:"reading" call through the real handler
// (with a stubbed LLM) enqueues end-to-end. Run with: node --test test/
//
// SANDBOX LIMITATION: no real Blobs (mock-blobs stands in) and fal.ai/
// OpenRouter is stubbed via a fake global.fetch — this proves the enqueue
// decision + record shape + the handler wiring, not real cross-region Blobs
// behavior or a real model call.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var { markInstalledFetchAsTestDouble } = require('./helpers/fetch-double');

var realFetch = global.fetch;
var ipCounter = 0;
function nextIp() { ipCounter += 1; return '10.41.0.' + ipCounter; }

/** A plausible, well-over-MIN_VALID_LENGTH reading, standing in for a real model completion. */
var SAMPLE_READING = 'Dreams about flying often echo a wish for freedom or a release from something weighing on you. What might your dream be reflecting back to you about how you have been feeling lately? May this reading turn your dream toward the good.';

/** PostHog capture (best-effort) must not throw on an unexpected fetch; the fal.ai LLM call returns a valid reading. */
function installBenignFetchSpy() {
  global.fetch = async function (url) {
    var urlStr = String(url);
    if (urlStr.indexOf('/capture/') !== -1) return { ok: true, status: 200, json: async function () { return {}; } };
    if (urlStr.indexOf('fal.run') !== -1 || urlStr.indexOf('fal.ai') !== -1) {
      return { ok: true, status: 200, json: async function () { return { choices: [{ message: { role: 'assistant', content: SAMPLE_READING } }] }; } };
    }
    throw new Error('unexpected fetch to ' + urlStr);
  };
  markInstalledFetchAsTestDouble();
}

test.beforeEach(function () {
  global.fetch = realFetch;
  mockBlobs.reset();
  delete require.cache[require.resolve('../netlify/functions/interpret-dream')];
  delete require.cache[require.resolve('../netlify/functions/register-account')];
  delete require.cache[require.resolve('../netlify/functions/lib/account-store')];
  delete require.cache[require.resolve('../netlify/functions/lib/job-owners')];
  delete require.cache[require.resolve('../netlify/functions/lib/interp-unread-queue-store')];
  delete require.cache[require.resolve('../netlify/functions/lib/rate-limit')];
  delete process.env.MAX_INTERPRETATIONS_PER_IP_PER_DAY;
  process.env.FAL_KEY = 'test-fal-key';
  installBenignFetchSpy();
});
test.after(function () {
  global.fetch = realFetch;
  delete process.env.FAL_KEY;
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

/** Drive the exported enqueue helper directly (the branch logic, isolated from the LLM path). */
function enqueue(operationName) {
  var maybeEnqueue = require('../netlify/functions/interpret-dream').maybeEnqueueInterpUnreadCandidate;
  return maybeEnqueue(fakeEvent({ method: 'POST' }), operationName);
}

async function pendingUnread(operationName) {
  var queueStore = require('../netlify/functions/lib/interp-unread-queue-store');
  return queueStore.getPending(fakeEvent({}), operationName);
}

test('a signed-up user\'s FIRST reading on a video dream ENQUEUES a pending "unread" candidate', async function () {
  await registerAccount('unreaduser', 'unreaduser@sample.io');
  var op = 'mock:1:unread-enqueue-1';
  await seedJobOwner(op, 'unreaduser@sample.io', 'video');

  await enqueue(op);

  var record = await pendingUnread(op);
  assert.ok(record, 'a pending "unread" candidate must be enqueued on the first reading');
  assert.equal(record.operationName, op);
  assert.equal(record.username, 'unreaduser');
  assert.equal(record.email, 'unreaduser@sample.io');
  assert.equal(typeof record.firstReadAt, 'number');
});

test('a reading with NO registered account (a pre-signup visitor) does NOT enqueue — signed-up users only', async function () {
  var op = 'mock:1:unread-noacct';
  await seedJobOwner(op, 'stranger@sample.io', 'video'); // never registered

  await enqueue(op);
  assert.equal(await pendingUnread(op), null, 'no account -> no candidate');
});

test('an IMAGE job does NOT enqueue — video-only scope', async function () {
  await registerAccount('imgunread', 'imgunread@sample.io');
  var op = 'mock:1:unread-img';
  await seedJobOwner(op, 'imgunread@sample.io', 'image');

  await enqueue(op);
  assert.equal(await pendingUnread(op), null, 'image media type -> no candidate');
});

test('a reading with NO job-owner record does NOT enqueue (owner cannot be resolved)', async function () {
  await registerAccount('noowner-u', 'noowner-u@sample.io');
  var op = 'mock:1:unread-noowner';
  // No seedJobOwner call.
  await enqueue(op);
  assert.equal(await pendingUnread(op), null, 'no owner record -> no candidate');
});

test('a SECOND reading on the same dream does NOT reset the firstReadAt clock (idempotent enqueue)', async function () {
  await registerAccount('reread', 'reread@sample.io');
  var op = 'mock:1:unread-reread';
  await seedJobOwner(op, 'reread@sample.io', 'video');

  await enqueue(op);
  var first = await pendingUnread(op);
  assert.ok(first, 'first reading enqueues');
  var firstReadAt = first.firstReadAt;

  // A moment later, the user opens a SECOND reading on the SAME dream.
  await new Promise(function (r) { setTimeout(r, 5); });
  await enqueue(op);
  var second = await pendingUnread(op);
  assert.ok(second, 'still enqueued');
  assert.equal(second.firstReadAt, firstReadAt, 'a second reading must NOT push the ~next-day clock forward (onlyIfNew CAS)');
});

test('a full mode:"reading" call through the real handler ENQUEUES end-to-end', async function () {
  await registerAccount('e2euser', 'e2euser@sample.io');
  var op = 'mock:1:unread-e2e';
  await seedJobOwner(op, 'e2euser@sample.io', 'video');

  var handler = require('../netlify/functions/interpret-dream').handler;
  var res = await handler(fakeEvent({
    method: 'POST', ip: nextIp(),
    body: { caption: 'I was flying over my childhood home', personaKey: 'jung', mode: 'reading', qa: [], operationName: op }
  }));
  assert.equal(res.statusCode, 200, 'the reading itself succeeds');
  assert.ok(JSON.parse(res.body).interpretation, 'a reading came back');

  var record = await pendingUnread(op);
  assert.ok(record, 'the reading also enqueued a pending "unread" candidate');
  assert.equal(record.username, 'e2euser');
});
