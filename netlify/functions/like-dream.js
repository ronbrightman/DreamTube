// netlify/functions/like-dream.js
//
// POST { id, delta } -> adjusts a dream's shared like count by delta (+1 or
// -1, from toggling like/unlike) and returns the new total. Read-modify-
// write on the same feed-index blob as get-feed.js/publish-dream.js — see
// that file's header comment for why this is fine at this app's scale but
// not race-proof under real concurrent traffic (deliberate MVP tradeoff).
//
// No per-user like tracking (would need real accounts, out of scope) — the
// client decides whether it's liking or unliking based on its own local
// "have I liked this" flag (js/store.js's state.likedIds), so the same
// dream liked from two different browsers/devices counts twice. Acceptable
// given this app's local-only auth model everywhere else.

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
  var delta = payload.delta === -1 ? -1 : 1;
  if (!id) {
    return { statusCode: 400, body: JSON.stringify({ error: 'id_required' }) };
  }

  try {
    connectLambda(event);
    var store = getStore('dreamtube-feed');
    var feed = (await store.get('feed-index', { type: 'json' })) || [];
    var idx = feed.findIndex(function (d) { return d.id === id; });
    if (idx === -1) {
      return { statusCode: 404, body: JSON.stringify({ error: 'not_found' }) };
    }
    feed[idx].likes = Math.max(0, (feed[idx].likes || 0) + delta);
    await store.setJSON('feed-index', feed);
    return { statusCode: 200, body: JSON.stringify({ ok: true, likes: feed[idx].likes }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'like_failed: ' + (e && e.message) }) };
  }
};
