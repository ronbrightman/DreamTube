// netlify/functions/share-dream.js
//
// GET ?id=<dreamId> -> serves a small HTML page carrying real og: meta
// tags for that dream, so pasting a DreamTube share link into WhatsApp/
// iMessage/Facebook finally shows a real preview card (title/image)
// instead of a bare URL — the researched gap driving tracker item
// for-product-build-share-mini-sheet-share-r42tc4: zero og: tags existed
// anywhere in this app before this file.
//
// Looks the dream up the same way get-feed.js already does — the shared
// "dreamtube-feed" Blobs store's "feed-index" blob (the same array
// publish-dream.js/like-dream.js maintain), since a shareable dream is by
// definition one that's already been published to that feed. An
// unpublished/never-published/deleted dream simply won't be found here —
// same as it wouldn't render on explore.html?id=... either.
//
// This page is ONLY ever meant to be scraped by a link-preview bot
// (WhatsApp/iMessage/Facebook's crawler reads <head> meta tags straight
// off the raw HTML response, without executing JS or following a
// meta-refresh) — a real human visitor is redirected to the actual
// explore.html?id=... page immediately via a meta-refresh AND a JS
// location.replace fallback, so this is never a page anyone actually
// looks at. js/share-sheet.js's "Share link" option now points here
// instead of straight at explore.html?id=..., so a pasted link carries a
// preview card.
//
// mediaType 'video' dreams (and any dream missing its own image) fall
// back to a static branded image (assets/logo-v4.png) — no poster-frame
// extraction exists in this codebase yet; a static fallback is explicitly
// in-scope for v1 per this feature's own spec.
//
// Missing/deleted dream id (or no id at all): redirects (302) straight to
// explore.html with a ?notice=dream_gone query param explore.html's own
// script reads once (and strips) to show a gentle toast — never a bare
// error page.
//
// Error codes (this file's own small namespace):
//   E1 method_not_allowed

var { connectLambda, getStore } = require('@netlify/blobs');

var FALLBACK_IMAGE_PATH = '/assets/logo-v4.png';
var GENERIC_DESCRIPTION = 'Create your own AI dream video on DreamTube';

// Used only when x-forwarded-host/host fails HOSTNAME_RE below -- this
// function's own real production host, so a rejected/malformed header still
// produces a working redirect/preview rather than an empty-host URL.
//
// Derived from Netlify's own built-in `URL` env var (every Netlify
// Function gets this automatically -- the site's primary URL, e.g.
// `https://dreamtube1.netlify.app` today) rather than a hardcoded literal,
// so a future primary-domain switch (dreamtube1.netlify.app -> dreamtube.life)
// updates this fallback with zero code change -- just Netlify's own site
// settings. The literal below only ever fires if URL is unset (e.g. local
// dev/tests), matching today's real production behavior exactly.
var FALLBACK_HOST = (function () {
  var siteUrl = process.env.URL;
  if (siteUrl) {
    try { return new URL(siteUrl).host; } catch (e) { /* fall through */ }
  }
  return 'dreamtube1.netlify.app';
})();

// Allow-list, not a block-list: a legitimate Host/X-Forwarded-Host header is
// just a hostname (letters/digits/dots/hyphens) with an optional :port --
// nothing else ever needs to appear there. Rejecting via this whitelist,
// rather than trying to blocklist "\r\n and other bad stuff", is what keeps
// this safe against CR/LF (header/response-splitting) or any other
// control/special character without having to enumerate every dangerous one.
var HOSTNAME_RE = /^[a-zA-Z0-9.-]+(:[0-9]{1,5})?$/;

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Same `x-forwarded-host || host` pattern every other emailed/shared-link
 * function in this codebase uses (lib/dream-share-token.js,
 * request-password-reset.js, create-checkout-session-dodo.js) -- but this is
 * the first place in the app that also feeds the result RAW into a raw HTTP
 * response header (the `Location` header built by redirectTo(), below), not
 * just into escaped HTML/JSON/email-body content like those other call
 * sites. A host header containing `\r`/`\n` fed straight into a `Location`
 * header is a header/response-splitting (CRLF injection) surface, so unlike
 * those other call sites this one validates the header against HOSTNAME_RE
 * before trusting it, falling back to FALLBACK_HOST when it doesn't look
 * like a real hostname.
 */
function siteOrigin(event) {
  var host = event.headers['x-forwarded-host'] || event.headers.host;
  if (typeof host !== 'string' || !HOSTNAME_RE.test(host)) {
    host = FALLBACK_HOST;
  }
  return 'https://' + host;
}

function redirectTo(location) {
  return { statusCode: 302, headers: { Location: location }, body: '' };
}

/**
 * Safe pattern for embedding a JSON value inside an inline <script> block:
 * JSON.stringify only escapes quotes/backslashes/control chars per the JSON
 * spec, NOT `<` or `>` -- so a raw JSON.stringify(...) result can still
 * contain a literal `</script>` sequence that breaks out of the tag early.
 * canonicalUrl is built from siteOrigin(event), which is itself derived
 * directly from the client-suppliable x-forwarded-host/host request header
 * with zero escaping -- so this is a real injection vector, not just theory.
 * Escaping `<`/`>` alone is sufficient: the browser's HTML tokenizer looks
 * for a literal less-than sign followed by "/script" to end the tag, so
 * replacing every literal `<`/`>` with its \uXXXX JS escape (a JS engine
 * decodes these back to the original characters at runtime, so the
 * resulting URL string used by location.replace is unaffected) already
 * prevents any `</script>` sequence from surviving in the raw HTML
 * response.
 */
function jsonForInlineScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e');
}

function renderPreviewPage(dream, origin) {
  var canonicalUrl = origin + '/explore.html?id=' + encodeURIComponent(dream.id);
  var title = dream.caption ? dream.caption : 'A dream on DreamTube';
  var image = (dream.mediaType !== 'video' && dream.imageUrl) ? dream.imageUrl : (origin + FALLBACK_IMAGE_PATH);

  var html = '<!doctype html>\n' +
    '<html><head>\n' +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<title>' + escapeHtml(title) + '</title>\n' +
    '<meta property="og:type" content="website">\n' +
    '<meta property="og:title" content="' + escapeHtml(title) + '">\n' +
    '<meta property="og:description" content="' + escapeHtml(GENERIC_DESCRIPTION) + '">\n' +
    '<meta property="og:image" content="' + escapeHtml(image) + '">\n' +
    '<meta property="og:url" content="' + escapeHtml(canonicalUrl) + '">\n' +
    '<meta http-equiv="refresh" content="0;url=' + escapeHtml(canonicalUrl) + '">\n' +
    '</head><body>\n' +
    '<script>location.replace(' + jsonForInlineScript(canonicalUrl) + ');</script>\n' +
    '<p>Redirecting to <a href="' + escapeHtml(canonicalUrl) + '">DreamTube</a>…</p>\n' +
    '</body></html>';

  return { statusCode: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: html };
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'E1: method_not_allowed' }) };
  }

  var params = event.queryStringParameters || {};
  var id = params.id;
  var origin = siteOrigin(event);

  if (!id) {
    return redirectTo(origin + '/explore.html?notice=dream_gone');
  }

  var dream = null;
  try {
    connectLambda(event);
    var store = getStore('dreamtube-feed');
    var feed = (await store.get('feed-index', { type: 'json' })) || [];
    dream = feed.find(function (d) { return d.id === id; }) || null;
  } catch (e) {
    // Any lookup failure is treated the same as "not found" -- a share
    // link must never surface a raw 500, only ever a gentle redirect.
    dream = null;
  }

  if (!dream) {
    return redirectTo(origin + '/explore.html?notice=dream_gone');
  }

  return renderPreviewPage(dream, origin);
};
