// netlify/functions/lib/push-subscription-store.js
//
// Durable, cross-device storage of a signed-in account's Web Push
// subscriptions — tracker item for-product-build-stage-0-pwa-web-push-
// f-jbutt5, part 3 ("Store subscriptions in Blobs ... key it by something
// durable like username/email"). Follows this codebase's established
// small-single-purpose-lib-file convention (lib/first-dream-email-store.js,
// lib/job-owners.js, lib/dream-share-token.js) rather than folding this
// into a larger file.
//
// Backed by a single Netlify Blobs store ("dreamtube-push-subscriptions"),
// ONE RECORD PER NORMALIZED USERNAME:
//   { username, subscriptions: [ { endpoint, keys: { p256dh, auth }, addedAt } ], updatedAt }
//
// Keyed by USERNAME, not email, deliberately: the two real call sites that
// need to resolve a subscription both already have a username on hand by
// the time they get here —
//   - save-push-subscription.js: the client already knows its own signed-in
//     username (DreamStore.getCurrentUser().username), same identity model
//     every other client-authenticated write in this codebase uses (no
//     session/auth token exists at all — see lib/job-owners.js's header
//     comment on generate-video.js's own email-as-identity precedent; this
//     store follows the SAME "no server session, client states its own
//     already-signed-in identity" model, not a stricter one, since a
//     confused/duplicate push notification is a much lower-stakes mistake
//     than the money/account-takeover concerns that made session-transfer's
//     endpoint require a real password check).
//   - mark-generation-completed.js's video-ready push (see that file):
//     already resolves `account.username` via accountStore.getByEmail
//     right before it would need this store, for the exact same reason
//     the automatic first-dream email does.
//   - the daily-claim-available scheduled job (send-daily-claim-pushes.js):
//     scans lib/entitlements.js's OWN store (keyed by email, since token
//     balances are email-keyed there), and for each candidate email
//     resolves username via accountStore.getByEmail before reading this
//     store — same resolution step as the video-ready path.
//
// MULTIPLE SUBSCRIPTIONS PER ACCOUNT: an account can be signed in on more
// than one device/browser (a phone AND a desktop, e.g.), and each
// pushManager.subscribe() call produces its own distinct endpoint — so
// this stores an ARRAY, keyed internally by `endpoint` (a subscription's
// own unique push-service URL), not a single subscription per account.
// addOrUpdateSubscription is idempotent on endpoint: re-subscribing the
// same device (e.g. after a browser-cleared-and-re-granted permission)
// updates that one entry in place rather than accumulating duplicates.
// Capped at MAX_SUBSCRIPTIONS_PER_ACCOUNT — oldest (by addedAt) evicted
// first — so one account somehow re-subscribing many times (a bug, or
// literally many real devices) can't grow this record unboundedly.
//
// NOT idempotency-critical the same way lib/entitlements.js's token
// ledger is (see lib/job-owners.js's own header comment on this same
// distinction) — a plain read-modify-write is used, not
// lib/blobs-retry.js's guarded retry loop. The worst case of a lost
// concurrent write here is a device's subscription not getting saved on
// its very first attempt (the browser's own pushManager.subscribe() call
// already succeeded regardless — this store just failed to durably record
// it), which self-heals the next time that device is subscribed again
// (js/push-subscribe.js re-POSTs on every processing.html load until the
// device is known-subscribed — see that file's own doc comment) — a
// narrow, low-stakes, self-correcting race, not the kind of double-spend/
// double-send hazard blobs-retry.js exists to prevent.

var { getStore, connectLambda } = require('@netlify/blobs');

var STORE_NAME = 'dreamtube-push-subscriptions';
var MAX_SUBSCRIPTIONS_PER_ACCOUNT = 8;

function store() {
  return getStore({ name: STORE_NAME });
}

function normalizeUsername(username) {
  return (typeof username === 'string' ? username : '').trim().toLowerCase();
}

/** Returns the full subscription array for `username` (empty array if none/never subscribed). Never throws — a Blobs read failure degrades to "no subscriptions known", same honest-degrade posture as every other best-effort store in this codebase. */
async function getSubscriptions(event, username) {
  var key = normalizeUsername(username);
  if (!key) return [];
  try {
    connectLambda(event);
    var record = await store().get(key, { type: 'json' });
    return (record && Array.isArray(record.subscriptions)) ? record.subscriptions : [];
  } catch (e) {
    console.error('push-subscription-store: read failed for ' + key, e);
    return [];
  }
}

/**
 * Adds (or, if this exact endpoint is already on file, updates) one Web
 * Push subscription for `username`. `subscription` is the raw object
 * `PushSubscription.toJSON()` produces client-side: { endpoint, keys: {
 * p256dh, auth } }. Returns { ok: true } / { ok: false, error }.
 */
async function addOrUpdateSubscription(event, username, subscription) {
  var key = normalizeUsername(username);
  if (!key) return { ok: false, error: 'invalid_username' };
  if (!subscription || typeof subscription.endpoint !== 'string' || !subscription.endpoint) {
    return { ok: false, error: 'invalid_subscription' };
  }
  if (!subscription.keys || typeof subscription.keys.p256dh !== 'string' || typeof subscription.keys.auth !== 'string') {
    return { ok: false, error: 'invalid_subscription_keys' };
  }

  try {
    connectLambda(event);
    var record = await store().get(key, { type: 'json' });
    var subs = (record && Array.isArray(record.subscriptions)) ? record.subscriptions.slice() : [];

    var now = Date.now();
    var existingIdx = -1;
    for (var i = 0; i < subs.length; i++) {
      if (subs[i].endpoint === subscription.endpoint) { existingIdx = i; break; }
    }
    var entry = { endpoint: subscription.endpoint, keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth }, addedAt: now };
    if (existingIdx !== -1) {
      subs[existingIdx] = entry;
    } else {
      subs.push(entry);
    }
    // Evict oldest first if over the cap -- see header comment.
    if (subs.length > MAX_SUBSCRIPTIONS_PER_ACCOUNT) {
      subs.sort(function (a, b) { return a.addedAt - b.addedAt; });
      subs = subs.slice(subs.length - MAX_SUBSCRIPTIONS_PER_ACCOUNT);
    }

    connectLambda(event);
    await store().setJSON(key, { username: key, subscriptions: subs, updatedAt: now });
    return { ok: true };
  } catch (e) {
    console.error('push-subscription-store: write failed for ' + key, e);
    return { ok: false, error: 'write_failed' };
  }
}

/**
 * Removes one subscription by endpoint — called by
 * lib/push-sender.js when the push service itself reports the
 * subscription is gone (HTTP 404/410, the standard Web Push signal for
 * "this endpoint will never accept another push" — see that file's own
 * doc comment), so a permanently-dead subscription doesn't keep getting
 * retried forever. Best-effort, never throws.
 */
async function removeSubscription(event, username, endpoint) {
  var key = normalizeUsername(username);
  if (!key || !endpoint) return { ok: false };
  try {
    connectLambda(event);
    var record = await store().get(key, { type: 'json' });
    if (!record || !Array.isArray(record.subscriptions)) return { ok: false };
    var filtered = record.subscriptions.filter(function (s) { return s.endpoint !== endpoint; });
    if (filtered.length === record.subscriptions.length) return { ok: false }; // wasn't present -- nothing to do
    connectLambda(event);
    await store().setJSON(key, { username: key, subscriptions: filtered, updatedAt: Date.now() });
    return { ok: true };
  } catch (e) {
    console.error('push-subscription-store: removeSubscription failed for ' + key, e);
    return { ok: false };
  }
}

module.exports = {
  STORE_NAME,
  MAX_SUBSCRIPTIONS_PER_ACCOUNT,
  normalizeUsername,
  getSubscriptions,
  addOrUpdateSubscription,
  removeSubscription
};
