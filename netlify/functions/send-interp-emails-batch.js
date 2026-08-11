// netlify/functions/send-interp-emails-batch.js
//
// Owner-gated, HARD-CAPPED batch sender for the two founder-approved
// interpretation retention emails (+ their matching pushes). A manual,
// owner-triggered endpoint — NOT a scheduled function — so the founder/
// Manager reviews, deploys, and triggers each batch himself, sending at most
// `limit` emails per call. Modeled EXACTLY on send-winback-batch.js (owner-
// gating, limit clamp, previewTo branch, selection + send pass, structured
// skip summary, same error-code discipline and owner-check ordering).
//
// THE TWO EMAILS (each keyed/guarded PER DREAM by the dream's operationName):
//   1. ★ "Unread meanings" (flagship, lib/interp-unread-email-sender.js) —
//      the user READ between 1 and 4 (inclusive) of the 5 interpretation
//      personas on a dream (some but not all, not zero). Re-fires per dream.
//   2. "No meaning yet" (lib/interp-none-email-sender.js) — the user WATCHED
//      their dream video (lib/result-view-store.js marker) but read ZERO of
//      the 5 interpretations on that dream.
//
// A single dream can only ever match ONE trigger (read-count 1-4 vs read-
// count 0 are mutually exclusive), so no dream is ever double-selected.
//
// POST { email: <owner>, limit?: <n> }
//   -> { ok, limit, totalAccounts, selected:{unread,none}, sent:{unread,none,push},
//        skipped:{...} }
// POST { email: <owner>, previewTo: <addr>, which?: "unread"|"none"|"both" }
//   -> renders + sends the preview email(s) to <addr>. Default (no `which`, or
//      "both") sends BOTH previews so the founder sees both in one call.
//
// THE SERVER-SIDE READ SIGNAL (the hard part this feature depends on):
// "which interpretation personas did a user read on a dream" was CLIENT-ONLY
// (PostHog `interp_reading_shown` + localStorage). This batch reads a durable
// SERVER-SIDE marker instead — lib/interp-read-store.js, written by
// interpret-dream.js the moment a reading is generated for a (dream, persona),
// keyed by the dream's server-issued operationName (the SAME key lib/result-
// view-store.js's watched-marker uses), so a dream's watched-state and its
// interpretation-read-set line up on one key. See those files' header
// comments for the full "why operationName, never a client dreamId" reasoning.
//
// RECIPIENT SELECTION — scans accounts (account-store.js) and each account's
// server-synced PRIVATE dreams (dream-store.js). A (dream) is eligible when
// ALL hold: the account has a non-empty, non-founder/test, non-suppressed
// email; the dream carries a `sourceOperationName`; and the dream matches one
// trigger above AND that email hasn't already been sent for this dream
// (lib/interp-email-store.js). The actual senders re-apply exclusion,
// suppression, and the once-per-dream CAS claim at the single send choke
// point, so anything slipping through selection is still caught — selection
// is an optimization to not waste the cap, the CAS claim is the correctness
// guarantee (same division send-winback-batch.js documents).
//
// THE HARD CAP: `limit` defaults to 10, clamped to an absolute ceiling of 50,
// and bounds the TOTAL emails selected across BOTH types in one call. The
// number actually sent is always <= limit (a send that skips at the choke
// point only lowers it).
//
// Error codes (local to this function, same scheme as send-winback-batch.js):
//   E1 method_not_allowed  — verb other than POST
//   E2 missing_owner_email — OWNER_EMAIL not configured in this environment
//   E3 invalid_json        — POST body wasn't valid JSON
//   E4 invalid_limit       — `limit` present but not a positive integer
//   E5 forbidden           — POST body's `email` didn't match OWNER_EMAIL
//   E6 invalid_which        — `which` present but not "unread"/"none"/"both"
//   E7 invalid_preview_to   — `previewTo` present but not a plausible address

var { normalizeEmail } = require('./lib/entitlements');
var accountStore = require('./lib/account-store');
var emailSuppressionStore = require('./lib/email-suppression-store');
var dreamStore = require('./lib/dream-store');
var interpReadStore = require('./lib/interp-read-store');
var resultViewStore = require('./lib/result-view-store');
var interpEmailStore = require('./lib/interp-email-store');
var unreadSender = require('./lib/interp-unread-email-sender');
var noneSender = require('./lib/interp-none-email-sender');
var winbackSender = require('./lib/winback-email-sender');
var InterpreterPersonas = require('../../js/interpreter-personas');

var DEFAULT_LIMIT = 10;
var MAX_LIMIT = 50;

// The full set of persona keys (single source of truth), used to name an
// UNREAD persona for the flagship email's copy.
var ALL_PERSONA_KEYS = (InterpreterPersonas.ALL || []).map(function (p) { return p.key; });

/** The first persona key in `all` NOT present in `readSet` — a persona the user did NOT read, to name in the flagship email. Null if every persona was read (never happens for a 1-4 trigger). */
function firstUnreadPersona(readSet) {
  for (var i = 0; i < ALL_PERSONA_KEYS.length; i++) {
    if (readSet.indexOf(ALL_PERSONA_KEYS[i]) === -1) return ALL_PERSONA_KEYS[i];
  }
  return null;
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
    selected: { unread: 0, none: 0 },
    sent: { unread: 0, none: 0, push: 0 },
    skipped: {
      no_email: 0,
      excluded: 0,
      suppressed: 0,
      no_dreams: 0,
      no_operation_name: 0,
      not_eligible: 0,
      already_sent_unread: 0,
      already_sent_none: 0,
      send_stage: {}
    }
  };

  // ── Selection pass (cheap filters first; per-dream async reads only for
  //    accounts that survive the account-level filters) ──
  var eligible = [];
  for (var i = 0; i < accounts.length && eligible.length < limit; i++) {
    var record = accounts[i];
    var email = record && record.email;
    var username = record && record.username;

    if (!email) { summary.skipped.no_email++; continue; }
    if (winbackSender.isExcludedEmail(email, ownerEmail)) { summary.skipped.excluded++; continue; }
    if (await emailSuppressionStore.isSuppressed(event, email)) { summary.skipped.suppressed++; continue; }

    var dreams = await dreamStore.getPrivateDreams(event, username);
    if (!dreams || !dreams.length) { summary.skipped.no_dreams++; continue; }

    for (var d = 0; d < dreams.length && eligible.length < limit; d++) {
      var dream = dreams[d];
      var operationName = dream && dream.sourceOperationName;
      if (!operationName) { summary.skipped.no_operation_name++; continue; }

      var readSet = await interpReadStore.listPersonasRead(event, operationName);
      var readCount = readSet.length;

      // ── Trigger 1: "Unread meanings" — read 1-4 of 5 ──
      if (readCount >= 1 && readCount <= 4) {
        if (await interpEmailStore.hasSentUnread(event, operationName)) { summary.skipped.already_sent_unread++; continue; }
        var unreadKey = firstUnreadPersona(readSet);
        if (!unreadKey) { summary.skipped.not_eligible++; continue; } // defensive — a 1-4 count always has an unread
        eligible.push({
          type: 'unread', username: username, email: email, dream: dream, operationName: operationName,
          readPersonaKey: readSet[0], unreadPersonaKey: unreadKey
        });
        continue;
      }

      // ── Trigger 2: "No meaning yet" — read 0, but WATCHED the video ──
      if (readCount === 0) {
        var watched = await resultViewStore.hasViewed(event, operationName);
        if (!watched) { summary.skipped.not_eligible++; continue; }
        if (await interpEmailStore.hasSentNone(event, operationName)) { summary.skipped.already_sent_none++; continue; }
        eligible.push({
          type: 'none', username: username, email: email, dream: dream, operationName: operationName
        });
        continue;
      }

      // read all 5 (or some impossible count) — nothing to send
      summary.skipped.not_eligible++;
    }
  }

  summary.selected.unread = eligible.filter(function (e) { return e.type === 'unread'; }).length;
  summary.selected.none = eligible.filter(function (e) { return e.type === 'none'; }).length;

  // ── Send pass (the choke point re-applies every guard + the CAS claim) ──
  for (var j = 0; j < eligible.length; j++) {
    var item = eligible[j];
    var result;
    if (item.type === 'unread') {
      result = await unreadSender.sendIfEligible(event, {
        operationName: item.operationName, username: item.username, email: item.email, dream: item.dream,
        readPersonaKey: item.readPersonaKey, unreadPersonaKey: item.unreadPersonaKey, ownerEmail: ownerEmail
      });
    } else {
      result = await noneSender.sendIfEligible(event, {
        operationName: item.operationName, username: item.username, email: item.email, dream: item.dream,
        ownerEmail: ownerEmail
      });
    }
    if (result.sent) {
      summary.sent[item.type]++;
      if (result.pushSent) summary.sent.push++;
    } else {
      var reason = (item.type + ':') + (result.skipped || 'unknown');
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

  // `which` validated BEFORE the owner check, same ordering discipline as the
  // limit validation (shape errors before the auth boundary).
  var which = 'both';
  if (Object.prototype.hasOwnProperty.call(payload, 'which') && payload.which !== null && payload.which !== undefined) {
    if (payload.which !== 'unread' && payload.which !== 'none' && payload.which !== 'both') {
      return { statusCode: 400, body: JSON.stringify({ error: 'E6: invalid_which' }) };
    }
    which = payload.which;
  }

  var requestEmail = normalizeEmail(payload.email);
  if (!requestEmail || requestEmail !== ownerEmail) {
    return { statusCode: 403, body: JSON.stringify({ error: 'E5: forbidden' }) };
  }

  // Owner-gated PREVIEW: send the interpretation email preview(s) to an
  // explicit address (the founder's own test inbox). Bypasses selection, the
  // founder/test exclusion, the suppression list, and the once-per-dream
  // markers. Default (no `which`, or "both") sends BOTH so he sees both in
  // one call. Only reachable past the owner check above.
  if (Object.prototype.hasOwnProperty.call(payload, 'previewTo') && payload.previewTo) {
    if (typeof payload.previewTo !== 'string' || payload.previewTo.indexOf('@') < 1) {
      return { statusCode: 400, body: JSON.stringify({ error: 'E7: invalid_preview_to' }) };
    }
    var to = payload.previewTo.trim();
    var results = {};
    if (which === 'both' || which === 'unread') {
      results.unread = await unreadSender.sendPreview(event, to);
    }
    if (which === 'both' || which === 'none') {
      results.none = await noneSender.sendPreview(event, to);
    }
    var allOk = Object.keys(results).every(function (k) { return results[k] && results[k].ok; });
    return { statusCode: allOk ? 200 : 502, body: JSON.stringify({ preview: true, to: to, which: which, results: results }) };
  }

  var summary = await selectAndSend(event, { limit: limit, ownerEmail: ownerEmail });
  return { statusCode: 200, body: JSON.stringify(summary) };
};

// Exposed for direct unit testing.
exports.selectAndSend = selectAndSend;
exports.firstUnreadPersona = firstUnreadPersona;
exports.DEFAULT_LIMIT = DEFAULT_LIMIT;
exports.MAX_LIMIT = MAX_LIMIT;
