// netlify/functions/sync-profile.js
//
// POST { authToken, handle, displayName, avatarDataUrl, bio }
// -> { ok:true, profile } | { ok:false, error }
//
// Token-gated write half of Social Layer v2 slice 1 ("profile shell +
// share" — docs/SOCIAL_LAYER_V2_DESIGN.md, tracker item
// for-product-build-social-layer-v2-direct-34047c). Called by
// js/store.js's syncProfileToServer on Edit-profile save (profile.html)
// and on first publish (DreamStore.publishDream) — see that function's own
// doc comment for exactly when.
//
// AUTH — same lib/account-auth-token.js verifyToken + reject-on-mismatch
// shape publish-dream.js already established (see that file's own
// "SECURITY"/"DESIGN CHOICE — reject-on-mismatch" header comments): a
// bare client-supplied `handle` would let anyone forge a POST here and
// overwrite a stranger's public bio/avatar/display name. `handle` is
// still accepted from the client (rather than only ever trusting the
// token's own username) specifically because verifyToken only ever hands
// back a NORMALIZED (lowercased) username — the real-cased handle (e.g.
// "@Luna", matching every dream's own ownerHandle on the shared feed)
// has no other server-side source (see lib/profile-store.js's own header
// comment). The request is REJECTED (E6), not silently corrected, if the
// claimed handle doesn't match the verified token's username
// case-insensitively — same posture as publish-dream.js's E6.
//
// Error codes (local to this function, same small-number-scheme
// reasoning as publish-dream.js/block-user.js):
//   E1 method_not_allowed       — verb other than POST
//   E2 invalid_json             — POST body wasn't valid JSON
//   E3 handle_required          — `handle` missing/blank
//   E4 auth_token_required      — `authToken` missing/blank
//   E5 invalid_or_expired_token — authToken didn't verify (unknown,
//                                   expired, or never issued) — same
//                                   "200, ok:false, business outcome"
//                                   shape publish-dream.js's own E5 uses
//   E6 owner_mismatch           — the verified token's username doesn't
//                                   match the request's claimed handle
//   E7 invalid_avatar           — `avatarDataUrl` present but not a
//                                   small, correctly-typed image data URL
//                                   (wrong type, malformed, or over
//                                   AVATAR_MAX_BYTES decoded size)
//   E8 bio_too_long             — `bio` present and over BIO_MAX_CHARS
//                                   (150, IG parity — see the design doc)

var { connectLambda } = require('@netlify/blobs');
var accountAuthToken = require('./lib/account-auth-token');
var profileStore = require('./lib/profile-store');

function stripAt(handle) {
  var s = (typeof handle === 'string' ? handle : '').trim();
  return s.charAt(0) === '@' ? s.slice(1) : s;
}

var BIO_MAX_CHARS = 150;
// A profile avatar is re-downscaled to 256px JPEG client-side (see
// js/store.js's currentUserProfileAvatarDataUrl) before ever reaching
// this endpoint — generous enough headroom for that real size (a 256x256
// JPEG at reasonable quality is typically well under 60KB) without
// letting a forged request smuggle something much larger into a store
// every profile-page visitor's browser downloads a copy of.
var AVATAR_MAX_BYTES = 150 * 1024;
var AVATAR_DATA_URL_RE = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/;

// Purely defensive length cap on the free-text display name — no product
// spec calls for a hard limit here (unlike bio's explicit IG-parity 150),
// this just keeps a wildly-oversized value out of the shared store; a
// legitimate client (the Me character's own `name` field) never comes
// close to this.
var DISPLAY_NAME_MAX_CHARS = 80;

/** Same shape as publish-dream.js's own validateAvatar — see that file's header comment. */
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

  var handle = (typeof payload.handle === 'string' ? payload.handle : '').trim();
  if (!handle) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E3: handle_required' }) };
  }

  var authToken = (payload.authToken || '').trim();
  if (!authToken) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E4: auth_token_required' }) };
  }

  var bio = (typeof payload.bio === 'string' ? payload.bio : '').trim();
  if (bio.length > BIO_MAX_CHARS) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E8: bio_too_long' }) };
  }

  var avatarCheck = validateAvatar(payload.avatarDataUrl);
  if (!avatarCheck.ok) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E7: invalid_avatar' }) };
  }

  var displayName = (typeof payload.displayName === 'string' ? payload.displayName : '').trim().slice(0, DISPLAY_NAME_MAX_CHARS);

  var auth = await accountAuthToken.verifyToken(event, authToken);
  if (!auth.ok) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'E5: invalid_or_expired_token' }) };
  }

  // See this file's own header comment for why the client's handle case
  // is trusted (once verified to belong to the right account) rather than
  // reconstructed from the token's normalized username.
  if (stripAt(handle).toLowerCase() !== auth.username.toLowerCase()) {
    return { statusCode: 403, body: JSON.stringify({ error: 'E6: owner_mismatch' }) };
  }

  try {
    connectLambda(event);
    var profile = await profileStore.upsertProfile(event, auth.username, {
      handle: handle,
      displayName: displayName,
      avatarDataUrl: avatarCheck.value,
      bio: bio
    });
    return { statusCode: 200, body: JSON.stringify({ ok: true, profile: profile }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'sync_profile_failed: ' + (e && e.message) }) };
  }
};
