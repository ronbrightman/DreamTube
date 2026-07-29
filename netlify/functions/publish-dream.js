// netlify/functions/publish-dream.js
//
// POST { id, ownerHandle, caption, style, dur, videoUrl, imageUrl, mediaType,
//        channelLicenseGrantedAt, channelLicenseRevokedAt, okToFeatureOnChannels,
//        authToken }
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

var { connectLambda, getStore } = require('@netlify/blobs');
var accountAuthToken = require('./lib/account-auth-token');

function stripAt(handle) {
  var s = (typeof handle === 'string' ? handle : '').trim();
  return s.charAt(0) === '@' ? s.slice(1) : s;
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

  try {
    connectLambda(event);
    var store = getStore('dreamtube-feed');
    var feed = (await store.get('feed-index', { type: 'json' })) || [];
    var idx = feed.findIndex(function (d) { return d.id === id; });

    var record = {
      id: id, ownerHandle: ownerHandle, caption: caption, style: style, dur: dur,
      videoUrl: videoUrl, imageUrl: imageUrl, mediaType: mediaType,
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
