// netlify/functions/claim-pending-generation.js
//
// POST { pendingId, email } -> marks a dream-builder-wizard pending
// generation (see lib/pending-dreams.js) as 'claimed'. Called from
// wizard.html the instant a real signup succeeds for the SAME browser
// session that started the pending generation (see
// start-pending-generation.js) — this is the "generate during signup"
// happy path completing normally, and this call's whole job is telling
// dream-webhook.js "don't send the abandoned-dream re-engagement email
// for this one — they already made it in on their own." Also called from
// claim-dream.html once a visitor arriving via the re-engagement email
// actually saves the dream to an account. Best-effort from the caller's
// side too: neither caller blocks its own flow on this call's result (a
// failure here just means a possible, harmless duplicate "your dream is
// ready" email later if the fal webhook fires after this call was lost —
// not a broken signup/claim).
//
// OWNERSHIP CHECK (review finding, fixed): `email` is REQUIRED and MUST
// match the pending record's own email (case-insensitively) before this
// will actually claim anything — see lib/pending-dreams.js's markClaimed
// doc comment. Before this, `pendingId` alone was accepted as sufficient
// "proof" to claim ANY record — pendingId values aren't secret capability
// tokens (they're returned to the browser in start-pending-generation.js's
// plain JSON response and travel through client-side code/URLs), so
// anyone who obtained or guessed one could silently mark an unrelated
// person's pending dream 'claimed', permanently suppressing THEIR real
// re-engagement email with no way for them to know why it never arrived.
// Requiring the email the record was actually created under raises the
// bar to "you'd also have to know/guess the exact email," consistent with
// how every other identity check in this codebase (entitlements.js,
// account-store.js) already treats email as the anchor of "who this is
// about." A mismatch is reported back as `claimed:false` (not a 4xx) —
// same "don't leak which specific check failed" posture other endpoints
// in this codebase take for auth-adjacent mismatches.
//
// Error codes:
//   E1 method_not_allowed
//   E2 invalid_json
//   E3 pending_id_required
//   E4 email_required

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
  var email = (payload.email || '').trim();
  if (!email) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E4: email_required' }) };
  }

  try {
    var result = await pendingDreams.markClaimed(event, pendingId, email);
    // Unknown pendingId (already cleaned up, or never existed — e.g. the
    // pre-signup generation call itself failed and no record was ever
    // usably created), an email mismatch (see header comment), and a
    // genuine transition failure (lost a concurrent race — see
    // lib/pending-dreams.js) are all reported the same non-error way —
    // none of them are worth surfacing as a hard failure to a caller that
    // treats this as fire-and-forget either way.
    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        found: !!result.record,
        claimed: result.ok
      })
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'claim_failed: ' + (e && e.message) }) };
  }
};
