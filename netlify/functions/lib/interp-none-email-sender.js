// netlify/functions/lib/interp-none-email-sender.js
//
// The guarded "actually send the 'No meaning yet' interpretation retention
// email + matching push" core (founder-approved retention plan; see
// send-interp-emails-batch.js's header comment for the full feature and the
// batch endpoint that selects recipients and calls this). Direct mirror of
// lib/unwatched-dream-nudge-sender.js / lib/interp-unread-email-sender.js: a
// once-per-dream CAS guard (lib/interp-email-store.js's markNoneSentOnce)
// claimed BEFORE any send, founder/test addresses excluded and the email-
// suppression list honored BEFORE that claim, best-effort PostHog telemetry,
// a provider-side Resend Idempotency-Key, the shared lib/email-layout.js
// shell with List-Unsubscribe headers + unsubscribe footer, canonical origin
// via lib/site-origin.js — and the matching Web Push (second channel).
//
// TRIGGER (owned by the batch endpoint's selection, restated here): the user
// WATCHED their dream video (lib/result-view-store.js has a viewed marker for
// this operationName) but opened ZERO of the 5 interpretations on that dream
// (lib/interp-read-store.js reports 0 personas read). Once per dream.
//
// APPROVED COPY (founder-approved, used verbatim — the body embeds the user's
// OWN dream text, truncated sensibly, and names Jung literally as the hook):
//   Body: "There's a hidden meaning in your dream '<THEIR_DREAM_TEXT>'. See
//          what Jung would say."

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

var RESEND_API_BASE = 'https://api.resend.com/emails';
var FROM_ADDRESS = 'DreamTube <dreams@dreamtube.life>';

var SUBJECT_LINE = 'There\'s a hidden meaning in your dream 🌙'; // 🌙

// A generous cap for the dream quote in the body — enough for a real dream
// sentence or two without letting a pathological multi-paragraph text bloat
// the email.
var BODY_TEXT_MAX = 180;
// The generic sample used only when a dream somehow carries no text at all
// (a legacy/edge record) — the batch selection avoids these, but the sender
// is the single choke point so it must still render something coherent.
var GENERIC_DREAM_TEXT = 'your dream';

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** The human-readable dream description this codebase already shows humans (js/store.js reads `d.storyText || d.caption`). '' if the dream carries neither. */
function dreamDescription(dream) {
  if (!dream) return '';
  var text = (typeof dream.storyText === 'string' && dream.storyText.trim()) ? dream.storyText
    : (typeof dream.caption === 'string' ? dream.caption : '');
  return String(text || '').trim();
}

/** Truncates on a word boundary where possible, appending an ellipsis only when it actually cut something. */
function truncate(text, max) {
  text = String(text || '');
  if (text.length <= max) return text;
  var slice = text.slice(0, max);
  var lastSpace = slice.lastIndexOf(' ');
  if (lastSpace > max * 0.6) slice = slice.slice(0, lastSpace);
  return slice.replace(/[\s.,;:!?-]+$/, '') + '…';
}

/** Resolves a dream's imageUrl to an absolute https:// url an email client can load, against the canonical origin. Returns null when there's no url. */
function absoluteImageUrl(event, url) {
  if (typeof url !== 'string' || !url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  return siteOrigin.emailOrigin(event) + (url.charAt(0) === '/' ? url : '/' + url);
}

/** The media banner: the recipient's OWN dream still where synced, else the branded interpretation-themed fallback — so this email ALWAYS shows an image (founder fix 2026-08-11: this email previously rendered no image at all). */
function resolveMediaUrl(event, dream) {
  return absoluteImageUrl(event, dream && dream.imageUrl) || emailLayout.brandedFallbackImageUrl(event);
}

/** The deep link to THIS dream's interpretation view — result.html?id=<dreamId>&interp=1 auto-opens the Chamber (see result.html's `interp=1` handler). */
function interpUrl(event, dreamId) {
  return siteOrigin.emailOrigin(event) + '/result.html?id=' + encodeURIComponent(String(dreamId || '')) + '&interp=1';
}

function buildHtml(opts) {
  var media = emailLayout.mediaImage(opts.imageUrl, 'Your dream');

  var quoted = opts.dreamText ? esc(truncate(opts.dreamText, BODY_TEXT_MAX)) : esc(GENERIC_DREAM_TEXT);

  var sentence = opts.dreamText
    ? 'There&rsquo;s a hidden meaning in your dream &lsquo;<b>' + quoted + '</b>&rsquo;. See what Jung would say.'
    : 'There&rsquo;s a hidden meaning in ' + quoted + '. See what Jung would say.';

  var inner = (
    media +
    '<p style="font-size:16px;line-height:1.5;color:' + emailLayout.COLORS.textPrimary + ';margin:0 0 18px;">' + sentence + '</p>' +
    '<p style="margin:0;">' + emailLayout.ctaButton(opts.interpUrl, 'See what Jung would say →') + '</p>'
  );

  return emailLayout.renderShell({
    event: opts.event,
    previewText: 'There\'s a hidden meaning in your dream. See what Jung would say.',
    bodyHtml: inner,
    unsubscribeUrl: opts.unsubscribeUrl
  });
}

/** Best-effort skip telemetry — fires 'interp_none_email_skipped', never throws, never affects the return value. */
async function reportSkip(username, email, reason) {
  try {
    await posthogCapture.captureEvent({
      event: 'interp_none_email_skipped',
      distinct_id: username || email || 'unknown',
      properties: { reason: reason }
    });
  } catch (e) { /* analytics must never break the app */ }
}

/** Best-effort matching push, gated by its own once-per-dream dedup (separate channel from the email marker). Never throws, never affects the email result. */
async function sendPush(event, opts) {
  try {
    var dedupKey = 'interp-none:' + opts.operationName;
    var claim = await pushDedupStore.markSentOnce(event, dedupKey);
    if (!claim.ok) return false;
    var pushBody = opts.dreamText
      ? 'There\'s a hidden meaning in ‘' + truncate(opts.dreamText, 80) + '’. See what Jung would say.'
      : 'There\'s a hidden meaning in your dream. See what Jung would say.';
    var result = await pushSender.sendToUser(event, opts.username, {
      title: 'There\'s a hidden meaning in your dream',
      body: pushBody,
      url: './result.html?id=' + encodeURIComponent(String(opts.dreamId || '')) + '&interp=1',
      type: pushSender.PUSH_TYPES.INTERP_NONE
    });
    return !!(result && result.ok);
  } catch (e) {
    console.error('interp-none-email-sender: push send failed (non-fatal)', e);
    return false;
  }
}

/**
 * Guarded send (email + push). `opts`:
 *   operationName (required) — the dream's server-issued job id; the guard key
 *   username      (required) — verified account username
 *   email         (required) — verified account email
 *   dream         (required) — the resolved private-dream record (`id`, `storyText`/`caption`)
 *   ownerEmail    (optional) — the endpoint's configured OWNER_EMAIL, excluded from sends
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

  if (!operationName || !username || !email || !dream) {
    await reportSkip(username, email, 'missing_identity');
    return { ok: true, sent: false, skipped: 'missing_identity' };
  }

  // Founder / test address — never send, checked BEFORE claiming the guard.
  if (winbackSender.isExcludedEmail(email, opts.ownerEmail)) {
    await reportSkip(username, email, 'excluded');
    return { ok: true, sent: false, skipped: 'excluded' };
  }

  // Belt-and-suspenders: re-confirm the dream was actually WATCHED at send
  // time (the batch selection already checks this, but this is the single
  // send choke point, so the trigger's own precondition lives here too —
  // checked BEFORE claiming the guard so a not-yet-watched dream never burns
  // its marker). Same lib/result-view-store.js marker the selection reads.
  var viewed = await resultViewStore.hasViewed(event, operationName);
  if (!viewed) {
    await reportSkip(username, email, 'not_watched');
    return { ok: true, sent: false, skipped: 'not_watched' };
  }

  // Unsubscribed — checked BEFORE claiming the guard.
  var suppressed = await emailSuppressionStore.isSuppressed(event, email);
  if (suppressed) {
    await reportSkip(username, email, 'suppressed');
    return { ok: true, sent: false, skipped: 'suppressed' };
  }

  // Once-per-dream claim — the real "exactly one No-meaning-yet email per
  // dream" guarantee.
  var guard = await interpEmailStore.markNoneSentOnce(event, operationName);
  if (!guard.ok) {
    var guardReason = guard.alreadySent ? 'already_sent' : (guard.error || 'guard_failed');
    await reportSkip(username, email, guardReason);
    return { ok: true, sent: false, skipped: guardReason };
  }

  var resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    console.log('interp-none-email-sender: RESEND_API_KEY not configured -- skipping send for ' + username);
    await interpEmailStore.releaseNone(event, operationName, guard.claimId);
    await reportSkip(username, email, 'no_resend_key');
    return { ok: true, sent: false, skipped: 'no_resend_key' };
  }

  var dreamText = dreamDescription(dream);
  var unsubscribeUrl = unsubscribeToken.buildUnsubscribeUrl(event, email);
  var html = buildHtml({
    event: event,
    dreamText: dreamText,
    imageUrl: resolveMediaUrl(event, dream),
    interpUrl: interpUrl(event, dream.id),
    unsubscribeUrl: unsubscribeUrl
  });

  var idempotencyKey = 'interp-none-email:' + operationName;

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
      console.error('interp-none-email-sender: Resend rejected the send', res.status);
      await interpEmailStore.releaseNone(event, operationName, guard.claimId);
      await reportSkip(username, email, 'resend_rejected');
      return { ok: true, sent: false, skipped: 'resend_rejected' };
    }
  } catch (sendErr) {
    console.error('interp-none-email-sender: Resend send failed (non-fatal)', sendErr);
    await interpEmailStore.releaseNone(event, operationName, guard.claimId);
    await reportSkip(username, email, 'resend_network_failure');
    return { ok: true, sent: false, skipped: 'resend_network_failure' };
  }

  try {
    await posthogCapture.captureEvent({
      event: 'interp_none_email_sent',
      distinct_id: username,
      properties: { has_dream_text: !!dreamText }
    });
  } catch (e) { /* analytics must never break the app */ }

  var pushSent = await sendPush(event, {
    operationName: operationName, username: username, dreamId: dream.id, dreamText: dreamText
  });

  return { ok: true, sent: true, pushSent: pushSent };
}

/**
 * PREVIEW send (owner-gated at the handler): composes the SAME email with a
 * realistic sample dream text and sends it to an explicit address, bypassing
 * selection, the founder/test exclusion, the suppression list, AND the once-
 * per-dream marker. EMAIL ONLY.
 */
async function sendPreview(event, previewEmail) {
  var resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return { ok: false, error: 'no_resend_key' };
  var unsubscribeUrl = unsubscribeToken.buildUnsubscribeUrl(event, previewEmail);
  var html = buildHtml({
    event: event,
    dreamText: 'I was flying over a city made of glass and the streets kept rearranging beneath me',
    // A real, reachable sample still so the founder actually sees the media
    // banner render (no per-recipient dream exists in a preview).
    imageUrl: emailLayout.brandedFallbackImageUrl(event),
    // A PREVIEW has no real recipient dream, so a per-dream result.html?id=…
    // link would dead-end to explore (the exact thing the founder flagged).
    // Point the preview CTA at the reachable Dream Meaning entry (home.html)
    // instead — never explore. REAL sends use the per-dream deep link above.
    interpUrl: siteOrigin.emailOrigin(event) + '/home.html',
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
  dreamDescription,
  truncate,
  SUBJECT_LINE,
  FROM_ADDRESS,
  BODY_TEXT_MAX
};
