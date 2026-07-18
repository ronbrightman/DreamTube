// netlify/functions/publish-dream.js
//
// POST { id, ownerHandle, caption, style, dur, videoUrl } -> upserts a dream
// into the shared feed-index blob (see get-feed.js). Called both when a
// dream is first published, and again if an already-published dream is
// later edited/regenerated (store.js's finalizeDream re-syncs so the shared
// copy doesn't go stale) — same upsert either way, keyed on id.
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
  var videoUrl = payload.videoUrl;
  if (!id || !ownerHandle || !caption || !style || !videoUrl) {
    return { statusCode: 400, body: JSON.stringify({ error: 'missing_fields' }) };
  }

  try {
    connectLambda(event);
    var store = getStore('dreamtube-feed');
    var feed = (await store.get('feed-index', { type: 'json' })) || [];
    var idx = feed.findIndex(function (d) { return d.id === id; });

    var record = {
      id: id, ownerHandle: ownerHandle, caption: caption, style: style, dur: dur, videoUrl: videoUrl,
      likes: idx === -1 ? 0 : (feed[idx].likes || 0),
      publishedAt: idx === -1 ? Date.now() : feed[idx].publishedAt
    };

    if (idx === -1) feed.unshift(record); else feed[idx] = record;
    await store.setJSON('feed-index', feed);

    return { statusCode: 200, body: JSON.stringify({ ok: true, dream: record }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'publish_failed: ' + (e && e.message) }) };
  }
};
