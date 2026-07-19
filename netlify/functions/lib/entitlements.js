// netlify/functions/lib/entitlements.js
//
// Shared entitlement helper, used by generate-video.js (the gate),
// create-checkout-session.js (indirectly, via the email it collects),
// and stripe-webhook.js (the writer). Not a Netlify Function itself —
// a plain module other functions require(), matching this codebase's
// existing "self-contained function, shared bits in a plain require()"
// pattern rather than introducing a build step.
//
// Backed by a single Netlify Blobs store ("dreamtube-entitlements"),
// ONE RECORD PER NORMALIZED EMAIL:
//   { email, active, plan, stripeCustomerId, stripeSubscriptionId, updatedAt }
//
// Why keyed by normalized (trimmed, lowercased) email, not a new
// proprietary user-id: this project's only other "account" concept
// (js/store.js's `accounts`/`charactersByUser`) is already keyed by
// lowercased username, and email is the one identifier Stripe Checkout,
// a future Google Sign-In ID token, and a future Apple Sign-In ID token
// all naturally produce — so keying entitlements on email lets
// Apple/Google Sign-In be added later purely additively (resolve to an
// email, hit this same lookup), with no migration of paid entitlements.
// See the founder's infrastructure research (payment-providers-v2.md /
// infrastructure-v2.md) for the full reasoning.
//
// Why Blobs is fine here (and isn't the same tradeoff as get-feed.js's
// shared array): every write here is a single keyed idempotent
// overwrite of one user's own record — two different users' writes
// never touch the same key, so there's no read-modify-write race on a
// shared collection the way the feed has (see get-feed.js's header
// comment). The only realistic race is the same email's webhook firing
// twice (Stripe retries webhooks) or a webhook landing close to another
// event for the same subscription — and because the value written is
// idempotent status (not a counter/array append), writing "active"
// twice in either order lands on the same correct end state.
//
// Reads were originally requested with Blobs' strong-consistency mode (a
// paying user must never be told "not entitled" for up to a minute right
// after paying) but that mode threw BlobsConsistencyError ("the
// environment has not been configured with a 'uncachedEdgeURL' property")
// on every single call in this deployment, taking down generate-video.js
// entirely — not a graceful degrade, an unconditional 502 for every
// request. Reverted to Blobs' default eventual consistency (edge
// propagation up to ~60s) as the only thing that actually works here;
// revisit strong consistency only after confirming it's supported in the
// real target deploy environment, not before.

var { getStore, connectLambda } = require('@netlify/blobs');

var STORE_NAME = 'dreamtube-entitlements';

/** Trims + lowercases an email so every caller keys/looks up consistently. Returns '' for anything falsy/non-string. */
function normalizeEmail(email) {
  return (typeof email === 'string' ? email : '').trim().toLowerCase();
}

function store() {
  return getStore({ name: STORE_NAME });
}

/**
 * Looks up the raw entitlement record for an email, or null if none exists
 * yet (never paid, or paid under a different email). `event` is the
 * calling function's Lambda event — passed through to connectLambda so
 * this works from any Netlify Function without each one needing its own
 * Blobs bootstrapping.
 */
async function getEntitlement(event, email) {
  var key = normalizeEmail(email);
  if (!key) return null;
  connectLambda(event);
  return (await store().get(key, { type: 'json' })) || null;
}

/** True only if a record exists for this email AND its `active` flag is true (covers canceled/past_due/never-paid alike). */
async function isEntitled(event, email) {
  var record = await getEntitlement(event, email);
  return !!(record && record.active === true);
}

/**
 * Idempotent upsert — merges `patch` onto whatever record already exists
 * for this email (creating one if this is the first event for it) and
 * always stamps `updatedAt`. Used by stripe-webhook.js on
 * checkout.session.completed / customer.subscription.updated/deleted.
 *
 * Keys in `patch` whose value is `undefined` are dropped before merging
 * (rather than passed straight to Object.assign) so a caller that didn't
 * have, say, a plan name for this particular event can't accidentally
 * blank out a plan value a previous event already recorded — Stripe
 * doesn't always echo every field on every event type.
 */
async function setEntitlement(event, email, patch) {
  var key = normalizeEmail(email);
  if (!key) throw new Error('email_required');
  connectLambda(event);
  var s = store();
  var existing = (await s.get(key, { type: 'json' })) || { email: key };
  var cleanPatch = {};
  Object.keys(patch || {}).forEach(function (k) {
    if (patch[k] !== undefined) cleanPatch[k] = patch[k];
  });
  var record = Object.assign({}, existing, cleanPatch, { email: key, updatedAt: Date.now() });
  await s.setJSON(key, record);
  return record;
}

module.exports = { STORE_NAME, normalizeEmail, getEntitlement, isEntitled, setEntitlement };
