// netlify/functions/lib/site-origin.js
//
// One resolver for "what is this app's own public https origin", for code
// that emits a url someone will open OUTSIDE the request that produced it
// -- email bodies, share links, OG tags. Added for tracker item
// for-product-bug-two-blank-square-emails--3fvxvc.
//
// THE 08-08 CANONICAL-DOMAIN RULE (founder standing rule): "if we don't
// need a Netlify URL, never link to any Netlify URL." Every outbound
// user-facing link resolves to the canonical origin,
// https://dreamtube.life -- NEVER echoed back from the inbound request's
// Host header. Mixed-hostname links are a live bug family, not
// cosmetics: localStorage/auth/session identity is per-origin, so a
// user who browses on one hostname and clicks an emailed link to the
// other lands in a "logged-out" browser identity. One canonical origin
// in every outbound link ends that class of bug. The request-host
// precedence tier this file used to have (see git history) was removed
// for exactly that reason; a deploy-preview-triggered email carrying a
// production link is the INTENDED behavior under this rule, not a bug.
//
// THE BUG THIS ORIGINALLY EXISTED TO FIX. Every emailed url in this
// codebase was built as `'https://' + (x-forwarded-host || host)`,
// reconstructing the origin from the INBOUND REQUEST. That WAS this
// codebase's convention for request-driven senders
// (request-password-reset.js, lib/dream-share-token.js,
// lib/pending-dream-token.js, ...) until the 08-08 canonical rule above
// retired it for every user-facing link -- those senders now all call
// emailOrigin() here. The convention survives only where the visitor's
// browser must round-trip back to the origin it left from
// (facebook-oauth-callback.js, the Dodo checkout functions).
//
// But since commit de124a5 (2026-08-04) the only path that sends the
// automatic first-dream retention email is send-pending-first-dream-
// emails.js -- a SCHEDULED function. A scheduled invocation has no public
// inbound request behind it: Netlify's own scheduler ("Netlify Clockwork")
// calls the function internally, so there is no visitor-facing Host to
// reconstruct. `'https://' + ''` collapsed to the bare string `'https://'`,
// and lib/email-layout.js's shell emitted
//
//     <img src="https:///assets/logo-v4.png" width="40" height="40" />
//
// which a url parser resolves to the HOST `assets` -- a domain this app
// does not own. It never loads, and an <img> with an explicit
// width/height that never loads renders as exactly a 40x40 BLANK SQUARE.
// That is the blank square two real founder-received emails showed. The
// same defect emitted `https://profile.html/`, `https://create.html/` and
// a `https://.netlify/...` unsubscribe link (a broken CAN-SPAM-required
// link), and silently downgraded the real dream thumbnail to the flat-
// colour fallback banner, since lib/first-dream-email-sender.js's
// absoluteImageUrl correctly refuses to emit a relative src and production
// thumbnails ARE relative durable urls (upload-dream-thumbnail.js returns
// lib/media-rehost.js's durableUrl()).
//
// WHY A SHARED MODULE, against this codebase's own "small, self-contained
// per-file constants, not one shared module" convention: the same reason
// lib/email-layout.js documents for itself. That convention is about
// trivial one-line values cheap enough to duplicate safely. This is the
// opposite: the bug WAS four independent copies of the same one-line
// derivation (lib/email-layout.js, lib/first-dream-email-sender.js x3,
// lib/unsubscribe-token.js), each individually reasonable and all wrong in
// the same place at once. Re-fixing four copies leaves four things that
// can drift apart again. One resolver cannot.
//
// SCOPE: every outbound user-facing absolute self-link -- emailed urls
// (password reset, verification, share/claim tokens, retention emails,
// unsubscribe) and the share endpoints' OG/redirect urls. NOT in scope:
// mid-browser round trips that must return to the origin the visitor is
// actually on (facebook-oauth-callback.js, the Dodo checkout functions)
// -- those NEED the request host, because the visitor's localStorage
// session lives on the origin they left from, and machine-to-machine
// callbacks (start-pending-generation's fal webhook url), which no human
// ever sees.
//
// PRECEDENCE, highest first:
//   1. `process.env.URL` -- Netlify's own built-in "primary url of this
//      site" variable, available to every Netlify Function. In
//      production this IS https://dreamtube.life (the primary-domain
//      flip already happened -- see docs/DOMAIN_ROUTING_MATRIX.md).
//      Derived rather than hardcoded so any future primary-domain
//      change needs no code change, just Netlify's own site settings.
//   2. FALLBACK_HOST below -- only ever reached when URL is unset
//      (local dev, tests), and equal to the canonical production host.
//
// The inbound request's Host header is deliberately NOT consulted --
// see the 08-08 rule above. isPublicHost is still applied to the env
// URL's host (guarding against a localhost URL in netlify dev), and
// remains exported for callers that validate hosts for other reasons.

// Allow-list, not a block-list -- see header comment. A legitimate public
// Host header is a dotted hostname (letters/digits/hyphens, at least one
// dot) with an optional :port, and nothing else. Anything with CR/LF,
// spaces, slashes, quotes or angle brackets fails this outright, without
// having to enumerate what is dangerous.
var PUBLIC_HOST_RE = /^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+(:[0-9]{1,5})?$/;

// Loopback/link-local/private literals that CAN satisfy PUBLIC_HOST_RE
// (e.g. `127.0.0.1`, `10.0.0.4`) but are unreachable from a real inbox.
// Bare `localhost` (no dot) is already rejected by PUBLIC_HOST_RE; it is
// listed anyway so this reads as the complete rule rather than relying on
// a side effect of the regex.
var NON_PUBLIC_HOST_RE = /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.)/i;

// Only ever used when process.env.URL is unset (local dev / tests) --
// equal to the canonical production host (08-08 rule), so local/test
// behavior matches production exactly rather than introducing a second
// answer.
var FALLBACK_HOST = 'dreamtube.life';

/** True when `host` is a hostname a stranger's mail client could actually reach. */
function isPublicHost(host) {
  if (typeof host !== 'string' || !host) return false;
  if (!PUBLIC_HOST_RE.test(host)) return false;
  if (NON_PUBLIC_HOST_RE.test(host)) return false;
  return true;
}

/** The configured site host (Netlify's own `URL`), or FALLBACK_HOST. Read per call, not cached at module load, so tests and a re-configured environment both see the current value. */
function configuredHost() {
  var siteUrl = process.env.URL;
  if (siteUrl) {
    try {
      var parsed = new URL(siteUrl);
      if (isPublicHost(parsed.host)) return parsed.host;
    } catch (e) { /* fall through to FALLBACK_HOST */ }
  }
  return FALLBACK_HOST;
}

/**
 * This app's own CANONICAL public https origin, with no trailing slash,
 * safe to prefix onto an emailed path. NEVER returns an empty-host
 * origin -- see this file's header comment. The `event` parameter is
 * retained (and ignored) for signature stability across the ~10 call
 * sites and so a future caller-specific need can be reintroduced
 * without touching every caller; `event` may be null/undefined/
 * header-less (exactly what a scheduled invocation looks like).
 */
function emailOrigin(event) {
  return 'https://' + configuredHost();
}

module.exports = { emailOrigin, isPublicHost, FALLBACK_HOST, PUBLIC_HOST_RE };
