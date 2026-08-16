// netlify/functions/lib/winback-email-sender.js
//
// The guarded "actually send ONE win-back email to a lapsed past user via
// Resend" core, for the owner-gated, hard-capped batch endpoint
// (send-winback-batch.js). A once-EVER-per-account CAS guard
// (lib/winback-email-store.js) claimed BEFORE any send, the suppression
// list honored BEFORE that claim, founder/test addresses excluded, best-
// effort PostHog telemetry, and a provider-side Resend Idempotency-Key as
// belt-and-suspenders — a direct mirror of lib/unwatched-dream-nudge-
// sender.js's send core (same Resend endpoint, FROM/reply-to convention,
// lib/email-layout.js shell, lib/unsubscribe-token.js one-click footer, and
// lib/site-origin.js emailOrigin for canonical links), specialized to the
// win-back's static approved copy and per-ACCOUNT (not per-dream) scope.
//
// This module owns only "exclude / suppress / dedupe / render / send" for a
// SINGLE recipient the endpoint has already selected. Recipient SELECTION
// (enumerate accounts, keep only lapsed / non-excluded / non-suppressed /
// not-yet-sent, honor the hard cap) lives in send-winback-batch.js. Both
// ends re-apply the exclusion + suppression + sent checks on purpose: the
// endpoint's selection pass keeps the hard cap from being spent on
// recipients that would skip anyway, and THIS sender is the single actual
// send choke point where the real once-ever guarantee (the CAS claim) is
// enforced, so a candidate that slips through selection (a suppression /
// marker landing in the window between selection and send) is still caught
// here.
//
// APPROVED COPY (founder-approved, used verbatim, rendered through
// email-layout's shell so it carries the required unsubscribe footer +
// mailing address + canonical logo/links):
//   Subject: Your next dream is waiting 🌙
//   Body:  "You made a dream on DreamTube — but the good ones never really
//           end."
//          "Tell us tonight's dream and we'll turn it into a video you can
//           keep."
//   Button: "Make a new dream →"  -> the canonical /create.html (the New
//           Dream page a returning user lands on to make a new one).
//   Sign-off: "Sweet dreams, DreamTube"

var winbackStore = require('./winback-email-store');
var posthogCapture = require('./posthog-capture');
var emailSuppressionStore = require('./email-suppression-store');
var unsubscribeToken = require('./unsubscribe-token');
var emailLayout = require('./email-layout');
var siteOrigin = require('./site-origin');
var emailLoginToken = require('./email-login-token');

var RESEND_API_BASE = 'https://api.resend.com/emails';
// Same address the nudge sender / dream-webhook sender use — this codebase's
// own convention for small self-contained per-file constants over one shared
// constants module (see lib/unwatched-dream-nudge-sender.js's own comment).
var FROM_ADDRESS = 'DreamTube <dreams@dreamtube.life>';

var SUBJECT_LINE = 'Your next dream is waiting 🌙'; // 🌙

// The founder's own address — never send the win-back to it. Also read from
// OWNER_EMAIL at the endpoint and threaded through (see isExcludedEmail),
// but pinned here too as belt-and-suspenders since the commissioning task
// names it explicitly.
var FOUNDER_EMAIL = 'ronbrightman@gmail.com';

function normalizeEmail(email) {
  return (typeof email === 'string' ? email : '').trim().toLowerCase();
}

/**
 * True when `email` must be excluded from the win-back entirely — the
 * founder's own address (FOUNDER_EMAIL, or the endpoint-supplied ownerEmail)
 * and any obvious test/placeholder address. Deliberately broad on the test
 * side ("@example.com/.org/.net", "@test." / ".test", "@localhost", and a
 * "+test" / literal "test@" tag) since the cost of wrongly INCLUDING a real
 * test address in a real user send is far worse than wrongly excluding an
 * oddly-named real one. Exported so both the endpoint's selection pass and
 * this sender's own choke-point re-check use the exact same rule.
 */
function isExcludedEmail(email, ownerEmail) {
  var e = normalizeEmail(email);
  if (!e) return true; // no address to send to -- exclude
  if (e === FOUNDER_EMAIL) return true;
  if (ownerEmail && e === normalizeEmail(ownerEmail)) return true;
  if (/@example\.(com|org|net)$/.test(e)) return true;
  if (/@(test|localhost)$/.test(e)) return true;
  if (/@test\./.test(e)) return true;
  if (/\.test$/.test(e)) return true;
  if (/(^|[._+-])test@/.test(e)) return true;
  return false;
}

function createUrl(event) {
  return siteOrigin.emailOrigin(event) + '/create.html?ec=winback';
}

/**
 * The one-tap login CTA target (founder 2026-08-15 "make the return emails
 * auto-login"): the email-login.js endpoint carrying a single-use, 7-day
 * lib/email-login-token.js token, landing (after that endpoint mints a fresh
 * ?bt= and redirects) on /create.html already signed in. Falls back to a
 * plain /create.html link if minting fails — a token-store hiccup must never
 * stop a win-back send.
 */
async function loginCreateUrl(event, username, email) {
  try {
    var token = await emailLoginToken.createToken(event, username, email);
    return siteOrigin.emailOrigin(event) + '/.netlify/functions/email-login?elt=' +
      encodeURIComponent(token) + '&dest=' + encodeURIComponent('/create.html') + '&ec=winback';
  } catch (e) {
    return createUrl(event);
  }
}

/** Builds the win-back email HTML — the static approved copy rendered through email-layout's shared night-aesthetic shell (unsubscribe footer + mailing address + logo). */
function buildHtml(opts) {
  var inner = (
    '<p style="font-size:16px;line-height:1.5;color:' + emailLayout.COLORS.textPrimary + ';margin:0 0 14px;">' +
    'You made a dream on DreamTube &mdash; but the good ones never really end.' +
    '</p>' +
    '<p style="font-size:16px;line-height:1.5;color:' + emailLayout.COLORS.textPrimary + ';margin:0 0 20px;">' +
    'Tell us tonight&rsquo;s dream and we&rsquo;ll turn it into a video you can keep.' +
    '</p>' +
    '<p style="margin:0 0 20px;">' + emailLayout.ctaButton(opts.createUrl, 'Make a new dream →') + '</p>' +
    '<p style="font-size:15px;line-height:1.5;color:' + emailLayout.COLORS.textMuted + ';margin:0;">Sweet dreams,<br>DreamTube</p>'
  );

  return emailLayout.renderShell({
    event: opts.event,
    previewText: 'The good ones never really end.',
    bodyHtml: inner,
    unsubscribeUrl: opts.unsubscribeUrl
  });
}

/** Best-effort skip telemetry — fires 'winback_email_skipped', never throws, never affects the return value. */
async function reportSkip(username, email, reason) {
  try {
    await posthogCapture.captureEvent({
      event: 'winback_email_skipped',
      distinct_id: username || email || 'unknown',
      properties: { reason: reason }
    });
  } catch (e) { /* analytics must never break the app */ }
}

/**
 * Guarded single-recipient send. `opts`:
 *   username   (required) — the lapsed account's username (guard key + PostHog distinct_id)
 *   email      (required) — the account's email
 *   ownerEmail (optional) — the endpoint's configured OWNER_EMAIL, excluded from sends
 *
 * Returns { ok:true, sent:true } only when Resend accepted the send, else
 * { ok:true, sent:false, skipped:<reason> } for every other case (excluded,
 * suppressed, already-sent, no Resend key, Resend rejected/failed). Never
 * throws — best-effort, exactly like the nudge sender.
 *
 * ORDER OF GUARDS (each BEFORE the once-ever CAS claim, so a skipped send
 * never burns this account's one-and-only win-back marker):
 *   missing identity -> excluded (founder/test) -> suppressed -> CLAIM ->
 *   Resend-key -> send. Only after a claim is won and the key is present is
 *   any request put on the wire; a failed send releases the claim.
 */
async function sendIfEligible(event, opts) {
  opts = opts || {};
  var username = opts.username;
  var email = opts.email;

  if (!username || !email) {
    await reportSkip(username, email, 'missing_identity');
    return { ok: true, sent: false, skipped: 'missing_identity' };
  }

  // Founder / test address — never send, and check BEFORE claiming the guard.
  if (isExcludedEmail(email, opts.ownerEmail)) {
    await reportSkip(username, email, 'excluded');
    return { ok: true, sent: false, skipped: 'excluded' };
  }

  // Unsubscribed/suppressed — checked BEFORE claiming the guard, so a
  // suppressed recipient never burns this account's one-and-only marker.
  var suppressed = await emailSuppressionStore.isSuppressed(event, email);
  if (suppressed) {
    await reportSkip(username, email, 'suppressed');
    return { ok: true, sent: false, skipped: 'suppressed' };
  }

  // Once-ever-per-account claim — the real "no user ever gets it twice,
  // even across repeated batch runs" guarantee.
  var guard = await winbackStore.markSentOnce(event, username);
  if (!guard.ok) {
    var guardReason = guard.alreadySent ? 'already_sent' : (guard.error || 'guard_failed');
    await reportSkip(username, email, guardReason);
    return { ok: true, sent: false, skipped: guardReason };
  }

  var resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    console.log('winback-email-sender: RESEND_API_KEY not configured -- skipping send for ' + username);
    // Release the just-won claim: no send was attempted, so a later batch
    // run (once RESEND_API_KEY IS set) must still be able to send it — a
    // config gap must not permanently burn this account's win-back.
    await winbackStore.releaseFailedWinback(event, username, guard.claimId);
    await reportSkip(username, email, 'no_resend_key');
    return { ok: true, sent: false, skipped: 'no_resend_key' };
  }

  var unsubscribeUrl = unsubscribeToken.buildUnsubscribeUrl(event, email);
  var html = buildHtml({
    event: event,
    createUrl: await loginCreateUrl(event, username, email),
    unsubscribeUrl: unsubscribeUrl
  });

  // Provider-side idempotency (belt-and-suspenders): a stable per-account
  // key, so even if the CAS guard is ever fooled by a stale Blobs replica
  // during a consistency degradation, Resend itself collapses the duplicate.
  var idempotencyKey = 'winback-email:' + winbackStore.normalizeUsername(username);

  try {
    var res = await fetch(RESEND_API_BASE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + resendKey,
        'Idempotency-Key': idempotencyKey
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: [email],
        subject: SUBJECT_LINE,
        html: html,
        // RFC 8058 one-click unsubscribe (Gmail/Yahoo bulk-mail requirement)
        // — same token/endpoint as the visible footer link.
        headers: {
          'List-Unsubscribe': '<' + unsubscribeUrl + '>',
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
        }
      })
    });
    if (!res.ok) {
      console.error('winback-email-sender: Resend rejected the send', res.status);
      await winbackStore.releaseFailedWinback(event, username, guard.claimId);
      await reportSkip(username, email, 'resend_rejected');
      return { ok: true, sent: false, skipped: 'resend_rejected' };
    }
  } catch (sendErr) {
    console.error('winback-email-sender: Resend send failed (non-fatal)', sendErr);
    await winbackStore.releaseFailedWinback(event, username, guard.claimId);
    await reportSkip(username, email, 'resend_network_failure');
    return { ok: true, sent: false, skipped: 'resend_network_failure' };
  }

  try {
    await posthogCapture.captureEvent({
      event: 'winback_email_sent',
      distinct_id: username,
      properties: {}
    });
  } catch (e) { /* analytics must never break the app */ }

  return { ok: true, sent: true };
}

/**
 * PREVIEW send (owner-gated at the handler): composes the SAME win-back email
 * and sends it to an explicit address, bypassing selection, the founder/test
 * exclusion, the suppression list, AND the once-ever CAS marker — so the
 * founder can see (and re-see) the real email in his own inbox. Only reachable
 * via send-winback-batch.js's owner-gated `previewTo`.
 */
async function sendPreview(event, previewEmail) {
  var resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return { ok: false, error: 'no_resend_key' };
  var unsubscribeUrl = unsubscribeToken.buildUnsubscribeUrl(event, previewEmail);
  var html = buildHtml({ event: event, createUrl: createUrl(event), unsubscribeUrl: unsubscribeUrl });
  try {
    var res = await fetch(RESEND_API_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + resendKey },
      body: JSON.stringify({
        from: FROM_ADDRESS, to: [previewEmail], subject: SUBJECT_LINE, html: html,
        headers: { 'List-Unsubscribe': '<' + unsubscribeUrl + '>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
      })
    });
    return res.ok ? { ok: true, sent: true } : { ok: false, error: 'resend_' + res.status };
  } catch (e) { return { ok: false, error: 'send_failed' }; }
}

module.exports = {
  sendIfEligible,
  sendPreview,
  buildHtml,
  isExcludedEmail,
  SUBJECT_LINE,
  FROM_ADDRESS,
  FOUNDER_EMAIL
};
