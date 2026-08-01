// netlify/functions/lib/test-identity.js
//
// Server-side twin of js/store.js's founder/test-identity normalization
// (normalizeIdentityBase / isKnownFounderOrInternalBase / the founder-alias
// half of isTestOrInternalIdentity) — tracker item
// for-product-founder-alias-exclusion-by-p-f7qyxo (08-01). The founder's
// standing rule: any identity matching one of these base names is his own
// test traffic and must be excluded from real-user analytics/metrics,
// matched by NORMALIZED BASE NAME rather than an exact-string list, so a
// numbered throwaway account he creates later (e.g. ronbrightman8877,
// already a real example in this codebase's data) or a Gmail dot-variant of
// one of his real inboxes (Gmail ignores dots in the local part —
// ri.chardharrisman@gmail.com and richardharrisman@gmail.com are the same
// real inbox) is caught without a code change every time he creates one.
//
// WHY A DUPLICATE FILE, NOT A SHARED REQUIREABLE MODULE: this codebase does
// have one precedent for a plain <script>-loaded client file that Netlify
// Functions also require() directly (js/analytics-config.js, via its
// UMD-lite `typeof module !== 'undefined'` guard — see that file's own
// header). That precedent was deliberately NOT reused here. The function
// this file mirrors, isTestOrInternalIdentity, is called synchronously,
// unguarded, deep inside js/store.js's identifyForAnalytics — a path this
// codebase repeatedly documents as "analytics must never break auth" (see
// identifyForAnalytics's own header). identifyForAnalytics currently has NO
// dependency on any cross-file global (analytics-config.js's own constants
// are only ever referenced from store.js in a comment, never live code —
// verified before this change), and js/store.js is the one script every
// page that has ANY identify-driven flow already loads reliably. Wiring in
// a new cross-file dependency there would mean every one of the ~17 pages
// that load js/store.js would need js/analytics-config.js's <script> tag
// placed before it too (one page, admin.html, currently doesn't have it at
// all) — and forgetting that on any future new page turns "PostHog
// mis-tags a real user" (today's bug) into "signup/login throws and breaks
// for that page's users" (a strictly worse bug), for zero runtime benefit
// server-side today: this repo currently has NO existing server-side path
// that does equivalent founder-username filtering to retrofit (grepped for
// hardcoded test-account lists across netlify/functions/ before writing
// this — posthog-capture.js's own "TEST-ENVIRONMENT GUARD" is a different
// concern entirely, whether the *process* is a local test run, not whether
// a given *distinct_id* belongs to the founder).
//
// So: js/store.js keeps its own copy (self-contained, zero new cross-file
// risk), and this file is the canonical, requireable copy for whichever
// Netlify Function needs the same predicate next — e.g. a future
// captureEvent() caller that wants to tag a server-fired event the same
// way identifyForAnalytics tags a client-fired one. This mirrors
// derive-username.js's own precedent exactly (see that file's header):
// two client-side copies (there: start.html/wizard.html; here: none other
// than store.js) stay hand-written because a browser page can't require()
// anything, while a canonical server-side copy exists for whatever
// server-side callers need it, and a test (see
// test/founder-alias-exclusion-behavioral.test.js) pulls BOTH
// implementations' source out of their real files and asserts they agree
// on the same fixture inputs, so the two can never silently drift apart.
//
// KNOWN_TEST_OR_INTERNAL_BASE_NAMES: richardharrisman, jackflaa,
// ronbrightman are the founder's own real identities per his 08-01
// standing rule, stored as their bare base name. benbrightman14 (his son's
// confirmed, founder-approved secondary account — see
// owner-topup-tokens.js's own header comment on tracker item
// for-product-extend-owner-top-up-with-a-t-2hmopn) is stored here as its
// REDUCED base, "benbrightman": normalizeIdentityBase strips a trailing
// numeric suffix from EVERY identity it checks — that's the whole point,
// see below — so keeping the literal "benbrightman14" in this list would
// never match anything (the normalized form of the input "benbrightman14"
// is "benbrightman", not "benbrightman14") and would silently stop
// matching the very account this list exists to cover. Storing the
// already-reduced base keeps this list internally consistent with the same
// rule applied to every other entry, rather than carving out one
// inconsistent exact-match exception.
var KNOWN_TEST_OR_INTERNAL_BASE_NAMES = {
  richardharrisman: true,
  jackflaa: true,
  ronbrightman: true,
  benbrightman: true
};

/**
 * Normalizes a username or email to the "base name"
 * KNOWN_TEST_OR_INTERNAL_BASE_NAMES is matched against: lowercase, email
 * domain dropped (compare on the local part only — Gmail's
 * dot-insensitivity is a local-part rule), dots stripped
 * (ri.chardharrisman -> richardharrisman), then any trailing run of digits
 * stripped (ronbrightman8877 -> ronbrightman). Digits/dots anywhere OTHER
 * than a trailing run, or in the domain, are left alone — this is
 * base-name normalization, not general sanitizing, so it doesn't
 * over-match an unrelated real user whose name merely contains a digit or
 * a dot (e.g. "sonbrightman99" strips to "sonbrightman", which still
 * compares unequal to "ronbrightman").
 *
 * MUST stay byte-for-byte identical to js/store.js's own
 * normalizeIdentityBase — see this file's header comment for why this is
 * a deliberate duplicate rather than a shared require()d module, and
 * test/founder-alias-exclusion-behavioral.test.js for the parity check
 * that enforces it.
 */
function normalizeIdentityBase(usernameOrEmail) {
  var s = String(usernameOrEmail == null ? '' : usernameOrEmail).toLowerCase();
  var at = s.indexOf('@');
  if (at !== -1) s = s.slice(0, at);
  s = s.replace(/\./g, '');
  s = s.replace(/\d+$/, '');
  return s;
}

/** True if `raw` (a username or email) normalizes to one of the founder's known base names — see KNOWN_TEST_OR_INTERNAL_BASE_NAMES above. */
function isKnownFounderOrInternalBase(raw) {
  return !!KNOWN_TEST_OR_INTERNAL_BASE_NAMES[normalizeIdentityBase(raw)];
}

module.exports = {
  KNOWN_TEST_OR_INTERNAL_BASE_NAMES: KNOWN_TEST_OR_INTERNAL_BASE_NAMES,
  normalizeIdentityBase: normalizeIdentityBase,
  isKnownFounderOrInternalBase: isKnownFounderOrInternalBase
};
