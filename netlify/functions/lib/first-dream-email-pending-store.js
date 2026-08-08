// netlify/functions/lib/first-dream-email-pending-store.js
//
// Durable "waiting on a captured thumbnail before sending the automatic
// first-dream retention email" queue — tracker item
// for-product-email-redesign-unsubscribe-l-16ysmp's founder-approved
// follow-up, as amended by the founder's 2026-08-08 rule ("do NOT send the
// email at all until the thumbnail is available"): wait for the captured
// image; if it lands within the window, send with it; if it NEVER lands,
// DROP the email entirely rather than sending a thumbnail-less one — see
// send-pending-first-dream-emails.js's "DROP, NOT SEND-ANYWAY" header note
// for the full reasoning (the old "SEND ANYWAY at the 3-minute mark" flat-
// color fallback is gone — it was the source of the founder's bare email).
//
// WHY THIS EXISTS: mark-generation-completed.js's automatic send used to
// call lib/first-dream-email-sender.js's sendIfEligible SYNCHRONOUSLY,
// the instant a generation verified complete — see that file's own prior
// header comment (git history) on why it had no dreamId/imageUrl at that
// exact choke point and always fell back to the flat-color banner as a
// result. A real Netlify Function cannot just `await delay(3 minutes)`
// inside one synchronous invocation (this codebase has no precedent for
// Background Functions, and even if it did, the default/typical
// synchronous execution budget is nowhere near 3 minutes — see
// lib/blobs-retry.js's own header comment on this deploy's ~10s ballpark
// budget for a plain request). So the wait has to be modeled as a
// DEFERRED, re-checked-on-a-schedule state, the same shape this codebase
// already uses for anything genuinely time-based with no natural request
// to piggyback on (send-daily-claim-pushes.js — this repo's first
// scheduled function, "a claim became available again... no existing
// request-driven choke point... has to be found by scanning, on a
// schedule"). This store is the "found by scanning" half for THIS
// feature: mark-generation-completed.js now just enqueues a pending
// record here (see markPending below); send-pending-first-dream-
// emails.js's scheduled scanAndSend is the other half that actually
// decides, on every run, whether to send now (thumbnail landed), wait
// (still within the give-up window), or drop (window elapsed, no thumbnail
// ever synced — never a thumbnail-less send).
//
// HOW THE THUMBNAIL IS FOUND, WITH NO CHANGE TO ANY CLIENT CONTRACT: this
// store deliberately carries NO thumbnail/dreamId field of its own —
// resolving "has the thumbnail for THIS operationName landed yet" is
// send-pending-first-dream-emails.js's own job, done by cross-referencing
// lib/dream-store.js's already-existing, already-synced private-dream
// record for `username` (dream-sync.js's own DREAM_FIELDS whitelist
// already includes BOTH `sourceOperationName` — stamped once by
// js/store.js's finalizeDream — and `imageUrl` — stamped once
// saveThumbnailBestEffort's own upload succeeds and re-syncs). Both were
// built for an entirely different feature (server-side private-dream
// persistence) and happen to be exactly the correlation this needs —
// avoids inventing a second identity-carrying field, and (per this
// codebase's own stated design goal for mark-generation-completed.js's
// request contract) needs ZERO new client-trusted input at the choke
// point that enqueues here: operationName, username, and email are all
// already independently, server-side resolved by the time this is
// called (see mark-generation-completed.js's own maybeSendAutomatic
// FirstDreamEmail).
//
// Backed by a single Netlify Blobs store
// ("dreamtube-first-dream-email-pending"), ONE RECORD PER operationName:
// { operationName, username, email, triggeredAt }.
//
// IDEMPOTENT ENQUEUE, CAS-BACKED (`blobs10`'s real onlyIfNew conditional
// write — same modern primitive lib/first-dream-email-store.js's/
// lib/push-dedup-store.js's own markSentOnce already use, see either
// file's own header comment for the fuller "why CAS over the old
// read-mutate-write-verify loop"): mark-generation-completed.js's own
// completion marker has no dedup of its own against a retried/duplicate
// client call for the SAME operationName (see generation-completion-
// store.js's own header comment — "No TTL/cleanup... a marker that's
// never consumed... is a harmless record left behind"), so
// maybeSendAutomaticFirstDreamEmail can genuinely run more than once for
// one real completion. A plain overwrite here would reset `triggeredAt`
// on every duplicate call, quietly pushing the 3-minute deadline forward
// each time — onlyIfNew makes the FIRST enqueue win outright and every
// later duplicate a harmless no-op against the SAME already-ticking
// deadline.
//
// CLEANUP: send-pending-first-dream-emails.js's scanAndSend removes a
// record the moment it decides to act on it (send with image, or drop
// after the give-up window) — see that file's own header comment. A record that's
// never removed (e.g. a scan's own removePending call failing) is a
// single small, harmless leftover, same "negligible storage, no TTL
// needed" acceptance lib/rate-limit.js's/generation-completion-store.js's
// own header comments already document elsewhere in this codebase — it
// just means a future scan keeps re-checking (and re-attempting to send,
// which lib/first-dream-email-sender.js's own once-ever guard makes a
// safe no-op) until it's cleaned up.

var { getStore, connectLambda } = require('blobs10');

var STORE_NAME = 'dreamtube-first-dream-email-pending';

function store() {
  return getStore({ name: STORE_NAME });
}

/**
 * Enqueues `operationName` as waiting on its thumbnail, unless it's
 * already enqueued (see header comment's IDEMPOTENT ENQUEUE section).
 * Returns { ok:true } the first time for a given operationName,
 * { ok:true, alreadyPending:true } on every later duplicate call (a
 * normal, harmless outcome — not an error), or { ok:false, error } only
 * if the input was invalid or the write itself genuinely failed (fails
 * CLOSED — same posture as every other CAS-backed marker in this
 * codebase: a caller that can't verify the enqueue landed must not
 * assume it did).
 */
async function markPending(event, operationName, username, email) {
  if (!operationName || !username || !email) return { ok: false, error: 'invalid_input' };

  var record = { operationName: operationName, username: username, email: email, triggeredAt: Date.now() };

  var result;
  try {
    connectLambda(event);
    result = await store().setJSON(operationName, record, { onlyIfNew: true });
  } catch (e) {
    console.error('first-dream-email-pending-store: CAS write threw for operationName -- refusing to assume it enqueued', e);
    return { ok: false, error: 'exhausted' };
  }

  if (result && result.modified === true) return { ok: true };
  if (result && result.modified === false) return { ok: true, alreadyPending: true };

  console.error('first-dream-email-pending-store: CAS write returned an unexpected shape: ' + JSON.stringify(result));
  return { ok: false, error: 'exhausted' };
}

/**
 * Lists every currently-pending operationName — used by send-pending-
 * first-dream-emails.js's scanAndSend to enumerate what needs checking on
 * each run. Same "no per-record key to read directly, must enumerate the
 * whole store" shape as send-daily-claim-pushes.js's own scan (see that
 * file's own header comment) — fine at this app's current real scale
 * (this store only ever holds records still WITHIN their 3-minute window,
 * never a long-lived backlog, so it stays naturally small).
 */
async function listPendingOperationNames(event) {
  connectLambda(event);
  var listResult = await store().list();
  return listResult.blobs.map(function (b) { return b.key; });
}

/** Reads one pending record by operationName, or null if not (or no longer) enqueued. */
async function getPending(event, operationName) {
  if (!operationName) return null;
  connectLambda(event);
  return (await store().get(operationName, { type: 'json' })) || null;
}

/**
 * Removes a pending record — called once scanAndSend has actually decided
 * (send now, or send the fallback) so it's never re-checked again.
 * Best-effort (never throws) — see header comment's CLEANUP paragraph on
 * why a failed removal here is a harmless, self-correcting leftover, not
 * a correctness bug (lib/first-dream-email-sender.js's own once-ever
 * guard is what actually prevents a duplicate real send, not this).
 */
async function removePending(event, operationName) {
  if (!operationName) return { ok: false };
  try {
    connectLambda(event);
    await store().delete(operationName);
    return { ok: true };
  } catch (e) {
    console.error('first-dream-email-pending-store: failed to remove a pending record -- a future scan will just re-check it', e);
    return { ok: false };
  }
}

module.exports = { STORE_NAME, markPending, listPendingOperationNames, getPending, removePending };
