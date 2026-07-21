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
//   { email, active, plan, stripeCustomerId, stripeSubscriptionId, updatedAt,
//     quota: { includedPerMonth, used, periodKey }, bonusCredits }
//
// quota/bonusCredits (usage-quota/credits system, generate-video.js's E111
// gate) are additive to the shape above, not new top-level concepts: same
// one-record-per-email store, same setEntitlement idempotent-merge upsert.
//   - quota.includedPerMonth: generations included per calendar month —
//     10 on every plan today (Monthly and Yearly both include the same
//     cap; see docs on the founder-approved parameters).
//   - quota.used: how many of those this email has spent so far in
//     quota.periodKey.
//   - quota.periodKey: "YYYY-MM" in UTC — the month this `used` count is
//     for. There is no scheduled/background job that resets this on the
//     1st of the month (this codebase has no scheduled functions at all,
//     see AGENT_POLICY.md) — instead getQuotaStatus below lazily resets
//     `used` to 0 the first time it's read in a new UTC month. This is
//     the entire reset mechanism, not a stopgap for one.
//   - bonusCredits: extra generations bought as a top-up (see
//     grant-topup-bonus.js). Never expires, never reset by the monthly
//     rollover above — spent only after the monthly included quota is
//     exhausted (see recordGenerationUsage).
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

var DEFAULT_INCLUDED_PER_MONTH = 10;

/** "YYYY-MM" in UTC — the quota period key for "right now". See the quota doc block above for why this (not a scheduled job) is the entire monthly-reset mechanism. */
function currentPeriodKeyUtc() {
  var now = new Date();
  var month = now.getUTCMonth() + 1;
  return now.getUTCFullYear() + '-' + (month < 10 ? '0' : '') + month;
}

/**
 * Reads this email's generation-quota status, lazily resetting `used` to 0
 * the moment it notices `quota.periodKey` no longer matches the current UTC
 * "YYYY-MM" (a new month has started since this was last read) — the whole
 * reset mechanism for this feature, see the doc block above. The reset is
 * persisted back via the existing idempotent setEntitlement merge, but only
 * when a record already exists for this email — an email with no
 * entitlement record at all (never subscribed) has nothing worth writing,
 * and gets sensible defaults (`active:false`, a full month of quota) without
 * ever creating a phantom record purely from being read.
 *
 * Returns { active, plan, includedPerMonth, used, remaining, bonusCredits,
 * effectiveRemaining }. `remaining` is the monthly-included balance only;
 * `effectiveRemaining` folds in bonusCredits too — that's the number
 * generate-video.js's E111 gate actually checks against.
 */
async function getQuotaStatus(event, email) {
  var record = await getEntitlement(event, email);
  var active = !!(record && record.active === true);
  var periodKey = currentPeriodKeyUtc();
  var includedPerMonth = (record && record.quota && typeof record.quota.includedPerMonth === 'number')
    ? record.quota.includedPerMonth
    : DEFAULT_INCLUDED_PER_MONTH;
  var used = 0;

  if (record && record.quota && record.quota.periodKey === periodKey) {
    used = record.quota.used || 0;
  } else if (record) {
    record = await setEntitlement(event, email, {
      quota: { includedPerMonth: includedPerMonth, used: 0, periodKey: periodKey }
    });
    used = 0;
  }

  var bonusCredits = (record && typeof record.bonusCredits === 'number') ? record.bonusCredits : 0;
  var remaining = Math.max(0, includedPerMonth - used);

  return {
    active: active,
    plan: (record && record.plan) || null,
    includedPerMonth: includedPerMonth,
    used: used,
    remaining: remaining,
    bonusCredits: bonusCredits,
    effectiveRemaining: remaining + bonusCredits
  };
}

/**
 * Records one spent generation against this email, called only from
 * generate-video.js's successful (200) paths — a fal submission rejection
 * must never reach this, since no real spend happened (see that file's
 * E105/E106/E107 handling). Spends the monthly included quota first, then
 * falls back to bonusCredits once the month's included amount is used up —
 * matching the order generate-video.js's E111 check itself reads them in
 * (remaining, then bonusCredits, via effectiveRemaining).
 *
 * No-ops (returns null, writes nothing) for an empty/missing email — most
 * commonly a logged-in account that hasn't added an email yet, which is a
 * normal, common state in this app (see js/store.js's account model), not
 * an error worth surfacing from a 200 response.
 */
async function recordGenerationUsage(event, email) {
  var key = normalizeEmail(email);
  if (!key) return null;
  var status = await getQuotaStatus(event, key);
  if (status.used < status.includedPerMonth) {
    return setEntitlement(event, key, {
      quota: { includedPerMonth: status.includedPerMonth, used: status.used + 1, periodKey: currentPeriodKeyUtc() }
    });
  }
  return setEntitlement(event, key, { bonusCredits: Math.max(0, status.bonusCredits - 1) });
}

module.exports = { STORE_NAME, normalizeEmail, getEntitlement, isEntitled, setEntitlement, getQuotaStatus, recordGenerationUsage };
