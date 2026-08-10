// test/daily-grant-copy-static-sweep.test.js
//
// Structural safety net for tracker item
// recurring-bug-class-hardcoded-daily-gran-h6swgy: this codebase's
// free-token-grant amounts (netlify/functions/lib/entitlements.js's
// DAILY_CLAIM_AMOUNT/FIRST_CLAIM_BONUS_AMOUNT/TRIAL_DAILY_CLAIM_AMOUNT/
// INITIAL_GRANT) have drifted out of sync with hardcoded copy in .html
// files FIVE separate times across two branches, each caught only by a
// manual review-round grep sweep for that ONE known phrasing:
//   - style.html/result.html's old #modal-quota-body ("you'll get N more
//     automatically")
//   - shop.html's #shop-countdown ("Next N free tokens claimable in...")
//   - shop.html's #shop-cap-note ("...capped — N every 24 hours...", a
//     phrasing that slipped past the grep patterns used to find the
//     first four)
//   - profile.html's old daily-claim countdown (since removed entirely
//     — see test/token-daily-grant-copy-behavioral.test.js's own
//     "REMOVED" note)
//
// test/token-daily-grant-copy-behavioral.test.js already covers those
// specific known instances behaviorally (real Chromium runs asserting
// each element reads the LIVE dailyClaimAmount from getTokenStatus()
// rather than a hardcoded number) — but it is enumerated per-instance,
// so a NEW sixth occurrence in a NEW file/element slips through exactly
// the same way the fifth one did. This file is additive, generic
// coverage: it does not replace any of those tests, and does not touch
// them.
//
// Approach (mirrors test/shop-pricing-copy-sweep.test.js's own
// repo-wide-sweep pattern — plain fs walk + text search, no browser
// needed, since what's under test is literal static source text):
//
//   1. Extract the live grant-amount constants straight from
//      entitlements.js's source text (regex, no eval) — never
//      hardcoded a second time here, which would just reintroduce the
//      exact class of drift this test exists to prevent.
//   2. Walk every .html file in the repo root and, for each one, strip
//      HTML comments (<!-- ... -->, which legitimately reference old/
//      historical numbers as documentation — e.g. shop.html's SKU-ladder
//      header comment listing each pack's token count) before scanning the
//      remaining raw text — this is
//      the STATIC, pre-JS source, not a rendered DOM: a live element
//      whose textContent gets overwritten by JS at render time still
//      has to start from *some* string baked into the HTML, and that
//      string is exactly what's checked here.
//   3. A curated set of phrase regexes — each one derived from an
//      actual instance of this bug class or the actual live copy this
//      sweep found while being built (see the regex list's own
//      comments below for provenance) — finds digit-adjacent
//      grant-vocabulary copy and extracts the candidate grant-amount
//      digit specifically (not any incidental nearby number, like the
//      "24" in "every 24 hours" or a "3" in "3-day free trial").
//   4. Every match must resolve to one of the live grant-amount
//      constants. Anything else fails loudly with the file, line
//      number, and exact matched text.

var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('node:fs');
var path = require('node:path');

var ROOT = path.join(__dirname, '..');
var ENTITLEMENTS_PATH = path.join(ROOT, 'netlify', 'functions', 'lib', 'entitlements.js');

// ===========================================================================
// Step 1: live values, parsed from the real source — never hardcoded here.
// ===========================================================================

/** Regex-extracts `var NAME = <integer>;` from entitlements.js's source text. Throws loudly (not a silent 0/undefined) if the constant's declaration shape ever changes, since a silently-missing constant would make every later assertion in this file meaningless. */
function extractConstant(source, name) {
  var re = new RegExp('var\\s+' + name + '\\s*=\\s*(\\d+)\\s*;');
  var m = source.match(re);
  if (!m) {
    throw new Error(
      'daily-grant-copy-static-sweep: could not find `var ' + name + ' = <number>;` in ' +
      ENTITLEMENTS_PATH + ' — its declaration shape changed and this extractor needs updating ' +
      '(this must fail loudly rather than silently treating the constant as absent).'
    );
  }
  return parseInt(m[1], 10);
}

var entitlementsSource = fs.readFileSync(ENTITLEMENTS_PATH, 'utf8');

// The two amounts the tracker item names directly.
var DAILY_CLAIM_AMOUNT = extractConstant(entitlementsSource, 'DAILY_CLAIM_AMOUNT');
var FIRST_CLAIM_BONUS_AMOUNT = extractConstant(entitlementsSource, 'FIRST_CLAIM_BONUS_AMOUNT');

// Two more grant-adjacent constants this sweep's own construction found
// live, digit-bearing copy for — both squarely inside "the daily
// free-token-grant amount has drifted out of sync with hardcoded HTML
// copy," just not the two amounts the tracker item happened to name:
//   - TRIAL_DAILY_CLAIM_AMOUNT: shop.html's Dreamer Pass redirect cue
//     ("3-day free trial · 100 free tokens/day · then $9.99/mo") is pure
//     static copy — never touched by any JS in that file (only its
//     `style.display` gets toggled, never its textContent) — so its "100"
//     has to be checked against SOMETHING, and the only live constant it
//     could ever legitimately equal is this one.
//   - INITIAL_GRANT: the actual live bug this sweep's construction found
//     (see this file's own header note in the PR this test shipped in) —
//     profile.html's FAQ and admin.html's reset-tool copy both hardcoded
//     the signup grant as "220," which drifted stale across TWO same-day
//     retunes (220 -> 170 -> 150) that never touched either page.
var TRIAL_DAILY_CLAIM_AMOUNT = extractConstant(entitlementsSource, 'TRIAL_DAILY_CLAIM_AMOUNT');
var INITIAL_GRANT = extractConstant(entitlementsSource, 'INITIAL_GRANT');

var LIVE_GRANT_AMOUNTS = [DAILY_CLAIM_AMOUNT, FIRST_CLAIM_BONUS_AMOUNT, TRIAL_DAILY_CLAIM_AMOUNT, INITIAL_GRANT];

// KNOWN LIMITATION, found while proving this test has teeth (see the
// TEETH_CASES section below): a stale number is only caught if it does
// NOT happen to equal a DIFFERENT live grant constant than the one that
// actually belongs at that call site. Concretely: reintroducing the real
// historical shop.html #shop-cap-note bug verbatim ("capped — 100 every
// 24 hours") does NOT fail today, because 100 happens to equal the live
// TRIAL_DAILY_CLAIM_AMOUNT even though that copy has nothing to do with
// the trial. This is why TEETH_CASES below deliberately uses a
// guaranteed-invalid placeholder (999) instead of literal historical
// values — a whole-repo digit sweep with no per-element semantic
// awareness of "which constant SHOULD apply here" cannot fully close
// this gap without becoming a much larger, per-instance-aware system
// (which is exactly what test/token-daily-grant-copy-behavioral.test.js
// already is, for the specific elements it knows about). Treat this file
// as a broad, cheap tripwire for the common case — a number that matches
// NONE of the live constants — not an airtight proof for every possible
// stale value.

// ===========================================================================
// Step 2: walk every .html file in the repo root.
// ===========================================================================

var SKIP_DIRS = new Set(['.git', 'node_modules', '.netlify']);
var SKIP_PATH_PREFIXES = [path.join(ROOT, '.claude', 'worktrees')];

/** Collects every *.html file directly in `dir` (non-recursive is enough — this repo's real pages all live at the repo root; test/ fixtures and node_modules live elsewhere and are skipped explicitly below anyway), skipping SKIP_DIRS/SKIP_PATH_PREFIXES as it goes. */
function collectHtmlFiles(dir) {
  var entries = fs.readdirSync(dir, { withFileTypes: true });
  var out = [];
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    var full = path.join(dir, entry.name);
    if (SKIP_PATH_PREFIXES.indexOf(full) !== -1) continue;
    if (entry.isDirectory()) continue; // repo-root-only, see comment above
    if (SKIP_DIRS.has(entry.name)) continue;
    if (path.extname(entry.name) === '.html') out.push(full);
  }
  return out;
}

var HTML_FILES = collectHtmlFiles(ROOT);

test('sanity: the repo-root HTML sweep actually found files (a would-be silent no-op if the walk logic broke)', function () {
  assert.ok(HTML_FILES.length > 20, 'expected dozens of .html files at the repo root, found ' + HTML_FILES.length);
});

/** Strips HTML comments (<!-- ... -->) out of raw source text before scanning — these legitimately reference old/live numbers as documentation (e.g. "the claim amount varies... see FIRST_CLAIM_BONUS_AMOUNT" right next to a live element) and aren't rendered, user-facing copy. Replaces each comment character-for-character (newlines stay newlines, everything else becomes a space) rather than collapsing it, so every match offset in the RETURNED string is still the exact same character offset as in the original — required for lineNumberAt() to point at a real, correct line when called with an offset taken from the cleaned text. */
function stripHtmlComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, function (m) {
    var out = '';
    for (var i = 0; i < m.length; i++) out += m[i] === '\n' ? '\n' : ' ';
    return out;
  });
}

/** 1-based line number for a character offset into `text`. */
function lineNumberAt(text, offset) {
  var upTo = text.slice(0, offset);
  var newlines = upTo.match(/\n/g);
  return (newlines ? newlines.length : 0) + 1;
}

// ===========================================================================
// Step 3: phrase regexes — each derived from real copy (either a
// historical bug instance, or an actual live phrasing this sweep's own
// construction found while grepping the codebase). Every regex has
// exactly one capture group: the candidate grant-amount digit run.
// Global + case-insensitive.
// ===========================================================================

var GRANT_PHRASE_PATTERNS = [
  // "20 free tokens" / "20 more free tokens" (profile.html FAQ,
  // shop.html's cost banner + Dreamer Pass trial line) — the "more "
  // is optional since "N more free tokens" is real live copy today.
  { name: 'N (more )?free tokens', re: /(\d+)\s+(?:more\s+)?free tokens?\b/gi },
  // "Claim 20 free tokens" (shop.html's claim button label).
  { name: 'claim N', re: /\bclaim\s+(\d+)\s+free/gi },
  // "Next 20 free tokens claimable in..." (shop.html's countdown,
  // style.html/result.html's old #modal-quota-body historical bug).
  { name: 'next N free', re: /\bnext\s+(\d+)\s+free/gi },
  // "20 claimable once a day" (shop.html's #shop-cap-note).
  { name: 'N claimable once a day', re: /(\d+)\s+claimable once a day/gi },
  // "N every 24 hours" — the retired grant-ceiling phrasing
  // (shop-cap-note's fifth historical instance: "capped — 100 every 24
  // hours"). Kept even though the ceiling concept itself is retired
  // (test/token-daily-grant-copy-behavioral.test.js separately pins
  // "capped"/"banked" never reappearing) — a *different* future feature
  // could reintroduce an "N every 24 hours" phrasing without reusing
  // either retired word.
  { name: 'N every 24 hours', re: /(\d+)\s+every\s+24\s*h(?:ours?)?\b/gi },
  // "You start with 220 free" (profile.html FAQ — the live bug this
  // sweep's construction found: INITIAL_GRANT drifted 220 -> 150 across
  // two retunes that never touched this line).
  { name: 'start with N free', re: /start with\s+(\d+)\s+free/gi },
  // "a re-signup re-grants 220" (admin.html's reset-tool description).
  { name: 're-grants N', re: /re-grants?\s+(\d+)\b/gi },
  // "(220 grant + re-earnable bonuses)" (admin.html's reset-result
  // toast — a JS template string, not markup, but still static,
  // hardcoded source text baked in ahead of any real response).
  { name: '(N grant', re: /\(\s*(\d+)\s+grant\b/gi },
  // "20 tokens today" / "20 tokens per day" / "20 tokens each day" /
  // "100 free tokens/day" (shop.html's Dreamer Pass trial line uses the
  // "free tokens/day" shape, already caught by the first pattern above;
  // this one generalizes to phrasings without "free").
  { name: 'N tokens today/per day/each day/per-day', re: /(\d+)\s+tokens?\s*(?:today|per day|each day|\/day)/gi },
  // Generic "grants N tokens" / "grant of N tokens" — a plausible future
  // phrasing not yet seen verbatim in this repo, generalized outward per
  // this test's own brief.
  { name: 'grant(s) of N tokens', re: /grants?(?:\s+of)?\s+(\d+)\s+(?:free\s+)?tokens?\b/gi }
];

// ===========================================================================
// Step 4: scan, and assert every match resolves to a live grant amount.
// ===========================================================================

/** Scans one file's raw text for every GRANT_PHRASE_PATTERNS match, returning {file, line, amount, matchedText, patternName} for each. Comments are stripped first (see stripHtmlComments); line numbers are computed against the ORIGINAL text so they point at a real, readable line in the actual file. */
function scanFile(filePath) {
  var original = fs.readFileSync(filePath, 'utf8');
  var cleaned = stripHtmlComments(original);
  var findings = [];
  GRANT_PHRASE_PATTERNS.forEach(function (pattern) {
    var re = new RegExp(pattern.re.source, pattern.re.flags);
    var m;
    while ((m = re.exec(cleaned)) !== null) {
      findings.push({
        file: filePath,
        line: lineNumberAt(original, m.index),
        amount: parseInt(m[1], 10),
        matchedText: m[0],
        patternName: pattern.name
      });
      // Guard against a zero-width match looping forever (none of the
      // patterns above are zero-width, but this keeps the scanner safe
      // if a future pattern edit accidentally introduces one).
      if (m[0].length === 0) re.lastIndex++;
    }
  });
  return findings;
}

function describeFinding(f) {
  return f.file + ':' + f.line + ' — matched ' + JSON.stringify(f.matchedText) +
    ' (pattern "' + f.patternName + '", extracted amount ' + f.amount + ')';
}

test('daily-grant copy sweep: every digit-bearing daily-grant-adjacent phrase in static HTML matches a live entitlements.js constant', function () {
  var offenders = [];
  HTML_FILES.forEach(function (filePath) {
    scanFile(filePath).forEach(function (finding) {
      if (LIVE_GRANT_AMOUNTS.indexOf(finding.amount) === -1) offenders.push(finding);
    });
  });

  if (offenders.length > 0) {
    var report = offenders.map(describeFinding).join('\n  ');
    assert.fail(
      '\n' + offenders.length + ' stale/hardcoded daily-grant-amount reference(s) found in static HTML ' +
      '(none of them match a live entitlements.js constant — DAILY_CLAIM_AMOUNT=' + DAILY_CLAIM_AMOUNT +
      ', FIRST_CLAIM_BONUS_AMOUNT=' + FIRST_CLAIM_BONUS_AMOUNT + ', TRIAL_DAILY_CLAIM_AMOUNT=' + TRIAL_DAILY_CLAIM_AMOUNT +
      ', INITIAL_GRANT=' + INITIAL_GRANT + '):\n  ' + report +
      '\n\nFix: either update the hardcoded copy to the live amount, or if this number is genuinely ' +
      'unrelated to a token grant (a price, a token COST, a pack size, a date), tighten this test\'s ' +
      'GRANT_PHRASE_PATTERNS so it stops matching that phrasing.'
    );
  }
});

// ===========================================================================
// Sanity checks that this sweep actually has teeth — proves each pattern
// really fires on real copy shapes, not just "the file happens to have no
// offenders right now." Mirrors this codebase's own established
// discipline of proving a regression test isn't tautological (see e.g.
// test/shop-pricing-copy-sweep.test.js and its own sibling tests) via a
// direct call into the scanning function against synthetic strings —
// the equivalent of a stash-and-rerun check, without needing to actually
// mutate a file on disk mid-test-run.
// ===========================================================================

/** Same scan logic as scanFile, but against an in-memory string instead of a file on disk — used only to prove each pattern fires, without touching real repository files mid-test-run. */
function scanText(text) {
  var cleaned = stripHtmlComments(text);
  var findings = [];
  GRANT_PHRASE_PATTERNS.forEach(function (pattern) {
    var re = new RegExp(pattern.re.source, pattern.re.flags);
    var m;
    while ((m = re.exec(cleaned)) !== null) {
      findings.push({ amount: parseInt(m[1], 10), matchedText: m[0], patternName: pattern.name });
    }
  });
  return findings;
}

var TEETH_CASES = [
  // The exact five historical bug phrasings (or close paraphrases where
  // the exact old markup is gone from this codebase), each with a
  // deliberately-wrong amount (999) that cannot coincidentally match a
  // real live constant.
  { label: 'style/result.html-era: "you\'ll get N more automatically"', text: 'Out of tokens — you\'ll get 999 more free tokens automatically at midnight.' },
  { label: 'shop.html #shop-countdown: "Next N free tokens claimable in..."', text: 'Next 999 free tokens claimable in 3h 12m' },
  { label: 'shop.html #shop-cap-note (old ceiling phrasing): "capped — N every 24 hours"', text: 'Free tokens are capped — 999 every 24 hours, up to 400 banked.' },
  { label: 'shop.html #shop-cap-note (current phrasing): "N claimable once a day"', text: 'Free tokens: 999 claimable once a day. Buy a pack any time for more, right when you need it.' },
  // This PR's own real-world find: profile.html's stale "220" signup
  // grant (hand-reintroduced here at a deliberately-wrong 999, not the
  // real historical 220, so this proves the PATTERN has teeth without
  // depending on which exact number happened to be stale at the time).
  { label: 'profile.html FAQ: "You start with N free, and you can claim N more free tokens each day"', text: 'You start with 999 free, and you can claim 999 more free tokens each day.' },
  { label: 'admin.html reset-tool: "re-signup re-grants N"', text: 'so a re-signup re-grants 999 + re-earns the bonuses.' },
  { label: 'admin.html reset-result toast: "(N grant + re-earnable bonuses)"', text: 'Re-signup with this email now gets a genuine fresh start (999 grant + re-earnable bonuses).' }
];

TEETH_CASES.forEach(function (testCase) {
  test('sweep has teeth: catches a reintroduced ' + testCase.label, function () {
    var findings = scanText(testCase.text);
    var offenders = findings.filter(function (f) { return LIVE_GRANT_AMOUNTS.indexOf(f.amount) === -1; });
    assert.ok(
      offenders.length > 0,
      'expected the sweep to flag the deliberately-wrong 999 in ' + JSON.stringify(testCase.text) +
      ' but it found nothing — this pattern has no teeth'
    );
    offenders.forEach(function (f) { assert.equal(f.amount, 999); });
  });
});

test('sweep does not false-positive on genuinely unrelated numbers next to grant vocabulary', function () {
  // These three should produce NO match at all — no grant-vocabulary
  // pattern should even fire, proving the cost/price/date numbers are
  // never extracted as grant-amount candidates in the first place. (The
  // first case was shop.html's cost banner until the 2026-08-10 copy trim
  // removed it; it stays here as a synthetic false-positive guard.)
  assert.deepEqual(scanText('Videos cost 100 tokens, images 10.'), [], 'a token COST must not be treated as a grant amount');
  assert.deepEqual(scanText('$9.99 for 4000 tokens.'), [], 'a pack price/size must not be treated as a grant amount');
  assert.deepEqual(scanText('Offer ends August 20.'), [], 'a date must not be treated as a grant amount');

  // This one DOES legitimately match ("100 free tokens/day" is real
  // shop.html copy) — the interesting assertion is that the extracted
  // amount is 100 (the trial grant), not 3 (the trial's day-count,
  // sitting right next to matching vocabulary as "3-day free trial").
  var trialFindings = scanText('3-day free trial · 100 free tokens/day · then $9.99/mo');
  assert.ok(trialFindings.length > 0, 'expected the trial line\'s "100 free tokens/day" to be picked up as a candidate');
  trialFindings.forEach(function (f) {
    assert.equal(f.amount, 100, 'the "3" in "3-day" must never be extracted as the candidate amount');
  });
  assert.ok(trialFindings.some(function (f) { return f.amount === TRIAL_DAILY_CLAIM_AMOUNT; }));
});
