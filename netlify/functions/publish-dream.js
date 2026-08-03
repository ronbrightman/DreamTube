// netlify/functions/publish-dream.js
//
// POST { id, ownerHandle, caption, style, dur, videoUrl, imageUrl, mediaType,
//        avatar, channelLicenseGrantedAt, channelLicenseRevokedAt,
//        okToFeatureOnChannels, authToken }
// (musicBedOn removed from this payload/record shape as of tracker item
// for-product-build-founder-approved-08-03-jlkjy9's 2026-08-03 founder
// simplification — "no user choice," music is always on. js/music-bed.js's
// eligible() computes bed eligibility purely from a dream's own
// videoUrl/style, so the field no longer means anything and is no longer
// read or written here.)
// -> upserts a dream into the shared feed-index blob (see get-feed.js).
// Called both when a dream is first published, and again if an
// already-published dream is later edited/regenerated (store.js's
// finalizeDream re-syncs so the shared copy doesn't go stale) — same
// upsert either way, keyed on id.
//
// videoUrl/imageUrl/mediaType (added for the image-generation feature — see
// docs/IMAGE_GENERATION_SPEC.md): a dream needs EITHER a videoUrl or an
// imageUrl to publish, not both — the old `!videoUrl` requirement below
// used to hard-block an image-type dream from ever reaching the shared
// feed at all (silently, since js/store.js's syncPublishedDreamToFeed is
// fire-and-forget). mediaType is passed through mostly for forward
// compatibility/debugging — get-feed.js's own consumers (explore.html/
// profile.html) render off videoUrl/imageUrl presence directly, the same
// three-way fallback pattern used everywhere else in this codebase, not
// off this field.
//
// channelLicenseGrantedAt/channelLicenseRevokedAt/okToFeatureOnChannels
// (tracker item for-product-terms-republish-license-per--fhpcxk): the
// republish-license consent state for terms.html's "Your content" clause,
// carried into this SHARED record — not just js/store.js's local copy —
// since a real, cross-device future auto-posting engine (NOT built here)
// could only ever read curation eligibility from here. `channelLicenseGrantedAt`
// null/absent means this dream was published before the clause shipped and
// has no license at all yet (deliberately never backfilled — see
// js/store.js's publishDream comment); `channelLicenseRevokedAt` is the
// same "concrete state a later 'remove existing social posts on request'
// pass would read" js/store.js's unpublishDream/deleteDream comments
// describe; `okToFeatureOnChannels` defaults true (on) when omitted,
// matching the zero-click default-on opt-out toggle.
//
// SECURITY (fixed after review — tracker item
// publish-dream-js-trusts-client-supplied--lkppcu): this file used to
// upsert a shared feed record straight from a bare client-supplied
// `ownerHandle`, with no identity check at all. That was honest MVP scope
// while the shared record only carried display fields (caption/style
// forgery here is just vandalism, and a dream's public `id` already has no
// real secrecy — anyone can see it via Explore). It stopped being honest
// scope the moment channelLicenseGrantedAt/channelLicenseRevokedAt/
// okToFeatureOnChannels started carrying real legal consent state: since
// `id` is public, anyone could forge a raw POST here and silently flip a
// real owner's republish-license consent, with nothing server-side to
// notice or stop it.
//
// avatar (tracker item for-product-ui-founder-directed-2026-07--djgjn0):
// a small avatar thumbnail (see js/store.js's syncPublishedDreamToFeed —
// resized client-side to a low-quality, ~48px JPEG data URL, "few KB" per
// that item) carried alongside the rest of the record so OTHER visitors'
// devices have something real to render for Explore's feed-user-row
// circle, not just the always-empty div this fixes. This is the one field
// on this endpoint that's genuinely attacker-controllable free-form data
// (everything else is short strings/URLs/booleans) — validated the same
// rigor as this file's other hardening (see validateAvatar below): must be
// a real small image data URL or absent, never trusted blindly. Rejected
// (E7) rather than silently dropped, matching this file's existing
// reject-don't-silently-degrade posture for a request that fails its own
// stated shape (see E3/E6) — a legitimate client (js/store.js) never sends
// anything else, so this only ever fires against a forged/malformed
// request.
//
// Fixed the same way block-user.js was (lib/account-auth-token.js's
// verifyToken — see that file's own header comment for why this
// mechanism, and not a wider auth rewrite, is the right scope here): a
// verified `authToken` is now required, and the token's own verified
// username is treated as the one true identity for this request.
//
// DESIGN CHOICE — reject-on-mismatch, not silent-overwrite: the client
// still sends `ownerHandle` (unchanged payload shape, so js/store.js keeps
// its existing upsert-by-id call shape), but this handler now REQUIRES it
// to match the verified token's username and REJECTS (E6) the whole
// request if it doesn't, rather than silently substituting the verified
// username and proceeding. The alternative (always trust the token's
// username, ignore the client's ownerHandle field entirely) was
// deliberately not taken: js/store.js's backfillSharedFeed loops over
// EVERY dream in state.dreams, which is one array shared across every
// account that has ever signed into a given browser (see CLAUDE.md) —
// it's shaped to sync each dream under ITS OWN recorded ownerHandle, not
// whoever happens to be signed in when the backfill runs. Silently
// substituting the token's username there would misattribute a different,
// previously-used account's already-published dream to whoever is
// currently signed in, in the SHARED public feed. Rejecting the mismatch
// instead means that one narrow backfill case just honestly fails to sync
// (that dream was already published under its real owner's own session at
// some point, which is the path that actually matters) rather than
// corrupting a record's ownership — same "honest degrade, never a silent
// wrong answer" posture the rest of this file's fire-and-forget callers
// already rely on.
//
// Error codes (local to this function, same small-number-scheme reasoning
// as block-user.js/admin-paywall-toggle.js):
//   E1 method_not_allowed       — verb other than POST
//   E2 invalid_json             — POST body wasn't valid JSON
//   E3 missing_fields           — id/ownerHandle/caption/style, or neither
//                                   videoUrl nor imageUrl, present
//   E4 auth_token_required      — `authToken` missing/blank
//   E5 invalid_or_expired_token — authToken didn't verify (unknown,
//                                   expired, or never issued) — same "200,
//                                   ok:false, business outcome" shape
//                                   block-user.js's own E6 uses, not a
//                                   4xx/5xx (mirrors that file's reasoning:
//                                   a stale/expired token on an otherwise
//                                   fire-and-forget sync is an expected,
//                                   routine outcome for js/store.js to
//                                   quietly swallow, not a client bug)
//   E6 owner_mismatch           — the verified token's username doesn't
//                                   match the request's own claimed
//                                   ownerHandle — the actual forged-request
//                                   case this fix closes. A real 4xx, not
//                                   the E5 "business as usual" shape —
//                                   this is a rejected identity claim, not
//                                   a routine expired-token retry.
//   E7 invalid_avatar           — `avatar` present but not a small,
//                                   correctly-typed image data URL (wrong
//                                   type, malformed, or over
//                                   AVATAR_MAX_BYTES decoded size)
//   E8 email_not_verified       — the verified token's own account has
//                                   `emailVerified === false` (tracker item
//                                   for-product-build-passwordless-signup-
//                                   fo-at2fko's gate list — see
//                                   lib/account-store.js's own GATE LIST
//                                   header comment for the full "why
//                                   publish specifically"). Same 200/
//                                   ok:false "business outcome" shape as E5
//                                   — js/store.js's syncPublishedDreamToFeed
//                                   call site is fire-and-forget today (see
//                                   that function's own doc comment), so
//                                   this degrades exactly like every other
//                                   failure mode there: the dream stays
//                                   published in the account's own local/
//                                   private view, it just doesn't reach the
//                                   shared cross-account feed yet.

var { connectLambda, getStore } = require('@netlify/blobs');
var accountAuthToken = require('./lib/account-auth-token');
var accountStore = require('./lib/account-store');

function stripAt(handle) {
  var s = (typeof handle === 'string' ? handle : '').trim();
  return s.charAt(0) === '@' ? s.slice(1) : s;
}

// Generous cap given js/store.js's own thumbnail target of ~1-3KB at
// 48px/0.55-quality JPEG (see syncPublishedDreamToFeed) -- 20KB decoded
// leaves real headroom for a legitimate client without letting a forged
// request smuggle a full-size photo into the shared feed-index blob that
// every visitor's device downloads whole (see get-feed.js).
var AVATAR_MAX_BYTES = 20 * 1024;
var AVATAR_DATA_URL_RE = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/;

/**
 * Validates an `avatar` payload field. Returns { ok:true, value } — value
 * is the original data URL string, or null if the field was omitted/empty
 * (a dream published with no Me photo set, or before this feature shipped
 * — see explore.html's avatarFallback-driven rendering for how that's
 * handled) — or { ok:false } if `avatar` was present but isn't a small,
 * correctly-typed image data URL.
 */
function validateAvatar(avatar) {
  if (avatar === undefined || avatar === null || avatar === '') return { ok: true, value: null };
  if (typeof avatar !== 'string') return { ok: false };
  var match = AVATAR_DATA_URL_RE.exec(avatar);
  if (!match) return { ok: false };
  var approxBytes = Math.floor(match[2].length * 3 / 4);
  if (approxBytes > AVATAR_MAX_BYTES) return { ok: false };
  return { ok: true, value: avatar };
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

  var id = payload.id;
  var ownerHandle = payload.ownerHandle;
  var caption = payload.caption;
  var style = payload.style;
  var dur = payload.dur;
  var videoUrl = payload.videoUrl || null;
  var imageUrl = payload.imageUrl || null;
  var mediaType = payload.mediaType === 'image' ? 'image' : 'video';
  // See this file's header comment — null/absent means "not licensed,
  // published before the clause shipped," not a value to paper over with
  // a default. okToFeatureOnChannels DOES default true/on (unset === on).
  var channelLicenseGrantedAt = payload.channelLicenseGrantedAt || null;
  var channelLicenseRevokedAt = payload.channelLicenseRevokedAt || null;
  var okToFeatureOnChannels = payload.okToFeatureOnChannels !== false;
  var authToken = (payload.authToken || '').trim();

  if (!id || !ownerHandle || !caption || !style || (!videoUrl && !imageUrl)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E3: missing_fields' }) };
  }
  if (!authToken) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E4: auth_token_required' }) };
  }

  var avatarCheck = validateAvatar(payload.avatar);
  if (!avatarCheck.ok) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E7: invalid_avatar' }) };
  }
  var avatar = avatarCheck.value;

  var auth = await accountAuthToken.verifyToken(event, authToken);
  if (!auth.ok) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'E5: invalid_or_expired_token' }) };
  }

  // See this file's own "DESIGN CHOICE — reject-on-mismatch" header
  // comment for why this rejects rather than silently substituting
  // auth.username here.
  if (stripAt(ownerHandle).toLowerCase() !== auth.username.toLowerCase()) {
    return { statusCode: 403, body: JSON.stringify({ error: 'E6: owner_mismatch' }) };
  }

  // Gate list, item 2 — see this file's own E8 doc comment above and
  // account-store.js's GATE LIST header comment. `=== false` specifically,
  // never `!record.emailVerified` — an account this field predates, or
  // whose record somehow can't be read, must never be blocked from
  // publishing over it (under-gate, never over-gate).
  var account = await accountStore.getByUsername(event, auth.username);
  if (account && account.emailVerified === false) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'E8: email_not_verified' }) };
  }

  try {
    connectLambda(event);
    var store = getStore('dreamtube-feed');
    var feed = (await store.get('feed-index', { type: 'json' })) || [];
    var idx = feed.findIndex(function (d) { return d.id === id; });

    var record = {
      id: id, ownerHandle: ownerHandle, caption: caption, style: style, dur: dur,
      videoUrl: videoUrl, imageUrl: imageUrl, mediaType: mediaType,
      avatar: avatar,
      likes: idx === -1 ? 0 : (feed[idx].likes || 0),
      publishedAt: idx === -1 ? Date.now() : feed[idx].publishedAt,
      channelLicenseGrantedAt: channelLicenseGrantedAt,
      channelLicenseRevokedAt: channelLicenseRevokedAt,
      okToFeatureOnChannels: okToFeatureOnChannels
    };

    if (idx === -1) feed.unshift(record); else feed[idx] = record;
    await store.setJSON('feed-index', feed);

    return { statusCode: 200, body: JSON.stringify({ ok: true, dream: record }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'publish_failed: ' + (e && e.message) }) };
  }
};
