// test/comment-sheet-behavioral.test.js
//
// Real browser-driven coverage for js/comment-sheet.js — Social Layer v2
// slice 2 ("comments" — docs/SOCIAL_LAYER_V2_DESIGN.md, tracker item
// for-product-build-social-layer-v2-direct-34047c). Follows
// test/social-layer-v2-profile-behavioral.test.js's/test/ui-behavioral.test.js's
// own conventions: real Chromium via Playwright, page.route() to intercept
// the new comment endpoints instead of a real network/Blobs call,
// localStorage-seeded login state, safeGoto wrapping (this sandbox's known
// intermittent outbound-network stalls — see CLAUDE.md).
//
// Mounted via explore.html (one of this component's two mount points —
// the other, u.html, has its own coverage in
// test/social-layer-v2-profile-behavioral.test.js for what's SPECIFIC to
// that page's card layout (the top-2 comment-preview lines and the
// "View all N"/"Add a thought…" teaser, including that page's own,
// separate esc()-based render of the preview lines); this file focuses on
// the SHARED js/comment-sheet.js component itself, which behaves
// identically regardless of which page opened it.

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

function mockGetFeed(page, feed) {
  return page.route('**/.netlify/functions/get-feed', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ feed: feed, dreamOfDayId: null }) });
  });
}

/** Intercepts get-comments.js for a specific dreamId with a fixed response. */
function mockGetComments(page, dreamId, comments) {
  return page.route('**/.netlify/functions/get-comments?dreamId=' + encodeURIComponent(dreamId), function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ comments: comments }) });
  });
}

function makeDream(overrides) {
  return Object.assign({
    id: 'd1', caption: 'A dream', style: 'Cinematic',
    videoUrl: 'https://example.com/fake-feed-video.mp4', imageUrl: null, mediaType: 'video',
    ownerHandle: '@luna', avatar: null, likes: 3, commentCount: 0, publishedAt: 1000
  }, overrides || {});
}

async function seedUser(page, handle) {
  await safeGoto(page, baseUrl + '/login.html');
  await page.evaluate(function (handleArg) {
    var username = handleArg.replace(/^@/, '');
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: handleArg, username: username, authToken: 'fake-token-' + username };
    if (!state.accounts) state.accounts = {};
    state.accounts[username] = { password: 'testpass1', email: username + '@example.com' };
    if (!state.dreams) state.dreams = [];
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, handle);
}

test('comment sheet: signed-out visitor sees "Log in to comment" instead of a composer, and tapping it opens the signup nudge with no network call', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockGetFeed(page, [makeDream({ id: 'd1', commentCount: 1 })]);
    await mockGetComments(page, 'd1', [{ id: 'c1', handle: '@someone', text: 'nice dream', createdAt: new Date().toISOString() }]);
    var addCommentCalled = false;
    await page.route('**/.netlify/functions/add-comment', function (route) { addCommentCalled = true; route.abort(); });

    await safeGoto(page, baseUrl + '/explore.html');
    await page.waitForSelector('.feed-card', { timeout: 5000 });
    await page.click('[data-comments="d1"]');
    await page.waitForSelector('#comment-sheet-overlay.open', { timeout: 5000 });

    await page.waitForSelector('#cs-login-row', { timeout: 5000 });
    var loginRowText = await page.textContent('#cs-login-row');
    assert.match(loginRowText, /Log in to comment/);
    assert.equal(await page.$('#cs-composer-textarea'), null, 'no composer textarea should render for a signed-out visitor');

    await page.click('#cs-login-row');
    await page.waitForSelector('#modal-signup-nudge.open', { timeout: 2000 });
    assert.equal(addCommentCalled, false, 'no add-comment request should ever fire for a signed-out visitor');
  } finally {
    await context.close();
  }
});

test('XSS: a comment containing <script>/<img onerror> renders as inert literal text, never executes', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockGetFeed(page, [makeDream({ id: 'd1', commentCount: 2 })]);
    var maliciousText = 'nice dream <script>window.__xss_text=1</script>';
    var maliciousHandle = '@<img src=x onerror=window.__xss_handle=1>evil';
    await mockGetComments(page, 'd1', [
      { id: 'c1', handle: maliciousHandle, text: maliciousText, createdAt: new Date().toISOString() },
      { id: 'c2', handle: '@normal', text: 'a totally normal comment', createdAt: new Date().toISOString() }
    ]);

    await safeGoto(page, baseUrl + '/explore.html');
    await page.waitForSelector('.feed-card', { timeout: 5000 });
    await page.click('[data-comments="d1"]');
    await page.waitForSelector('.cs-comment', { timeout: 5000 });

    var xssText = await page.evaluate(function () { return window.__xss_text; });
    var xssHandle = await page.evaluate(function () { return window.__xss_handle; });
    assert.equal(xssText, undefined, 'a <script> tag embedded in comment text must never execute');
    assert.equal(xssHandle, undefined, 'an <img onerror> embedded in a handle must never execute');

    var bodyHTML = await page.$eval('#cs-list', function (el) { return el.innerHTML; });
    // The raw markup must still literally contain the ESCAPED entities
    // (proves it rendered as visible inert text, not silently stripped --
    // e.g. "&lt;img ... onerror=...&gt;" is expected and fine, since only
    // the angle brackets that would open/close a real tag are escaped) --
    // what must NEVER appear is a live, unescaped opening tag.
    assert.match(bodyHTML, /&lt;script&gt;/, 'the escaped script tag should be visible as literal text');
    assert.ok(bodyHTML.indexOf('<script>window.__xss_text') === -1, 'no live <script> tag should ever land in the DOM');
    assert.ok(bodyHTML.indexOf('<img src=x onerror') === -1, 'no live, unescaped <img onerror> tag should ever land in the DOM');
    assert.match(bodyHTML, /&lt;img src=x onerror=window\.__xss_handle=1&gt;/, 'the escaped img tag should be visible as literal text');

    var title = await page.textContent('#cs-title');
    assert.equal(title, 'Comments · 2');
  } finally {
    await context.close();
  }
});

test('per-instance token guard: closing the sheet mid-post and reopening it for a DIFFERENT dream must not let the stale response contaminate the new sheet or the closed card', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedUser(page, '@viewer');
    await mockGetFeed(page, [
      makeDream({ id: 'd-a', commentCount: 0 }),
      makeDream({ id: 'd-b', commentCount: 0, ownerHandle: '@other' })
    ]);
    await mockGetComments(page, 'd-a', []);
    await mockGetComments(page, 'd-b', []);

    var resolveAdd;
    var addPromise = new Promise(function (r) { resolveAdd = r; });
    await page.route('**/.netlify/functions/add-comment', async function (route) {
      await addPromise;
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ ok: true, comment: { id: 'real-c-a', handle: '@viewer', text: 'hello from A', createdAt: new Date().toISOString() }, commentCount: 1 })
      });
    });

    await safeGoto(page, baseUrl + '/explore.html');
    await page.waitForSelector('.feed-card', { timeout: 5000 });

    // Open dream A's sheet and post a comment (the request is held open by
    // the unresolved addPromise above).
    await page.click('[data-comments="d-a"]');
    await page.waitForSelector('#comment-sheet-overlay.open', { timeout: 5000 });
    await page.fill('#cs-composer-textarea', 'hello from A');
    await page.click('#cs-composer-post');
    // Optimistic insert should show immediately.
    await page.waitForSelector('.cs-comment', { timeout: 2000 });

    // Close the sheet (this bumps currentGen) and open dream B's instead,
    // all while dream A's add-comment request is still pending.
    await page.evaluate(function () { CommentSheet.hide(); });
    await page.click('[data-comments="d-b"]');
    await page.waitForSelector('#comment-sheet-overlay.open', { timeout: 5000 });
    // Dream B's sheet has genuinely loaded (its own empty state), proving
    // it's not still showing dream A's content.
    await page.waitForSelector('#cs-list .cs-empty', { timeout: 5000 });
    var titleAfterSwitch = await page.textContent('#cs-title');
    assert.equal(titleAfterSwitch, 'Comments · 0', "dream B's sheet must show ITS OWN comment count, not carry over dream A's in-flight optimistic state");

    // Now let dream A's delayed response resolve.
    resolveAdd();
    await page.waitForTimeout(300);

    // Dream B's currently-open sheet must be completely unaffected -- still
    // empty, no stray "hello from A" comment leaked in.
    var bListText = await page.textContent('#cs-list');
    assert.ok(bListText.indexOf('hello from A') === -1, "dream A's stale response must never write into dream B's sheet");

    // Dream A's card badge (in the underlying feed, no longer the open
    // sheet) must also be untouched by the stale response -- the guard
    // aborts the ENTIRE .then callback, including the onCountChange call
    // that would otherwise bump it.
    var aBadge = await page.textContent('[data-comment-count="d-a"]');
    assert.equal(aBadge, '0', "a stale response for a dream whose sheet has since been closed/reopened elsewhere must not mutate that dream's card DOM either");
  } finally {
    await context.close();
  }
});

test('posting a comment is optimistic, reconciles with the server response, and updates the card\'s comment-count badge', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedUser(page, '@viewer');
    await mockGetFeed(page, [makeDream({ id: 'd1', commentCount: 0 })]);
    await mockGetComments(page, 'd1', []);
    await page.route('**/.netlify/functions/add-comment', function (route) {
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ ok: true, comment: { id: 'real-1', handle: '@viewer', text: 'a real thought', createdAt: new Date().toISOString() }, commentCount: 1 })
      });
    });

    await safeGoto(page, baseUrl + '/explore.html');
    await page.waitForSelector('.feed-card', { timeout: 5000 });
    await page.click('[data-comments="d1"]');
    await page.waitForSelector('#comment-sheet-overlay.open', { timeout: 5000 });

    await page.fill('#cs-composer-textarea', 'a real thought');
    var postDisabled = await page.$eval('#cs-composer-post', function (el) { return el.disabled; });
    assert.equal(postDisabled, false, 'Post must be enabled once there is real text');

    await page.click('#cs-composer-post');
    await page.waitForSelector('.cs-comment', { timeout: 3000 });
    await page.waitForFunction(function () { return document.getElementById('cs-title').textContent === 'Comments · 1'; }, { timeout: 3000 });

    var cardBadge = await page.textContent('[data-comment-count="d1"]');
    assert.equal(cardBadge, '1', 'the underlying card badge should reflect the new count via onCountChange');

    // Composer clears and Post re-disables after a successful post.
    var textareaValue = await page.$eval('#cs-composer-textarea', function (el) { return el.value; });
    assert.equal(textareaValue, '');
  } finally {
    await context.close();
  }
});

test('posting a comment rolls back on a failed add-comment response, restoring the composer text and leaving no optimistic entry behind', async function (t) {
  // Fills the gap flagged in review: the prior delete-rollback test's mock
  // always returned ok:true, so submitComment's own .catch (js/comment-sheet.js's
  // "Couldn't post your comment — try again." branch) had zero coverage.
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedUser(page, '@viewer');
    await mockGetFeed(page, [makeDream({ id: 'd1', commentCount: 0 })]);
    await mockGetComments(page, 'd1', []);
    // Delayed on purpose (same pattern as the "second rapid tap while
    // pending" like-dream test) -- an instantly-resolving mock races the
    // optimistic-insert assertion below against the rollback under load,
    // since both happen on the same tick from this test's point of view.
    await page.route('**/.netlify/functions/add-comment', async function (route) {
      await new Promise(function (r) { setTimeout(r, 200); });
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'add_comment_failed: boom' }) });
    });

    await safeGoto(page, baseUrl + '/explore.html');
    await page.waitForSelector('.feed-card', { timeout: 5000 });
    await page.click('[data-comments="d1"]');
    await page.waitForSelector('#comment-sheet-overlay.open', { timeout: 5000 });

    await page.fill('#cs-composer-textarea', 'this will fail to post');
    await page.click('#cs-composer-post');

    // Optimistic insert happens immediately, well before the delayed
    // failure response lands.
    await page.waitForSelector('.cs-text', { timeout: 3000 });
    var optimisticText = await page.textContent('.cs-text');
    assert.equal(optimisticText, 'this will fail to post');

    // ...then rolls back once the (failed) response lands: the optimistic
    // row is removed, the sheet goes back to its empty state, and an error
    // toast fires -- the card's comment-count badge must NOT have moved.
    await page.waitForSelector('.cs-empty', { timeout: 3000 });
    var emptyText = await page.textContent('.cs-empty');
    assert.match(emptyText, /No thoughts yet/, 'the optimistic entry must be removed on failure, back to the empty state');
    await page.waitForFunction(function () { return document.getElementById('cs-title').textContent === 'Comments · 0'; }, { timeout: 3000 });

    var cardBadge = await page.textContent('[data-comment-count="d1"]');
    assert.equal(cardBadge, '0', 'a failed post must never bump the card badge (onCountChange only fires on success)');

    await page.waitForSelector('.toast.show', { timeout: 2000 });
    var toastText = await page.textContent('#toast');
    assert.match(toastText, /Couldn't post your comment/);
  } finally {
    await context.close();
  }
});

test('empty composer disables Post; the empty-comments state reads "No thoughts yet — be the first."', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedUser(page, '@viewer');
    await mockGetFeed(page, [makeDream({ id: 'd1', commentCount: 0 })]);
    await mockGetComments(page, 'd1', []);

    await safeGoto(page, baseUrl + '/explore.html');
    await page.waitForSelector('.feed-card', { timeout: 5000 });
    await page.click('[data-comments="d1"]');
    await page.waitForSelector('#comment-sheet-overlay.open', { timeout: 5000 });

    await page.waitForSelector('.cs-empty', { timeout: 5000 });
    var emptyText = await page.textContent('.cs-empty');
    assert.match(emptyText, /No thoughts yet — be the first\./);

    var postDisabled = await page.$eval('#cs-composer-post', function (el) { return el.disabled; });
    assert.equal(postDisabled, true, 'Post should start disabled with an empty composer');
  } finally {
    await context.close();
  }
});

test('per-comment overflow menu (kebab) opens on tap, closes on outside tap, and Delete only appears on the current user\'s own comment', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedUser(page, '@viewer');
    await mockGetFeed(page, [makeDream({ id: 'd1', commentCount: 2, ownerHandle: '@dreamowner' })]);
    await mockGetComments(page, 'd1', [
      { id: 'mine', handle: '@viewer', text: 'my own comment', createdAt: new Date().toISOString() },
      { id: 'theirs', handle: '@someoneelse', text: 'not my comment', createdAt: new Date().toISOString() }
    ]);

    await safeGoto(page, baseUrl + '/explore.html');
    await page.waitForSelector('.feed-card', { timeout: 5000 });
    await page.click('[data-comments="d1"]');
    await page.waitForSelector('.cs-comment', { timeout: 5000 });

    var mineRow = page.locator('.cs-comment[data-comment-id="mine"]');
    var theirsRow = page.locator('.cs-comment[data-comment-id="theirs"]');

    await mineRow.locator('[data-overflow-toggle]').click();
    await page.waitForSelector('#cs-overflow-mine.open', { timeout: 2000 });
    var mineActions = await mineRow.locator('.cs-overflow-item').allTextContents();
    assert.deepEqual(mineActions, ['Delete'], 'own comment: Delete only, no Report/Block on yourself');

    // Tapping elsewhere INSIDE the sheet (but outside any overflow menu)
    // closes the menu -- deliberately NOT a tap on the outer overlay
    // backdrop, which is a different, already-covered gesture
    // (js/sheet-dismiss.js's own tap-outside-to-close-the-WHOLE-sheet).
    await page.click('#cs-title');
    var stillOpen = await page.isVisible('#cs-overflow-mine.open');
    assert.equal(stillOpen, false, 'a tap elsewhere in the sheet should close the open overflow menu');
    var sheetStillOpen = await page.isVisible('#comment-sheet-overlay.open');
    assert.equal(sheetStillOpen, true, 'the sheet itself must stay open -- only the overflow menu should have closed');

    await theirsRow.locator('[data-overflow-toggle]').click();
    await page.waitForSelector('#cs-overflow-theirs.open', { timeout: 2000 });
    var theirsActions = await theirsRow.locator('.cs-overflow-item').allTextContents();
    assert.deepEqual(theirsActions, ['Report', 'Block'], "someone else's comment: Report + Block, no Delete (not mine, not the dream owner)");
  } finally {
    await context.close();
  }
});

test('tap-target: the per-comment overflow (kebab) button meets the 44px minimum (design doc QA checklist explicitly calls this out)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedUser(page, '@viewer');
    await mockGetFeed(page, [makeDream({ id: 'd1', commentCount: 1 })]);
    await mockGetComments(page, 'd1', [{ id: 'c1', handle: '@someone', text: 'hi', createdAt: new Date().toISOString() }]);

    await safeGoto(page, baseUrl + '/explore.html');
    await page.waitForSelector('.feed-card', { timeout: 5000 });
    await page.click('[data-comments="d1"]');
    await page.waitForSelector('.cs-overflow-btn', { timeout: 5000 });

    var box = await page.$eval('.cs-overflow-btn', function (el) { return el.getBoundingClientRect(); });
    assert.ok(box.width >= 44 && box.height >= 44, 'expected >=44px overflow-button tap target, got ' + box.width + 'x' + box.height);

    var postBox = await page.$eval('#cs-composer-post', function (el) { return el.getBoundingClientRect(); });
    assert.ok(postBox.height >= 44, 'expected >=44px Post button tap target, got ' + postBox.height);
  } finally {
    await context.close();
  }
});

test('deleting a comment succeeds optimistically, and blocking a comment author removes their comments from the list', async function (t) {
  // Renamed from a prior version that also claimed "rollback on failure" in
  // its title while mocking delete-comment to always return ok:true -- see
  // the dedicated failure test right below this one for that coverage.
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedUser(page, '@viewer');
    await mockGetFeed(page, [makeDream({ id: 'd1', commentCount: 2 })]);
    await mockGetComments(page, 'd1', [
      { id: 'mine', handle: '@viewer', text: 'delete me', createdAt: new Date().toISOString() },
      { id: 'blockme', handle: '@bad-actor', text: 'block me', createdAt: new Date().toISOString() }
    ]);
    await page.route('**/.netlify/functions/delete-comment', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, commentCount: 1 }) });
    });

    await safeGoto(page, baseUrl + '/explore.html');
    await page.waitForSelector('.feed-card', { timeout: 5000 });
    await page.click('[data-comments="d1"]');
    await page.waitForSelector('.cs-comment', { timeout: 5000 });

    var mineRow = page.locator('.cs-comment[data-comment-id="mine"]');
    await mineRow.locator('[data-overflow-toggle]').click();
    await page.waitForSelector('#cs-overflow-mine.open', { timeout: 2000 });
    await page.click('#cs-overflow-mine [data-action="delete"]');
    await page.waitForSelector('.cs-comment[data-comment-id="mine"]', { state: 'detached', timeout: 3000 });

    // Blocking the remaining comment's author removes it too (client-side,
    // no network call needed -- see js/store.js's blockUser doc comment).
    var blockRow = page.locator('.cs-comment[data-comment-id="blockme"]');
    await blockRow.locator('[data-overflow-toggle]').click();
    await page.waitForSelector('#cs-overflow-blockme.open', { timeout: 2000 });
    await page.click('#cs-overflow-blockme [data-action="block"]');
    await page.waitForSelector('.cs-empty', { timeout: 3000 });
    var emptyText = await page.textContent('.cs-empty');
    assert.match(emptyText, /No thoughts yet/);
  } finally {
    await context.close();
  }
});

test('deleting a comment rolls back on a failed delete-comment response, reinserting it at its original position', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedUser(page, '@viewer');
    await mockGetFeed(page, [makeDream({ id: 'd1', commentCount: 2 })]);
    await mockGetComments(page, 'd1', [
      { id: 'newer', handle: '@someone', text: 'newer comment', createdAt: new Date().toISOString() },
      { id: 'mine', handle: '@viewer', text: 'delete me but it fails', createdAt: new Date().toISOString() }
    ]);
    await page.route('**/.netlify/functions/delete-comment', function (route) {
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'delete_comment_failed: boom' }) });
    });

    await safeGoto(page, baseUrl + '/explore.html');
    await page.waitForSelector('.feed-card', { timeout: 5000 });
    await page.click('[data-comments="d1"]');
    await page.waitForSelector('.cs-comment', { timeout: 5000 });

    var mineRow = page.locator('.cs-comment[data-comment-id="mine"]');
    await mineRow.locator('[data-overflow-toggle]').click();
    await page.waitForSelector('#cs-overflow-mine.open', { timeout: 2000 });
    await page.click('#cs-overflow-mine [data-action="delete"]');

    // Optimistic removal happens immediately...
    await page.waitForSelector('.cs-comment[data-comment-id="mine"]', { state: 'detached', timeout: 3000 });

    // ...then the failed response reinserts it at its ORIGINAL position
    // (second row, not re-appended at the top) -- js/comment-sheet.js's
    // own deleteCommentAction splices back in at removedIndex.
    await page.waitForSelector('.cs-comment[data-comment-id="mine"]', { timeout: 3000 });
    var idsInOrder = await page.locator('.cs-comment').evaluateAll(function (els) {
      return els.map(function (el) { return el.dataset.commentId; });
    });
    assert.deepEqual(idsInOrder, ['newer', 'mine'], 'a failed delete must reinsert the comment at its original index, not lose the ordering');

    await page.waitForSelector('.toast.show', { timeout: 2000 });
    var toastText = await page.textContent('#toast');
    assert.match(toastText, /Couldn't delete/);
  } finally {
    await context.close();
  }
});
