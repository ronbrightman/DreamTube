// netlify/functions/lib/first-dream-email-sender.js
//
// Shared "idempotency guard + actually send the Resend email" core for the
// first-dream RETENTION email (tracker.html's
// for-product-retention-email-send-user-th-eke9ra item, then
// for-product-activate-automatic-retention-4n74rw). Extracted so the SAME
// guarded send logic runs identically from BOTH of this feature's two
// trigger points, which resolve identity in completely different ways but
// must never be able to race each other into a double-send:
//   - send-first-dream-email.js &mdash; the original, client-triggered endpoint
//     (still called from result.html's/explore.html's own
//     markFirstVideoCreatedIfEligible-gated call sites), which resolves
//     identity via a real password re-check against a client-CLAIMED
//     username (see that file's own header comment for why a password is
//     required there).
//   - mark-generation-completed.js &mdash; the new automatic path, which
//     resolves identity via lib/job-owners.js's server-issued
//     operationName -> email binding, recorded at generation-SUBMISSION
//     time, completely independent of anything the client claims at
//     completion time (no password needed, since nothing client-supplied
//     is trusted for identity on that path at all).
// Both call sites must have ALREADY resolved a real, verified
// (username, email) pair before calling sendIfEligible below &mdash; this
// module trusts that completely and does no identity verification of its
// own; it owns only the "have we already sent this account's one email
// ever, and if not, actually send it" logic, via
// lib/first-dream-email-store.js's atomic markSentOnce guard (checked
// FIRST, before any send attempt &mdash; see that file's own header comment for
// why this is now race-safe under two near-simultaneous callers, not just
// a plain check-then-act).
//
// THE LINK (changed 2026-07-27, founder decision &mdash; "link should bring
// them back to their video/profile... link to their profile page"): this
// used to mint a lib/dream-share-token.js one-time-to-mint,
// many-times-viewable watch.html link (an unauthenticated view of that ONE
// specific, possibly-still-private dream). That's gone now &mdash; the CTA
// links straight at this account's own profile.html instead. This is a
// meaningful simplification, not just a URL swap: profile.html is an
// already-authenticated app page (it reads state.user out of this
// device's own localStorage, same as every other page), so it needs no
// per-dream token/session-carrying mechanism at all &mdash; a plain
// `https://<host>/profile.html` URL is exactly "whatever direct-URL
// mechanism this already uses" elsewhere in this codebase (see
// dream-webhook.js's own plain-URL links for its separate, pre-signup
// "your dream is ready" email). If the email's recipient isn't logged in
// on whatever device clicks the link, profile.html's own existing login
// gate handles that exactly like any other direct link into the app
// would &mdash; not something this feature needs to solve itself.
//
// Content is best-effort/optional (caption), same "trust the client for
// non-identity CONTENT, never for identity" split this codebase already
// establishes elsewhere (see send-first-dream-email.js's own header
// comment) &mdash; the automatic path has no caption available at its choke
// point (mark-generation-completed.js only ever independently re-verifies a
// job's COMPLETION status, deliberately never fetches the full result
// payload &mdash; see that file's own header comment on why), so it calls this
// without one, and gets the generic copy below instead of a personalized
// one. That's an accepted, deliberate scope trade for this task, not an
// oversight &mdash; keeping mark-generation-completed.js's own request contract
// from processing.html completely unchanged (still just `{ operationName }`)
// means this automatic send needs no new client-trusted input at all at
// that exact choke point. (`style` used to be passed too, for the flat-
// color fallback banner's tint &mdash; that banner is gone now, so style no
// longer affects this email; callers may still pass it harmlessly.)
//
// REAL THUMBNAIL (added 2026-08-02, tracker item
// for-product-dream-ready-email-real-first-qr9fbj, founder request &mdash; a
// real first-frame image): `opts.imageUrl` is an account's own
// dream.imageUrl (see js/store.js's DreamStore.saveThumbnailBestEffort for
// how that field gets populated: result.html captures the video element's
// own first real frame to a <canvas> client-side and uploads it, since
// there's no thumbnail field anywhere in fal's veo3.1 result payload and a
// second paid fal image-generation call per video isn't worth it).
//
// THUMBNAIL-GATED SEND (founder rule 2026-08-08, tracker item
// for-product-p1-regression-evidence-found-7lbwkx follow-up &mdash; "do NOT send
// the email at all until the thumbnail is available"): this email is now
// NEVER sent without a real video thumbnail. The founder received one
// first-dream email WITH a thumbnail and a later one WITHOUT (just the logo
// + button) and ruled that a thumbnail-less send must not happen in the
// normal path. sendIfEligible therefore GATES on a present, valid
// thumbnail (below) BEFORE claiming the once-ever guard, so a not-yet-ready
// send defers instead of going out bare &mdash; and, crucially, doesn't burn the
// account's one-and-only marker, so a later attempt (once the client's
// capture syncs, or the next scheduled scan finds the imageUrl) can still
// send the real thing. Because this is the single choke point BOTH trigger
// paths funnel through, the guarantee lives here once:
//   - the client-triggered send-first-dream-email.js path fires the moment
//     result.html loads, when dream.imageUrl is usually STILL NULL (it
//     loses the race with saveThumbnailBestEffort's upload &mdash; see
//     js/store.js's own comment) &mdash; so that path now simply no-ops here
//     until the capture has synced, rather than sending a bare email;
//   - the automatic path enqueues (mark-generation-completed.js ->
//     lib/first-dream-email-pending-store.js) and
//     send-pending-first-dream-emails.js's scheduled scan retries every
//     minute, sending the moment a thumbnail lands and DROPPING (never
//     sending bare) if none lands within its give-up window &mdash; see that
//     file's own header comment for the full mechanism and the "drop vs.
//     send-anyway" decision.
// The old flat-color STYLE_COLORS fallback banner is consequently gone &mdash;
// it was the exact thing that produced the founder's thumbnail-less email,
// so it's removed rather than left as reachable dead code.
//
// WATCHED-AWARE SUPPRESSION (founder complaint 2026-08-10 &mdash; "I still get
// the email 'your video is ready to watch' even when I DID watch the video;
// make sure only the NEW watched-aware flow is live"): this email's body
// literally says "Your dream is ready to watch.", and it used to be the one
// "your dream is ready" path that sent regardless of whether the user had
// actually watched. It now suppresses (WITHOUT burning the once-ever guard)
// when the dream's operationName has a server-side viewed marker
// (lib/result-view-store.js) &mdash; the SAME marker the unwatched-dream nudge
// already suppresses on &mdash; so no "ready to watch" email of any kind now goes
// out for a dream the user has opened the fullscreen player for. See
// sendIfEligible's own "WATCHED-AWARE SUPPRESSION" inline comment for the
// full reasoning (including why this never causes a double-send with the
// nudge) and opts.operationName's doc for the legacy-dream fall-through.
//
// PostHog event: fires 'first_dream_email_sent' server-side (via
// lib/posthog-capture.js, the same server-side-capture pattern
// dodo-webhook.js's firePurchaseConversion already established for
// exactly this "the true source of truth is a server event, not a
// browser page load" reason) &mdash; ONLY on an actual successful send (never
// on a skip/no-op), so Growth can measure day-1 -> day-2+ return-rate
// lift off a real "this account was actually emailed" signal, not a mere
// "eligibility was checked" one. distinct_id is the account's raw
// username, matching posthog-capture.js's own documented discipline.
//
// PROVIDER-SIDE IDEMPOTENCY (added 2026-08-05, tracker item
// for-product-triple-first-dream-email-fou-2pyopo, ask #1): the founder's
// own fresh signup got THREE of this exact email ~2 minutes apart (a
// second account got 2) despite firstDreamEmailStore.markSentOnce's CAS
// guard already being the strongest dedup primitive this codebase has &mdash;
// diagnosed as the CAS decision itself being made against a stale Blobs
// replica during a real consistency-degradation event. The actual Resend
// fetch() call below now also carries a stable, deterministic
// `Idempotency-Key` header (Resend's own dedup primitive, enforced
// provider-side, independent of anything our own storage layer believes)
// &mdash; see that call site's own comment for the exact key derivation and its
// justification. This is belt-and-suspenders ON TOP of markSentOnce, not a
// replacement for it &mdash; the CAS guard is still what stops the overwhelming
// majority of duplicate attempts (and the ONLY thing that saves the Resend
// API request itself), the Idempotency-Key is what survives the guard
// lying.

var firstDreamEmailStore = require('./first-dream-email-store');
var posthogCapture = require('./posthog-capture');
var emailSuppressionStore = require('./email-suppression-store');
var resultViewStore = require('./result-view-store');
var unsubscribeToken = require('./unsubscribe-token');
var emailLayout = require('./email-layout');
var siteOrigin = require('./site-origin');

var RESEND_API_BASE = 'https://api.resend.com/emails';
// Deliberately duplicated from dream-webhook.js's own identical constant &mdash;
// see send-first-dream-email.js's own header comment on why (small,
// self-contained per-file/per-lib constants are this codebase's own
// established convention over one shared constants module).
var FROM_ADDRESS = 'DreamTube <dreams@dreamtube.life>';

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
 * `/.netlify/functions/image-file?key=...` url &mdash; see lib/media-rehost.js's
 * own durableUrl &mdash; or an already-absolute one) to something an email
 * client can actually load, which must always be a full https:// url &mdash;
 * unlike an in-app <img>, an email has no document base url to resolve a
 * relative one against. Returns null (never a broken/relative src) only
 * when there's no url to resolve at all.
 *
 * FIXED (tracker item for-product-bug-two-blank-square-emails--3fvxvc):
 * this used to resolve a relative url against the inbound request's own
 * Host header and give up (return null) when there wasn't one. Under the
 * SCHEDULED sender (send-pending-first-dream-emails.js, the only path that
 * sends this email automatically since commit de124a5) there never is one
 * &mdash; so a real, successfully-captured-and-synced thumbnail was silently
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
  // The real video-frame thumbnail. This email is NEVER built (let alone
  // sent) without one now (founder rule 2026-08-08 &mdash; see this file's own
  // "THUMBNAIL-GATED SEND" header paragraph and sendIfEligible's own gate),
  // so there is no flat-color fallback branch here anymore: opts.imageUrl
  // is always a present, absolute https:// url by the time buildHtml runs.
  var media = '<img src="' + esc(opts.imageUrl) + '" width="480" alt="" style="display:block;width:100%;max-width:480px;height:160px;object-fit:cover;border-radius:14px;margin-bottom:18px;" />';
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
    '<p style="color:' + emailLayout.COLORS.textMuted + ';font-size:13px;margin:0;">Loved it? <a href="' + opts.createUrl + '" style="color:' + emailLayout.COLORS.textMuted + ';">Make another dream</a> &mdash; it only takes a minute.</p>'
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
 * send. Never throws &mdash; every failure mode (guard loss, no Resend key
 * configured, Resend itself rejecting the send) resolves normally.
 *
 * `opts`:
 *   username  (required) &mdash; already-verified account username (lowercase
 *             or not, normalized internally by the guard)
 *   email     (required) &mdash; the account's own real, server-resolved
 *             email address (never a client-claimed one &mdash; see this
 *             file's own header comment on why callers must resolve this
 *             themselves before calling in)
 *   dreamId   (optional) &mdash; purely for the guard's own bookkeeping record
 *   caption   (optional) &mdash; cosmetic personalization only, see header
 *             comment on why the automatic path omits it
 *   imageUrl  (REQUIRED for an actual send) &mdash; the dream's real video
 *             thumbnail. Resolved to an absolute url internally
 *             (absoluteImageUrl); if it resolves to nothing, this defers
 *             (skipped:'no_thumbnail') WITHOUT sending or burning the
 *             once-ever guard &mdash; see the header's "THUMBNAIL-GATED SEND"
 *             paragraph
 *   operationName (optional) &mdash; the dream's server-issued job id. When
 *             present, this send is SUPPRESSED (skipped:'already_viewed',
 *             WITHOUT burning the once-ever guard) if the user has already
 *             opened the fullscreen player for this dream &mdash; see the
 *             "WATCHED-AWARE SUPPRESSION" note below and the founder
 *             complaint it closes. Absent (a legacy dream with no
 *             sourceOperationName) &mdash; the check is skipped and this behaves
 *             exactly as before.
 *
 * Returns { ok:true, sent:true } ONLY when Resend actually accepted the
 * send, or { ok:true, sent:false, skipped:<reason> } for every other case
 * (already sent, no thumbnail yet, no RESEND_API_KEY, missing identity,
 * this email having unsubscribed via lib/email-suppression-store.js, or
 * Resend itself rejecting/failing the request) &mdash; this function itself never signals
 * failure to its caller; every caller here treats this as best-effort,
 * exactly like the rest of this codebase's other analytics-adjacent/
 * notification sends. A 'first_dream_email_skipped' PostHog event fires
 * for every one of these skip/failure reasons too (see reportSkip above)
 * &mdash; this used to be genuinely invisible (console.log only).
 *
 * RESEND-FAILURE FIX (tracker.html's for-product-bug-founder-affects-all-
 * funn-0efe7t item, gap #6): a Resend 4xx/network failure used to still
 * return `sent:true` AND leave the guard's one-time-ever marker burned &mdash;
 * meaning a real account whose send genuinely failed would never get a
 * legitimate retry (the marker already said "sent") and callers reporting
 * on this return value would believe an email went out that never did.
 * Both are wrong: the guard is now released (firstDreamEmailStore.
 * releaseFailedSend) on any non-2xx/network failure, and this reports
 * sent:false / skipped:'resend_rejected'|'resend_network_failure' instead
 * &mdash; a later attempt (a regenerate, or the client-triggered fallback) can
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

  // WATCHED-AWARE SUPPRESSION (founder complaint 2026-08-10 &mdash; "I still
  // get the email 'your video is ready to watch' even when I DID watch the
  // video; make sure only the NEW watched-aware flow is live"). This email's
  // own body literally says "Your dream is ready to watch." &mdash; sending it to
  // someone who has already watched is exactly the reported bug. It used to
  // be the one "your dream is ready" path that was NOT watched-aware (the
  // newer unwatched-dream nudge already suppresses a viewed dream at its own
  // scan step 1 &mdash; see send-unwatched-dream-nudges.js). Now both consult the
  // SAME server-side viewed marker (lib/result-view-store.js, keyed by the
  // dream's server-issued operationName, written by mark-result-viewed.js
  // from result.html's fullscreen-open). Checked BEFORE claiming the
  // once-ever guard, exactly like the suppression + thumbnail gates around
  // it, so a suppressed-because-watched send never burns the account's
  // one-and-only marker &mdash; a genuinely-unwatched later dream is still free to
  // claim it (the guard is per account, and the nudge sender's own first-
  // dream-overlap check keys off whichever dream actually claimed it, so this
  // can never produce a double-send &mdash; see lib/unwatched-dream-nudge-
  // sender.js). operationName is optional: a legacy dream with no
  // sourceOperationName can't be viewed-checked, so it falls through
  // unchanged (the dominant automatic path always has one &mdash; the scan is
  // keyed by it). hasViewed fails toward NOT-viewed on a read blip (see its
  // own doc comment), matching this feature's "a wrongly-sent email is
  // bounded by the once-ever guard + unsubscribe, wrongly-suppressing kills
  // the feature" posture &mdash; the same direction the nudge scan degrades.
  if (opts.operationName) {
    var alreadyViewed = await resultViewStore.hasViewed(event, opts.operationName);
    if (alreadyViewed) {
      await reportSkip(username, email, 'already_viewed', opts.auto);
      return { ok: true, sent: false, skipped: 'already_viewed' };
    }
  }

  // THUMBNAIL GATE (founder rule 2026-08-08 &mdash; see this file's own
  // "THUMBNAIL-GATED SEND" header paragraph): never send this email
  // without a real video thumbnail. Checked BEFORE claiming the once-ever
  // guard below, exactly like the suppression check above, so a send that
  // can't legitimately go out yet never BURNS the account's one-time-ever
  // marker &mdash; a later attempt (the client-triggered path once its capture
  // has synced, or send-pending-first-dream-emails.js's next scan once the
  // thumbnail lands) can still succeed. This is the single choke point both
  // trigger paths funnel through, so it's the one place the guarantee has
  // to live. absoluteImageUrl returns null only when there's genuinely no
  // url to show (see its own doc comment), which is precisely "no thumbnail
  // available".
  var absImageUrl = absoluteImageUrl(event, opts.imageUrl);
  if (!absImageUrl) {
    await reportSkip(username, email, 'no_thumbnail', opts.auto);
    return { ok: true, sent: false, skipped: 'no_thumbnail' };
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
    // account's one-time-ever email) &mdash; but with no key configured, no
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
    profileUrl: profileUrl(event),
    createUrl: createUrl(event),
    imageUrl: absImageUrl,
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
  // safely rather than double-sending.
  //
  // SECOND UNVERIFIED EDGE CASE (review round 1): since the key is a
  // stable function of username alone, a genuine Resend-side failure (a
  // real 5xx FROM Resend, not just a network error that never reaches
  // them) recomputes the IDENTICAL key on any later legitimate retry
  // after releaseFailedSend runs. Resend's own docs don't explicitly
  // state whether a failed/errored request's key gets cached against
  // future retries -- the phrasing suggests only successful sends do,
  // which would mean this is a non-issue in practice, but that's an
  // inference, not a documented guarantee. Worst case if it DOES cache
  // failures too: a legitimate retry gets blocked/delayed, never a
  // duplicate send -- consistent with this feature's fail-toward-
  // no-double-send priority. A future engineer with real Resend access
  // should spot-check both this and the 409-different-payload case above
  // once real traffic exercises either.)
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
        subject: "Your dream is ready &mdash; here's your video",
        html: html
      })
    });
    if (!res.ok) {
      console.error('first-dream-email-sender: Resend rejected the send', res.status);
      // See "RESEND-FAILURE FIX" above &mdash; release the claim so a later
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
