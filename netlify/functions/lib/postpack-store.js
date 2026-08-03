// netlify/functions/lib/postpack-store.js
//
// Durable storage of every "post pack" item ever assembled by
// assemble-instagram-tiktok-postpack.js (tracker item
// for-product-instagram-tiktok-auto-postin-cahr76, Manager's SPEC v1 —
// manual-export MVP). This is what postpack-*.html's owner-only page
// actually reads to render the grid the founder downloads-and-posts from
// — the nightly job's own run is otherwise invisible to a human unless
// its output lands somewhere durable and reviewable at leisure, not just
// a one-off console.log on a scheduled invocation nobody watches.
//
// Backed by a single Netlify Blobs store ("dreamtube-postpack-items"), ONE
// KEY ("items") whose value is the full append-only items array — same
// small-record singleton-key pattern as lib/moderation-store.js's own
// "reports" key (a genuinely comparable shape: low-frequency, append-only,
// read back as a whole list by an owner-only page). Not folded into
// moderation-store.js itself — a post-pack item is a completely different
// record shape/lifecycle (caption/hashtags/media for a human to post) with
// nothing conceptually in common with a content report beyond "also a
// small append-only list," so a dedicated store keeps each one legible on
// its own, matching this codebase's established "small single-purpose
// store" convention (see moderation-store.js's own header comment making
// the identical case against folding into tracker-store.js).
//
// CONCURRENT-WRITE RACE — same shape, same accepted mitigation, as
// moderation-store.js's own appendReport: a read-full-array ->
// concat-if-not-already-present -> write-the-full-array-back cycle via
// lib/blobs-retry.js's bounded retry loop, not a real compare-and-swap.
// Given the write frequency here is at most 2/day (one per channel, see
// the assembler's own per-channel-per-day dedup key), the residual risk
// is negligible — this store's own writer never runs more than once a day
// per channel by construction, let alone concurrently with itself.
//
// The NEVER-REPEAT-A-DREAM and MAX-1-PER-DAY-PER-CHANNEL guarantees are
// NOT enforced here — this store is a plain append-only list with no
// dedup logic of its own. Those guarantees live in
// lib/push-dedup-store.js's existing markSentOnce/hasSent (reused, not
// reinvented — see assemble-instagram-tiktok-postpack.js's own header
// comment for why that store, not a new one, is the right fit) and are
// enforced by the caller BEFORE it ever calls appendItem here.

var { getStore, connectLambda } = require('@netlify/blobs');
var blobsRetry = require('./blobs-retry');

var STORE_NAME = 'dreamtube-postpack-items';
var KEY = 'items';
var MAX_WRITE_ATTEMPTS = 3;

function store() {
  return getStore(STORE_NAME);
}

/** Returns the full pack-items array (empty if the store has never been written to yet). */
async function getItems(event) {
  connectLambda(event);
  var items = await store().get(KEY, { type: 'json' });
  return items || [];
}

/**
 * Appends one new pack item and persists the full list. `item` must
 * already be a complete record with a real `id` — shape/validation is the
 * caller's job (assemble-instagram-tiktok-postpack.js), same division of
 * labor lib/dream-store.js's upsertPrivateDream documents for its own
 * caller. Idempotent by id (a retry landing on an already-present id is a
 * no-op, not a duplicate) — same "check alreadyPresent before
 * concatenating" shape as moderation-store.js's own appendReport, and for
 * the identical reason: a retry here can be triggered by our OWN
 * verify-read getting a false negative under Blobs' eventual consistency,
 * not only by a genuine concurrent writer.
 */
async function appendItem(event, item) {
  await blobsRetry.retryingWrite(event, STORE_NAME, KEY, {
    maxAttempts: MAX_WRITE_ATTEMPTS,
    read: getItems,
    mutate: function (items) {
      var alreadyPresent = items.some(function (it) { return it.id === item.id; });
      return alreadyPresent ? items : items.concat([item]);
    },
    verify: function (verifyItems) {
      return (verifyItems || []).some(function (it) { return it.id === item.id; });
    }
  });
  return item;
}

module.exports = { STORE_NAME: STORE_NAME, KEY: KEY, getItems: getItems, appendItem: appendItem };
