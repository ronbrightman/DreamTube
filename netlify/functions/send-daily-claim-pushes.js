// netlify/functions/send-daily-claim-pushes.js
//
// Scheduled Netlify Function — tracker item for-product-build-stage-0-
// pwa-web-push-f-jbutt5, part 4 ("daily-claim-available: fires when a
// user's daily token claim becomes available again — see
// lib/entitlements.js's claimDailyTokens/CLAIM_COOLDOWN_MS"). This is the
// FIRST scheduled function anywhere in this repo — every other function
// here fires reactively, off a real client/webhook request. A "claim
// became available again" event is genuinely time-based (CLAIM_COOLDOWN_MS
// is a rolling 20h server-clock cooldown with no request that naturally
// lands right when it elapses — see that constant's own doc comment), so
// there is no existing request-driven choke point to piggyback on the way
// mark-generation-completed.js's video-ready push does; it has to be
// found by scanning, on a schedule. See netlify.toml's own comment for
// how the schedule itself is declared (both there AND via this file's own
// inline schedule() wrapper below, since this sandbox has no way to
// invoke Netlify's real scheduler to confirm which mechanism a given
// deploy actually honors).
//
// MECHANISM: scans every record in lib/entitlements.js's own
// "dreamtube-entitlements" Blobs store (keyed by email — see that file's
// header comment) via the Blobs SDK's own `list()` (no separate index
// needed — this store's records themselves already carry the field this
// job needs to read: `tokens.lastClaimAt`). For each account whose claim
// crossed its own `nextClaimAt` (lastClaimAt + CLAIM_COOLDOWN_MS) within
// the last CHECK_WINDOW_MS, sends the push — comfortably wide relative to
// the hourly schedule so no account's own crossing moment is ever missed
// between two consecutive runs, while narrow enough that a run's own
// (rare) failure/delay doesn't cause the NEXT run to re-notify an account
// that's been claimable for days.
//
// This is an O(n) full-store scan, not an indexed query — Netlify Blobs
// has no "list by field value" capability (see lib/blobs-retry.js's own
// header comment: "Blobs has no list-by-value"). Completely fine at this
// app's current real scale (see FOUNDER_PRINCIPLES.md's own "~0 users
// affected at current traffic" framing elsewhere in this codebase) — an
// actual production concern only once the entitlements store holds many
// thousands of records, at which point this would need a real secondary
// index (out of scope for this Stage-0 build).
//
// DEDUP: lib/push-dedup-store.js, keyed by 'daily-claim-available:' +
// email + ':' + nextClaimAt — a FRESH key every 20h cycle (nextClaimAt
// changes every time claimDailyTokens actually credits a new claim), so
// this job can safely re-scan the same account on every hourly run
// without ever double-sending for the SAME availability window, and
// naturally starts sending again for that account's NEXT window once it
// claims again. See that file's own header comment for why this can't
// reuse the video-ready push's marker or the retention email's marker —
// three genuinely different scopes.
//
// Never sends to an account that hasn't ever completed a claim at all
// (tokens.lastClaimAt falsy) — there's no "became available AGAIN" event
// for an account that's never claimed once; getTokenStatus's own
// dailyClaimAmount logic treats this the same way (see
// hasCompletedAnyClaim's doc comment).

var { schedule } = require('@netlify/functions');
var { getStore, connectLambda } = require('@netlify/blobs');
var entitlements = require('./lib/entitlements');
var accountStore = require('./lib/account-store');
var pushDedupStore = require('./lib/push-dedup-store');
var pushSender = require('./lib/push-sender');

// See header comment on why this is wider than the nominal hourly
// schedule interval (70 minutes, not 60) -- a deliberate overlap margin
// against a run starting a few minutes late/early, not a precision knob.
var CHECK_WINDOW_MS = 70 * 60 * 1000;

/**
 * Does the actual scan + send. Exposed separately from the scheduled
 * `exports.handler` below so test/send-daily-claim-pushes.test.js can
 * call it directly with a fake event/mocked stores, without needing to
 * simulate an actual Netlify scheduled invocation payload.
 */
async function scanAndSend(event) {
  connectLambda(event);
  var store = getStore({ name: entitlements.STORE_NAME });
  var listResult = await store.list();

  var now = Date.now();
  var scanned = 0;
  var sent = 0;

  for (var i = 0; i < listResult.blobs.length; i++) {
    var email = listResult.blobs[i].key;
    scanned++;

    var record;
    try {
      connectLambda(event);
      record = await store.get(email, { type: 'json' });
    } catch (e) {
      console.error('send-daily-claim-pushes: read failed for ' + email, e);
      continue;
    }
    if (!record || !record.tokens) continue;

    var lastClaimAt = record.tokens.lastClaimAt || 0;
    if (!lastClaimAt) continue; // never claimed even once -- nothing "became available again"

    var nextClaimAt = lastClaimAt + entitlements.CLAIM_COOLDOWN_MS;
    if (now < nextClaimAt) continue; // not yet available
    if (now - nextClaimAt > CHECK_WINDOW_MS) continue; // crossed too long ago -- an earlier run already covered it (or this predates the feature)

    var account = await accountStore.getByEmail(event, email);
    if (!account || !account.username) continue;

    var dedupKey = 'daily-claim-available:' + email + ':' + nextClaimAt;
    var claim = await pushDedupStore.markSentOnce(event, dedupKey);
    if (!claim.ok) continue; // already sent for this exact availability window

    var result = await pushSender.sendToUser(event, account.username, {
      title: 'Your daily tokens are ready',
      body: 'Come back and claim your free tokens.',
      url: './profile.html',
      type: pushSender.PUSH_TYPES.DAILY_CLAIM_AVAILABLE
    });
    if (result.ok) sent++;
  }

  return { scanned: scanned, sent: sent };
}

exports.handler = schedule('@hourly', async function (event) {
  try {
    var result = await scanAndSend(event);
    console.log('send-daily-claim-pushes: scanned ' + result.scanned + ' account(s), sent ' + result.sent + ' push(es)');
  } catch (e) {
    // Best-effort, same "never let this surface as a hard failure"
    // discipline as every other background/analytics-adjacent job in
    // this codebase -- a failed scan just means this hour's batch of
    // daily-claim pushes doesn't go out; the next scheduled run tries
    // again.
    console.error('send-daily-claim-pushes: unexpected error', e);
  }
  return { statusCode: 200 };
});

// Exposed for direct unit testing (test/send-daily-claim-pushes.test.js).
exports.scanAndSend = scanAndSend;
exports.CHECK_WINDOW_MS = CHECK_WINDOW_MS;
