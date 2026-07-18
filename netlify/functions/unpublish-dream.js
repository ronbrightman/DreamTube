// netlify/functions/unpublish-dream.js
//
// POST { id } -> removes a dream from the shared feed-index blob (see
// get-feed.js). Called when a published dream is deleted, so it doesn't
// linger in everyone else's Explore/Home feed once the owner has removed it.

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

  if (!payload.id) {
    return { statusCode: 400, body: JSON.stringify({ error: 'id_required' }) };
  }

  try {
    connectLambda(event);
    var store = getStore('dreamtube-feed');
    var feed = (await store.get('feed-index', { type: 'json' })) || [];
    var filtered = feed.filter(function (d) { return d.id !== payload.id; });
    await store.setJSON('feed-index', filtered);
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'unpublish_failed: ' + (e && e.message) }) };
  }
};
