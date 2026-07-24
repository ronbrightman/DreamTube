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
//      into the body. The email's `reply_to` is set to the USER's own
//      email — not DreamTube's from-address — so Ron can hit "Reply" in
//      his own inbox and land directly on a message to that user, per
//      his own request. This is a manual step by design for now:
//      reply-capture/threading back into this app ("we will try to
//      automate this process" — Ron's own words) is explicitly deferred,
//      not built here.
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
// Server-side email resolution: if `username` resolves to a real,
// server-side account (lib/account-store.js), that account's own email
// is used instead of the client-supplied `email` — same defense-in-depth
// reasoning admin-paywall-toggle.js/generate-video.js already apply
// elsewhere in this codebase to client-supplied identity: a request
// naming someone else's real username can't misdirect the reply-to onto
// an attacker-chosen address for a genuinely registered account. Falls
// back to the client-supplied email only when no server-side account
// record exists yet (a legacy, not-yet-backfilled local-only account —
// see account-store.js's own header comment on this being a normal,
// still-open gap, not a bug this function is responsible for closing).
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

  // Defense-in-depth email resolution — see header comment above.
  var account = await accountStore.getByUsername(event, username);
  var email = account ? account.email : normalizeEmail(payload.email);
  if (!email) {
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
    email: email,
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
      var subject = 'DreamTube ' + label + ' — ' + username;
      var html =
        '<p><b>' + label + ' message from @' + esc(username) + '</b> (' + esc(email) + ')</p>' +
        '<p style="white-space:pre-wrap;">' + esc(message) + '</p>' +
        '<hr>' +
        '<p style="color:#666;font-size:13px;">' +
        'Videos created: ' + (videoCount == null ? 'unknown' : videoCount) + '<br>' +
        'Days since signup: ' + (daysSinceSignup == null ? 'unknown' : daysSinceSignup) + '<br>' +
        'Submitted: ' + entry.submittedAt +
        '</p>' +
        '<p style="color:#666;font-size:13px;">Reply to this email to respond to ' + esc(username) + ' directly.</p>';

      var res = await fetch(RESEND_API_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + resendKey },
        body: JSON.stringify({
          from: FROM_ADDRESS,
          to: [ownerEmail],
          reply_to: email,
          subject: subject,
          html: html
        })
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
