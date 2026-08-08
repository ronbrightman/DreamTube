// test/social-layer-v2-follow-behavioral.test.js
//
// Real browser-driven coverage for Social Layer v2 slice 3 ("follow" —
// docs/SOCIAL_LAYER_V2_DESIGN.md, tracker item
// for-product-build-social-layer-v2-direct-34047c). Follows
// test/social-layer-v2-profile-behavioral.test.js's/test/comment-sheet-
// behavioral.test.js's own conventions: real Chromium via Playwright,
// page.route() to intercept the new follow endpoints instead of a real
// network/Blobs call, localStorage-seeded login state (with a real
// `authToken` field — get-following.js/follow-user.js are both auth-gated,
// same as add-comment.js/delete-comment.js), and every page.goto wrapped
// against this sandbox's known intermittent outbound-network stalls (see
// CLAUDE.md).
//
// Covers: u.html's Follow button (no button on your own profile, a
// signed-out tap routing to the signup nudge with no network call,
// optimistic flip + server reconciliation, a genuine failed-follow rollback
// with toast, the per-instance guard against a rapid second tap AND against
// two genuinely separate profile instances in flight at once never
// cross-contaminating each other's state — the exact documented recurring
// bug class this feature's own build task calls out), profile.html's
// owner-only follower count, explore.html's "Following" filter chip
// (filters to followed accounts only, signed-out gating), and the LOCKED
// constraint that a follower count never appears anywhere on u.html's
// public view of someone else's profile.

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

function mockGetProfile(page, response) {
  return page.route('**/.netlify/functions/get-profile*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response) });
  });
}

function mockGetFollowing(page, response) {
  return page.route('**/.netlify/functions/get-following*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(Object.assign({ ok: true, following: [], followerCount: 0 }, response)) });
  });
}

function mockGetFeed(page, feed) {
  return page.route('**/.netlify/functions/get-feed', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ feed: feed, dreamOfDayId: null }) });
  });
}

function makeDream(overrides) {
  return Object.assign({
    id: 'synthetic-1', caption: 'A synthetic dream', style: 'Cinematic',
    videoUrl: 'https://example.com/fake-feed-video.mp4', imageUrl: null, mediaType: 'video',
    ownerHandle: '@luna', avatar: null, likes: 3, commentCount: 0, publishedAt: 1000
  }, overrides || {});
}

/** Seeds js/store.js's localStorage state with a signed-in account, including a real `authToken` field -- get-following.js/follow-user.js are both auth-gated, same shape test/comment-sheet-behavioral.test.js's own seedUser uses for add-comment.js/delete-comment.js. */
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

// ===================================================================
// u.html: Follow button
// ===================================================================

test('u.html: no Follow button renders when viewing your own profile', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedUser(page, '@luna');
    await mockGetProfile(page, {
      exists: true, profile: { handle: '@luna', displayName: 'Luna', avatarDataUrl: null, bio: '', updatedAt: 1 },
      dreams: [], publishedCount: 0, commentCounts: {}
    });

    await safeGoto(page, baseUrl + '/u.html?handle=luna');
    await page.waitForSelector('#u-identity', { state: 'visible', timeout: 5000 });

    var followVisible = await page.isVisible('#u-follow-btn');
    assert.equal(followVisible, false, 'the owner previewing their own public page must never see a Follow button');
  } finally {
    await context.close();
  }
});

test('u.html: a signed-out visitor tapping Follow sees the signup nudge (with next= back to this profile) instead of a network call', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var followCalled = false;
    await page.route('**/.netlify/functions/follow-user', function (route) { followCalled = true; route.abort(); });
    await mockGetProfile(page, {
      exists: true, profile: null,
      dreams: [makeDream({ id: 'd1', ownerHandle: '@luna' })], publishedCount: 1, commentCounts: {}
    });

    await safeGoto(page, baseUrl + '/u.html?handle=luna');
    await page.waitForSelector('#u-follow-btn', { state: 'visible', timeout: 5000 });
    await page.click('#u-follow-btn');

    await page.waitForSelector('#modal-signup-nudge.open', { timeout: 2000 });
    var nextHref = await page.getAttribute('#signup-nudge-cta', 'href');
    assert.match(nextHref, /next=.*u\.html/i);
    assert.equal(followCalled, false, 'no follow request should fire for a signed-out visitor');
  } finally {
    await context.close();
  }
});

test('u.html: Follow optimistically flips to Following and reconciles with the server response; a second rapid tap while the request is in flight is ignored (per-instance guard)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedUser(page, '@viewer');
    await mockGetProfile(page, {
      exists: true, profile: null,
      dreams: [makeDream({ id: 'd1', ownerHandle: '@luna' })], publishedCount: 1, commentCounts: {}
    });
    await mockGetFollowing(page, { following: [], followerCount: 0 });
    var followCallCount = 0;
    // Delay the response slightly so the "second tap while pending" assertion has a real window to land in.
    await page.route('**/.netlify/functions/follow-user', async function (route) {
      followCallCount++;
      await new Promise(function (r) { setTimeout(r, 200); });
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, following: true }) });
    });

    await safeGoto(page, baseUrl + '/u.html?handle=luna');
    await page.waitForSelector('#u-follow-btn', { state: 'visible', timeout: 5000 });

    var followBtn = page.locator('#u-follow-btn');
    await followBtn.click();
    // Optimistic flip should be immediate.
    await page.waitForFunction(function () {
      var el = document.getElementById('u-follow-btn');
      return el && el.textContent.trim() === 'Following';
    }, null, { timeout: 1000 });
    assert.equal(await followBtn.evaluate(function (el) { return el.classList.contains('btn-secondary'); }), true, 'optimistic "Following" state should use the outline (btn-secondary) style');

    // A second tap while the (delayed) request is still in flight must be a no-op.
    await followBtn.click();
    await page.waitForTimeout(400); // let the delayed response settle
    assert.equal(followCallCount, 1, 'a rapid second tap while the first request was pending must not fire a second follow-user request');
    var finalText = await followBtn.textContent();
    assert.equal(finalText.trim(), 'Following');
  } finally {
    await context.close();
  }
});

test('u.html: a failed follow request rolls back the optimistic flip to Follow and shows a toast', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedUser(page, '@viewer');
    await mockGetProfile(page, {
      exists: true, profile: null,
      dreams: [makeDream({ id: 'd1', ownerHandle: '@luna' })], publishedCount: 1, commentCounts: {}
    });
    await mockGetFollowing(page, { following: [], followerCount: 0 });
    // Delayed on purpose (same pattern test/comment-sheet-behavioral.test.js's
    // own failed-post rollback test uses) -- an instantly-resolving mock
    // races the optimistic-flip assertion below against the rollback under
    // load, since both would otherwise land on the same tick from this
    // test's point of view.
    await page.route('**/.netlify/functions/follow-user', async function (route) {
      await new Promise(function (r) { setTimeout(r, 200); });
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'follow_toggle_failed' }) });
    });

    await safeGoto(page, baseUrl + '/u.html?handle=luna');
    await page.waitForSelector('#u-follow-btn', { state: 'visible', timeout: 5000 });
    var followBtn = page.locator('#u-follow-btn');
    await followBtn.click();
    // Optimistic flip happens immediately, well before the delayed failure response lands.
    await page.waitForFunction(function () {
      var el = document.getElementById('u-follow-btn');
      return el && el.textContent.trim() === 'Following';
    }, null, { timeout: 1000 });

    // Rolls back once the failure lands.
    await page.waitForFunction(function () {
      var el = document.getElementById('u-follow-btn');
      return el && el.textContent.trim() === 'Follow';
    }, null, { timeout: 2000 });
    assert.equal(await followBtn.evaluate(function (el) { return el.classList.contains('btn-primary'); }), true, 'rolled-back "Follow" state should use the primary style again');
    var toastText = await page.textContent('#toast');
    assert.match(toastText, /couldn't update follow/i);
  } finally {
    await context.close();
  }
});

test('u.html: two DIFFERENT profile instances (separate tabs) with follow requests in flight at once never cross-contaminate each other\'s Follow/Following state', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var pageAlice = await context.newPage();
    var pageBob = await context.newPage();
    await blockThirdParty(pageAlice);
    await blockThirdParty(pageBob);
    await seedUser(pageAlice, '@viewer');
    // Same browser context -- localStorage (and thus the signed-in account)
    // is shared across both tabs, same as two real tabs signed into the
    // same DreamTube account would be.

    await mockGetProfile(pageAlice, {
      exists: true, profile: null,
      dreams: [makeDream({ id: 'd-alice', ownerHandle: '@alice' })], publishedCount: 1, commentCounts: {}
    });
    await mockGetProfile(pageBob, {
      exists: true, profile: null,
      dreams: [makeDream({ id: 'd-bob', ownerHandle: '@bob' })], publishedCount: 1, commentCounts: {}
    });
    await mockGetFollowing(pageAlice, { following: [], followerCount: 0 });
    await mockGetFollowing(pageBob, { following: [], followerCount: 0 });

    // Alice's tab: follow succeeds (following:true) after a delay.
    await pageAlice.route('**/.netlify/functions/follow-user', async function (route) {
      await new Promise(function (r) { setTimeout(r, 250); });
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, following: true }) });
    });
    // Bob's tab: follow FAILS after a shorter delay -- deliberately
    // resolves BEFORE alice's tab's own in-flight request, so if either
    // tab's async callback were writing into shared/global state instead
    // of state scoped to its own page, this ordering would be the one to
    // expose it.
    await pageBob.route('**/.netlify/functions/follow-user', async function (route) {
      await new Promise(function (r) { setTimeout(r, 80); });
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'follow_toggle_failed' }) });
    });

    await safeGoto(pageAlice, baseUrl + '/u.html?handle=alice');
    await safeGoto(pageBob, baseUrl + '/u.html?handle=bob');
    await pageAlice.waitForSelector('#u-follow-btn', { state: 'visible', timeout: 5000 });
    await pageBob.waitForSelector('#u-follow-btn', { state: 'visible', timeout: 5000 });

    // Tap BOTH before either resolves.
    await pageAlice.click('#u-follow-btn');
    await pageBob.click('#u-follow-btn');

    // Bob's (shorter-delay, failing) request settles first -- rolls back to Follow.
    await pageBob.waitForFunction(function () {
      var el = document.getElementById('u-follow-btn');
      return el && el.textContent.trim() === 'Follow';
    }, null, { timeout: 2000 });

    // Alice's (longer-delay, succeeding) request settles after -- must
    // still land on Following, completely unaffected by Bob's tab's own
    // failure/rollback.
    await pageAlice.waitForFunction(function () {
      var el = document.getElementById('u-follow-btn');
      return el && el.textContent.trim() === 'Following';
    }, null, { timeout: 2000 });

    var aliceFinal = (await pageAlice.textContent('#u-follow-btn')).trim();
    var bobFinal = (await pageBob.textContent('#u-follow-btn')).trim();
    assert.equal(aliceFinal, 'Following', "alice's tab must reflect ITS OWN successful follow, unaffected by bob's tab");
    assert.equal(bobFinal, 'Follow', "bob's tab must reflect ITS OWN failed follow, unaffected by alice's tab");
  } finally {
    await context.close();
  }
});

test('u.html: LOCKED CONSTRAINT -- no follower count ever renders anywhere on the public view of someone else\'s profile', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedUser(page, '@viewer');
    await mockGetProfile(page, {
      exists: true, profile: { handle: '@luna', displayName: 'Luna', avatarDataUrl: null, bio: '', updatedAt: 1 },
      dreams: [makeDream({ id: 'd1', ownerHandle: '@luna' })], publishedCount: 1, commentCounts: {}
    });
    // Even if the viewer's own following-status fetch happened to carry a
    // real followerCount for THEIR OWN account, it must never leak onto
    // this page anywhere -- this response deliberately carries a nonzero,
    // easy-to-spot value.
    await mockGetFollowing(page, { following: [], followerCount: 42 });

    await safeGoto(page, baseUrl + '/u.html?handle=luna');
    await page.waitForSelector('#u-identity', { state: 'visible', timeout: 5000 });
    await page.waitForSelector('#u-follow-btn', { state: 'visible', timeout: 5000 });

    var bodyText = await page.textContent('#app');
    assert.doesNotMatch(bodyText, /follower/i, 'no "follower(s)" text should ever render on the public profile view');
    var statsText = await page.textContent('#u-stats');
    assert.doesNotMatch(statsText, /42/, 'the viewer\'s own followerCount must never leak into the stats line of a DIFFERENT profile\'s public view');
  } finally {
    await context.close();
  }
});

// ===================================================================
// profile.html: owner-only follower count
// ===================================================================

test('profile.html: shows the owner\'s own follower count next to the existing "posted"/"created on this device" stats', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedUser(page, '@luna');
    await mockGetFollowing(page, { following: [], followerCount: 7 });
    await mockGetProfile(page, { exists: true, profile: null, dreams: [], publishedCount: 0, commentCounts: {} });

    await safeGoto(page, baseUrl + '/profile.html');
    await page.waitForSelector('#stat-followers', { timeout: 5000 });
    await page.waitForFunction(function () {
      return document.getElementById('stat-followers').textContent === '7';
    }, null, { timeout: 3000 });

    var statsText = await page.textContent('.profile-stats');
    assert.match(statsText, /7\s*<\/b>\s*followers|7.*followers/i);
  } finally {
    await context.close();
  }
});

// ===================================================================
// explore.html: "Following" filter chip
// ===================================================================

test('explore.html: the Following chip filters the feed to only accounts the viewer follows, and clearing it restores the full feed', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedUser(page, '@viewer');
    await mockGetFeed(page, [
      makeDream({ id: 'd-alice', ownerHandle: '@alice' }),
      makeDream({ id: 'd-bob', ownerHandle: '@bob' })
    ]);
    await mockGetFollowing(page, { following: ['@alice'], followerCount: 0 });

    await safeGoto(page, baseUrl + '/explore.html');
    await page.waitForSelector('[data-id="d-alice"]', { timeout: 5000 });
    await page.waitForSelector('[data-id="d-bob"]', { timeout: 5000 });

    await page.click('#following-filter-chip');
    await page.waitForFunction(function () {
      return document.querySelector('[data-id="d-alice"]') && !document.querySelector('[data-id="d-bob"]');
    }, null, { timeout: 3000 });

    var chipText = await page.textContent('#filter-chip');
    assert.match(chipText, /Following/);
    var chipActive = await page.evaluate(function () {
      return document.getElementById('following-filter-chip').classList.contains('active');
    });
    assert.equal(chipActive, true);

    // Clearing via the active-filter chip's own X restores the full feed --
    // same generic clear mechanism every other filter type already uses.
    await page.click('#filter-chip');
    await page.waitForSelector('[data-id="d-bob"]', { timeout: 3000 });
    var bothPresent = await page.evaluate(function () {
      return !!document.querySelector('[data-id="d-alice"]') && !!document.querySelector('[data-id="d-bob"]');
    });
    assert.equal(bothPresent, true);
  } finally {
    await context.close();
  }
});

test('explore.html: a signed-out visitor tapping the Following chip sees the signup nudge, with no following fetch and no filter applied', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var followingFetched = false;
    await page.route('**/.netlify/functions/get-following*', function (route) { followingFetched = true; route.abort(); });
    await mockGetFeed(page, [
      makeDream({ id: 'd-alice', ownerHandle: '@alice' }),
      makeDream({ id: 'd-bob', ownerHandle: '@bob' })
    ]);

    await safeGoto(page, baseUrl + '/explore.html');
    await page.waitForSelector('[data-id="d-alice"]', { timeout: 5000 });
    await page.click('#following-filter-chip');

    await page.waitForSelector('#modal-signup-nudge.open', { timeout: 2000 });
    assert.equal(followingFetched, false, 'a signed-out visitor should never trigger a get-following fetch');
    var bothPresent = await page.evaluate(function () {
      return !!document.querySelector('[data-id="d-alice"]') && !!document.querySelector('[data-id="d-bob"]');
    });
    assert.equal(bothPresent, true, 'the feed must remain unfiltered for a signed-out tap');
  } finally {
    await context.close();
  }
});
