// netlify/functions/lib/support-store.js
//
// Backing store for submit-support-message.js — the "dedicated place"
// half of Ron's support/feedback request (see tracker.html's
// support-and-feedback-atms4a item): every support/feedback submission
// gets emailed to the founder (via Resend, see submit-support-message.js)
// AND persisted here, so a later Claude Code session can read the real
// history back (get-support-messages.js) instead of relying solely on
// the email having landed and stayed in Ron's inbox. Not a Netlify
// Function itself — a plain module submit-support-message.js/
// get-support-messages.js both require(), matching this codebase's
// existing "self-contained function, shared bits in a plain require()"
// pattern (see entitlements.js, paywall-settings.js, tracker-store.js).
//
// Backed by a single Netlify Blobs store ("dreamtube-support-messages"),
// ONE KEY ("messages") whose value is the full append-only messages
// array — same small-record singleton-key pattern as tracker-store.js's
// "items" key, just append-only (no per-item update/delete — unlike the
// tracker, nothing here is ever mutated after submission; a reply is a
// real email Ron sends from his own inbox, not something this app models
// or stores, see submit-support-message.js's header comment for why that
// stays a manual step for now). Uses Blobs' default eventual consistency
// (not strong) — same reasoning as every other Blobs-backed store in
// this codebase: strong consistency threw BlobsConsistencyError
// unconditionally in this deploy environment.
//
// Message shape: { id, type: "support"|"feedback", username, email,
//   message, videoCount: number|null, daysSinceSignup: number|null,
//   submittedAt: string (ISO) }
//
// videoCount/daysSinceSignup are CLIENT-SUPPLIED, not independently
// verified server-side — see submit-support-message.js's own header
// comment for why (dreams/signup-time live only in each browser's
// localStorage today, js/store.js's whole account/dream model, so there
// is no server-side source of truth to check them against yet). Treated
// as informational context for a human reading the message, same trust
// level this codebase already extends to other client-reported account
// facts (e.g. generate-video.js's client-supplied email) — never used
// for any access-control or spend decision.
//
// CONCURRENT-WRITE RACE — same shape as tracker-store.js's addItem/
// deleteItem (see that file's own CONCURRENT-WRITE RACE comment for the
// full writeup): a read-full-array -> push -> setJSON-the-full-array-back
// cycle, with no compare-and-swap primitive available in the installed
// @netlify/blobs SDK. Two genuinely concurrent submissions could each
// read the same base array and the second write could clobber the
// first's append. Mitigated (not eliminated) the same way tracker-store.js
// does: a bounded read-mutate-write-then-verify retry loop. Given this is
// a low-frequency, append-only write path (a real user submitting a
// support message, not a hot loop), the residual risk is accepted here
// exactly as it already is for the tracker.

var { getStore, connectLambda } = require('@netlify/blobs');

var STORE_NAME = 'dreamtube-support-messages';
var KEY = 'messages';
var MAX_WRITE_ATTEMPTS = 3;

function store() {
  return getStore({ name: STORE_NAME });
}

/** Returns the full messages array (empty if the store has never been written to yet). `event` is the calling function's Lambda event, passed through to connectLambda so this works from any Netlify Function. */
async function getMessages(event) {
  connectLambda(event);
  var messages = await store().get(KEY, { type: 'json' });
  return messages || [];
}

/**
 * Appends one new message and persists the full list. `entry` must
 * already be a complete, validated record (shape/validation is the
 * caller's job — see submit-support-message.js). Returns the entry as
 * stored. Goes through a bounded read-mutate-write-then-verify retry
 * loop — see the CONCURRENT-WRITE RACE comment above for what this does
 * and doesn't protect against.
 *
 * Each attempt checks `alreadyPresent` (by `entry.id`) against the FRESH
 * read before concatenating — mirrors tracker-store.js's addItem, and
 * for the exact same reason: a retry here isn't only triggered by a real
 * clobber from another writer, it's also triggered by our own verify-read
 * getting a false negative (this store's eventual consistency means a
 * read immediately after our own write isn't guaranteed to see it yet).
 * Without this check, that false-negative case would retry into a
 * SECOND, genuinely successful write of the same message once the first
 * write actually does propagate — i.e. `entry` landing twice in the
 * array, not just once. Checking `alreadyPresent` first makes a retry
 * against an already-landed entry a no-op (re-persists the same array
 * unchanged) instead of a duplicate append.
 */
async function appendMessage(event, entry) {
  var result = entry;
  for (var attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
    var messages = await getMessages(event);
    var alreadyPresent = messages.some(function (m) { return m.id === entry.id; });
    var next = alreadyPresent ? messages : messages.concat([entry]);

    connectLambda(event);
    await store().setJSON(KEY, next);

    connectLambda(event);
    var verifyMessages = await store().get(KEY, { type: 'json' });
    var landed = (verifyMessages || []).some(function (m) { return m.id === entry.id; });
    if (landed) return result;
  }
  return result;
}

module.exports = { STORE_NAME, KEY, getMessages, appendMessage };
