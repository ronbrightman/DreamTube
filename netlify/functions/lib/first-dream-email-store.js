// netlify/functions/lib/first-dream-email-store.js
//
// Durable, cross-device "has this account already gotten its first-dream
// retention email" flag — the server-side backstop for
// send-first-dream-email.js (tracker.html's
// for-product-retention-email-send-user-th-eke9ra item). Mirrors
// js/store.js's own `account.firstVideoCreatedFired` client-side flag in
// spirit (same "fire exactly once per account" goal, same accepted
// choke-point race — see that function's doc comment and
// docs/EVENT_TAXONOMY.md's FirstVideoCreated writeup for the full history
// of the cross-tab race this reuses, deliberately not re-litigated here),
// but lives server-side so it actually holds across devices/browsers, not
// just within one browser's localStorage — the same reason
// lib/account-store.js exists at all instead of relying purely on
// js/store.js's local copy.
//
// Backed by a single Netlify Blobs store ("dreamtube-first-dream-email"),
// ONE RECORD PER NORMALIZED USERNAME: { username, dreamId, sentAt }.
//
// Plain existence-check-then-write — the same accepted-race shape every
// other Blobs-backed store in this codebase already uses (see
// lib/account-store.js's header comment's INCIDENT note for the full
// story of why a stricter-looking read-your-own-write check was tried and
// reverted here). Two concurrent first-time completions for the same
// account (the documented cross-tab race above) could in principle both
// read "not sent yet" and both send — accepted, same posture as
// markFirstVideoCreatedIfEligible's own client-side flag, not something
// this file's task is meant to close.

var { getStore, connectLambda } = require('@netlify/blobs');

var STORE_NAME = 'dreamtube-first-dream-email';

function normalizeUsername(username) {
  return (typeof username === 'string' ? username : '').trim().toLowerCase();
}

function store() {
  return getStore({ name: STORE_NAME });
}

/** True if this account's first-dream retention email has already been recorded as sent. */
async function hasSent(event, username) {
  var key = normalizeUsername(username);
  if (!key) return true; // no valid identity to key on -- treat as "already sent" so nothing sends against it
  connectLambda(event);
  return !!(await store().get(key, { type: 'json' }));
}

/**
 * Records this account's first-dream email as sent, but only if it hasn't
 * been already. Returns { ok:true } the first time for a given username,
 * { ok:false, alreadySent:true } every time after (including a second call
 * for a different dreamId — this flag is per-ACCOUNT, not per-dream, same
 * as markFirstVideoCreatedIfEligible's own scope). Callers must check this
 * BEFORE sending, not after, so a losing racer never sends a duplicate.
 */
async function markSentOnce(event, username, dreamId) {
  var key = normalizeUsername(username);
  if (!key) return { ok: false, error: 'invalid_username' };
  connectLambda(event);
  var s = store();
  var existing = await s.get(key, { type: 'json' });
  if (existing) return { ok: false, alreadySent: true };
  await s.setJSON(key, { username: key, dreamId: dreamId || null, sentAt: Date.now() });
  return { ok: true };
}

module.exports = { STORE_NAME, normalizeUsername, hasSent, markSentOnce };
