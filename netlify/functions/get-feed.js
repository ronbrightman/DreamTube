// netlify/functions/get-feed.js
//
// GET -> { feed: [...] } the full shared list of published dreams, newest
// first. Backed by a single JSON blob (feed-index) in the "dreamtube-feed"
// Blobs store — this is intentionally not a real database: reads/writes are
// whole-array read-modify-write (see publish-dream.js/like-dream.js), which
// is fine at this app's scale but would race under real concurrent traffic.
// That tradeoff is deliberate — see the request that added this file.

var { connectLambda, getStore } = require('@netlify/blobs');

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'method_not_allowed' }) };
  }

  try {
    connectLambda(event);
    var store = getStore('dreamtube-feed');
    var feed = (await store.get('feed-index', { type: 'json' })) || [];
    return { statusCode: 200, body: JSON.stringify({ feed: feed }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'feed_fetch_failed: ' + (e && e.message) }) };
  }
};
