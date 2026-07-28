// netlify/functions/lib/first-dream-email-sender.js
//
// Shared "idempotency guard + actually send the Resend email" core for the
// first-dream RETENTION email (tracker.html's
// for-product-retention-email-send-user-th-eke9ra item, then
// for-product-activate-automatic-retention-4n74rw). Extracted so the SAME
// guarded send logic runs identically from BOTH of this feature's two
// trigger points, which resolve identity in completely different ways but
// must never be able to race each other into a double-send:
//   - send-first-dream-email.js — the original, client-triggered endpoint
//     (still called from result.html's/explore.html's own
//     markFirstVideoCreatedIfEligible-gated call sites), which resolves
//     identity via a real password re-check against a client-CLAIMED
//     username (see that file's own header comment for why a password is
//     required there).
//   - mark-generation-completed.js — the new automatic path, which
//     resolves identity via lib/job-owners.js's server-issued
//     operationName -> email binding, recorded at generation-SUBMISSION
//     time, completely independent of anything the client claims at
//     completion time (no password needed, since nothing client-supplied
//     is trusted for identity on that path at all).
// Both call sites must have ALREADY resolved a real, verified
// (username, email) pair before calling sendIfEligible below — this
// module trusts that completely and does no identity verification of its
// own; it owns only the "have we already sent this account's one email
// ever, and if not, actually send it" logic, via
// lib/first-dream-email-store.js's atomic markSentOnce guard (checked
// FIRST, before any send attempt — see that file's own header comment for
// why this is now race-safe under two near-simultaneous callers, not just
// a plain check-then-act).
//
// THE LINK (changed 2026-07-27, founder decision — "link should bring
// them back to their video/profile... link to their profile page"): this
// used to mint a lib/dream-share-token.js one-time-to-mint,
// many-times-viewable watch.html link (an unauthenticated view of that ONE
// specific, possibly-still-private dream). That's gone now — the CTA
// links straight at this account's own profile.html instead. This is a
// meaningful simplification, not just a URL swap: profile.html is an
// already-authenticated app page (it reads state.user out of this
// device's own localStorage, same as every other page), so it needs no
// per-dream token/session-carrying mechanism at all — a plain
// `https://<host>/profile.html` URL is exactly "whatever direct-URL
// mechanism this already uses" elsewhere in this codebase (see
// dream-webhook.js's own plain-URL links for its separate, pre-signup
// "your dream is ready" email). If the email's recipient isn't logged in
// on whatever device clicks the link, profile.html's own existing login
// gate handles that exactly like any other direct link into the app
// would — not something this feature needs to solve itself.
//
// Content is best-effort/optional (caption/style), same "trust the client
// for non-identity CONTENT, never for identity" split this codebase
// already establishes elsewhere (see send-first-dream-email.js's own
// header comment) — the automatic path has no caption/style available at
// its choke point (mark-generation-completed.js only ever independently
// re-verifies a job's COMPLETION status, deliberately never fetches the
// full result payload — see that file's own header comment on why), so it
// calls this with neither, and gets the generic copy below instead of a
// personalized one. That's an accepted, deliberate scope trade for this
// task, not an oversight — keeping mark-generation-completed.js's own
// request contract from processing.html completely unchanged (still just
// `{ operationName }`) means this automatic send needs no new client-
// trusted input at all at that exact choke point.
//
// PostHog event: fires 'first_dream_email_sent' server-side (via
// lib/posthog-capture.js, the same server-side-capture pattern
// dodo-webhook.js's firePurchaseConversion already established for
// exactly this "the true source of truth is a server event, not a
// browser page load" reason) — ONLY on an actual successful send (never
// on a skip/no-op), so Growth can measure day-1 -> day-2+ return-rate
// lift off a real "this account was actually emailed" signal, not a mere
// "eligibility was checked" one. distinct_id is the account's raw
// username, matching posthog-capture.js's own documented discipline.

var firstDreamEmailStore = require('./first-dream-email-store');
var posthogCapture = require('./posthog-capture');

var RESEND_API_BASE = 'https://api.resend.com/emails';
// Deliberately duplicated from dream-webhook.js's own identical constant —
// see send-first-dream-email.js's own header comment on why (small,
// self-contained per-file/per-lib constants are this codebase's own
// established convention over one shared constants module).
var FROM_ADDRESS = 'DreamTube <onboarding@resend.dev>';

// Same style -> color mapping as js/store.js's STYLE_GRADIENTS, flattened
// to a single flat hex for an email client — see send-first-dream-email.js's
// original header comment (this table moved here unchanged) for why a flat
// color stands in for a real video-frame thumbnail.
var STYLE_COLORS = {
  Cartoon: '#FFB199',
  Cinematic: '#22405c',
  Anime: '#9F8FFF',
  Realistic: '#2A2F4A'
};
function colorForStyle(style) {
  return STYLE_COLORS[style] || STYLE_COLORS.Cinematic;
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function profileUrl(event) {
  var host = (event && event.headers && (event.headers['x-forwarded-host'] || event.headers.host)) || '';
  return 'https://' + host + '/profile.html';
}

function buildHtml(opts) {
  var bannerColor = colorForStyle(opts.style);
  // COPY FIX (tracker.html's for-product-bug-founder-affects-all-funn-
  // 0efe7t, gap #5): this used to read "Your first dream is ready to
  // watch." here, but the ONLY guard behind this send is
  // lib/first-dream-email-store.js's markSentOnce -- "has THIS account
  // ever gotten this email before", not "is this account's dream actually
  // its first ever" -- and the automatic path (mark-generation-completed.js)
  // never has a caption to fall back on (see this file's own header
  // comment on why), so it hits this exact branch every time. A legacy
  // account with prior dreams that simply hadn't triggered this email
  // before (e.g. it predates this feature, or its earlier dreams never
  // got a job-owners record) would get told this is its "first" dream,
  // which may well be false. Adding a REAL first-ness check would mean
  // this choke point fetching the account's full dream history just to
  // word one sentence -- a real cost for a cosmetic detail. Picked the
  // smaller, more consistent fix instead: drop the "first" claim and keep
  // this generic, matching the caption-present branch right above (which
  // already never says "first" either) and the email's own subject line
  // ("Your dream is ready -- here's your video").
  var readyLine = opts.caption
    ? 'Your dream is ready to watch: <b>' + esc(opts.caption) + '</b>'
    : 'Your dream is ready to watch.';
  return (
    '<div style="max-width:480px;margin:0 auto;font-family:sans-serif;">' +
    '<div style="height:160px;border-radius:14px;background:' + bannerColor + ';margin-bottom:18px;"></div>' +
    '<p style="font-size:16px;">' + readyLine + '</p>' +
    '<p><a href="' + opts.profileUrl + '" style="display:inline-block;padding:12px 22px;background:#000;color:#fff;border-radius:24px;text-decoration:none;font-weight:600;">View my dreams</a></p>' +
    '<p style="color:#666;font-size:13px;">Loved it? <a href="' + opts.createUrl + '">Make another dream</a> — it only takes a minute.</p>' +
    '</div>'
  );
}

/**
 * Fires 'first_dream_email_skipped' server-side for every no-op/failure
 * branch below (tracker.html's for-product-bug-founder-affects-all-funn-
 * 0efe7t item, gap #6: "every skip reason in the email chain is invisible
 * -- console.log only"). Same fire-and-forget discipline as the
 * 'first_dream_email_sent' event this file already fires -- best-effort,
 * never throws, never affects the caller's own return value. `username`
 * may be null (e.g. the missing_identity branch, which by definition has
 * no verified username) -- falls back to whatever identifying string IS
 * on hand (an email, or 'unknown'), same distinct_id-fallback precedent
 * video-status.js's refundAndReport already establishes for a
 * PostHog fire that needs to happen even without a resolved account.
 */
async function reportSkip(username, email, reason, auto) {
  try {
    await posthogCapture.captureEvent({
      event: 'first_dream_email_skipped',
      distinct_id: username || email || 'unknown',
      properties: { reason: reason, auto: !!auto }
    });
  } catch (e) { /* analytics must never break the app */ }
}

/**
 * Guarded send: checks (and atomically claims) firstDreamEmailStore's
 * per-account "already sent" flag BEFORE attempting anything, sends via
 * Resend only if this call actually won that claim, and best-effort fires
 * the 'first_dream_email_sent' PostHog event ONLY on an actual, accepted
 * send. Never throws — every failure mode (guard loss, no Resend key
 * configured, Resend itself rejecting the send) resolves normally.
 *
 * `opts`:
 *   username  (required) — already-verified account username (lowercase
 *             or not, normalized internally by the guard)
 *   email     (required) — the account's own real, server-resolved
 *             email address (never a client-claimed one — see this
 *             file's own header comment on why callers must resolve this
 *             themselves before calling in)
 *   dreamId   (optional) — purely for the guard's own bookkeeping record
 *   caption/style (optional) — cosmetic personalization only, see header
 *             comment on why the automatic path omits these
 *
 * Returns { ok:true, sent:true } ONLY when Resend actually accepted the
 * send, or { ok:true, sent:false, skipped:<reason> } for every other case
 * (already sent, no RESEND_API_KEY, missing identity, or Resend itself
 * rejecting/failing the request) — this function itself never signals
 * failure to its caller; every caller here treats this as best-effort,
 * exactly like the rest of this codebase's other analytics-adjacent/
 * notification sends. A 'first_dream_email_skipped' PostHog event fires
 * for every one of these skip/failure reasons too (see reportSkip above)
 * — this used to be genuinely invisible (console.log only).
 *
 * RESEND-FAILURE FIX (tracker.html's for-product-bug-founder-affects-all-
 * funn-0efe7t item, gap #6): a Resend 4xx/network failure used to still
 * return `sent:true` AND leave the guard's one-time-ever marker burned —
 * meaning a real account whose send genuinely failed would never get a
 * legitimate retry (the marker already said "sent") and callers reporting
 * on this return value would believe an email went out that never did.
 * Both are wrong: the guard is now released (firstDreamEmailStore.
 * releaseFailedSend) on any non-2xx/network failure, and this reports
 * sent:false / skipped:'resend_rejected'|'resend_network_failure' instead
 * — a later attempt (a regenerate, or the client-triggered fallback) can
 * genuinely succeed where this one didn't.
 */
async function sendIfEligible(event, opts) {
  opts = opts || {};
  var username = opts.username;
  var email = opts.email;
  if (!username || !email) {
    await reportSkip(username, email, 'missing_identity', opts.auto);
    return { ok: true, sent: false, skipped: 'missing_identity' };
  }

  var guard = await firstDreamEmailStore.markSentOnce(event, username, opts.dreamId);
  if (!guard.ok) {
    var guardReason = guard.alreadySent ? 'already_sent' : (guard.error || 'guard_failed');
    await reportSkip(username, email, guardReason, opts.auto);
    return { ok: true, sent: false, skipped: guardReason };
  }

  var resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    console.log('first-dream-email-sender: RESEND_API_KEY not configured -- skipping send for ' + username);
    // The guard was already won above (a real, singular claim of this
    // account's one-time-ever email) — but with no key configured, no
    // send was even attempted, let alone one that could later succeed on
    // retry once RESEND_API_KEY IS configured, so this is released too,
    // same as an actual Resend failure below (a config gap must not
    // permanently burn a real account's one and only send).
    await firstDreamEmailStore.releaseFailedSend(event, username, guard.claimId);
    await reportSkip(username, email, 'no_resend_key', opts.auto);
    return { ok: true, sent: false, skipped: 'no_resend_key' };
  }

  var host = (event && event.headers && (event.headers['x-forwarded-host'] || event.headers.host)) || '';
  var html = buildHtml({
    caption: opts.caption,
    style: opts.style,
    profileUrl: profileUrl(event),
    createUrl: 'https://' + host + '/create.html'
  });

  try {
    var res = await fetch(RESEND_API_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + resendKey },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: [email],
        subject: "Your dream is ready — here's your video",
        html: html
      })
    });
    if (!res.ok) {
      console.error('first-dream-email-sender: Resend rejected the send', res.status);
      // See "RESEND-FAILURE FIX" above — release the claim so a later
      // attempt can genuinely retry, rather than reporting a send that
      // never happened.
      await firstDreamEmailStore.releaseFailedSend(event, username, guard.claimId);
      await reportSkip(username, email, 'resend_rejected', opts.auto);
      return { ok: true, sent: false, skipped: 'resend_rejected' };
    }
  } catch (sendErr) {
    console.error('first-dream-email-sender: Resend send failed (non-fatal)', sendErr);
    await firstDreamEmailStore.releaseFailedSend(event, username, guard.claimId);
    await reportSkip(username, email, 'resend_network_failure', opts.auto);
    return { ok: true, sent: false, skipped: 'resend_network_failure' };
  }

  // Fire-and-forget, best-effort -- see header comment. Only fired for an
  // ACCEPTED send (Resend returned 2xx above) -- see "RESEND-FAILURE FIX"
  // for why this is no longer "count the attempt regardless of vendor
  // confirmation" for this specific event (a rejected/failed attempt now
  // reports via reportSkip's 'resend_rejected'/'resend_network_failure'
  // instead, and releases the guard so it can be reattempted).
  try {
    await posthogCapture.captureEvent({
      event: 'first_dream_email_sent',
      distinct_id: username,
      properties: { auto: !!opts.auto }
    });
  } catch (e) { /* analytics must never break the app */ }

  return { ok: true, sent: true };
}

module.exports = { sendIfEligible, buildHtml, profileUrl };
