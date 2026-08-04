// netlify/functions/lib/email-suppression-store.js
//
// Durable "has this email address unsubscribed from our retention/
// marketing emails" list (tracker item
// for-product-email-redesign-unsubscribe-l-16ysmp) — the suppression half
// of the unsubscribe mechanism. Every retention/marketing sender
// (lib/first-dream-email-sender.js's sendIfEligible, dream-webhook.js's
// sendReadyEmail, and any future one — a win-back/weekly-recap send, per
// this feature's own tracker item body: "honored by ALL senders
// (first-dream, dream-ready, win-back, future)") must check isSuppressed
// BEFORE sending and skip (never error) if it comes back true.
//
// Deliberately SCOPED to retention/marketing sends only — password reset
// (request-password-reset.js), the deferred-verification code/link
// (lib/verification-email-sender.js), and the support-confirmation email
// (submit-support-message.js) are all transactional (a user directly
// asked for that specific email as the result of their own action right
// now) and must never be suppressible — see this feature's own tracker
// item: "a password-reset email is transactional, not marketing, and
// should NOT carry an unsubscribe link nor be suppressible". Callers
// outside the retention/marketing category simply never call this module
// at all; there is no separate "kind" flag to check here, the boundary is
// enforced by which senders were wired to call it, not by this store
// itself.
//
// Plain read-then-write, same tradeoff every other simple Blobs store in
// this codebase already accepts (see lib/account-store.js's own header
// comment for why): a genuine double-unsubscribe race (two clicks on the
// same link at nearly the same instant) can only ever converge on the
// SAME final state (suppressed:true, whichever write lands last), so
// there is nothing to lose from a plain overwrite here the way there
// would be for a one-time claim like lib/first-dream-email-store.js's
// markSentOnce — idempotent by construction, no CAS needed.
//
// Backed by a single Netlify Blobs store ("dreamtube-email-suppressions"),
// one record per normalized email: { email, unsubscribedAt, reason }.

var { getStore, connectLambda } = require('@netlify/blobs');

var STORE_NAME = 'dreamtube-email-suppressions';

function normalizeEmail(email) {
  return (typeof email === 'string' ? email : '').trim().toLowerCase();
}

function store() {
  return getStore({ name: STORE_NAME });
}

/**
 * True if `email` (normalized) has unsubscribed. An empty/invalid email
 * is treated as "not suppressed" (nothing on file to suppress) rather
 * than throwing — callers already separately require a real email before
 * ever getting this far (see lib/first-dream-email-sender.js's own
 * missing_identity guard, which runs first).
 */
async function isSuppressed(event, email) {
  var key = normalizeEmail(email);
  if (!key) return false;
  connectLambda(event);
  var record = await store().get(key, { type: 'json' });
  return !!(record && record.unsubscribedAt);
}

/**
 * Records `email` (normalized) as unsubscribed. Idempotent — calling this
 * any number of times for the same email leaves it suppressed either way
 * (a second call just re-stamps `unsubscribedAt` to the latest click,
 * which is harmless and never un-suppresses anything). Never throws; a
 * write failure is logged and reported back as `{ ok:false }` so the
 * calling endpoint can still respond sensibly, but this is not a
 * security-sensitive claim the way first-dream-email-store's markSentOnce
 * is — there is no "who won the race" question here, only "is this email
 * suppressed after this call", so a plain best-effort write is enough.
 */
async function suppress(event, email, reason) {
  var key = normalizeEmail(email);
  if (!key) return { ok: false, error: 'invalid_email' };
  try {
    connectLambda(event);
    await store().setJSON(key, { email: key, unsubscribedAt: Date.now(), reason: reason || 'user_unsubscribed' });
    return { ok: true };
  } catch (e) {
    console.error('email-suppression-store: failed to record unsubscribe for an email', e);
    return { ok: false, error: 'write_failed' };
  }
}

module.exports = { STORE_NAME, normalizeEmail, isSuppressed, suppress };
