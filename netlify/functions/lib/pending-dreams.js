// netlify/functions/lib/pending-dreams.js
//
// Blobs-backed record of a dream-builder-wizard generation started BEFORE
// (or without) a completed signup — see start-pending-generation.js
// (creates these), dream-webhook.js (fal.ai's completion callback resolves
// them), claim-pending-generation.js (marks one claimed the instant a real
// signup completes, so the webhook's "your dream is ready" email never
// double-sends to someone who's already back in the app), and
// verify-pending-claim.js (lets claim-dream.html read a ready one back by
// its claim token). This is the durable, cross-device record of "a video
// this browser tab might never come back to see finish" — see
// dream-webhook.js's header comment for why a server-side record is
// unavoidable here (this codebase deliberately has no cron/scheduled-
// function infrastructure, see lib/entitlements.js's own note on that; the
// event-driven fix is fal's webhook, not polling).
//
// Backed by a single Netlify Blobs store ("dreamtube-pending-dreams"), one
// record per pending id, same "one small store, existence-check-then-write"
// shape every other Blobs store in this codebase already uses (see
// lib/account-store.js's header comment for the accepted-race reasoning —
// identical here: two near-simultaneous writes to the SAME pending id are
// not expected in practice, since only one caller (start-pending-
// generation.js) ever creates a given id and every later writer targets
// exactly that id with a small, idempotent patch).
//
// Record shape:
//   {
//     id, email, whatsapp (optional), caption, style,
//     characterIdsForGeneration, cameraView, sceneryTime, sceneryPlace,
//     operationName, status: 'pending'|'ready'|'notified'|'claimed'|'failed',
//     videoUrl, createdAt, readyAt, notifiedAt, claimedAt, failedReason
//   }

var { getStore, connectLambda } = require('@netlify/blobs');
var crypto = require('crypto');

var STORE_NAME = 'dreamtube-pending-dreams';

function store() {
  return getStore({ name: STORE_NAME });
}

function newId() {
  return 'pd' + crypto.randomBytes(12).toString('hex');
}

/** Creates a new pending-dream record in 'pending' status. Returns the full record (including its new id). */
async function create(event, data) {
  connectLambda(event);
  var id = newId();
  var record = {
    id: id,
    email: (data.email || '').trim().toLowerCase(),
    whatsapp: data.whatsapp || null,
    caption: data.caption || '',
    style: data.style || '',
    characterIdsForGeneration: Array.isArray(data.characterIdsForGeneration) ? data.characterIdsForGeneration : [],
    cameraView: data.cameraView || null,
    sceneryTime: data.sceneryTime || null,
    sceneryPlace: data.sceneryPlace || null,
    operationName: data.operationName || null,
    status: 'pending',
    videoUrl: null,
    createdAt: Date.now(),
    readyAt: null,
    notifiedAt: null,
    claimedAt: null,
    failedReason: null
  };
  await store().setJSON(id, record);
  return record;
}

async function get(event, id) {
  if (!id) return null;
  connectLambda(event);
  return (await store().get(id, { type: 'json' })) || null;
}

/** Merges `patch` onto the existing record (if any) and re-stamps `status`/timestamps as given. No-ops (returns null) if the record doesn't exist — a webhook/claim call for an unknown/already-cleaned-up id is treated as a harmless no-op by every caller, not an error. */
async function update(event, id, patch) {
  connectLambda(event);
  var s = store();
  var existing = await s.get(id, { type: 'json' });
  if (!existing) return null;
  var record = Object.assign({}, existing, patch);
  await s.setJSON(id, record);
  return record;
}

async function markReady(event, id, videoUrl) {
  return update(event, id, { status: 'ready', videoUrl: videoUrl, readyAt: Date.now() });
}

async function markNotified(event, id) {
  return update(event, id, { status: 'notified', notifiedAt: Date.now() });
}

/** Called the instant a real signup completes for the same email that started this pending generation — see claim-pending-generation.js. Idempotent: claiming an already-claimed (or already-notified) record is harmless. */
async function markClaimed(event, id) {
  return update(event, id, { status: 'claimed', claimedAt: Date.now() });
}

async function markFailed(event, id, reason) {
  return update(event, id, { status: 'failed', failedReason: reason || 'unknown' });
}

module.exports = { STORE_NAME, create, get, update, markReady, markNotified, markClaimed, markFailed };
