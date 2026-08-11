// netlify/functions/lib/interp-unread-email-sender.js
//
// The guarded "actually send the flagship 'Unread meanings' interpretation
// retention email + matching push" core (founder-approved retention plan;
// see send-interp-emails-batch.js's header comment for the full feature and
// the batch endpoint that selects recipients and calls this). Direct mirror
// of lib/unwatched-dream-nudge-sender.js / lib/winback-email-sender.js: a
// once-per-dream CAS guard (lib/interp-email-store.js's markUnreadSentOnce)
// claimed BEFORE any send, founder/test addresses excluded and the email-
// suppression list honored BEFORE that claim, best-effort PostHog telemetry,
// a provider-side Resend Idempotency-Key, and the shared lib/email-layout.js
// night-aesthetic shell with the required List-Unsubscribe headers +
// visible unsubscribe footer (lib/unsubscribe-token.js) — all pointed at the
// canonical origin via lib/site-origin.js. It ALSO sends the matching Web
// Push (lib/push-sender.js + lib/push-dedup-store.js), the second channel.
//
// TRIGGER (owned by the batch endpoint's selection, restated here): the user
// READ between 1 and 4 (inclusive) of the 5 interpretation personas on a
// given dream — some but not all, and not zero. Re-fires PER DREAM (each of
// a user's dreams can independently trigger once — the self-suppression is
// the per-dream CAS marker, not a per-user one).
//
// APPROVED COPY (founder-approved, used verbatim — the body sentence is
// filled with a persona the user DID read and one they did NOT):
//   Body: "You read what <READ_NAME> saw. <UNREAD_NAME> saw something very
//          different. Check it out."
// Persona DISPLAY names come from js/interpreter-personas.js (the single
// source of truth) — the batch endpoint passes the persona KEYS, this sender
// resolves their display names, so a founder rename of any persona flows
// through with no change here.

var interpEmailStore = require('./interp-email-store');
var resultViewStore = require('./result-view-store');
var posthogCapture = require('./posthog-capture');
var emailSuppressionStore = require('./email-suppression-store');
var unsubscribeToken = require('./unsubscribe-token');
var emailLayout = require('./email-layout');
var siteOrigin = require('./site-origin');
var pushSender = require('./push-sender');
var pushDedupStore = require('./push-dedup-store');
var winbackSender = require('./winback-email-sender');
var InterpreterPersonas = require('../../../js/interpreter-personas');

var RESEND_API_BASE = 'https://api.resend.com/emails';
var FROM_ADDRESS = 'DreamTube <dreams@dreamtube.life>';

var SUBJECT_LINE = 'One reading you haven\'t seen 🌙'; // 🌙

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** A persona's human display name from the single source of truth, or the key itself as a last-resort fallback (never blank). */
function personaName(personaKey) {
  var p = InterpreterPersonas.get(personaKey);
  return (p && p.name) ? p.name : String(personaKey || '');
}

/** Resolves a dream's imageUrl to an absolute https:// url an email client can load, against the canonical origin (a scheduled/owner invocation has no inbound Host). Returns null when there's no url. */
function absoluteImageUrl(event, url) {
  if (typeof url !== 'string' || !url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  return siteOrigin.emailOrigin(event) + (url.charAt(0) === '/' ? url : '/' + url);
}

/** The deep link to THIS dream's interpretation view — result.html?id=<dreamId>&interp=1 auto-opens the Chamber (see result.html's `interp=1` handler). */
function interpUrl(event, dreamId) {
  return siteOrigin.emailOrigin(event) + '/result.html?id=' + encodeURIComponent(String(dreamId || '')) + '&interp=1';
}

/** The exact approved body sentence, persona display names substituted. */
function bodySentence(readName, unreadName) {
  return 'You read what ' + readName + ' saw. ' + unreadName + ' saw something very different. Check it out.';
}

function buildHtml(opts) {
  var media = opts.imageUrl
    ? '<img src="' + esc(opts.imageUrl) + '" width="480" alt="" style="display:block;width:100%;max-width:480px;height:160px;object-fit:cover;border-radius:14px;margin-bottom:18px;" />'
    : '';

  var sentence = 'You read what <b>' + esc(opts.readName) + '</b> saw. <b>' + esc(opts.unreadName) + '</b> saw something very different. Check it out.';

  var inner = (
    media +
    '<p style="font-size:16px;line-height:1.5;color:' + emailLayout.COLORS.textPrimary + ';margin:0 0 18px;">' + sentence + '</p>' +
    '<p style="margin:0;">' + emailLayout.ctaButton(opts.interpUrl, 'Check it out →') + '</p>'
  );

  return emailLayout.renderShell({
    event: opts.event,
    previewText: opts.unreadName + ' saw something very different in your dream.',
    bodyHtml: inner,
    unsubscribeUrl: opts.unsubscribeUrl
  });
}

/** Best-effort skip telemetry — fires 'interp_unread_email_skipped', never throws, never affects the return value. */
async function reportSkip(username, email, reason) {
  try {
    await posthogCapture.captureEvent({
      event: 'interp_unread_email_skipped',
      distinct_id: username || email || 'unknown',
      properties: { reason: reason }
    });
  } catch (e) { /* analytics must never break the app */ }
}

/** Best-effort matching push, gated by its own once-per-dream dedup (separate channel from the email marker — see lib/push-dedup-store.js). Never throws, never affects the email result. */
async function sendPush(event, opts) {
  try {
    var dedupKey = 'interp-unread:' + opts.operationName;
    var claim = await pushDedupStore.markSentOnce(event, dedupKey);
    if (!claim.ok) return false;
    var result = await pushSender.sendToUser(event, opts.username, {
      title: 'One reading you haven\'t seen',
      body: opts.unreadName + ' saw something very different in your dream.',
      url: './result.html?id=' + encodeURIComponent(String(opts.dreamId || '')) + '&interp=1',
      type: pushSender.PUSH_TYPES.INTERP_UNREAD
    });
    return !!(result && result.ok);
  } catch (e) {
    console.error('interp-unread-email-sender: push send failed (non-fatal)', e);
    return false;
  }
}

/**
 * Guarded send (email + push). `opts`:
 *   operationName    (required) — the dream's server-issued job id; the guard key
 *   username         (required) — verified account username
 *   email            (required) — verified account email
 *   dream            (required) — the resolved private-dream record (`id`, `imageUrl`, `storyText`/`caption`)
 *   readPersonaKey   (required) — a persona key the user DID read
 *   unreadPersonaKey (required) — a persona key the user did NOT read
 *   ownerEmail       (optional) — the endpoint's configured OWNER_EMAIL, excluded from sends
 *
 * Returns { ok:true, sent:true, pushSent:bool } only when Resend accepted the
 * email, else { ok:true, sent:false, skipped:<reason> } for every other case.
 * Never throws — best-effort.
 */
async function sendIfEligible(event, opts) {
  opts = opts || {};
  var operationName = opts.operationName;
  var username = opts.username;
  var email = opts.email;
  var dream = opts.dream;

  if (!operationName || !username || !email || !dream || !opts.readPersonaKey || !opts.unreadPersonaKey) {
    await reportSkip(username, email, 'missing_identity');
    return { ok: true, sent: false, skipped: 'missing_identity' };
  }

  // Founder / test address — never send, checked BEFORE claiming the guard.
  if (winbackSender.isExcludedEmail(email, opts.ownerEmail)) {
    await reportSkip(username, email, 'excluded');
    return { ok: true, sent: false, skipped: 'excluded' };
  }

  // Unsubscribed — checked BEFORE claiming the guard, so a suppressed
  // recipient never burns this dream's one-and-only marker.
  var suppressed = await emailSuppressionStore.isSuppressed(event, email);
  if (suppressed) {
    await reportSkip(username, email, 'suppressed');
    return { ok: true, sent: false, skipped: 'suppressed' };
  }

  // Once-per-dream claim — the real "exactly one Unread-meanings email per
  // dream" guarantee.
  var guard = await interpEmailStore.markUnreadSentOnce(event, operationName);
  if (!guard.ok) {
    var guardReason = guard.alreadySent ? 'already_sent' : (guard.error || 'guard_failed');
    await reportSkip(username, email, guardReason);
    return { ok: true, sent: false, skipped: guardReason };
  }

  var resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    console.log('interp-unread-email-sender: RESEND_API_KEY not configured -- skipping send for ' + username);
    await interpEmailStore.releaseUnread(event, operationName, guard.claimId);
    await reportSkip(username, email, 'no_resend_key');
    return { ok: true, sent: false, skipped: 'no_resend_key' };
  }

  var readName = personaName(opts.readPersonaKey);
  var unreadName = personaName(opts.unreadPersonaKey);
  var unsubscribeUrl = unsubscribeToken.buildUnsubscribeUrl(event, email);
  var html = buildHtml({
    event: event,
    readName: readName,
    unreadName: unreadName,
    imageUrl: absoluteImageUrl(event, dream.imageUrl),
    interpUrl: interpUrl(event, dream.id),
    unsubscribeUrl: unsubscribeUrl
  });

  // The subject stays the founder-approved faithful line (SUBJECT_LINE);
  // personalization lives in the body (the approved copy: the two persona
  // names), not the subject.
  var idempotencyKey = 'interp-unread-email:' + operationName;

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
        headers: {
          'List-Unsubscribe': '<' + unsubscribeUrl + '>',
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
        }
      })
    });
    if (!res.ok) {
      console.error('interp-unread-email-sender: Resend rejected the send', res.status);
      await interpEmailStore.releaseUnread(event, operationName, guard.claimId);
      await reportSkip(username, email, 'resend_rejected');
      return { ok: true, sent: false, skipped: 'resend_rejected' };
    }
  } catch (sendErr) {
    console.error('interp-unread-email-sender: Resend send failed (non-fatal)', sendErr);
    await interpEmailStore.releaseUnread(event, operationName, guard.claimId);
    await reportSkip(username, email, 'resend_network_failure');
    return { ok: true, sent: false, skipped: 'resend_network_failure' };
  }

  try {
    await posthogCapture.captureEvent({
      event: 'interp_unread_email_sent',
      distinct_id: username,
      properties: { read_persona: opts.readPersonaKey, unread_persona: opts.unreadPersonaKey }
    });
  } catch (e) { /* analytics must never break the app */ }

  // Second channel — best-effort, never affects the email result.
  var pushSent = await sendPush(event, {
    operationName: operationName, username: username, dreamId: dream.id, unreadName: unreadName
  });

  return { ok: true, sent: true, pushSent: pushSent };
}

/**
 * PREVIEW send (owner-gated at the handler): composes the SAME email with
 * realistic sample persona names + sample dream text and sends it to an
 * explicit address, bypassing selection, the founder/test exclusion, the
 * suppression list, AND the once-per-dream marker (so the founder can re-
 * preview). EMAIL ONLY — a push can't be meaningfully previewed to an inbox.
 */
async function sendPreview(event, previewEmail) {
  var resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return { ok: false, error: 'no_resend_key' };
  var unsubscribeUrl = unsubscribeToken.buildUnsubscribeUrl(event, previewEmail);
  var html = buildHtml({
    event: event,
    readName: personaName('jung'),   // "The Depth Analyst"
    unreadName: personaName('freud'), // "The Analyst"
    imageUrl: null,
    interpUrl: interpUrl(event, 'sample-dream-id'),
    unsubscribeUrl: unsubscribeUrl
  });
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
  bodySentence,
  personaName,
  SUBJECT_LINE,
  FROM_ADDRESS
};
