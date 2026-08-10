// netlify/functions/send-first-dream-email.js
//
// POST { username, password, dreamId, caption, style, videoUrl, mediaType,
//        imageUrl, operationName }
// -> sends the "your dream is ready" RETENTION email (day-1 -> day-2+
// return), tracker.html's for-product-retention-email-send-user-th-eke9ra
// item, founder-greenlit 2026-07-26 ("start now, before paywall"). imageUrl
// (added 2026-08-02, tracker item
// for-product-dream-ready-email-real-first-qr9fbj) is optional/cosmetic --
// see lib/first-dream-email-sender.js's own "REAL THUMBNAIL" header
// comment.
//
// AS OF 2026-07-27 (tracker.html's
// for-product-activate-automatic-retention-4n74rw item, founder-approved
// -- "start sending... AUTOMATICALLY... do not wait for manual
// triggering"), this is no longer the ONLY way this email fires --
// mark-generation-completed.js now ALSO fires it directly, automatically,
// from the real server-verified generation-complete choke point (see that
// file's own header comment for why THIS endpoint's client-triggered path
// couldn't be that choke point on its own: it depends on the browser tab
// surviving long enough to load result.html/explore.html and run their
// JS, which a closed tab, a killed in-app-browser webview, or total
// network loss between processing.html and result.html could all
// prevent). This endpoint is KEPT, unchanged in its own request contract,
// as the client-triggered fallback result.html/explore.html still call
// (see their own call sites) -- both paths funnel into the exact same
// atomic per-account guard (lib/first-dream-email-store.js's
// markSentOnce, via the shared lib/first-dream-email-sender.js core both
// now call), so whichever one reaches the choke point first for a given
// account wins the send, and the other is a harmless no-op. In practice
// the automatic path almost always wins the race (it fires the moment
// processing.html's poll sees completion, well before result.html even
// loads) -- this endpoint mainly exists now as a safety net for whatever
// edge case reaches result.html/explore.html without the automatic path
// having already fired (e.g. a legacy dream with no sourceOperationName,
// or a mark-generation-completed request that got lost in transit).
//
// Called from the SAME choke point js/store.js's
// markFirstVideoCreatedIfEligible already fires the FirstVideoCreated KPI
// event from (see result.html's and explore.html's own call sites, and
// docs/EVENT_TAXONOMY.md) -- the moment an account's first-ever completed
// dream shows up, client-side. There is no real fal webhook for a normal
// signed-in generation completing at all (see generate-video.js's
// withWebhook comment -- fal's webhook is used ONLY for the separate
// pre-signup abandoned-dream flow in dream-webhook.js), so the client has
// historically been the one to tell the server "this just happened" for
// this fallback path -- this endpoint takes that tip and does everything
// security-sensitive server-side instead of trusting the client with it.
//
// A NEW, SEPARATE email from dream-webhook.js's sendReadyEmail -- do not
// confuse the two. That one re-engages someone who abandoned BEFORE
// finishing signup, using lib/pending-dream-token.js. This one is for an
// already-signed-up account whose first dream just finished -- a
// completely different audience and choke point. dream-webhook.js is left
// untouched by this feature.
//
// WHAT'S TRUSTED FROM THE CLIENT AND WHAT ISN'T (the one thing that
// actually matters here): the email ADDRESS is never taken from the
// client -- it's resolved server-side via lib/account-store.js's
// getByUsername(), the exact same "trust the account record, not a raw
// client-supplied address" pattern submit-support-message.js already
// established (see that file's own header comment on why naming a
// `username` that isn't a real registered account is trivial for anyone,
// and why that's fine as long as nothing sensitive is done with an
// unverified identity). If the account has no verified email on file yet
// (a real, common state -- see js/store.js's own account model), this is
// a silent, logged no-op: there is nothing safe to send to, and no
// fallback to any client-supplied address. The dream CONTENT
// (caption/style), on the other hand, is taken as given from the client,
// same as publish-dream.js's own documented "no ownership check, honest
// MVP scope" -- there is no independent server-side record of a PRIVATE
// dream to cross-check it against, and it's used purely for cosmetic
// personalization of the email body (see lib/first-dream-email-sender.js),
// never anything account-identifying.
//
// THE LINK (changed 2026-07-27, founder decision): used to mint a
// lib/dream-share-token.js one-time-to-mint, many-times-viewable
// watch.html link for this ONE specific (possibly still-private) dream.
// Now links straight at this account's own profile.html instead -- see
// lib/first-dream-email-sender.js's header comment for the full reasoning
// (profile.html is already an authenticated app page, needing no
// per-dream token/session-carrying mechanism of its own). `videoUrl` is
// consequently no longer used for anything (no share token to mint), but
// is still accepted/required in the request shape unchanged, so
// result.html's/explore.html's existing call sites need no changes.
//
// MEDIA-TYPE SCOPE: video only, matching FirstVideoCreated's own existing
// scope (js/store.js's markFirstVideoCreatedIfEligible filters on
// `!!d.videoUrl`, i.e. an account whose first-ever completed dream is an
// IMAGE never fires that event today either) -- kept consistent
// deliberately rather than quietly broadening scope as part of this task.
// A `mediaType !== 'video'` (or missing videoUrl) request is a no-op, not
// an error.
//
// IDEMPOTENCY: exactly once per account, ever -- see
// lib/first-dream-email-store.js's markSentOnce(), checked (and won)
// BEFORE any send is attempted, via lib/first-dream-email-sender.js's
// shared sendIfEligible(). Now genuinely race-safe (blobs-retry-backed),
// not just a plain check-then-act -- see that store's own header comment
// for why this matters more now that a second, unconditional automatic
// caller (mark-generation-completed.js) exists alongside this endpoint's
// own client-triggered, one-time-page-load-gated calls.
//
// BEST-EFFORT, SAME DISCIPLINE AS dream-webhook.js's sendReadyEmail /
// request-password-reset.js: gated on RESEND_API_KEY being configured
// (logs and no-ops if missing), wrapped so a Resend failure is logged but
// never surfaces as an error -- this must never block or fail the
// generation-completion flow it's called from.
//
// AUTHENTICATION (review finding, fixed): unlike submit-support-message.js
// (which this file's own header comment originally, and wrongly, cited as
// precedent), this endpoint has a real external side effect on a THIRD
// PARTY's own inbox, plus a PERMANENT, unrecoverable per-account guard
// (firstDreamEmailStore.markSentOnce, with no admin/reset path anywhere
// in this codebase) -- submit-support-message.js only ever emails the
// FOUNDER's own inbox, using the resolved account email solely as a
// reply_to convenience, so a bare client-claimed username was an
// acceptable bar there. Here it is not: since every account's handle is
// public (shown on every Explore feed row), a bare client-claimed
// username would let anyone spam a real stranger's real inbox with
// attacker-chosen caption/video content AND silently, permanently disable
// that account's own legitimate future retention email, with no recovery
// path. Requires the account's real current password -- the same bar
// account-login.js already uses for password-gated access to a real
// account, verified via accountStore.verifyLogin BEFORE
// resolving the account's email or touching the idempotency guard (so a
// wrong-password attempt never poisons the real "already sent" flag for
// that account either). js/store.js's sendFirstDreamEmailBestEffort
// supplies this from the CURRENTLY signed-in account's own locally-cached
// password (state.accounts[key].password -- the same plaintext-local
// account model every other DreamStore method already relies on), so
// this adds no new UI prompt -- the legitimate caller already has it on
// hand. (mark-generation-completed.js's automatic path needs no password
// at all -- it resolves identity via lib/job-owners.js's server-issued
// operationName binding instead, see that file's own header comment.)
//
// RATE LIMITING: a per-IP daily cap (lib/rate-limit.js, same helper
// generate-video.js/account-login.js/submit-support-message.js already
// use) -- unlike generate-video.js's cost risk, the risk here is spam/
// reputation/quota (Resend's free tier caps at 100 sends/day total -- see
// tracker.html's idea-weekly-recap item flagging this same constraint)
// rather than dollars. The per-account markSentOnce guard above already
// bounds the worst case to one email per real account ever, and the
// password check above closes the spoofing vector, but a per-IP cap still
// bounds how many password-guessing attempts one source can make in a
// single day (same two-bucket reasoning as account-login.js's own rate
// limiting, simplified to per-IP only here since this isn't itself a
// login endpoint -- a wrong guess here doesn't unlock anything beyond
// this one email). The automatic path (mark-generation-completed.js) has
// its OWN, separate per-IP rate limit already (guarding against scripted
// junk requests, not password-guessing, since it needs no password at
// all) -- this endpoint's cap is unrelated to that one.
//
// Error codes (this file's own small namespace, matching
// dream-webhook.js's bare-number convention for a small file, not
// generate-video.js's zero-padded E1xx range):
//   E1 method_not_allowed
//   E2 invalid_json
//   E3 missing_fields  -- username/dreamId/videoUrl/password not all present
//   E4 rate_limited    -- MAX_FIRST_DREAM_EMAILS_PER_IP_PER_DAY exceeded
//   E5 incorrect_password -- password present but didn't match this account

var accountStore = require('./lib/account-store');
var firstDreamEmailSender = require('./lib/first-dream-email-sender');
var rateLimit = require('./lib/rate-limit');

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

  var username = payload.username;
  var password = payload.password;
  var dreamId = payload.dreamId;
  var videoUrl = payload.videoUrl;
  var caption = payload.caption;
  var style = payload.style;
  // imageUrl (tracker item for-product-dream-ready-email-real-first-qr9fbj)
  // -- same best-effort/optional-content class as caption/style above, see
  // lib/first-dream-email-sender.js's own "REAL THUMBNAIL" header comment.
  // Purely cosmetic: an absent/invalid value just means the email falls
  // back to the flat-color banner, never rejected or treated as a
  // malformed request.
  var imageUrl = payload.imageUrl;
  // operationName (added 2026-08-10, founder complaint — "I still get 'your
  // video is ready to watch' even when I DID watch it"): the dream's
  // server-issued job id (js/store.js passes dream.sourceOperationName). Lets
  // the shared sender suppress this "your dream is ready to watch" email for
  // a dream the user has already opened the fullscreen player for (the same
  // watched-aware suppression the automatic scan and the unwatched-dream
  // nudge apply — see lib/first-dream-email-sender.js's WATCHED-AWARE
  // SUPPRESSION note). Optional: absent (a legacy dream with no
  // sourceOperationName) just means this send can't be viewed-checked and
  // behaves exactly as before.
  var operationName = payload.operationName;
  var mediaType = payload.mediaType === 'image' ? 'image' : 'video';

  if (!username || !password || !dreamId || !videoUrl) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E3: missing_fields' }) };
  }

  // Video-only scope -- see header comment. A no-op, not an error: the
  // caller's own eligibility check already only ever gates on a videoUrl
  // dream (see js/store.js), so this should never actually trigger in
  // practice, but it's cheap, honest defense-in-depth to state the scope
  // explicitly here too rather than silently relying on the caller.
  if (mediaType !== 'video') {
    return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: 'not_video' }) };
  }

  var maxPerDay = parseInt(process.env.MAX_FIRST_DREAM_EMAILS_PER_IP_PER_DAY, 10);
  if (!maxPerDay || maxPerDay <= 0) maxPerDay = 50;
  var ip = rateLimit.clientIp(event);
  var ipLimit = await rateLimit.checkAndIncrement(event, 'first-dream-email', ip, maxPerDay);
  if (!ipLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ error: 'E4: rate_limited' }) };
  }

  try {
    // Real password re-check BEFORE resolving the account's email or
    // touching the idempotency guard below -- see header comment. This is
    // the fix for a review finding: a bare client-claimed username alone
    // would let anyone spam a real account's real inbox (every handle is
    // public) and permanently poison that account's own future retention
    // email via the unrecoverable markSentOnce guard. A wrong password
    // must fail here, before either of those, so a spoofing attempt never
    // has any observable effect at all.
    var loginCheck = await accountStore.verifyLogin(event, username, password);
    if (!loginCheck.ok) {
      return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'E5: incorrect_password' }) };
    }

    // The just-verified record's own email -- never a client-supplied
    // one. No email on file yet (a legacy, not-yet-backfilled account)
    // means there is nothing safe to send to.
    var account = loginCheck.record;
    if (!account.email) {
      console.log('send-first-dream-email: no verified account email on file for username ' + username + ' -- skipping');
      return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: 'no_verified_email' }) };
    }

    // The guard + actual send both live in the shared core now -- see
    // lib/first-dream-email-sender.js's header comment for why (the exact
    // same logic mark-generation-completed.js's automatic path calls, so
    // the two trigger points can never race each other into a double-send).
    await firstDreamEmailSender.sendIfEligible(event, {
      username: account.username,
      email: account.email,
      dreamId: dreamId,
      operationName: operationName,
      caption: caption,
      style: style,
      imageUrl: imageUrl,
      auto: false
    });

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    console.error('send-first-dream-email: unexpected error', e);
    // Best-effort, same philosophy as dream-webhook.js/request-password-
    // reset.js -- never let this surface as a failure to the caller.
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'internal_error' }) };
  }
};
