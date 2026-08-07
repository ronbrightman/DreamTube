// netlify/functions/lib/whisper-alignment-store.js
//
// Idempotency guard for interp-audio-status.js's Stage 1 -> Stage 2 handoff
// (tracker.html's for-product-whisper-runaway-5-000-whispe-szk33s item).
//
// THE BUG THIS FIXES: interp-audio-status.js is fully stateless across
// polls -- the only state is the `operationName` string the client round-
// trips. Its Stage 1 branch, on finding the Kokoro TTS job COMPLETED, used
// to unconditionally call submitWhisperAlignment(audioUrl) -- a REAL
// fal-ai/whisper job submission, real spend -- every single time ANY poll
// request reached that branch. Once the TTS job is COMPLETED, checkFalStatus
// reports COMPLETED forever, so this wasn't a one-time race: any poll that
// hits Stage 1 again with the OLD "fal:" operationName -- client latency
// swapping over to the new "falw:" name, overlapping/concurrent poll
// requests, a client retry after a flaky response the server already
// processed, two browser tabs open on the same reading -- submitted ANOTHER
// whisper job. Confirmed against real fal.ai billing: ~4,200-5,200
// fal-ai/whisper units/day against ~1-2 actual readings/day (tracker item's
// own numbers), roughly 100x the expected one-submission-per-reading rate.
//
// THE FIX: a Blobs-backed dedup marker, ONE RECORD PER TTS REQUEST, keyed on
// `ttsModel + ':' + ttsRequestId` -- the exact identity already embedded in
// Stage 1's own "fal:<ttsModel>:<ttsRequestId>" operationName, so it's
// stable and available at exactly the point (Stage 1, TTS-completed) that
// needs to check it, with no extra parsing/derivation. audioUrl would also
// be stable, but it's only known a step later (after fetching the TTS
// result) and is a much longer/noisier key for no benefit -- ttsRequestId
// alone is already the right identity for "how many times have we tried to
// align THIS TTS job's audio."
//
// CONCURRENT-CLAIM RACE -- CLOSED, not just narrowed, deliberately DIFFERENT
// from this codebase's usual "accept the residual race, document it" posture
// (lib/blobs-retry.js's own header comment, lib/pending-dreams.js's
// tryTransition): every other store documented in blobs-retry.js's header
// predates @netlify/blobs 10.x's real compare-and-swap primitive and is
// deliberately left on the older read/mutate/write/verify loop (see that
// file's "WHAT WAS RE-CHECKED 2026-07-30" section, point 3, for why the
// SDK bump itself is out of scope everywhere else -- "a two-major-version
// dependency bump touching every Blobs-backed store including the money
// paths... needs its own reviewed change"). This store doesn't need that
// bump: `blobs10` is ALREADY an installed, reviewed, in-production
// dependency (package.json; lib/first-dream-email-store.js and
// lib/push-dedup-store.js's CAS rewrite), so using it here for a BRAND NEW
// store is not a new risk surface, just reusing an already-proven idiom.
// Given that, and given this fix's entire purpose is eliminating duplicate
// real-money submissions, there's no reason to accept a residual "two
// concurrent Stage-1-completed polls both see no marker and both submit"
// window when closing it costs nothing extra: `claim()` below wins or loses
// atomically via `setJSON(key, value, { onlyIfNew: true })`, exactly like
// first-dream-email-store.js's markSentOnce / push-dedup-store.js's
// markSentOnce -- no read-then-write gap for two concurrent claims to both
// slip through.
//
// WHAT STILL ISN'T FULLY ATOMIC, AND WHY THAT'S FINE: the actual whisper
// SUBMISSION (a real network round trip to fal.ai) necessarily happens
// AFTER the claim write, not atomically with it -- there is no way to make
// an external HTTP call part of a single Blobs CAS write. So there's a
// short window where a record exists with `whisperRequestId: null` (claimed,
// submission in flight). A poll landing in that window does NOT retry the
// claim (it would lose the CAS write anyway) and does NOT submit anything --
// it just re-polls Stage 1 with the OLD "fal:" operationName again shortly,
// same zero-cost "processing" response the client already tolerates while
// waiting on Kokoro itself. The only two outcomes that cost real money --
// "submit a whisper job" -- are gated behind winning the CAS claim, full
// stop. If the winning submission itself fails, releaseClaim() deletes the
// marker so a genuinely fresh attempt isn't permanently blocked (matches
// interp-audio-status.js's existing "submission failure degrades to
// sentence-level captions, non-fatal" behavior) -- see that function's own
// doc comment for why a plain delete (not a CAS op) is safe here: only the
// claim's own winner ever calls it.
//
// HONESTY NOTE, same as every other blobs10 call site in this codebase:
// verified here via unit tests against test/helpers/mock-blobs.js's
// in-memory fake of both the `blobs10` and `@netlify/blobs` module names
// (including real CAS `onlyIfNew`/`modified` semantics and concurrent-claim
// coverage). NOT verified against a real Netlify Blobs backend in
// production -- there is no real Netlify/Blobs environment or FAL_KEY in
// this sandbox.

var { getStore, connectLambda } = require('blobs10');

var STORE_NAME = 'dreamtube-whisper-alignment';

function store() {
  return getStore({ name: STORE_NAME });
}

function keyFor(ttsModel, ttsRequestId) {
  return ttsModel + ':' + ttsRequestId;
}

/** Reads the current whisper-submission record for a TTS request, or null if none exists yet. */
async function get(event, ttsModel, ttsRequestId) {
  connectLambda(event);
  var record = await store().get(keyFor(ttsModel, ttsRequestId), { type: 'json' });
  return record || null;
}

/**
 * Attempts to atomically claim the right to submit the ONE whisper
 * alignment job for this TTS request. Returns:
 *   { claimed: true }  -- this call won; caller MUST now actually submit
 *     the whisper job and then call recordSubmitted (on success) or
 *     releaseClaim (on failure) -- see this file's header comment.
 *   { claimed: false, record }  -- someone else already holds (or has
 *     completed) this claim; caller MUST NOT submit. `record.whisperRequestId`
 *     is null if that other claim is still mid-submission (not yet a real
 *     job to reuse), or set if it already succeeded.
 *   { claimed: false, error: 'exhausted' }  -- the CAS write itself
 *     REJECTED (a genuine transport/server error, never the expected
 *     precondition-rejection signal -- that resolves normally with
 *     modified:false). Fails CLOSED, same posture as every other blobs10
 *     call site in this codebase: caller MUST NOT submit, since it cannot
 *     tell whether this attempt actually created the marker or not.
 */
async function claim(event, ttsModel, ttsRequestId, audioUrl) {
  var key = keyFor(ttsModel, ttsRequestId);
  var record = {
    ttsModel: ttsModel,
    ttsRequestId: ttsRequestId,
    audioUrl: audioUrl,
    whisperRequestId: null,
    claimedAt: Date.now(),
    submittedAt: null
  };

  var result;
  try {
    connectLambda(event);
    result = await store().setJSON(key, record, { onlyIfNew: true });
  } catch (e) {
    console.error('whisper-alignment-store: CAS claim write threw for ttsRequestId=' + ttsRequestId + ' -- refusing to submit rather than risk a duplicate whisper job', e);
    return { claimed: false, error: 'exhausted' };
  }

  if (result && result.modified === true) {
    return { claimed: true };
  }
  if (result && result.modified === false) {
    var existing = await get(event, ttsModel, ttsRequestId);
    return { claimed: false, record: existing };
  }

  console.error('whisper-alignment-store: CAS claim write for ttsRequestId=' + ttsRequestId + ' returned an unexpected shape -- refusing to submit: ' + JSON.stringify(result));
  return { claimed: false, error: 'exhausted' };
}

/**
 * Records a successful whisper submission against a claim THIS caller just
 * won (claim() returned claimed:true). Plain overwrite, no CAS needed --
 * only the claim's own winner ever calls this, so there is no concurrent
 * writer to race.
 *
 * BEST-EFFORT, same posture as releaseClaim() below -- and for a sharper
 * reason: by the time this is called, the real fal-ai/whisper submission
 * has ALREADY happened (real money spent, `whisperRequestId` is a real,
 * otherwise-unrecoverable job id the caller is already holding). A
 * transient Blobs write failure here must never discard that. This
 * function swallows its own write failure (logs and returns normally,
 * never throws) so interp-audio-status.js's Stage 1 can still hand the
 * client the "falw:" operationName it needs in THIS response, regardless
 * of whether the durable dedup record itself got persisted -- the record
 * is a best-effort optimization to avoid a second submission on a FUTURE
 * poll, not a correctness requirement for the response happening right now.
 *
 * RESIDUAL GAP, accepted deliberately rather than chased: if this write
 * does fail, the persisted record is left exactly as claim() left it --
 * `{ whisperRequestId: null, ... }` -- forever, since nothing ever retries
 * or corrects it. Any OTHER poll for the SAME ttsRequestId (a second
 * browser tab, a genuinely concurrent retry racing this one) that reaches
 * Stage 1's `whisperAlignmentStore.get()` will keep taking the "someone
 * else is mid-submission, don't touch it" branch and re-poll with the OLD
 * "fal:" name -- forever -- until INTERP_AUDIO_MAX_POLL_MS elapses and
 * THAT poll's reading fails outright (E506: tts_request_failed: timed_out).
 * This is deliberately NOT "fixed" by releasing the claim on a write
 * failure here the way releaseClaim() does on a submission failure:
 * releasing would let a future poll win claim() again and submit a SECOND
 * real fal-ai/whisper job for audio that was already (successfully, just
 * not durably recorded) aligned -- reopening exactly the duplicate-
 * submission cost leak this whole store exists to prevent, and a worse
 * outcome than the gap it would be closing. There is no way for this
 * function to tell "the submission actually failed, a fresh claim is
 * safe" (releaseClaim's case) apart from "the submission succeeded but
 * only the record of it failed to save" (this case) -- so the safe choice
 * is to leave the marker in place. The blast radius is narrow and
 * strictly smaller than before this fix existed: the ONE poller that
 * actually holds `whisperRequestId` (this invocation) still succeeds
 * immediately via interp-audio-status.js's direct return, completely
 * unaffected by this write's outcome; only a genuinely different,
 * genuinely concurrent-at-this-exact-moment poller for the same TTS
 * request is affected, and only until it independently times out. A
 * narrow, rare-of-a-rare edge, documented honestly here rather than
 * chased -- same "narrowed but not fully eliminated" posture as
 * blobs-retry.js's own header comment.
 */
async function recordSubmitted(event, ttsModel, ttsRequestId, audioUrl, whisperRequestId) {
  var key = keyFor(ttsModel, ttsRequestId);
  try {
    connectLambda(event);
    await store().setJSON(key, {
      ttsModel: ttsModel,
      ttsRequestId: ttsRequestId,
      audioUrl: audioUrl,
      whisperRequestId: whisperRequestId,
      claimedAt: Date.now(),
      submittedAt: Date.now()
    });
  } catch (e) {
    // Best-effort -- see this function's own doc comment above. The
    // whisper submission itself already succeeded and the caller already
    // holds whisperRequestId, so it still returns it to the client
    // regardless of this write's outcome -- never orphan an already-paid
    // job over a durability write failing.
    console.error('whisper-alignment-store: failed to record a successful whisper submission (requestId=' + whisperRequestId + ') for ttsRequestId=' + ttsRequestId + ' -- the submission itself succeeded and the caller will still return it to the client, but the durable dedup record was NOT updated (stays claimed/null)', e);
  }
}

/**
 * Releases a claim THIS caller just won, after the actual whisper
 * submission call failed -- without this, a real (rare) submission failure
 * would permanently block ANY future attempt for this TTS request, forcing
 * every reading to degrade to sentence-level captions forever rather than
 * just this one attempt. Best-effort plain delete, same "only the claim's
 * own winner ever calls this, no CAS needed" reasoning as recordSubmitted.
 */
async function releaseClaim(event, ttsModel, ttsRequestId) {
  var key = keyFor(ttsModel, ttsRequestId);
  try {
    connectLambda(event);
    await store().delete(key);
  } catch (e) {
    // Best-effort -- a failed release just means this TTS request's claim
    // stays burned until a human notices, never a crash and never a risk
    // of a duplicate submission (the caller releasing already knows its
    // own submission failed, so it never reused the claim itself).
    console.error('whisper-alignment-store: failed to release a failed-submission claim for ttsRequestId=' + ttsRequestId, e);
  }
}

module.exports = { STORE_NAME, keyFor, get, claim, recordSubmitted, releaseClaim };
