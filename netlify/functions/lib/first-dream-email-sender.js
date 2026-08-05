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
// REAL THUMBNAIL (added 2026-08-02, tracker item
// for-product-dream-ready-email-real-first-qr9fbj, founder request — a
// real first-frame image instead of the flat STYLE_COLORS banner below):
// `opts.imageUrl` is the SAME best-effort/optional-content class as
// caption/style above, not identity — an account's own dream.imageUrl
// (see js/store.js's DreamStore.saveThumbnailBestEffort for how that
// field gets populated: result.html captures the video element's own
// first real frame to a <canvas> client-side and uploads it, since
// there's no thumbnail field anywhere in fal's veo3.1 result payload and
// a second paid fal image-generation call per video isn't worth it for a
// cosmetic email detail). buildHtml falls back to the flat-color banner
// whenever it's absent.
//
// CORRECTED (2026-08-04, same tracker item's founder-approved thumbnail-
// gating follow-up): this paragraph used to say the automatic path
// (mark-generation-completed.js) "has no dreamId at all... so it has no
// way to look up a dream's imageUrl even when one exists" and therefore
// ALWAYS fell back to the flat-color banner in practice. That's no longer
// true — mark-generation-completed.js no longer calls sendIfEligible
// directly at all; it only enqueues (lib/first-dream-email-pending-
// store.js's markPending), and send-pending-first-dream-emails.js's
// scheduled scan is what actually calls this function, after resolving a
// real dreamId/imageUrl (via lib/dream-store.js, once the client's own
// thumbnail capture has synced) whenever one is available within the
// founder's 3-minute window — see that file's own header comment for the
// full mechanism. The flat-color banner is still the deliberate, honest
// fallback for whenever no thumbnail lands within that window (client
// never reached result.html, capture failed, sync never landed, etc.) —
// this template is NOT dead code, it's the one path that intentionally
// still reaches it. The client-triggered send-first-dream-email.js path
// (which has the actual dream object on hand at request time) can also
// still realistically supply a real thumbnail, same as before.
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
//
// PROVIDER-SIDE IDEMPOTENCY (added 2026-08-05, tracker item
// for-product-triple-first-dream-email-fou-2pyopo, ask #1): the founder's
// own fresh signup got THREE of this exact email ~2 minutes apart (a
// second account got 2) despite firstDreamEmailStore.markSentOnce's CAS
// guard already being the strongest dedup primitive this codebase has —
// diagnosed as the CAS decision itself being made against a stale Blobs
// replica during a real consistency-degradation event. The actual Resend
// fetch() call below now also carries a stable, deterministic
// `Idempotency-Key` header (Resend's own dedup primitive, enforced
// provider-side, independent of anything our own storage layer believes)
// — see that call site's own comment for the exact key derivation and its
// justification. This is belt-and-suspenders ON TOP of markSentOnce, not a
// replacement for it — the CAS guard is still what stops the overwhelming
// majority of duplicate attempts (and the ONLY thing that saves the Resend
// API request itself), the Idempotency-Key is what survives the guard
// lying.

var firstDreamEmailStore = require('./first-dream-email-store');
var posthogCapture = require('./posthog-capture');
var emailSuppressionStore = require('./email-suppression-store');
var unsubscribeToken = require('./unsubscribe-token');
var emailLayout = require('./email-layout');
var siteOrigin = require('./site-origin');

var RESEND_API_BASE = 'https://api.resend.com/emails';
// Deliberately duplicated from dream-webhook.js's own identical constant —
// see send-first-dream-email.js's own header comment on why (small,
// self-contained per-file/per-lib constants are this codebase's own
// established convention over one shared constants module).
var FROM_ADDRESS = 'DreamTube <dreams@dreamtube.life>';

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
  return siteOrigin.emailOrigin(event) + '/profile.html';
}

/** This email's "Make another dream" link, on the same resolved public origin as everything else in the body. */
function createUrl(event) {
  return siteOrigin.emailOrigin(event) + '/create.html';
}

/**
 * Resolves `url` (a dream's imageUrl, which may be a relative durable
 * `/.netlify/functions/image-file?key=...` url — see lib/media-rehost.js's
 * own durableUrl — or an already-absolute one) to something an email
 * client can actually load, which must always be a full https:// url —
 * unlike an in-app <img>, an email has no document base url to resolve a
 * relative one against. Returns null (never a broken/relative src) only
 * when there's no url to resolve at all.
 *
 * FIXED (tracker item for-product-bug-two-blank-square-emails--3fvxvc):
 * this used to resolve a relative url against the inbound request's own
 * Host header and give up (return null) when there wasn't one. Under the
 * SCHEDULED sender (send-pending-first-dream-emails.js, the only path that
 * sends this email automatically since commit de124a5) there never is one
 * — so a real, successfully-captured-and-synced thumbnail was silently
 * downgraded to buildHtml's flat-colour fallback banner on every automatic
 * send. Production thumbnails are ALWAYS relative durable urls
 * (upload-dream-thumbnail.js returns lib/media-rehost.js's durableUrl()),
 * so this hit every single one. lib/site-origin.js's emailOrigin always
 * yields a real public origin, so there is no "give up" case left.
 */
function absoluteImageUrl(event, url) {
  if (typeof url !== 'string' || !url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  return siteOrigin.emailOrigin(event) + (url.charAt(0) === '/' ? url : '/' + url);
}

function buildHtml(opts) {
  // Real thumbnail when one's on hand (see this file's own header comment
  // "REAL THUMBNAIL" paragraph) -- falls back to the original flat
  // STYLE_COLORS banner otherwise, same visual weight/footprint (160px
  // tall, same border-radius/margin) so the rest of the email's layout is
  // unaffected either way.
  var media = opts.imageUrl
    ? '<img src="' + esc(opts.imageUrl) + '" width="480" alt="" style="display:block;width:100%;max-width:480px;height:160px;object-fit:cover;border-radius:14px;margin-bottom:18px;" />'
    : '<div style="height:160px;border-radius:14px;background:' + colorForStyle(opts.style) + ';margin-bottom:18px;"></div>';
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
  // DESIGN (tracker item for-product-email-redesign-unsubscribe-l-16ysmp,
  // "elevate the templates toward the product night aesthetic"): the
  // media banner/flat-color-fallback and the profileUrl/createUrl links
  // above are UNCHANGED in shape (same style strings, same href targets)
  // -- only the surrounding chrome (typography color, spacing, the CTA
  // button's visual treatment) moved to lib/email-layout.js's shared
  // night-aesthetic shell + ctaButton helper, wrapped around this same
  // inner content, plus the required unsubscribe/mailing-address footer
  // (opts.unsubscribeUrl, see this file's own sendIfEligible).
  var inner = (
    media +
    '<p style="font-size:16px;line-height:1.5;color:' + emailLayout.COLORS.textPrimary + ';margin:0 0 18px;">' + readyLine + '</p>' +
    '<p style="margin:0 0 16px;">' + emailLayout.ctaButton(opts.profileUrl, 'View my dreams') + '</p>' +
    '<p style="color:' + emailLayout.COLORS.textMuted + ';font-size:13px;margin:0;">Loved it? <a href="' + opts.createUrl + '" style="color:' + emailLayout.COLORS.textMuted + ';">Make another dream</a> — it only takes a minute.</p>'
  );
  return emailLayout.renderShell({
    event: opts.event,
    previewText: readyLine.replace(/<[^>]*>/g, ''),
    bodyHtml: inner,
    unsubscribeUrl: opts.unsubscribeUrl
  });
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
 *   imageUrl  (optional) — cosmetic real-thumbnail content, same class as
 *             caption/style above (see header comment's "REAL THUMBNAIL"
 *             paragraph) — resolved to an absolute url internally
 *             (absoluteImageUrl) before ever reaching buildHtml
 *
 * Returns { ok:true, sent:true } ONLY when Resend actually accepted the
 * send, or { ok:true, sent:false, skipped:<reason> } for every other case
 * (already sent, no RESEND_API_KEY, missing identity, this email having
 * unsubscribed via lib/email-suppression-store.js, or Resend itself
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

  // SUPPRESSION CHECK (tracker item for-product-email-redesign-unsubscribe-
  // l-16ysmp) -- checked BEFORE claiming the once-ever guard below, so an
  // unsubscribed account's guard is never burned for an email that will
  // never send: if this account ever gets a real, working un-suppress path
  // in the future, it stays eligible for its one legitimate first-dream
  // email rather than having silently "used up" its only shot while
  // suppressed.
  var suppressed = await emailSuppressionStore.isSuppressed(event, email);
  if (suppressed) {
    await reportSkip(username, email, 'suppressed', opts.auto);
    return { ok: true, sent: false, skipped: 'suppressed' };
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

  var html = buildHtml({
    event: event,
    caption: opts.caption,
    style: opts.style,
    profileUrl: profileUrl(event),
    createUrl: createUrl(event),
    imageUrl: absoluteImageUrl(event, opts.imageUrl),
    unsubscribeUrl: unsubscribeToken.buildUnsubscribeUrl(event, email)
  });

  // PROVIDER-SIDE IDEMPOTENCY (tracker item
  // for-product-triple-first-dream-email-fou-2pyopo, ask #1 only -- see
  // that item's own comments for the other 3 asks, deliberately not
  // touched here): on 2026-08-05 the founder's own signup got THREE of
  // this exact email ~2 minutes apart, and a second account got 2 --
  // despite firstDreamEmailStore.markSentOnce's CAS guard above already
  // being the strongest dedup primitive this codebase has (a real
  // conditional write, no read/verify race window). The tracker item's
  // own diagnosis: the CAS decision itself was made against a stale
  // Blobs replica during a real consistency-degradation event, so a
  // storage-side dedup marker alone is not sufficient during degradation
  // -- this send needs a dedup mechanism the PROVIDER enforces
  // independently of our own storage layer, as belt-and-suspenders.
  //
  // Resend's API supports a request-level `Idempotency-Key` header on
  // POST /emails (confirmed 2026-08-05 against Resend's own current docs
  // -- resend.com/docs/api-reference/emails/send-email and
  // resend.com/docs/dashboard/emails/idempotency-keys -- via this
  // sandbox's live web access; NOT verified against a real Resend
  // account/dashboard, since there is no real RESEND_API_KEY here. Per
  // those docs: keys are honored for 24h, up to 256 chars, and a key
  // reused with a DIFFERENT request payload gets rejected with 409
  // invalid_idempotent_request rather than sent -- which the `!res.ok`
  // branch below already treats as a safe non-send failure and releases
  // our own guard for a legitimate retry, so that edge case degrades
  // safely rather than double-sending. A future engineer with real
  // Resend access should spot-check this against Resend's dashboard once
  // real traffic exercises it.)
  //
  // KEY DERIVATION: firstDreamEmailStore's own normalizeUsername(username)
  // -- the EXACT SAME key markSentOnce's CAS write above already claims
  // against, not a new identity concept. This codebase already treats
  // normalized username as the canonical identity of "this account's
  // one-time-ever first-dream email" (see first-dream-email-store.js's
  // own header comment: the flag is per-ACCOUNT, not per-dream, so a
  // second call for a different dreamId is still logically the same
  // send). Reusing it here means both dedup layers agree on what "the
  // same send" means by construction. Deliberately NOT guard.claimId --
  // markSentOnce mints that fresh via crypto.randomUUID() on every call,
  // so it's the opposite of stable and would defeat the entire point (two
  // duplicate attempts for the same event must compute the SAME key so
  // Resend itself collapses them). Namespaced with a 'first-dream-email:'
  // prefix per Resend's own documented convention (event-type + entity-id,
  // e.g. their own 'order-sent-12345678' example) since Idempotency-Key is
  // a flat namespace across this whole Resend account, not scoped to one
  // template.
  var idempotencyKey = 'first-dream-email:' + firstDreamEmailStore.normalizeUsername(username);

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

module.exports = { sendIfEligible, buildHtml, profileUrl, createUrl, absoluteImageUrl };
