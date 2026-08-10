// netlify/functions/lib/unwatched-dream-nudge-sender.js
//
// The guarded "actually send the unwatched-dream retention nudge via
// Resend" core (founder-approved retention plan, piece 1 — see
// send-unwatched-dream-nudges.js's header comment for the full feature and
// the scan that calls this). Structured exactly like
// lib/first-dream-email-sender.js (the automatic FIRST-dream email's own
// guarded sender): a once-per-dream CAS guard claimed BEFORE any send, the
// suppression list honored, best-effort PostHog telemetry on send/skip, and
// a provider-side Resend Idempotency-Key as belt-and-suspenders. The scan
// (send-unwatched-dream-nudges.js) has already decided this dream is ready,
// unviewed, past the 7-minute floor, and has a real thumbnail before ever
// calling in here — this module owns only "suppress / dedupe / personalize /
// send".
//
// WHAT MAKES EVERY ONE OF THESE EMAILS DIFFERENT (founder ask — relevance +
// spam-fingerprint dilution): the recipient's OWN dream text is embedded in
// both the subject and the body. `dream.storyText || dream.caption` is the
// human-readable, first-person dream description this codebase already
// treats as the canonical thing to show a human (js/store.js's own readers
// use exactly `d.storyText || d.caption`; storyText is the split-out
// human description, caption is the older single field that still serves
// that role for pre-split dreams — see dream-sync.js's DREAM_FIELDS and
// js/store.js's finalizeDream). The engineered generation prompt
// (promptText) is deliberately NOT used — it's machine-facing, not what the
// dreamer wrote.
//
// NO OVERLAP WITH THE OTHER TWO "your dream is ready" EMAILS — a two-sided
// guarantee, since three different sends could each say "your dream is
// ready":
//   1. dream-webhook.js's PRE-SIGNUP abandoned-dream email — excluded
//      upstream, at enqueue: mark-generation-completed.js only enqueues a
//      nudge for a job that resolves to a real REGISTERED account, and skips
//      any funnel-started job whose pre-signup email already sent (its
//      pending-dreams `readyAt` is set) — the exact pendingId/readyAt guard
//      maybeSendAutomaticFirstDreamEmail already uses. So a pre-signup
//      recipient never reaches this sender at all.
//   2. lib/first-dream-email-sender.js's automatic FIRST-dream email —
//      excluded HERE, per dream: if the first-dream email has already been
//      sent for THIS SAME dream (firstDreamEmailStore.getSentRecord's
//      dreamId matches this dream's id), this nudge suppresses itself. The
//      first-dream email is once-ever-per-account and fires on the first
//      video whether or not it was watched; without this check, a user's
//      unwatched FIRST dream would get BOTH emails. For a 2nd+ dream the
//      first-dream email's stored dreamId is a DIFFERENT (earlier) dream, so
//      this nudge is free to send — which is the whole point: the nudge
//      covers every unwatched dream the once-ever first-dream email cannot.
//   3. this nudge's OWN once-per-dream guard (lib/unwatched-dream-nudge-
//      store.js's markNudgedOnce) — never two nudges for one dream.
//
// DELIVERABILITY (founder-approved this round): this send carries the RFC
// 8058 one-click `List-Unsubscribe` + `List-Unsubscribe-Post` headers
// (Gmail/Yahoo's required invisible header for bulk mail), built off the
// same lib/unsubscribe-token.js HMAC token the visible footer link uses, and
// pointed at unsubscribe-email.js (which now also accepts the one-click
// POST). The visible footer unsubscribe link is the shared lib/email-
// layout.js one, now rendered in its small/faint style.

var nudgeStore = require('./unwatched-dream-nudge-store');
var firstDreamEmailStore = require('./first-dream-email-store');
var posthogCapture = require('./posthog-capture');
var emailSuppressionStore = require('./email-suppression-store');
var unsubscribeToken = require('./unsubscribe-token');
var emailLayout = require('./email-layout');
var siteOrigin = require('./site-origin');

var RESEND_API_BASE = 'https://api.resend.com/emails';
// Deliberately duplicated per-file, this codebase's own convention for
// small self-contained constants — see lib/first-dream-email-sender.js's
// header comment.
var FROM_ADDRESS = 'DreamTube <dreams@dreamtube.life>';

// How much of the dream's description goes in the SUBJECT line — long
// enough to be genuinely personal/unique per recipient, short enough that
// the "— come see it" tail survives Gmail's ~70-char subject truncation.
var SUBJECT_TEXT_MAX = 48;
// A generous cap for the BODY quote — enough for a real dream sentence or
// two without letting a pathological multi-paragraph promptText bloat the
// email.
var BODY_TEXT_MAX = 240;

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** The human-readable dream description this codebase already shows humans (js/store.js reads `d.storyText || d.caption`). Trimmed; '' if the dream carries neither (a legacy/edge record) — the caller's copy falls back to the generic line then. */
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
  return slice.replace(/[\s.,;:!?-]+$/, '') + '…';
}

/**
 * Resolves a dream's imageUrl (often a relative durable
 * `/.netlify/functions/image-file?key=...` url) to the absolute https:// url
 * an email client can load. Returns null only when there's no url at all.
 * Same helper/reasoning as lib/first-dream-email-sender.js's absoluteImageUrl
 * (a scheduled invocation has no inbound Host, so this must resolve against
 * lib/site-origin.js's canonical origin, never the request).
 */
function absoluteImageUrl(event, url) {
  if (typeof url !== 'string' || !url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  return siteOrigin.emailOrigin(event) + (url.charAt(0) === '/' ? url : '/' + url);
}

function profileUrl(event) {
  return siteOrigin.emailOrigin(event) + '/profile.html';
}

function subjectLine(description) {
  if (!description) return 'Your dream is ready — come see it';
  return 'Your dream “' + truncate(description, SUBJECT_TEXT_MAX) + '” is ready — come see it';
}

function buildHtml(opts) {
  // A present, absolute https:// thumbnail is guaranteed by the scan's own
  // thumbnail gate before this runs — same shape/style as the first-dream
  // email's own banner.
  var media = '<img src="' + esc(opts.imageUrl) + '" width="480" alt="" style="display:block;width:100%;max-width:480px;height:160px;object-fit:cover;border-radius:14px;margin-bottom:18px;" />';

  var lead = opts.description
    ? 'Your dream <b>“' + esc(truncate(opts.description, BODY_TEXT_MAX)) + '”</b> finished rendering — but you haven’t watched it yet.'
    : 'Your dream finished rendering — but you haven’t watched it yet.';

  var inner = (
    media +
    '<p style="font-size:16px;line-height:1.5;color:' + emailLayout.COLORS.textPrimary + ';margin:0 0 14px;">' + lead + '</p>' +
    '<p style="font-size:15px;line-height:1.5;color:' + emailLayout.COLORS.textMuted + ';margin:0 0 18px;">It’s waiting for you. Take a minute and see how it turned out.</p>' +
    '<p style="margin:0;">' + emailLayout.ctaButton(opts.profileUrl, 'Watch my dream') + '</p>'
  );

  return emailLayout.renderShell({
    event: opts.event,
    previewText: opts.description ? ('“' + truncate(opts.description, 60) + '” is ready to watch.') : 'Your dream is ready to watch.',
    bodyHtml: inner,
    unsubscribeUrl: opts.unsubscribeUrl
  });
}

/** Best-effort skip telemetry, mirroring lib/first-dream-email-sender.js's reportSkip — fires 'unwatched_dream_nudge_skipped', never throws, never affects the return value. */
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
 *   operationName (required) — the dream's server-issued job id; the guard key
 *   username      (required) — verified account username
 *   email         (required) — verified account email
 *   dream         (required) — the resolved private-dream record, carrying
 *                 `id`, `imageUrl` (thumbnail — the scan guarantees it's
 *                 present), and `storyText`/`caption` (the description)
 *
 * Returns { ok:true, sent:true } only when Resend accepted the send, else
 * { ok:true, sent:false, skipped:<reason> } for every other case
 * (suppressed, first-dream-email already covered this dream, already
 * nudged, no thumbnail, no Resend key, Resend rejected/failed). Never
 * throws — best-effort, exactly like the first-dream sender.
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

  // Thumbnail gate (the scan already enforces this, but this is the single
  // choke point so the guarantee lives here too — never claim the once-per-
  // dream guard for a send that can't legitimately go out).
  var absImageUrl = absoluteImageUrl(event, dream && dream.imageUrl);
  if (!absImageUrl) {
    await reportSkip(username, email, 'no_thumbnail');
    return { ok: true, sent: false, skipped: 'no_thumbnail' };
  }

  // Unsubscribed — checked BEFORE claiming the guard, so a suppressed
  // recipient never burns this dream's one-and-only nudge marker.
  var suppressed = await emailSuppressionStore.isSuppressed(event, email);
  if (suppressed) {
    await reportSkip(username, email, 'suppressed');
    return { ok: true, sent: false, skipped: 'suppressed' };
  }

  // OVERLAP with the automatic FIRST-dream email, per THIS dream (see header
  // comment #2): if the first-dream email already went out for this exact
  // dream, don't also nudge it. Checked BEFORE claiming the guard so a
  // suppressed-by-overlap dream stays un-marked (harmless, but keeps the
  // marker's meaning honest: "we actually nudged this dream").
  try {
    var firstDreamRecord = await firstDreamEmailStore.getSentRecord(event, username);
    if (firstDreamRecord && dream && firstDreamRecord.dreamId && firstDreamRecord.dreamId === dream.id) {
      await reportSkip(username, email, 'first_dream_email_already_sent');
      return { ok: true, sent: false, skipped: 'first_dream_email_already_sent' };
    }
  } catch (e) {
    // A read blip here must not double-send; fail toward NOT sending (the
    // safer direction for an anti-double-send check), same fail-closed
    // spirit as the guards around it.
    console.error('unwatched-dream-nudge-sender: first-dream overlap check failed -- skipping this nudge to avoid a possible double-send', e);
    await reportSkip(username, email, 'overlap_check_failed');
    return { ok: true, sent: false, skipped: 'overlap_check_failed' };
  }

  // Once-per-dream claim — the real "exactly one nudge per dream" guarantee.
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
    // nudge — a config gap must not permanently burn it.
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
    profileUrl: profileUrl(event),
    unsubscribeUrl: unsubscribeUrl
  });

  // Provider-side idempotency (same belt-and-suspenders as lib/first-dream-
  // email-sender.js — see its header comment): a stable key derived from the
  // per-dream identity this nudge is scoped to, so even if the CAS guard
  // above is ever fooled by a stale Blobs replica during a consistency
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
        // — Resend passes documented `headers` straight through onto the
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
