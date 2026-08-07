// netlify/functions/lib/site-origin.js
//
// One resolver for "what is this app's own public https origin", for code
// that emits a url someone will open OUTSIDE the request that produced it
// -- i.e. email bodies. Added for tracker item
// for-product-bug-two-blank-square-emails--3fvxvc.
//
// THE BUG THIS EXISTS TO FIX. Every emailed url in this codebase was built
// as `'https://' + (x-forwarded-host || host)`, reconstructing the origin
// from the INBOUND REQUEST. That is correct and remains this codebase's
// convention for request-driven senders (request-password-reset.js,
// lib/dream-share-token.js, lib/pending-dream-token.js,
// create-checkout-session-dodo.js, ...) -- each of those runs under a real
// public HTTP request whose Host genuinely IS the origin the recipient
// should come back to, which is also what keeps deploy previews and the
// second domain (dreamtube.life vs dreamtube1.netlify.app) self-consistent.
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
// SCOPE, deliberately narrow: this file is for EMAIL urls only. The
// request-driven, in-request callers listed above are not changed -- they
// are not broken, they always run under a real public request, and
// rewriting them would be unrelated risk in a bugfix. share-dream.js
// already independently arrived at this exact pattern for its own
// (different) reason -- CRLF safety on a raw Location header -- including
// the same `process.env.URL`-derived fallback; this generalises that
// precedent rather than inventing one.
//
// PRECEDENCE, highest first:
//   1. The request's own `x-forwarded-host || host`, when it looks like a
//      genuine public hostname (see isPublicHost). Keeps every request-
//      driven sender behaving exactly as it does today, deploy previews
//      and both live domains included.
//   2. `process.env.URL` -- Netlify's own built-in "primary url of this
//      site" variable, available to every Netlify Function. Derived rather
//      than hardcoded so a future primary-domain switch
//      (dreamtube1.netlify.app -> dreamtube.life) needs no code change,
//      just Netlify's own site settings. Same reasoning share-dream.js's
//      FALLBACK_HOST already documents.
//   3. FALLBACK_HOST below -- only ever reached when URL is unset (local
//      dev, tests), and equal to today's real production primary host.
//
// WHY REJECT rather than merely check-for-empty. Two separate reasons, and
// the first is the load-bearing one:
//   - It is NOT independently confirmable from this sandbox what Netlify's
//     production scheduler puts in `host` for a scheduled invocation. The
//     documented local-dev value is `localhost:8888` (via the
//     `Netlify Clockwork` user-agent), which is every bit as unusable in a
//     stranger's inbox as an empty string is -- a `https://localhost:8888/
//     profile.html` link in a real email is just a different flavour of
//     the same bug. Falling back on "not a usable PUBLIC origin" rather
//     than on "" alone makes the fix correct either way, without needing
//     to pin down a value this sandbox cannot observe.
//   - Host/X-Forwarded-Host is client-suppliable. It has always been
//     escaped on its way into email HTML, so this was not an injection
//     hole, but validating an allow-list here means a hostile header can
//     no longer put an attacker's domain in front of a recipient inside an
//     email that genuinely came from us. Same allow-list-not-blocklist
//     reasoning share-dream.js's HOSTNAME_RE documents.

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
// equal to today's real production primary host, so this matches current
// production behavior exactly rather than introducing a third answer.
var FALLBACK_HOST = 'dreamtube1.netlify.app';

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
 * This app's own public https origin, with no trailing slash, safe to
 * prefix onto an emailed path. NEVER returns an empty-host origin -- see
 * this file's header comment. `event` may be null/undefined/header-less
 * (exactly what a scheduled invocation looks like to this code).
 */
function emailOrigin(event) {
  var headers = (event && event.headers) || {};
  var host = headers['x-forwarded-host'] || headers.host;
  return 'https://' + (isPublicHost(host) ? host : configuredHost());
}

module.exports = { emailOrigin, isPublicHost, FALLBACK_HOST, PUBLIC_HOST_RE };
