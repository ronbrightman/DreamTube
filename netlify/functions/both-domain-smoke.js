// netlify/functions/both-domain-smoke.js
//
// Reliability net, piece 1 ("both-domain smoke runs") — tracker item
// for-product-reliability-net-spec-v1-smok-x1o5zc. A scheduled Netlify
// Function (same convention as send-daily-claim-pushes.js, this repo's
// first scheduled function — see that file's own header comment for the
// "why both netlify.toml AND this file's own inline schedule() wrapper"
// belt-and-suspenders reasoning, which applies here identically) that
// hits BOTH real, currently-live production domains
// (dreamtube1.netlify.app and dreamtube.life — see
// docs/DOMAIN_ROUTING_MATRIX.md for why both are live at once today, not
// a stale leftover) for every key page and a curated set of "core"
// function endpoints, asserting a real 200 and a content marker per page
// — the same "assert content markers, not full rendering" philosophy
// test/prod-smoke/README.md already documents for this repo's other
// prod-smoke checks, just plain HTTP (no browser) since that's both
// cheaper and the only thing that can actually run inside a Netlify
// Function's own runtime (a real Chromium binary cannot — see
// test/prod-smoke/README.md's "Nightly scheduling" section, added
// alongside this file, for the full investigation of why the SEPARATE
// state-seeded-journeys piece of this same tracker item needed a
// different mechanism instead).
//
// WHAT THIS CHECKS, per domain:
//   - PAGE_CHECKS: every key page this tracker item named (home, explore,
//     create, style, result, profile, shop, media-library-x7q4), plus
//     index.html (the true entry point for Journey 2 — see
//     docs/JOURNEY_MANIFEST.md) — a real 200 AND the page's own <title>
//     text present in the response body (proves the CURRENTLY DEPLOYED
//     build actually served that page's real markup, not a 404/500/blank
//     error page mislabeled 200 — same reasoning
//     test/prod-smoke/media-serving.test.js's own header comment gives
//     for its "a 200 must actually BE the right content-type" assertion).
//     This is a static multi-page site with NO server-side auth gating on
//     the HTML itself (every page's real gating is client-side JS — see
//     CLAUDE.md) so every one of these always returns the same real
//     markup regardless of login state; this check can never see the
//     app's actual UI state, only that the real file is being served.
//   - FUNCTION_CHECKS: a curated, cheap, side-effect-free (or
//     side-effect-bounded) subset of "core" endpoints — get-feed (public
//     read, no auth), get-token-status (GET, no email = the documented
//     zero-touch fast path, see that file's own header comment),
//     get-tracker-items (public read, no auth), and check-email (POST,
//     the one call here with any real backend work — see CHECK_EMAIL_
//     PROBE_ADDRESS below for why a 429 counts as a PASS, not a failure).
//
// ALERT PATH (per this tracker item's own spec): writes every result to
// lib/smoke-status-store.js, which get-smoke-status.js exposes for
// whatever eventually reads it at a glance (the Board, a morning-report
// channel, a human/Manager checking in). Deliberately does NOT
// auto-file a tracker item on failure — this build has no owner-email
// credential to call add-tracker-item.js with (see AGENT_POLICY.md's
// "Cross-session coordination: tracker.html" section: only a human/
// Manager with the founder's owner email can write there), and BUILD.md
// explicitly says to default to "status blob only" rather than guess at
// an authority this build doesn't have. See this build's own report for
// the explicit flag that automatic tracker-filing on a failure is a
// decision still open for Manager/Ron, not something this file attempts.
//
// SCHEDULE: every 4 hours (see netlify.toml) — frequent enough to catch a
// regression within a few hours (not just once a day), while keeping real
// outbound call volume low: 13 checks x 2 domains x 6 runs/day = ~156
// requests/day total across both domains, nowhere near any per-IP/per-day
// cap this codebase's own endpoints enforce (see check-email.js's own
// 40/day-per-IP default; this function's own outbound IP is Netlify's,
// not a real visitor's, and 6 check-email calls/day per domain is well
// under that regardless).

var { schedule } = require('@netlify/functions');
var smokeStatusStore = require('./lib/smoke-status-store');

var DOMAINS = ['dreamtube1.netlify.app', 'dreamtube.life'];

var FETCH_TIMEOUT_MS = 8000;

// Real key pages this tracker item named, plus index.html (Journey 2's
// true entry point per docs/JOURNEY_MANIFEST.md). Each `marker` is that
// page's own real, currently-committed <title> text (verified by reading
// the file directly, not guessed) -- a cheap, reliable "this really is
// that page's markup" signal with zero DOM parsing needed.
var PAGE_CHECKS = [
  { path: '/index.html', marker: 'DreamTube — Your dreams come alive' },
  { path: '/home.html', marker: 'Home — DreamTube' },
  { path: '/explore.html', marker: 'Explore — DreamTube' },
  { path: '/create.html', marker: 'New Dream — DreamTube' },
  { path: '/style.html', marker: 'Choose a style — DreamTube' },
  { path: '/result.html', marker: 'Your Dream — DreamTube' },
  { path: '/profile.html', marker: 'Profile — DreamTube' },
  { path: '/shop.html', marker: 'The Vault — DreamTube' },
  { path: '/media-library-x7q4.html', marker: 'Media Library — DreamTube' }
];

// A stable, obviously-fake, never-registered probe address -- reuses the
// SAME @example.com convention test/prod-smoke/helpers/config.js's own
// header comment documents (js/store.js's isTestOrInternalIdentity()
// already treats any @example.com address as test/internal), so this
// never risks colliding with (or looking like an attack against) a real
// account.
var CHECK_EMAIL_PROBE_ADDRESS = 'both-domain-smoke-probe@example.com';

var FUNCTION_CHECKS = [
  {
    name: 'get-feed',
    path: '/.netlify/functions/get-feed',
    method: 'GET',
    // A real 200 whose body actually parses and carries the documented
    // `feed` array -- not just any 200 (an edge/CDN error page can still
    // be served with a 200 status in some misconfigurations).
    verify: function (status, body) {
      if (status !== 200) return 'expected 200, got ' + status;
      try {
        var parsed = JSON.parse(body);
        if (!Array.isArray(parsed.feed)) return 'response body has no feed array';
      } catch (e) { return 'response body is not valid JSON'; }
      return null;
    }
  },
  {
    name: 'get-token-status',
    path: '/.netlify/functions/get-token-status',
    method: 'GET',
    // No ?email= -- the documented zero-touch fast path (see that file's
    // own header comment): always resolves to a real 200 with a
    // deterministic zero/inert body, no Blobs read at all.
    verify: function (status, body) {
      if (status !== 200) return 'expected 200, got ' + status;
      try {
        var parsed = JSON.parse(body);
        if (typeof parsed.balance !== 'number') return 'response body has no numeric balance field';
      } catch (e) { return 'response body is not valid JSON'; }
      return null;
    }
  },
  {
    name: 'get-tracker-items',
    path: '/.netlify/functions/get-tracker-items',
    method: 'GET',
    verify: function (status, body) {
      if (status !== 200) return 'expected 200, got ' + status;
      try {
        var parsed = JSON.parse(body);
        if (!Array.isArray(parsed.items)) return 'response body has no items array';
      } catch (e) { return 'response body is not valid JSON'; }
      return null;
    }
  },
  {
    name: 'check-email',
    path: '/.netlify/functions/check-email',
    method: 'POST',
    body: JSON.stringify({ email: CHECK_EMAIL_PROBE_ADDRESS }),
    // 429 (E4 rate_limited) is an EXPECTED, healthy outcome here, not a
    // failure -- this function is called up to 6x/day per domain by this
    // very check (see this file's own header comment on call volume), so
    // it can legitimately hit its own per-IP daily cap on a domain that's
    // also fielding real traffic. What must never happen is a 5xx/timeout/
    // malformed body -- that's the actual "this endpoint is broken"
    // signal this check exists to catch.
    verify: function (status, body) {
      if (status === 429) return null;
      if (status !== 200) return 'expected 200 (or 429 rate_limited, itself a healthy signal), got ' + status;
      try {
        var parsed = JSON.parse(body);
        if (parsed.ok !== true) return 'response body did not report ok:true';
      } catch (e) { return 'response body is not valid JSON'; }
      return null;
    }
  }
];

/** fetch() with a bounded timeout -- a hung request must not stall this function past the schedule's own execution budget. */
async function fetchWithTimeout(fetchImpl, url, options) {
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, FETCH_TIMEOUT_MS);
  try {
    return await fetchImpl(url, Object.assign({}, options, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}

/** Runs a single page check against `baseUrl` (e.g. 'https://dreamtube.life'). Never throws -- a network failure is reported as a failed check, not an uncaught rejection. */
async function checkPage(fetchImpl, baseUrl, page) {
  try {
    var res = await fetchWithTimeout(fetchImpl, baseUrl + page.path, { method: 'GET' });
    var body = await res.text();
    if (res.status !== 200) {
      return { path: page.path, ok: false, status: res.status, error: 'expected 200, got ' + res.status };
    }
    if (body.indexOf(page.marker) === -1) {
      return { path: page.path, ok: false, status: res.status, error: 'response body missing expected marker "' + page.marker + '"' };
    }
    return { path: page.path, ok: true, status: res.status };
  } catch (e) {
    return { path: page.path, ok: false, status: null, error: e && e.message ? e.message : String(e) };
  }
}

/** Runs a single function-endpoint check against `baseUrl`. Never throws, same reasoning as checkPage. */
async function checkFunction(fetchImpl, baseUrl, check) {
  try {
    var options = { method: check.method, headers: check.body ? { 'Content-Type': 'application/json' } : undefined };
    if (check.body) options.body = check.body;
    var res = await fetchWithTimeout(fetchImpl, baseUrl + check.path, options);
    var body = await res.text();
    var error = check.verify(res.status, body);
    if (error) return { name: check.name, ok: false, status: res.status, error: error };
    return { name: check.name, ok: true, status: res.status };
  } catch (e) {
    return { name: check.name, ok: false, status: null, error: e && e.message ? e.message : String(e) };
  }
}

/**
 * Runs every page + function check against a single domain, concurrently.
 * Returns { ok, pages: [...], functions: [...] } -- `ok` is true only if
 * every single check passed.
 */
async function runDomainChecks(domain, fetchImpl) {
  fetchImpl = fetchImpl || fetch;
  var baseUrl = 'https://' + domain;

  var pageResults = await Promise.all(PAGE_CHECKS.map(function (page) { return checkPage(fetchImpl, baseUrl, page); }));
  var functionResults = await Promise.all(FUNCTION_CHECKS.map(function (check) { return checkFunction(fetchImpl, baseUrl, check); }));

  var ok = pageResults.every(function (r) { return r.ok; }) && functionResults.every(function (r) { return r.ok; });
  return { ok: ok, pages: pageResults, functions: functionResults };
}

/**
 * Runs both domains' checks (concurrently with each other too) and writes
 * one result record per domain to lib/smoke-status-store.js. Exposed
 * separately from exports.handler so test/both-domain-smoke.test.js can
 * call it directly with a mocked fetch, without needing a real scheduled
 * invocation payload -- same convention as send-daily-claim-pushes.js's
 * own scanAndSend/exports.handler split.
 */
async function scanAndCheck(event, fetchImpl) {
  var results = await Promise.all(DOMAINS.map(async function (domain) {
    var result = await runDomainChecks(domain, fetchImpl);
    var failedPages = result.pages.filter(function (r) { return !r.ok; }).map(function (r) { return r.path; });
    var failedFunctions = result.functions.filter(function (r) { return !r.ok; }).map(function (r) { return r.name; });
    var summary = result.ok
      ? 'all ' + (result.pages.length + result.functions.length) + ' checks passed'
      : 'FAILED: ' + failedPages.concat(failedFunctions).join(', ');
    var record = await smokeStatusStore.writeResult(event, 'both-domain-smoke', domain, {
      ok: result.ok,
      summary: summary,
      pages: result.pages,
      functions: result.functions
    });
    return { domain: domain, ok: result.ok, summary: summary, record: record };
  }));
  return results;
}

exports.handler = schedule('0 */4 * * *', async function (event) {
  try {
    var results = await scanAndCheck(event);
    results.forEach(function (r) {
      console.log('both-domain-smoke: ' + r.domain + ' -- ' + (r.ok ? 'OK' : 'FAILED') + ' (' + r.summary + ')');
    });
  } catch (e) {
    // Best-effort, same "never let this surface as a hard failure"
    // discipline every other background/scheduled job in this codebase
    // follows (send-daily-claim-pushes.js, reconcile-fal-cost.js) -- a
    // failed scan just means this run's health snapshot doesn't update;
    // the next scheduled run tries again.
    console.error('both-domain-smoke: unexpected error', e);
  }
  return { statusCode: 200 };
});

// Exposed for direct unit testing (test/both-domain-smoke.test.js).
exports.scanAndCheck = scanAndCheck;
exports.runDomainChecks = runDomainChecks;
exports.checkPage = checkPage;
exports.checkFunction = checkFunction;
exports.PAGE_CHECKS = PAGE_CHECKS;
exports.FUNCTION_CHECKS = FUNCTION_CHECKS;
exports.DOMAINS = DOMAINS;
