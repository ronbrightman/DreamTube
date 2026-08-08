// netlify/functions/admin-diagnose-resend-sends.js
//
// READ-ONLY diagnostic for tracker item
// for-product-urgent-email-dedup-integrity-iys5fb: three accounts
// (moreecemiller, dtsexton18, demiaharchie49) each logged 3-4
// `first_dream_email_sent` PostHog events around 2026-08-01/08-02. The
// founder already ran admin-diagnose-account-duplicates.js and confirmed
// these are NOT duplicate accounts sharing one inbox -- each username is
// a genuinely distinct account, each solely owning its own distinct
// email address. So the multiple telemetry events genuinely hit the SAME
// single account each time, and only ONE remaining question is left,
// answerable only from Resend's own send logs (our own PostHog events
// prove nothing here -- they're exactly the metric under suspicion):
//   (A) EVENT-TAXONOMY OVER-COUNT -- multiple code paths log the
//       `first_dream_email_sent` event name for what is really the same
//       one Resend send, or for genuinely-legitimate-but-differently-
//       purposed sends (e.g. a retry that correctly re-fired after an
//       earlier releaseFailedSend) that still only ever produced ONE
//       delivered email per PostHog-event-count claim. Fix would be
//       renaming/scoping the event sources -- no real duplicate emails
//       ever went out, nothing wrong with the CAS dedup itself.
//   (B) REAL CAS BUG -- lib/first-dream-email-store.js's markSentOnce
//       (an `onlyIfNew` blobs10 conditional write) is not actually
//       holding against REAL, non-mocked Netlify Blobs, and these users
//       genuinely received 3-4 identical duplicate emails. Burns trust
//       and domain reputation; the win-back send campaign (tracker item
//       for-product-win-back-send-founder-direct-3yku0r) stays blocked
//       on this being confirmed fixed.
// This tool settles it directly: it counts how many emails Resend's own
// API actually shows as SENT to each of the affected addresses in the
// window this happened, plus each match's timestamp/subject so a human
// can eyeball whether they look like distinct legitimate emails or
// literal duplicates of the identical first-dream template.
//
// WHAT IT DOES: calls Resend's real `GET https://api.resend.com/emails`
// list-sent-emails endpoint (Bearer auth via process.env.RESEND_API_KEY
// -- same base host/auth convention as
// lib/first-dream-email-sender.js's own send call, RESEND_API_BASE
// there is the /emails POST endpoint this is the sibling GET of),
// confirmed against Resend's own current docs (resend.com/docs/api-
// reference/emails/list-emails, resend.com/changelog/list-sent-emails-
// endpoint, both fetched live 2026-08-08 via this sandbox's web access --
// NOT verified against a real Resend account, see this file's own REAL-
// MODE note below): query params are `limit` (max 100) and `after`
// (an email id, for cursor pagination) OR `before` (mutually exclusive
// with `after` -- this file only ever uses `after`, paging backward in
// time). Response shape: `{ object:'list', has_more:boolean,
// data:[ { id, message_id, to, from, created_at, subject, bcc, cc,
// reply_to, last_event, scheduled_at }, ... ] }`. Results come back
// NEWEST-FIRST (confirmed via the docs' own pagination description:
// `after` navigates from newer to older items) and there is NO
// recipient/to-address filter server-side -- every page has to be
// fetched and filtered client-side here.
//
// PAGINATION STRATEGY: fetch pages of 100, newest-first, following
// `after=<last email id on this page>` until either (a) the OLDEST
// email on a page has `created_at` before `sinceISO` (safe to stop --
// everything past this point is older than the window, and results are
// strictly newest-first so no in-range email could still be waiting
// further back), (b) `has_more` is false (genuinely exhausted Resend's
// whole history), or (c) the PAGE_CAP safety bound below is hit first,
// in which case the response is honestly marked `truncated:true` rather
// than silently returning an incomplete result as if it were complete.
//
// AUTH: identical bar to every sibling admin diagnostic in this codebase
// -- real, server-verified password (lib/account-store.js's verifyLogin)
// against an account whose own on-file email matches OWNER_EMAIL.
// Duplicated inline rather than shared, matching this codebase's explicit
// precedent (see admin-diagnose-account-duplicates.js's own header
// comment, and admin-diagnose-rename-conflict.js's before it).
//
// RATE LIMITING: same two-bucket (per-IP + per-identifier) shape as every
// sibling admin tool.
//
// PRIVACY: this can read the SUBJECT LINE and delivery timestamp of any
// email this Resend account has ever sent to the requested addresses --
// no email BODY content is ever requested or returned. Same founder-only
// gating as every sibling admin diagnostic; scoped output only reports
// what's needed to prove/disprove duplicate delivery (createdAt,
// subject), never Resend's internal id/message_id/other recipients.
//
// Request: POST { usernameOrEmail, password, recipientEmails: [string, ...],
//   sinceISO, untilISO }
//   recipientEmails: 1-20 email addresses to check for matching sends.
//   sinceISO/untilISO: ISO-8601 timestamps bounding the window (untilISO
//     is applied client-side too, filtering out any match newer than it --
//     Resend's own list endpoint has no date-range query param at all).
// Response: 200 { ok:true, results: { "<email>": { count, sends:
//   [ {createdAt, subject}, ... ] }, ... }, totalEmailsScanned,
//   pagesFetched, truncated }
//
// Error codes (same small-number scheme as every sibling admin-*.js file):
//   E1 method_not_allowed
//   E2 missing_owner_email
//   E3 invalid_json
//   E4 missing_fields
//   E5 forbidden
//   E6 rate_limited
//   E7 invalid_recipient_emails — `recipientEmails` missing, not an array,
//      empty, over 20 entries, or containing a non-string/blank entry
//   E8 invalid_date_range — `sinceISO`/`untilISO` missing, not parseable
//      as a date, or `sinceISO` is not strictly before `untilISO`
//   E9 missing_resend_api_key — RESEND_API_KEY not configured
//   E10 resend_api_error — Resend's own API returned a non-2xx response
//      or the fetch itself failed; propagated honestly, never swallowed
//      into an empty/partial result presented as complete

var accountStore = require('./lib/account-store');
var { normalizeEmail } = require('./lib/entitlements');
var rateLimit = require('./lib/rate-limit');

var MAX_RECIPIENT_EMAILS = 20;
var RESEND_LIST_API_BASE = 'https://api.resend.com/emails';
var PAGE_SIZE = 100;
var PAGE_CAP = 50; // 50 pages * 100/page = 5000 emails scanned, max

/** Real, server-verified credential check + owner-email confirmation -- duplicated from sibling admin-diagnose-*.js files, see header comment. */
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

function isValidIsoDate(s) {
  if (typeof s !== 'string' || !s.trim()) return false;
  var t = Date.parse(s);
  return !isNaN(t);
}

/**
 * Pages backward through Resend's real send history (newest-first),
 * stopping once we've paged past `sinceMs` or hit PAGE_CAP -- see this
 * file's header comment for the full strategy/stop conditions.
 * Returns { emails, pagesFetched, truncated }. Throws on any Resend API
 * error/network failure -- the caller (handler below) turns that into
 * an honest E10 response rather than swallowing it.
 */
async function fetchResendSendsSince(resendKey, sinceMs) {
  var emails = [];
  var after = null;
  var pagesFetched = 0;
  var truncated = false;

  for (;;) {
    if (pagesFetched >= PAGE_CAP) {
      truncated = true;
      break;
    }

    var url = RESEND_LIST_API_BASE + '?limit=' + PAGE_SIZE + (after ? '&after=' + encodeURIComponent(after) : '');
    var res = await fetch(url, {
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + resendKey }
    });
    pagesFetched += 1;

    if (!res.ok) {
      var errText;
      try { errText = await res.text(); } catch (e) { errText = ''; }
      var err = new Error('resend_api_error: ' + res.status + ' ' + errText);
      err.isResendApiError = true;
      throw err;
    }

    var page = await res.json();
    var data = (page && Array.isArray(page.data)) ? page.data : [];

    var hitBoundary = false;
    for (var i = 0; i < data.length; i++) {
      var item = data[i];
      var createdMs = item && item.created_at ? Date.parse(item.created_at) : NaN;
      if (!isNaN(createdMs) && createdMs < sinceMs) {
        // Results are strictly newest-first -- everything from here to
        // the end of this page (and every subsequent page) is even
        // older, so it's safe to stop without fetching further.
        hitBoundary = true;
        break;
      }
      emails.push(item);
    }

    if (hitBoundary) break;

    var hasMore = !!(page && page.has_more);
    if (!hasMore || data.length === 0) break;

    var lastItem = data[data.length - 1];
    if (!lastItem || !lastItem.id) break; // can't page further without a cursor id
    after = lastItem.id;
  }

  return { emails: emails, pagesFetched: pagesFetched, truncated: truncated };
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

  var recipientEmails = payload.recipientEmails;
  var recipientsValid = Array.isArray(recipientEmails) && recipientEmails.length > 0 && recipientEmails.length <= MAX_RECIPIENT_EMAILS &&
    recipientEmails.every(function (e) { return typeof e === 'string' && e.trim(); });
  if (!recipientsValid) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'E7: invalid_recipient_emails' }) };
  }

  var sinceISO = payload.sinceISO;
  var untilISO = payload.untilISO;
  if (!isValidIsoDate(sinceISO) || !isValidIsoDate(untilISO) || Date.parse(sinceISO) >= Date.parse(untilISO)) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'E8: invalid_date_range' }) };
  }

  // Same two-bucket rate limiting as every sibling admin tool.
  var maxPerIpPerDay = parseInt(process.env.MAX_ADMIN_DIAGNOSE_RESEND_SENDS_PER_IP_PER_DAY, 10);
  if (!maxPerIpPerDay || maxPerIpPerDay <= 0) maxPerIpPerDay = 20;
  var maxPerIdentifierPerDay = parseInt(process.env.MAX_ADMIN_DIAGNOSE_RESEND_SENDS_PER_IDENTIFIER_PER_DAY, 10);
  if (!maxPerIdentifierPerDay || maxPerIdentifierPerDay <= 0) maxPerIdentifierPerDay = 10;

  var ip = rateLimit.clientIp(event);
  var ipLimit = await rateLimit.checkAndIncrement(event, 'admin-diagnose-resend-sends-ip', ip, maxPerIpPerDay);
  if (!ipLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ ok: false, error: 'E6: rate_limited: too many attempts from this network today, try again tomorrow' }) };
  }

  var canonicalAccount = await accountStore.getByUsername(event, usernameOrEmail);
  if (!canonicalAccount) canonicalAccount = await accountStore.getByEmail(event, usernameOrEmail);
  var identifierKey = canonicalAccount ? canonicalAccount.username : usernameOrEmail.toLowerCase();
  var identifierLimit = await rateLimit.checkAndIncrement(event, 'admin-diagnose-resend-sends-identifier', identifierKey, maxPerIdentifierPerDay);
  if (!identifierLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ ok: false, error: 'E6: rate_limited: too many attempts for this account today, try again tomorrow' }) };
  }

  var auth = await verifyOwnerCredentials(event, usernameOrEmail, password);
  if (!auth.ok) {
    return { statusCode: 403, body: JSON.stringify({ ok: false, error: 'E5: forbidden' }) };
  }

  var resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'E9: missing_resend_api_key' }) };
  }

  var sinceMs = Date.parse(sinceISO);
  var untilMs = Date.parse(untilISO);

  var page;
  try {
    page = await fetchResendSendsSince(resendKey, sinceMs);
  } catch (e) {
    console.error('admin-diagnose-resend-sends: Resend API call failed', e);
    return { statusCode: 502, body: JSON.stringify({ ok: false, error: 'E10: resend_api_error: ' + (e && e.message ? e.message : 'unknown') }) };
  }

  var wantedLower = recipientEmails.map(function (e) { return e.trim().toLowerCase(); });
  var results = {};
  recipientEmails.forEach(function (e) { results[e] = { count: 0, sends: [] }; });

  for (var i = 0; i < page.emails.length; i++) {
    var item = page.emails[i];
    var createdMs = item && item.created_at ? Date.parse(item.created_at) : NaN;
    if (isNaN(createdMs) || createdMs < sinceMs || createdMs > untilMs) continue;

    var to = Array.isArray(item.to) ? item.to : (item.to ? [item.to] : []);
    var toLower = to.map(function (t) { return String(t || '').trim().toLowerCase(); });

    for (var j = 0; j < wantedLower.length; j++) {
      if (toLower.indexOf(wantedLower[j]) !== -1) {
        var originalKey = recipientEmails[j];
        results[originalKey].count += 1;
        results[originalKey].sends.push({ createdAt: item.created_at, subject: item.subject || null });
      }
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      ok: true,
      results: results,
      totalEmailsScanned: page.emails.length,
      pagesFetched: page.pagesFetched,
      truncated: page.truncated
    })
  };
};
