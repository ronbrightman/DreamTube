// netlify/functions/get-profile.js
//
// GET ?handle=<username or "@handle", any case>
// -> { exists, profile, dreams, publishedCount, commentCounts }
//
// Public, no-auth read half of Social Layer v2 slice 1 ("profile shell +
// share" — docs/SOCIAL_LAYER_V2_DESIGN.md, tracker item
// for-product-build-social-layer-v2-direct-34047c). Backs u.html the same
// way get-feed.js backs explore.html — a bare GET, no login required
// (u.html is reachable signed-out, same posture as explore.html).
//
// `profile` is the dreamtube-profiles record (lib/profile-store.js) if one
// exists, or `null` if this handle has never synced one (e.g. published
// before ever opening Edit-profile — see js/store.js's syncProfileToServer
// for the two moments that create one). `exists` is true whenever there IS
// something real to show for this handle — a real profile record OR at
// least one published dream — so a dreamer who has published but never
// synced a profile record still gets a real (if minimally-filled) u.html
// page, not a "doesn't exist" wall. Only a handle with NEITHER a profile
// record NOR any published dreams is genuinely `exists:false` — u.html
// shows "This dreamer hasn't set up their profile yet" for exactly that
// case (design doc §D).
//
// `dreams` is the SAME raw shared-feed record shape get-feed.js's own
// `feed` array already carries (id/ownerHandle/caption/style/dur/
// videoUrl/imageUrl/mediaType/avatar/likes/publishedAt/...), filtered to
// this one ownerHandle and left in the feed-index's own newest-first
// order — u.html runs these through DreamStore.decorateFeedDreams
// client-side to add the per-viewer mine/likedByMe/blockedByMe flags this
// endpoint has no viewer identity to compute itself (a bare public GET,
// same reasoning get-feed.js's own header comment gives for leaving those
// flags out of its own response).
//
// `commentCounts` is a placeholder empty object in THIS slice — slice 2
// ("comments", not built here) is what will ever populate it, keyed by
// dream id. Shipped now, empty, so slice 2 only has to fill in a value
// that's already part of this response's shape rather than also having to
// widen the shape itself.
//
// Handle matching is CASE-INSENSITIVE and '@'-agnostic against each
// dream's own `ownerHandle` (which carries whatever case the owner's
// browser sent at publish time — see publish-dream.js) and against the
// profile record's own lowercased-username store key (lib/profile-
// store.js) — a visitor's `?handle=` can come from a URL typed by hand,
// so it must not be case-sensitive.
//
// CORS: open (Access-Control-Allow-Origin: *), matching get-feed.js's own
// reasoning — this is already-public, read-only data (every dream in it
// is something its owner explicitly published to Explore), no
// confidentiality reason to restrict the origin.
//
// Error codes (local to this function):
//   E1 method_not_allowed
//   E2 handle_required

var { connectLambda, getStore } = require('@netlify/blobs');
var profileStore = require('./lib/profile-store');

var CORS_HEADERS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };

function stripAt(handle) {
  var s = (typeof handle === 'string' ? handle : '').trim();
  return s.charAt(0) === '@' ? s.slice(1) : s;
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'E1: method_not_allowed' }) };
  }

  var params = event.queryStringParameters || {};
  var handleParam = (params.handle || '').trim();
  if (!handleParam) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'E2: handle_required' }) };
  }
  var normalizedTarget = stripAt(handleParam).toLowerCase();

  try {
    connectLambda(event);
    var profile = await profileStore.getProfile(event, handleParam);

    var feedStore = getStore('dreamtube-feed');
    var feed = (await feedStore.get('feed-index', { type: 'json' })) || [];
    var dreams = feed.filter(function (d) {
      return d && stripAt(d.ownerHandle).toLowerCase() === normalizedTarget;
    });

    var exists = !!profile || dreams.length > 0;

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        exists: exists,
        profile: profile,
        dreams: dreams,
        publishedCount: dreams.length,
        // Slice 2 seam — see this file's own header comment.
        commentCounts: {}
      })
    };
  } catch (e) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'get_profile_failed: ' + (e && e.message) }) };
  }
};
