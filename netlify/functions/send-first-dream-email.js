// netlify/functions/send-first-dream-email.js
//
// POST { username, dreamId, caption, style, videoUrl, mediaType } -> sends
// the "your dream is ready" RETENTION email (day-1 -> day-2+ return),
// tracker.html's for-product-retention-email-send-user-th-eke9ra item,
// founder-greenlit 2026-07-26 ("start now, before paywall").
//
// Called from the SAME choke point js/store.js's
// markFirstVideoCreatedIfEligible already fires the FirstVideoCreated KPI
// event from (see result.html's and explore.html's own call sites, and
// docs/EVENT_TAXONOMY.md) -- the moment an account's first-ever completed
// dream shows up, client-side. There is no server-side signal for a
// normal signed-in generation completing at all (see
// generate-video.js's withWebhook comment -- fal's webhook is used ONLY
// for the separate pre-signup abandoned-dream flow in dream-webhook.js),
// so the client has to be the one to tell the server "this just happened"
// -- this endpoint exists to take that tip and do everything
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
// (caption/style/videoUrl), on the other hand, is taken as given from the
// client, same as publish-dream.js's own documented "no ownership check,
// honest MVP scope" -- there is no independent server-side record of a
// PRIVATE dream to cross-check it against (see lib/dream-share-token.js's
// header comment for the full reasoning), and the content is only ever
// exposed back to whoever holds the resulting single-purpose share token,
// never anything account-identifying beyond that.
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
// BEFORE any send is attempted. This is the durable, cross-device
// backstop for the same known cross-tab race already accepted at this
// exact choke point for markFirstVideoCreatedIfEligible/FirstVideoCreated
// (see docs/EVENT_TAXONOMY.md) -- two tabs racing the client-side check
// could both dispatch this request, but only one wins this server-side
// guarded write, so only one email ever actually sends.
//
// BEST-EFFORT, SAME DISCIPLINE AS dream-webhook.js's sendReadyEmail /
// request-password-reset.js: gated on RESEND_API_KEY being configured
// (logs and no-ops if missing), wrapped so a Resend failure is logged but
// never surfaces as an error -- this must never block or fail the
// generation-completion flow it's called from.
//
// RATE LIMITING: a per-IP daily cap (lib/rate-limit.js, same helper
// generate-video.js/account-login.js/submit-support-message.js already
// use) -- this is a public endpoint with no real caller auth (same MVP
// security posture as every other endpoint in this codebase), and unlike
// generate-video.js's cost risk, the risk here is spam/reputation/quota
// (Resend's free tier caps at 100 sends/day total -- see tracker.html's
// idea-weekly-recap item flagging this same constraint) rather than
// dollars. The per-account markSentOnce guard above already bounds the
// worst case to one email per real account ever, but a per-IP cap still
// bounds how many DISTINCT accounts one source can trigger sends for in a
// single day.
//
// Error codes (this file's own small namespace, matching
// dream-webhook.js's/request-magic-link.js's bare-number convention for a
// small file, not generate-video.js's zero-padded E1xx range):
//   E1 method_not_allowed
//   E2 invalid_json
//   E3 missing_fields  -- username/dreamId/videoUrl not all present

var accountStore = require('./lib/account-store');
var firstDreamEmailStore = require('./lib/first-dream-email-store');
var dreamShareToken = require('./lib/dream-share-token');
var rateLimit = require('./lib/rate-limit');

var RESEND_API_BASE = 'https://api.resend.com/emails';
// Deliberately duplicated from dream-webhook.js's own identical constant
// rather than extracted into a shared lib -- this task's own instructions
// are explicit not to touch that file, and both are small, self-contained
// per-file constants already (this codebase's established convention --
// see request-password-reset.js's own identical FROM_ADDRESS constant).
var FROM_ADDRESS = 'DreamTube <onboarding@resend.dev>';

// Same style -> color mapping as js/store.js's STYLE_GRADIENTS, flattened
// to a single flat hex for an email client (most email clients don't
// render CSS gradients reliably, some strip <style> blocks entirely) --
// this stands in for a real video-frame thumbnail, which this codebase
// has no infrastructure to generate (no server-side video-frame
// extraction anywhere) -- a real thumbnail is a separate, bigger project,
// out of scope for "keep it simple" here. Falls back to Cinematic's own
// color, same default gradientFor() in js/store.js uses.
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
  var dreamId = payload.dreamId;
  var videoUrl = payload.videoUrl;
  var caption = payload.caption;
  var style = payload.style;
  var mediaType = payload.mediaType === 'image' ? 'image' : 'video';

  if (!username || !dreamId || !videoUrl) {
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
    // Never trust a client-supplied email -- resolve the account's real,
    // verified address the same way submit-support-message.js already
    // does. No account record, or an account with no email on file yet,
    // means there is nothing safe to send to.
    var account = await accountStore.getByUsername(event, username);
    if (!account || !account.email) {
      console.log('send-first-dream-email: no verified account email on file for username ' + username + ' -- skipping');
      return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: 'no_verified_email' }) };
    }

    // Idempotency FIRST, before any send is attempted -- see header
    // comment. A losing racer (the same cross-tab race
    // markFirstVideoCreatedIfEligible already accepts) must never send.
    var guard = await firstDreamEmailStore.markSentOnce(event, username, dreamId);
    if (!guard.ok) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: 'already_sent' }) };
    }

    var resendKey = process.env.RESEND_API_KEY;
    if (!resendKey) {
      console.log('send-first-dream-email: RESEND_API_KEY not configured -- skipping send for ' + username);
      return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: 'no_resend_key' }) };
    }

    var token = await dreamShareToken.createToken(event, {
      id: dreamId, ownerHandle: account.username, caption: caption, style: style, videoUrl: videoUrl, mediaType: mediaType
    });
    var watchUrl = dreamShareToken.buildUrl(event, dreamId, token);
    var host = event.headers['x-forwarded-host'] || event.headers.host;
    var createUrl = 'https://' + host + '/create.html';
    var bannerColor = colorForStyle(style);

    try {
      var res = await fetch(RESEND_API_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + resendKey },
        body: JSON.stringify({
          from: FROM_ADDRESS,
          to: [account.email],
          subject: "Your dream is ready — here's your video",
          html:
            '<div style="max-width:480px;margin:0 auto;font-family:sans-serif;">' +
            '<div style="height:160px;border-radius:14px;background:' + bannerColor + ';margin-bottom:18px;"></div>' +
            '<p style="font-size:16px;">Your dream is ready to watch' + (caption ? ': <b>' + esc(caption) + '</b>' : '.') + '</p>' +
            '<p><a href="' + watchUrl + '" style="display:inline-block;padding:12px 22px;background:#000;color:#fff;border-radius:24px;text-decoration:none;font-weight:600;">Watch it</a></p>' +
            '<p style="color:#666;font-size:13px;">Loved it? <a href="' + createUrl + '">Make another dream</a> — it only takes a minute.</p>' +
            '</div>'
        })
      });
      if (!res.ok) console.error('send-first-dream-email: Resend rejected the send', res.status);
    } catch (sendErr) {
      console.error('send-first-dream-email: Resend send failed (non-fatal)', sendErr);
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    console.error('send-first-dream-email: unexpected error', e);
    // Best-effort, same philosophy as dream-webhook.js/request-password-
    // reset.js -- never let this surface as a failure to the caller.
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'internal_error' }) };
  }
};
