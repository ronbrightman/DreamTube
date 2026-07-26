// netlify/functions/get-shared-dream.js
//
// GET ?id=<dreamId>&token=<share token> -> resolves a
// lib/dream-share-token.js token minted by send-first-dream-email.js, and
// returns the dream snapshot it carries so watch.html can render it
// without the viewer needing to be logged in or the dream needing to have
// ever been published to the shared feed. See dream-share-token.js's own
// header comment for the full "why explore.html?id= can't do this
// already" reasoning.
//
// Response shapes:
//   200 { ok:true, dream: { id, ownerHandle, caption, style, videoUrl, mediaType } }
//   200 { ok:false, error:'E3: invalid_or_expired' } -- unknown/expired/mismatched token,
//                                                        or id/token missing
// Deliberately always 200 (never 404/403) for the invalid case, same
// "don't let a response shape/status leak anything about what a guess did
// or didn't match" posture as request-password-reset.js -- there's no
// legitimate reason for a caller to distinguish "wrong token" from
// "expired token" from "malformed request" here, and no enumeration value
// in doing so (dreamId alone, without the matching random token, reveals
// nothing).
//
// Error codes (this file's own small namespace):
//   E1 method_not_allowed
//   E2 missing_params -- id or token not supplied
//   E3 invalid_or_expired

var dreamShareToken = require('./lib/dream-share-token');

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'E1: method_not_allowed' }) };
  }

  var params = event.queryStringParameters || {};
  var id = params.id;
  var token = params.token;
  if (!id || !token) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'E2: missing_params' }) };
  }

  try {
    var result = await dreamShareToken.verifyToken(event, id, token);
    if (!result.ok) {
      return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'E3: invalid_or_expired' }) };
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true, dream: result.dream }) };
  } catch (e) {
    console.error('get-shared-dream: unexpected error', e);
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'E3: invalid_or_expired' }) };
  }
};
