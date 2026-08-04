// netlify/functions/share-profile.js
//
// GET ?handle=<username> -> serves a small HTML page carrying real og: meta
// tags for that public profile, so pasting a "share this profile" link into
// WhatsApp/iMessage/Facebook shows a real preview card, mirroring
// netlify/functions/share-dream.js's exact approach — see that file's own
// header comment for the full "why a preview-page function, not a bare
// link" writeup; this file repeats only what differs.
//
// og:title  — `"@handle's dreams on DreamTube"` (design doc §F).
// og:description — `"N dreams, turned into video. Watch them — or create
//   your own."` (design doc §F, N = this handle's real published count).
// og:image — the profile's own avatar for now. A branded share-preview
//   card (design doc's open decision #2) is an explicit, non-blocking
//   fast-follow — see docs/SOCIAL_LAYER_V2_DESIGN.md — a bare avatar image
//   is fine for this slice. Falls back to the same static branded image
//   share-dream.js uses (assets/logo-v4.png) when there's no avatar on
//   file at all (never-synced profile, or a synced profile with no photo).
//   KNOWN LIMITATION, called out explicitly rather than silently accepted:
//   lib/profile-store.js's avatarDataUrl is a `data:image/...;base64,...`
//   URI, not a hosted `https://` URL — some real-world link-preview
//   crawlers (WhatsApp/Facebook/iMessage) may not fetch/render an og:image
//   that isn't a real URL, in which case this falls back to looking
//   broken (or just showing the generic logo) rather than the real avatar
//   for those surfaces specifically. This is exactly the gap the design
//   doc's "branded card, fast-follow" decision is meant to close (a real
//   hosted image URL, not a data URI) — accepted as this slice's own
//   scope boundary, not re-litigated here.
//
// A real human visitor is redirected to u.html?handle=... immediately via
// a meta-refresh AND a JS location.replace fallback — this page is only
// ever meant to be scraped by a link-preview bot, exactly like
// share-dream.js. A handle with nothing to show (get-profile.js's own
// `exists:false` — no profile record and no published dreams) redirects
// straight to u.html?handle=... anyway, same "never a bare error page"
// posture share-dream.js's own missing-dream case takes (redirecting to
// explore.html there) — u.html itself already renders the "hasn't set up
// their profile yet" empty state for that case, so there's no separate
// error page to build here.
//
// Error codes (this file's own small namespace, matching share-dream.js's):
//   E1 method_not_allowed

var { connectLambda, getStore } = require('@netlify/blobs');
var profileStore = require('./lib/profile-store');

var FALLBACK_IMAGE_PATH = '/assets/logo-v4.png';

function stripAt(handle) {
  var s = (typeof handle === 'string' ? handle : '').trim();
  return s.charAt(0) === '@' ? s.slice(1) : s;
}

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Same allow-list header-splitting defense as share-dream.js's own
// HOSTNAME_RE — see that file's header comment for the full "why an
// allow-list, not a block-list" reasoning. Duplicated rather than shared
// via a lib/ module: both files are small, self-contained, and this is
// the only piece either would need from the other — not worth a new
// shared module for two call sites.
var FALLBACK_HOST = (function () {
  var siteUrl = process.env.URL;
  if (siteUrl) {
    try { return new URL(siteUrl).host; } catch (e) { /* fall through */ }
  }
  return 'dreamtube1.netlify.app';
})();
var HOSTNAME_RE = /^[a-zA-Z0-9.-]+(:[0-9]{1,5})?$/;

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

// Same </script>-breakout defense as share-dream.js's own jsonForInlineScript — see that file's header comment for the full reasoning.
function jsonForInlineScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e');
}

function renderPreviewPage(handle, displayName, publishedCount, avatarUrl, origin) {
  var canonicalUrl = origin + '/u.html?handle=' + encodeURIComponent(stripAt(handle));
  var title = '@' + stripAt(handle) + "'s dreams on DreamTube";
  var description = publishedCount + (publishedCount === 1 ? ' dream' : ' dreams') + ', turned into video. Watch them — or create your own.';
  var image = avatarUrl || (origin + FALLBACK_IMAGE_PATH);

  var html = '<!doctype html>\n' +
    '<html><head>\n' +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<title>' + escapeHtml(title) + '</title>\n' +
    '<meta property="og:type" content="website">\n' +
    '<meta property="og:title" content="' + escapeHtml(title) + '">\n' +
    '<meta property="og:description" content="' + escapeHtml(description) + '">\n' +
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
  var handleParam = (params.handle || '').trim();
  var origin = siteOrigin(event);

  if (!handleParam) {
    return redirectTo(origin + '/explore.html');
  }

  var normalizedTarget = stripAt(handleParam).toLowerCase();

  try {
    connectLambda(event);
    var profile = await profileStore.getProfile(event, handleParam);

    var feedStore = getStore('dreamtube-feed');
    var feed = (await feedStore.get('feed-index', { type: 'json' })) || [];
    var publishedCount = feed.filter(function (d) {
      return d && stripAt(d.ownerHandle).toLowerCase() === normalizedTarget;
    }).length;

    // Nothing at all to show for this handle -- straight to u.html, which
    // renders its own "hasn't set up their profile yet" empty state (see
    // this file's own header comment).
    if (!profile && publishedCount === 0) {
      return redirectTo(origin + '/u.html?handle=' + encodeURIComponent(stripAt(handleParam)));
    }

    var handle = (profile && profile.handle) || stripAt(handleParam);
    var displayName = (profile && profile.displayName) || stripAt(handle);
    var avatarUrl = (profile && profile.avatarDataUrl) || null;

    return renderPreviewPage(handle, displayName, publishedCount, avatarUrl, origin);
  } catch (e) {
    // Any lookup failure degrades to the same "never a raw error page"
    // redirect share-dream.js's own catch already establishes.
    return redirectTo(origin + '/u.html?handle=' + encodeURIComponent(stripAt(handleParam)));
  }
};
