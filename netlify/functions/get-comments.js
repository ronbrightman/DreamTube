// netlify/functions/get-comments.js
//
// GET ?dreamId=<id> -> { comments: [{ id, handle, text, createdAt }, ...] }
// (newest-first)
//
// Public, no-auth read half of Social Layer v2 slice 2 ("comments" —
// docs/SOCIAL_LAYER_V2_DESIGN.md, tracker item
// for-product-build-social-layer-v2-direct-34047c). Backs js/comment-sheet.js
// the same way get-feed.js backs explore.html — a bare GET, no login
// required (comments are public content on an already-public dream, same
// posture as every other read in this app's Explore/u.html surface).
//
// Deliberately returns the FULL list every time, no pagination — matches
// the design doc's own MVP scope (flat comments, no threading) and this
// app's per-dream comment volume, which is expected to stay small; add
// pagination later if a dream's comment count ever makes this a real cost
// concern (same "worth reconsidering later" posture this codebase already
// takes with several other unbounded-for-now reads).
//
// CORS: open (Access-Control-Allow-Origin: *), matching get-profile.js's
// own reasoning — this is already-public, read-only data.
//
// Error codes (local to this function):
//   E1 method_not_allowed
//   E2 dream_id_required

var { connectLambda } = require('@netlify/blobs');
var commentStore = require('./lib/comment-store');

var CORS_HEADERS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'E1: method_not_allowed' }) };
  }

  var params = event.queryStringParameters || {};
  var dreamId = (params.dreamId || '').trim();
  if (!dreamId) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'E2: dream_id_required' }) };
  }

  try {
    connectLambda(event);
    var comments = await commentStore.getComments(event, dreamId);
    // Storage order is oldest-first append order (see comment-store.js's
    // own header comment) -- the design doc's own state E asks for
    // "newest first", so reverse here rather than pushing that ordering
    // responsibility onto every caller.
    var newestFirst = comments.slice().reverse();
    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ comments: newestFirst }) };
  } catch (e) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'get_comments_failed: ' + (e && e.message) }) };
  }
};
