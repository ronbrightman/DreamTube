// netlify/functions/claim-pending-generation.js
//
// POST { pendingId } -> marks a dream-builder-wizard pending generation
// (see lib/pending-dreams.js) as 'claimed'. Called from wizard.html the
// instant a real signup succeeds for the SAME browser session that
// started the pending generation (see start-pending-generation.js) — this
// is the "generate during signup" happy path completing normally, and
// this call's whole job is telling dream-webhook.js "don't send the
// abandoned-dream re-engagement email for this one — they already made it
// in on their own." Best-effort from the caller's side too: wizard.html
// fires this and does not block the signup flow on its result (a failure
// here just means a possible, harmless duplicate "your dream is ready"
// email later if the fal webhook fires after this call was lost — not a
// broken signup).
//
// Error codes:
//   E1 method_not_allowed
//   E2 invalid_json
//   E3 pending_id_required

var pendingDreams = require('./lib/pending-dreams');

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
  if (!pendingId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E3: pending_id_required' }) };
  }

  try {
    var record = await pendingDreams.markClaimed(event, pendingId);
    // Unknown pendingId (already cleaned up, or never existed — e.g. the
    // pre-signup generation call itself failed and no record was ever
    // usably created) is not an error worth surfacing to the signup flow
    // that's calling this fire-and-forget — same { ok:true } either way.
    return { statusCode: 200, body: JSON.stringify({ ok: true, found: !!record }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'claim_failed: ' + (e && e.message) }) };
  }
};
