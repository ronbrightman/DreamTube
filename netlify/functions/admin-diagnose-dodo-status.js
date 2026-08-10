// netlify/functions/admin-diagnose-dodo-status.js
//
// READ-ONLY owner-gated diagnostic that answers two founder questions in
// one call, straight from Dodo's own API (not our local Blobs, unlike its
// sibling admin-diagnose-dodo-payment.js which reads OUR token-purchase
// marker):
//
//   1. WHICH DODO MODE IS ACTIVE RIGHT NOW — live vs test. Resolved
//      EXACTLY the way create-checkout-session-dodo.js resolves it for
//      real checkouts: `process.env.DODO_ENVIRONMENT || 'live_mode'`
//      (see that file's `new DodoPayments({ environment: ... })` call).
//      Quoting that precedent verbatim here is the whole point — this
//      tool reports the SAME value the real checkout path would use, so
//      "am I accidentally pointed at test mode / at live mode" has a
//      direct, trustworthy answer instead of a guess. `activeMode` is
//      ALWAYS returned, even when the API key is missing or a Dodo call
//      fails, because half this tool's value is just telling the founder
//      the mode.
//
//   2. THE TRUE STATUS OF A SUBSCRIPTION — trialing vs active, trial end
//      / next billing date, recurring amount — read live from Dodo via
//      the installed `dodopayments` SDK (v2.42.2 in node_modules).
//
// AUTH: identical bar to every sibling admin diagnostic in this codebase
// (see admin-diagnose-dodo-payment.js / admin-diagnose-rename-conflict.js
// header comments) — a real, server-verified password
// (lib/account-store.js's verifyLogin) against an account whose own
// on-file email matches OWNER_EMAIL (normalized). Duplicated inline
// rather than shared, matching this codebase's explicit precedent for
// these one-off admin tools.
//
// RATE LIMITING: same two-bucket (per-IP + per-identifier) shape as every
// sibling admin tool, with its own env vars / bucket names.
//
// ── STRICTLY READ-ONLY ──
// This tool ONLY ever calls Dodo's read methods:
//   • client.subscriptions.retrieve(subscriptionId)   (by id)
//   • client.customers.list({ email })                 (email -> customer)
//   • client.subscriptions.list({ customer_id })       (customer -> subs)
// It NEVER calls any mutating Dodo method — no subscriptions.update /
// cancel (there is no cancel; cancel is done via update) / charge /
// changePlan / updatePaymentMethod, no customers.create/update, nothing
// that writes. This is a diagnostic; changing a real subscription is a
// separate, deliberate, human-driven action, never something this file
// does. The mock-based regression test asserts no mutating method is ever
// touched.
//
// ── THE API KEY NEVER LEAVES THE SERVER ──
// DODO_API_KEY (the bearer token) is NEVER put into any response, log, or
// error string. `keyPresent` (a boolean) is the only thing said about it.
// Every Dodo call is wrapped in try/catch and its error message is passed
// through redactToken() before it can ever reach a response — mirroring
// exactly how lib/meta-capi.js keeps its access token out of error text
// (see that file's redactToken()).
//
// WHY NO `keyLooksLike`: the spec allowed a `keyLooksLike` label derived
// from the key's prefix IF the prefix reliably distinguishes test vs live
// in the Dodo SDK. It does NOT: the Dodo SDK takes the environment
// (test_mode / live_mode) as an EXPLICIT constructor arg — the same
// bearer token is used regardless, and the mode is set independently of
// the key (see create-checkout-session-dodo.js, which passes
// DODO_ENVIRONMENT and the key separately). A key prefix is therefore not
// a reliable mode signal, so this field is deliberately OMITTED rather
// than guessed. `activeMode` (the explicit environment) is the real
// answer to "test or live"; `keyPresent` only says whether a key exists
// to talk to Dodo at all.
//
// ── "trialing" and "trial_end" are DERIVED, not native Dodo fields ──
// The installed SDK's SubscriptionStatus enum is
// 'pending' | 'active' | 'on_hold' | 'cancelled' | 'failed' | 'expired'
// — there is NO 'trialing' status, and a Subscription exposes NO
// `trial_end` field. What Dodo DOES expose is `trial_period_days`
// (number, 0 if no trial), `created_at`, `next_billing_date` (the first
// real charge date / end of current period) and `previous_billing_date`.
// So:
//   • `trial_period_days` / `next_billing_date` / `previous_billing_date`
//     / `created_at` are passed through verbatim (native fields).
//   • `trial_end` is COMPUTED = created_at + trial_period_days days, and
//     clearly labeled derived. (During a trial this lines up with
//     next_billing_date, which is the authoritative first-charge date.)
//   • `trialing` is COMPUTED = has a trial AND status is active/pending
//     AND now is before the computed trial end. Documented as derived,
//     because Dodo has no trialing status to read.
//
// Request:  POST { usernameOrEmail, password, email?, subscriptionId? }
//   At least one of `email` / `subscriptionId` is required (E4 if
//   neither). If BOTH are given, `subscriptionId` wins (a single exact
//   retrieve is more precise than an email fan-out).
// Response (single id):
//   200 { ok:true, activeMode, keyPresent, subscription:{...} }
// Response (email lookup):
//   200 { ok:true, activeMode, keyPresent, subscriptions:[{...}, ...] }  (1-3 most recent)
// Mode-only degrade (key not configured — still 200, mode still reported):
//   200 { ok:true, activeMode, keyPresent:false, subscriptions:[], warning:'E7: dodo_not_configured' }
// Errors: { ok:false, activeMode, keyPresent, error:'<code> <reason>' }
//
// Error codes (same small-number scheme as every sibling admin-*.js file):
//   E1 method_not_allowed
//   E2 missing_owner_email
//   E3 invalid_json
//   E4 missing_fields        — usernameOrEmail/password missing, OR neither
//                              email nor subscriptionId supplied
//   E5 forbidden
//   E6 rate_limited
//   E7 dodo_not_configured   — DODO_API_KEY not set; surfaced as a
//                              `warning` on an otherwise-ok 200 (the mode
//                              is still reported), never as a hard failure
//   E8 dodo_api_error        — a Dodo read call threw/failed; SAFE message
//                              only, token redacted defensively

var accountStore = require('./lib/account-store');
var { normalizeEmail } = require('./lib/entitlements');
var rateLimit = require('./lib/rate-limit');

var DAY_MS = 24 * 60 * 60 * 1000;
var MAX_EMAIL_CUSTOMERS = 3;   // bound the customer fan-out for an email lookup
var MAX_SUBSCRIPTIONS = 3;     // return at most the 3 most-recent matches

// ── Test seam ──────────────────────────────────────────────────────────
// Production builds the real SDK client below. Tests inject a fake client
// (a recording spy) via __setTestClientFactory so the mock-based suite can
// assert exactly which Dodo methods were called (and that no mutating one
// ever was) without any network. Null => real SDK. This mirrors the
// "inject or stub" seam the spec asked for; it changes no production
// behavior when left unset.
var _testClientFactory = null;
function buildClient(activeMode) {
  if (_testClientFactory) return _testClientFactory(activeMode);
  // Same construction as create-checkout-session-dodo.js.
  var DodoPayments = require('dodopayments').default;
  return new DodoPayments({
    bearerToken: process.env.DODO_API_KEY,
    environment: activeMode
  });
}

/** Strips every occurrence of `secret` (raw and URI-encoded) out of `text` so an error message can never carry the bearer token back to a caller — mirrors lib/meta-capi.js's redactToken(). */
function redactToken(text, secret) {
  if (!text || !secret) return text;
  var redacted = String(text).split(secret).join('[REDACTED]');
  try {
    redacted = redacted.split(encodeURIComponent(secret)).join('[REDACTED]');
  } catch (e) { /* never let redaction itself break error handling */ }
  return redacted;
}

/** Real, server-verified credential check + owner-email confirmation — duplicated from the sibling admin diagnostics' own copy, see header comment. */
async function verifyOwnerCredentials(event, usernameOrEmail, password) {
  var ownerEmail = normalizeEmail(process.env.OWNER_EMAIL);
  if (!ownerEmail) return { ok: false, error: 'owner_not_configured' };

  var loginCheck = await accountStore.verifyLogin(event, usernameOrEmail, password);
  if (!loginCheck.ok) return { ok: false, error: loginCheck.error };

  if (normalizeEmail(loginCheck.record.email) !== ownerEmail) {
    return { ok: false, error: 'not_owner' };
  }
  return { ok: true, record: loginCheck.record };
}

/**
 * Maps a Dodo Subscription (from retrieve) OR SubscriptionListResponse
 * (from list) — the two shapes share every field read here — down to ONLY
 * the non-sensitive status fields the founder needs. Deliberately returns
 * NO customer PII (name/email/phone/address), NO payment-instrument /
 * card data, NO billing address — only subscription status/lifecycle.
 * `trialing` / `trial_end` are DERIVED here; see header comment.
 */
function mapSubscription(sub) {
  sub = sub || {};
  var status = typeof sub.status === 'string' ? sub.status : null;

  var trialDays = typeof sub.trial_period_days === 'number' ? sub.trial_period_days : 0;
  var createdMs = sub.created_at ? Date.parse(sub.created_at) : NaN;
  var trialEndIso = null;
  var trialEndMs = null;
  if (trialDays > 0 && !isNaN(createdMs)) {
    trialEndMs = createdMs + trialDays * DAY_MS;
    trialEndIso = new Date(trialEndMs).toISOString();
  }
  // Dodo has no 'trialing' status — derive it (see header comment).
  var trialing = trialDays > 0 &&
    (status === 'active' || status === 'pending') &&
    trialEndMs !== null && Date.now() < trialEndMs;

  // recurring_pre_tax_amount is in the currency's SMALLEST unit (cents for
  // USD). Pass the raw integer through (per spec) and add a human-readable
  // display string as a convenience — both non-sensitive.
  var rawAmount = typeof sub.recurring_pre_tax_amount === 'number' ? sub.recurring_pre_tax_amount : null;
  var currency = typeof sub.currency === 'string' ? sub.currency : null;
  var amountDisplay = null;
  if (rawAmount !== null) {
    amountDisplay = (rawAmount / 100).toFixed(2) + (currency ? ' ' + currency : '');
  }

  return {
    subscription_id: sub.subscription_id || null,
    status: status,
    trialing: trialing,
    trial_period_days: trialDays,
    trial_end: trialEndIso,                 // DERIVED (created_at + trial_period_days); null when no trial
    next_billing_date: sub.next_billing_date || null,
    previous_billing_date: sub.previous_billing_date || null,
    cancel_at_next_billing_date: typeof sub.cancel_at_next_billing_date === 'boolean' ? sub.cancel_at_next_billing_date : null,
    cancelled_at: sub.cancelled_at || null,
    recurring_pre_tax_amount: rawAmount,    // raw, in smallest currency unit (cents for USD)
    currency: currency,
    amount_display: amountDisplay,          // DERIVED convenience, e.g. "9.99 USD"
    product_id: sub.product_id || null,
    created_at: sub.created_at || null
  };
}

/** Awaits a Dodo SDK list call and returns its `.data` array (stainless PagePromise), tolerating a plain array too. Never iterates further pages — a bounded, single-page read is all this diagnostic needs. */
function pageData(page) {
  if (!page) return [];
  if (Array.isArray(page)) return page;
  if (Array.isArray(page.data)) return page.data;
  return [];
}

function byCreatedAtDesc(a, b) {
  var am = a && a.created_at ? Date.parse(a.created_at) : 0;
  var bm = b && b.created_at ? Date.parse(b.created_at) : 0;
  return (isNaN(bm) ? 0 : bm) - (isNaN(am) ? 0 : am);
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'E1: method_not_allowed' }) };
  }

  var ownerEmail = normalizeEmail(process.env.OWNER_EMAIL);
  if (!ownerEmail) {
    return { statusCode: 500, body: JSON.stringify({ error: 'E2: missing_owner_email' }) };
  }

  var payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E3: invalid_json' }) };
  }

  var usernameOrEmail = typeof payload.usernameOrEmail === 'string' ? payload.usernameOrEmail.trim() : '';
  var password = typeof payload.password === 'string' ? payload.password : '';
  if (!usernameOrEmail || !password) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'E4: missing_fields' }) };
  }

  var email = normalizeEmail(payload.email);
  var subscriptionId = typeof payload.subscriptionId === 'string' ? payload.subscriptionId.trim() : '';
  if (!email && !subscriptionId) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'E4: missing_fields: supply an email or a subscriptionId' }) };
  }

  // Same two-bucket rate limiting as every sibling admin tool.
  var maxPerIpPerDay = parseInt(process.env.MAX_ADMIN_DIAGNOSE_DODO_STATUS_PER_IP_PER_DAY, 10);
  if (!maxPerIpPerDay || maxPerIpPerDay <= 0) maxPerIpPerDay = 20;
  var maxPerIdentifierPerDay = parseInt(process.env.MAX_ADMIN_DIAGNOSE_DODO_STATUS_PER_IDENTIFIER_PER_DAY, 10);
  if (!maxPerIdentifierPerDay || maxPerIdentifierPerDay <= 0) maxPerIdentifierPerDay = 10;

  var ip = rateLimit.clientIp(event);
  var ipLimit = await rateLimit.checkAndIncrement(event, 'admin-diagnose-dodo-status-ip', ip, maxPerIpPerDay);
  if (!ipLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ ok: false, error: 'E6: rate_limited: too many attempts from this network today, try again tomorrow' }) };
  }

  var canonicalAccount = await accountStore.getByUsername(event, usernameOrEmail);
  if (!canonicalAccount) canonicalAccount = await accountStore.getByEmail(event, usernameOrEmail);
  var identifierKey = canonicalAccount ? canonicalAccount.username : usernameOrEmail.toLowerCase();
  var identifierLimit = await rateLimit.checkAndIncrement(event, 'admin-diagnose-dodo-status-identifier', identifierKey, maxPerIdentifierPerDay);
  if (!identifierLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ ok: false, error: 'E6: rate_limited: too many attempts for this account today, try again tomorrow' }) };
  }

  var auth = await verifyOwnerCredentials(event, usernameOrEmail, password);
  if (!auth.ok) {
    return { statusCode: 403, body: JSON.stringify({ ok: false, error: 'E5: forbidden' }) };
  }

  // ── (1) ALWAYS report the active mode — resolved EXACTLY as
  //        create-checkout-session-dodo.js resolves it for real checkouts. ──
  var activeMode = process.env.DODO_ENVIRONMENT || 'live_mode';
  var apiKey = process.env.DODO_API_KEY;
  var keyPresent = !!apiKey;

  // Mode-only degrade: no key configured, so we can't talk to Dodo. Still
  // a success — the mode (the primary deliverable) IS reported. The E7
  // code is surfaced as a warning, never a hard error.
  if (!keyPresent) {
    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        activeMode: activeMode,
        keyPresent: false,
        subscriptions: [],
        warning: 'E7: dodo_not_configured: DODO_API_KEY is not set — mode reported, subscription lookup skipped'
      })
    };
  }

  // ── (2) Live read from Dodo. Every Dodo call is wrapped so its error
  //        can never carry the token out (redactToken), and activeMode is
  //        still returned on the error path. ──
  var client = buildClient(activeMode);

  try {
    if (subscriptionId) {
      // Exact retrieve wins when a subscription id is supplied.
      var sub = await client.subscriptions.retrieve(subscriptionId);
      return {
        statusCode: 200,
        body: JSON.stringify({
          ok: true,
          activeMode: activeMode,
          keyPresent: true,
          subscription: mapSubscription(sub)
        })
      };
    }

    // Email lookup: the SDK's SubscriptionListParams has no email filter
    // (only customer_id / product_id / status — verified against
    // node_modules/dodopayments/resources/subscriptions.d.ts), but
    // CustomerListParams DOES expose a server-side `email` filter. So:
    // customers.list({ email }) -> customer_id(s) -> subscriptions.list({
    // customer_id }). Bounded fan-out, most-recent-first, capped at 3.
    var customersPage = await client.customers.list({ email: email });
    var customers = pageData(customersPage).slice(0, MAX_EMAIL_CUSTOMERS);

    var collected = [];
    for (var i = 0; i < customers.length; i++) {
      var customerId = customers[i] && customers[i].customer_id;
      if (!customerId) continue;
      var subsPage = await client.subscriptions.list({ customer_id: customerId });
      collected = collected.concat(pageData(subsPage));
    }

    collected.sort(byCreatedAtDesc);
    var mapped = collected.slice(0, MAX_SUBSCRIPTIONS).map(mapSubscription);

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        activeMode: activeMode,
        keyPresent: true,
        subscriptions: mapped
      })
    };
  } catch (e) {
    // SAFE message only — no raw internal detail that could leak the key,
    // and the token redacted defensively even from the message we do keep.
    var safeMessage = redactToken((e && e.message) ? e.message : 'dodo read failed', apiKey);
    return {
      statusCode: 502,
      body: JSON.stringify({
        ok: false,
        activeMode: activeMode,
        keyPresent: true,
        error: 'E8: dodo_api_error: ' + safeMessage
      })
    };
  }
};

// Test-only seam (see buildClient). No effect on production; tests set a
// fake recording client and clear it after each case.
exports.__setTestClientFactory = function (fn) { _testClientFactory = fn; };
