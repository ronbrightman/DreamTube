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
//     tokens: { balance, lastGrantAt },
//     appliedTokenPackPaymentIds, refundedJobIds,
//     firstPackPurchaseAt }
//
// refundedJobIds: a short-lived per-email list of generation job ids
// (operationName values) whose spend is in the process of being (or has
// just been) refunded — same "short-lived, pruned once its outer marker
// commits" shape as appliedTokenPackPaymentIds, just for refunds instead
// of purchases. See refundTokensOnce's own doc block (near the bottom of
// this file) for the full two-phase-marker mechanism and
// forgetRefundedJobId for the pruning.
//
// appliedTokenPackPaymentIds: a short-lived array of Dodo payment_ids whose
// token-pack credit has already been applied to `tokens.balance` — see
// creditTokenPackAmountOnce below for why this needs to live in the SAME
// record (and get written in the SAME setJSON call) as the balance it
// guards. Nothing else about it is interesting on its own:
// forgetAppliedTokenPack prunes an entry the moment its purchase is fully
// committed (see creditTokenPackOnce), so in steady state this array is
// normally empty — it only holds entries while a credit is genuinely
// in-flight or was interrupted mid-way.
//
// firstPackPurchaseAt: epoch-ms timestamp stamped the first time this email
// ever completes a token-pack credit, by creditTokenPackAmountOnce — unlike
// appliedTokenPackPaymentIds this is NEVER pruned, since its whole job is
// to durably answer "has this account ever bought a pack before" for the
// one-time +50% first-purchase bonus (see creditTokenPackAmountOnce below).
// Deliberately its own field rather than reusing
// appliedTokenPackPaymentIds.length — that array is transient by design
// (pruned back to empty in steady state), so it can't answer "ever", only
// "currently mid-flight".
//
// ============================================================================
// TOKEN ECONOMY — replaces the old quota/subscription-entitlement model
// ----------------------------------------------------------------------------
// DreamTube's launch monetization model is consumption-based, not
// subscription-based: every user spends from a single "tokens" balance
// (100 tokens = one video generation, uniformly for a brand-new generation,
// an edit/regenerate, or a style change — all three already funnel through
// the same generate-video.js call site, see that file; a cheaper 10-token
// image generation was added later, see generate-image.js). Balance is
// earned for free (220 on first read of a never-before-seen email, +20
// every 24h, lazily, see below — the daily amount was retuned 2026-07-24
// from the original 200/+100 to 290/+10 so a new signup nets exactly 190
// tokens after its one free onboarding video, then raised 2026-07-26
// (morning) from +10 to +200/day (2 fresh videos' worth) after new users
// were found to choke once the 290-token signup grant ran out and the +10
// trickle left them stuck for days, then retuned again 2026-07-26 (night,
// "Token Economy C", founder-approved) to 220 initial / +20 per day / 200
// ceiling — 220 covers the funnel's free onboarding video (100) plus one
// additional day-1 video (100) plus 2 images (20); the daily drip was cut
// back down to +20 once real token packs (see the 3-pack lineup below)
// existed as the actual "need more, buy more" path, rather than a fast
// free drip doing that job. 220 > the new 200 ceiling is deliberate and
// fine — see the GRANT_CEILING doc comment below — the drip simply
// resumes once balance actually drops below 200) — this remains true even
// now that shop.html's token packs are a live, real purchase (see
// creditTokenPackOnce below and
// docs/PAYWALL_SETUP.md): the free grant and paid packs are both additive
// to the same balance, never either/or. Because every token anyone can
// ever spend was, from day one, either free-earned or (now) purchased —
// never gated behind a subscription that had to exist first — this gate
// is UNCONDITIONAL AND LIVE FROM THE START, unlike the old subscription
// paywall (PAYWALL_ENABLED, E108/E111) which stayed default-off until real
// Stripe checkout existed — being entitled there required having actually
// paid, so gating on it before a checkout flow existed would have
// hard-blocked everyone. This model can never fully
// block anyone (the daily drip guarantees continued access), it just rate-
// limits free usage to a sustainable level. See generate-video.js's E112
// doc block and AGENT_POLICY.md for the full reasoning.
//
// `active`/`plan`/`stripeCustomerId`/`stripeSubscriptionId` are kept on the
// record shape but are NOT read by the generation gate anymore — the
// dormant Stripe subscription backend (create-checkout-session.js /
// stripe-webhook.js) stays inert code-wise, so these fields stay meaningful
// for that if it's ever revived, just unused here. isEntitled() below is
// kept for that same reason, even though nothing in this codebase calls it
// today. The Dodo Payments backend (create-checkout-session-dodo.js /
// dodo-webhook.js), by contrast, is now LIVE and wired to shop.html's
// 3-pack one-time token-pack purchases (pack100/pack300/pack700 — see
// create-checkout-session-dodo.js) — see creditTokenPackOnce
// below, which is what dodo-webhook.js actually calls on a confirmed
// payment. It does not touch `active`/`plan` at all (that's a subscription
// concept); a token-pack purchase is a straight balance credit via
// addTokens, plus a one-time +50% first-purchase bonus (see
// creditTokenPackAmountOnce's `firstPackPurchaseAt` handling below).
//
// tokens.balance: the email's current spendable token count. Never goes
// negative (spendTokens floors at 0); the ≥200 daily-grant ceiling below is
// the only thing that keeps it from growing unbounded for an idle account.
//
// tokens.lastGrantAt: epoch-ms timestamp of the most recent grant this
// record actually received — either the one-time 220-token signup grant, or
// the most recent +20 daily drip. getTokenStatus lazily compares this
// against "now" on every read to decide whether a daily grant is due — the
// entire reset/grant mechanism, no scheduled function involved (this
// codebase has none and none should be added, see AGENT_POLICY.md), same
// shape of lazy-catch-up-on-read this file already used for the old
// system's monthly quota reset.
//
// Why a single lazy grant per read, not a multi-day catch-up loop: if an
// email goes unread for, say, 5 days, a strict "credit +20 for every full
// 24h elapsed" reading would hand it +100 in one shot. This file
// deliberately does the simpler thing instead — one +20 grant per lazy
// check, then lastGrantAt snaps to "now" — mirroring exactly how the old
// monthly quota reset never compounded across multiple skipped months
// either, it just snapped `used` to 0 once. This is the more conservative
// (cheaper, simpler to reason about) of the two readings of "20 tokens
// every 24 hours, granted lazily on read" and was chosen deliberately for
// that reason.
//
// ≥200 grant ceiling: getTokenStatus skips the +20 daily grant entirely
// (leaving lastGrantAt untouched, so the very next read re-checks
// immediately once the balance actually drops) once balance is already
// ≥200 (2 video generations' worth, or 20 image generations' worth) — an
// idle account that never spends must not silently accumulate unbounded
// free value while still fully honoring "20/day" for anyone actually using
// the product. Note the brand-new 220-token signup grant is deliberately
// ABOVE this 200 ceiling — that's fine and intentional (see the doc block
// at the top of this file): the drip simply stays paused until the account
// actually spends down below 200, exactly the same "skip while ≥ceiling"
// logic already handles for any other reason a balance sits at/above it.
// See getTokenStatus.
//
// Per-IP daily cap on brand-new signup-bonus grants: see the big comment
// on syncTokens below for what this raises the cost of and why it's
// enforced exactly at token-materialization time rather than as a separate
// signup-registration endpoint. It only raises the cost of casual
// single-IP farming — a determined attacker with rotating IPs can still
// exceed it, bounded by the existing E109/E110 backstops (unrelated to
// this change), not by this cap.
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

var crypto = require('crypto');
var { getStore, connectLambda } = require('@netlify/blobs');
var rateLimit = require('./rate-limit');
var blobsRetry = require('./blobs-retry');
var jobOwners = require('./job-owners');

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

// "Token Economy C" (founder-approved 2026-07-26 night) — see the doc
// block at the top of this file for the full retune history/reasoning.
// 220 initial = free funnel video (100) + one additional day-1 video (100)
// + 2 images (20). 220 > GRANT_CEILING (200) is intentional: the drip
// simply resumes once balance actually drops below 200 — do not add
// special-casing to force the initial grant under the ceiling.
var INITIAL_GRANT = 220;
var DAILY_GRANT_AMOUNT = 20;
var GRANT_CEILING = 200;
var GRANT_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Per-IP daily cap on brand-new-email token initializations — see
// AGENT_POLICY.md / the founder's token-economy spec for the abuse vector:
// js/store.js's signup() is 100% client-side (localStorage only, confirmed
// by reading it — there is no server touchpoint at account-creation time at
// all today), so a scripted attacker can create unlimited accounts purely
// to farm the 220-token signup bonus, each one worth up to ~$1.60-3.20 of
// real fal.ai generation cost with no payment and no email verification.
//
// Rather than inventing new server-side signup-registration plumbing just
// to enforce a rate limit (a new, wider surface for a narrow problem), this
// gates the actual moment the 220-token grant becomes real cost exposure:
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
// the normal +20/24h lazy drip picks it up starting tomorrow exactly like
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
 *
 * Optional 3rd arg `opts.ownerBypass` (default false — every existing
 * caller before this was added, and every caller other than
 * generate-video.js/generate-image.js's own getTokenStatus call today,
 * passes nothing and keeps the exact prior behavior): when true, skips
 * ONLY the per-IP token-init rate-limit check in the first-ever-read
 * branch immediately below, granting INITIAL_GRANT unconditionally instead
 * — see netlify/functions/lib/owner-bypass.js's header comment for the
 * full "owner testing on a rate-limited IP" mechanism this closes, and the
 * for-product-founder-hit-the-per-ip-gener-7mjq2l tracker item this
 * implements. Deliberately narrow: this flag is never read anywhere else
 * in this function or file — it has no effect on the ≥200 grant ceiling,
 * the +20/24h drip, spendTokens, addTokens, or (critically) the E112/E412
 * balance-threshold check itself, which callers apply completely
 * independently of this — a bypassed IP still gets exactly INITIAL_GRANT
 * (220) tokens, no more, same as any other brand-new email that simply
 * wasn't IP-capped.
 */
async function syncTokens(event, email, opts) {
  var key = normalizeEmail(email);
  if (!key) return { balance: 0, lastGrantAt: Date.now() };

  var record = await getEntitlement(event, key);
  var now = Date.now();
  // `firstPackPurchaseAt` lives at the TOP LEVEL of the entitlement record
  // (stamped by creditTokenPackAmountOnce, see its own doc comment), never
  // inside `record.tokens` — so it has to be read off `record` here and
  // carried through explicitly on every return path below, rather than
  // assumed to already be part of whatever `record.tokens` holds. Every
  // existing caller of syncTokens (spendTokens, addTokens,
  // creditTokenPackAmountOnce, refund crediting) explicitly picks only
  // `balance`/`lastGrantAt` back off this return value when building the
  // `tokens` sub-object it writes, so adding this field here never risks
  // it getting persisted into `record.tokens` itself.
  var firstPackPurchaseAt = record && record.firstPackPurchaseAt;

  if (!record || !record.tokens) {
    // First-ever token read for this email — see the per-IP cap doc block
    // above for why this specific branch is where that limit is enforced.
    var maxInitPerIp = parseInt(process.env.MAX_TOKEN_GRANTS_PER_IP_PER_DAY, 10);
    if (!maxInitPerIp || maxInitPerIp <= 0) maxInitPerIp = MAX_TOKEN_GRANTS_PER_IP_PER_DAY_DEFAULT;
    var ip = rateLimit.clientIp(event);
    var ownerBypassActive = !!(opts && opts.ownerBypass);
    var ipCheck = ownerBypassActive
      ? { allowed: true }
      : await rateLimit.checkAndIncrement(event, 'token-init', ip, maxInitPerIp);

    var fresh = ipCheck.allowed
      ? { balance: INITIAL_GRANT, lastGrantAt: now }
      : { balance: 0, lastGrantAt: now }; // capped for today — see doc block above, not a permanent block

    await setEntitlement(event, key, { tokens: fresh });
    return Object.assign({}, fresh, { firstPackPurchaseAt: firstPackPurchaseAt });
  }

  var tokens = record.tokens;
  var elapsed = now - (tokens.lastGrantAt || 0);
  if (elapsed >= GRANT_INTERVAL_MS && tokens.balance < GRANT_CEILING) {
    var granted = { balance: tokens.balance + DAILY_GRANT_AMOUNT, lastGrantAt: now };
    await setEntitlement(event, key, { tokens: granted });
    return Object.assign({}, granted, { firstPackPurchaseAt: firstPackPurchaseAt });
  }
  // Either not due yet, or due but held back by the ≥200 ceiling — in the
  // ceiling case lastGrantAt is deliberately left untouched (not bumped to
  // `now`) so the very next read re-checks immediately once the balance
  // actually drops below the ceiling, rather than waiting a further 24h.
  return Object.assign({}, tokens, { firstPackPurchaseAt: firstPackPurchaseAt });
}

/**
 * Reads this email's current token status, applying the lazy 220-token
 * first-ever-read grant and/or the lazy +20/24h drip (with its ≥200
 * ceiling) as needed — see the doc blocks above for the full mechanism.
 * Returns { balance, nextGrantAt, dailyGrantAmount, grantCeiling,
 * atCeiling }. nextGrantAt is an epoch-ms timestamp (lastGrantAt + 24h)
 * for the UI's live countdown (see profile.html/style.html/result.html/
 * processing.html/shop.html) — while balance is held at the ≥200 ceiling
 * this is already in the past (lastGrantAt is deliberately never bumped
 * while held back, see syncTokens above), which is exactly what
 * `atCeiling` exists to disambiguate for callers.
 *
 * `atCeiling` (added for tracker item
 * for-product-bug-founder-high-token-chip--kn1v8t — the founder's own
 * profile, sitting at the 200 ceiling, showed a permanent "+20 in now"):
 * true whenever `balance >= GRANT_CEILING`, i.e. exactly the condition
 * syncTokens uses to decide whether to hold the drip back. Every UI
 * countdown renderer MUST branch on this explicit flag rather than
 * inferring "at ceiling" from a past `nextGrantAt` — a past `nextGrantAt`
 * used to be the only signal available, and every renderer collapsed it
 * to "now" and rendered "+20 in now" forever for any account sitting
 * at/above the ceiling, which is misleading (nothing is "due right now" —
 * the grant is simply paused until the balance actually drops). See
 * profile.html's/shop.html's own renderers for the fix.
 *
 * `grantCeiling` is exported alongside `atCeiling` so clients never need
 * to hand-maintain their own copy of GRANT_CEILING (200 as of Token
 * Economy C) to build ceiling-aware copy — the same "read the live
 * constant instead of a literal that goes stale on the next retune"
 * fix already applied to dailyGrantAmount, see tracker item
 * recurring-bug-class-hardcoded-daily-gran-h6swgy.
 *
 * Optional 3rd arg `opts` is forwarded as-is to syncTokens — see that
 * function's own doc comment for `opts.ownerBypass`. This does NOT change
 * the E112/E412 threshold check itself (`balance < 100`/`< 10`) — that
 * comparison lives entirely in the caller (generate-video.js/
 * generate-image.js) against whatever balance this returns, unconditional
 * either way.
 *
 * `hasMadeFirstPurchase` (added for tracker item
 * for-product-shop-first-purchase-50-bonus-bzx2d4): true once this email
 * has ever completed a token-pack purchase (derived from
 * `!!tokens.firstPackPurchaseAt` — see syncTokens/creditTokenPackAmountOnce
 * for where that's stamped). shop.html uses this to decide whether the
 * first-purchase +50% bonus callout is still a true claim for this
 * visitor — showing it to someone who already used the bonus would be
 * false advertising. Deliberately exposes only this derived boolean, never
 * the raw `firstPackPurchaseAt` timestamp itself, since the UI has no
 * legitimate use for the actual purchase time and there's no reason to
 * leak more than it needs.
 */
async function getTokenStatus(event, email, opts) {
  var tokens = await syncTokens(event, email, opts);
  return {
    balance: tokens.balance,
    nextGrantAt: tokens.lastGrantAt + GRANT_INTERVAL_MS,
    dailyGrantAmount: DAILY_GRANT_AMOUNT,
    grantCeiling: GRANT_CEILING,
    atCeiling: tokens.balance >= GRANT_CEILING,
    hasMadeFirstPurchase: !!tokens.firstPackPurchaseAt
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

// Sanity ceiling on the *total* balance addTokens can ever produce — not a
// security boundary (this function is only ever reachable through
// owner-topup-tokens.js's owner-only 403 gate, see that file), just a
// backstop against a balance silently ballooning without limit if this ever
// got called in a loop (a retried request, a scripting mistake) rather than
// the deliberate one-off top-ups it's meant for. Chosen well above any
// realistic manual top-up total (owner-topup-tokens.js's own 5000-per-call
// cap means reaching this would take 200+ separate calls) so it never gets
// in the way of legitimate testing use.
var MAX_TOKEN_BALANCE = 1000000;

/**
 * Direct, immediate credit to this email's balance — the manual "top up my
 * balance" counterpart to spendTokens' manual deduction, both built on the
 * same syncTokens-then-setEntitlement shape. Deliberately separate from the
 * automatic daily-grant machinery syncTokens drives: `lastGrantAt` is
 * carried through unchanged (not bumped to "now"), so a top-up never resets
 * or delays the next automatic +20/24h drip — it is purely additive to
 * `balance`, nothing else about the record's grant timing changes because
 * of it. (syncTokens itself may still apply an already-*due* lazy grant as
 * part of reading the current balance before adding to it, exactly as
 * spendTokens already does — that's the normal lazy-grant mechanism firing
 * on read, not something this function triggers.) Result is capped at
 * MAX_TOKEN_BALANCE (see above). No-ops (returns null, writes nothing) for
 * an empty/missing email, matching spendTokens' and syncTokens' own guard.
 */
async function addTokens(event, email, amount) {
  var key = normalizeEmail(email);
  if (!key) return null;
  var tokens = await syncTokens(event, key);
  var newBalance = Math.min(MAX_TOKEN_BALANCE, tokens.balance + amount);
  return setEntitlement(event, key, { tokens: { balance: newBalance, lastGrantAt: tokens.lastGrantAt } });
}

// ============================================================================
// Token-pack purchase crediting (Dodo Payments) — idempotent by payment id
// ----------------------------------------------------------------------------
// Backed by a SEPARATE Blobs store ("dreamtube-token-purchases"), one record
// per Dodo payment_id: { email, tokens, creditedAt }. Deliberately its own
// store rather than folding into the per-email entitlement record above —
// this one is keyed by payment, not by email, since its whole job is
// deduplicating *events*, not describing a user's current state.
//
// Why this needs its own dedup guard at all: unlike setEntitlement (an
// idempotent overwrite — replaying the same subscription event twice
// produces the same end state), addTokens is NOT idempotent — calling it
// twice for the same payment credits tokens twice. Dodo's webhook delivery,
// like every mainstream webhook provider (Stripe included), is at-least-
// once: a slow response, a transient 5xx, or a delivery timeout can cause
// the same payment.succeeded event to arrive more than once. Without a
// guard, a redelivered event would double-grant tokens for a single real
// charge.
// ============================================================================

var TOKEN_PURCHASES_STORE_NAME = 'dreamtube-token-purchases';

function tokenPurchasesStore() {
  return getStore({ name: TOKEN_PURCHASES_STORE_NAME });
}

// Bounded attempts for the claim-token write-then-verify loop below — same
// number and same "fail closed, don't hang" reasoning as tracker-store.js's
// own MAX_WRITE_ATTEMPTS (see that file's CONCURRENT-WRITE RACE comment).
// The actual read -> mutate -> write -> verify mechanics live in the shared
// lib/blobs-retry.js (extracted once a fourth store reimplemented this same
// pattern — see that file's own header comment) — this stays a thin
// domain-specific wrapper around it: the "mutate" step is "write a fresh
// claim marker unless one already exists" (SKIP if it does — see below),
// and "verify" is "is MY claimId the one that's actually visible".
var MAX_CREDIT_ATTEMPTS = 3;

/**
 * Credits `tokens` onto `email`'s balance exactly once per Dodo
 * `paymentId` — see the doc block above. Returns { credited: boolean }:
 * `false` means this paymentId was already processed (a no-op, not an
 * error — dodo-webhook.js should still return 200 either way, since from
 * Dodo's perspective the event was handled successfully).
 *
 * A plain "read marker -> if absent, write marker -> credit" (what this
 * function used to do) is a straightforward TOCTOU: Netlify Blobs has no
 * compare-and-swap, and this file's OWN header comment documents its
 * reads as only eventually consistent (up to ~60s propagation) — so a
 * webhook redelivery landing ANYWHERE in that window (not just a
 * perfectly-simultaneous one), or a genuinely concurrent invocation of
 * this handler, can both observe "not yet processed" before either write
 * happens, and both go on to credit. That is a real double-grant of real
 * money's worth of tokens, not a hypothetical.
 *
 * This adapts tracker-store.js's bounded read -> mutate -> write ->
 * verify retry loop (writeItemsWithRetry / the CONCURRENT-WRITE RACE
 * comment there) to a single dedup-marker key instead of a full array:
 * each attempt writes a marker carrying a fresh random `claimId`, then
 * immediately reads the key back. If the read-back marker's `claimId`
 * matches the one this attempt just wrote, this call "won" the race (its
 * write was the one left standing) and proceeds to credit. If the
 * read-back shows a DIFFERENT claimId, some other caller's write landed
 * either concurrently or in between — this call backs off without
 * crediting and loops back to a fresh read, which (now that a marker
 * genuinely exists) resolves as "already processed" on the next
 * iteration, exactly like a real redelivery would. This closes the
 * window where two callers could both observe "absent" *before* either
 * write, which is the actual bug: only the write that's still visible at
 * verify-time ever credits.
 *
 * Like tracker-store.js's own version, this NARROWS the race window but,
 * per that file's own honest caveat about Blobs having no real
 * compare-and-swap, does not mathematically eliminate it: two verify
 * reads could in principle each observe their own write as still current
 * under sufficiently pathological propagation timing (e.g. two different
 * edge replicas each still showing their own local write). That residual
 * window is now bounded to "both writes' verify-reads land before either
 * write has propagated across the store," which is categorically
 * narrower than the original bug ("both initial reads land before either
 * write happens at all") — every real concurrent-redelivery scenario
 * this function is actually exercised against (see
 * test/entitlements-token-purchases.test.js's concurrency tests) resolves
 * to exactly one credit. If item loss/duplication is ever actually
 * observed in practice, revisit — same posture tracker-store.js already
 * takes on its own residual race.
 *
 * Bounded (not infinite) attempts, same reasoning as tracker-store.js:
 * a still-propagating read shouldn't hang the webhook response
 * indefinitely. A `SKIP` (a marker legitimately already existed) is a
 * normal no-op outcome. Exhausting all attempts WITHOUT a legitimate
 * `SKIP` — i.e. genuinely never confirming a win — is a different case
 * and is NOT silently swallowed as "no credit": see the "EXHAUSTION MUST
 * THROW" addendum below for why and how.
 *
 * A missing/falsy `paymentId` (shouldn't happen with a real Dodo payload,
 * but don't let that silently drop a legitimate purchase) skips the dedup
 * check entirely and just credits once, uncached.
 *
 * ----------------------------------------------------------------------
 * TWO-PHASE MARKER (status: 'pending' -> 'committed') — fixes tracker
 * item dodo-payment-webhook-marker-before-credi-kz94cx
 * ----------------------------------------------------------------------
 * The version of this function described above (and originally shipped)
 * wrote the dedup marker as its own terminal state: once the write-then-
 * verify race above declared a winner, THAT marker's mere existence was
 * treated as "fully processed" forever after. That's a real gap: if
 * `addTokens` threw right after the marker committed (a transient Blobs
 * write failure at exactly the wrong moment — rare, but real, and a
 * webhook 500 in response is expected/correct so Dodo retries), every
 * subsequent redelivery would see the already-written marker, SKIP, and
 * report `credited: false` — permanently. A real charge would have gone
 * through with its tokens silently, permanently uncredited, with no way
 * for a retry to ever self-heal it.
 *
 * The fix is a marker with an explicit `status` field, not treated as
 * terminal until `status === 'committed'`:
 *   1. The write-then-verify race above now writes `status: 'pending'`
 *      (not yet terminal) instead of treating existence-of-any-marker as
 *      done.
 *   2. If the marker we find already exists with `status === 'committed'`,
 *      that's a genuine redelivery of an already-fully-processed
 *      payment — SKIP, `credited: false`, exactly like before.
 *   3. If the marker (ours or a pre-existing one) has `status ===
 *      'pending'`, this is either a fresh attempt or a RESUME of an
 *      earlier attempt that was interrupted somewhere between writing
 *      the marker and finishing the credit. Either way the remaining
 *      work is identical: make sure the balance credit has actually
 *      landed (creditTokenPackAmountOnce below), then flip the marker to
 *      `'committed'`. The flip is ALSO raced (a second, smaller
 *      read -> mutate -> write -> verify via blobs-retry.js, SKIPping if
 *      some other call already flipped it to `'committed'`) rather than
 *      a blind overwrite — a `'pending'` marker can legitimately be
 *      resumed by more than one near-simultaneous redelivery, and
 *      without this guard every one of them would independently report
 *      `credited: true` even though the balance is only ever incremented
 *      once (caught by this fix's own concurrency tests — see
 *      test/entitlements-token-purchases.test.js). Exactly one resumer
 *      ends up reporting `credited: true`; the rest see the flip already
 *      done and report `credited: false`, a safe no-op since the money
 *      is correct either way.
 *
 * The subtle part `status: 'pending'` alone does NOT solve: on resume,
 * this function cannot tell from the marker alone whether `addTokens`
 * already ran during the interrupted attempt (it could have thrown
 * mid-write, OR it could have succeeded and only the flip-to-committed
 * write afterward failed). Since a plain balance increment is not
 * idempotent, blindly calling it again on every resume would re-open
 * the exact double-credit hazard the original TOCTOU fix above exists to
 * prevent — just moved one step later. `creditTokenPackAmountOnce` below
 * closes THIS gap: it records `paymentId` as applied in the SAME single
 * Blobs write that bumps the balance, so "was this payment's credit
 * already applied" can be answered with certainty by reading the
 * entitlement record, not guessed at from a separate marker whose write
 * could itself have failed independently. See that function's own doc
 * comment for why putting both facts in one write is what actually makes
 * this safe, rather than just narrowing the window.
 *
 * ----------------------------------------------------------------------
 * EXHAUSTION MUST THROW, NOT SILENTLY SWALLOW (round 2 review finding)
 * ----------------------------------------------------------------------
 * `blobsRetry.retryingWrite`'s exhausted-attempts outcome
 * (`{ ok: false, skipped: false }`) is a plain return value, not a
 * thrown error — by design, since two of its four call sites
 * (tracker-store.js/support-store.js's array-mutate ones) deliberately
 * fail OPEN on it (see blobs-retry.js's own header comment: "that
 * decision is domain-specific and stays with each caller"). The first
 * draft of THIS two-phase fix treated exhaustion the same way its
 * pre-two-phase ancestor did: silently return `{ credited: false }`, no
 * different from a legitimate `SKIP`. That's wrong for this specific
 * caller: `dodo-webhook.js` discards `creditTokenPackOnce`'s return
 * value entirely and only ever 500s if something actually THROWS — so a
 * genuine transient failure (real write contention, or the propagation
 * lag this file already documents as real) that exhausts all attempts
 * without throwing acknowledges (200s) the webhook with a `'pending'`
 * marker left on disk and nothing to ever prompt Dodo to redeliver it.
 * That is the ORIGINAL bug (a real charge, permanently unaccounted for)
 * via a different trigger — silently fixing the `addTokens`-throws case
 * while leaving this one open would be an incomplete fix.
 *
 * The correct call-site-specific choice here (this module's own
 * documented philosophy: fail-open vs fail-closed is domain-specific,
 * decided by the caller, not by retryingWrite itself) is to fail LOUD:
 * every `blobsRetry.retryingWrite` call in this credit path (the initial
 * marker write below, creditTokenPackAmountOnce's balance write, and the
 * flip-to-'committed' write) throws a plain `Error` on genuine
 * exhaustion (`!ok && !skipped`), distinct from the legitimate `SKIP`
 * no-op case, which still returns normally. That throw propagates
 * straight up through this function (nothing here catches it) and out
 * to dodo-webhook.js's existing try/catch, converting it into a 500 —
 * the exact mechanism the doc comment at the top of dodo-webhook.js
 * already documents (E5, "returns 500 deliberately so Dodo retries
 * delivery"). No change to dodo-webhook.js itself was needed; its
 * existing catch block already does the right thing once this function
 * actually throws instead of quietly returning success-shaped false.
 */
async function creditTokenPackOnce(event, email, paymentId, tokens) {
  if (!paymentId) {
    // Hardening fix (store-launch copy-sweep companion pass,
    // for-product-store-launch-copy-sweep-purc-m6xhkx): this used to
    // credit unconditionally here, with a comment calling it a
    // "documented escape hatch" — but that's a real gap now that real
    // money is involved. paymentId is the ONLY thing the dedup marker
    // below keys on; with none, there is no way to tell a genuine
    // (if malformed) event apart from a redelivery/replay of the exact
    // same one, so crediting here would double- (or infinitely-) credit
    // on every redelivery. A real Dodo `payment.succeeded` Payment object
    // always carries `payment_id` — seeing this branch hit at all means
    // something is wrong with the event, not that it's safe to trust.
    // Fail closed: log loudly for ops visibility and skip crediting,
    // rather than crediting real tokens off an unverifiable event. Not a
    // `throw` — dodo-webhook.js's catch turns a throw into a 500 (asking
    // Dodo to redeliver), which would just repeat this same unresolvable
    // situation forever; this is a structural problem with the event, not
    // a transient one worth retrying.
    console.error('creditTokenPackOnce: payment.succeeded event has no payment_id -- refusing to credit tokens (nothing to dedupe a redelivery against). email=' + normalizeEmail(email) + ' tokens=' + tokens);
    return { credited: false };
  }

  var claimId; // set fresh inside mutate() on whichever attempt actually writes

  var result = await blobsRetry.retryingWrite(event, TOKEN_PURCHASES_STORE_NAME, paymentId, {
    maxAttempts: MAX_CREDIT_ATTEMPTS,
    read: function (evt) {
      connectLambda(evt);
      return tokenPurchasesStore().get(paymentId, { type: 'json' });
    },
    mutate: function (existing) {
      // A marker already exists — either from an earlier attempt of ours
      // within this same loop (verify lagged, so we looped back and now
      // see our own write) or a genuinely separate caller/redelivery.
      // Either way there's nothing new to write here: SKIP and let the
      // caller decide what the existing marker's `status` means.
      if (existing) return blobsRetry.SKIP;
      claimId = crypto.randomUUID();
      return { email: normalizeEmail(email), tokens: tokens, status: 'pending', claimId: claimId, createdAt: Date.now() };
    },
    verify: function (verifyRead) {
      return !!(verifyRead && verifyRead.claimId === claimId);
    }
  });

  var marker;
  if (result.ok) {
    marker = result.value; // our freshly-written 'pending' marker just won the race
  } else if (result.skipped) {
    marker = result.current; // a pre-existing marker (pending or committed)
  } else {
    // Genuine exhaustion — NOT the legitimate `skipped` case (an existing
    // marker meaning "already processed"). This means every attempt's
    // write was never confirmed as the winner, AND, since a fresh marker
    // is only skipped when `existing` is truthy, nothing usable is
    // necessarily persisted either. Silently returning `credited: false`
    // here would acknowledge (200) this payment.succeeded event with no
    // durable record of it anywhere and no future retry to ever pick it
    // back up — the exact "permanently and silently swallowed" failure
    // mode this whole fix exists to close, just triggered by write
    // contention/propagation lag instead of a mid-flight `addTokens`
    // throw. Throwing instead lets dodo-webhook.js's EXISTING catch
    // block turn this into a 500, which is what actually gets Dodo to
    // redeliver and give this a real second attempt.
    throw new Error('creditTokenPackOnce: exhausted attempts writing the pending marker for paymentId ' + paymentId + ' without confirming a winner');
  }

  if (!marker || marker.status === 'committed') {
    // A fully-processed payment — genuine redelivery, nothing to do.
    return { credited: false };
  }

  // marker.status === 'pending': either freshly created above, or a
  // resume of an interrupted earlier attempt. creditTokenPackAmountOnce
  // is idempotent per paymentId (see its own doc comment), so it's safe
  // to call again here even if an earlier, interrupted attempt already
  // applied this exact credit — it will report `ok: true` without
  // touching the balance a second time. It never returns `ok: false`: on
  // genuine exhaustion it throws (see its own doc comment), which
  // propagates straight out of this function too — deliberately, for the
  // same "let dodo-webhook.js's catch turn this into a retry" reason as
  // the marker write above.
  await creditTokenPackAmountOnce(event, email, paymentId, tokens);

  // At this point the balance credit is guaranteed to have landed exactly
  // once (creditTokenPackAmountOnce's own guarantee), regardless of how
  // many callers reach this line concurrently — a 'pending' marker CAN
  // legitimately be resumed by more than one near-simultaneous redelivery
  // (see creditTokenPackAmountOnce's doc comment). But `credited: true`
  // is a signal a future caller might reasonably treat as "fire a
  // one-time side effect" (a receipt email, an analytics event) — so,
  // same as the initial marker write above, this flip is ALSO raced
  // rather than a blind overwrite: exactly one of several concurrent
  // resumers should be the one that reports `credited: true`, the rest
  // should see it's already been finished and report `credited: false`
  // (a safe, expected no-op — the money is correct either way, this is
  // only about which single call gets to say "I was the one").
  var finishClaimId;
  var finishResult = await blobsRetry.retryingWrite(event, TOKEN_PURCHASES_STORE_NAME, paymentId, {
    maxAttempts: MAX_CREDIT_ATTEMPTS,
    read: function (evt) {
      connectLambda(evt);
      return tokenPurchasesStore().get(paymentId, { type: 'json' });
    },
    mutate: function (existing) {
      if (existing && existing.status === 'committed') return blobsRetry.SKIP; // someone else already finished this resume
      finishClaimId = crypto.randomUUID();
      return Object.assign({}, existing || marker, { status: 'committed', creditedAt: Date.now(), finishClaimId: finishClaimId });
    },
    verify: function (verifyRead) {
      return !!(verifyRead && verifyRead.finishClaimId === finishClaimId);
    }
  });

  if (finishResult.skipped) {
    // Someone else's concurrent resume already flipped this marker to
    // 'committed' — a safe, expected no-op. The credit itself is
    // guaranteed correct regardless (creditTokenPackAmountOnce's own
    // guarantee, above); this call just isn't the one that gets to
    // report `credited: true`.
    return { credited: false };
  }
  if (!finishResult.ok) {
    // Genuine exhaustion, not a legitimate SKIP. The balance credit
    // itself is NOT at risk here (creditTokenPackAmountOnce already
    // guaranteed it landed, or would have thrown) — only the bookkeeping
    // flip-to-'committed' failed to confirm. Still throw rather than
    // silently 200ing: a thrown error here becomes a 500 via
    // dodo-webhook.js's existing catch block, and Dodo redelivering is
    // exactly what gives this marker another chance to reach
    // 'committed' — harmless to retry, since creditTokenPackAmountOnce
    // will immediately no-op via its own idempotency check next time.
    // Silently swallowing this instead would leave the marker stuck
    // 'pending' forever unless some UNRELATED future event happens to
    // redeliver this same paymentId — not something to rely on.
    throw new Error('creditTokenPackOnce: exhausted attempts flipping the marker to committed for paymentId ' + paymentId);
  }

  // Best-effort cleanup of the short-lived per-email applied-paymentId
  // record now that the payment marker itself is committed (see
  // forgetAppliedTokenPack's doc comment) — not required for correctness
  // (a lingering entry is harmless), so a failure here must not turn an
  // already-successful credit into a 500/retry.
  try {
    await forgetAppliedTokenPack(event, email, paymentId);
  } catch (e) {
    // Swallowed deliberately — see comment above.
  }

  return { credited: true };
}

/**
 * Credits `amount` BASE tokens (before any bonus — see the FIRST-PURCHASE
 * BONUS section of this doc comment below) onto `email`'s balance for a
 * specific Dodo `paymentId`, idempotently: calling this twice for the same
 * paymentId only ever applies the balance increment once. Used by
 * creditTokenPackOnce to make its 'pending'-marker resume path safe (see
 * that function's doc comment for the hazard this closes).
 *
 * WHY THIS NEEDS ITS OWN WRITE, NOT JUST "check a flag, then call
 * addTokens": recording "this paymentId's tokens were applied" and
 * actually applying them are two facts that, if written separately (e.g.
 * a marker write before/after a plain addTokens() call), can end up
 * disagreeing with each other exactly the same way the original
 * marker-before-credit bug did — whichever one is written second is
 * still vulnerable to a crash in between, just with the hazard moved to
 * a new pair of writes instead of eliminated. A single Netlify Blobs
 * `setJSON` call for one key IS all-or-nothing (the whole record
 * replaces in one write, even though there's still no cross-key
 * transaction and no compare-and-swap — see blobs-retry.js's header
 * comment) — so folding both facts into ONE write (the entitlement
 * record's `tokens.balance` and its `appliedTokenPackPaymentIds` array)
 * means they can never end up recorded inconsistently with each other.
 * Resuming just has to read that one record and check whether
 * `paymentId` is already in the list — no guessing required.
 *
 * Reuses blobs-retry.js's bounded read -> mutate -> write -> verify loop
 * (same shape as creditTokenPackOnce's own dedup guard above) rather than
 * a plain check-then-write, because a 'pending' marker CAN legitimately
 * be resumed by more than one caller close together (e.g. two Dodo
 * redeliveries of the same interrupted payment arriving near-
 * simultaneously) — without this, two concurrent resumes could both read
 * "not yet applied" before either writes, and both credit. `verify`
 * checks the SAME thing `mutate` checks: that `paymentId` is now present
 * in the record's `appliedTokenPackPaymentIds`. On exhausted attempts,
 * takes one bonus, unhurried confirmatory read before giving up — a
 * failed verify can mean either a real clobber (someone else's write is
 * the one visible) or just our own write not yet propagating to the
 * verify-read in time (see blobs-retry.js's own honest caveat about
 * this), and only the former is actually "still not applied". If even
 * that bonus read doesn't show the credit landed, this THROWS rather
 * than returning `{ ok: false }` — see the "EXHAUSTION MUST THROW"
 * addendum on creditTokenPackOnce's own doc comment for why a payment
 * webhook's crediting path can't silently swallow genuine exhaustion.
 *
 * Residual, undefended race: `addTokens` (owner-topup-tokens.js's manual
 * top-up) does a single plain, unretried setEntitlement write — if one
 * happens to land concurrently with this function's own retryingWrite
 * cycle for the same email, whichever write is last can clobber the
 * other's `tokens.balance` (the `appliedTokenPackPaymentIds` array
 * itself is safe either way, since addTokens' patch never touches it).
 * Same class of narrow last-write-wins drift this file's own header
 * comment already accepts for concurrent balance mutations in general;
 * not something this fix introduces or specifically defends against.
 *
 * ----------------------------------------------------------------------
 * FIRST-PURCHASE BONUS (+50%, Token Economy C, founder-approved 2026-07-26)
 * ----------------------------------------------------------------------
 * `amount` here is always the pack's BASE token count (resolved by
 * dodo-webhook.js's resolvePackTokens, unaware of any bonus) — this
 * function is what actually decides, per call, whether the account's
 * `firstPackPurchaseAt` field is already set. If it is not, this is (as
 * far as this record can tell) the email's first-ever completed pack
 * purchase, so `amount` is bumped by FIRST_PURCHASE_BONUS_MULTIPLIER
 * before being added to the balance, and `firstPackPurchaseAt` is stamped
 * in the SAME write — deliberately the same atomic-single-write reasoning
 * as `appliedTokenPackPaymentIds` above: whether the bonus applies and the
 * credit that depends on that decision must never be allowed to disagree
 * with each other, so they're decided and written together, not as two
 * separate facts that could each independently fail to land.
 *
 * This is why the bonus decision lives HERE (inside the retryingWrite's
 * `mutate`, re-read fresh on every attempt) rather than being computed
 * once by the caller and passed in: a resume of an interrupted earlier
 * attempt re-reads the CURRENT record state on each try, so it can never
 * apply a bonus decision that's gone stale relative to what's actually
 * been committed.
 *
 * Known, accepted residual race (same class this file's header comment
 * already accepts elsewhere): two genuinely concurrent FIRST purchases
 * under DIFFERENT payment_ids for the same brand-new email (e.g. two
 * pack purchases within the same Blobs propagation window) could each
 * read `firstPackPurchaseAt` as unset and each apply the bonus once —
 * dedup here is per-payment, not a per-email lock, same as
 * appliedTokenPackPaymentIds' own dedup. Narrow, real-money-adjacent but
 * bounded to a single extra bonus application in a genuinely rare timing
 * window, not unbounded double-crediting; revisit only if actually
 * observed in practice, same posture this file already takes on its
 * other documented residual races.
 */
var FIRST_PURCHASE_BONUS_MULTIPLIER = 1.5;

async function creditTokenPackAmountOnce(event, email, paymentId, amount) {
  var key = normalizeEmail(email);
  if (!key) return { ok: false };

  // Apply any due lazy grant first, same sequencing as addTokens — AND,
  // critically, use ITS RETURNED VALUE directly as the balance base
  // below, never a later independent re-read. Netlify Blobs has no
  // read-your-own-write guarantee (this file's own header comment
  // documents the exact incident that forced this codebase off strong
  // consistency): a `store().get()` issued right after syncTokens' own
  // setEntitlement write can legitimately still return the pre-grant
  // record. addTokens already avoids this exact hazard by computing
  // `tokens.balance + amount` from syncTokens' in-memory return value
  // and letting that patch fully replace `tokens` on write (setEntitlement
  // merges via Object.assign, so the patch's `tokens` key wins outright
  // over whatever its own internal read saw) — this function follows the
  // same pattern for the same reason. Getting this wrong would silently
  // overwrite a real grant that just landed (up to 220 tokens for a
  // brand-new email's first-ever read, or 20 for a daily drip).
  var syncedTokens = await syncTokens(event, key);

  var result = await blobsRetry.retryingWrite(event, STORE_NAME, key, {
    maxAttempts: MAX_CREDIT_ATTEMPTS,
    read: function (evt) {
      connectLambda(evt);
      return store().get(key, { type: 'json' });
    },
    mutate: function (existing) {
      // This fresh-per-attempt read is used ONLY to check
      // appliedTokenPackPaymentIds (the idempotency guard against a
      // concurrent resume) and firstPackPurchaseAt (the first-purchase-
      // bonus check, same reasoning — see this function's own doc
      // comment) — and to preserve any other fields already on the
      // record — NEVER to derive the new balance. See the doc comment
      // above `syncedTokens` for why.
      var rec = existing || { email: key };
      var appliedList = rec.appliedTokenPackPaymentIds || [];
      if (appliedList.indexOf(paymentId) !== -1) return blobsRetry.SKIP; // already applied by an earlier attempt
      var isFirstPurchase = !rec.firstPackPurchaseAt;
      var creditAmount = isFirstPurchase ? Math.round(amount * FIRST_PURCHASE_BONUS_MULTIPLIER) : amount;
      var newBalance = Math.min(MAX_TOKEN_BALANCE, syncedTokens.balance + creditAmount);
      return Object.assign({}, rec, {
        email: key,
        tokens: { balance: newBalance, lastGrantAt: syncedTokens.lastGrantAt },
        appliedTokenPackPaymentIds: appliedList.concat([paymentId]),
        firstPackPurchaseAt: rec.firstPackPurchaseAt || Date.now(),
        updatedAt: Date.now()
      });
    },
    verify: function (verifyRead) {
      return !!(verifyRead && verifyRead.appliedTokenPackPaymentIds && verifyRead.appliedTokenPackPaymentIds.indexOf(paymentId) !== -1);
    }
  });

  if (result.ok || result.skipped) return { ok: true }; // credited just now, or already applied by an earlier attempt

  // Attempts exhausted without our write ever being confirmed — take one
  // more plain, unhurried read before giving up: this resolves the
  // common case (our write actually landed, only the verify-read lagged
  // behind it — see blobs-retry.js's own honest caveat about this being
  // possible) without ever reporting success when nothing was actually
  // confirmed.
  var finalRead = await getEntitlement(event, key);
  var finalApplied = (finalRead && finalRead.appliedTokenPackPaymentIds) || [];
  if (finalApplied.indexOf(paymentId) !== -1) return { ok: true };

  // Genuinely could not confirm the credit landed, even after the bonus
  // read — this is NOT a legitimate "someone else already handled it"
  // outcome (that's the `result.skipped` branch above, already handled).
  // Returning normally here with some "not applied" value would let the
  // caller silently swallow a real, transient failure exactly the way
  // the original bug did — just relocated from "addTokens threw" to
  // "write contention/propagation lag exhausted our attempts". Throwing
  // instead propagates up through dodo-webhook.js's existing catch block
  // into a 500, which is what actually gets Dodo to redeliver and give
  // this a real second chance, rather than silently 200ing with the
  // marker left `'pending'` and no future trigger to ever resume it.
  throw new Error('creditTokenPackAmountOnce: exhausted attempts crediting paymentId ' + paymentId + ' for ' + key + ' without ever confirming the credit landed');
}

/**
 * Removes `paymentId` from `email`'s short-lived `appliedTokenPackPaymentIds`
 * list once its purchase marker has been safely flipped to `'committed'`
 * (see creditTokenPackOnce) — at that point the marker record is the sole
 * source of truth for "already processed" and this per-email array no
 * longer needs to remember it too. Purely a housekeeping step to keep the
 * array from growing across a long-lived paying account's lifetime; NOT
 * required for correctness (a lingering entry is harmless — it just means
 * a paymentId that will never be looked up again stays idempotency-marked
 * forever), so callers should treat a failure here as non-fatal. No-ops
 * for an empty/missing email or a paymentId that isn't present.
 */
async function forgetAppliedTokenPack(event, email, paymentId) {
  var key = normalizeEmail(email);
  if (!key) return;
  var record = await getEntitlement(event, key);
  var applied = (record && record.appliedTokenPackPaymentIds) || [];
  if (applied.indexOf(paymentId) === -1) return;
  await setEntitlement(event, key, {
    appliedTokenPackPaymentIds: applied.filter(function (id) { return id !== paymentId; })
  });
}

// ============================================================================
// Automatic token refund on post-submission generation failure — idempotent
// per job id (tracker item idea-auto-refund-policy, founder-approved
// 2026-07-26)
// ----------------------------------------------------------------------------
// generate-video.js/generate-image.js spend tokens the moment a generation
// is successfully SUBMITTED to fal (100 for video, 10 for image, via
// spendTokens above) — correct even though the job hasn't finished yet, a
// real submission is real cost regardless of what fal eventually does with
// it. But a user charged for a video/image that never actually materialized
// is a bad experience worth fixing automatically, not just routing to the
// support form every time.
//
// video-status.js/image-status.js are the two places that determine, on
// fal's own authority, that a submitted job actually failed (E205/E505 —
// fal itself marked the job's terminal status something other than
// success) or completed with no usable result (E208/E508 — COMPLETED but
// no video/image URL in the response). Those two files call
// refundTokensOnce below the moment they report one of THOSE specific
// codes — see either file's own error-code doc block for the full list and
// why only these two per media type are refund-eligible: a transport-level
// hiccup fetching fal's status/result endpoint (E203/E204/E206/E207 and
// their E5xx counterparts) doesn't actually prove the job failed, only that
// THIS status check couldn't confirm either way, so those stay outside the
// automatic refund's scope — the support-form fallback covers those, per
// the founder's own spec ("Support-form fallback stays for anything beyond
// (form exists)"). Also per spec: tokens only — money refunds for a real
// Dodo purchase stay a manual, support-driven process, not something this
// function ever touches.
//
// WHY THIS NEEDS THE EXACT SAME TWO-PHASE-MARKER DISCIPLINE AS
// creditTokenPackOnce (NOT just creditTokenPackAmountOnce's single-write
// dedup array alone): not a theoretical race, and a single "fold the id
// into the same write as the balance" array-membership check is NOT
// sufficient by itself under genuine concurrency, even though it looks
// idempotent at first glance. Proven directly by this file's own test
// suite (test/entitlements-refund.test.js's first draft): two concurrent
// calls for the same jobId can both `read()` the entitlement record
// BEFORE either has written, both independently compute "jobId is not yet
// in refundedJobIds, add it," and both write — a plain array-membership
// `verify()` (does the array contain jobId) then returns TRUE for BOTH
// callers, since whichever write actually lands last still contains jobId
// either way. That's a real double-refund, not a false alarm — the same
// class of bug creditTokenPackAmountOnce alone would have if
// creditTokenPackOnce's own OUTER per-payment-id marker (a separate store,
// a claimId minted per attempt, `verify()` checking "is MY claimId the one
// now visible" rather than "does a marker merely exist") didn't serialize
// concurrent callers before any of them ever reach the balance write.
// creditTokenPackAmountOnce is only safe in production because it is never
// called with the same paymentId from two genuinely concurrent callers —
// creditTokenPackOnce's outer marker already guarantees at most one caller
// gets past the SKIP check to call it. Refunds need that identical outer
// serialization, not a copy of the inner half alone — see
// refundTokensOnce below (the outer, claimId-based marker, mirroring
// creditTokenPackOnce almost line for line) and refundTokenAmountOnce
// (the inner, per-job balance credit, mirroring creditTokenPackAmountOnce)
// for the two-function split this requires.
//
// Backed by a SEPARATE Blobs store ("dreamtube-refunded-jobs"), one record
// per generation job id — deliberately mirrors TOKEN_PURCHASES_STORE_NAME's
// own shape (see that store's header comment above) for the identical
// reason: a job id and a Dodo payment id are different id spaces meaning
// different things, so keeping their dedup stores separate means a
// refund's guard can never be confused with a purchase's, and this store's
// own 'committed' marker becomes ITS OWN durable, permanent "already
// refunded" record — which is what makes it safe to prune the per-email
// `refundedJobIds` array afterward (see forgetRefundedJobId below),
// exactly like forgetAppliedTokenPack does for purchases once
// TOKEN_PURCHASES_STORE_NAME's own marker commits.
// ============================================================================

var REFUNDED_JOBS_STORE_NAME = 'dreamtube-refunded-jobs';

function refundedJobsStore() {
  return getStore({ name: REFUNDED_JOBS_STORE_NAME });
}

/**
 * The OUTER refund entry point — mirrors creditTokenPackOnce almost line
 * for line (see that function's own doc comment for the full two-phase
 * mechanism this reuses): a claimId-based write-then-verify race against
 * REFUNDED_JOBS_STORE_NAME serializes concurrent callers for the SAME
 * jobId (only one ever gets past the SKIP check to actually apply the
 * balance credit), a `status: 'pending' -> 'committed'` marker makes an
 * interrupted attempt (a crash between winning the marker race and
 * finishing the credit) safely RESUMABLE rather than permanently stuck
 * either "already marked processed but never credited" or "credited
 * twice," and refundTokenAmountOnce below (mirroring
 * creditTokenPackAmountOnce) makes the actual balance write idempotent per
 * jobId too, so a resume can never double-apply it.
 *
 * Returns `{ ok: true, refunded: boolean }`: `refunded: false` means this
 * jobId was already refunded (a genuine redelivery/resumed poll finding
 * the same terminal failure again, or a concurrent caller that lost the
 * marker race) — a safe no-op, not an error. Throws on genuine exhaustion
 * at either phase (bounded retry attempts never confirm a winner),
 * matching creditTokenPackOnce's own "EXHAUSTION MUST THROW, NOT SILENTLY
 * SWALLOW" reasoning — see that function's doc comment. Callers here
 * (video-status.js/image-status.js) catch this and log rather than fail
 * the whole status-check response: there's no webhook-style redelivery
 * mechanism to give a thrown error a genuine second attempt the way
 * dodo-webhook.js has, so the generation-failure notice must still reach
 * the user even if this refund attempt itself hit a transient Blobs
 * failure — the support-form fallback covers the rare case a refund never
 * lands, per the founder's own spec.
 *
 * A missing/falsy jobId skips the dedup guard entirely and always refunds
 * — this used to mirror creditTokenPackOnce's own `!paymentId` behavior,
 * but that one now fails closed instead (see its own doc comment, fixed
 * for tracker item for-product-store-launch-copy-sweep-purc-m6xhkx —
 * real-money crediting needed the stricter behavior; a token refund here
 * is lower-stakes and out of scope for that pass). Shouldn't happen in
 * practice (every real generation always has an
 * operationName), but this must not silently drop a legitimate refund if
 * it somehow did. NOT reachable via the real HTTP-exposed status endpoints
 * (video-status.js/image-status.js both require a non-empty `name` before
 * ever calling this — see either file's own E202/E502 validation), so this
 * escape hatch is not itself part of the ownership-check surface below —
 * there is no jobId for an attacker to spoof ownership of in this branch.
 *
 * ----------------------------------------------------------------------
 * SECURITY: email/jobId ownership check (round-2 review finding, fixes a
 * real vulnerability, not a hypothetical)
 * ----------------------------------------------------------------------
 * `email` and `jobId` both arrive here as plain, unauthenticated
 * arguments — video-status.js/image-status.js pass through whatever the
 * request's own query string said, with no session/auth token to check
 * either against (this codebase has none — every request is identified
 * purely by a client-supplied email throughout, see generate-video.js's
 * own E112 doc block). Before this check existed, that meant `GET
 * /video-status?name=<victim's in-flight operationName>&email=
 * <attacker's email>` would credit the ATTACKER's balance for a
 * STRANGER's failed job the instant it failed — and PERMANENTLY lock the
 * real owner out of ever being refunded for their own job, since the
 * marker below commits to 'committed' on the first successful claim,
 * regardless of who made it. This was a genuine, not merely theoretical,
 * gap: nothing before this line verified the caller was actually the
 * account that submitted `jobId`.
 *
 * jobOwners.getJobOwnerEmail(jobId) (lib/job-owners.js) answers exactly
 * that — a record written once, at generation-submission time, by
 * generate-video.js's/generate-image.js's own recordJobOwnerBestEffort,
 * binding the job id to the email that actually paid for it. This check
 * runs BEFORE this function ever touches REFUNDED_JOBS_STORE_NAME's
 * marker or any balance, so a mismatched/unauthorized attempt has ZERO
 * side effects — it never creates, resumes, or interferes with a marker
 * the real owner's later, correctly-authenticated poll would still need
 * to see fresh.
 *
 * Fails CLOSED, not open, when no owner record exists at all (a write
 * failure at submission time, or a job that predates this store): refuses
 * to refund rather than falling back to trusting the caller's claimed
 * email. The support-form fallback (per the founder's own spec) is the
 * correct route for that rare case — silently trusting an unverifiable
 * email here would just reopen the exact vulnerability this check exists
 * to close, for the same convenience "auto-refund still works one way or
 * another" reasoning; this codebase already accepts that a security
 * boundary degrades to "the automatic path doesn't fire" rather than "the
 * automatic path fires for someone unverified."
 */
async function refundTokensOnce(event, email, jobId, amount) {
  var key = normalizeEmail(email);
  if (!key) return { ok: false, refunded: false };

  if (!jobId) {
    await addTokens(event, key, amount);
    return { ok: true, refunded: true };
  }

  var ownerEmail = await jobOwners.getJobOwnerEmail(event, jobId);
  if (!ownerEmail) {
    console.error('refundTokensOnce: no recorded owner for jobId ' + jobId + ' — refusing to refund (fails closed; the support form is the fallback)');
    return { ok: true, refunded: false };
  }
  if (ownerEmail !== key) {
    console.error('refundTokensOnce: email/jobId mismatch — refusing to refund. jobId=' + jobId + ' requested-by=' + key + ' actual-owner=' + ownerEmail);
    return { ok: true, refunded: false };
  }

  var claimId; // set fresh inside mutate() on whichever attempt actually writes

  var result = await blobsRetry.retryingWrite(event, REFUNDED_JOBS_STORE_NAME, jobId, {
    maxAttempts: MAX_CREDIT_ATTEMPTS,
    read: function (evt) {
      connectLambda(evt);
      return refundedJobsStore().get(jobId, { type: 'json' });
    },
    mutate: function (existing) {
      // A marker already exists — either our own earlier attempt within
      // this loop (verify lagged, so we looped back and now see our own
      // write) or a genuinely separate concurrent caller/redelivery.
      // Nothing new to write: SKIP and let the caller decide what the
      // existing marker's `status` means.
      if (existing) return blobsRetry.SKIP;
      claimId = crypto.randomUUID();
      return { email: key, amount: amount, status: 'pending', claimId: claimId, createdAt: Date.now() };
    },
    verify: function (verifyRead) {
      return !!(verifyRead && verifyRead.claimId === claimId);
    }
  });

  var marker;
  if (result.ok) {
    marker = result.value; // our freshly-written 'pending' marker just won the race
  } else if (result.skipped) {
    marker = result.current; // a pre-existing marker (pending or committed) -- some other caller/attempt already owns this jobId
  } else {
    // Genuine exhaustion — not the legitimate `skipped` case. See
    // creditTokenPackOnce's own identical doc comment for why this must
    // throw rather than silently return refunded:false.
    throw new Error('refundTokensOnce: exhausted attempts writing the pending marker for jobId ' + jobId + ' without confirming a winner');
  }

  if (!marker || marker.status === 'committed') {
    // Already fully processed — a genuine redelivery/concurrent-loser,
    // nothing to do.
    return { ok: true, refunded: false };
  }

  // marker.status === 'pending': either freshly created above, or a
  // resume of an interrupted earlier attempt. refundTokenAmountOnce is
  // idempotent per jobId (folds the dedup check into the same write as
  // the balance, see its own doc comment), so it's safe to call again
  // here even if an earlier, interrupted attempt already applied this
  // exact credit.
  await refundTokenAmountOnce(event, marker.email || key, jobId, marker.amount || amount);

  // Flip to 'committed' — ALSO raced (a second claimId-based
  // write-then-verify), not a blind overwrite, since a 'pending' marker
  // can legitimately be resumed by more than one near-simultaneous caller
  // — exactly one resumer should report refunded:true, the rest see it
  // already finished. Mirrors creditTokenPackOnce's own finish-flip
  // exactly.
  var finishClaimId;
  var finishResult = await blobsRetry.retryingWrite(event, REFUNDED_JOBS_STORE_NAME, jobId, {
    maxAttempts: MAX_CREDIT_ATTEMPTS,
    read: function (evt) {
      connectLambda(evt);
      return refundedJobsStore().get(jobId, { type: 'json' });
    },
    mutate: function (existing) {
      if (existing && existing.status === 'committed') return blobsRetry.SKIP; // someone else already finished this resume
      finishClaimId = crypto.randomUUID();
      return Object.assign({}, existing || marker, { status: 'committed', creditedAt: Date.now(), finishClaimId: finishClaimId });
    },
    verify: function (verifyRead) {
      return !!(verifyRead && verifyRead.finishClaimId === finishClaimId);
    }
  });

  if (finishResult.skipped) {
    // Someone else's concurrent resume already flipped this marker — a
    // safe, expected no-op. The credit itself is guaranteed correct
    // regardless (refundTokenAmountOnce's own guarantee, above); this
    // call just isn't the one that gets to report refunded:true.
    return { ok: true, refunded: false };
  }
  if (!finishResult.ok) {
    // The balance credit itself is NOT at risk (refundTokenAmountOnce
    // already guaranteed it landed, or would have thrown) — only the
    // bookkeeping flip-to-'committed' failed to confirm. Still throw
    // rather than silently succeed — see creditTokenPackOnce's identical
    // reasoning.
    throw new Error('refundTokensOnce: exhausted attempts flipping the marker to committed for jobId ' + jobId);
  }

  // Best-effort cleanup of the short-lived per-email refundedJobIds entry
  // now that the job's own marker is committed (see forgetRefundedJobId's
  // doc comment) — not required for correctness, so a failure here must
  // never turn an already-successful refund into a thrown error.
  try {
    await forgetRefundedJobId(event, marker.email || key, jobId);
  } catch (e) {
    // Swallowed deliberately — see comment above.
  }

  return { ok: true, refunded: true };
}

/**
 * Credits `amount` tokens back onto `email`'s balance for a specific
 * generation job id, idempotently: calling this twice (or concurrently)
 * for the same jobId only ever applies the balance increment once. Same
 * read -> mutate -> write -> verify shape as creditTokenPackAmountOnce —
 * see that function's own doc comment for the full race-closing reasoning.
 * Used by refundTokensOnce above to make its 'pending'-marker resume path
 * safe (see that function's doc comment for the hazard this closes) — NOT
 * safe to call directly with the same jobId from genuinely concurrent
 * callers with no outer serialization (see the doc block above this
 * section for exactly why that alone isn't enough); always go through
 * refundTokensOnce in production code.
 *
 * A missing/falsy jobId skips the dedup guard entirely and always credits
 * — mirrors creditTokenPackOnce's own OLD, pre-hardening-fix `!paymentId`
 * behavior (see that function's own doc comment: it now fails closed
 * instead, since real money is on the line there; this refund-side
 * function's own fail-open behavior is lower-stakes and was intentionally
 * left as-is by that same pass, see this function's own doc comment
 * above for why).
 */
async function refundTokenAmountOnce(event, email, jobId, amount) {
  var key = normalizeEmail(email);
  if (!key) return { ok: false };

  if (!jobId) {
    await addTokens(event, key, amount);
    return { ok: true };
  }

  // Same "use syncTokens' own returned value as the balance base, never a
  // later independent re-read" discipline as creditTokenPackAmountOnce —
  // see that function's own doc comment for the read-your-own-write hazard
  // this avoids (a just-landed daily/signup grant getting silently
  // clobbered by a stale re-read).
  var syncedTokens = await syncTokens(event, key);

  var result = await blobsRetry.retryingWrite(event, STORE_NAME, key, {
    maxAttempts: MAX_CREDIT_ATTEMPTS,
    read: function (evt) {
      connectLambda(evt);
      return store().get(key, { type: 'json' });
    },
    mutate: function (existing) {
      var rec = existing || { email: key };
      var refundedList = rec.refundedJobIds || [];
      if (refundedList.indexOf(jobId) !== -1) return blobsRetry.SKIP; // already applied by an earlier attempt
      var newBalance = Math.min(MAX_TOKEN_BALANCE, syncedTokens.balance + amount);
      return Object.assign({}, rec, {
        email: key,
        tokens: { balance: newBalance, lastGrantAt: syncedTokens.lastGrantAt },
        refundedJobIds: refundedList.concat([jobId]),
        updatedAt: Date.now()
      });
    },
    verify: function (verifyRead) {
      return !!(verifyRead && verifyRead.refundedJobIds && verifyRead.refundedJobIds.indexOf(jobId) !== -1);
    }
  });

  if (result.ok || result.skipped) return { ok: true }; // credited just now, or already applied by an earlier attempt

  // Bonus confirmatory read, same reasoning as creditTokenPackAmountOnce's
  // own — resolves the common "our write actually landed, only the
  // verify-read lagged" case without ever reporting success when nothing
  // was actually confirmed.
  var finalRead = await getEntitlement(event, key);
  var finalRefunded = (finalRead && finalRead.refundedJobIds) || [];
  if (finalRefunded.indexOf(jobId) !== -1) return { ok: true };

  throw new Error('refundTokenAmountOnce: exhausted attempts refunding jobId ' + jobId + ' for ' + key + ' without ever confirming the refund landed');
}

/**
 * Removes `jobId` from `email`'s short-lived `refundedJobIds` list once
 * REFUNDED_JOBS_STORE_NAME's own marker for it has been safely flipped to
 * `'committed'` (see refundTokensOnce) — at that point the marker record
 * is the sole durable source of truth for "already refunded" and this
 * per-email array no longer needs to remember it too. Mirrors
 * forgetAppliedTokenPack exactly (same reasoning, same "harmless if this
 * never runs" non-fatal cleanup). No-ops for an empty/missing email or a
 * jobId that isn't present.
 */
async function forgetRefundedJobId(event, email, jobId) {
  var key = normalizeEmail(email);
  if (!key) return;
  var record = await getEntitlement(event, key);
  var refunded = (record && record.refundedJobIds) || [];
  if (refunded.indexOf(jobId) === -1) return;
  await setEntitlement(event, key, {
    refundedJobIds: refunded.filter(function (id) { return id !== jobId; })
  });
}

/**
 * Permanently deletes an email's entire entitlement record — the token
 * ledger half of delete-account.js's account-deletion flow. Removes the
 * balance/lastGrantAt, the dormant Stripe subscription fields
 * (active/plan/stripeCustomerId/stripeSubscriptionId — see this file's own
 * header comment for why they're still on the record shape even though
 * unused), and appliedTokenPackPaymentIds (the short-lived Dodo
 * in-flight-credit bookkeeping array) all in one shot, since they're all
 * one single-key record here (unlike account-store.js's two-key shape).
 *
 * Deliberately does NOT touch TOKEN_PURCHASES_STORE_NAME (the per-
 * Dodo-payment_id dedup markers, keyed by payment, not by email) — see
 * delete-account.js's own header comment for why: those records are
 * keyed by an opaque payment_id this codebase has no cheap way to
 * enumerate "all payment_ids for email X" against (no index from email
 * -> payment_id exists, mirroring this file's own header comment on why
 * Blobs has no cheap scan), and forgetAppliedTokenPack's own doc comment
 * already establishes that a lingering payment marker is harmless once
 * its purchase is fully committed — it carries no more than the email,
 * a token count, and a status, no card data or name/address (that PII
 * lives entirely on Dodo's own side, see create-checkout-session-dodo.js).
 *
 * Always succeeds (returns { ok:true }) even if no record existed yet for
 * this email — same "deleting something already gone is a safe no-op"
 * semantics as account-store.js's deleteAccount and
 * @netlify/blobs' own store.delete().
 */
async function deleteEntitlement(event, email) {
  var key = normalizeEmail(email);
  if (!key) return { ok: false, error: 'email_required' };
  connectLambda(event);
  await store().delete(key);
  return { ok: true };
}

module.exports = {
  STORE_NAME,
  TOKEN_PURCHASES_STORE_NAME,
  REFUNDED_JOBS_STORE_NAME,
  normalizeEmail,
  getEntitlement,
  isEntitled,
  setEntitlement,
  getTokenStatus,
  spendTokens,
  addTokens,
  creditTokenPackOnce,
  creditTokenPackAmountOnce,
  forgetAppliedTokenPack,
  refundTokensOnce,
  refundTokenAmountOnce,
  forgetRefundedJobId,
  deleteEntitlement,
  // Exported so callers that need the live values (get-token-status.js's
  // no-email fast path, which never reaches getTokenStatus itself — see
  // that file) can read them instead of hand-maintaining a duplicate
  // literal that silently goes stale on the next retune. See this
  // recurring bug class documented in tracker item
  // recurring-bug-class-hardcoded-daily-gran-h6swgy.
  INITIAL_GRANT,
  DAILY_GRANT_AMOUNT,
  GRANT_CEILING,
  FIRST_PURCHASE_BONUS_MULTIPLIER
};
