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
// Record shape:
//   {
//     id, email, whatsapp (optional), caption, style,
//     characterIdsForGeneration, cameraView, sceneryTime, sceneryPlace,
//     mediaType: 'video'|'image' (default 'video' — see below),
//     operationName, status: 'pending'|'ready'|'notified'|'claimed'|'failed',
//     videoUrl, imageUrl, createdAt, readyAt, notifiedAt, claimedAt, failedReason
//   }
//
// mediaType/imageUrl were added for style.html's image-vs-video picker (see
// start-pending-generation.js and docs/IMAGE_GENERATION_SPEC.md) — default
// 'video'/null respectively so every existing caller/record that predates
// these fields (in particular wizard.html's own pre-signup flow, which is
// deliberately unchanged and never passes mediaType at all — see
// IMAGE_GENERATION_SPEC.md §6-revised) keeps working exactly as before.
// videoUrl/imageUrl are independent fields — a 'video' record only ever
// populates videoUrl, an 'image' record only ever populates imageUrl (there
// is currently no server-side "turn this into a video" path that upgrades a
// pending-dreams record in place; that upsell — see js/store.js's
// turnImageIntoVideo — operates on a real dream.id after the pending record
// has already resolved into one, not on the pending record itself).
//
// ============================================================================
// CONCURRENT-WRITE RACE (fixed per review — was a real TOCTOU bug, not a
// hypothetical) — markReady/markNotified/markClaimed below
// ----------------------------------------------------------------------------
// A generation started via start-pending-generation.js can take 1-6 minutes
// (this codebase's own documented Veo range) — plenty of real wall-clock
// time for a user to finish signing up (-> claim-pending-generation.js's
// markClaimed) at very nearly the same moment fal's completion webhook
// fires (-> dream-webhook.js's markReady/markNotified). Both are writes to
// the SAME record, and the installed @netlify/blobs SDK has no compare-
// and-swap (same limitation documented in lib/account-store.js, lib/
// tracker-store.js, lib/entitlements.js). An earlier version of
// markReady/markClaimed here did a plain read -> Object.assign(patch) ->
// write, each independently, with no way for a CALLER to know whether its
// own write was the one that actually ended up persisted. Confirmed live
// (reproduced under `node --test` with a real Promise.all race before
// this fix): racing markReady() against markClaimed() on the same fresh
// record, markReady() returned a record claiming `status: "ready"` — its
// OWN locally-computed patch — while the actually-persisted record (per a
// fresh get() right after) was `status: "claimed"`, because markClaimed's
// write happened to land last. A caller (dream-webhook.js) that trusted
// markReady's *return value* as "safe to proceed" would send the
// abandoned-dream re-engagement email to someone who had just completed
// signup normally — exactly the bug class already fixed once in this
// codebase for entitlements.js's creditTokenPackOnce (Dodo Payments token
// crediting), which this adapts:
//
// tryTransition(event, id, fromStatuses, toStatus, patch) below writes a
// fresh random claim marker alongside the patch, then immediately reads
// the key back. Only the call whose marker is STILL the one visible at
// verify-time returns `ok: true` — every other concurrent (or merely
// stale) caller gets `ok: false` and MUST NOT perform whatever side
// effect it was gating (sending an email, crediting tokens, etc.).
// Bounded retries (MAX_TRANSITION_ATTEMPTS), same "fails closed on
// exhaustion, narrows the race window but doesn't claim to eliminate it
// down to zero" posture as tracker-store.js's writeItemsWithRetry and
// entitlements.js's creditTokenPackOnce — see those files' own comments
// for the same accepted-residual reasoning, which applies here
// identically. See test/pending-dreams.test.js's concurrency tests for
// direct Promise.all coverage, and test/dream-webhook.test.js for the
// end-to-end "a claim landing concurrently with the webhook must
// suppress the email" regression test.
// ============================================================================

var { getStore, connectLambda } = require('@netlify/blobs');
var crypto = require('crypto');
var blobsRetry = require('./blobs-retry');

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
    mediaType: data.mediaType === 'image' ? 'image' : 'video',
    operationName: data.operationName || null,
    status: 'pending',
    videoUrl: null,
    imageUrl: null,
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

/**
 * Merges `patch` onto the existing record with NO transition/race
 * protection at all — no-ops (returns null) if the record doesn't exist.
 * Only safe to use for bookkeeping-only patches that gate no side effect
 * and don't need to move `status` (e.g. attaching a videoUrl to a record
 * that's already reached a terminal state some other way) — anything
 * that decides whether to send an email/credit/notify MUST go through
 * tryTransition below instead. See the CONCURRENT-WRITE RACE comment
 * above for why a plain read-then-write here is unsafe for anything
 * side-effect-gating.
 */
async function update(event, id, patch) {
  connectLambda(event);
  var s = store();
  var existing = await s.get(id, { type: 'json' });
  if (!existing) return null;
  var record = Object.assign({}, existing, patch);
  await s.setJSON(id, record);
  return record;
}

var MAX_TRANSITION_ATTEMPTS = 3;

/**
 * The single safe way to move a record from one of `fromStatuses` to
 * `toStatus` while racing a concurrent writer — see the CONCURRENT-WRITE
 * RACE comment at the top of this file for the full incident this fixes
 * and the precedent it adapts (entitlements.js's creditTokenPackOnce /
 * tracker-store.js's writeItemsWithRetry). The actual read -> mutate ->
 * write -> verify mechanics live in the shared lib/blobs-retry.js
 * (extracted once a fourth store reimplemented this same pattern — see
 * that file's own header comment) — this stays a thin domain-specific
 * wrapper: "mutate" bails out (SKIP) once the record's current status is
 * no longer one this call expects, otherwise it builds the patched
 * record plus a fresh claim marker; "verify" confirms THIS attempt's
 * marker is the one actually visible.
 *
 * Each attempt: read the record fresh, bail out immediately (no write at
 * all) if its CURRENT status isn't one of `fromStatuses` (someone else
 * already moved it past the state this call expects), otherwise write
 * `patch` + the new status + a fresh random `_transitionClaim` marker,
 * then immediately read the key back. Only if the read-back record's
 * marker still matches the one THIS attempt just wrote does this call
 * "own" the transition (`ok: true`) — a different marker means another
 * writer's attempt is the one actually persisted, so this call backs off
 * (without mutating anything further) and retries against a fresh read,
 * up to MAX_TRANSITION_ATTEMPTS.
 *
 * Returns { ok: true, record } if THIS call's write won — callers MUST
 * treat `ok: true` as the only trustworthy "safe to perform my side
 * effect" signal, never a status value read/computed earlier. Returns
 * { ok: false, record } otherwise, where `record` is whatever this call
 * last actually observed (or `null` if no record exists at all) — useful
 * for a caller that still wants to inspect the current state (e.g. "was
 * it claimed?") without being allowed to treat that as a green light.
 */
async function tryTransition(event, id, fromStatuses, toStatus, patch) {
  var claimToken; // set fresh inside mutate() on whichever attempt actually writes

  var result = await blobsRetry.retryingWrite(event, STORE_NAME, id, {
    maxAttempts: MAX_TRANSITION_ATTEMPTS,
    read: function (evt) {
      connectLambda(evt);
      return store().get(id, { type: 'json' }).then(function (v) { return v || null; });
    },
    mutate: function (existing) {
      // Not found, or already moved past a state this call expected —
      // either a concurrent writer got there first, or a previous
      // attempt of ours already succeeded and this is a false-negative-
      // triggered retry. Either way, this is terminal: nothing for THIS
      // call to do, and retrying won't change it. See blobs-retry.js's
      // SKIP doc comment.
      if (!existing) return blobsRetry.SKIP;
      if (fromStatuses.indexOf(existing.status) === -1) return blobsRetry.SKIP;

      claimToken = crypto.randomBytes(12).toString('hex');
      return Object.assign({}, existing, patch, { status: toStatus, _transitionClaim: claimToken });
    },
    verify: function (verifyRead) {
      return !!(verifyRead && verifyRead._transitionClaim === claimToken);
    }
  });

  if (result.ok) return { ok: true, record: result.value };
  return { ok: false, record: result.current };
}

/**
 * Attempts to move a record into 'ready' (attaching videoUrl/readyAt) —
 * the FIRST half of dream-webhook.js's success path, and the one gate
 * that decides whether sending the re-engagement email is safe. Allowed
 * from 'pending' (the common case) or 'ready' itself (an idempotent
 * re-entry — e.g. a crashed prior invocation that transitioned but never
 * got to actually send, on a real fal webhook redelivery). NOT allowed
 * from 'claimed'/'notified'/'failed' — see the module header comment.
 * Returns { ok, record } — see tryTransition's own doc comment; callers
 * MUST only send the email when ok is true.
 */
async function markReady(event, id, videoUrl) {
  return tryTransition(event, id, ['pending', 'ready'], 'ready', { videoUrl: videoUrl, readyAt: Date.now() });
}

/**
 * The SECOND half of dream-webhook.js's success path, called only after
 * the email has actually been sent (i.e. only after markReady returned
 * ok: true). Allowed only from 'ready' — if a concurrent claim landed in
 * the (now much narrower) window between the two, this simply fails
 * (ok: false) and the record correctly stays 'claimed' rather than being
 * incorrectly downgraded back to 'notified'. That's fine: the email
 * decision was already correctly made by markReady's own guarantee, and
 * this second call is purely a bookkeeping transition, not a second
 * side-effect gate.
 */
async function markNotified(event, id) {
  return tryTransition(event, id, ['ready'], 'notified', { notifiedAt: Date.now() });
}

/**
 * Called the instant a real signup completes for the same email that
 * started this pending generation — see claim-pending-generation.js.
 * Allowed from 'pending' (the common case) or 'notified' (claiming after
 * the re-engagement email already fully went out is still meaningful
 * bookkeeping — the user came back on their own either way); NOT allowed
 * once already 'claimed'/'failed' (harmless no-ops, ok: false).
 *
 * Deliberately NOT allowed from 'ready' — a real Promise.all concurrency
 * test (see test/pending-dreams.test.js) caught a genuine gap here: 'ready'
 * is the brief, ephemeral state dream-webhook.js's own markReady/
 * markNotified pair straddles while actually sending the re-engagement
 * email (a real network round trip to Resend/WhatsApp). If markClaimed
 * were allowed to succeed from 'ready', a claim landing in exactly that
 * window would legitimately transition ready -> claimed — and markReady's
 * OWN earlier ok:true (correctly decided at ITS read instant, before the
 * claim existed) would have ALREADY triggered the email send — producing
 * precisely the reviewed bug (both the normal signup experience AND an
 * unwanted email), even though neither individual transition was
 * "wrong" in isolation. Excluding 'ready' here closes that combined
 * outcome: once dream-webhook.js has moved a record into 'ready', ANY
 * claim attempt racing into that narrow window now correctly fails
 * (ok: false) instead of silently succeeding — the only cost is not
 * recording the 'claimed' bookkeeping label for the rare claim that lands
 * in that specific few-hundred-ms-to-low-seconds window, which has no
 * user-visible consequence (the send decision the label exists to gate
 * is already made by then; the user's own real DreamStore.signup() is
 * entirely independent of this server-side bookkeeping flag).
 *
 * `expectedEmail`, if provided, is an OWNERSHIP check (see review finding
 * on claim-pending-generation.js accepting any pendingId with no
 * ownership check at all): if it doesn't match the record's own email
 * (case-insensitively), this returns { ok:false, record, reason:
 * 'email_mismatch' } WITHOUT ever attempting the transition — so a
 * caller that merely knows/guesses a pendingId, but not the email it was
 * created under, cannot silently mark an unrelated person's pending
 * dream as claimed (which would suppress THEIR real re-engagement email).
 * Omit `expectedEmail` only for a caller that has already verified
 * ownership some other way (there is currently no such caller — every
 * real call site passes it).
 */
async function markClaimed(event, id, expectedEmail) {
  if (expectedEmail !== undefined && expectedEmail !== null) {
    var record = await get(event, id);
    if (!record) return { ok: false, record: null };
    var normalizedExpected = String(expectedEmail).trim().toLowerCase();
    if (record.email !== normalizedExpected) {
      return { ok: false, record: record, reason: 'email_mismatch' };
    }
  }
  return tryTransition(event, id, ['pending', 'notified'], 'claimed', { claimedAt: Date.now() });
}

/**
 * Marks a record failed after a real generation error. Allowed from
 * 'pending'/'ready' only — a failure signal arriving after the record's
 * already 'claimed'/'notified'/'failed' is moot (no email/side effect
 * rides on this transition either way, but staying consistent with the
 * same guarded shape as the others rather than a plain blind update).
 */
async function markFailed(event, id, reason) {
  return tryTransition(event, id, ['pending', 'ready'], 'failed', { failedReason: reason || 'unknown' });
}

module.exports = { STORE_NAME, create, get, update, tryTransition, markReady, markNotified, markClaimed, markFailed };
