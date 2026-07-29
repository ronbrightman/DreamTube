// netlify/functions/verify-pending-claim.js
//
// POST { pendingId, token } -> verifies the claim token from the
// abandoned-dream re-engagement email's link (see
// lib/pending-dream-token.js, dream-webhook.js's sendReadyEmail) and, if
// valid, returns the pending dream's public-safe fields for claim-dream.html
// to render: { caption, storyText, style, videoUrl, email, status }.
// storyText (tracker item for-product-split-prompttext-storytext-f-yt5kc7)
// is the human-readable dream description — claim-dream.html shows this
// (falling back to caption for a record predating this field), never the
// engineered promptText/caption. Read-only from
// the caller's perspective — this does NOT mark anything claimed (see
// claim-pending-generation.js for that, called separately once the
// visitor actually finishes signing up on claim-dream.html) and does not
// consume the token (see lib/pending-dream-token.js's `peek` default —
// a "your dream is ready" email link should stay revisitable).
//
// Error codes:
//   E1 method_not_allowed
//   E2 invalid_json
//   E3 pending_id_and_token_required
//   E4 invalid_or_expired
//   E5 not_ready — the token is valid but the generation hasn't finished
//      yet (shouldn't normally be reachable, since the email is only ever
//      sent once the record is already 'ready', but defensive against a
//      token being reused/shared before that — no video to show yet).

var pendingDreams = require('./lib/pending-dreams');
var pendingDreamToken = require('./lib/pending-dream-token');

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

  var pendingId = (payload.pendingId || '').trim();
  var token = (payload.token || '').trim();
  if (!pendingId || !token) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E3: pending_id_and_token_required' }) };
  }

  try {
    var verifyResult = await pendingDreamToken.verifyToken(event, token);
    if (!verifyResult.ok || verifyResult.pendingId !== pendingId) {
      return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'E4: invalid_or_expired' }) };
    }

    var record = await pendingDreams.get(event, pendingId);
    if (!record) {
      return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'E4: invalid_or_expired' }) };
    }
    if (record.status !== 'ready' && record.status !== 'notified' && record.status !== 'claimed') {
      return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'E5: not_ready' }) };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        pendingId: record.id,
        email: record.email,
        caption: record.caption,
        storyText: record.storyText || '',
        style: record.style,
        videoUrl: record.videoUrl,
        status: record.status
      })
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'verify_failed: ' + (e && e.message) }) };
  }
};
