// netlify/functions/publish-dream.js
//
// POST { id, ownerHandle, caption, style, dur, videoUrl, imageUrl, mediaType,
//        channelLicenseGrantedAt, okToFeatureOnChannels }
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
// channelLicenseGrantedAt/okToFeatureOnChannels (tracker item for-product-
// terms-republish-license-per--fhpcxk): the republish-license consent
// state for terms.html's "Your content" clause, carried into this SHARED
// record — not just js/store.js's local copy — since a real, cross-device
// future auto-posting engine (NOT built here) could only ever read
// curation eligibility from here. `channelLicenseGrantedAt` null/absent
// means this dream was published before the clause shipped and has no
// license at all yet (deliberately never backfilled — see js/store.js's
// publishDream comment); `okToFeatureOnChannels` defaults true (on) when
// omitted, matching the zero-click default-on opt-out toggle.
//
// No ownership check: this app has no real server-side auth (client-side
// localStorage only, same as every other write in this codebase), so this
// is honest MVP scope, not an oversight — matches the rest of the app's
// documented "no real backend yet" security model.

var { connectLambda, getStore } = require('@netlify/blobs');

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'method_not_allowed' }) };
  }

  var payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'invalid_json' }) };
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
  var okToFeatureOnChannels = payload.okToFeatureOnChannels !== false;
  if (!id || !ownerHandle || !caption || !style || (!videoUrl && !imageUrl)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'missing_fields' }) };
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
      okToFeatureOnChannels: okToFeatureOnChannels
    };

    if (idx === -1) feed.unshift(record); else feed[idx] = record;
    await store.setJSON('feed-index', feed);

    return { statusCode: 200, body: JSON.stringify({ ok: true, dream: record }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'publish_failed: ' + (e && e.message) }) };
  }
};
