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
//     tokens: { balance, lastClaimAt, streak },
//     appliedTokenPackPaymentIds, refundedJobIds,
//     firstPackPurchaseAt,
//     achievements: { [achievementId]: { grantedAt, type, amount|capability/count } },
//     capabilities: { [capabilityName]: count } }
//
// achievements / capabilities (tracker item
// for-product-build-server-side-achievemen-begfnb — infrastructure for the
// homepage's upcoming milestone rewards, e.g. streaks): see the big
// "ACHIEVEMENT / MILESTONE GRANT LEDGER" doc block further down (near
// applyAchievementGrant) for the full mechanism. Short version: `achievements`
// is a once-per-account-per-id ledger (mirrors `firstClaimAt`'s "grant this
// exactly once, ever" shape, generalized to an arbitrary id instead of one
// fixed field), and `capabilities` is the running redeemable balance of
// non-currency rewards (free re-edits, free interpretation lenses, free
// images) that capability-type achievement grants add to. Deliberately no
// ACTUAL achievement ids or grant sizes are wired to any real user-facing
// trigger yet — see that doc block's own "SHIPS NO GRANTS" note.
//
// tokens.lastClaimAt / tokens.streak (added 2026-07-28, "daily token
// claim" — replaces the old lazy background +20/24h drip entirely, see
// claim-daily-tokens.js and the big doc block below) are the ONLY
// per-user grant-timing state left on this record. A record with no
// tokens.lastClaimAt at all (every account that predates this feature)
// reads as claimable immediately — claimDailyTokens/getTokenStatus below
// both treat a missing lastClaimAt as `0`, and `now - 0` is always well
// past the cooldown, per the founder's own explicit confirmation on the
// tracker item that shipped this.
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
// earned partly for free and partly by claiming: 320 on first read of a
// never-before-seen email (the funnel's free onboarding video (100) plus
// one additional day-1 video (100) plus 2 images (20), plus a further
// +100 headroom — 2026-08-01 founder-directed bump, tracker xostu6), plus a
// further +20/day the user must actively CLAIM (claim-daily-tokens.js) —
// EXCEPT the account's first-ever claim ever, which grants +100 instead
// (2026-07-28 founder amendment — "enough to make more videos on the
// second day" — see FIRST_CLAIM_BONUS_AMOUNT's own doc comment below for
// the full reasoning and why this is keyed off a once-only firstClaimAt
// marker, not a streak day). This REPLACES the old lazy background +20/24h drip entirely (2026-07-28,
// "daily token claim", founder decision, replacing part of "Token Economy
// C"). The old drip (and its ≥200 grant ceiling — see the retired
// GRANT_CEILING) auto-materialized tokens on any read with nothing for the
// user to do; the founder's own stated reasoning for the switch was that a
// standard "daily reward, must tap to claim" pattern (games, Duolingo,
// TikTok-style check-ins) drives a real return-visit habit a silent
// background drip never could, and removes any need for a ceiling at all —
// see claim-daily-tokens.js's own header comment for the full claim
// mechanism (rolling 20h server-clock cooldown, no calendar days) and why
// an un-claimed idle account now accumulates nothing (no ceiling needed,
// since nothing accrues without an active tap). This remains true even
// now that shop.html's token packs are a live, real purchase (see
// creditTokenPackOnce below and
// docs/PAYWALL_SETUP.md): the free/claimed grants and paid packs are both
// additive to the same balance, never either/or. Because every token
// anyone can ever spend was, from day one, either free-earned/claimed or
// (now) purchased — never gated behind a subscription that had to exist
// first — this gate is UNCONDITIONAL AND LIVE FROM THE START, unlike the
// old subscription paywall (PAYWALL_ENABLED, E108/E111) which stayed
// default-off until real Stripe checkout existed — being entitled there
// required having actually paid, so gating on it before a checkout flow
// existed would have hard-blocked everyone. This model can never fully
// block anyone (the 320-token signup grant plus a daily claim guarantee
// continued access), it just rate-limits free usage to a sustainable
// level, now gated behind an active tap rather than a silent drip. See
// generate-video.js's E112 doc block and AGENT_POLICY.md for the full
// reasoning.
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
// negative (spendTokens floors at 0). No ceiling of any kind (the old
// ≥200 GRANT_CEILING is retired along with the drip it guarded — see the
// doc block above): an idle account accumulates nothing beyond whatever
// it already has, since nothing accrues without an active claim tap, so
// there is no unbounded-idle-accrual risk left for a ceiling to guard
// against.
//
// tokens.lastClaimAt: epoch-ms timestamp of the most recent SUCCESSFUL
// daily claim (claim-daily-tokens.js), or absent entirely for any account
// that hasn't claimed yet — including every account that predates this
// feature, which the founder confirmed must read as claimable immediately
// (see claimDailyTokens/getTokenStatus below, both of which treat a
// missing lastClaimAt as `0`). Never touched by the old lazy-grant
// machinery; the only writer is claimDailyTokens.
//
// tokens.streak: display-only claim-streak counter (v1: no escalation, no
// milestones, no freeze mechanic tied to it — see claim-daily-tokens.js's
// own doc comment). Bumped to `previous + 1` on a claim whose gap since
// the last claim is under 48h (a deliberately generous continuity window,
// wider than the 20h cooldown itself, so an early-in-the-day claim one day
// followed by a late-in-the-day claim the next doesn't break the streak),
// reset to `1` on any longer gap (including the very first-ever claim,
// where there is no previous claim to be continuous with).
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
var effectiveConfig = require('./effective-config');

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

// 320 initial = free funnel video (100) + one additional day-1 video (100)
// + 2 images (20) + a further +100 headroom (2026-08-01 founder-directed
// bump, tracker xostu6 — "add 100 tokens to the base balance of every new
// user so they get some more capabilities") — unchanged by the
// daily-claim switch (2026-07-28), see the doc block at the top of this
// file for the full retune history.
var INITIAL_GRANT = 320;

// The daily-claim mechanism (claim-daily-tokens.js) — replaces the old
// DAILY_GRANT_AMOUNT/GRANT_CEILING/GRANT_INTERVAL_MS lazy-drip trio
// entirely, see the doc block at the top of this file. Flat 20/day in v1
// (no escalating amounts — explicitly out of scope, see claim-daily-
// tokens.js's own doc comment) EXCEPT the account's first-ever claim ever,
// which grants FIRST_CLAIM_BONUS_AMOUNT (100) instead — see that constant's
// own doc comment below and claimDailyTokens' amount-selection logic.
//
// CLAIM_COOLDOWN_MS (20h, not 24h): a ROLLING cooldown measured purely off
// the server clock (`now - lastClaimAt >= CLAIM_COOLDOWN_MS`) — never a
// calendar-day/timezone comparison anywhere in this mechanism. This is
// deliberate and the single most important property of this feature (the
// growth research that proposed it called this out as the #1 bug class
// for daily-reward mechanics): a strict 24h-or-calendar-day cooldown
// either lets a user claim earlier and earlier each day by claiming right
// at the boundary (calendar-day version), or creates a real risk of
// missing a whole day if "today" is computed in the wrong timezone/across
// a DST transition (naive 24h-from-midnight version). 20h (4h shorter than
// a full day) instead gives every legitimate daily claimer comfortable
// slack to claim at roughly the same time each day without ever having to
// watch a clock, while still only allowing one claim per rolling ~day.
//
// STREAK_CONTINUITY_MS (48h): the window a NEW claim's gap-since-last-claim
// must fall under to continue (rather than reset) the streak — see
// tokens.streak's own doc comment above for why this is wider than the
// cooldown itself.
var CLAIM_COOLDOWN_MS = 20 * 60 * 60 * 1000;
var STREAK_CONTINUITY_MS = 48 * 60 * 60 * 1000;
var DAILY_CLAIM_AMOUNT = 20;

// FIRST_CLAIM_BONUS_AMOUNT (2026-07-28, founder-approved economy amendment,
// tracker item for-product-daily-claim-bugs-founder-rea-kei2ub, relayed via
// Manager): the account's FIRST-EVER successful daily claim grants 100
// tokens instead of the usual 20 — founder's own words, "I want users to
// have enough to make more videos on the second day so let's make the free
// tokens on the second day be 100". A returning day-2 user who claims for
// the very first time can then afford another full video (100 tokens) on
// top of whatever they still have left from the 320-token signup grant.
//
// Deliberately a CLAIM-COUNT/`firstClaimAt` rule, NOT a streak-day-2 rule:
// a streak-based "day 2 of a streak gets 100" would re-grant the bonus
// after every streak reset caused by a missed day (see tokens.streak's own
// doc comment — a missed day resets the streak to 1, and under a
// streak-based rule that reset "day 2" would recur indefinitely), making it
// trivially farmable just by skipping a day now and then. first-claim-EVER
// happens at most once per account, ever, matching the founder's actual
// intent (a returning user affording their next video), not a repeatable
// exploit. See `firstClaimAt` (claimDailyTokens below) for the actual
// once-only marker this is keyed off, and getTokenStatus for how this
// is projected to the client BEFORE a claim happens (so every UI surface
// shows the real upcoming amount, never a hardcoded 20 — the recurring bug
// class documented in tracker item
// recurring-bug-class-hardcoded-daily-gran-h6swgy).
//
// Abuse exposure: the one-time +80 delta (100 vs the usual 20) is bounded
// by the SAME per-IP daily cap that already guards the 320-token signup
// grant (MAX_TOKEN_GRANTS_PER_IP_PER_DAY / the "token-init" rate-limit
// bucket, see below) — a genuinely first-ever claim can only ever happen
// for an email whose tokens were never initialized before (no
// `tokens.lastClaimAt` AND no `firstClaimAt`, see the `isFirstEverClaim`
// check in claimDailyTokens), and claimDailyTokens always calls syncTokens
// first (see its own doc comment), which is exactly the choke point that
// cap already enforces on brand-new emails. So farming the bonus requires
// farming brand-new accounts in the first place — already capped at
// MAX_TOKEN_GRANTS_PER_IP_PER_DAY (default 5) per IP per day, same as
// today's INITIAL_GRANT exposure — not a new, wider abuse surface.
// claim-daily-tokens.js's OWN "claim-ip"/"claim-email" rate-limit bucket
// (20/day default) is a separate, looser guard against retry-hammering a
// single already-known email; it is not what bounds this specific
// exposure, the token-init cap is.
var FIRST_CLAIM_BONUS_AMOUNT = 100;

// Per-IP daily cap on brand-new-email token initializations — see
// AGENT_POLICY.md / the founder's token-economy spec for the abuse vector:
// js/store.js's signup() is 100% client-side (localStorage only, confirmed
// by reading it — there is no server touchpoint at account-creation time at
// all today), so a scripted attacker can create unlimited accounts purely
// to farm the 320-token signup bonus, each one worth up to ~$2.40-4.80 of
// real fal.ai generation cost (up to 3 full 100-token video generations,
// same $0.80-1.60/video basis as before the 2026-08-01 grant bump) with no
// payment and no email verification.
//
// Rather than inventing new server-side signup-registration plumbing just
// to enforce a rate limit (a new, wider surface for a narrow problem), this
// gates the actual moment the 320-token grant becomes real cost exposure:
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
// since this isn't the generation gate); the account is otherwise created
// normally and can still claim its first +20 via claim-daily-tokens.js as
// soon as the founder-confirmed "no lastClaimAt yet -> claimable
// immediately" rule allows (see that function). This only ever runs once
// per email (the branch it's in is only reached while `tokens` has never
// been set), so a legitimate user is never repeatedly rate-limited just
// for reading their own already-initialized balance.
var MAX_TOKEN_GRANTS_PER_IP_PER_DAY_DEFAULT = 5;

// Logs this lib's resolved MAX_TOKEN_GRANTS_PER_IP_PER_DAY effective value
// once per cold start (tracker item for-product-damage-assessment-env-
// var-ca-rmgaqh — see lib/effective-config.js's own doc block for the
// full "why"; this is the same env-var-with-a-code-default shape as
// generate-video.js's/generate-image.js's/start-pending-generation.js's
// MAX_GENERATIONS_PER_IP_PER_DAY, just gating first-ever token-balance
// reads instead of a generation submission). Module-level, not inside
// getTokenStatus below, so this runs exactly once per cold Lambda
// instance regardless of which function (generate-video.js,
// get-token-status.js, claim-daily-tokens.js, etc.) happens to require
// this shared lib first and trigger that cold start — labeled
// fn=entitlements (this module's own name) rather than any one caller's,
// since a shared lib genuinely has no single "the function" to attribute
// it to.
effectiveConfig.logEffectiveConfigOnce('entitlements', [
  { envVar: 'MAX_TOKEN_GRANTS_PER_IP_PER_DAY', default: MAX_TOKEN_GRANTS_PER_IP_PER_DAY_DEFAULT, type: 'int' }
]);

/**
 * The read-side engine, shared by getTokenStatus (read) and spendTokens
 * (spend) so both always see the same up-to-date balance before acting on
 * it. Returns the raw `{ balance, lastClaimAt, streak }` tokens sub-object
 * (already persisted if this was the first-ever read for this email) —
 * never the full public getTokenStatus shape, callers that want that call
 * getTokenStatus itself. NOTE: unlike its pre-2026-07-28 self, this no
 * longer applies any daily grant — it only ever materializes the one-time
 * INITIAL_GRANT on a brand-new email's first read. The daily +20 is now
 * claimed, not synced — see claimDailyTokens below, the only writer of
 * lastClaimAt/streak.
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
 * in this function or file — it has no effect on the daily claim,
 * spendTokens, addTokens, or (critically) the E112/E412 balance-threshold
 * check itself, which callers apply completely independently of this — a
 * bypassed IP still gets exactly INITIAL_GRANT (320) tokens, no more, same
 * as any other brand-new email that simply wasn't IP-capped.
 *
 * Return value also carries `justSeeded` (2026-07-29, tracker item
 * entitlements-js-retryingwrite-balance-mu-qxm1ih): true only on the
 * branch below that just materialized this email's FIRST-EVER tokens
 * sub-object via a write in THIS SAME call, false whenever `record.tokens`
 * already existed before this call started (nothing was written here).
 * Purely an internal signal — never exported, never persisted onto the
 * entitlement record itself — consumed only by creditTokenPackAmountOnce/
 * refundTokenAmountOnce/applyAchievementGrantOnce's shared
 * baseTokensForAttempt helper (see its own doc comment) to know whether
 * attempt 0 of their OWN following retryingWrite loop is allowed to trust
 * its own fresh read yet: right after THIS write, Netlify Blobs' lack of a
 * read-your-own-write guarantee means that attempt's read can still
 * legitimately show the pre-seed state (or nothing at all) for a brief
 * window, so only in that specific justSeeded-and-first-attempt case must
 * the caller fall back to this return value instead.
 */
async function syncTokens(event, email, opts) {
  var key = normalizeEmail(email);
  if (!key) return { balance: 0 };

  var record = await getEntitlement(event, key);
  // `firstPackPurchaseAt` lives at the TOP LEVEL of the entitlement record
  // (stamped by creditTokenPackAmountOnce, see its own doc comment), never
  // inside `record.tokens` — so it has to be read off `record` here and
  // carried through explicitly on every return path below, rather than
  // assumed to already be part of whatever `record.tokens` holds. Every
  // existing caller of syncTokens (spendTokens, addTokens,
  // creditTokenPackAmountOnce, refund crediting) explicitly picks only
  // `balance`/`lastClaimAt`/`streak` back off this return value when
  // building the `tokens` sub-object it writes, so adding this field here
  // never risks it getting persisted into `record.tokens` itself.
  var firstPackPurchaseAt = record && record.firstPackPurchaseAt;
  // `firstClaimAt` (2026-07-28 first-claim-bonus amendment, see
  // FIRST_CLAIM_BONUS_AMOUNT's own doc comment) — same top-level-sibling
  // shape as firstPackPurchaseAt above (stamped by claimDailyTokens, never
  // inside `record.tokens`), carried through here purely so getTokenStatus
  // below can project the correct upcoming claim amount BEFORE a claim
  // happens. Same "never risks leaking into record.tokens" reasoning as
  // firstPackPurchaseAt applies here too.
  var firstClaimAt = record && record.firstClaimAt;

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

    // No lastClaimAt stamped here — a brand-new record deliberately has
    // none, which is exactly the "claimable immediately" state (see
    // claimDailyTokens/getTokenStatus, both of which treat a missing
    // lastClaimAt as `0`). This also covers every pre-existing account
    // that predates this feature and never got a tokens.lastClaimAt at
    // all — same fresh-read path, same immediately-claimable outcome, per
    // the founder's own explicit confirmation.
    var fresh = ipCheck.allowed
      ? { balance: INITIAL_GRANT }
      : { balance: 0 }; // capped for today — see doc block above, not a permanent block

    // ACCEPTED LAZY-SEED RACE (tracker item decide-blobs-lazy-seed-race):
    // this write is plain/unguarded, and the installed @netlify/blobs SDK
    // has no atomic/conditional-write primitive to make "materialize a
    // default on first read" race-proof. Two genuinely concurrent
    // first-ever reads for the SAME email (two tabs, a signup racing an
    // immediate generation) could each see `!record.tokens`, each compute
    // an IDENTICAL `fresh` value, and each write — a redundant write, not
    // a corrupting one, since both writes agree on the value. The one real
    // side effect is `checkAndIncrement('token-init', ...)` above
    // potentially being counted twice for what's effectively one grant.
    // Same class of one-time, low-frequency bootstrap race as
    // tracker-store.js's own getItems() seed branch — documented rather
    // than fixed with a separate "seeded" marker key, per that tracker
    // item's own cheaper option, given the low real-world likelihood
    // (single email, narrow window) and non-corrupting outcome here.
    await setEntitlement(event, key, { tokens: fresh });
    return Object.assign({}, fresh, { firstPackPurchaseAt: firstPackPurchaseAt, firstClaimAt: firstClaimAt, justSeeded: true });
  }

  return Object.assign({}, record.tokens, { firstPackPurchaseAt: firstPackPurchaseAt, firstClaimAt: firstClaimAt, justSeeded: false });
}

/**
 * Reads this email's current token status, applying the one-time 320-token
 * first-ever-read grant if needed (see syncTokens above) — the daily +20 is
 * a separate, explicit CLAIM (claimDailyTokens below), never applied
 * lazily by this read. Returns
 * { balance, claimable, nextClaimAt, dailyClaimAmount, streak,
 * hasMadeFirstPurchase }.
 *
 * `claimable`: true whenever `now - lastClaimAt >= CLAIM_COOLDOWN_MS` (a
 * missing lastClaimAt reads as `0`, so a never-claimed account — brand new
 * or pre-existing — is always claimable). This is a READ-ONLY projection
 * for the UI (the pulsing chip state, the claim sheet's own enable/disable)
 * — it has no side effect and never itself grants anything; only
 * claimDailyTokens actually credits tokens, and it independently
 * recomputes this same condition server-side rather than trusting a
 * client's claim that a previous getTokenStatus call said `claimable:true`
 * (a stale read plus a delayed claim tap must not be able to claim twice).
 *
 * `nextClaimAt`: an epoch-ms timestamp (lastClaimAt + CLAIM_COOLDOWN_MS,
 * or effectively "now" for a never-claimed account since lastClaimAt reads
 * as 0) for the UI's own countdown, same "epoch-ms the client formats
 * itself" shape the old nextGrantAt used.
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
 * leak more than it needs. Untouched by the daily-claim switch.
 *
 * Optional 3rd arg `opts` is forwarded as-is to syncTokens — see that
 * function's own doc comment for `opts.ownerBypass`. This does NOT change
 * the E112/E412 threshold check itself (`balance < 100`/`< 10`) — that
 * comparison lives entirely in the caller (generate-video.js/
 * generate-image.js) against whatever balance this returns, unconditional
 * either way.
 *
 * `dailyClaimAmount` (2026-07-28 first-claim-bonus amendment — see
 * FIRST_CLAIM_BONUS_AMOUNT's own doc comment): this is the amount THIS
 * user would actually be credited if they claimed right now — not always
 * the flat DAILY_CLAIM_AMOUNT. An account that has never completed a
 * claim (no `firstClaimAt` AND no `tokens.lastClaimAt` — see
 * hasCompletedAnyClaim below, the exact same check claimDailyTokens uses
 * to decide the amount it actually credits) sees FIRST_CLAIM_BONUS_AMOUNT
 * (100) here; every other account sees the normal DAILY_CLAIM_AMOUNT (20).
 * Every UI surface (the claim sheet's big number, its button label, the
 * topbar chip's "+N" pill, the out-of-tokens sheet's inline claim button)
 * reads this field live rather than hand-maintaining its own literal — see
 * js/purchase-sheet.js and tracker item
 * recurring-bug-class-hardcoded-daily-gran-h6swgy for why that discipline
 * matters here specifically.
 */
function hasCompletedAnyClaim(firstClaimAt, lastClaimAt) {
  return !!(firstClaimAt || lastClaimAt);
}

async function getTokenStatus(event, email, opts) {
  var tokens = await syncTokens(event, email, opts);
  var lastClaimAt = tokens.lastClaimAt || 0;
  var nextClaimAt = lastClaimAt + CLAIM_COOLDOWN_MS;
  return {
    balance: tokens.balance,
    claimable: (Date.now() - lastClaimAt) >= CLAIM_COOLDOWN_MS,
    nextClaimAt: nextClaimAt,
    dailyClaimAmount: hasCompletedAnyClaim(tokens.firstClaimAt, lastClaimAt) ? DAILY_CLAIM_AMOUNT : FIRST_CLAIM_BONUS_AMOUNT,
    streak: tokens.streak || 0,
    hasMadeFirstPurchase: !!tokens.firstPackPurchaseAt
  };
}

/**
 * The daily-claim writer — called only from claim-daily-tokens.js's POST
 * handler. Re-derives claimability itself, server-side, off the SAME
 * `now - lastClaimAt >= CLAIM_COOLDOWN_MS` rolling check getTokenStatus
 * uses (never trusting a client-supplied "I know I'm claimable" signal —
 * a stale getTokenStatus read plus a delayed tap must not be able to
 * double-claim).
 *
 * ----------------------------------------------------------------------
 * CONCURRENCY (review finding, round 1): a bare read -> setEntitlement
 * write is NOT safe against two genuinely concurrent claim attempts for
 * the same email (two open tabs, a retried client request) — this file's
 * own header comment and creditTokenPackOnce/refundTokensOnce already
 * document, with a proven-in-this-file's-own-test-suite incident, why a
 * naive single write is unsafe under this codebase's eventually-
 * consistent Blobs reads. Fixed the same documented way every other
 * balance-mutating path in this file already does: blobsRetry.retryingWrite
 * re-checks the SAME cooldown condition fresh on every attempt (inside
 * `mutate`, off that attempt's own read), SKIPping if some other request
 * already claimed this window between our outer syncTokens call and this
 * attempt's read — so two racing claims can land at most ONE credit
 * between them, never two, and the loser gets an honest `claimed:false`
 * (not a fabricated success) with `nextClaimAt` derived from whichever
 * record actually won. `verify` deliberately checks a fresh random
 * `attemptId` (see that var's own doc comment below), NOT `lastClaimAt
 * === now` — two genuinely concurrent calls can capture the IDENTICAL
 * `now` millisecond, which would make both writes look indistinguishable
 * to a timestamp-based verify and let both report `claimed:true` (caught
 * by this file's own round-1-of-round-1 concurrency test before this was
 * corrected).
 *
 * Streak: `gap = now - lastClaimAt` inside `mutate`, using THAT attempt's
 * own fresh `lastClaimAt` (never the outer syncTokens call's, which could
 * be stale by the time this attempt's write actually lands) — the
 * `tokens.lastClaimAt` truthiness check still guards the first-claim-ever
 * case the same way (a missing lastClaimAt must start streak at 1, never
 * "continue" a streak that never existed, regardless of what the gap math
 * alone would say). `gap < STREAK_CONTINUITY_MS` (48h) -> `previousStreak
 * + 1`, else resets to `1` — see tokens.streak's own doc comment (top of
 * file) for why 48h, not 20h/24h.
 *
 * Exhaustion (every attempt's verify failed): same fail-loud posture as
 * creditTokenPackAmountOnce — one more plain, unhurried read to catch the
 * common "our write actually landed, only the verify-read lagged" case
 * before ever reporting success; if that still doesn't show OUR `now`
 * stamped as lastClaimAt, throws rather than silently returning a
 * not-claimed result that could actually mask a real (if rare) failure —
 * claim-daily-tokens.js's handler turns this into a 500 the client's
 * existing "Couldn't claim right now" retry copy already covers.
 *
 * Returns EXACTLY the two documented response shapes (see this file's own
 * doc block and claim-daily-tokens.js), PLUS `amountClaimed` on a genuine
 * claim (2026-07-28 first-claim-bonus amendment — see
 * FIRST_CLAIM_BONUS_AMOUNT's own doc comment): the ACTUAL amount just
 * credited (100 on a genuine first-ever claim, 20 otherwise), so the
 * client shows what really happened rather than assuming a flat 20:
 *   { claimed: true,  balance, streak, nextClaimAt, amountClaimed } — a
 *     genuine claim, just written and confirmed.
 *   { claimed: false, nextClaimAt }                  — not yet claimable
 *     (including "someone else's concurrent claim already landed" — the
 *     SKIP case above); NOT an error, a normal, expected outcome (see
 *     claim-daily-tokens.js's own doc comment on why this is a 200, not a
 *     4xx). No `amountClaimed` here — nothing was actually credited.
 *
 * A missing/empty email resolves to `{ claimed: false, nextClaimAt: 0 }` —
 * mirrors syncTokens' own "an unidentifiable caller never creates a
 * phantom record, and never claims anything" guard.
 *
 * `firstClaimAt`: a top-level record field (sibling of
 * lastClaimAttemptId/firstPackPurchaseAt, never inside `tokens`), stamped
 * to `now` the first time this email's `mutate` below computes
 * `isFirstEverClaim: true`, and NEVER overwritten again afterward
 * (`rec.firstClaimAt || now`) — see FIRST_CLAIM_BONUS_AMOUNT's own doc
 * comment for the full reasoning (once-only, first-claim-EVER, not
 * streak-based). `isFirstEverClaim` itself checks BOTH `rec.firstClaimAt`
 * AND `tokens.lastClaimAt` (via hasCompletedAnyClaim, the exact same check
 * getTokenStatus uses to project the upcoming amount) — not `firstClaimAt`
 * alone — specifically so an account that already completed a claim under
 * the pre-2026-07-28 flat-20-only regime (real accounts exist from
 * earlier the same day this bonus shipped, before this field existed) is
 * correctly recognized as having already had its "first claim" and never
 * retroactively re-granted the bonus just because `firstClaimAt` was never
 * backfilled for it. `tokens.lastClaimAt` alone is sufficient signal for
 * that grandfather case since it is ONLY ever set by a genuine successful
 * claim (see that field's own doc comment at the top of this file).
 */
async function claimDailyTokens(event, email) {
  var key = normalizeEmail(email);
  if (!key) return { claimed: false, nextClaimAt: 0 };

  // Ensures the lazy first-read INITIAL_GRANT (syncTokens) has already
  // landed before this record is touched via blobsRetry directly below —
  // same sequencing creditTokenPackAmountOnce follows, for the same
  // reason (a brand-new email's first-ever grant must exist before any
  // later credit path reads/mutates the record).
  //
  // The return value is captured (2026-08-01 fix, tracker item
  // for-product-bug-founder-repro-high-brand-1dtzdc) — it used to be
  // discarded here, which was the actual root cause of a brand-new
  // account's very first claim silently losing its 220-token signup
  // grant: unlike creditTokenPackAmountOnce/refundTokenAmountOnce/
  // applyAchievementGrantOnce (all fixed 2026-07-29, tracker item
  // entitlements-js-retryingwrite-balance-mu-qxm1ih, via this exact
  // baseTokensForAttempt/syncedTokens pattern — see that helper's own doc
  // comment for the full reasoning), this function's `mutate` below used
  // to read balance straight off `rec.tokens` on every attempt, including
  // attempt 0. For a genuinely brand-new email, the `syncTokens` call
  // directly above JUST wrote the INITIAL_GRANT seed moments earlier in
  // this SAME call — and Netlify Blobs has no read-your-own-write
  // guarantee (this file's own header comment), so attempt 0's own fresh
  // read can legitimately still show the pre-seed (no-tokens) record.
  // Without this fix, that phantom `{balance:0}` became the base the
  // claim amount was added to, quietly discarding the real 220-token
  // grant — home.html's auto-open-right-after-signup flow, firing a claim
  // only seconds after the account (and its entitlement record) was
  // created, makes this the near-guaranteed default path for every new
  // signup rather than a rare edge case.
  var syncedTokens = await syncTokens(event, key);
  var attemptIndex = 0;

  var now = Date.now();
  var newBalance, newStreak, claimAmount;

  // `attemptId`: a fresh random token per call, NOT derived from `now` —
  // two genuinely concurrent claims for the same email (two open tabs, a
  // retried client request) can easily capture the IDENTICAL `Date.now()`
  // millisecond (near-certain when triggered synchronously, e.g. by this
  // file's own concurrency tests, and entirely plausible under real
  // production load too). `verify` originally compared
  // `verifyRead.tokens.lastClaimAt === now` — but if both racers land on
  // the same `now`, BOTH writes look identical and BOTH verifies pass,
  // so both calls report `claimed:true` even though only one is the
  // record's actual final state (the classic "verify returns true for
  // both callers" hazard this file's own header comment already warns
  // about for a naive design). Stamping a random `attemptId` — astronomically
  // unlikely to collide between two genuinely different calls even in the
  // same millisecond — and checking THAT for equality instead gives each
  // attempt a way to tell whether the persisted record actually reflects
  // its own write or a concurrent racer's, regardless of timestamp
  // collisions. Lives at the TOP LEVEL of the record (a sibling of
  // firstPackPurchaseAt/appliedTokenPackPaymentIds), not inside `tokens`,
  // so `tokens` itself stays exactly `{balance, lastClaimAt, streak}` —
  // no cleanup write needed, a stale value here is inert (only ever
  // compared against a fresh `attemptId` a later call mints for itself).
  var attemptId = crypto.randomBytes(12).toString('hex');

  var result = await blobsRetry.retryingWrite(event, STORE_NAME, key, {
    maxAttempts: MAX_CREDIT_ATTEMPTS,
    read: function (evt) {
      connectLambda(evt);
      return store().get(key, { type: 'json' });
    },
    mutate: function (existing) {
      var currentAttempt = attemptIndex;
      attemptIndex++;
      var rec = existing || { email: key };
      var tokens = rec.tokens || { balance: 0 };
      var lastClaimAt = tokens.lastClaimAt || 0;
      // Fresh, per-attempt re-check — a concurrent claim from another
      // request/tab may have already landed between our outer syncTokens
      // read above and this attempt's read. Deliberately off THIS
      // attempt's own fresh `rec`/`tokens` (never `syncedTokens`) — the
      // cooldown/streak/first-claim decision must always reflect the most
      // current state a real concurrent claim could have already written.
      // baseTokensForAttempt below only ever supplies a trustworthy
      // BALANCE base for a still-propagating seed write — see its own doc
      // comment — it is never a stand-in for this claimability check.
      if (now - lastClaimAt < CLAIM_COOLDOWN_MS) return blobsRetry.SKIP;
      var gap = now - lastClaimAt;
      var previousStreak = tokens.streak || 0;
      newStreak = (tokens.lastClaimAt && gap < STREAK_CONTINUITY_MS) ? previousStreak + 1 : 1;
      // See FIRST_CLAIM_BONUS_AMOUNT's own doc comment and this function's
      // doc comment above for the full reasoning — grandfathers any
      // account whose tokens.lastClaimAt was already set before
      // firstClaimAt existed, so it's never re-granted the bonus.
      var isFirstEverClaim = !hasCompletedAnyClaim(rec.firstClaimAt, tokens.lastClaimAt);
      claimAmount = isFirstEverClaim ? FIRST_CLAIM_BONUS_AMOUNT : DAILY_CLAIM_AMOUNT;
      // baseTokensForAttempt (2026-08-01 fix, tracker item for-product-bug-
      // founder-repro-high-brand-1dtzdc — see this function's own doc
      // comment above for the full incident): on attempt 0 of a call whose
      // OWN syncTokens just seeded this record, `rec.tokens` (this
      // attempt's fresh read) may still legitimately show the pre-seed
      // state under Blobs' no-read-your-own-write guarantee, so the
      // BALANCE is based on `syncedTokens` (this call's own in-memory copy
      // of what it just wrote) instead of trusting that read — same rule
      // creditTokenPackAmountOnce/refundTokenAmountOnce/
      // applyAchievementGrantOnce already apply. Every other case trusts
      // this attempt's own fresh `rec.tokens`, so a real concurrent
      // spendTokens/addTokens/another claim that landed since our outer
      // syncTokens call is still correctly picked up rather than reverted.
      var baseTokens = baseTokensForAttempt(currentAttempt, rec, syncedTokens);
      newBalance = Math.min(MAX_TOKEN_BALANCE, baseTokens.balance + claimAmount);
      return Object.assign({}, rec, {
        email: key,
        tokens: { balance: newBalance, lastClaimAt: now, streak: newStreak },
        lastClaimAttemptId: attemptId,
        firstClaimAt: rec.firstClaimAt || now,
        updatedAt: now
      });
    },
    verify: function (verifyRead) {
      return !!(verifyRead && verifyRead.lastClaimAttemptId === attemptId);
    }
  });

  if (result.skipped) {
    // SKIP fires whenever a fresh read already shows a cooldown in
    // effect -- which includes the read seeing OUR OWN just-written
    // record from an earlier attempt in this same call, once its verify
    // (which raced the write under Blobs' eventual consistency) had
    // already failed and looped back to a fresh read that then caught up.
    // Without this check that self-clobber gets misreported as
    // claimed:false even though the credit genuinely landed -- the same
    // "was this actually my own write" hazard the exhaustion branch below
    // already guards against, just reachable one step earlier here.
    if (result.current && result.current.lastClaimAttemptId === attemptId) {
      return { claimed: true, balance: result.current.tokens.balance, streak: result.current.tokens.streak, nextClaimAt: now + CLAIM_COOLDOWN_MS, amountClaimed: claimAmount };
    }
    var currentLastClaimAt = (result.current && result.current.tokens && result.current.tokens.lastClaimAt) || 0;
    return { claimed: false, nextClaimAt: currentLastClaimAt + CLAIM_COOLDOWN_MS };
  }

  if (result.ok) {
    return { claimed: true, balance: newBalance, streak: newStreak, nextClaimAt: now + CLAIM_COOLDOWN_MS, amountClaimed: claimAmount };
  }

  var finalRead = await getEntitlement(event, key);
  if (finalRead && finalRead.lastClaimAttemptId === attemptId) {
    return { claimed: true, balance: finalRead.tokens.balance, streak: finalRead.tokens.streak, nextClaimAt: now + CLAIM_COOLDOWN_MS, amountClaimed: claimAmount };
  }
  throw new Error('claimDailyTokens: exhausted attempts claiming for ' + key + ' without ever confirming the claim landed');
}

// ── STANDING CHECKLIST for adding a new low-frequency field to this
//    record (recurring-pattern-new-entitlements-js-wr-m5mo9g) ──
// spendTokens/addTokens below are this record's only remaining PLAIN
// (unguarded, no retry/verify) writers — an already-accepted tradeoff
// since spendTokens is by far the highest-frequency writer to this store
// (fires on every generation) and a full retryingWrite there would be
// needless overhead for a fire-and-forget balance decrement. Every OTHER
// field on this record (dodoCustomerId, appliedTokenPackPaymentIds,
// firstPackPurchaseAt, lastClaimAttemptId, refundedJobIds, ...) is written
// through blobsRetry.retryingWrite instead, specifically because a plain
// write racing spendTokens/addTokens can silently clobber whichever one
// lands second (see dodoCustomerId's own doc comment above for a full
// worked example of exactly this class of bug, caught in review before it
// shipped). So: when adding a NEW low-frequency field to this record, fold
// it into an EXISTING hardened retryingWrite call (creditTokenPackAmountOnce,
// claimDailyTokens, refundTokenAmountOnce — whichever already fires at a
// point in the field's own natural lifecycle) rather than adding a
// standalone plain setEntitlement call beside it. Only spendTokens/
// addTokens themselves get to stay plain, and only because their own
// tradeoff (frequency vs. race-safety) has already been explicitly
// accepted — a new field does not inherit that exemption just by being
// written near them.

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
  // lastClaimAt/streak carried through unchanged — a spend must never
  // reset the claim cooldown or streak, same "purely additive/subtractive
  // to balance only" discipline this file already applies everywhere else
  // a full `tokens` sub-object gets rewritten.
  return setEntitlement(event, key, { tokens: { balance: newBalance, lastClaimAt: tokens.lastClaimAt, streak: tokens.streak } });
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
 * daily-claim machinery: `lastClaimAt`/`streak` are carried through
 * unchanged (never bumped/reset), so a top-up never resets or delays the
 * next daily claim's cooldown/streak — it is purely additive to `balance`,
 * nothing else about the record's claim state changes because of it.
 * Result is capped at MAX_TOKEN_BALANCE (see above). No-ops (returns null,
 * writes nothing) for an empty/missing email, matching spendTokens' and
 * syncTokens' own guard.
 */
async function addTokens(event, email, amount) {
  var key = normalizeEmail(email);
  if (!key) return null;
  var tokens = await syncTokens(event, key);
  var newBalance = Math.min(MAX_TOKEN_BALANCE, tokens.balance + amount);
  return setEntitlement(event, key, { tokens: { balance: newBalance, lastClaimAt: tokens.lastClaimAt, streak: tokens.streak } });
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
 * not something this fix introduces or specifically defends against. This
 * is a genuinely DIFFERENT, narrower race than the one fixed 2026-07-29
 * (tracker item entitlements-js-retryingwrite-balance-mu-qxm1ih, see the
 * `syncedTokens`/`baseTokensForAttempt` doc comments below): that fix
 * closes the "our OWN retry loop reuses a stale pre-loop snapshot instead
 * of a later attempt's fresh read" gap; THIS disclosure is about a
 * completely unguarded plain writer (no retryingWrite, no verify at all)
 * landing inside the single-attempt window between our own read and our
 * own write — inherent to Blobs having no compare-and-swap, and not
 * closable by re-deriving from a fresher read, since there IS no fresher
 * read available at that exact instant.
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

/**
 * Chooses the base `{balance, lastClaimAt, streak}` a single retryingWrite
 * ATTEMPT should build its new `tokens` sub-object from — shared by
 * creditTokenPackAmountOnce, refundTokenAmountOnce, and
 * applyAchievementGrantOnce, the three functions that share the exact same
 * "syncTokens once, then a bounded read -> mutate -> write -> verify loop"
 * shape (see any one's own doc comment for the full mechanism this is
 * part of). Exists purely so this one piece of logic can't drift three
 * separate ways.
 *
 * `attemptIndex` is 0 for the FIRST attempt of the caller's own
 * retryingWrite loop, incrementing on every subsequent attempt — callers
 * track this themselves (a closure counter bumped once per `mutate` call,
 * since `mutate` runs exactly once per attempt in lockstep with `read`).
 *
 * Rule (2026-07-29 fix, tracker item
 * entitlements-js-retryingwrite-balance-mu-qxm1ih — the bug this closes,
 * and the read-your-own-write hazard it must NOT reopen, are both
 * explained in full on each of the three callers' own doc comments):
 *   - `attemptIndex === 0 && syncedTokens.justSeeded`: this call's own
 *     outer `syncTokens` JUST materialized this email's first-ever tokens
 *     sub-object with a write, moments ago, in this exact same call.
 *     Netlify Blobs has no read-your-own-write guarantee, so attempt 0's
 *     own fresh read can still legitimately show the pre-seed record (or
 *     nothing at all) — `rec.tokens` is NOT trustworthy yet here, so
 *     `syncedTokens` (this call's own in-memory copy of the value it just
 *     wrote) is the only safe base. This is a narrow, single-attempt
 *     window: by the time a SECOND attempt runs (blobs-retry.js's own
 *     real ~200ms inter-attempt delay), that one seed write has almost
 *     always propagated.
 *   - Every other case (a record whose tokens already existed before this
 *     call even started — `syncTokens` never wrote anything, so there is
 *     no read-your-own-write hazard from THIS call to guard against — or
 *     any attempt after the first): trust THIS attempt's own fresh
 *     `rec.tokens`, falling back to `syncedTokens` only if `rec.tokens`
 *     itself is entirely absent (mirrors this file's existing
 *     `rec.someArrayField || []` fallback discipline for other per-record
 *     fields). This is what lets a real concurrent claimDailyTokens/
 *     spendTokens/addTokens write that has landed on this SAME email's
 *     record since `syncTokens` was called get picked up and preserved,
 *     instead of being silently reverted by a stale pre-loop snapshot plus
 *     this function's own delta on top.
 */
function baseTokensForAttempt(attemptIndex, rec, syncedTokens) {
  if (attemptIndex === 0 && syncedTokens.justSeeded) return syncedTokens;
  return rec.tokens || syncedTokens;
}

async function creditTokenPackAmountOnce(event, email, paymentId, amount) {
  var key = normalizeEmail(email);
  if (!key) return { ok: false };

  // Ensures a brand-new email's tokens sub-object exists (materializing
  // INITIAL_GRANT via syncTokens' own lazy-seed branch) before this record
  // is touched via blobsRetry directly below, AND gives `mutate` a
  // fallback base for the narrow window where attempt 0's own fresh read
  // might not show that just-written tokens field yet (Netlify Blobs has
  // no read-your-own-write guarantee — this file's own header comment
  // documents the exact incident that forced this codebase off strong
  // consistency). See baseTokensForAttempt's own doc comment for the full
  // per-attempt rule this feeds — as of 2026-07-29 (tracker item
  // entitlements-js-retryingwrite-balance-mu-qxm1ih) this snapshot is
  // deliberately NOT reused verbatim on every retry attempt the way it
  // used to be: each attempt now re-derives balance/lastClaimAt/streak
  // from THAT attempt's own fresh `rec.tokens` whenever it's safe to trust
  // (falling back to this snapshot only in the one narrow case
  // baseTokensForAttempt documents), the same "trust the fresh per-attempt
  // read, don't reuse a stale pre-loop snapshot" discipline this
  // function's own appliedTokenPackPaymentIds/firstPackPurchaseAt fields
  // already followed. The old version reused this snapshot verbatim on
  // every attempt, which could silently revert a concurrent
  // claimDailyTokens/spendTokens/addTokens write that landed on this SAME
  // email's record between this call's outer syncTokens read and a later
  // retry attempt's successful write.
  var syncedTokens = await syncTokens(event, key);
  var attemptIndex = 0;

  var result = await blobsRetry.retryingWrite(event, STORE_NAME, key, {
    maxAttempts: MAX_CREDIT_ATTEMPTS,
    read: function (evt) {
      connectLambda(evt);
      return store().get(key, { type: 'json' });
    },
    mutate: function (existing) {
      var currentAttempt = attemptIndex;
      attemptIndex++;
      // This fresh-per-attempt read is used to check
      // appliedTokenPackPaymentIds (the idempotency guard against a
      // concurrent resume), firstPackPurchaseAt (the first-purchase-bonus
      // check, same reasoning — see this function's own doc comment), AND
      // (as of the 2026-07-29 fix) the base balance/lastClaimAt/streak via
      // baseTokensForAttempt — see that helper's own doc comment for
      // exactly when it trusts this fresh read vs. falls back to
      // `syncedTokens`.
      var rec = existing || { email: key };
      var appliedList = rec.appliedTokenPackPaymentIds || [];
      if (appliedList.indexOf(paymentId) !== -1) return blobsRetry.SKIP; // already applied by an earlier attempt
      var isFirstPurchase = !rec.firstPackPurchaseAt;
      var creditAmount = isFirstPurchase ? Math.round(amount * FIRST_PURCHASE_BONUS_MULTIPLIER) : amount;
      var baseTokens = baseTokensForAttempt(currentAttempt, rec, syncedTokens);
      var newBalance = Math.min(MAX_TOKEN_BALANCE, baseTokens.balance + creditAmount);
      return Object.assign({}, rec, {
        email: key,
        tokens: { balance: newBalance, lastClaimAt: baseTokens.lastClaimAt, streak: baseTokens.streak },
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
 *
 * Base balance/lastClaimAt/streak (2026-07-29 fix, tracker item
 * entitlements-js-retryingwrite-balance-mu-qxm1ih): same
 * `syncTokens`-then-`baseTokensForAttempt` discipline as
 * creditTokenPackAmountOnce — see either that function's own doc comment
 * or baseTokensForAttempt's for the full reasoning. In short: `syncedTokens`
 * (captured once, before the loop) still exists to (a) materialize a
 * brand-new email's INITIAL_GRANT before this record is ever touched here,
 * and (b) serve as attempt 0's ONLY trustworthy base in the narrow window
 * right after that same-call seed write, before it's had a chance to
 * propagate — but it is no longer reused verbatim on every later retry
 * attempt the way it used to be. Each attempt now re-derives its base from
 * THAT attempt's own fresh `rec.tokens` whenever `baseTokensForAttempt`
 * says it's safe to trust, so a real concurrent claimDailyTokens/
 * spendTokens/addTokens write landing on this SAME email's record between
 * this call's outer syncTokens read and a later retry attempt's
 * successful write is picked up and preserved, instead of being silently
 * reverted by a stale snapshot plus this function's own delta on top.
 */
async function refundTokenAmountOnce(event, email, jobId, amount) {
  var key = normalizeEmail(email);
  if (!key) return { ok: false };

  if (!jobId) {
    await addTokens(event, key, amount);
    return { ok: true };
  }

  var syncedTokens = await syncTokens(event, key);
  var attemptIndex = 0;

  var result = await blobsRetry.retryingWrite(event, STORE_NAME, key, {
    maxAttempts: MAX_CREDIT_ATTEMPTS,
    read: function (evt) {
      connectLambda(evt);
      return store().get(key, { type: 'json' });
    },
    mutate: function (existing) {
      var currentAttempt = attemptIndex;
      attemptIndex++;
      var rec = existing || { email: key };
      var refundedList = rec.refundedJobIds || [];
      if (refundedList.indexOf(jobId) !== -1) return blobsRetry.SKIP; // already applied by an earlier attempt
      var baseTokens = baseTokensForAttempt(currentAttempt, rec, syncedTokens);
      var newBalance = Math.min(MAX_TOKEN_BALANCE, baseTokens.balance + amount);
      return Object.assign({}, rec, {
        email: key,
        tokens: { balance: newBalance, lastClaimAt: baseTokens.lastClaimAt, streak: baseTokens.streak },
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

// ============================================================================
// ACHIEVEMENT / MILESTONE GRANT LEDGER — idempotent, once-per-account-per-id
// (tracker item for-product-build-server-side-achievemen-begfnb, mechanism
// only — see "SHIPS NO GRANTS" below)
// ----------------------------------------------------------------------------
// Infrastructure for the upcoming homepage feature's milestone rewards
// (streaks, "first repeated theme", etc.). Client-side-only achievement
// grants would be trivially farmable — a user can always replay/fake
// whatever client-side condition supposedly unlocked a reward — so, same
// reasoning as everything else in this file, a real grant has to be decided
// and recorded server-side, exactly once per account, ever.
//
// This generalizes the SAME anti-farming shape `firstClaimAt` already uses
// above (a once-only marker on the entitlement record, checked before
// crediting anything) from one hardcoded field to an arbitrary, open-ended
// set of achievement ids — `firstClaimAt` answers exactly one question
// ("has this account EVER completed a claim"); `achievements` answers the
// same shape of question for however many distinct achievement ids the
// homepage feature ends up defining, without this file needing to grow a
// new hardcoded boolean field per achievement. Deliberately NOT a fixed
// enum anywhere in this mechanism — the actual set of ids (e.g.
// "streak_7day", "first_repeat_theme") is homepage-feature-owned and
// defined later; this file only needs a string key and a grant shape.
//
// REWARD TYPES: a grant is one of two shapes (open to more later, but only
// these two exist today, per the founder-brain reward-design rules relayed
// on the tracker item):
//   { type: 'tokens', amount: N }              — a straight balance credit,
//     reserved for only the biggest milestones (a 7-day streak, a first
//     repeated theme) per the founder's own stated principle: garnish, never
//     replace the existing daily-claim economy. This mechanism can express
//     amounts smaller than DAILY_CLAIM_AMOUNT (e.g. +10/+20) just as easily
//     as a bigger one-off — it does not itself enforce any ceiling on
//     `amount` (that judgment call belongs to whoever picks real sizes at
//     the homepage design review, not to this generic mechanism).
//   { type: 'capability', capability: <name>, count: N } — a non-currency
//     unlock (e.g. 'free_reedit', 'free_lens', 'free_image'), preferred by
//     the founder's own reward-design principle over a token grant for
//     everything BELOW the biggest milestones: near-zero cost-of-goods, and
//     can't cannibalize shop.html's token-pack economics the way handing out
//     free tokens at scale would. Adds `count` onto a running per-capability
//     balance (`capabilities[capability]`) this record carries, which some
//     future spend path (not built here — out of scope, see "SHIPS NO
//     GRANTS" below) would decrement when a free re-edit/lens/image is
//     actually redeemed.
//
// SHIPS NO GRANTS: per the tracker item's own explicit instruction ("Actual
// grant SIZES are a founder sign-off at the homepage design review — build
// the mechanism, ship no grants until sizes approved"), NOTHING in this
// codebase calls applyAchievementGrant from any real user-facing code path
// as of this writing — it is exercised only by this file's own test suite
// (test/entitlements-achievements.test.js). The homepage feature wiring real
// achievement ids/amounts to real triggers is separate, later work, gated on
// the founder actually approving sizes.
//
// PER-IP RATE LIMITING IS THE FUTURE CALLER'S JOB, NOT THIS FUNCTION'S: same
// division of responsibility this file already uses everywhere else — this
// is a plain library function with no concept of an HTTP request/IP, exactly
// like syncTokens/claimDailyTokens/spendTokens. claim-daily-tokens.js applies
// its own 'claim-ip'/'claim-email' rate-limit buckets (rate-limit.js's
// checkAndIncrement) BEFORE ever calling claimDailyTokens; generate-video.js
// does the same (E109/E110) before spendTokens. Whenever a real Netlify
// Function eventually calls applyAchievementGrant from a genuine user
// trigger, it MUST apply an equivalent per-IP (and/or per-email) rate-limit
// bucket first, the same way every other sensitive write endpoint in this
// codebase already does (see admin-consolidate-accounts.js/
// admin-rename-account.js for the same discipline on the admin side) — this
// mechanism's own idempotency (below) prevents a DUPLICATE grant, but it
// does nothing to stop a scripted client from hammering the endpoint with
// many DIFFERENT achievement ids/accounts, which only an IP cap defends
// against.
//
// TWO-PHASE MARKER, SAME REASONING AS creditTokenPackOnce/refundTokensOnce:
// a plain "read the ledger, if the id is absent write it" is the exact
// documented TOCTOU this file's own header comment (and
// creditTokenPackAmountOnce's/refundTokenAmountOnce's doc comments) already
// warns is NOT safe under genuine concurrency — two concurrent grant calls
// for the SAME (email, achievementId) could each read "not yet granted"
// before either writes, and a plain map-membership `verify()` would then
// report success for BOTH, double-applying the reward (double-crediting
// tokens, or double-incrementing a capability count). Fixed the identical
// way: an OUTER claimId-based write-then-verify marker
// (ACHIEVEMENT_GRANTS_STORE_NAME, keyed by `email::achievementId` — a
// composite key, since a grant is scoped to one account's one achievement,
// not to achievementId alone) serializes concurrent callers before any of
// them touch the entitlement record's balance/capabilities, a
// `status: 'pending' -> 'committed'` marker makes an interrupted attempt
// (a crash between winning the marker race and finishing the grant) safely
// RESUMABLE rather than stuck, and applyAchievementGrantOnce below (mirrors
// creditTokenPackAmountOnce/refundTokenAmountOnce) makes the actual
// entitlement-record write idempotent per achievementId too, so a resume
// can never double-apply it. See creditTokenPackOnce's own doc comment for
// the full step-by-step reasoning this mirrors almost line for line.
//
// Returns `{ ok: true, granted: boolean, ... }`: `granted: false` means this
// (email, achievementId) pair was already recorded — a safe no-op, not an
// error (mirrors `credited`/`refunded` false on the purchase/refund paths).
// Throws on genuine exhaustion at any phase (bounded retry attempts never
// confirm a winner), matching this file's own "EXHAUSTION MUST THROW, NOT
// SILENTLY SWALLOW" posture (see creditTokenPackOnce's doc comment) — a
// caller that can't confirm a grant landed must not silently report success
// OR silently report failure for what might actually be a transient Blobs
// hiccup; it propagates up so its own caller can decide (retry, log, 500).
//
// A missing/empty email or a missing/non-string achievementId is a safe
// no-op (`{ ok: false, granted: false }`), matching this file's existing
// "an unidentifiable caller never creates a phantom record" discipline. An
// invalid `grantSpec` (missing/unrecognized `type`) throws immediately,
// before any Blobs I/O — this is a caller-programming-error class of bug
// (a hardcoded typo in a homepage-feature call site), not a runtime
// condition worth an "already granted"-shaped false; it should fail loud
// and immediately in whatever test/staging exercised it first.
// ============================================================================

var ACHIEVEMENT_GRANTS_STORE_NAME = 'dreamtube-achievement-grants';

function achievementGrantsStore() {
  return getStore({ name: ACHIEVEMENT_GRANTS_STORE_NAME });
}

/**
 * Composite key for the OUTER per-(email, achievementId) marker — see the
 * doc block above for why this needs to be scoped to both, not
 * achievementId alone. Uses JSON.stringify (not string concatenation with a
 * separator) specifically so a crafted email/achievementId containing that
 * separator can never collide two different pairs onto the same key —
 * review finding: a plain `email + '::' + achievementId` scheme let
 * email="x::y", achievementId="z" collide with email="x", achievementId="y::z".
 * ACHIEVEMENT_ID_PATTERN (checked in validateAchievementId below, before
 * this is ever called) additionally rules out `::`/quote characters in
 * achievementId at the source, so this is defense in depth, not the only
 * guard.
 */
function achievementGrantMarkerKey(email, achievementId) {
  return JSON.stringify([normalizeEmail(email), achievementId]);
}

// Achievement ids are homepage-feature-owned string constants (e.g.
// "streak_7day"), never user input — this pattern exists purely to rule out
// a caller-programming-error id containing characters that could ever be
// mistaken for a key-composition separator (see achievementGrantMarkerKey's
// own doc comment), not to validate any real-world naming convention.
var ACHIEVEMENT_ID_PATTERN = /^[a-zA-Z0-9_]+$/;

function validateAchievementId(achievementId) {
  return typeof achievementId === 'string' && ACHIEVEMENT_ID_PATTERN.test(achievementId);
}

function validateGrantSpec(grantSpec) {
  if (!grantSpec || typeof grantSpec !== 'object') {
    throw new Error('applyAchievementGrant: grantSpec is required');
  }
  if (grantSpec.type === 'tokens') {
    if (typeof grantSpec.amount !== 'number' || !(grantSpec.amount > 0)) {
      throw new Error('applyAchievementGrant: a "tokens" grantSpec requires a positive numeric amount');
    }
    return;
  }
  if (grantSpec.type === 'capability') {
    if (typeof grantSpec.capability !== 'string' || !grantSpec.capability) {
      throw new Error('applyAchievementGrant: a "capability" grantSpec requires a non-empty capability name');
    }
    if (typeof grantSpec.count !== 'number' || !(grantSpec.count > 0)) {
      throw new Error('applyAchievementGrant: a "capability" grantSpec requires a positive numeric count');
    }
    return;
  }
  throw new Error('applyAchievementGrant: grantSpec.type must be "tokens" or "capability", got ' + (grantSpec && grantSpec.type));
}

/**
 * The OUTER entry point — see the big doc block above this section for the
 * full mechanism. Idempotent per (email, achievementId): calling this twice
 * (sequentially or concurrently) for the same pair only ever applies the
 * reward once.
 */
async function applyAchievementGrant(event, email, achievementId, grantSpec) {
  var key = normalizeEmail(email);
  if (!key) return { ok: false, granted: false };
  if (!validateAchievementId(achievementId)) return { ok: false, granted: false };
  validateGrantSpec(grantSpec); // throws on a caller-programming-error grantSpec, before any I/O

  var markerKey = achievementGrantMarkerKey(key, achievementId);
  var claimId; // set fresh inside mutate() on whichever attempt actually writes

  var result = await blobsRetry.retryingWrite(event, ACHIEVEMENT_GRANTS_STORE_NAME, markerKey, {
    maxAttempts: MAX_CREDIT_ATTEMPTS,
    read: function (evt) {
      connectLambda(evt);
      return achievementGrantsStore().get(markerKey, { type: 'json' });
    },
    mutate: function (existing) {
      // A marker already exists — either our own earlier attempt within
      // this loop (verify lagged, so we looped back and now see our own
      // write) or a genuinely separate concurrent caller. Nothing new to
      // write: SKIP and let the caller decide what the existing marker's
      // `status` means.
      if (existing) return blobsRetry.SKIP;
      claimId = crypto.randomUUID();
      return { email: key, achievementId: achievementId, grantSpec: grantSpec, status: 'pending', claimId: claimId, createdAt: Date.now() };
    },
    verify: function (verifyRead) {
      return !!(verifyRead && verifyRead.claimId === claimId);
    }
  });

  var marker;
  if (result.ok) {
    marker = result.value; // our freshly-written 'pending' marker just won the race
  } else if (result.skipped) {
    marker = result.current; // a pre-existing marker (pending or committed) -- some other caller/attempt already owns this pair
  } else {
    // Genuine exhaustion — see creditTokenPackOnce's identical doc comment
    // for why this must throw rather than silently return granted:false.
    throw new Error('applyAchievementGrant: exhausted attempts writing the pending marker for ' + markerKey + ' without confirming a winner');
  }

  if (!marker || marker.status === 'committed') {
    // Already fully processed — a genuine repeat call/concurrent-loser,
    // nothing to do.
    return { ok: true, granted: false };
  }

  // marker.status === 'pending': either freshly created above, or a resume
  // of an interrupted earlier attempt. applyAchievementGrantOnce is
  // idempotent per (email, achievementId) (folds the dedup check into the
  // same write as the balance/capability update), so it's safe to call
  // again here even if an earlier, interrupted attempt already applied this
  // exact grant. Uses the marker's OWN recorded grantSpec (not whatever this
  // call happened to pass) so a resume always applies the grant that was
  // actually decided when the marker was first created, even if this call's
  // own `grantSpec` argument somehow differs.
  await applyAchievementGrantOnce(event, marker.email || key, achievementId, marker.grantSpec || grantSpec);

  // Flip to 'committed' — ALSO raced (a second claimId-based
  // write-then-verify), not a blind overwrite, since a 'pending' marker can
  // legitimately be resumed by more than one near-simultaneous caller —
  // exactly one resumer should report granted:true, the rest see it already
  // finished. Mirrors creditTokenPackOnce's/refundTokensOnce's own
  // finish-flip exactly.
  var finishClaimId;
  var finishResult = await blobsRetry.retryingWrite(event, ACHIEVEMENT_GRANTS_STORE_NAME, markerKey, {
    maxAttempts: MAX_CREDIT_ATTEMPTS,
    read: function (evt) {
      connectLambda(evt);
      return achievementGrantsStore().get(markerKey, { type: 'json' });
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
    // safe, expected no-op. The grant itself is guaranteed correct
    // regardless (applyAchievementGrantOnce's own guarantee, above); this
    // call just isn't the one that gets to report granted:true.
    return { ok: true, granted: false };
  }
  if (!finishResult.ok) {
    // The grant itself is NOT at risk here (applyAchievementGrantOnce
    // already guaranteed it landed, or would have thrown) — only the
    // bookkeeping flip-to-'committed' failed to confirm. Still throw rather
    // than silently succeed — see creditTokenPackOnce's identical reasoning.
    throw new Error('applyAchievementGrant: exhausted attempts flipping the marker to committed for ' + markerKey);
  }

  var record = await getEntitlement(event, key);
  return {
    ok: true,
    granted: true,
    achievementId: achievementId,
    grantSpec: marker.grantSpec || grantSpec,
    balance: record && record.tokens && record.tokens.balance,
    capabilities: record && record.capabilities
  };
}

/**
 * Applies `grantSpec` onto `email`'s entitlement record's `achievements`
 * ledger and, in the SAME write, its dependent effect (`tokens.balance` for
 * a 'tokens' grant, `capabilities[capability]` for a 'capability' grant) —
 * idempotently per (email, achievementId): calling this twice (or
 * concurrently) for the same pair only ever applies the effect once. Same
 * read -> mutate -> write -> verify shape as creditTokenPackAmountOnce/
 * refundTokenAmountOnce — see either's own doc comment for the full
 * race-closing reasoning. Used by applyAchievementGrant above to make its
 * 'pending'-marker resume path safe — NOT safe to call directly with the
 * same (email, achievementId) from genuinely concurrent callers with no
 * outer serialization (see the big doc block above this section for exactly
 * why that alone isn't enough); always go through applyAchievementGrant in
 * production code.
 *
 * Folding both facts (the ledger entry and its balance/capability effect)
 * into ONE write is what makes a resume safe without guessing: whichever
 * attempt's write is the one that ends up persisted, the ledger entry and
 * its effect always agree with each other — never "ledger says granted but
 * balance/capability wasn't actually bumped" or vice versa. Same reasoning
 * creditTokenPackAmountOnce's own doc comment gives for
 * appliedTokenPackPaymentIds + tokens.balance living in the same write.
 */
async function applyAchievementGrantOnce(event, email, achievementId, grantSpec) {
  var key = normalizeEmail(email);
  if (!key) return { ok: false };

  // syncTokens-then-baseTokensForAttempt discipline shared with
  // creditTokenPackAmountOnce/refundTokenAmountOnce — see
  // baseTokensForAttempt's own doc comment for the full per-attempt rule.
  // `syncedTokens` still exists to (a) materialize a brand-new email's
  // INITIAL_GRANT before this record is ever touched here, and (b) serve
  // as attempt 0's only trustworthy base in the narrow read-your-own-write
  // window right after that same-call seed write. Needed for BOTH grant
  // types, not just 'tokens': a 'capability' grant still rewrites the
  // whole `tokens` sub-object unchanged (to preserve it against a stale
  // read the same way spendTokens/addTokens already do), so it needs this
  // same base too.
  //
  // FIXED 2026-07-29 (tracker item entitlements-js-retryingwrite-balance-
  // mu-qxm1ih): this used to capture `syncedTokens` ONCE before the retry
  // loop below, then reuse it verbatim on EVERY retry attempt for
  // `lastClaimAt`/`streak`/the pre-grant `balance` base — unlike
  // `nextCapabilities`, which already correctly re-derived from each
  // attempt's own fresh `rec.capabilities` read. blobs-retry.js's own
  // header comment documents a second/third attempt as a NORMAL occurrence
  // (propagation lag), not a rare edge case, so a real `claimDailyTokens`/
  // `spendTokens`/`addTokens`/pack-credit/refund write landing on this
  // SAME email's record in that window could have its fresher
  // `lastClaimAt`/`streak`/`balance` silently reverted by this function's
  // stale snapshot plus its own delta on top. Now each attempt re-derives
  // its base from THAT attempt's own fresh `rec.tokens` via
  // baseTokensForAttempt whenever it's safe to trust one, matching
  // `nextCapabilities`'s existing discipline — see that helper's own doc
  // comment for the exact rule, and creditTokenPackAmountOnce's/
  // refundTokenAmountOnce's doc comments for the identical fix applied to
  // those two functions.
  var syncedTokens = await syncTokens(event, key);
  var attemptIndex = 0;

  var result = await blobsRetry.retryingWrite(event, STORE_NAME, key, {
    maxAttempts: MAX_CREDIT_ATTEMPTS,
    read: function (evt) {
      connectLambda(evt);
      return store().get(key, { type: 'json' });
    },
    mutate: function (existing) {
      var currentAttempt = attemptIndex;
      attemptIndex++;
      var rec = existing || { email: key };
      var achievements = rec.achievements || {};
      if (achievements[achievementId]) return blobsRetry.SKIP; // already applied by an earlier attempt

      var now = Date.now();
      var ledgerEntry = { grantedAt: now, type: grantSpec.type };
      var nextAchievements = Object.assign({}, achievements);
      var baseTokens = baseTokensForAttempt(currentAttempt, rec, syncedTokens);
      // `tokens` is carried through unchanged by default (same
      // "purely additive, never resets claim state" discipline
      // spendTokens/addTokens already apply) -- the 'tokens' branch below
      // overrides only `balance`.
      var nextTokens = { balance: baseTokens.balance, lastClaimAt: baseTokens.lastClaimAt, streak: baseTokens.streak };
      var nextCapabilities = Object.assign({}, rec.capabilities);

      if (grantSpec.type === 'tokens') {
        ledgerEntry.amount = grantSpec.amount;
        nextTokens.balance = Math.min(MAX_TOKEN_BALANCE, baseTokens.balance + grantSpec.amount);
      } else { // 'capability' -- validateGrantSpec already rejected anything else
        ledgerEntry.capability = grantSpec.capability;
        ledgerEntry.count = grantSpec.count;
        nextCapabilities[grantSpec.capability] = (nextCapabilities[grantSpec.capability] || 0) + grantSpec.count;
      }

      nextAchievements[achievementId] = ledgerEntry;

      return Object.assign({}, rec, {
        email: key,
        tokens: nextTokens,
        achievements: nextAchievements,
        capabilities: nextCapabilities,
        updatedAt: now
      });
    },
    verify: function (verifyRead) {
      return !!(verifyRead && verifyRead.achievements && verifyRead.achievements[achievementId]);
    }
  });

  if (result.ok || result.skipped) return { ok: true }; // applied just now, or already applied by an earlier attempt

  // Bonus confirmatory read, same reasoning as creditTokenPackAmountOnce's/
  // refundTokenAmountOnce's own -- resolves the common "our write actually
  // landed, only the verify-read lagged" case without ever reporting
  // success when nothing was actually confirmed.
  var finalRead = await getEntitlement(event, key);
  if (finalRead && finalRead.achievements && finalRead.achievements[achievementId]) return { ok: true };

  throw new Error('applyAchievementGrantOnce: exhausted attempts granting achievement ' + achievementId + ' for ' + key + ' without ever confirming the grant landed');
}

/**
 * Permanently deletes an email's entire entitlement record — the token
 * ledger half of delete-account.js's account-deletion flow. Removes the
 * balance/lastClaimAt/streak, the dormant Stripe subscription fields
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
 * DOES clean up ACHIEVEMENT_GRANTS_STORE_NAME (the per-email::achievementId
 * dedup markers) for every achievement this record's own `achievements`
 * field lists — review finding: the borrowed "no cheap way to enumerate"
 * reasoning from TOKEN_PURCHASES_STORE_NAME/REFUNDED_JOBS_STORE_NAME (whose
 * markers are keyed by an opaque payment_id/job_id with no email index)
 * doesn't actually apply here, since the entitlement record IS the
 * enumeration — `rec.achievements`'s own keys are exactly "every
 * achievementId this email was ever granted." Left uncleaned, a re-created
 * account under the same (deleted, then reused) email would find specific
 * achievements permanently, silently un-grantable — the same "stale
 * artifact tied to a freed identifier still affects the next holder" bug
 * class this codebase already had to fix once for
 * lib/account-auth-token.js's username reuse (see that file's own header
 * comment). Best-effort, not itself retried/verified — if one of these
 * deletes fails, the account record is still gone (the thing that actually
 * matters for privacy/PII), and a lingering marker in that failure case is
 * back to being merely a rare, narrow annoyance rather than an expected
 * outcome of every deletion.
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

  var existing = await store().get(key, { type: 'json' });
  if (existing && existing.achievements) {
    var achievementIds = Object.keys(existing.achievements);
    for (var i = 0; i < achievementIds.length; i++) {
      try {
        await achievementGrantsStore().delete(achievementGrantMarkerKey(key, achievementIds[i]));
      } catch (e) {
        // Best-effort — see this function's own doc comment for why a
        // failure here doesn't block the actual account-data deletion.
      }
    }
  }

  await store().delete(key);
  return { ok: true };
}

module.exports = {
  STORE_NAME,
  TOKEN_PURCHASES_STORE_NAME,
  REFUNDED_JOBS_STORE_NAME,
  ACHIEVEMENT_GRANTS_STORE_NAME,
  // Exported so tests seed/read the achievement-grant marker store under
  // the SAME key this file's own code computes, rather than a test-local
  // copy of the key format that could silently drift out of sync with a
  // future change here (review finding: the marker-key scheme changed once
  // already, from string concatenation to JSON.stringify, specifically to
  // close a collision gap — a hardcoded test-side format would have masked
  // that exact kind of change).
  achievementGrantMarkerKey,
  normalizeEmail,
  getEntitlement,
  isEntitled,
  setEntitlement,
  getTokenStatus,
  claimDailyTokens,
  spendTokens,
  addTokens,
  creditTokenPackOnce,
  creditTokenPackAmountOnce,
  forgetAppliedTokenPack,
  refundTokensOnce,
  refundTokenAmountOnce,
  forgetRefundedJobId,
  applyAchievementGrant,
  applyAchievementGrantOnce,
  deleteEntitlement,
  // Exported so callers that need the live values (get-token-status.js's
  // no-email fast path, which never reaches getTokenStatus itself — see
  // that file) can read them instead of hand-maintaining a duplicate
  // literal that silently goes stale on the next retune. See this
  // recurring bug class documented in tracker item
  // recurring-bug-class-hardcoded-daily-gran-h6swgy.
  INITIAL_GRANT,
  DAILY_CLAIM_AMOUNT,
  FIRST_CLAIM_BONUS_AMOUNT,
  CLAIM_COOLDOWN_MS,
  STREAK_CONTINUITY_MS,
  FIRST_PURCHASE_BONUS_MULTIPLIER
};
