// netlify/functions/admin-repair-feed-likes.js
//
// ONE-OFF, owner-gated data-correction endpoint for tracker item
// for-product-likes-vanish-from-feed-video-fyqks0: restores the 3 real
// likes founder-confirmed lost to like-dream.js's stale-read clobber (see
// that file's own header comment for the root cause and the fix) before
// this fix landed. PostHog's own like_given events for these dreams are
// real, already-happened user actions — this applies the missing +1 each
// should have produced, it does not manufacture new engagement.
//
// TARGET_REPAIRS below is a hardcoded, one-off list (id + how many likes
// were lost), not a request parameter — same "not a general-purpose tool,
// a literal fixed correction for this one incident" reasoning admin-
// restore-founder-email.js's own header comment already established for
// RESTORE_USERNAME. Per that same precedent: DELETE THIS FILE (and its
// test) once it's actually been invoked once against production.
//
// IDEMPOTENT / SAFE TO CALL MORE THAN ONCE: each dream gets a
// `_lostLikeRepairs` marker array stamped with REPAIR_ID the moment this
// repair actually applies to it (same "already recovered" self-check shape
// admin-repair-lost-generations.js uses via sourceOperationName, just a
// list instead of a single field since a dream could in principle need more
// than one distinct one-off repair over its lifetime) — a second call finds
// the marker already present and skips that dream rather than adding
// another +1. GET previews what a POST would do (or report already done)
// with no write at all, same GET-preview/POST-apply shape as admin-
// restore-founder-email.js.
//
// RACE SAFETY: this touches the exact same dreamtube-feed/feed-index blob
// like-dream.js does, so it goes through lib/blobs-retry.js's
// retryingWrite too, not a raw read-modify-write — see like-dream.js's own
// STALE-READ CLOBBER FIX header comment for why a raw RMW on this key is
// unsafe. All 3 target dreams are corrected in ONE retryingWrite
// read->mutate->write->verify cycle (not 3 separate ones) so the write is
// atomic across all of them. FAILS CLOSED on retry exhaustion (contrast
// like-dream.js's own live like-toggle path, which fails open) — this is a
// manually-triggered, one-shot data correction the operator can just
// re-run (it's idempotent), so there's no reason to report success without
// a confirmed write for a real-money-adjacent... no, not money, but still a
// deliberate, auditable correction a human is watching the response of.
//
// AUTH: identical bar to admin-restore-founder-email.js — real,
// server-verified password (lib/account-store.js's verifyLogin) against an
// account whose own on-file email matches OWNER_EMAIL. Duplicated inline
// rather than shared, matching this codebase's explicit precedent (see
// admin-diagnose-account-duplicates.js's own header comment).
//
// Request:
//   GET  ?usernameOrEmail=...&password=... -> read-only report, no writes.
//   POST { usernameOrEmail, password } -> applies the repair.
//
// Response: 200 { ok:true, dryRun, repairs: [ { id, found, alreadyRepaired,
//   likesBefore, likesAfter } ] }
//
// Error codes (local to this function, same small-number-scheme reasoning
// as every sibling admin-*.js file):
//   E1 method_not_allowed
//   E2 missing_owner_email
//   E3 invalid_json (POST only)
//   E4 missing_fields
//   E5 forbidden
//   E6 rate_limited
//   E7 exhausted_retries — the write could not be confirmed within the
//      bounded retry budget; safe to just call this again (idempotent).

var { connectLambda, getStore } = require('@netlify/blobs');
var accountStore = require('./lib/account-store');
var blobsRetry = require('./lib/blobs-retry');
var { normalizeEmail } = require('./lib/entitlements');
var rateLimit = require('./lib/rate-limit');

var STORE_NAME = 'dreamtube-feed';
var KEY = 'feed-index';
var REPAIR_ID = 'fyqks0';

// The 3 founder-confirmed, PostHog-vs-feed-count documented cases — see
// this file's own header comment and tracker item
// for-product-likes-vanish-from-feed-video-fyqks0's own text for the exact
// ids/evidence. Each lost exactly 1 like to the stale-read clobber.
var TARGET_REPAIRS = [
  { id: 'dvkt5z2x', delta: 1 },
  { id: 'dztocy69', delta: 1 },
  { id: 'dioart8a', delta: 1 }
];

/** Real, server-verified credential check + owner-email confirmation — duplicated from admin-restore-founder-email.js's own copy, see header comment. */
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
 * The actual read (and, if `write`, repair) of the 3 target dreams' likes.
 * Returns { repairs: [{ id, found, alreadyRepaired, likesBefore, likesAfter }],
 * exhausted: boolean }.
 *
 * mutate() computes what EVERY target dream's next state should be (skipping
 * ones already carrying REPAIR_ID or not present in the feed at all) in one
 * pass, so all 3 corrections land in a single write — see header comment.
 * If nothing actually needs to change (all 3 already repaired, or none
 * found), returns blobsRetry.SKIP rather than performing a no-op write —
 * same "once false, retrying can't change it" reasoning every other SKIP
 * call site in this codebase uses.
 */
async function reportOrRepair(event, write) {
  connectLambda(event);

  // Read-only report path: a single fresh read, no retry loop needed (no
  // write is happening, so nothing here can race against itself).
  if (!write) {
    var current = (await getStore(STORE_NAME).get(KEY, { type: 'json' })) || [];
    var preview = TARGET_REPAIRS.map(function (target) {
      var dream = current.filter(function (d) { return d.id === target.id; })[0];
      if (!dream) return { id: target.id, found: false, alreadyRepaired: false, likesBefore: null, likesAfter: null };
      var already = (dream._lostLikeRepairs || []).indexOf(REPAIR_ID) !== -1;
      return {
        id: target.id, found: true, alreadyRepaired: already,
        likesBefore: dream.likes || 0,
        likesAfter: already ? (dream.likes || 0) : Math.max(0, (dream.likes || 0) + target.delta)
      };
    });
    return { repairs: preview, exhausted: false };
  }

  var report; // filled in by mutate() on the attempt verify() confirms

  var result = await blobsRetry.retryingWrite(event, STORE_NAME, KEY, {
    read: function (evt) {
      connectLambda(evt);
      return getStore(STORE_NAME).get(KEY, { type: 'json' }).then(function (v) { return v || []; });
    },
    mutate: function (items) {
      items = items || [];
      var next = items.slice();
      var changed = false;
      var thisAttemptReport = [];

      TARGET_REPAIRS.forEach(function (target) {
        var idx = next.findIndex(function (d) { return d.id === target.id; });
        if (idx === -1) {
          thisAttemptReport.push({ id: target.id, found: false, alreadyRepaired: false, likesBefore: null, likesAfter: null });
          return;
        }
        var dream = next[idx];
        var existingMarks = dream._lostLikeRepairs || [];
        if (existingMarks.indexOf(REPAIR_ID) !== -1) {
          thisAttemptReport.push({ id: target.id, found: true, alreadyRepaired: true, likesBefore: dream.likes || 0, likesAfter: dream.likes || 0 });
          return;
        }
        var newLikes = Math.max(0, (dream.likes || 0) + target.delta);
        next[idx] = Object.assign({}, dream, { likes: newLikes, _lostLikeRepairs: existingMarks.concat([REPAIR_ID]) });
        changed = true;
        thisAttemptReport.push({ id: target.id, found: true, alreadyRepaired: false, likesBefore: dream.likes || 0, likesAfter: newLikes });
      });

      report = thisAttemptReport;
      if (!changed) return blobsRetry.SKIP; // every target already repaired or not found -- nothing to write
      return next;
    },
    verify: function (verifyItems) {
      verifyItems = verifyItems || [];
      return report.every(function (r) {
        if (!r.found) return true; // nothing to verify for a target that isn't in the feed
        var found = verifyItems.filter(function (d) { return d.id === r.id; })[0];
        if (!found) return false;
        return found.likes === r.likesAfter && (found._lostLikeRepairs || []).indexOf(REPAIR_ID) !== -1;
      });
    }
  });

  if (result.skipped) {
    // report was still populated by mutate() before it returned SKIP.
    return { repairs: report, exhausted: false };
  }
  if (!result.ok) {
    return { repairs: null, exhausted: true };
  }
  return { repairs: report, exhausted: false };
}

exports.handler = async function (event) {
  var method = event.httpMethod;
  if (method !== 'GET' && method !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'E1: method_not_allowed' }) };
  }

  var ownerEmail = normalizeEmail(process.env.OWNER_EMAIL);
  if (!ownerEmail) {
    return { statusCode: 500, body: JSON.stringify({ error: 'E2: missing_owner_email' }) };
  }

  var usernameOrEmail, password;
  if (method === 'GET') {
    var q = event.queryStringParameters || {};
    usernameOrEmail = typeof q.usernameOrEmail === 'string' ? q.usernameOrEmail.trim() : '';
    password = typeof q.password === 'string' ? q.password : '';
  } else {
    var payload;
    try {
      payload = JSON.parse(event.body || '{}');
    } catch (e) {
      return { statusCode: 400, body: JSON.stringify({ error: 'E3: invalid_json' }) };
    }
    usernameOrEmail = typeof payload.usernameOrEmail === 'string' ? payload.usernameOrEmail.trim() : '';
    password = typeof payload.password === 'string' ? payload.password : '';
  }

  if (!usernameOrEmail || !password) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'E4: missing_fields' }) };
  }

  // Same two-bucket (per-IP + per-identifier) rate limiting as every
  // sibling admin-*.js account/data tool.
  var maxPerIpPerDay = parseInt(process.env.MAX_ADMIN_REPAIR_FEED_LIKES_PER_IP_PER_DAY, 10);
  if (!maxPerIpPerDay || maxPerIpPerDay <= 0) maxPerIpPerDay = 20;
  var maxPerIdentifierPerDay = parseInt(process.env.MAX_ADMIN_REPAIR_FEED_LIKES_PER_IDENTIFIER_PER_DAY, 10);
  if (!maxPerIdentifierPerDay || maxPerIdentifierPerDay <= 0) maxPerIdentifierPerDay = 10;

  var ip = rateLimit.clientIp(event);
  var ipLimit = await rateLimit.checkAndIncrement(event, 'admin-repair-feed-likes-ip', ip, maxPerIpPerDay);
  if (!ipLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ ok: false, error: 'E6: rate_limited: too many attempts from this network today, try again tomorrow' }) };
  }

  var canonicalAccount = await accountStore.getByUsername(event, usernameOrEmail);
  if (!canonicalAccount) canonicalAccount = await accountStore.getByEmail(event, usernameOrEmail);
  var identifierKey = canonicalAccount ? canonicalAccount.username : usernameOrEmail.toLowerCase();
  var identifierLimit = await rateLimit.checkAndIncrement(event, 'admin-repair-feed-likes-identifier', identifierKey, maxPerIdentifierPerDay);
  if (!identifierLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ ok: false, error: 'E6: rate_limited: too many attempts for this account today, try again tomorrow' }) };
  }

  var auth = await verifyOwnerCredentials(event, usernameOrEmail, password);
  if (!auth.ok) {
    return { statusCode: 403, body: JSON.stringify({ ok: false, error: 'E5: forbidden' }) };
  }

  try {
    var result = await reportOrRepair(event, method === 'POST');
    if (result.exhausted) {
      return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'E7: exhausted_retries: safe to call this again, it is idempotent' }) };
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true, dryRun: method === 'GET', repairs: result.repairs }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'repair_failed: ' + (e && e.message) }) };
  }
};
