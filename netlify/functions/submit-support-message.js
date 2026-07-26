// netlify/functions/submit-support-message.js
//
// POST { type, username, email, message, videoCount, daysSinceSignup } ->
// the backend for Settings' Support/Feedback form (see tracker.html's
// support-and-feedback-atms4a item, Ron's own words: "in the settings tab
// in the users profile ... a section for support where user can enter
// text and this text is sent to me to my email and also to you to a
// dedicated place, including user details and allow me to reply directly
// to the user from my own email").
//
// Does two things on a valid submission:
//   1. Persists the message to Blobs (lib/support-store.js) — the
//      "dedicated place... for you to learn from later" half. This is
//      the durable record a later Claude Code session can actually read
//      back (see get-support-messages.js), independent of whether the
//      email below is ever opened.
//   2. Emails OWNER_EMAIL via Resend (same provider/pattern as
//      request-password-reset.js) with the message plus real user
//      context (username, email, videoCount, daysSinceSignup) folded
//      into the body. Whenever `username` resolves to a real, VERIFIED
//      server-side account, the email's `reply_to` is set to that
//      account's own email — not DreamTube's from-address — so Ron can
//      hit "Reply" in his own inbox and land directly on a message to
//      that user, per his own request. See the "Server-side email
//      resolution + reply_to" section below for why an unverified
//      client-supplied email is never used as `reply_to` (only shown,
//      clearly labeled, in the email body). This reply is a manual step
//      by design for now: reply-capture/threading back into this app
//      ("we will try to automate this process" — Ron's own words) is
//      explicitly deferred, not built here.
//
// `type` distinguishes Support ("something's wrong, help me") from
// Feedback ("here's a product opinion, unprompted") — both go through
// this same endpoint/store (per the tracker item's own suggestion to
// reuse one mechanism rather than build a second pipeline), just tagged
// differently in the email subject and the persisted record so Ron/a
// later session can tell them apart at a glance.
//
// videoCount/daysSinceSignup are CLIENT-SUPPLIED, not independently
// verified — see lib/support-store.js's header comment for why (this
// app's dreams/signup-time live only in each browser's localStorage
// today, there is no server-side source of truth to check them against
// yet). Both are optional/nullable: a legacy account with no local
// createdAt on file (see js/store.js's getAccountCreatedAt) sends
// daysSinceSignup: null, rendered as "unknown" in the email rather than a
// fabricated number.
//
// Server-side email resolution + reply_to: if `username` resolves to a
// real, server-side account (lib/account-store.js), that account's own
// (VERIFIED) email is used as the Resend `reply_to`. This is a public,
// unauthenticated POST gated only by a per-IP rate limit — a request
// naming a `username` that ISN'T a real registered account is trivial for
// anyone to send, so falling back to the raw client-supplied `email` as
// `reply_to` (an earlier version of this function did exactly that) would
// let anyone make Ron's "Reply" button land on an arbitrary third party's
// address with attacker-chosen message content — a real impersonation/
// harassment vector, not theoretical, since this is a mail header on an
// email that actually reaches his inbox. So `reply_to` is ONLY ever the
// verified account email — the key is omitted from the Resend call
// entirely when no verified account exists (see the `resendPayload`
// build below), never a fallback to unverified input. The unverified
// client-supplied email is still accepted for `contactEmail` (persisted
// in the Blobs record, and shown in the email BODY, clearly labeled
// "unverified", for human context only — never as a header) — a legacy,
// not-yet-backfilled local-only account (see account-store.js's own
// header comment on this being a normal, still-open gap) still gets its
// message through and its self-reported contact address shown, just
// without the reply-to convenience a verified account gets.
//
// Residual, accepted gap (distinct from the reply_to-spoofing vector above,
// which IS closed): this endpoint is unauthenticated, so anyone who knows a
// real registered `username` can submit a message AS that user — their
// real verified email gets wired up as reply_to and shown as the sender,
// even though the actual caller never proved they control that account.
// That's impersonating a real user's authorship, not redirecting PII to an
// attacker (that vector is closed) — the same client-trusted-identity
// tradeoff already accepted elsewhere in this early-beta app (no real
// server-side sessions yet). Not fixed here; needs a real auth/session
// layer to close properly (tracker.html's harden-submit-support-message-js
// item).
//
// Error codes (local to this function, same small-number-scheme
// reasoning as admin-paywall-toggle.js/owner-topup-tokens.js):
//   E1 method_not_allowed  — verb other than POST
//   E2 invalid_json        — POST body wasn't valid JSON
//   E3 invalid_type        — `type` present but not "support"/"feedback"
//   E4 username_required   — `username` missing/blank
//   E5 email_required      — no usable email at all (neither a
//                              server-side account record nor a
//                              client-supplied `email`)
//   E6 message_required    — `message` missing/blank after trimming
//   E7 message_too_long    — `message` over MAX_MESSAGE_LENGTH characters
//   E8 rate_limited        — MAX_SUPPORT_MESSAGES_PER_IP_PER_DAY exceeded
//                              for today (see register-account.js for the
//                              same per-IP-cap-on-a-public-endpoint shape)
//
// Deliberately does NOT hard-fail the whole request if RESEND_API_KEY is
// missing or the Resend send itself fails — unlike request-password-
// reset.js (where a silent failure would need to be indistinguishable
// from "no matching account" for anti-enumeration reasons), there's no
// such constraint here: the message is still safely persisted to Blobs
// either way (the more important of the two "make sure Ron sees this"
// paths, since it can be read back later even if the email is lost), so
// a Resend outage or a not-yet-configured API key degrades to "recorded
// but not emailed today" rather than losing the message outright.

var { normalizeEmail } = require('./lib/entitlements');
var accountStore = require('./lib/account-store');
var supportStore = require('./lib/support-store');
var rateLimit = require('./lib/rate-limit');
var crypto = require('crypto');

var VALID_TYPES = ['support', 'feedback'];
var MAX_MESSAGE_LENGTH = 4000;
var MAX_SUPPORT_MESSAGES_PER_IP_PER_DAY_DEFAULT = 10;
var RESEND_API_BASE = 'https://api.resend.com/emails';
// Same "works out of the box, no domain verification needed" address
// request-password-reset.js already uses.
var FROM_ADDRESS = 'DreamTube <onboarding@resend.dev>';

function esc(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// `username` here is CLIENT-SUPPLIED and not length-limited by
// register-account.js (only a MINIMUM of 3 chars is enforced there), and
// this endpoint doesn't even require it to resolve to a real account (see
// the header comment on the accountStore.getByUsername lookup below) — so
// an arbitrary caller can put an arbitrary string straight into
// `resendPayload.subject`, a raw mail header field. Resend's API takes
// structured JSON over HTTPS rather than raw SMTP text, so a literal
// CRLF-header-injection attack isn't actually reachable here the way it
// would be against a real sendmail-style API — but stripping CR/LF and
// capping length anyway is cheap, real defense-in-depth against whatever
// Resend (or a future provider swap) does internally with this string, and
// keeps an absurdly long username from bloating/breaking the subject line
// Ron actually reads. Only used for the subject; the HTML body already
// escapes username via esc() everywhere it appears.
var MAX_SUBJECT_USERNAME_LENGTH = 100;
function forSubjectHeader(str) {
  return String(str == null ? '' : str).replace(/[\r\n]+/g, ' ').slice(0, MAX_SUBJECT_USERNAME_LENGTH);
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'E1: method_not_allowed' }) };
  }

  var payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E2: invalid_json' }) };
  }

  var type = payload.type === 'feedback' ? 'feedback' : (payload.type === 'support' ? 'support' : null);
  if (!type || VALID_TYPES.indexOf(type) === -1) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E3: invalid_type' }) };
  }

  var username = (payload.username || '').trim();
  if (!username) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E4: username_required' }) };
  }

  var message = (payload.message || '').trim();
  if (!message) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E6: message_required' }) };
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E7: message_too_long' }) };
  }

  var maxPerDay = parseInt(process.env.MAX_SUPPORT_MESSAGES_PER_IP_PER_DAY, 10);
  if (!maxPerDay || maxPerDay <= 0) maxPerDay = MAX_SUPPORT_MESSAGES_PER_IP_PER_DAY_DEFAULT;
  var ip = rateLimit.clientIp(event);
  var ipLimit = await rateLimit.checkAndIncrement(event, 'support-message-ip', ip, maxPerDay);
  if (!ipLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ error: 'E8: rate_limited' }) };
  }

  // Server-side email resolution — see header comment above for why
  // `verifiedEmail` (never the raw client-supplied one) is the only thing
  // that may ever become the Resend `reply_to`.
  var account = await accountStore.getByUsername(event, username);
  var verifiedEmail = account ? account.email : null;
  var contactEmail = verifiedEmail || normalizeEmail(payload.email);
  if (!contactEmail) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E5: email_required' }) };
  }

  var videoCount = typeof payload.videoCount === 'number' && isFinite(payload.videoCount) && payload.videoCount >= 0
    ? Math.floor(payload.videoCount)
    : null;
  var daysSinceSignup = typeof payload.daysSinceSignup === 'number' && isFinite(payload.daysSinceSignup) && payload.daysSinceSignup >= 0
    ? Math.floor(payload.daysSinceSignup)
    : null;

  var entry = {
    id: crypto.randomBytes(8).toString('hex'),
    type: type,
    username: username,
    email: contactEmail,
    message: message,
    videoCount: videoCount,
    daysSinceSignup: daysSinceSignup,
    submittedAt: new Date().toISOString()
  };

  await supportStore.appendMessage(event, entry);

  var resendKey = process.env.RESEND_API_KEY;
  var ownerEmail = process.env.OWNER_EMAIL;
  if (resendKey && ownerEmail) {
    try {
      var label = type === 'feedback' ? 'Feedback' : 'Support';
      var subject = 'DreamTube ' + label + ' — ' + forSubjectHeader(username);
      // "(unverified)" whenever contactEmail didn't come from a real,
      // server-side account — Ron should be able to tell at a glance
      // that this address is exactly what the client claimed, not
      // something this function confirmed, since it's deliberately NOT
      // wired up as reply_to below (see header comment).
      var emailLabel = verifiedEmail ? esc(contactEmail) : (esc(contactEmail) + ' — unverified');
      var html =
        '<p><b>' + label + ' message from @' + esc(username) + '</b> (' + emailLabel + ')</p>' +
        '<p style="white-space:pre-wrap;">' + esc(message) + '</p>' +
        '<hr>' +
        '<p style="color:#666;font-size:13px;">' +
        'Videos created: ' + (videoCount == null ? 'unknown' : videoCount) + '<br>' +
        'Days since signup: ' + (daysSinceSignup == null ? 'unknown' : daysSinceSignup) + '<br>' +
        'Submitted: ' + entry.submittedAt +
        '</p>' +
        (verifiedEmail
          ? '<p style="color:#666;font-size:13px;">Reply to this email to respond to ' + esc(username) + ' directly.</p>'
          : '<p style="color:#666;font-size:13px;">This contact email is unverified (self-reported, no matching account found) — Reply on this email will NOT reach ' + esc(username) + '.</p>');

      var resendPayload = {
        from: FROM_ADDRESS,
        to: [ownerEmail],
        subject: subject,
        html: html
      };
      // Only ever set reply_to to a VERIFIED account email — see header
      // comment for why an unverified client-supplied address must never
      // become a mail header, regardless of how convincing it looks.
      if (verifiedEmail) resendPayload.reply_to = verifiedEmail;

      var res = await fetch(RESEND_API_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + resendKey },
        body: JSON.stringify(resendPayload)
      });
      if (!res.ok) console.error('submit-support-message: Resend rejected the send', res.status);
    } catch (sendErr) {
      console.error('submit-support-message: Resend send failed', sendErr);
    }
  } else {
    // Missing config — message is still safely persisted above (see
    // header comment for why this doesn't fail the whole request).
    console.error('submit-support-message: RESEND_API_KEY or OWNER_EMAIL not configured — message recorded but not emailed');
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
