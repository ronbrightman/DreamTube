// test/founder-alias-exclusion-behavioral.test.js
//
// Covers tracker item for-product-founder-alias-exclusion-by-p-f7qyxo
// (08-01): the founder's standing rule that any identity matching one of
// his known base names (richardharrisman, jackflaa, ronbrightman,
// benbrightman/benbrightman14) — including Gmail dot-variants and
// numbered-throwaway-account variants — is his own test traffic and must
// be excluded from real-user analytics/metrics.
//
// js/store.js's normalizeIdentityBase/isKnownFounderOrInternalBase and
// their byte-for-byte server-side twin in
// netlify/functions/lib/test-identity.js implement this as
// NORMALIZATION-BASED pattern matching (strip dots, strip a trailing
// numeric suffix, lowercase, compare the base) rather than a hardcoded
// exact-string list — see both files' own header comments for the full
// reasoning, including why this is a deliberate duplicate (not a shared
// requireable module) and how the two are kept from drifting apart (the
// parity test at the bottom of this file).
//
// Pure normalization-logic assertions run directly against
// netlify/functions/lib/test-identity.js and, via the same
// extract-and-eval technique test/account-store-facebook.test.js already
// established for deriveUsernameBase, directly against js/store.js's own
// in-file copy — no browser needed for any of that, so these run fast and
// deterministically. A handful of true end-to-end browser tests (signup ->
// identifyForAnalytics -> isTestOrInternalIdentity -> setPersonProperties)
// cover the base-name cases reachable through a real call site (every
// current identifyForAnalytics call site passes a USERNAME, never an
// email — see js/store.js's own comment above identifyForAnalytics — so
// the email/dot-variant cases are only exercisable at the normalization-
// function level, not end-to-end).

var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('node:fs');
var path = require('node:path');
var staticServer = require('./helpers/static-server');
var serverIdentity = require('../netlify/functions/lib/test-identity');

var CHROMIUM_PATH = '/opt/pw-browsers/chromium';

var playwright = null;
var unavailableReason = null;
try {
  playwright = require('playwright');
} catch (e1) {
  try {
    playwright = require('/opt/node22/lib/node_modules/playwright');
  } catch (e2) {
    unavailableReason = 'Playwright is not resolvable in this environment (' + e2.message + ')';
  }
}

var server = null;
var browser = null;
var baseUrl = null;

test.before(async function () {
  if (unavailableReason) return;
  server = await staticServer.start();
  baseUrl = server.url;
  try {
    browser = await playwright.chromium.launch({ executablePath: CHROMIUM_PATH });
  } catch (e) {
    unavailableReason = 'Could not launch Chromium at ' + CHROMIUM_PATH + ': ' + e.message;
  }
});

test.after(async function () {
  if (browser) await browser.close();
  if (server) await server.close();
});

function blockThirdParty(page) {
  return page.route(/fonts\.(googleapis|gstatic)\.com|connect\.facebook\.net|i\.posthog\.com/, function (route) {
    route.abort();
  });
}

/** Wraps page.goto with 'domcontentloaded' (not the default 'load') and tolerates a transient nav failure -- see CLAUDE.md's known environment quirk. */
async function safeGoto(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  } catch (e) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  }
}

function mockSignupSucceeds(page) {
  return page.route('**/.netlify/functions/register-account', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
}

// The wizard.html cases below use the page ONLY as a "DreamStore + PostHog stub
// loaded here" vehicle — they call DreamStore.signup() directly via
// page.evaluate() to exercise identifyForAnalytics/is_test tagging (UNCHANGED),
// never the wall UI. Since unify-all-creation-flows (founder 2026-08-14) a BARE
// wizard.html hit is retired and redirects to /go/ (not served by the static test
// server), so it's reached via the funnel-arrival URL — the SAME page/scripts, no
// redirect. No distinct_id is passed, so no pre-signup identity stitch occurs.
var WIZARD_WALL_PATH = '/wizard.html?resume=1&caption=' + encodeURIComponent('a dream of flying over a glowing city, dreamlike');

function readPostHogCalls(page) {
  return page.evaluate(function () {
    var queue = (window.posthog && typeof window.posthog.slice === 'function') ? window.posthog.slice() : [];
    return queue;
  });
}

function callsNamed(calls, name) {
  return calls.filter(function (entry) { return entry[0] === name; });
}

// ---------------------------------------------------------------------
// Pure normalization-logic coverage (no browser)
// ---------------------------------------------------------------------

var STORE_FN_RE = /function normalizeIdentityBase\(usernameOrEmail\) \{[\s\S]*?\n {2}\}/;

/** Pulls normalizeIdentityBase straight out of js/store.js's own source and evals it, so the fixtures below are checked against the REAL shipped implementation, not a hand-copied stand-in. */
function loadStoreNormalizeIdentityBase() {
  var source = fs.readFileSync(path.join(__dirname, '..', 'js', 'store.js'), 'utf8');
  var match = source.match(STORE_FN_RE);
  assert.ok(match, 'normalizeIdentityBase must still be findable in js/store.js in this exact shape');
  /* eslint-disable no-new-func */
  return new Function(match[0] + '; return normalizeIdentityBase;')();
}

// Fixtures: [input, expectedBase]
var BASE_FIXTURES = [
  // Exact base-name matches
  ['richardharrisman', 'richardharrisman'],
  ['jackflaa', 'jackflaa'],
  ['ronbrightman', 'ronbrightman'],
  ['RonBrightman', 'ronbrightman'],
  ['benbrightman14', 'benbrightman'],
  ['benbrightman', 'benbrightman'],
  // Dot-variant matches (Gmail ignores dots in the local part)
  ['ri.chardharrisman', 'richardharrisman'],
  ['ri.chardharrisman@gmail.com', 'richardharrisman'],
  ['richardharrisman@gmail.com', 'richardharrisman'],
  ['jack.flaa@gmail.com', 'jackflaa'],
  // Trailing-digit-variant matches (numbered throwaway accounts)
  ['ronbrightman8877', 'ronbrightman'],
  ['jackflaa2', 'jackflaa'],
  ['benbrightman14', 'benbrightman'],
  // Combination of dot-variant AND trailing-digit-variant
  ['ri.chardharrisman8877@gmail.com', 'richardharrisman'],
  ['ri.char.dharrisman99@gmail.com', 'richardharrisman'],
  // Unrelated real users: must NOT reduce to a founder base name
  ['sonbrightman99', 'sonbrightman'],
  ['ronbrightmanofficial', 'ronbrightmanofficial'],
  ['richardharrismanjr', 'richardharrismanjr'],
  ['jackflaaherty', 'jackflaaherty'],
  ['flaajack99', 'flaajack'],
  ['user12345', 'user'],
  ['12345', '']
];

test('normalizeIdentityBase (server lib): strips dots, strips a trailing numeric suffix, lowercases, and drops an email domain', function () {
  BASE_FIXTURES.forEach(function (pair) {
    assert.equal(serverIdentity.normalizeIdentityBase(pair[0]), pair[1],
      'normalizeIdentityBase(' + JSON.stringify(pair[0]) + ')');
  });
});

test('normalizeIdentityBase (js/store.js source): agrees with the server lib on every fixture', function () {
  var storeFn = loadStoreNormalizeIdentityBase();
  BASE_FIXTURES.forEach(function (pair) {
    assert.equal(storeFn(pair[0]), pair[1], 'js/store.js normalizeIdentityBase(' + JSON.stringify(pair[0]) + ')');
  });
});

test('isKnownFounderOrInternalBase (server lib): matches exact base names, dot-variants, trailing-digit-variants, and the combination', function () {
  var shouldMatch = [
    'richardharrisman', 'RICHARDHARRISMAN', 'jackflaa', 'ronbrightman', 'benbrightman14', 'benbrightman',
    'ri.chardharrisman@gmail.com', 'richardharrisman@gmail.com', 'jack.flaa@gmail.com',
    'ronbrightman8877', 'ronbrightman1', 'jackflaa2',
    'ri.chardharrisman8877@gmail.com', 'ri.char.dharrisman99@gmail.com'
  ];
  shouldMatch.forEach(function (id) {
    assert.equal(serverIdentity.isKnownFounderOrInternalBase(id), true, id + ' must match a founder base name');
  });
});

test('isKnownFounderOrInternalBase (server lib): does NOT over-match a real user whose name merely contains digits or a similar substring', function () {
  var shouldNotMatch = [
    'sonbrightman99', 'ronbrightmanofficial', 'richardharrismanjr', 'jackflaaherty',
    'flaajack99', 'user12345', 'realgenuineuser', 'exampletestuser', '', null, undefined,
    'brightman', 'ron', 'harrisman99gmailcom'
  ];
  shouldNotMatch.forEach(function (id) {
    assert.equal(serverIdentity.isKnownFounderOrInternalBase(id), false, JSON.stringify(id) + ' must NOT match a founder base name');
  });
});

// ---------------------------------------------------------------------
// End-to-end browser coverage (base-name cases reachable via a real
// identify() call site — always a username, never an email)
// ---------------------------------------------------------------------

test('identifyForAnalytics: richardharrisman and jackflaa (new founder aliases) get tagged is_test on signup', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  for (var i = 0; i < 2; i++) {
    var username = ['richardharrisman', 'jackflaa'][i];
    var page = await browser.newPage();
    await blockThirdParty(page);
    await mockSignupSucceeds(page);
    try {
      await safeGoto(page, baseUrl + WIZARD_WALL_PATH);
      var result = await page.evaluate(function (u) {
        return window.DreamStore.signup(u, 'password123', u + '@gmail.com');
      }, username);
      assert.equal(result.ok, true);

      var calls = await readPostHogCalls(page);
      var setProps = callsNamed(calls, 'setPersonProperties');
      assert.equal(setProps.length, 1, username + ' must be tagged is_test');
      assert.deepEqual(setProps[0].slice(1), [{ is_test: true }]);
    } finally {
      await page.close();
    }
  }
});

test('identifyForAnalytics: a numbered throwaway founder account (ronbrightman8877) gets tagged is_test without any code change for the new number', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  await mockSignupSucceeds(page);
  try {
    await safeGoto(page, baseUrl + WIZARD_WALL_PATH);
    var result = await page.evaluate(function () {
      return window.DreamStore.signup('ronbrightman8877', 'password123', 'ron+throwaway@gmail.com');
    });
    assert.equal(result.ok, true);

    var calls = await readPostHogCalls(page);
    var setProps = callsNamed(calls, 'setPersonProperties');
    assert.equal(setProps.length, 1, 'ronbrightman8877 must be tagged is_test');
    assert.deepEqual(setProps[0].slice(1), [{ is_test: true }]);
  } finally {
    await page.close();
  }
});

test('identifyForAnalytics: a real user whose username merely resembles a founder base name is NOT tagged is_test', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  await mockSignupSucceeds(page);
  try {
    await safeGoto(page, baseUrl + WIZARD_WALL_PATH);
    var result = await page.evaluate(function () {
      return window.DreamStore.signup('sonbrightman99', 'password123', 'sonbrightman99@gmail.com');
    });
    assert.equal(result.ok, true);

    var calls = await readPostHogCalls(page);
    assert.equal(callsNamed(calls, 'identify').length, 1, 'sanity: identify() must still fire normally');
    assert.equal(callsNamed(calls, 'setPersonProperties').length, 0,
      'sonbrightman99 must NOT be tagged is_test -- it is a real, unrelated username that merely contains digits and a similar substring');
  } finally {
    await page.close();
  }
});
