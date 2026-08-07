// test/journey-manifest.test.js
//
// Pins the funnel JOURNEY itself, not just per-change behavior (tracker
// item for-product-pin-the-funnel-journey-as-a--3uawmc, founder 2026-07-31,
// after catching two stale funnel screens himself: "How come there is no
// routine check to catch such things?"). docs/JOURNEY_MANIFEST.md is the
// canonical, founder-approved ordered screen list for both entry journeys
// -- this test extracts the ACTUAL step sequence straight from
// start.html's/wizard.html's own markup (their SCREEN_RENDERERS arrays,
// by render-function name) and asserts it equals the manifest's own
// documented arrays below.
//
// ADDING or REMOVING a screen renderer from either file's SCREEN_RENDERERS
// (or reordering it) breaks this suite until BOTH this test's expected
// arrays AND docs/JOURNEY_MANIFEST.md are deliberately updated to match --
// per the manifest's own header, that update requires founder/Manager
// approval, same as any other funnel-journey change. This test enforces
// "no silent drift," not "no change ever."
//
// Deliberately a plain Node fs.readFileSync + regex extraction, not a
// Playwright/browser test -- the thing under test is the literal
// SCREEN_RENDERERS array LITERAL in the file's source text (a markup/
// structure fact), not runtime behavior, so this runs fast and needs no
// browser.

var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('node:fs');
var path = require('node:path');

var ROOT = path.join(__dirname, '..');

/**
 * Extracts the function names inside a `var SCREEN_RENDERERS = [a, b, c];`
 * array literal from a page's raw source text. Fails loudly (not silently
 * returning an empty array) if the pattern isn't found at all -- a missing
 * SCREEN_RENDERERS declaration is itself a journey-breaking change this
 * test must catch, not tolerate.
 */
function extractScreenRenderers(fileName) {
  var source = fs.readFileSync(path.join(ROOT, fileName), 'utf8');
  var match = source.match(/var\s+SCREEN_RENDERERS\s*=\s*\[([^\]]*)\]/);
  assert.ok(match, fileName + ': could not find a `var SCREEN_RENDERERS = [...]` declaration at all -- has the funnel-step array been renamed or restructured?');
  return match[1].split(',').map(function (s) { return s.trim(); }).filter(Boolean);
}

// ===========================================================================
// Journey 1 -- paid ad funnel (dreamtube-growth -> start.html -> first
// video). This repo's manifest starts at start.html's own screen 13 (the
// ad funnel's own pre-signup hook/quiz/style screens live in the separate
// dreamtube-growth repo -- out of scope here, tracked there separately).
// ===========================================================================

var EXPECTED_AD_FUNNEL_SCREENS = ['renderScreen13', 'renderScreen14'];

test('JOURNEY_MANIFEST.md: start.html\'s actual SCREEN_RENDERERS sequence matches the ad-funnel journey documented there', function () {
  var actual = extractScreenRenderers('start.html');
  assert.deepEqual(
    actual,
    EXPECTED_AD_FUNNEL_SCREENS,
    'start.html\'s SCREEN_RENDERERS has drifted from docs/JOURNEY_MANIFEST.md\'s "Journey 1 -- Paid ad funnel" table. ' +
    'If this is a deliberate, founder/Manager-approved change: update BOTH this test\'s EXPECTED_AD_FUNNEL_SCREENS array ' +
    'AND docs/JOURNEY_MANIFEST.md\'s Journey 1 table (in the same commit) to match. If it is not deliberate, this is ' +
    'exactly the silent-drift bug class this test exists to catch -- revert the change instead.'
  );
});

// ===========================================================================
// Journey 2 -- organic/direct entry (index.html -> wizard.html -> first
// video). wizard.html is a deliberately separate, lighter pre-signup
// implementation from start.html (founder decision 2026-07-24,
// for-product-funnel-is-getting-its-own-co-pihldm) -- its own chip-first
// flow, not start.html's. The former separate Contact-capture + username/
// password Signup pair is now ONE merged signup wall (renderSignupWall)
// at parity with start.html's screen 13 -- a deliberate, founder-ordered
// journey change (tracker item for-product-wizard-signup-wall-is-the-ol-
// lt1l9j), updated here + in docs/JOURNEY_MANIFEST.md in the same commit
// per this test's own contract.
// ===========================================================================

var EXPECTED_ORGANIC_SCREENS = [
  'renderSubject', 'renderSetting', 'renderAction', 'renderMood',
  'renderStyleStep', 'renderFreeText', 'renderSignupWall'
];

test('JOURNEY_MANIFEST.md: wizard.html\'s actual SCREEN_RENDERERS sequence matches the organic journey documented there', function () {
  var actual = extractScreenRenderers('wizard.html');
  assert.deepEqual(
    actual,
    EXPECTED_ORGANIC_SCREENS,
    'wizard.html\'s SCREEN_RENDERERS has drifted from docs/JOURNEY_MANIFEST.md\'s "Journey 2 -- Organic / direct entry" table. ' +
    'If this is a deliberate, founder/Manager-approved change: update BOTH this test\'s EXPECTED_ORGANIC_SCREENS array ' +
    'AND docs/JOURNEY_MANIFEST.md\'s Journey 2 table (in the same commit) to match. If it is not deliberate, this is ' +
    'exactly the silent-drift bug class this test exists to catch -- revert the change instead.'
  );
});

// ===========================================================================
// index.html's own routing into Journey 2 -- a plain markup check
// (no browser needed) that the organic entry point's CTA still points at
// wizard.html, the documented Journey 2 entry. The fuller behavioral
// coverage (actually following the link, confirming the paid path is
// untouched) lives in test/route-organic-to-wizard-behavioral.test.js --
// this is just the journey-manifest-level guard that the DOCUMENTED entry
// seam itself hasn't silently moved.
// ===========================================================================

test('JOURNEY_MANIFEST.md: index.html\'s "Get Started" CTA still routes into wizard.html, the documented Journey 2 entry point', function () {
  var source = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  // ?entry=index (tracker item for-product-urgent-founder-repro-index-g-
  // c6boa9) is a deliberate marker, not a route change -- wizard.html's
  // returning-visitor guard reads it to distinguish an explicit
  // Get-Started click (proceed) from a direct/bookmarked hit (still
  // bounced to index.html) -- see that guard's own doc comment.
  assert.match(
    source,
    /href="wizard\.html(\?entry=index)?"/,
    'index.html no longer links "Get Started" straight to wizard.html -- this is the documented Journey 2 entry seam in docs/JOURNEY_MANIFEST.md. If this routing changed deliberately, update the manifest\'s Journey 2 table to match.'
  );
});
