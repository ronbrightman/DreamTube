// netlify/functions/lib/email-domain-check.js
//
// Lightweight, no-vendor email deliverability heuristic: does this
// email's domain look like it can receive mail at all? Added for
// check-email.js (tracker item
// for-product-signup-email-micro-step-foun-ns8uve): the founder asked for
// "format + a lightweight existence check (domain/MX-level; no
// heavyweight vendor without founder approval)" to run BEFORE the
// password field appears on start.html's/wizard.html's signup screens, so
// an obvious typo ("...@gmial.con") is caught inline instead of only
// surfacing once the real, billed pending-generation call and the actual
// signup round trip have already fired.
//
// Deliberately built on Node's own built-in `dns` module, not a paid
// third-party verification API (Kickbox, ZeroBounce, etc.) or even a
// public DNS-over-HTTPS provider (Cloudflare/Google) — the former needs a
// vendor decision this codebase's standing approval gate reserves for the
// founder, the latter would trade one external dependency (DNS) for
// another (a specific HTTPS host) for no real benefit, since outbound DNS
// resolution is already available to any Node process, including a
// Netlify Function. This is a heuristic, not a guarantee: a domain with
// valid MX/A records can still bounce every message it receives, and a
// domain with a slow/flaky DNS answer is treated as "unknown, proceed"
// (see FAIL-OPEN below) rather than blocked — same resilient-fallback
// posture as check-email.js's own availability check and this codebase's
// generation-guardrail checks generally.
//
// WHAT COUNTS AS DELIVERABLE: an MX record (the normal case for any real
// mail domain), OR — per RFC 5321 §5.1's documented fallback for domains
// with no MX record — a plain A/AAAA record, since some small/personal
// domains route mail straight to their web server's address with no
// dedicated MX entry. Only a domain with NEITHER is reported as
// undeliverable.
//
// FAIL-OPEN: any DNS outcome other than a clean "this name genuinely does
// not exist" (ENOTFOUND/ENODATA) — a timeout, a resolver error, anything
// else — resolves `true` (proceed), never blocking a real signup over
// this ancillary check's own infrastructure hiccup. Only a confirmed
// "no MX and no A/AAAA record" resolves `false`.
//
// TIMEOUT: capped at DNS_TIMEOUT_MS (default 2500ms) per lookup so a slow
// or unreachable resolver can never meaningfully delay the signup screen
// — the caller is already showing its own "Checking…" state for however
// long this takes, and this check runs in the tight window before a
// password field is revealed, not in the background.

var dns = require('dns');
var dnsPromises = dns.promises;

var DNS_TIMEOUT_MS = 2500;

function isNotFoundError(err) {
  return !!err && (err.code === 'ENOTFOUND' || err.code === 'ENODATA');
}

function withTimeout(promise, ms) {
  return new Promise(function (resolve, reject) {
    var timer = setTimeout(function () {
      var err = new Error('email_domain_check_timeout');
      err.code = 'ETIMEOUT';
      reject(err);
    }, ms);
    promise.then(
      function (v) { clearTimeout(timer); resolve(v); },
      function (e) { clearTimeout(timer); reject(e); }
    );
  });
}

/**
 * @param {string} domain - the portion of an email address after '@',
 *   already trimmed/lowercased by the caller. An empty/falsy domain is
 *   treated as undeliverable (there's nothing to look up).
 * @returns {Promise<boolean>} true = deliverable (has MX, or falls back
 *   to a plain A/AAAA record) or the check couldn't run conclusively
 *   (fail-open); false = confirmed no MX AND no A/AAAA record for this
 *   domain.
 */
async function isDomainDeliverable(domain) {
  if (!domain) return false;

  try {
    var mxRecords = await withTimeout(dnsPromises.resolveMx(domain), DNS_TIMEOUT_MS);
    if (mxRecords && mxRecords.length > 0) return true;
    // No error, but an empty MX list -- fall through to the A/AAAA
    // fallback below, same as an ENODATA would.
  } catch (e) {
    if (!isNotFoundError(e)) return true; // unexpected infra error -- fail open
    // else: confirmed no MX record -- fall through to the A/AAAA fallback.
  }

  try {
    var aRecords = await withTimeout(dnsPromises.resolve4(domain), DNS_TIMEOUT_MS);
    if (aRecords && aRecords.length > 0) return true;
  } catch (e) {
    if (!isNotFoundError(e)) return true; // unexpected infra error -- fail open
    // else: no A record either -- try AAAA before giving up.
  }

  try {
    var aaaaRecords = await withTimeout(dnsPromises.resolve6(domain), DNS_TIMEOUT_MS);
    return !!(aaaaRecords && aaaaRecords.length > 0);
  } catch (e) {
    if (!isNotFoundError(e)) return true; // unexpected infra error -- fail open
    return false; // confirmed: no MX, no A, no AAAA -- this domain cannot receive mail
  }
}

module.exports = { isDomainDeliverable: isDomainDeliverable };
