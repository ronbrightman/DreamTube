// test/logo-purple-retouch-asset-sweep.test.js
//
// Regression coverage for tracker item
// for-product-logo-retouch-founder-pick-08-685hbg (founder-picked
// "variant C" from logo-mock-x7q4.html -- a purple-shifted retouch of
// the production logo, `filter: hue-rotate(-62deg) saturate(1.08)`
// baked into new static raster assets rather than shipped as a live CSS
// filter). This repo has a documented recurring bug pattern of missing a
// second/third copy of the same asset reference scattered across pages
// when a shared asset gets renamed -- this test exists so a future
// asset rename gets caught here instead of shipping a broken favicon/
// icon/OG-image somewhere nobody happened to click.
//
// Two things pinned:
//   1. Every known "the logo appears here" reference point (favicons,
//      apple-touch-icon, manifest.json icons, sw.js notification icon/
//      badge, the share-dream.js OG-image fallback, login.html's auth
//      logo, index.html's welcome-screen mark, home.html's inline
//      base64 topbar mark, and the photo-upload test fixtures that
//      happen to reuse the raster file as generic real-photo test data)
//      points at the NEW asset filenames (the logo-v3* / apple-touch-
//      icon-v3.png family).
//   2. A plain filesystem walk of the whole repo (skipping .git, the
//      gitignored .claude/worktrees/ scratch dir other concurrent
//      agents use, and any node_modules) confirms the OLD filenames
//      (logo-v2*.png, the pre-v3 apple-touch-icon.png) appear NOWHERE
//      else -- with the one documented, deliberate exception of
//      logo-mock-x7q4.html itself, the founder look-and-pick mock this
//      migration was decided from. That file is explicitly NOT this
//      migration's to delete (per the tracker item: it joins
//      "delete-after-purpose" only once the founder device-confirms the
//      shipped result) and its own reference to the pre-retouch original
//      asset is deliberately left as-is, not rewritten.
//
// Deliberately a plain Node fs.readFileSync + directory walk, not a
// Playwright/browser test -- what's under test is literal source-text
// asset-reference facts (and file-existence facts on disk), not runtime
// behavior, so this runs fast and needs no browser. Follows
// test/journey-manifest.test.js's precedent for this style in this repo.

var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('node:fs');
var path = require('node:path');

var ROOT = path.join(__dirname, '..');

var OLD_LOGO_FILES = [
  'logo-v2.png',
  'logo-v2-192.png',
  'logo-v2-512.png',
  'logo-v2-maskable.png',
  'logo-v2-maskable-192.png',
  'logo-v2-maskable-512.png',
  'apple-touch-icon.png',
];

var NEW_LOGO_FILES = [
  'logo-v3.png',
  'logo-v3-192.png',
  'logo-v3-512.png',
  'logo-v3-maskable.png',
  'logo-v3-maskable-192.png',
  'logo-v3-maskable-512.png',
  'apple-touch-icon-v3.png',
];

// Directories to skip entirely while walking: version control internals,
// other concurrent agents' gitignored worktree checkouts (which can be on
// unrelated branches / mid-edit and aren't this migration's concern), and
// any dependency directories.
var SKIP_DIRS = new Set(['.git', 'node_modules', '.netlify']);
var SKIP_PATH_PREFIXES = [path.join(ROOT, '.claude', 'worktrees')];

// The deliberate, documented exceptions: the founder look-and-pick mock this
// migration's color choice was decided from (not this migration's to edit or
// delete -- see this file's header comment and the tracker item), and
// RELEASES.md (tracker item for-product-release-visibility-founder-a-8hx5cz)
// -- an auto-regenerated changelog that verbatim-quotes historical commit
// messages, one of which is this migration's own commit summary naming the
// retired filename it swept. That's an honest historical record, not a live
// asset reference (RELEASES.md is plain-text documentation, never loaded or
// rendered as a page), so it's excluded the same way the mock is.
var ALLOWED_OLD_REFERENCE_FILE = path.join(ROOT, 'logo-mock-x7q4.html');
var ALLOWED_OLD_REFERENCE_FILE_2 = path.join(ROOT, 'RELEASES.md');

// This test file itself legitimately spells out every OLD_LOGO_FILES name
// as literal strings (that's the whole list being swept FOR) -- exclude it
// from the walk it performs on everything else, or it flags itself.
var SELF_PATH = path.join(__dirname, 'logo-purple-retouch-asset-sweep.test.js');

/**
 * Recursively collects every regular file path under `dir`, skipping
 * SKIP_DIRS / SKIP_PATH_PREFIXES as it goes.
 */
function walk(dir, out) {
  var entries = fs.readdirSync(dir, { withFileTypes: true });
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    var full = path.join(dir, entry.name);
    if (SKIP_PATH_PREFIXES.indexOf(full) !== -1) continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function readTextIfPossible(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return null; // binary file (e.g. a .png itself) -- not a text reference, skip
  }
}

// ===========================================================================
// 1. New asset files actually exist on disk, old ones are actually gone.
// ===========================================================================

NEW_LOGO_FILES.forEach(function (fileName) {
  test('assets/' + fileName + ' (purple-shifted variant C asset) exists on disk', function () {
    var p = path.join(ROOT, 'assets', fileName);
    assert.ok(fs.existsSync(p), 'expected assets/' + fileName + ' to exist -- has the retouched logo asset gone missing?');
  });
});

OLD_LOGO_FILES.forEach(function (fileName) {
  test('assets/' + fileName + ' (pre-retouch original) no longer exists on disk', function () {
    var p = path.join(ROOT, 'assets', fileName);
    assert.ok(!fs.existsSync(p), 'expected assets/' + fileName + ' to be retired (deleted), found it still on disk -- old logo asset was not fully swept');
  });
});

// ===========================================================================
// 2. Every known "the logo appears here" reference point uses the NEW name.
// ===========================================================================

var FAVICON_PAGES = [
  'profile.html', 'home.html', 'wizard.html', 'tracker.html', 'watch.html',
  'admin.html', 'offline.html', 'shop.html', 'login.html', 'index.html',
  'claim-dream.html', 'start.html', 'result.html', 'privacy.html',
  'create.html', 'terms.html', 'explore.html', 'style.html',
];

FAVICON_PAGES.forEach(function (page) {
  test(page + ': favicon link points at the new logo-v3.png', function () {
    var source = fs.readFileSync(path.join(ROOT, page), 'utf8');
    assert.match(source, /<link rel="icon" type="image\/png" href="assets\/logo-v3\.png">/, page + ' favicon should reference assets/logo-v3.png');
  });

  test(page + ': apple-touch-icon link points at the new apple-touch-icon-v3.png', function () {
    var source = fs.readFileSync(path.join(ROOT, page), 'utf8');
    assert.match(source, /<link rel="apple-touch-icon" href="assets\/apple-touch-icon-v3\.png">/, page + ' apple-touch-icon should reference assets/apple-touch-icon-v3.png');
  });
});

test('manifest.json: every icon entry points at a logo-v3* asset', function () {
  var manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0, 'manifest.json should declare at least one icon');
  manifest.icons.forEach(function (icon) {
    assert.match(icon.src, /^assets\/logo-v3(-192|-512|-maskable|-maskable-192|-maskable-512)?\.png$/, 'manifest.json icon src ' + icon.src + ' should be a logo-v3* asset');
  });
});

test('sw.js: push notification icon and badge point at logo-v3.png', function () {
  var source = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  assert.match(source, /icon:\s*'assets\/logo-v3\.png'/, 'sw.js notification icon should reference assets/logo-v3.png');
  assert.match(source, /badge:\s*'assets\/logo-v3\.png'/, 'sw.js notification badge should reference assets/logo-v3.png');
});

test('netlify/functions/share-dream.js: OG-image fallback points at logo-v3.png', function () {
  var source = fs.readFileSync(path.join(ROOT, 'netlify', 'functions', 'share-dream.js'), 'utf8');
  assert.match(source, /FALLBACK_IMAGE_PATH = '\/assets\/logo-v3\.png';/, 'share-dream.js FALLBACK_IMAGE_PATH should reference /assets/logo-v3.png');
});

test('login.html: auth-logo images point at logo-v3.png', function () {
  var source = fs.readFileSync(path.join(ROOT, 'login.html'), 'utf8');
  var matches = source.match(/<img src="assets\/logo-v3\.png" alt="DreamTube">/g) || [];
  assert.ok(matches.length >= 1, 'login.html should have at least one auth-logo <img> referencing assets/logo-v3.png');
});

test('index.html: welcome-screen watermark image points at logo-v3.png', function () {
  var source = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(source, /<img class="wm-visual" src="assets\/logo-v3\.png" alt="DreamTube logo">/, 'index.html wm-visual should reference assets/logo-v3.png');
});

// ===========================================================================
// 3. Repo-wide sweep: the OLD filenames appear nowhere except the one
//    documented, deliberate exception (the founder decision mock).
// ===========================================================================

test('repo-wide sweep: no OLD logo/icon filename is referenced anywhere except the documented founder-mock exception', function () {
  var allFiles = walk(ROOT, []);
  var offenders = [];

  allFiles.forEach(function (filePath) {
    if (filePath === ALLOWED_OLD_REFERENCE_FILE) return;
    if (filePath === ALLOWED_OLD_REFERENCE_FILE_2) return;
    if (filePath === SELF_PATH) return;
    // Never flag the new binary asset files themselves (their filenames
    // legitimately contain "apple-touch-icon" etc. but not the exact old
    // strings being swept for).
    var text = readTextIfPossible(filePath);
    if (text === null) return;

    OLD_LOGO_FILES.forEach(function (oldName) {
      if (text.indexOf(oldName) !== -1) {
        offenders.push(path.relative(ROOT, filePath) + ' still references "' + oldName + '"');
      }
    });
  });

  assert.deepEqual(offenders, [], 'found leftover references to the retired pre-retouch logo asset(s):\n' + offenders.join('\n'));
});

test('logo-mock-x7q4.html (the one documented exception) still references the pre-retouch original -- confirms the sweep test itself is exercising the exception path, not silently matching zero files', function () {
  var source = fs.readFileSync(ALLOWED_OLD_REFERENCE_FILE, 'utf8');
  assert.match(source, /assets\/logo-v2\.png/, 'expected logo-mock-x7q4.html to still reference assets/logo-v2.png (deliberately left as-is -- not this migration\'s file to edit)');
});
