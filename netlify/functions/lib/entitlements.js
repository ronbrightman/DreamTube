// netlify/functions/lib/entitlements.js
//
// Shared entitlement helper, used by generate-video.js (the gate),
// get-token-status.js (the client-facing read), create-checkout-session.js
// (indirectly, via the email it collects), and stripe-webhook.js (the
// writer). Not a Netlify Function itself — a plain module other functions
// require(), matching this codebase's existing "self-contained function,
// shared bits in a plain require()" pattern rather than introducing a
// build step.
//
// Backed by a single Netlify Blobs store ("dreamtube-entitlements"),
// ONE RECORD PER NORMALIZED EMAIL:
//   { email, active, plan, stripeCustomerId, stripeSubscriptionId, updatedAt,
//     tokens: { balance, lastGrantAt } }
//
// ============================================================================
// TOKEN ECONOMY — replaces the old quota/subscription-entitlement model
// ----------------------------------------------------------------------------
// DreamTube's launch monetization model is consumption-based, not
// subscription-based: every user spends from a single "tokens" balance
// (100 tokens = one generation, uniformly for a brand-new generation, an
// edit/regenerate, or a style change — all three already funnel through the
// same generate-video.js call site, see that file). Balance is earned for
// free (200 on first read of a never-before-seen email, +100 every 24h,
// lazily, see below) until a payment processor exists — see shop.html and
// its "Coming soon" buttons. Because every token anyone can ever spend is
// free-earned today, this gate is UNCONDITIONAL AND LIVE FROM THE START,
// unlike the old subscription paywall (PAYWALL_ENABLED, E108/E111) which
// stayed default-off until real Stripe checkout existed — being entitled
// there required having actually paid, so gating on it before a checkout
// flow existed would have hard-blocked everyone. This model can never fully
// block anyone (the daily drip guarantees continued access), it just rate-
// limits free usage to a sustainable level. See generate-video.js's E112
// doc block and AGENT_POLICY.md for the full reasoning.
//
// `active`/`plan`/`stripeCustomerId`/`stripeSubscriptionId` are kept on the
// record shape but are NOT read by the generation gate anymore — the
// dormant Dodo/Stripe backend (see the claude/dodo-payments-backend branch)
// may still be reused later for one-time token-pack checkouts (see
// shop.html's $1.99/$8.95 packs) instead of subscriptions, so these fields
// stay meaningful for that, just unused here. isEntitled() below is kept
// for that same future reuse, even though nothing in this codebase calls it
// today.
//
// tokens.balance: the email's current spendable token count. Never goes
// negative (spendTokens floors at 0); the ≥500 daily-grant ceiling below is
// the only thing that keeps it from growing unbounded for an idle account.
//
// tokens.lastGrantAt: epoch-ms timestamp of the most recent grant this
// record actually received — either the one-time 200-token signup grant, or
// the most recent +100 daily drip. getTokenStatus lazily compares this
// against "now" on every read to decide whether a daily grant is due — the
// entire reset/grant mechanism, no scheduled function involved (this
// codebase has none and none should be added, see AGENT_POLICY.md), same
// shape of lazy-catch-up-on-read this file already used for the old
// system's monthly quota reset.
//
// Why a single lazy grant per read, not a multi-day catch-up loop: if an
// email goes unread for, say, 5 days, a strict "credit +100 for every full
// 24h elapsed" reading would hand it +500 in one shot. This file
// deliberately does the simpler thing instead — one +100 grant per lazy
// check, then lastGrantAt snaps to "now" — mirroring exactly how the old
// monthly quota reset never compounded across multiple skipped months
// either, it just snapped `used` to 0 once. This is the more conservative
// (cheaper, simpler to reason about) of the two readings of "100 tokens
// every 24 hours, granted lazily on read" and was chosen deliberately for
// that reason.
//
// ≥500 grant ceiling: getTokenStatus skips the +100 daily grant entirely
// (leaving lastGrantAt untouched, so the very next read re-checks
// immediately once the balance actually drops) once balance is already
// ≥500 (5 generations' worth) — an idle account that never spends must not
// silently accumulate unbounded free value while still fully honoring
// "100/day" for anyone actually using the product. See getTokenStatus.
//
// Per-IP daily cap on brand-new signup-bonus grants: see the big comment
// on syncTokens below for the abuse vector this closes and why it's
// enforced exactly at token-materialization time rather than as a separate
// signup-registration endpoint.
//
// Why keyed by normalized (trimmed, lowercased) email, not a new
// proprietary user-id: this project's only other "account" concept
// (js/store.js's `accounts`/`charactersByUser`) is already keyed by
// lowercased username, and email is the one identifier Stripe/Dodo
// Checkout, a future Google Sign-In ID token, and a future Apple Sign-In ID
// token all naturally produce — so keying entitlements on email lets
// Apple/Google Sign-In be added later purely additively (resolve to an
// email, hit this same lookup), with no migration of paid entitlements or
// token balances. See the founder's infrastructure research
// (payment-providers-v2.md / infrastructure-v2.md) for the full reasoning.
//
// Why Blobs is fine here (and isn't the same tradeoff as get-feed.js's
// shared array): every write here is a single keyed idempotent overwrite of
// one user's own record — two different users' writes never touch the same
// key, so there's no read-modify-write race on a shared collection the way
// the feed has (see get-feed.js's header comment). The realistic races here
// (two near-simultaneous generate-video.js requests from the same email
// both reading the same pre-spend balance, or a lazy grant firing twice)
// are the same class of narrow last-write-wins race rate-limit.js's own
// header comment already accepts for this deploy — Netlify Blobs has no
// compare-and-swap primitive — and are bounded in impact: at most a handful
// of tokens of drift, never unbounded, and E109/E110 (rate limit + daily
// spend circuit breaker, both untouched by this change, see
// generate-video.js) remain the real backstop against runaway cost
// regardless of how this counter drifts.
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
var rateLimit = require('./rate-limit');

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
 * yet (never granted tokens, never paid, or paid under a different email).
 * `event` is the calling function's Lambda event — passed through to
 * connectLambda so this works from any Netlify Function without each one
 * needing its own Blobs bootstrapping.
 */
async function getEntitlement(event, email) {
  var key = normalizeEmail(email);
  if (!key) return null;
  connectLambda(event);
  return (await store().get(key, { type: 'json' })) || null;
}

/**
 * True only if a record exists for this email AND its `active` flag is
 * true. NOT used by the generation gate anymore (see the token-economy doc
 * block above) — kept for the dormant Stripe/Dodo subscription/checkout
 * backend, which may reuse this if it comes back for one-time token-pack
 * purchases.
 */
async function isEntitled(event, email) {
  var record = await getEntitlement(event, email);
  return !!(record && record.active === true);
}

/**
 * Idempotent upsert — merges `patch` onto whatever record already exists
 * for this email (creating one if this is the first event for it) and
 * always stamps `updatedAt`. Used by stripe-webhook.js on
 * checkout.session.completed / customer.subscription.updated/deleted, and
 * by every token read/spend below.
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

var INITIAL_GRANT = 200;
var DAILY_GRANT_AMOUNT = 100;
var GRANT_CEILING = 500;
var GRANT_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Per-IP daily cap on brand-new-email token initializations — see
// AGENT_POLICY.md / the founder's token-economy spec for the abuse vector:
// js/store.js's signup() is 100% client-side (localStorage only, confirmed
// by reading it — there is no server touchpoint at account-creation time at
// all today), so a scripted attacker can create unlimited accounts purely
// to farm the 200-token signup bonus, each one worth ~$1.60-3.20 of real
// fal.ai generation cost with no payment and no email verification.
//
// Rather than inventing new server-side signup-registration plumbing just
// to enforce a rate limit (a new, wider surface for a narrow problem), this
// gates the actual moment the 200-token grant becomes real cost exposure:
// the first time syncTokens below ever materializes a balance for a given
// email (the `!record.tokens` branch), regardless of which caller triggered
// it (get-token-status.js's read, or generate-video.js's gate on a client
// that skipped the pre-check entirely). That's the simpler, more
// consistent-with-this-codebase's-existing-shape option the spec called
// out as likely preferable — same Blobs-counter pattern as
// lib/rate-limit.js's checkAndIncrement, scoped "token-init" so it shares
// nothing with generate-video.js's own "ip"/"email" generation-rate-limit
// buckets.
//
// A NEW email whose IP is already over today's cap does not get hard-
// blocked forever — it gets 0 tokens today (not the usual E112 rejection,
// since this isn't the generation gate) with lastGrantAt stamped to now, so
// the normal +100/24h lazy drip picks it up starting tomorrow exactly like
// any other account. This only ever runs once per email (the branch it's
// in is only reached while `tokens` has never been set), so a legitimate
// user is never repeatedly rate-limited just for reading their own
// already-initialized balance.
var MAX_TOKEN_GRANTS_PER_IP_PER_DAY_DEFAULT = 5;

/**
 * The actual lazy grant engine, shared by getTokenStatus (read) and
 * spendTokens (spend) so both always see the same up-to-date balance before
 * acting on it. Returns the raw `{ balance, lastGrantAt }` tokens sub-object
 * (already persisted if anything changed) — never the full public
 * getTokenStatus shape, callers that want that call getTokenStatus itself.
 *
 * Safe to call with an empty/missing email: returns a throwaway zero
 * balance and writes nothing, mirroring this file's existing "an
 * unidentifiable caller never creates a phantom record" discipline (see
 * the old getQuotaStatus, which had the same guard for the same reason).
 */
async function syncTokens(event, email) {
  var key = normalizeEmail(email);
  if (!key) return { balance: 0, lastGrantAt: Date.now() };

  var record = await getEntitlement(event, key);
  var now = Date.now();

  if (!record || !record.tokens) {
    // First-ever token read for this email — see the per-IP cap doc block
    // above for why this specific branch is where that limit is enforced.
    var maxInitPerIp = parseInt(process.env.MAX_TOKEN_GRANTS_PER_IP_PER_DAY, 10);
    if (!maxInitPerIp || maxInitPerIp <= 0) maxInitPerIp = MAX_TOKEN_GRANTS_PER_IP_PER_DAY_DEFAULT;
    var ip = rateLimit.clientIp(event);
    var ipCheck = await rateLimit.checkAndIncrement(event, 'token-init', ip, maxInitPerIp);

    var fresh = ipCheck.allowed
      ? { balance: INITIAL_GRANT, lastGrantAt: now }
      : { balance: 0, lastGrantAt: now }; // capped for today — see doc block above, not a permanent block

    await setEntitlement(event, key, { tokens: fresh });
    return fresh;
  }

  var tokens = record.tokens;
  var elapsed = now - (tokens.lastGrantAt || 0);
  if (elapsed >= GRANT_INTERVAL_MS && tokens.balance < GRANT_CEILING) {
    var granted = { balance: tokens.balance + DAILY_GRANT_AMOUNT, lastGrantAt: now };
    await setEntitlement(event, key, { tokens: granted });
    return granted;
  }
  // Either not due yet, or due but held back by the ≥500 ceiling — in the
  // ceiling case lastGrantAt is deliberately left untouched (not bumped to
  // `now`) so the very next read re-checks immediately once the balance
  // actually drops below the ceiling, rather than waiting a further 24h.
  return tokens;
}

/**
 * Reads this email's current token status, applying the lazy 200-token
 * first-ever-read grant and/or the lazy +100/24h drip (with its ≥500
 * ceiling) as needed — see the doc blocks above for the full mechanism.
 * Returns { balance, nextGrantAt, dailyGrantAmount }. nextGrantAt is an
 * epoch-ms timestamp (lastGrantAt + 24h) for the UI's live countdown (see
 * profile.html/style.html/result.html/processing.html/shop.html) — while
 * balance is held at the ≥500 ceiling this may already be in the past;
 * callers should treat that as "a grant is pending, due as soon as balance
 * drops", not render a negative countdown.
 */
async function getTokenStatus(event, email) {
  var tokens = await syncTokens(event, email);
  return {
    balance: tokens.balance,
    nextGrantAt: tokens.lastGrantAt + GRANT_INTERVAL_MS,
    dailyGrantAmount: DAILY_GRANT_AMOUNT
  };
}

/**
 * Deducts `amount` tokens from this email's balance, called only from
 * generate-video.js's successful (200) paths — mock mode and a real fal
 * success alike — never on a submission rejection (E105/E106) or a network
 * failure reaching fal (E107), since no real spend happened on those paths.
 * Same call-site discipline the old recordGenerationUsage enforced for the
 * quota system it replaced. Floors at 0 (a balance can never go negative,
 * even under the narrow last-write-wins race this file's header comment
 * already accepts). No-ops (returns null, writes nothing) for an empty/
 * missing email, matching syncTokens' own guard.
 */
async function spendTokens(event, email, amount) {
  var key = normalizeEmail(email);
  if (!key) return null;
  var tokens = await syncTokens(event, key);
  var newBalance = Math.max(0, tokens.balance - amount);
  return setEntitlement(event, key, { tokens: { balance: newBalance, lastGrantAt: tokens.lastGrantAt } });
}

module.exports = {
  STORE_NAME,
  normalizeEmail,
  getEntitlement,
  isEntitled,
  setEntitlement,
  getTokenStatus,
  spendTokens
};
