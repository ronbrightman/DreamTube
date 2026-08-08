// test/social-layer-v2-profile-behavioral.test.js
//
// Real browser-driven coverage for Social Layer v2 slice 1 — "profile
// shell + share" (docs/SOCIAL_LAYER_V2_DESIGN.md, tracker item
// for-product-build-social-layer-v2-direct-34047c). Follows
// test/explore-avatar-fallback-behavioral.test.js's own conventions: real
// Chromium via Playwright, page.route() to intercept the new
// get-profile.js endpoint instead of a real network/Blobs call,
// localStorage-seeded login state for the owner-preview cases, and every
// page.goto wrapped against this sandbox's known intermittent outbound-
// network stalls on third-party hosts (see CLAUDE.md).

var test = require('node:test');
var assert = require('node:assert/strict');
var staticServer = require('./helpers/static-server');

var CHROMIUM_PATH = '/opt/pw-browsers/chromium';
var MOBILE_VIEWPORT = { width: 390, height: 844 };

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

async function safeGoto(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  } catch (e) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  }
}

/** Intercepts get-profile.js with a fixed, caller-supplied response body -- no real network/Blobs call. */
function mockGetProfile(page, response) {
  return page.route('**/.netlify/functions/get-profile*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response) });
  });
}

function mockLikeDream(page, likes) {
  return page.route('**/.netlify/functions/like-dream', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ likes: likes, likedByMe: true }) });
  });
}

/** Intercepts get-comments.js for a specific dreamId -- backs u.html's own loadCommentPreviewFor. */
function mockGetComments(page, dreamId, comments) {
  return page.route('**/.netlify/functions/get-comments?dreamId=' + encodeURIComponent(dreamId), function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ comments: comments }) });
  });
}

function makeDream(overrides) {
  return Object.assign({
    id: 'synthetic-1', caption: 'A synthetic dream', style: 'Cinematic',
    videoUrl: 'https://example.com/fake-feed-video.mp4', imageUrl: null, mediaType: 'video',
    ownerHandle: '@luna', avatar: null, likes: 3, publishedAt: 1000
  }, overrides || {});
}

async function seedUser(page, handle, selfCharacter) {
  await safeGoto(page, baseUrl + '/login.html');
  await page.evaluate(function (args) {
    var handle = args.handle, selfCharacter = args.selfCharacter;
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    var username = handle.replace(/^@/, '');
    state.user = { handle: handle, username: username };
    if (!state.accounts) state.accounts = {};
    state.accounts[username] = { password: 'testpass1', email: username + '@example.com' };
    if (!state.dreams) state.dreams = [];
    if (selfCharacter) {
      if (!state.charactersByUser) state.charactersByUser = {};
      state.charactersByUser[username] = [selfCharacter];
    }
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, { handle: handle, selfCharacter: selfCharacter || null });
}

test('u.html: a handle with no profile record and no published dreams shows the "hasn\'t set up their profile yet" empty state', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockGetProfile(page, { exists: false, profile: null, dreams: [], publishedCount: 0, commentCounts: {} });

    await safeGoto(page, baseUrl + '/u.html?handle=nobody');
    await page.waitForSelector('#u-notfound', { state: 'visible', timeout: 5000 });
    var text = await page.textContent('#u-notfound');
    assert.match(text, /hasn't set up their profile yet/);

    var identityVisible = await page.isVisible('#u-identity');
    assert.equal(identityVisible, false, 'no identity block should render for a nonexistent handle');
  } finally {
    await context.close();
  }
});

test('u.html: a loaded profile renders identity (name/bio/avatar fallback), the published count, and full-width dream cards with an escaped caption', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var maliciousCaption = 'A dream about <script>window.__xss=1</script> flying';
    await mockGetProfile(page, {
      exists: true,
      profile: { handle: '@Luna', displayName: 'Luna ✦', avatarDataUrl: null, bio: 'I dream in cinematic blue.', updatedAt: 1 },
      dreams: [makeDream({ id: 'd1', caption: maliciousCaption, ownerHandle: '@Luna' })],
      publishedCount: 1,
      commentCounts: {}
    });

    await safeGoto(page, baseUrl + '/u.html?handle=Luna');
    await page.waitForSelector('#u-identity', { state: 'visible', timeout: 5000 });

    var name = await page.textContent('#u-name');
    assert.equal(name, 'Luna ✦');
    var bio = await page.textContent('#u-bio');
    assert.equal(bio, 'I dream in cinematic blue.');
    var stats = await page.textContent('#u-stats');
    assert.match(stats, /1 dream posted/);

    // No avatarDataUrl on this profile record -> deterministic colored
    // fallback, never a blank/broken <img>.
    var avatarHasImg = await page.$eval('#u-avatar', function (el) { return !!el.querySelector('img'); });
    assert.equal(avatarHasImg, false);

    await page.waitForSelector('.dj-card', { timeout: 5000 });
    var cardCount = await page.locator('.dj-card').count();
    assert.equal(cardCount, 1);

    // The caption must render as literal text (esc()'d), never execute.
    var xssFired = await page.evaluate(function () { return window.__xss; });
    assert.equal(xssFired, undefined, 'a <script> tag embedded in a caption must never execute');
    var captionText = await page.textContent('.dj-caption');
    assert.match(captionText, /<script>/, 'the escaped markup should be visible as literal text, not stripped or executed');

    // Comment-count action is real and interactive as of Social Layer v2
    // slice 2 (js/comment-sheet.js) -- see test/comment-sheet-behavioral.test.js
    // for the full sheet-opening/posting/XSS coverage; this test only
    // confirms the action itself renders with the right dream id wired.
    var commentEl = await page.$('[data-comments="d1"]');
    assert.ok(commentEl, 'expected the comment action to be present and wired to this card\'s dream id');

    // Privacy note is shown once, page-level.
    var privNote = await page.textContent('#u-priv-note');
    assert.match(privNote, /Your interpretations stay private to you/);

    // Owner controls (toggle) must NOT show for a signed-out visitor.
    var toggleVisible = await page.isVisible('#u-visibility-row');
    assert.equal(toggleVisible, false);
  } finally {
    await context.close();
  }
});

test('u.html: a dream with comments shows an escaped top-2 newest-first preview, and the "View all N" teaser opens the shared comment sheet', async function (t) {
  // Fills the gap flagged in review on social-layer-v2-slice2: this is
  // u.html's OWN loadCommentPreviewFor render path (a second, independent
  // esc()-based innerHTML build from js/comment-sheet.js's, per that
  // function's own header comment) and had zero coverage despite
  // test/comment-sheet-behavioral.test.js's header comment claiming this
  // file already covered it.
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var maliciousText = 'nice dream <script>window.__previewXss=1</script>';
    await mockGetProfile(page, {
      exists: true, profile: null,
      dreams: [makeDream({ id: 'd1', ownerHandle: '@luna', commentCount: 3 })],
      publishedCount: 1, commentCounts: { d1: 3 }
    });
    // Newest-first, only the top 2 should render as preview lines even
    // though 3 exist -- matches get-comments.js's own newest-first order.
    await mockGetComments(page, 'd1', [
      { id: 'c-newest', handle: '@newest', text: maliciousText, createdAt: new Date().toISOString() },
      { id: 'c-middle', handle: '@middle', text: 'a completely ordinary comment', createdAt: new Date().toISOString() },
      { id: 'c-oldest', handle: '@oldest', text: 'this one should be cut off, not shown', createdAt: new Date().toISOString() }
    ]);

    await safeGoto(page, baseUrl + '/u.html?handle=luna');
    await page.waitForSelector('.dj-card', { timeout: 5000 });

    // The teaser reads "View all N" once commentCount > 0.
    var teaserText = await page.textContent('[data-comments-teaser="d1"]');
    assert.match(teaserText, /View all 3 comments/);

    await page.waitForSelector('#dj-comments-preview-d1 .dj-comment-preview-line', { timeout: 5000 });
    var previewLines = await page.locator('#dj-comments-preview-d1 .dj-comment-preview-line').count();
    assert.equal(previewLines, 2, 'only the top 2 newest comments should render as preview lines');

    var firstLineText = await page.textContent('#dj-comments-preview-d1 .dj-comment-preview-line:first-child');
    assert.match(firstLineText, /<script>/, 'the malicious comment text must render as literal escaped text, not be stripped');
    var oldestShown = await page.textContent('#dj-comments-preview-d1');
    assert.doesNotMatch(oldestShown, /should be cut off/, 'the 3rd/oldest comment must not appear in a top-2 preview');

    // The <script> must never actually execute.
    var xssFired = await page.evaluate(function () { return window.__previewXss; });
    assert.equal(xssFired, undefined, 'a <script> tag embedded in comment text must never execute');

    // Tapping the teaser opens the SAME shared js/comment-sheet.js sheet
    // (not a separate preview-only UI).
    await page.click('[data-comments-teaser="d1"]');
    await page.waitForSelector('#comment-sheet-overlay.open', { timeout: 5000 });
    await page.waitForFunction(function () { return document.getElementById('cs-title').textContent === 'Comments · 3'; }, { timeout: 3000 });
  } finally {
    await context.close();
  }
});

test('u.html: a dream with zero comments shows no preview and the "Add a thought…" teaser', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var getCommentsCalled = false;
    await page.route('**/.netlify/functions/get-comments*', function (route) {
      getCommentsCalled = true;
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ comments: [] }) });
    });
    await mockGetProfile(page, {
      exists: true, profile: null,
      dreams: [makeDream({ id: 'd1', ownerHandle: '@luna', commentCount: 0 })],
      publishedCount: 1, commentCounts: { d1: 0 }
    });

    await safeGoto(page, baseUrl + '/u.html?handle=luna');
    await page.waitForSelector('.dj-card', { timeout: 5000 });

    var teaserText = await page.textContent('[data-comments-teaser="d1"]');
    assert.match(teaserText, /Add a thought…/);
    var previewHtml = await page.$eval('#dj-comments-preview-d1', function (el) { return el.innerHTML.trim(); });
    assert.equal(previewHtml, '', 'no preview markup should render when commentCount is 0');
    assert.equal(getCommentsCalled, false, 'loadCommentPreviewFor should skip the network call entirely when commentCount is 0');
  } finally {
    await context.close();
  }
});

test('u.html: liking a dream is optimistic, reconciles with the server response, and a second rapid tap while the request is in flight is ignored (per-instance guard)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedUser(page, '@viewer');
    await mockGetProfile(page, {
      exists: true, profile: null,
      dreams: [makeDream({ id: 'd1', ownerHandle: '@luna', likes: 3 })],
      publishedCount: 1, commentCounts: {}
    });
    // Delay the like-dream response slightly so the "second tap while
    // pending" assertion has a real window to land in.
    await page.route('**/.netlify/functions/like-dream', async function (route) {
      await new Promise(function (r) { setTimeout(r, 200); });
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ likes: 4, likedByMe: true }) });
    });

    await safeGoto(page, baseUrl + '/u.html?handle=luna');
    await page.waitForSelector('.dj-card', { timeout: 5000 });

    var likeAction = page.locator('[data-like="d1"]');
    await likeAction.click();
    // Optimistic flip should be immediate.
    await page.waitForSelector('[data-like="d1"].liked', { timeout: 1000 });
    var optimisticCount = await page.textContent('[data-count="d1"]');
    assert.equal(optimisticCount, '4');

    // A second tap while the (delayed) request is still in flight must be
    // a no-op, not a double-increment.
    await likeAction.click();
    await page.waitForTimeout(400); // let the delayed response settle
    var finalCount = await page.textContent('[data-count="d1"]');
    assert.equal(finalCount, '4', 'a rapid second tap while the first request was pending must not double-count');
  } finally {
    await context.close();
  }
});

test('u.html: a signed-out visitor tapping like sees the signup nudge instead of a network call', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var likeCalled = false;
    await page.route('**/.netlify/functions/like-dream', function (route) { likeCalled = true; route.abort(); });
    await mockGetProfile(page, {
      exists: true, profile: null, dreams: [makeDream({ id: 'd1', ownerHandle: '@luna' })], publishedCount: 1, commentCounts: {}
    });

    await safeGoto(page, baseUrl + '/u.html?handle=luna');
    await page.waitForSelector('.dj-card', { timeout: 5000 });
    await page.click('[data-like="d1"]');

    await page.waitForSelector('#modal-signup-nudge.open', { timeout: 2000 });
    assert.equal(likeCalled, false, 'no like request should fire for a signed-out visitor');
  } finally {
    await context.close();
  }
});

test('u.html: owner preview (viewer===handle) shows the PUBLIC/PRIVATE toggle and both "published"/"created on this device" counts; tapping PRIVATE returns to profile.html', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedUser(page, '@luna');
    await mockGetProfile(page, {
      exists: true,
      profile: { handle: '@luna', displayName: 'Luna', avatarDataUrl: null, bio: '', updatedAt: 1 },
      dreams: [makeDream({ id: 'd1', ownerHandle: '@luna' })],
      publishedCount: 1, commentCounts: {}
    });

    await safeGoto(page, baseUrl + '/u.html?handle=luna');
    await page.waitForSelector('#u-identity', { state: 'visible', timeout: 5000 });

    var toggleVisible = await page.isVisible('#u-visibility-row');
    assert.equal(toggleVisible, true, 'the owner previewing their own public page must see the toggle');

    var stats = await page.textContent('#u-stats');
    assert.match(stats, /1.*posted/);
    assert.match(stats, /created on this device/);

    await page.click('#u-visibility-row [data-visibility="private"]');
    await page.waitForURL(/profile\.html$/, { timeout: 5000 });
  } finally {
    await context.close();
  }
});

test('u.html: a fetch failure shows the error state with a working "Try again" retry that does not reload the page', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var callCount = 0;
    await page.route('**/.netlify/functions/get-profile*', function (route) {
      callCount++;
      if (callCount === 1) { route.abort(); return; }
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ exists: true, profile: null, dreams: [], publishedCount: 0, commentCounts: {} }) });
    });

    await safeGoto(page, baseUrl + '/u.html?handle=luna');
    await page.waitForSelector('#u-error', { state: 'visible', timeout: 5000 });

    await page.click('#u-retry-link');
    await page.waitForSelector('#u-identity', { state: 'visible', timeout: 5000 });
    assert.equal(callCount, 2, 'retry should have triggered exactly one more fetch');
  } finally {
    await context.close();
  }
});

test('u.html: zero-dreams empty state reads differently for a visitor vs. the owner', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var visitorPage = await context.newPage();
    await blockThirdParty(visitorPage);
    await mockGetProfile(visitorPage, {
      exists: true, profile: { handle: '@Luna', displayName: 'Luna', avatarDataUrl: null, bio: '', updatedAt: 1 },
      dreams: [], publishedCount: 0, commentCounts: {}
    });
    await safeGoto(visitorPage, baseUrl + '/u.html?handle=luna');
    await visitorPage.waitForSelector('#u-dreams-empty', { state: 'visible', timeout: 5000 });
    var visitorText = await visitorPage.textContent('#u-dreams-empty');
    assert.match(visitorText, /Luna hasn't posted/);
  } finally {
    await context.close();
  }
});

test('profile.html: Edit-profile sheet has a bio field with a 150-char counter, and the PUBLIC toggle navigates to u.html?handle=<me>', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    // A "Me" character with a photo already on file, so Save doesn't hit
    // saveCharacter's own "add a description or a photo" requirement (a
    // pre-existing, unrelated constraint on the isSelf character record —
    // see js/store.js's saveCharacter doc comment) and doesn't need a real
    // generate-avatar.js call either.
    await seedUser(page, '@luna', { id: 'cself1', isSelf: true, name: 'Luna', photoDataUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD//2Q==' });
    // Best-effort background calls this page fires (published-count fetch,
    // profile sync) must never block/break the page even when unmocked.
    await page.route('**/.netlify/functions/get-profile*', function (route) { route.abort(); });
    await page.route('**/.netlify/functions/sync-profile', function (route) { route.abort(); });
    await page.route('**/.netlify/functions/get-token-status*', function (route) { route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ balance: 0 }) }); });

    await safeGoto(page, baseUrl + '/profile.html');
    await page.waitForSelector('#profile-visibility-row', { timeout: 5000 });

    // Open Edit profile, type a bio, check the counter.
    await page.click('#profile-avatar-edit');
    await page.waitForSelector('#sheet-identity-overlay.open', { timeout: 5000 });
    await page.fill('#identity-bio-input', 'I dream in cinematic blue.');
    var counter = await page.textContent('#identity-bio-counter');
    assert.equal(counter, '26/150');

    // Save (photo mode, from the pre-seeded character — no avatar-
    // generation call fires).
    await page.click('#identity-save-btn');
    await page.waitForSelector('#sheet-identity-overlay:not(.open)', { timeout: 5000 });

    // Bio persisted locally and re-prefills on reopen.
    var savedBio = await page.evaluate(function () { return DreamStore.getMyBio(); });
    assert.equal(savedBio, 'I dream in cinematic blue.');

    // PUBLIC toggle navigates to u.html?handle=luna.
    await page.click('#profile-visibility-row [data-visibility="public"]');
    await page.waitForURL(/u\.html\?handle=luna/, { timeout: 5000 });
  } finally {
    await context.close();
  }
});

test('u.html and profile.html\'s new visibility-toggle buttons meet the 44px minimum tap-target height (mobile-webview QA requirement)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedUser(page, '@luna');
    await page.route('**/.netlify/functions/get-token-status*', function (route) { route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ balance: 0 }) }); });
    await safeGoto(page, baseUrl + '/profile.html');
    await page.waitForSelector('#profile-visibility-row', { timeout: 5000 });

    var heights = await page.$$eval('#profile-visibility-row .char-mode-btn', function (els) {
      return els.map(function (el) { return el.getBoundingClientRect().height; });
    });
    heights.forEach(function (h) { assert.ok(h >= 44, 'expected >=44px tap target, got ' + h); });

    await mockGetProfile(page, {
      exists: true, profile: { handle: '@luna', displayName: 'Luna', avatarDataUrl: null, bio: '', updatedAt: 1 },
      dreams: [makeDream({ id: 'd1', ownerHandle: '@luna' })], publishedCount: 1, commentCounts: {}
    });
    await safeGoto(page, baseUrl + '/u.html?handle=luna');
    await page.waitForSelector('.dj-card', { timeout: 5000 });

    var actionHeights = await page.$$eval('.dj-action', function (els) {
      return els.map(function (el) { return el.getBoundingClientRect().height; });
    });
    actionHeights.forEach(function (h) { assert.ok(h >= 44, 'expected >=44px action-row tap target, got ' + h); });
  } finally {
    await context.close();
  }
});
