// netlify/functions/lib/interp-read-store.js
//
// Durable, cross-device "which interpretation personas did this account
// READ on a given dream" marker — the server-side signal the two
// interpretation retention emails need (founder-approved retention plan;
// see send-interp-emails-batch.js's header comment for the full feature).
//
// WHY THIS EXISTS AT ALL: today "which personas did a user read on a dream"
// is tracked CLIENT-SIDE ONLY — js/interpret-experience.js's
// `interp_reading_shown` PostHog event, plus js/store.js's localStorage
// `dream.interpretations[personaKey]` map. A scheduled/owner-triggered
// server-side sender cannot read a PostHog event or a browser's
// localStorage, so it has no way to tell "read some but not all" (the
// flagship "Unread meanings" trigger) from "watched but read none" (the
// "No meaning yet" trigger). This is the exact same gap
// lib/result-view-store.js closed for the "did they WATCH it" half of the
// unwatched-dream nudge — this module is the "did they READ interpretation
// X" half, deliberately mirroring that store's shape and reasoning.
//
// KEYED BY operationName (the server-issued generation job id) — the SAME
// identity lib/result-view-store.js's watched-marker and lib/unwatched-
// dream-nudge-store.js's queue/guard are keyed by, so a single dream's
// watched-state and interpretation-read-set line up on one key (see
// mark-result-viewed.js's header comment on why operationName, never a
// client-invented dreamId, is the safe key: a dreamId is public elsewhere
// in this app, so keying a marker on one would let anyone who knows a
// dreamId plant a "read" marker for someone else's dream — here that would
// at worst suppress/mis-target a retention email, a self-limiting,
// non-destructive griefing outcome, not a data leak; operationName is never
// in any UI/URL, so it can't be targeted). The server records a read when
// interpret-dream.js successfully generates a reading for a (dream,
// persona), the moment a user actually opens/generates that persona's
// reading (see that file's marker-write call site).
//
// STORAGE SHAPE — ONE BLOB PER (operationName, persona) pair, key
// `operationName + '::' + personaKey`, value `{ operationName, personaKey,
// readAt }`. Deliberately NOT one record-per-operationName carrying a
// `personas` set: a set accumulated by read-modify-write is NOT idempotent-
// safe (two personas read close together each read the same prior state and
// the second write clobbers the first, silently dropping a persona from the
// set). A separate key per persona makes every write a PLAIN, idempotent
// setJSON that no other persona's write can ever clobber — the exact same
// "idempotent by construction, so no CAS needed" tradeoff lib/result-view-
// store.js documents for its own single-boolean marker, extended here to a
// per-persona marker. The read side reconstructs the set with a single
// prefix `list()` (Netlify Blobs' own server-side prefix filter — same
// mechanism account-store.js's listAccounts and lib/deploy-log-store.js
// already use).
//
// operationName contains only single colons in every real form
// (generate-video.js's "fal:<model>:<request_id>" / "mock:<ms>:<id>", or a
// Veo "operations/…" name) — never a double colon — so `::` is an
// unambiguous separator; the read side additionally validates the suffix is
// a KNOWN persona key (never a substring of another operationName), so even
// a pathological key can only ever be filtered out, never miscounted.
//
// Backed by the shared `@netlify/blobs` 8.2.0 client (not the blobs10 CAS
// alias) — no idempotency-critical write here, same as result-view-store.js.

var { getStore, connectLambda } = require('@netlify/blobs');
var InterpreterPersonas = require('../../../js/interpreter-personas');

var STORE_NAME = 'dreamtube-interp-reads';
var DELIM = '::';

// The set of legitimate persona keys, from the single source of truth
// (js/interpreter-personas.js) — used to validate a listed suffix so a
// stray/pathological blob key can never be miscounted as a persona read.
var VALID_PERSONA_KEYS = {};
(InterpreterPersonas.ALL || []).forEach(function (p) { if (p && p.key) VALID_PERSONA_KEYS[p.key] = true; });

function store() {
  return getStore({ name: STORE_NAME });
}

function markerKey(operationName, personaKey) {
  return operationName + DELIM + personaKey;
}

/**
 * Records that the account owning `operationName`'s dream has READ
 * `personaKey`'s interpretation on it. Best-effort, idempotent, never
 * throws — a failure here just means the sender can't yet see this read
 * (worst case: a wrongly-targeted retention email, bounded by each email's
 * own once-per-dream guard + unsubscribe link, not a correctness hazard).
 * Returns { ok:true } on a successful write, { ok:false } on invalid input
 * / an unknown persona / a write failure.
 */
async function markRead(event, operationName, personaKey) {
  if (!operationName || typeof operationName !== 'string') return { ok: false, error: 'invalid_operation_name' };
  if (!personaKey || typeof personaKey !== 'string' || !VALID_PERSONA_KEYS[personaKey]) return { ok: false, error: 'invalid_persona' };
  try {
    connectLambda(event);
    await store().setJSON(markerKey(operationName, personaKey), {
      operationName: operationName, personaKey: personaKey, readAt: Date.now()
    });
    return { ok: true };
  } catch (e) {
    console.error('interp-read-store: failed to record an interpretation-read marker -- a sender may not see this read yet', e);
    return { ok: false, error: 'write_failed' };
  }
}

/**
 * The set of persona keys READ for `operationName`, reconstructed by a
 * single prefix list(). Returns a de-duplicated array of known persona keys
 * (order not significant). A read failure returns [] (degrades toward
 * "nothing read" — matching lib/result-view-store.js's own "read failure
 * returns not-yet-viewed" posture: each email's once-per-dream guard +
 * unsubscribe bound the cost of a wrongly-sent email, whereas the opposite
 * degrade would silently break a trigger on any read blip).
 */
async function listPersonasRead(event, operationName) {
  if (!operationName || typeof operationName !== 'string') return [];
  var prefix = operationName + DELIM;
  try {
    connectLambda(event);
    var listResult = await store().list({ prefix: prefix });
    var seen = {};
    var out = [];
    (listResult.blobs || []).forEach(function (b) {
      if (!b || typeof b.key !== 'string') return;
      var suffix = b.key.slice(prefix.length);
      // Strictly a KNOWN persona key with no further delimiter — a longer
      // suffix (e.g. a different, longer operationName that happens to share
      // this prefix) is filtered out, never miscounted.
      if (suffix && suffix.indexOf(DELIM) === -1 && VALID_PERSONA_KEYS[suffix] && !seen[suffix]) {
        seen[suffix] = true;
        out.push(suffix);
      }
    });
    return out;
  } catch (e) {
    console.error('interp-read-store: read failed -- treating as nothing-read', e);
    return [];
  }
}

/** Convenience: how many distinct personas were read for `operationName` (0-5). */
async function countPersonasRead(event, operationName) {
  var list = await listPersonasRead(event, operationName);
  return list.length;
}

module.exports = { STORE_NAME, DELIM, VALID_PERSONA_KEYS, markRead, listPersonasRead, countPersonasRead };
