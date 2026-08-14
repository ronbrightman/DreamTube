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
//     id, email, whatsapp (optional), caption, storyText, style,
//     characterIdsForGeneration, cameraView, sceneryTime, sceneryPlace,
//     mediaType: 'video'|'image' (default 'video' — see below),
//     operationName, status: 'pending'|'ready'|'notified'|'claimed'|'failed',
//     videoUrl, imageUrl, createdAt, readyAt, notifiedAt, claimedAt, failedReason
//   }
//
// storyText (tracker item for-product-split-prompttext-storytext-
// f-yt5kc7, additive): the human-readable, first-person dream description
// wizard.html's own chip flow computes — `caption` keeps its existing
// meaning unchanged (the full engineered generation prompt). Defaults ''
// so a record created before this field existed (there are none possible
// after this ships, but defensively) reads back as an empty string, never
// undefined — verify-pending-claim.js/claim-dream.html both fall back to
// `caption` when this is empty, same forward-only-migration shape as
// js/store.js's dream records.
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

// Secondary BY-EMAIL index (cross-device recovery, tracker item
// for-product-passwordless-cross-device-attach — the founder iOS repro
// 2026-08-14 the E304 server-persist does NOT cover). A completed pending
// generation whose owning account did not exist yet at fal-completion time
// (dream-webhook.js's persistDurableDreamForOwner correctly SKIPs there —
// "no account yet") must still be attachable to that account once it's
// finalized LATER, on a DIFFERENT device, with no device-local pendingId to
// claim by. The primary store keys records by an unguessable random id, so
// there is no way to find "every pending record for this email" without an
// index. This is that index — the same "email is the cross-device anchor of
// identity" role account-store.js's own "e:" index plays, kept in its OWN
// store here (rather than a prefixed key in the primary store) so the
// primary store's keyspace stays exactly the pdXXXX records every existing
// get()/update()/tryTransition() call already assumes.
//
// KEY SHAPE: `<normalizedEmail>:<pendingId>` -> the pendingId (as JSON). One
// key per (email, record), so a create() only ever writes its OWN unique
// key — there is NO shared array to concurrently mutate (contrast a single
// "email -> [ids]" blob, which would have the lost-update race every other
// Blobs store in this codebase documents). listIdsByEmail below reads them
// back with a single prefix list(). The pendingId is recovered from the key
// itself (everything after the LAST ':'), so a pendingId — which is hex and
// never contains ':' — is isolated correctly even in the (practically
// impossible, but harmless) event a normalized email contained a colon.
var EMAIL_INDEX_STORE_NAME = 'dreamtube-pending-dreams-email-index';

function store() {
  return getStore({ name: STORE_NAME });
}

function emailIndexStore() {
  return getStore({ name: EMAIL_INDEX_STORE_NAME });
}

/**
 * The single normalization used for BOTH a record's stored `email` and its
 * email-index key, so the two can never drift out of match (a mismatch would
 * silently make listIdsByEmail miss a record). Identical to
 * entitlements.js's normalizeEmail / the trim().toLowerCase() every other
 * email anchor in this codebase uses.
 */
function normalizeEmailKey(email) {
  return (typeof email === 'string' ? email : '').trim().toLowerCase();
}

function emailIndexKey(email, id) {
  return normalizeEmailKey(email) + ':' + id;
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
    email: normalizeEmailKey(data.email),
    whatsapp: data.whatsapp || null,
    caption: data.caption || '',
    storyText: data.storyText || '',
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
  // Secondary by-email index write (best-effort) — see EMAIL_INDEX_STORE_NAME
  // above. A failure here never fails the create: the primary record still
  // exists and every existing recovery path (client sync, webhook persist,
  // claim email) still works; only the new cross-device finalization backfill
  // would miss this one record, an honest degrade back to today's behavior.
  if (record.email) {
    try {
      await emailIndexStore().setJSON(emailIndexKey(record.email, id), id);
    } catch (e) {
      console.error('pending-dreams: email-index write failed (non-fatal) for id ' + id, e);
    }
  }
  return record;
}

/**
 * Every pending-record id created under `email` (via the secondary by-email
 * index — see EMAIL_INDEX_STORE_NAME above). Cross-device recovery reads
 * these back at account finalization to find completed generations to attach,
 * with no device-local pendingId. Returns [] for an empty/unknown email or on
 * any read failure (never throws) — the caller (lib/pending-dream-recovery.js)
 * treats an empty list as "nothing to recover", same best-effort posture as
 * every other recovery path here.
 */
async function listIdsByEmail(event, email) {
  var normalized = normalizeEmailKey(email);
  if (!normalized) return [];
  try {
    connectLambda(event);
    var listResult = await emailIndexStore().list({ prefix: normalized + ':' });
    var blobs = (listResult && listResult.blobs) || [];
    return blobs.map(function (b) { return b.key.slice(b.key.lastIndexOf(':') + 1); });
  } catch (e) {
    console.error('pending-dreams: listIdsByEmail failed (non-fatal) for ' + normalized, e);
    return [];
  }
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

// Bounded re-read budget for getWithReadyRetry below — deliberately
// smaller than tryTransition's own MAX_TRANSITION_ATTEMPTS/blobs-retry.js's
// DEFAULT_MAX_ATTEMPTS (3): this runs on every funnel-path completion
// call, not just a genuine race (see getWithReadyRetry's own doc comment),
// so the attempt budget stays intentionally light — one extra re-read
// after one real delay, not a full three-attempt loop.
var READY_CHECK_MAX_ATTEMPTS = 2;
var READY_CHECK_RETRY_DELAY_MS = blobsRetry.DEFAULT_RETRY_DELAY_MS;

function delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/**
 * Bounded-retry variant of get() — used ONLY by mark-generation-
 * completed.js's maybeEnqueueUnwatchedNudge to check whether
 * dream-webhook.js's markReady has already stamped `readyAt` on a
 * funnel-started record (see that function's own doc comment for the full
 * pre-signup-overlap mechanism this guards).
 *
 * WHY THIS EXISTS (tracker.html's
 * narrow-residual-race-mark-generation-com-wenb3g item): a plain get()
 * here reads under Blobs' default eventual consistency, same as
 * everywhere else in this codebase (see this file's own CONCURRENT-WRITE
 * RACE comment above). dream-webhook.js's markReady is a GUARDED write
 * (tryTransition, itself verify-after-write) — but that guarantee only
 * covers markReady's OWN verify-read landing on the SAME instance/
 * request that just wrote it. A completely separate, independent read
 * from THIS function, arriving in the narrow window after markReady's
 * write is issued but before it's durably visible to every other reader,
 * can still observe a stale `readyAt: undefined` — incorrectly concluding
 * "the abandonment email hasn't sent yet" while dream-webhook.js's own
 * send decision (which never depends on any read from this function)
 * proceeds regardless. Both emails would fire for one dream.
 *
 * This mirrors lib/blobs-retry.js's own DEFAULT_RETRY_DELAY_MS fix for
 * the identical shape of gap (a zero-delay retry loop gives Blobs'
 * propagation no real time to catch up before the next read) — see that
 * constant's own doc comment for the precedent this adapts. It is
 * deliberately a bounded RE-READ, not a guarded WRITE: there is nothing
 * to mutate here (this function never writes a pending-dreams record,
 * only decides whether an email should fire), so blobs-retry.js's own
 * retryingWrite doesn't apply directly — the shape (a real delay between
 * attempts, a small bounded attempt count) is deliberately the same
 * regardless.
 *
 * Narrows the window substantially — dream-webhook.js's own write is
 * already fully committed and verified (markReady's own `ok: true`
 * guarantee) well before its email send even starts, so any genuine
 * propagation lag is almost always well under this function's total wait
 * budget — but, like every other eventually-consistent read in this
 * codebase, does not claim to eliminate it down to zero: an attempt
 * exhausting the full retry budget still concludes "not ready" and
 * returns whatever it last saw, same accepted-residual posture as
 * tryTransition's own MAX_TRANSITION_ATTEMPTS exhaustion above. See
 * test/pending-dreams.test.js's own getWithReadyRetry coverage and
 * test/automatic-first-dream-email.test.js's simulated-stale-read
 * regression test for the actual proof.
 */
async function getWithReadyRetry(event, id, options) {
  var maxAttempts = (options && options.maxAttempts) || READY_CHECK_MAX_ATTEMPTS;
  var retryDelayMs = options && typeof options.retryDelayMs === 'number' ? options.retryDelayMs : READY_CHECK_RETRY_DELAY_MS;

  var record = null;
  for (var attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0 && retryDelayMs > 0) {
      await delay(retryDelayMs);
    }
    record = await get(event, id);
    if (record && record.readyAt) return record;
  }
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

module.exports = { STORE_NAME, EMAIL_INDEX_STORE_NAME, normalizeEmailKey, create, get, getWithReadyRetry, listIdsByEmail, update, tryTransition, markReady, markNotified, markClaimed, markFailed };
