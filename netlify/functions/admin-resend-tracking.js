// netlify/functions/admin-resend-tracking.js
//
// Owner-gated one-shot: turn ON Resend open + click tracking at the DOMAIN
// level (founder ask 2026-08-11 — the Resend dashboard's list only shows
// delivery status; opens/clicks require tracking enabled, which is OFF by
// default). Resend tracking is a per-domain setting, not a per-send flag, so
// this GETs the account's domains, finds the one our FROM address sends from
// (dreamtube.life), and PATCHes it to enable both. Idempotent — safe to re-run.
//
// Runs server-side because RESEND_API_KEY only exists in the Netlify env.
//
// POST { email: <owner> } -> { ok, domain, open_tracking, click_tracking }
// Owner-gated exactly like send-winback-batch.js (trusts POST body `email`
// against OWNER_EMAIL — the same boundary the rest of this codebase accepts).

var { normalizeEmail } = require('./lib/entitlements');

var RESEND_API = 'https://api.resend.com';
var SEND_DOMAIN = 'dreamtube.life'; // the domain FROM_ADDRESS (dreams@dreamtube.life) sends from

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'method_not_allowed' }) };
  }
  var ownerEmail = normalizeEmail(process.env.OWNER_EMAIL);
  if (!ownerEmail) return { statusCode: 500, body: JSON.stringify({ error: 'missing_owner_email' }) };

  var key = process.env.RESEND_API_KEY;
  if (!key) return { statusCode: 500, body: JSON.stringify({ error: 'missing_resend_api_key' }) };

  var payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'invalid_json' }) }; }

  var requestEmail = normalizeEmail(payload.email);
  if (!requestEmail || requestEmail !== ownerEmail) {
    return { statusCode: 403, body: JSON.stringify({ error: 'forbidden' }) };
  }

  var authHeaders = { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' };

  // 1) find the sending domain's id
  var listRes = await fetch(RESEND_API + '/domains', { headers: authHeaders });
  var listBody = await listRes.json().catch(function () { return null; });
  if (!listRes.ok || !listBody) {
    return { statusCode: 502, body: JSON.stringify({ error: 'resend_list_failed', status: listRes.status, body: listBody }) };
  }
  var domains = Array.isArray(listBody.data) ? listBody.data : (Array.isArray(listBody) ? listBody : []);
  var match = domains.find(function (d) { return d && d.name === SEND_DOMAIN; }) || domains[0];
  if (!match) {
    return { statusCode: 404, body: JSON.stringify({ error: 'no_domain_found', domains: domains.map(function (d) { return d && d.name; }) }) };
  }

  // 2) enable open + click tracking (idempotent)
  var patchRes = await fetch(RESEND_API + '/domains/' + match.id, {
    method: 'PATCH',
    headers: authHeaders,
    body: JSON.stringify({ open_tracking: true, click_tracking: true })
  });
  var patchBody = await patchRes.json().catch(function () { return null; });
  if (!patchRes.ok) {
    return { statusCode: 502, body: JSON.stringify({ error: 'resend_patch_failed', status: patchRes.status, body: patchBody }) };
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      ok: true,
      domain: match.name,
      domainId: match.id,
      open_tracking: true,
      click_tracking: true,
      resend: patchBody
    })
  };
};
