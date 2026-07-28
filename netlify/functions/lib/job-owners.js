// netlify/functions/lib/job-owners.js
//
// Binds a generation job id (operationName) to the email that submitted
// it — the authorization check lib/entitlements.js's refundTokensOnce
// requires before crediting a refund to ANYONE. Closes a real
// vulnerability found in round-2 review of the auto-refund feature
// (tracker item idea-auto-refund-policy): video-status.js/image-status.js
// accept `email` as a plain, unauthenticated query-string parameter (this
// codebase has no session/auth token to check it against — see
// generate-video.js's own E112 doc block on why every request is
// identified purely by a client-supplied email throughout this codebase).
// Before this file existed, refundTokensOnce trusted that email outright:
// `GET /video-status?name=<victim's in-flight operationName>&email=
// <attacker's email>` would credit the attacker's balance for a stranger's
// failed job — and PERMANENTLY lock the real owner out of ever being
// refunded for their own job, since REFUNDED_JOBS_STORE_NAME's dedup
// marker commits to 'committed' on the first successful claim, regardless
// of who made it. Before the auto-refund feature existed, hitting these
// endpoints with an arbitrary email+jobId pair had zero financial
// consequence (there was nothing to credit) — this closes the gap the
// refund feature itself introduced.
//
// Backed by a single Netlify Blobs store ("dreamtube-job-owners"), one
// record per job id: { email, createdAt }. Written ONCE, at generation-
// SUBMISSION time (generate-video.js/generate-image.js, the moment
// operationName is minted, right alongside the same call's spendTokens —
// see recordJobOwner's call sites in both files). Read ONCE, at refund
// time, by lib/entitlements.js's refundTokensOnce via getJobOwnerEmail
// below, BEFORE that function ever touches REFUNDED_JOBS_STORE_NAME's
// marker or any balance — a request whose claimed email doesn't match the
// recorded owner (or where no owner record exists at all) is refused
// before any side effect happens, not just before the credit lands.
//
// Deliberately its own small file, not folded into entitlements.js
// (already the largest lib file in this codebase) — "who submitted this
// job" is a distinct, narrow concern from "what is this email's token
// balance," matching this codebase's existing precedent of small,
// single-purpose lib files for one piece of state (lib/pending-dream-
// token.js, lib/dream-share-token.js, lib/first-dream-email-store.js).
// Deliberately does NOT require('./entitlements') for normalizeEmail —
// entitlements.js requires this file (to call getJobOwnerEmail from
// refundTokensOnce), so requiring back would be circular; the two-line
// trim+lowercase is duplicated locally instead, matching this codebase's
// own explicit "small shared bits get duplicated across self-contained
// files rather than introducing a require cycle" precedent (see e.g.
// video-status.js's/generate-video.js's duplicated humanizeFalDetail).
//
// NOT idempotency-critical the way REFUNDED_JOBS_STORE_NAME's two-phase
// marker is — a plain last-write-wins overwrite is fine here. A job id is
// only ever submitted once by construction (fal mints a fresh request_id
// per real submission; this codebase's own mock-mode operationName embeds
// a fresh timestamp + random id per call too — see generate-video.js's
// mockOperationName), so there is no legitimate "two different submitters,
// same job id" case for this store to arbitrate between; two concurrent
// writes for the same key would only ever happen if the SAME submission
// retried, which would write the SAME email both times anyway.
//
// FAIL-CLOSED, not fail-open, on a missing/failed write: recordJobOwner is
// called best-effort (wrapped in try/catch) from generate-video.js/
// generate-image.js specifically so a transient Blobs hiccup here can
// never turn an already-successful, already-paid-for generation
// submission into a 500 — but the CONSEQUENCE of a missing record is that
// refundTokensOnce refuses to auto-refund that job later (falls through to
// the support-form fallback), never that it credits an unverified email.
// Failing this way (safe degrade to "no auto-refund" rather than "refund
// anyone who asks") is the deliberate, correct tradeoff for a security
// boundary, even though it's the less convenient one operationally.
//
// SECOND CALLER (added for tracker.html's
// for-product-activate-automatic-retention-4n74rw item, founder-approved
// 2026-07-27 — "start sending the first-video retention email
// AUTOMATICALLY... do not wait for manual triggering"): mark-generation-
// completed.js — the one genuine server-verified "a generation just
// finished" choke point for a normal signed-in generation (there is no
// real fal webhook for that path, only the abandoned-pre-signup one — see
// that file's own header comment) — needed a way to resolve WHO owns a
// just-completed operationName with no client-supplied identity at all,
// so it can fire the retention email itself rather than depending on the
// client's browser surviving long enough to load result.html and run its
// own JS. This store already existed for exactly that "operationName ->
// real owner, no client trust needed" purpose (see above), so it's reused
// here rather than inventing a second identity-binding mechanism.
//
// `mediaType` (optional 3rd arg to recordJobOwner, added the same day) is
// ALSO now recorded, purely so mark-generation-completed.js can preserve
// the retention email's existing "video only" scope (matching
// markFirstVideoCreatedIfEligible's/send-first-dream-email.js's own
// documented scope decision) without needing to fetch the job's actual
// result payload — verifyOperationCompleted's own doc comment explains
// why it deliberately never does that. A "fal:" operationName's own model
// segment can't be used instead: image and video mock-mode operationNames
// are indistinguishable strings ("mock:" + timestamp + uuid, see
// generate-video.js's/generate-image.js's own mockOperationName), so this
// needed to be recorded explicitly, not derived. Purely additive and
// backward compatible — a record written before this field existed simply
// has no `mediaType`, which getJobOwnerRecord's callers must treat as
// "unknown," never "video" (see mark-generation-completed.js's own
// comment on why it fails closed — no auto-send — on unknown mediaType,
// not just on a missing owner record).
//
// `pendingId` (optional 5th arg to recordJobOwner, added 2026-07-28 for
// tracker.html's for-product-bug-founder-affects-all-funn-0efe7t's
// review-round-1 fix): recorded ONLY by start-pending-generation.js (the
// dream-builder wizard's pre-signup funnel path — the only caller that
// has a lib/pending-dreams.js record at all). Closes a real double-send:
// once that file also writes job-owner records (the item's own root-cause
// fix), mark-generation-completed.js's automatic retention email had no
// way to know the SEPARATE abandonment-email path (dream-webhook.js) had
// already fired its own "your dream is ready" email for the same dream —
// a fully sequential (not merely racing) ordering reachable in normal
// usage: webhook arrives and fully notifies while the user is still
// mid-wizard, THEN they finish signup normally (markClaimed is explicitly
// allowed to succeed from 'notified'). See mark-generation-completed.js's
// own doc comment for how this field is used (a pending-dreams lookup,
// gated on `readyAt` rather than the current `status`).

var { getStore, connectLambda } = require('@netlify/blobs');

var STORE_NAME = 'dreamtube-job-owners';

function store() {
  return getStore({ name: STORE_NAME });
}

/** Trims + lowercases an email — duplicated from entitlements.js's own normalizeEmail rather than require()'d, see header comment for why. Returns '' for anything falsy/non-string. */
function normalizeEmail(email) {
  return (typeof email === 'string' ? email : '').trim().toLowerCase();
}

/**
 * Records that `email` submitted `jobId` — called once, right after
 * operationName is minted, alongside the same request's spendTokens call.
 * No-ops for a falsy jobId or an empty/unnormalizable email (shouldn't
 * happen — generate-video.js's/generate-image.js's own E112/E412 token
 * gate already requires a real email before either reaches this point —
 * but this must never throw on a defensive check failing).
 *
 * `mediaType` (optional) — see header comment's "SECOND CALLER" section.
 * Only 'video'/'image' are ever stored; anything else (including omitted)
 * leaves the field off the record entirely, which every reader must treat
 * as "unknown," not as either specific type.
 *
 * `pendingId` (optional, added for tracker.html's for-product-bug-founder-
 * affects-all-funn-0efe7t review-round-1 fix): ONLY ever passed by
 * start-pending-generation.js, which already has its own lib/pending-
 * dreams.js record's id on hand at the exact moment it calls this (see
 * that file's own recordJobOwnerBestEffort). Lets mark-generation-
 * completed.js's maybeSendAutomaticFirstDreamEmail look the pending-dreams
 * record back up and check whether the SEPARATE abandonment-email path
 * (dream-webhook.js) already committed to sending its own email for this
 * SAME dream, before firing the automatic retention email too — see that
 * function's own doc comment for the full reasoning. Every non-funnel
 * caller (generate-video.js/generate-image.js) never has a pendingId at
 * all — a record with no `pendingId` field is exactly today's existing
 * shape, so this is purely additive/backward compatible.
 */
async function recordJobOwner(event, jobId, email, mediaType, pendingId) {
  if (!jobId) return;
  var key = normalizeEmail(email);
  if (!key) return;
  connectLambda(event);
  var record = { email: key, createdAt: Date.now() };
  if (mediaType === 'video' || mediaType === 'image') record.mediaType = mediaType;
  if (pendingId) record.pendingId = pendingId;
  await store().setJSON(jobId, record);
}

/**
 * Returns the full { email, mediaType, createdAt } record for `jobId`, or
 * null if none exists — see getJobOwnerEmail below for the same
 * "predates this store / write failed" honest-degrade reasoning, just
 * handing back the whole record instead of only the email.
 */
async function getJobOwnerRecord(event, jobId) {
  if (!jobId) return null;
  connectLambda(event);
  return (await store().get(jobId, { type: 'json' })) || null;
}

/**
 * Returns the normalized email that submitted `jobId`, or null if no
 * record exists (never submitted through the real generate-video.js/
 * generate-image.js flow, predates this store, or recordJobOwner's own
 * write failed/never landed — see header comment for why that reads as
 * "refuse to refund," not "refund anyone"). Thin wrapper over
 * getJobOwnerRecord above — unchanged contract/behavior from before that
 * function existed.
 */
async function getJobOwnerEmail(event, jobId) {
  var record = await getJobOwnerRecord(event, jobId);
  return (record && record.email) || null;
}

module.exports = { STORE_NAME, recordJobOwner, getJobOwnerRecord, getJobOwnerEmail };
