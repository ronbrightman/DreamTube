// netlify/functions/lib/unwatched-dream-nudge-sender.js
//
// The guarded "actually send the unwatched-dream retention nudge via
// Resend" core (founder-approved retention plan, piece 1 &mdash; see
// send-unwatched-dream-nudges.js's header comment for the full feature and
// the scan that calls this). This is now THE single "your dream is ready to
// watch" email this app sends to a signed-up user (founder decision
// 2026-08-11: retire the separate first-dream email entirely and let this
// nudge be the one email per unwatched dream, including a user's FIRST
// dream). A once-per-dream CAS guard claimed BEFORE any send, the
// suppression list honored, best-effort PostHog telemetry on send/skip, and
// a provider-side Resend Idempotency-Key as belt-and-suspenders. The scan
// (send-unwatched-dream-nudges.js) has already decided this dream is ready,
// unviewed, past the 7-minute floor, and has a real thumbnail before ever
// calling in here &mdash; this module owns only "suppress / dedupe / personalize /
// send".
//
// WHAT MAKES EVERY ONE OF THESE EMAILS DIFFERENT (founder ask &mdash; relevance +
// spam-fingerprint dilution): the recipient's OWN dream text is embedded in
// both the subject and the body. `dream.storyText || dream.caption` is the
// human-readable, first-person dream description this codebase already
// treats as the canonical thing to show a human (js/store.js's own readers
// use exactly `d.storyText || d.caption`; storyText is the split-out
// human description, caption is the older single field that still serves
// that role for pre-split dreams &mdash; see dream-sync.js's DREAM_FIELDS and
// js/store.js's finalizeDream). The engineered generation prompt
// (promptText) is deliberately NOT used &mdash; it's machine-facing, not what the
// dreamer wrote.
//
// NO OVERLAP WITH THE OTHER "your dream is ready" EMAIL &mdash; a two-sided
// guarantee, since two different sends could each say "your dream is ready":
//   1. dream-webhook.js's PRE-SIGNUP abandoned-dream email &mdash; excluded
//      upstream, at enqueue: mark-generation-completed.js only enqueues a
//      nudge for a job that resolves to a real REGISTERED account, and skips
//      any funnel-started job whose pre-signup email already sent (its
//      pending-dreams `readyAt` is set) &mdash; the exact pendingId/readyAt guard
//      maybeEnqueueUnwatchedNudge uses. So a pre-signup recipient never
//      reaches this sender at all.
//   2. this nudge's OWN once-per-dream guard (lib/unwatched-dream-nudge-
//      store.js's markNudgedOnce) &mdash; never two nudges for one dream.
//
// (There used to be a THIRD "your dream is ready" send &mdash; the once-ever-per-
// account first-dream email &mdash; which this nudge had to suppress itself for on
// a user's first dream. That email was retired entirely on 2026-08-11 per the
// founder decision above, so this nudge now simply covers every unwatched
// dream, first or later, with no first-dream-email overlap check needed.)
//
// DELIVERABILITY (founder-approved this round): this send carries the RFC
// 8058 one-click `List-Unsubscribe` + `List-Unsubscribe-Post` headers
// (Gmail/Yahoo's required invisible header for bulk mail), built off the
// same lib/unsubscribe-token.js HMAC token the visible footer link uses, and
// pointed at unsubscribe-email.js (which now also accepts the one-click
// POST). The visible footer unsubscribe link is the shared lib/email-
// layout.js one, now rendered in its small/faint style.

var nudgeStore = require('./unwatched-dream-nudge-store');
var resultViewStore = require('./result-view-store');
var posthogCapture = require('./posthog-capture');
var emailSuppressionStore = require('./email-suppression-store');
var unsubscribeToken = require('./unsubscribe-token');
var emailLayout = require('./email-layout');
var siteOrigin = require('./site-origin');
var emailLoginToken = require('./email-login-token');

var RESEND_API_BASE = 'https://api.resend.com/emails';
// Deliberately duplicated per-file (same address dream-webhook.js's own
// sender uses), this codebase's own convention for small self-contained
// per-file constants over one shared constants module.
var FROM_ADDRESS = 'DreamTube <dreams@dreamtube.life>';

// How much of the dream's description goes in the SUBJECT line &mdash; long
// enough to be genuinely personal/unique per recipient, short enough that
// the "&mdash; come see it" tail survives Gmail's ~70-char subject truncation.
var SUBJECT_TEXT_MAX = 48;
// A generous cap for the BODY quote &mdash; enough for a real dream sentence or
// two without letting a pathological multi-paragraph promptText bloat the
// email.
var BODY_TEXT_MAX = 240;

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** The human-readable dream description this codebase already shows humans (js/store.js reads `d.storyText || d.caption`). Trimmed; '' if the dream carries neither (a legacy/edge record) &mdash; the caller's copy falls back to the generic line then. */
function dreamDescription(dream) {
  if (!dream) return '';
  var text = (typeof dream.storyText === 'string' && dream.storyText.trim()) ? dream.storyText
    : (typeof dream.caption === 'string' ? dream.caption : '');
  return String(text || '').trim();
}

/** Truncates on a word boundary where possible, appending an ellipsis only when it actually cut something. */
function truncate(text, max) {
  if (text.length <= max) return text;
  var slice = text.slice(0, max);
  var lastSpace = slice.lastIndexOf(' ');
  if (lastSpace > max * 0.6) slice = slice.slice(0, lastSpace);
  return slice.replace(/[\s.,;:!?-]+$/, '') + '&hellip;';
}

/**
 * Resolves a dream's imageUrl (often a relative durable
 * `/.netlify/functions/image-file?key=...` url) to the absolute https:// url
 * an email client can load. Returns null only when there's no url at all.
 * A scheduled invocation has no inbound Host, so this must resolve against
 * lib/site-origin.js's canonical origin, never the request.
 */
function absoluteImageUrl(event, url) {
  if (typeof url !== 'string' || !url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  return siteOrigin.emailOrigin(event) + (url.charAt(0) === '/' ? url : '/' + url);
}

function profileUrl(event) {
  return siteOrigin.emailOrigin(event) + '/profile.html';
}

/**
 * The one-tap login CTA target (founder 2026-08-15 "make the recovery emails
 * auto-login"): the email-login.js endpoint carrying a single-use, 7-day
 * lib/email-login-token.js token, landing (after that endpoint mints a fresh
 * ?bt= and redirects) on /profile.html signed in with the finished video
 * attached. Falls back to a plain /profile.html link only if minting fails —
 * a token-store hiccup must never stop the "your dream is ready" email.
 */
async function loginProfileUrl(event, username, email) {
  try {
    var token = await emailLoginToken.createToken(event, username, email);
    return siteOrigin.emailOrigin(event) + '/.netlify/functions/email-login?elt=' +
      encodeURIComponent(token) + '&dest=' + encodeURIComponent('/profile.html');
  } catch (e) {
    return profileUrl(event);
  }
}

function subjectLine(description) {
  if (!description) return 'Your dream is ready &mdash; come see it';
  return 'Your dream &ldquo;' + truncate(description, SUBJECT_TEXT_MAX) + '&rdquo; is ready &mdash; come see it';
}

function buildHtml(opts) {
  // A present, absolute https:// thumbnail is guaranteed by the scan's own
  // thumbnail gate before this runs.
  var media = '<img src="' + esc(opts.imageUrl) + '" width="480" alt="" style="display:block;width:100%;max-width:480px;height:160px;object-fit:cover;border-radius:14px;margin-bottom:18px;" />';

  var lead = opts.description
    ? 'Your dream <b>&ldquo;' + esc(truncate(opts.description, BODY_TEXT_MAX)) + '&rdquo;</b> finished rendering &mdash; but you haven&rsquo;t watched it yet.'
    : 'Your dream finished rendering &mdash; but you haven&rsquo;t watched it yet.';

  var inner = (
    media +
    '<p style="font-size:16px;line-height:1.5;color:' + emailLayout.COLORS.textPrimary + ';margin:0 0 14px;">' + lead + '</p>' +
    '<p style="font-size:15px;line-height:1.5;color:' + emailLayout.COLORS.textMuted + ';margin:0 0 18px;">It&rsquo;s waiting for you. Take a minute and see how it turned out.</p>' +
    '<p style="margin:0;">' + emailLayout.ctaButton(opts.profileUrl, 'Watch my dream') + '</p>'
  );

  return emailLayout.renderShell({
    event: opts.event,
    previewText: opts.description ? ('&ldquo;' + truncate(opts.description, 60) + '&rdquo; is ready to watch.') : 'Your dream is ready to watch.',
    bodyHtml: inner,
    unsubscribeUrl: opts.unsubscribeUrl
  });
}

/** Best-effort skip telemetry &mdash; fires 'unwatched_dream_nudge_skipped', never throws, never affects the return value. */
async function reportSkip(username, email, reason) {
  try {
    await posthogCapture.captureEvent({
      event: 'unwatched_dream_nudge_skipped',
      distinct_id: username || email || 'unknown',
      properties: { reason: reason }
    });
  } catch (e) { /* analytics must never break the app */ }
}

/**
 * Guarded send. `opts`:
 *   operationName (required) &mdash; the dream's server-issued job id; the guard key
 *   username      (required) &mdash; verified account username
 *   email         (required) &mdash; verified account email
 *   dream         (required) &mdash; the resolved private-dream record, carrying
 *                 `id`, `imageUrl` (thumbnail &mdash; the scan guarantees it's
 *                 present), and `storyText`/`caption` (the description)
 *
 * Returns { ok:true, sent:true } only when Resend accepted the send, else
 * { ok:true, sent:false, skipped:<reason> } for every other case
 * (suppressed, already nudged, no thumbnail, no Resend key, Resend
 * rejected/failed). Never throws &mdash; best-effort.
 */
async function sendIfEligible(event, opts) {
  opts = opts || {};
  var operationName = opts.operationName;
  var username = opts.username;
  var email = opts.email;
  var dream = opts.dream;
  if (!operationName || !username || !email) {
    await reportSkip(username, email, 'missing_identity');
    return { ok: true, sent: false, skipped: 'missing_identity' };
  }

  // WATCHED-AWARE RE-CHECK AT SEND TIME (founder complaint 2026-08-10 —
  // "the 'ready to watch' nudge must NOT be sent to a user who has already
  // watched that dream; re-check the watched flag at send time, not just at
  // enqueue time"). send-unwatched-dream-nudges.js's scan already suppresses
  // a viewed dream at its step 1 (BEFORE ever calling in here), but this is
  // the single actual send choke point, so the guarantee lives here too:
  // re-read the viewed marker right before doing anything, closing the narrow
  // window where the user opens the fullscreen player AFTER the scan's step-1
  // read but BEFORE this send, and protecting any future caller that reaches
  // this sender without the scan's own pre-check. Checked BEFORE claiming the
  // once-per-dream guard, exactly like the gates below it, so a suppressed-
  // because-watched nudge never burns this dream's one-and-only marker.
  // Same lib/result-view-store.js marker (keyed by operationName) the scan
  // also consults at its step 1.
  var alreadyViewed = await resultViewStore.hasViewed(event, operationName);
  if (alreadyViewed) {
    await reportSkip(username, email, 'already_viewed');
    return { ok: true, sent: false, skipped: 'already_viewed' };
  }

  // Hero image: the recipient's own dream thumbnail when we have one, else a
  // tasteful branded DREAMSCAPE fallback (emailLayout.brandedFallbackImageUrl).
  // The email is NEVER blocked for lack of a per-dream thumbnail (founder
  // 2026-08-15): a webview leaver's server-persisted dream carries a videoUrl
  // but NO imageUrl (fal's webhook returns no poster, and no client ran to
  // sync a first-frame still), so requiring a thumbnail here silently DROPPED
  // the recovery email for the exact cohort it exists to bring back (2 real
  // users dropped no_thumbnail in one hour before this fix). The dream text
  // still personalizes subject + body; the generic dreamscape hero represents
  // "your dream" without a per-dream still.
  var absImageUrl = absoluteImageUrl(event, dream && dream.imageUrl) || emailLayout.brandedFallbackImageUrl(event);

  // Unsubscribed &mdash; checked BEFORE claiming the guard, so a suppressed
  // recipient never burns this dream's one-and-only nudge marker.
  var suppressed = await emailSuppressionStore.isSuppressed(event, email);
  if (suppressed) {
    await reportSkip(username, email, 'suppressed');
    return { ok: true, sent: false, skipped: 'suppressed' };
  }

  // Once-per-dream claim &mdash; the real "exactly one nudge per dream" guarantee.
  var guard = await nudgeStore.markNudgedOnce(event, operationName, dream && dream.id);
  if (!guard.ok) {
    var guardReason = guard.alreadyNudged ? 'already_nudged' : (guard.error || 'guard_failed');
    await reportSkip(username, email, guardReason);
    return { ok: true, sent: false, skipped: guardReason };
  }

  var resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    console.log('unwatched-dream-nudge-sender: RESEND_API_KEY not configured -- skipping send for ' + username);
    // Release the just-won claim: no send was attempted, so a later run
    // (once RESEND_API_KEY IS set) must still be able to send this dream's
    // nudge &mdash; a config gap must not permanently burn it.
    await nudgeStore.releaseFailedNudge(event, operationName, guard.claimId);
    await reportSkip(username, email, 'no_resend_key');
    return { ok: true, sent: false, skipped: 'no_resend_key' };
  }

  var description = dreamDescription(dream);
  var unsubscribeUrl = unsubscribeToken.buildUnsubscribeUrl(event, email);
  var html = buildHtml({
    event: event,
    description: description,
    imageUrl: absImageUrl,
    profileUrl: await loginProfileUrl(event, username, email),
    unsubscribeUrl: unsubscribeUrl
  });

  // Provider-side idempotency (belt-and-suspenders): a stable key derived
  // from the per-dream identity this nudge is scoped to, so even if the CAS
  // guard above is ever fooled by a stale Blobs replica during a consistency
  // degradation, Resend itself collapses the duplicate. Keyed by
  // operationName (the guard's own key), namespaced per Resend's documented
  // event-type + entity-id convention.
  var idempotencyKey = 'unwatched-dream-nudge:' + operationName;

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
        subject: subjectLine(description),
        html: html,
        // RFC 8058 one-click unsubscribe (Gmail/Yahoo bulk-mail requirement)
        // &mdash; Resend passes documented `headers` straight through onto the
        // outbound message. Same token/endpoint as the visible footer link.
        headers: {
          'List-Unsubscribe': '<' + unsubscribeUrl + '>',
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
        }
      })
    });
    if (!res.ok) {
      console.error('unwatched-dream-nudge-sender: Resend rejected the send', res.status);
      await nudgeStore.releaseFailedNudge(event, operationName, guard.claimId);
      await reportSkip(username, email, 'resend_rejected');
      return { ok: true, sent: false, skipped: 'resend_rejected' };
    }
  } catch (sendErr) {
    console.error('unwatched-dream-nudge-sender: Resend send failed (non-fatal)', sendErr);
    await nudgeStore.releaseFailedNudge(event, operationName, guard.claimId);
    await reportSkip(username, email, 'resend_network_failure');
    return { ok: true, sent: false, skipped: 'resend_network_failure' };
  }

  try {
    await posthogCapture.captureEvent({
      event: 'unwatched_dream_nudge_sent',
      distinct_id: username,
      properties: { has_description: !!description }
    });
  } catch (e) { /* analytics must never break the app */ }

  return { ok: true, sent: true };
}

module.exports = { sendIfEligible, buildHtml, subjectLine, dreamDescription, absoluteImageUrl, SUBJECT_TEXT_MAX, BODY_TEXT_MAX };
