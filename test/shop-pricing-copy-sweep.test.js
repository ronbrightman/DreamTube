// test/shop-pricing-copy-sweep.test.js
//
// Regression coverage for tracker item
// for-product-build-ship-today-founder-app-zn9zyy ("The Vault" shop
// redesign — $0.99/300 one-time starter, $1.99/500, $4.99/1500 "Most
// popular", $9.99/4000 "Best value" — REPLACES the previous
// pack100/pack300/pack700 lineup, 200/600/1400 tokens at $2.99/$7.99/
// $14.99, and its +50% first-purchase-bonus callout entirely).
//
// This repo has a documented recurring bug pattern (tracker item
// recurring-pattern-a-ui-copy-behavior-fix-9mmjgh) of a copy/pricing fix
// landing on one page/surface while a second, independent copy of the
// same old fact survives untouched somewhere else. This test walks the
// whole repo's product source (.html/.js/.css — NOT docs/*.md or
// RELEASES.md, which are allowed to keep an honest historical narrative
// of past pricing/decisions, and NOT shop-mock-x7q4.html, the founder
// look-and-decide mock this redesign was built from and isn't this
// migration's file to edit) for exact strings that only ever existed as
// part of the OLD pack lineup's live UI copy or markup, and pins that
// they're gone. Mirrors test/logo-purple-retouch-asset-sweep.test.js's
// own repo-wide-sweep pattern (plain fs walk + string search, no browser
// needed — what's under test is literal source-text facts).
//
// Deliberately does NOT sweep for the bare strings "pack100"/"pack300"/
// "pack700" themselves — those remain legitimate, necessary prose in
// comments across this codebase explaining the no-grandfathering
// migration (e.g. "never reuse the old pack100/300/700 ids"), and a
// blunt substring check can't distinguish that from a live identifier.
// The targeted strings below are ones that only ever appeared as part of
// literal OLD rendered copy or exact OLD markup attributes/class names —
// legitimately retired everywhere, comments included, since nothing
// should still be describing removed markup by its old id/class.

var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('node:fs');
var path = require('node:path');

var ROOT = path.join(__dirname, '..');

// Directories to skip entirely while walking — version control internals,
// dependency directories, and other concurrent agents' gitignored
// worktree checkouts (which can be on unrelated branches / mid-edit and
// aren't this migration's concern), same convention as
// test/logo-purple-retouch-asset-sweep.test.js.
var SKIP_DIRS = new Set(['.git', 'node_modules', '.netlify']);
var SKIP_PATH_PREFIXES = [path.join(ROOT, '.claude', 'worktrees')];

// Only these extensions are swept — product source, not docs/changelogs.
var SWEEP_EXTENSIONS = new Set(['.html', '.js', '.css']);

// Deliberate, documented exceptions — files this migration does not (and
// should not) rewrite. shop-mock-x7q4.html is the founder look-and-decide
// mock this redesign's own SKU ladder/structure was built from (not this
// migration's to edit or delete — it joins "delete after decision" only
// once the founder confirms, per that file's own header comment). Test
// files under test/ legitimately reference the OLD pack ids/copy as part
// of THEIR OWN documentation of what changed and why (including this
// file's own header comment above) — excluded from the walk entirely,
// same as the reference sweep test excludes itself.
var ALLOWED_FILES = new Set([
  path.join(ROOT, 'shop-mock-x7q4.html')
]);
var TEST_DIR = path.join(ROOT, 'test');

/** Recursively collects every regular file path under `dir` with a swept extension, skipping SKIP_DIRS/SKIP_PATH_PREFIXES/ALLOWED_FILES/the test/ directory as it goes. */
function walk(dir, out) {
  var entries = fs.readdirSync(dir, { withFileTypes: true });
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    var full = path.join(dir, entry.name);
    if (SKIP_PATH_PREFIXES.indexOf(full) !== -1) continue;
    if (full === TEST_DIR) continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, out);
    } else if (entry.isFile()) {
      if (ALLOWED_FILES.has(full)) continue;
      if (SWEEP_EXTENSIONS.has(path.extname(entry.name))) out.push(full);
    }
  }
  return out;
}

var ALL_FILES = walk(ROOT, []);

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

// ===========================================================================
// Retired strings — must appear NOWHERE in product source anymore.
// ===========================================================================
var RETIRED_STRINGS = [
  // Old pack-card copy sentences (shop.html's own former markup).
  '200 tokens = 2 videos or 20 images.',
  '600 tokens = 6 videos or 60 images.',
  '1400 tokens = 14 videos or 140 images.',
  // Old +50% first-purchase-bonus callout copy (both the promoted callout
  // and the earlier plain line it replaced).
  '+50% bonus tokens on your first pack',
  'Automatically applied at checkout — first pack only, no code needed.',
  'First pack: +50% bonus tokens, automatically applied.',
  // Old exact element ids / class names — retired along with the markup
  // they identified, so nothing should still reference them by name.
  'id="shop-buy-pack100"',
  'id="shop-buy-pack300"',
  'id="shop-buy-pack700"',
  'id="shop-first-purchase-callout"',
  'class="token-pack-card',
  'class="first-purchase-callout',
  'shop-variant-a',
  'shop-variant-b',
  'dreamtube_shop_variant',
  'shop_palette_variant'
];

RETIRED_STRINGS.forEach(function (needle) {
  test('copy sweep: retired string ' + JSON.stringify(needle) + ' appears nowhere in product source', function () {
    var offenders = ALL_FILES.filter(function (f) { return readText(f).indexOf(needle) !== -1; });
    assert.deepEqual(offenders.map(function (f) { return path.relative(ROOT, f); }), [], 'expected zero files containing ' + JSON.stringify(needle) + ' — found it in: ' + offenders.map(function (f) { return path.relative(ROOT, f); }).join(', '));
  });
});

// ===========================================================================
// New pack ladder — must actually be present where expected.
// ===========================================================================
test('shop.html: new pack ids (pack099/pack199/pack499/pack999) are wired to real buy buttons', function () {
  var source = readText(path.join(ROOT, 'shop.html'));
  ['pack099', 'pack199', 'pack499', 'pack999'].forEach(function (pack) {
    assert.match(source, new RegExp('id="shop-buy-' + pack + '"'), 'shop.html should have a #shop-buy-' + pack + ' button');
    assert.match(source, new RegExp('data-pack="' + pack + '"'), 'shop.html should have a button with data-pack="' + pack + '"');
  });
});

test('shop.html: new prices ($0.99/$1.99/$4.99/$9.99) all appear', function () {
  var source = readText(path.join(ROOT, 'shop.html'));
  ['$0.99', '$1.99', '$4.99', '$9.99'].forEach(function (price) {
    assert.ok(source.indexOf(price) !== -1, 'shop.html should mention ' + price + ' somewhere');
  });
});

test('shop.html: "one-time" / "no subscription" trust framing is present (unchanged copy sweep bar from the previous store launch)', function () {
  var source = readText(path.join(ROOT, 'shop.html'));
  assert.match(source, /one-time/i);
  assert.match(source, /no subscription/i);
});

test('create-checkout-session-dodo.js: new pack ids map to fresh DODO_PRODUCT_PACK_* env vars, not the old ones', function () {
  var source = readText(path.join(ROOT, 'netlify', 'functions', 'create-checkout-session-dodo.js'));
  assert.match(source, /DODO_PRODUCT_PACK_099/);
  assert.match(source, /DODO_PRODUCT_PACK_199/);
  assert.match(source, /DODO_PRODUCT_PACK_499/);
  assert.match(source, /DODO_PRODUCT_PACK_999/);
});

test('dodo-webhook.js: new pack ids map to fresh DODO_PRODUCT_PACK_* env vars, not the old ones', function () {
  var source = readText(path.join(ROOT, 'netlify', 'functions', 'dodo-webhook.js'));
  assert.match(source, /DODO_PRODUCT_PACK_099/);
  assert.match(source, /DODO_PRODUCT_PACK_199/);
  assert.match(source, /DODO_PRODUCT_PACK_499/);
  assert.match(source, /DODO_PRODUCT_PACK_999/);
});

// ===========================================================================
// "Tokens never expire" trust line — pinning the fact-check the task spec
// asked for stays true: no expiry/TTL mechanism anywhere for token
// balances. A future feature adding one without touching this page's copy
// would otherwise ship a silently false claim.
// ===========================================================================
test('FACT CHECK: lib/entitlements.js has no token expiry/TTL mechanism (shop.html\'s "tokens never expire" trust line stays true)', function () {
  var source = readText(path.join(ROOT, 'netlify', 'functions', 'lib', 'entitlements.js'));
  assert.doesNotMatch(source, /expire/i, 'if this now matches, shop.html\'s "tokens never expire" claim needs re-checking against the real mechanism');
});

test('shop.html: "tokens never expire" trust line is present', function () {
  var source = readText(path.join(ROOT, 'shop.html'));
  assert.match(source, /never expire/i);
});
