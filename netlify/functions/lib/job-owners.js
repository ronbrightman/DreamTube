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
 */
async function recordJobOwner(event, jobId, email) {
  if (!jobId) return;
  var key = normalizeEmail(email);
  if (!key) return;
  connectLambda(event);
  await store().setJSON(jobId, { email: key, createdAt: Date.now() });
}

/**
 * Returns the normalized email that submitted `jobId`, or null if no
 * record exists (never submitted through the real generate-video.js/
 * generate-image.js flow, predates this store, or recordJobOwner's own
 * write failed/never landed — see header comment for why that reads as
 * "refuse to refund," not "refund anyone").
 */
async function getJobOwnerEmail(event, jobId) {
  if (!jobId) return null;
  connectLambda(event);
  var record = await store().get(jobId, { type: 'json' });
  return (record && record.email) || null;
}

module.exports = { STORE_NAME, recordJobOwner, getJobOwnerEmail };
