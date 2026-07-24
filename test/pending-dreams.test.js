// test/pending-dreams.test.js
//
// Unit coverage of netlify/functions/lib/pending-dreams.js — the durable,
// server-side record of a dream-builder-wizard generation started before
// (or without) a completed signup (see start-pending-generation.js,
// dream-webhook.js, claim-pending-generation.js, verify-pending-claim.js).

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var pendingDreams = require('../netlify/functions/lib/pending-dreams');

test.beforeEach(function () {
  mockBlobs.reset();
});

test('create() returns a fresh record in "pending" status with a real id', async function () {
  var record = await pendingDreams.create({}, { email: 'Person@Example.com ', caption: 'a dream', style: 'Cinematic' });
  assert.ok(record.id);
  assert.equal(record.status, 'pending');
  assert.equal(record.email, 'person@example.com'); // normalized
  assert.equal(record.videoUrl, null);
  assert.equal(record.operationName, null);
});

test('get() round-trips a created record; returns null for an unknown id', async function () {
  var created = await pendingDreams.create({}, { email: 'a@example.com', caption: 'x', style: 'Cartoon' });
  var fetched = await pendingDreams.get({}, created.id);
  assert.deepEqual(fetched, created);
  assert.equal(await pendingDreams.get({}, 'not-a-real-id'), null);
});

test('update() merges a patch onto an existing record; no-ops (returns null) for an unknown id', async function () {
  var created = await pendingDreams.create({}, { email: 'a@example.com', caption: 'x', style: 'Cartoon' });
  var updated = await pendingDreams.update({}, created.id, { operationName: 'fal:model:req123' });
  assert.equal(updated.operationName, 'fal:model:req123');
  assert.equal(updated.status, 'pending'); // untouched fields survive the merge

  assert.equal(await pendingDreams.update({}, 'unknown', { operationName: 'x' }), null);
});

test('markReady / markNotified / markClaimed / markFailed transition status and stamp their own timestamp', async function () {
  var created = await pendingDreams.create({}, { email: 'a@example.com', caption: 'x', style: 'Cartoon' });

  var ready = await pendingDreams.markReady({}, created.id, 'https://cdn.example/video.mp4');
  assert.equal(ready.status, 'ready');
  assert.equal(ready.videoUrl, 'https://cdn.example/video.mp4');
  assert.ok(ready.readyAt);

  var notified = await pendingDreams.markNotified({}, created.id);
  assert.equal(notified.status, 'notified');
  assert.ok(notified.notifiedAt);
  // videoUrl from the earlier step survives -- update() merges, not replaces.
  assert.equal(notified.videoUrl, 'https://cdn.example/video.mp4');

  var claimed = await pendingDreams.markClaimed({}, created.id);
  assert.equal(claimed.status, 'claimed');
  assert.ok(claimed.claimedAt);

  var other = await pendingDreams.create({}, { email: 'b@example.com', caption: 'y', style: 'Anime' });
  var failed = await pendingDreams.markFailed({}, other.id, 'E105: content_policy');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failedReason, 'E105: content_policy');
});

test('characterIdsForGeneration/cameraView/sceneryTime/sceneryPlace/whatsapp all round-trip when provided', async function () {
  var record = await pendingDreams.create({}, {
    email: 'a@example.com', whatsapp: '+15551234567', caption: 'x', style: 'Cartoon',
    characterIdsForGeneration: ['c1'], cameraView: 'POV', sceneryTime: 'Night', sceneryPlace: 'Urban'
  });
  assert.deepEqual(record.characterIdsForGeneration, ['c1']);
  assert.equal(record.whatsapp, '+15551234567');
  assert.equal(record.cameraView, 'POV');
  assert.equal(record.sceneryTime, 'Night');
  assert.equal(record.sceneryPlace, 'Urban');
});
