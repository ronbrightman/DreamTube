// netlify/functions/lib/geo.js
//
// Reads the visitor's geolocation off a Netlify Function invocation — no
// existing precedent in this codebase before this file (confirmed via
// grep across netlify/functions/ before writing this; tracker item
// for-product-cheap-generation-profile-for-yz2ina is the first caller).
//
// Netlify exposes geolocation two different ways depending on a function's
// handler signature (verified against Netlify's own docs, 2026-07-28):
// the newer `export default async (req, context) => {...}` shape gets a
// ready-made `context.geo` object, but every function in this codebase
// (this one included) uses the classic Lambda-compatible
// `exports.handler = async function (event) {...}` shape (see
// generate-video.js, rate-limit.js's clientIp, etc. — no build step, no
// per-invocation context object wired up anywhere here), which does NOT
// receive that context.geo convenience. The only avenue actually
// available in that shape is the raw `x-nf-geo` request header Netlify's
// edge attaches to every Function invocation regardless of handler style:
// base64-encoded JSON, same fields context.geo would give you, e.g.
// {"city":"Tel Aviv","country":{"code":"IL","name":"Israel"},...}.
//
// Best-effort, never throws — a missing/malformed header (local dev,
// GENERATION_MOCK_MODE test runs, a future Netlify format change) simply
// resolves to a null country code rather than breaking the request. Every
// caller of resolveCountryCode treats "unknown" as "not a match" for
// whatever it's gating (see generate-video.js's/start-pending-
// generation.js's resolveGenerationProfile) — a geo-parsing failure can
// only ever push a request toward the FULL-cost path, never silently
// toward the cheap one, so this fails open in the safe direction (more
// cost, never less) rather than the unsafe one.

/** Decodes x-nf-geo (base64 JSON) and returns just the ISO country code, or null if absent/unparseable. */
function resolveCountryCode(event) {
  var headers = (event && event.headers) || {};
  var raw = headers['x-nf-geo'] || headers['X-Nf-Geo'];
  if (!raw || typeof raw !== 'string') return null;
  try {
    var decoded = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    return (decoded && decoded.country && decoded.country.code) || null;
  } catch (e) {
    return null;
  }
}

module.exports = { resolveCountryCode: resolveCountryCode };
