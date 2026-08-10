// netlify/functions/unsubscribe-email.js
//
// GET ?email=<address>&token=<hmac> -> the one-click unsubscribe target
// every retention/marketing email's footer link points at (tracker item
// for-product-email-redesign-unsubscribe-l-16ysmp — the compliance-
// critical half: "an unsubscribe link to every outgoing template... an
// unsubscribe endpoint + suppression store honored by ALL senders").
//
// A BROWSER GET TARGET, not a JSON API — a human clicks this straight out
// of their inbox, so a successful (or failed) unsubscribe renders a small,
// self-contained confirmation page (same "return real HTML, not raw JSON,
// for a link a human just clicked" posture as share-dream.js) rather than
// a 302 elsewhere or a bare JSON body — there's no natural in-app
// destination to send someone to after unsubscribing, and no session to
// carry (this link's whole point, like verify-email-link.js's, is that it
// needs no signed-in session on the clicking device at all).
//
// RFC 8058 ONE-CLICK POST (added 2026-08-10, the "unwatched dream"
// retention-nudge round): the newer retention sends also carry the
// `List-Unsubscribe` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
// headers Gmail/Yahoo require on bulk mail. When a mail client honors those,
// it sends a machine POST (no human, no browser) to this SAME url — with
// `email`/`token` still on the query string (they're baked into the
// List-Unsubscribe url) and a `List-Unsubscribe=One-Click` form body. So
// this endpoint now ALSO accepts POST: it verifies the exact same token and
// suppresses the exact same way as GET, but returns a minimal 200 (no HTML
// page — nothing renders it). GET stays the human-facing confirmation page.
// Any non-GET/POST method is still rejected.
//
// TOKEN: `token` must be the real lib/unsubscribe-token.js HMAC signature
// for `email` — see that module's own header comment for why this is a
// stateless, deterministic HMAC rather than this codebase's usual
// random-token-in-Blobs pattern. A wrong/tampered/missing token is
// rejected WITHOUT suppressing anything — the whole point is that
// knowing an address alone must never be enough to unsubscribe it.
//
// IDEMPOTENT: unsubscribing an already-suppressed email is a harmless
// no-op that still reports success (lib/email-suppression-store.js's own
// suppress() is a plain, always-safe-to-repeat overwrite) — a user
// re-clicking an old email's link, or clicking the link in two different
// emails sent before their first click landed, must never error.
//
// Error codes (this file's own small namespace) — a human never sees the
// bare code itself (the page always shows a plain-language message
// instead, see page() below), it's only embedded as an HTML comment in
// the response body for cheap debuggability/log-grepping, same spirit as
// every other per-file error-code scheme in this codebase, just adapted
// to a browser-facing page instead of a JSON body:
//   E1 method_not_allowed
//   E2 missing_params    — no `email` and/or `token` on the query string
//   E3 invalid_token     — token doesn't verify for the given email

var emailSuppressionStore = require('./lib/email-suppression-store');
var unsubscribeToken = require('./lib/unsubscribe-token');
var emailLayout = require('./lib/email-layout');

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function page(title, message, code) {
  return (
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + esc(title) + ' — DreamTube</title></head>' +
    '<body style="margin:0;background:' + emailLayout.COLORS.void + ';font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;">' +
    (code ? '<!-- ' + esc(code) + ' -->' : '') +
    '<div style="max-width:420px;margin:60px auto;padding:32px;background:' + emailLayout.COLORS.card + ';border:1px solid ' + emailLayout.COLORS.border + ';border-radius:28px;text-align:center;color:' + emailLayout.COLORS.textPrimary + ';">' +
    '<h1 style="font-size:18px;margin:0 0 12px;">' + esc(title) + '</h1>' +
    '<p style="font-size:14px;line-height:1.6;color:' + emailLayout.COLORS.textMuted + ';margin:0;">' + esc(message) + '</p>' +
    '</div></body></html>'
  );
}

function htmlResponse(statusCode, title, message, code) {
  return { statusCode: statusCode, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: page(title, message, code) };
}

exports.handler = async function (event) {
  var method = event.httpMethod;
  if (method !== 'GET' && method !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'E1: method_not_allowed' }) };
  }

  // Both the human GET and the RFC 8058 one-click POST carry `email`/`token`
  // on the query string (they're baked into the List-Unsubscribe url) — see
  // this file's header comment. The POST additionally has a
  // `List-Unsubscribe=One-Click` form body, which we don't need to read: the
  // token in the url is the whole authorization.
  var query = (event.queryStringParameters || {});
  var email = (query.email || '').trim();
  var token = (query.token || '').trim();

  // A machine POST gets a minimal JSON body, never the human confirmation
  // page (nothing renders it); a human GET gets the page.
  var isOneClickPost = (method === 'POST');

  if (!email || !token) {
    if (isOneClickPost) return { statusCode: 400, body: JSON.stringify({ error: 'E2: missing_params' }) };
    return htmlResponse(400, 'Invalid link', 'This unsubscribe link is missing some information. Please use the link from your original email.', 'E2: missing_params');
  }

  if (!unsubscribeToken.verifyToken(email, token)) {
    if (isOneClickPost) return { statusCode: 400, body: JSON.stringify({ error: 'E3: invalid_token' }) };
    return htmlResponse(400, 'Invalid link', 'This unsubscribe link isn\'t valid. Please use the link from your original email.', 'E3: invalid_token');
  }

  await emailSuppressionStore.suppress(event, email);

  if (isOneClickPost) return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  return htmlResponse(200, 'You\'re unsubscribed', 'You won\'t get any more of these emails from DreamTube. If this was a mistake, just start a new dream and we\'ll pick it back up.');
};
