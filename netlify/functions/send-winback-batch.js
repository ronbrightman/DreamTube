// netlify/functions/send-winback-batch.js
//
// Owner-gated, HARD-CAPPED batch sender for the one-time win-back email to a
// small batch of LAPSED past users (founder-approved). This is a manual,
// owner-triggered endpoint — NOT a scheduled function — so the founder
// reviews, deploys, and triggers each batch himself, sending at most `limit`
// emails per call.
//
// POST { email: <owner>, limit?: <n> } -> { ok, limit, totalAccounts,
//   selected, sent, skipped: {...} }
//
// OWNER-GATED exactly like add-tracker-item.js / update-tracker-item.js:
// trusts the POST body's `email` against OWNER_EMAIL (normalized) as the
// real boundary — same tradeoff accepted everywhere else in this codebase.
// Shape validation (limit) runs BEFORE the owner check, same ordering
// discipline as the tracker functions.
//
// THE HARD CAP: `limit` defaults to 10 and is clamped to an absolute ceiling
// of 50. Selection keeps at most `limit` eligible recipients and attempts a
// send to each exactly once, so the number ACTUALLY sent is always <= limit
// (a send that skips at the choke point only ever lowers it). It can NEVER
// send more than `limit`.
//
// RECIPIENT SELECTION — an account is eligible when ALL hold:
//   - has a non-empty email;
//   - is NOT founder/test (lib/winback-email-sender.js's isExcludedEmail —
//     the founder's own address, OWNER_EMAIL, and obvious test/@example.com
//     placeholders);
//   - is NOT suppressed/unsubscribed (lib/email-suppression-store.js);
//   - is NOT already win-back-marked (lib/winback-email-store.js — the
//     once-ever guarantee, so repeated batch runs never re-send);
//   - is LAPSED (see LAPSED DEFINITION below).
// The actual send (lib/winback-email-sender.js) re-applies exclusion,
// suppression, and the once-ever CAS claim at the single send choke point,
// so anything that slips through selection in the window between selection
// and send is still caught — selection is an optimization to not waste the
// cap, the CAS claim is the correctness guarantee.
//
// LAPSED DEFINITION (documented, deliberately conservative): an account is
// "lapsed" when its account record's `updatedAt` is at least
// WINBACK_LAPSED_DAYS (default 30) days old. This codebase's account records
// carry no dedicated last-seen / last-activity / createdAt field
// (account-store.js's createAccount writes only `updatedAt`, set at creation
// and advanced ONLY by a handful of rare account-level mutations — password
// reset, email verify, WhatsApp opt-in, bounce flag), and private dreams are
// local-only (never server-synced — see account-store.js's header comment),
// so there is no server-side per-account dream-activity signal to key on.
// `updatedAt` is therefore the best available proxy: for the overwhelming
// majority of accounts (a signup that was never followed by one of those
// rare mutations) it equals signup time, so "updatedAt older than N days"
// reads as "signed up / last touched their account over N days ago" — the
// task's own "fall back to created-more-than-N-days-ago" definition. A
// record with a missing/invalid `updatedAt` is treated as UNKNOWN age and
// SKIPPED (never sent to), erring toward not-emailing whom we can't reason
// about. Limitation: a lapsed user who recently did a password reset / email
// verify / WhatsApp opt-in has a fresh `updatedAt` and is (correctly, if
// conservatively) treated as not-lapsed.
//
// Error codes (local to this function, same small-number scheme as
// add-tracker-item.js):
//   E1 method_not_allowed  — verb other than POST
//   E2 missing_owner_email — OWNER_EMAIL not configured in this environment
//   E3 invalid_json        — POST body wasn't valid JSON
//   E4 invalid_limit       — `limit` present but not a positive integer
//   E5 forbidden           — POST body's `email` didn't match OWNER_EMAIL

var { normalizeEmail } = require('./lib/entitlements');
var accountStore = require('./lib/account-store');
var emailSuppressionStore = require('./lib/email-suppression-store');
var winbackStore = require('./lib/winback-email-store');
var winbackSender = require('./lib/winback-email-sender');

var DEFAULT_LIMIT = 10;
var MAX_LIMIT = 50;

function lapsedDays(override) {
  // Optional per-request override (POST `lapsedDays`), else env, else default.
  // Default lowered to 7 (founder 2026-08-11): the product is only ~3 weeks
  // old, so a 30-day window matched NOBODY — "lapsed" for a young product means
  // "signed up a week+ ago and didn't stick".
  if (typeof override === 'number' && isFinite(override) && override > 0) return override;
  var n = parseInt(process.env.WINBACK_LAPSED_DAYS, 10);
  if (!n || n <= 0) n = 7;
  return n;
}

/** True when this account's `updatedAt` is at least the lapsed window old. A missing/invalid `updatedAt` returns false (unknown age — not lapsed). */
function isLapsed(record, override) {
  var updatedAt = record && record.updatedAt;
  if (typeof updatedAt !== 'number' || !isFinite(updatedAt) || updatedAt <= 0) return false;
  var ageMs = Date.now() - updatedAt;
  return ageMs >= lapsedDays(override) * 24 * 60 * 60 * 1000;
}

/**
 * The select + hard-cap + send core, exported separately from the handler so
 * tests can drive it directly with a fake event / mocked stores. `opts`:
 *   limit      (required) — already-validated, already-clamped-to-MAX_LIMIT
 *   ownerEmail (required) — normalized OWNER_EMAIL, excluded from sends
 *
 * Returns the summary object the handler serializes.
 */
async function selectAndSend(event, opts) {
  var limit = opts.limit;
  var ownerEmail = opts.ownerEmail;

  var accounts = await accountStore.listAccounts(event);

  var summary = {
    ok: true,
    limit: limit,
    totalAccounts: accounts.length,
    selected: 0,
    sent: 0,
    skipped: {
      no_email: 0,
      excluded: 0,
      not_lapsed: 0,
      unknown_age: 0,
      suppressed: 0,
      already_sent: 0,
      send_stage: {}
    }
  };

  // ── Selection pass (cheap filters first, async reads only for survivors) ──
  var eligible = [];
  for (var i = 0; i < accounts.length && eligible.length < limit; i++) {
    var record = accounts[i];
    var email = record && record.email;

    if (!email) { summary.skipped.no_email++; continue; }
    if (winbackSender.isExcludedEmail(email, ownerEmail)) { summary.skipped.excluded++; continue; }

    // Lapsed gate — unknown age (no usable updatedAt) is its own skip bucket
    // so the summary distinguishes "recently active" from "can't tell".
    var updatedAt = record.updatedAt;
    if (typeof updatedAt !== 'number' || !isFinite(updatedAt) || updatedAt <= 0) {
      summary.skipped.unknown_age++;
      continue;
    }
    if (!isLapsed(record, opts.lapsedDays)) { summary.skipped.not_lapsed++; continue; }

    if (await emailSuppressionStore.isSuppressed(event, email)) { summary.skipped.suppressed++; continue; }
    if (await winbackStore.hasSentWinback(event, record.username)) { summary.skipped.already_sent++; continue; }

    eligible.push(record);
  }

  summary.selected = eligible.length; // <= limit by construction (the loop's own bound)

  // ── Send pass (the choke point re-applies every guard + the CAS claim) ──
  for (var j = 0; j < eligible.length; j++) {
    var acct = eligible[j];
    var result = await winbackSender.sendIfEligible(event, {
      username: acct.username,
      email: acct.email,
      ownerEmail: ownerEmail
    });
    if (result.sent) {
      summary.sent++;
    } else {
      var reason = result.skipped || 'unknown';
      summary.skipped.send_stage[reason] = (summary.skipped.send_stage[reason] || 0) + 1;
    }
  }

  return summary;
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

  var limit;
  if (!Object.prototype.hasOwnProperty.call(payload, 'limit') || payload.limit === null || payload.limit === undefined) {
    limit = DEFAULT_LIMIT;
  } else {
    if (typeof payload.limit !== 'number' || !Number.isInteger(payload.limit) || payload.limit < 1) {
      return { statusCode: 400, body: JSON.stringify({ error: 'E4: invalid_limit' }) };
    }
    limit = Math.min(payload.limit, MAX_LIMIT); // absolute safety ceiling
  }

  // Optional lapsedDays override (positive integer, clamped to <= 365).
  var lapsedOverride = null;
  if (Object.prototype.hasOwnProperty.call(payload, 'lapsedDays') && payload.lapsedDays !== null && payload.lapsedDays !== undefined) {
    if (typeof payload.lapsedDays !== 'number' || !Number.isInteger(payload.lapsedDays) || payload.lapsedDays < 1) {
      return { statusCode: 400, body: JSON.stringify({ error: 'E6: invalid_lapsed_days' }) };
    }
    lapsedOverride = Math.min(payload.lapsedDays, 365);
  }

  var requestEmail = normalizeEmail(payload.email);
  if (!requestEmail || requestEmail !== ownerEmail) {
    return { statusCode: 403, body: JSON.stringify({ error: 'E5: forbidden' }) };
  }

  // Owner-gated PREVIEW: send ONE win-back email to an explicit address (the
  // founder's own test inbox) so he can see the real rendered email. Bypasses
  // selection, the founder/test exclusion, the suppression list, and the
  // once-ever marker (so he can re-preview). Only reachable past the owner
  // check above.
  if (Object.prototype.hasOwnProperty.call(payload, 'previewTo') && payload.previewTo) {
    if (typeof payload.previewTo !== 'string' || payload.previewTo.indexOf('@') < 1) {
      return { statusCode: 400, body: JSON.stringify({ error: 'E7: invalid_preview_to' }) };
    }
    var previewResult = await winbackSender.sendPreview(event, payload.previewTo.trim());
    return { statusCode: previewResult.ok ? 200 : 502, body: JSON.stringify({ preview: true, to: payload.previewTo.trim(), result: previewResult }) };
  }

  var summary = await selectAndSend(event, { limit: limit, ownerEmail: ownerEmail, lapsedDays: lapsedOverride });
  return { statusCode: 200, body: JSON.stringify(summary) };
};

// Exposed for direct unit testing.
exports.selectAndSend = selectAndSend;
exports.isLapsed = isLapsed;
exports.DEFAULT_LIMIT = DEFAULT_LIMIT;
exports.MAX_LIMIT = MAX_LIMIT;
