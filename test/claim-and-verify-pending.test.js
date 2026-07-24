// test/claim-and-verify-pending.test.js
//
// Covers netlify/functions/claim-pending-generation.js (marks a pending
// dream 'claimed' the instant a real signup completes, so
// dream-webhook.js skips the re-engagement email) and
// netlify/functions/verify-pending-claim.js (claim-dream.html's read-only
// token check, for the abandoned-dream re-engagement email's link).

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var pendingDreams = require('../netlify/functions/lib/pending-dreams');
var pendingDreamToken = require('../netlify/functions/lib/pending-dream-token');
var claimHandler = require('../netlify/functions/claim-pending-generation').handler;
var verifyHandler = require('../netlify/functions/verify-pending-claim').handler;

test.beforeEach(function () {
  mockBlobs.reset();
});

// ----- claim-pending-generation.js -----

test('claim: wrong method -> E1', async function () {
  var res = await claimHandler(fakeEvent({ method: 'GET' }));
  assert.equal(res.statusCode, 405);
});

test('claim: missing pendingId -> E3', async function () {
  var res = await claimHandler(fakeEvent({ method: 'POST', body: {} }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E3:/);
});

test('claim: marks a real pending record claimed', async function () {
  var record = await pendingDreams.create({}, { email: 'a@example.com', caption: 'x', style: 'Cartoon' });
  var res = await claimHandler(fakeEvent({ method: 'POST', body: { pendingId: record.id } }));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).found, true);
  var updated = await pendingDreams.get({}, record.id);
  assert.equal(updated.status, 'claimed');
});

test('claim: an unknown pendingId is a harmless no-op, not an error', async function () {
  var res = await claimHandler(fakeEvent({ method: 'POST', body: { pendingId: 'nope' } }));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).found, false);
});

// ----- verify-pending-claim.js -----

test('verify: wrong method -> E1', async function () {
  var res = await verifyHandler(fakeEvent({ method: 'GET' }));
  assert.equal(res.statusCode, 405);
});

test('verify: missing pendingId/token -> E3', async function () {
  var res = await verifyHandler(fakeEvent({ method: 'POST', body: {} }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E3:/);
});

test('verify: invalid/unknown token -> ok:false E4', async function () {
  var res = await verifyHandler(fakeEvent({ method: 'POST', body: { pendingId: 'pd1', token: 'not-a-real-token' } }));
  assert.equal(res.statusCode, 200);
  var data = JSON.parse(res.body);
  assert.equal(data.ok, false);
  assert.match(data.error, /^E4:/);
});

test('verify: a valid token for a record that is not yet ready -> ok:false E5 (not_ready)', async function () {
  var record = await pendingDreams.create({}, { email: 'a@example.com', caption: 'x', style: 'Cartoon' });
  var token = await pendingDreamToken.createToken({}, record.id);
  var res = await verifyHandler(fakeEvent({ method: 'POST', body: { pendingId: record.id, token: token } }));
  var data = JSON.parse(res.body);
  assert.equal(data.ok, false);
  assert.match(data.error, /^E5:/);
});

test('verify: a valid token for a ready record returns the public-safe fields', async function () {
  var record = await pendingDreams.create({}, { email: 'watcher@example.com', caption: 'a finished dream', style: 'Anime' });
  await pendingDreams.markReady({}, record.id, 'https://cdn.fal/finished.mp4');
  var token = await pendingDreamToken.createToken({}, record.id);

  var res = await verifyHandler(fakeEvent({ method: 'POST', body: { pendingId: record.id, token: token } }));
  var data = JSON.parse(res.body);
  assert.equal(data.ok, true);
  assert.equal(data.email, 'watcher@example.com');
  assert.equal(data.caption, 'a finished dream');
  assert.equal(data.style, 'Anime');
  assert.equal(data.videoUrl, 'https://cdn.fal/finished.mp4');
  assert.equal(data.status, 'ready');
});

test('verify: the token is NOT single-use — revisiting the same email link later still works (peek, not consume)', async function () {
  var record = await pendingDreams.create({}, { email: 'revisit@example.com', caption: 'x', style: 'Cartoon' });
  await pendingDreams.markReady({}, record.id, 'https://cdn.fal/v.mp4');
  var token = await pendingDreamToken.createToken({}, record.id);

  var first = await verifyHandler(fakeEvent({ method: 'POST', body: { pendingId: record.id, token: token } }));
  assert.equal(JSON.parse(first.body).ok, true);
  var second = await verifyHandler(fakeEvent({ method: 'POST', body: { pendingId: record.id, token: token } }));
  assert.equal(JSON.parse(second.body).ok, true);
});

test('verify: a token minted for one pendingId cannot be used to claim a different pendingId', async function () {
  var recordA = await pendingDreams.create({}, { email: 'a@example.com', caption: 'a', style: 'Cartoon' });
  var recordB = await pendingDreams.create({}, { email: 'b@example.com', caption: 'b', style: 'Cartoon' });
  await pendingDreams.markReady({}, recordA.id, 'https://cdn.fal/a.mp4');
  await pendingDreams.markReady({}, recordB.id, 'https://cdn.fal/b.mp4');
  var tokenForA = await pendingDreamToken.createToken({}, recordA.id);

  var res = await verifyHandler(fakeEvent({ method: 'POST', body: { pendingId: recordB.id, token: tokenForA } }));
  var data = JSON.parse(res.body);
  assert.equal(data.ok, false);
  assert.match(data.error, /^E4:/);
});
