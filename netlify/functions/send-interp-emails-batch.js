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

// ── WALL-CLOCK TIME BUDGET (perf fix 2026-08-11) ──────────────────────────
// The selection pass scans every account and, for every synced dream, does a
// prefix list() (interp-read-store) + hasViewed + a sent-marker read — far
// more per-account Blob round-trips than send-winback-batch, so over the full
// user base it blew this sync function's platform execution limit (a real
// send POST returned RemoteDisconnected — the function was killed with no
// response). Fix: a wall-clock budget on the scan (stop scanning after
// SELECTION_BUDGET_MS and send whatever eligible set was found so far) plus a
// SECOND independent bound on the send loop (stop starting new sends past
// SEND_DEADLINE_MS), so the function ALWAYS returns before the platform limit.
//
// OPERATING MODEL: this is a manual, owner-triggered drain. Because every send
// is idempotent (the per-dream once-ever CAS markers in interp-email-store),
// repeated owner-triggered calls safely drain the queue in bounded chunks —
// each call sends up to `limit` (default 10, max 50) of whatever it found
// within the budget, marks them sent, and the next call skips those and picks
// up the rest. `limit` is the SEND cap; the time budget is the independent
// safety bound that keeps the function under its platform timeout. The summary
// reports `timeBudgetHit`/`sendBudgetHit`/`accountsScanned` so the caller knows
// whether more remains to drain. Both budgets are env-overridable
// (INTERP_BATCH_SELECT_BUDGET_MS / INTERP_BATCH_SEND_DEADLINE_MS) without a
// redeploy. Defaults are conservative for a 10s platform limit; raise them if
// this function runs on a higher-limit plan.
function selectionBudgetMs() {
  var n = parseInt(process.env.INTERP_BATCH_SELECT_BUDGET_MS, 10);
  return (n && n > 0) ? n : 6000;
}
function sendDeadlineMs() {
  var n = parseInt(process.env.INTERP_BATCH_SEND_DEADLINE_MS, 10);
  return (n && n > 0) ? n : 9000;
}

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
  var startedAt = Date.now();
  var selBudget = (typeof opts.selectionBudgetMs === 'number') ? opts.selectionBudgetMs : selectionBudgetMs();
  var sendDeadline = (typeof opts.sendDeadlineMs === 'number') ? opts.sendDeadlineMs : sendDeadlineMs();

  var accounts = await accountStore.listAccounts(event);

  var summary = {
    ok: true,
    limit: limit,
    totalAccounts: accounts.length,
    accountsScanned: 0,
    timeBudgetHit: false, // selection scan was cut short by SELECTION_BUDGET_MS
    sendBudgetHit: false, // send loop was cut short by SEND_DEADLINE_MS
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
  //    accounts that survive the account-level filters). Bounded by both the
  //    send cap (`limit`) AND the wall-clock budget (see header) so it can
  //    never blow the platform timeout on a large user base. ──
  var eligible = [];
  for (var i = 0; i < accounts.length && eligible.length < limit; i++) {
    // Time budget — stop scanning and send whatever we've found so far.
    if (Date.now() - startedAt > selBudget) { summary.timeBudgetHit = true; break; }
    summary.accountsScanned++;
    var record = accounts[i];
    var email = record && record.email;
    var username = record && record.username;

    if (!email) { summary.skipped.no_email++; continue; }
    if (winbackSender.isExcludedEmail(email, ownerEmail)) { summary.skipped.excluded++; continue; }
    if (await emailSuppressionStore.isSuppressed(event, email)) { summary.skipped.suppressed++; continue; }

    var dreams = await dreamStore.getPrivateDreams(event, username);
    if (!dreams || !dreams.length) { summary.skipped.no_dreams++; continue; }

    // PER-USER CAP (founder hygiene ask 2026-08-11): a single user gets AT
    // MOST ONE interpretation email per batch run, even if they qualify for
    // both triggers or have several eligible dreams — never blasted with
    // multiple at once (a different hook on a different dream can still reach
    // them on a LATER run, gated only by the per-dream once-ever markers). We
    // scan ALL of this account's dreams to find the best single candidate,
    // PREFERRING the flagship "unread" over "none", then push exactly one.
    // Per-dream skip reasons are still counted for the summary.
    var unreadCandidate = null;
    var noneCandidate = null;
    for (var d = 0; d < dreams.length; d++) {
      if (Date.now() - startedAt > selBudget) { summary.timeBudgetHit = true; break; }
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
        if (!unreadCandidate) {
          unreadCandidate = {
            type: 'unread', username: username, email: email, dream: dream, operationName: operationName,
            readPersonaKey: readSet[0], unreadPersonaKey: unreadKey
          };
        }
        continue;
      }

      // ── Trigger 2: "No meaning yet" — read 0, but WATCHED the video ──
      if (readCount === 0) {
        var watched = await resultViewStore.hasViewed(event, operationName);
        if (!watched) { summary.skipped.not_eligible++; continue; }
        if (await interpEmailStore.hasSentNone(event, operationName)) { summary.skipped.already_sent_none++; continue; }
        if (!noneCandidate) {
          noneCandidate = {
            type: 'none', username: username, email: email, dream: dream, operationName: operationName
          };
        }
        continue;
      }

      // read all 5 (or some impossible count) — nothing to send
      summary.skipped.not_eligible++;
    }

    // One email per user this run — flagship "unread" wins over "none".
    var chosen = unreadCandidate || noneCandidate;
    if (chosen) eligible.push(chosen);
    if (summary.timeBudgetHit) break; // budget hit mid-account — stop after finishing this one
  }

  summary.selected.unread = eligible.filter(function (e) { return e.type === 'unread'; }).length;
  summary.selected.none = eligible.filter(function (e) { return e.type === 'none'; }).length;

  // ── Send pass (the choke point re-applies every guard + the CAS claim).
  //    Independently wall-clock-bounded: stop STARTING new sends past the send
  //    deadline so the function returns before its platform limit; anything not
  //    sent this call is re-found (idempotently) by the next drain call. ──
  for (var j = 0; j < eligible.length; j++) {
    if (Date.now() - startedAt > sendDeadline) { summary.sendBudgetHit = true; break; }
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

/**
 * countOnly / dryRun diagnostic — SENDS NOTHING. Returns:
 *   alreadySent: { unread, none } — EXACT counts of dreams already emailed
 *     (interp-email-store.countSent, two cheap whole-store list()s; the source
 *     of truth for "did any real send leak"). A `null` for a kind means its
 *     count couldn't be read (not "zero").
 *   eligible: { unread, none } — how many dreams currently qualify, tallied by
 *     a wall-clock-bounded scan (same per-dream classification as the send
 *     path, minus the per-user cap and the `limit`). If `timeBudgetHit` is
 *     true this is a LOWER BOUND (the scan stopped early), not the full total.
 *   accountsScanned / totalAccounts / timeBudgetHit — scan coverage.
 * Bounded by the same SELECTION_BUDGET_MS as the send scan, so it also fits the
 * platform timeout.
 */
async function scanCounts(event, opts) {
  var ownerEmail = opts.ownerEmail;
  var startedAt = Date.now();
  var selBudget = (typeof opts.selectionBudgetMs === 'number') ? opts.selectionBudgetMs : selectionBudgetMs();

  var alreadySent = await interpEmailStore.countSent(event);
  var accounts = await accountStore.listAccounts(event);

  var res = {
    ok: true,
    mode: 'countOnly',
    totalAccounts: accounts.length,
    accountsScanned: 0,
    timeBudgetHit: false,
    alreadySent: alreadySent,
    eligible: { unread: 0, none: 0 }
  };

  for (var i = 0; i < accounts.length; i++) {
    if (Date.now() - startedAt > selBudget) { res.timeBudgetHit = true; break; }
    res.accountsScanned++;
    var record = accounts[i];
    var email = record && record.email;
    var username = record && record.username;
    if (!email || winbackSender.isExcludedEmail(email, ownerEmail)) continue;
    if (await emailSuppressionStore.isSuppressed(event, email)) continue;

    var dreams = await dreamStore.getPrivateDreams(event, username);
    if (!dreams || !dreams.length) continue;

    for (var d = 0; d < dreams.length; d++) {
      if (Date.now() - startedAt > selBudget) { res.timeBudgetHit = true; break; }
      var dream = dreams[d];
      var operationName = dream && dream.sourceOperationName;
      if (!operationName) continue;

      var readSet = await interpReadStore.listPersonasRead(event, operationName);
      var readCount = readSet.length;
      if (readCount >= 1 && readCount <= 4) {
        if (!(await interpEmailStore.hasSentUnread(event, operationName))) res.eligible.unread++;
      } else if (readCount === 0) {
        if ((await resultViewStore.hasViewed(event, operationName)) && !(await interpEmailStore.hasSentNone(event, operationName))) res.eligible.none++;
      }
    }
    if (res.timeBudgetHit) break;
  }

  return res;
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

  // Owner-gated COUNT-ONLY / DRY-RUN diagnostic — scans and reports counts,
  // SENDS NOTHING (see scanCounts). Reachable only past the owner check above.
  if (payload.countOnly === true || payload.dryRun === true) {
    var counts = await scanCounts(event, { ownerEmail: ownerEmail });
    return { statusCode: 200, body: JSON.stringify(counts) };
  }

  var summary = await selectAndSend(event, { limit: limit, ownerEmail: ownerEmail });
  return { statusCode: 200, body: JSON.stringify(summary) };
};

// Exposed for direct unit testing.
exports.selectAndSend = selectAndSend;
exports.scanCounts = scanCounts;
exports.firstUnreadPersona = firstUnreadPersona;
exports.DEFAULT_LIMIT = DEFAULT_LIMIT;
exports.MAX_LIMIT = MAX_LIMIT;
