// netlify/functions/get-feed.js
//
// GET -> { feed: [...], dreamOfDayId } the full shared list of published
// dreams, newest first, plus today's shared "Dream of the Day" pick.
// Backed by a single JSON blob (feed-index) in the "dreamtube-feed" Blobs
// store — this is intentionally not a real database: reads/writes are
// whole-array read-modify-write (see publish-dream.js/like-dream.js), which
// is fine at this app's scale but would race under real concurrent traffic.
// That tradeoff is deliberate — see the request that added this file.
//
// CORS: open (Access-Control-Allow-Origin: *). This is already-public,
// read-only data — every dream in it is something its owner explicitly
// published to Explore, no auth/cookies involved — so there's no
// confidentiality reason to restrict the origin. Needed so the separate
// dreamtube-growth marketing repo can fetch it cross-origin for its own
// social-proof carousels (see that repo's funnel).

var { connectLambda, getStore } = require('@netlify/blobs');

var CORS_HEADERS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };

var DOD_KEY = 'dream-of-day';

// Today's date as a plain "YYYY-MM-DD" string, UTC. Rollover happens at UTC
// midnight rather than each visitor's local midnight -- a deliberate
// simplification (this app has no per-user timezone anywhere else either),
// not a correctness requirement worth a timezone library for.
function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

// Picks the highest-liked dream from whichever ones haven't already had a
// turn as Dream of the Day (usedIds). If literally every published dream
// has already been featured at some point, recycle: everyone's had a turn,
// so start a fresh exclusion cycle from here rather than leaving the pick
// permanently empty.
function pickDreamOfDay(feed, usedIds) {
  var pool = feed.filter(function (d) { return usedIds.indexOf(d.id) === -1; });
  var recycled = false;
  if (!pool.length && feed.length) { pool = feed; recycled = true; }
  var best = null;
  pool.forEach(function (d) {
    if (!best || (d.likes || 0) > (best.likes || 0)) best = d;
  });
  return { pick: best, recycled: recycled };
}

// Loads (and, once per calendar day, advances) the shared Dream of the Day
// pick. Deliberately just a deterministic function of shared state (today's
// date + the feed's current likes + the exclusion history) rather than any
// kind of locking -- concurrent requests on the first hit of a new day will
// all independently compute the *same* pick from the same inputs, so the
// redundant writes are harmless, not a real race condition.
async function resolveDreamOfDay(store, feed) {
  var state = (await store.get(DOD_KEY, { type: 'json' })) || { date: null, dreamId: null, usedIds: [] };
  var today = todayUTC();
  if (state.date === today) return state.dreamId;

  var result = pickDreamOfDay(feed, state.usedIds || []);
  var usedIds = result.recycled ? [] : (state.usedIds || []);
  var newState = {
    date: today,
    dreamId: result.pick ? result.pick.id : null,
    usedIds: result.pick ? usedIds.concat([result.pick.id]) : usedIds
  };
  await store.setJSON(DOD_KEY, newState);
  return newState.dreamId;
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'method_not_allowed' }) };
  }

  try {
    connectLambda(event);
    var store = getStore('dreamtube-feed');
    var feed = (await store.get('feed-index', { type: 'json' })) || [];
    // Dream of the Day is a highlight, not core functionality -- if picking/
    // persisting it fails for any reason, the feed itself should still load
    // rather than taking the whole request down with it.
    var dreamOfDayId = null;
    try { dreamOfDayId = await resolveDreamOfDay(store, feed); }
    catch (e) { /* feed still returns below without a Dream of the Day */ }
    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ feed: feed, dreamOfDayId: dreamOfDayId }) };
  } catch (e) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'feed_fetch_failed: ' + (e && e.message) }) };
  }
};
