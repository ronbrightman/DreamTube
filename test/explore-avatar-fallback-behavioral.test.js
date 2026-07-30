// test/explore-avatar-fallback-behavioral.test.js
//
// Real browser-driven coverage for tracker item for-product-ui-founder-
// directed-2026-07--djgjn0: Explore's feed-user-row avatar circle used to
// render permanently empty (explore.html's old cardHTML had a bare
// '<div class="feed-avatar"></div>', nothing ever populated it — verified
// at origin/main explore.html:256 before this branch).
//
// The fix (explore.html's new avatarHTML(), js/store.js's avatarFallback/
// getMeAvatarDataUrl/syncPublishedDreamToFeed's `avatar` thumbnail):
//   1. A real photo renders when there is one — either the small `avatar`
//      thumbnail synced at publish time (another author's dream), or,
//      for the viewer's OWN published dreams specifically, an immediate
//      backfill straight from this device's local Me-character photo
//      (no waiting on any server round trip — the founder's own explicit
//      ask).
//   2. Otherwise, a DETERMINISTIC per-username colored-initial fallback —
//      same color + initial for the same username on every render, on
//      every device (a pure function of the username, no Math.random) —
//      covers both "this author never set a Me photo" and "this dream
//      predates the avatar field entirely" (legacy records). Never a
//      blank/empty gray circle either way.
//
// Follows test/feed-windowing-behavioral.test.js's and
// test/profile-me-character-behavioral.test.js's conventions: node:test +
// real Chromium via Playwright, page.route() to intercept get-feed
// instead of a real network/Blobs call, localStorage-seeded login state
// for the "viewer's own dream" backfill case, and every page.goto wrapped
// against this sandbox's known intermittent outbound-network stalls on
// third-party hosts (see CLAUDE.md).

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

/** Aborts requests to third-party hosts every page here loads (fonts, PostHog, Meta Pixel) -- see CLAUDE.md's environment-quirk note. */
function blockThirdParty(page) {
  return page.route(/fonts\.(googleapis|gstatic)\.com|connect\.facebook\.net|i\.posthog\.com/, function (route) {
    route.abort();
  });
}

/** Wraps page.goto so a transient network stall on a blocked-in-vain third-party request doesn't crash the whole run -- see CLAUDE.md's environment-quirk note. */
async function safeGoto(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  } catch (e) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  }
}

/** Intercepts get-feed.js with a fixed, caller-supplied feed array -- no real network/Blobs call. */
function mockFeed(page, feed) {
  return page.route('**/.netlify/functions/get-feed', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ feed: feed, dreamOfDayId: null }) });
  });
}

/** A single synthetic published dream, matching get-feed.js's real record shape. */
function makeDream(overrides) {
  return Object.assign({
    id: 'synthetic-1',
    caption: 'A synthetic dream',
    style: 'Cinematic',
    videoUrl: 'https://example.com/fake-feed-video.mp4',
    ownerHandle: '@someoneelse',
    likes: 3,
    likedByMe: false,
    dur: '0:08'
    // deliberately no `avatar` key at all by default -- exercises both
    // "never set one" and "legacy, predates the field" in one shape.
  }, overrides || {});
}

/** Seeds js/store.js's localStorage state with a logged-in "tester" account and (optionally) a self character -- mirrors test/profile-me-character-behavioral.test.js's own seedUser helper. */
async function seedUser(page, selfCharacter) {
  await safeGoto(page, baseUrl + '/login.html');
  await page.evaluate(function (selfCharacter) {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@tester', username: 'tester' };
    if (!state.accounts) state.accounts = {};
    state.accounts.tester = { password: 'testpass1', email: 'tester@example.com' };
    if (!state.charactersByUser) state.charactersByUser = {};
    state.charactersByUser.tester = selfCharacter ? [selfCharacter] : [];
    if (!state.dreams) state.dreams = [];
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, selfCharacter || null);
}

/** The first (and, in every test here, only) rendered card's feed-avatar element's shape: whether it has a real <img>, its src if so, and the fallback classList/text otherwise. */
function readFirstAvatar(page) {
  return page.$eval('.feed-card .feed-avatar', function (el) {
    var img = el.querySelector('img');
    return {
      hasImg: !!img,
      imgSrc: img ? img.getAttribute('src') : null,
      isFallback: el.classList.contains('feed-avatar-fallback'),
      backgroundStyle: el.getAttribute('style') || '',
      text: (el.textContent || '').trim()
    };
  });
}

test('explore.html: a real avatar thumbnail present on the record renders as an <img>, not the fallback', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var AVATAR = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD//2Q==';
    await mockFeed(page, [makeDream({ ownerHandle: '@otheruser', avatar: AVATAR })]);

    await safeGoto(page, baseUrl + '/explore.html');
    await page.waitForSelector('.feed-card', { timeout: 5000 });
    await page.waitForTimeout(150);

    var avatar = await readFirstAvatar(page);
    assert.equal(avatar.hasImg, true, 'expected a real <img> in the avatar circle when the record carries one');
    assert.equal(avatar.imgSrc, AVATAR);
    assert.equal(avatar.isFallback, false);
  } finally {
    await context.close();
  }
});

test('explore.html: a legacy dream (no avatar field at all, predating the feature) gets the colored fallback, never a blank circle', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    // makeDream's default shape already omits `avatar` entirely -- exactly
    // what a real pre-this-feature published record looks like.
    await mockFeed(page, [makeDream({ ownerHandle: '@legacyuser' })]);

    await safeGoto(page, baseUrl + '/explore.html');
    await page.waitForSelector('.feed-card', { timeout: 5000 });
    await page.waitForTimeout(150);

    var avatar = await readFirstAvatar(page);
    assert.equal(avatar.hasImg, false, 'no real photo exists for this legacy record -- must not render an <img> at all');
    assert.equal(avatar.isFallback, true, 'expected the fallback class so this never renders as a bare empty circle');
    assert.ok(avatar.backgroundStyle.indexOf('gradient') !== -1, 'expected a real colored gradient background, got style="' + avatar.backgroundStyle + '"');
    assert.equal(avatar.text, 'L', 'expected the fallback initial derived from "legacyuser"');
  } finally {
    await context.close();
  }
});

test('explore.html: DreamStore.avatarFallback is a pure, deterministic function of username -- same color+initial every call, and identical across separate page loads', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockFeed(page, [makeDream()]);
    await safeGoto(page, baseUrl + '/explore.html');
    await page.waitForSelector('.feed-card', { timeout: 5000 });

    var results = await page.evaluate(function () {
      var out = [];
      for (var i = 0; i < 25; i++) out.push(DreamStore.avatarFallback('@repeatable_user_42'));
      return out;
    });
    var first = results[0];
    assert.ok(first.gradient && first.initial, 'sanity check: avatarFallback must return a real gradient + initial');
    results.forEach(function (r, i) {
      assert.deepEqual(r, first, 'call #' + i + ' returned a different fallback for the exact same username -- must be deterministic within one page');
    });

    // A second, completely independent page/browser context -- same
    // username must still resolve to the exact same fallback across
    // "devices" (nothing in avatarFallback may depend on any per-session
    // or per-load state).
    var context2 = await browser.newContext({ viewport: MOBILE_VIEWPORT });
    try {
      var page2 = await context2.newPage();
      await blockThirdParty(page2);
      await mockFeed(page2, [makeDream()]);
      await safeGoto(page2, baseUrl + '/explore.html');
      await page2.waitForSelector('.feed-card', { timeout: 5000 });
      var second = await page2.evaluate(function () { return DreamStore.avatarFallback('@repeatable_user_42'); });
      assert.deepEqual(second, first, 'a separate page/context must compute the identical fallback for the same username');
    } finally {
      await context2.close();
    }
  } finally {
    await context.close();
  }
});

test('explore.html: two different usernames get visibly different fallback colors (not everything collapsing to one color)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockFeed(page, [makeDream()]);
    await safeGoto(page, baseUrl + '/explore.html');
    await page.waitForSelector('.feed-card', { timeout: 5000 });

    var names = ['@alice', '@bob', '@carol', '@dave', '@erin', '@frank', '@grace', '@heidi'];
    var fallbacks = await page.evaluate(function (names) {
      return names.map(function (n) { return DreamStore.avatarFallback(n); });
    }, names);
    var distinctGradients = {};
    fallbacks.forEach(function (f) { distinctGradients[f.gradient] = true; });
    assert.ok(Object.keys(distinctGradients).length > 1, 'expected varied colors across different usernames, got only: ' + JSON.stringify(Object.keys(distinctGradients)));
  } finally {
    await context.close();
  }
});

test('explore.html: the viewer\'s OWN published dream backfills from the local Me-character photo immediately, even with no avatar field on the record', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var LOCAL_PHOTO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    await seedUser(page, { id: 'cself1', isSelf: true, name: 'Tester', photoDataUrl: LOCAL_PHOTO });

    // ownerHandle matches the seeded account ('@tester') -- js/store.js's
    // getSharedFeed computes `mine: true` for this from state.user.handle,
    // exactly as it would for a real round trip. No `avatar` field at all
    // on the wire record, simulating a dream published before this feature
    // (or before the server-side sync round-tripped) -- the local photo
    // must still win over the fallback.
    await mockFeed(page, [makeDream({ ownerHandle: '@tester' })]);
    await safeGoto(page, baseUrl + '/explore.html');
    await page.waitForSelector('.feed-card', { timeout: 5000 });
    await page.waitForTimeout(150);

    var avatar = await readFirstAvatar(page);
    assert.equal(avatar.hasImg, true, 'the viewer\'s own dream must render a real photo, not the fallback');
    assert.equal(avatar.imgSrc, LOCAL_PHOTO, 'must use the LOCAL Me-character photo, not wait on any server-synced avatar field');
    assert.equal(avatar.isFallback, false);
  } finally {
    await context.close();
  }
});

test('explore.html: a dream that is NOT the viewer\'s own still gets the fallback even when the viewer has their own Me photo set', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var LOCAL_PHOTO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    await seedUser(page, { id: 'cself1', isSelf: true, name: 'Tester', photoDataUrl: LOCAL_PHOTO });

    // A different author's dream, no avatar field -- must not accidentally
    // pick up the CURRENT viewer's own local photo.
    await mockFeed(page, [makeDream({ ownerHandle: '@notme' })]);
    await safeGoto(page, baseUrl + '/explore.html');
    await page.waitForSelector('.feed-card', { timeout: 5000 });
    await page.waitForTimeout(150);

    var avatar = await readFirstAvatar(page);
    assert.equal(avatar.hasImg, false, 'must not render the viewer\'s own local photo on someone else\'s dream');
    assert.equal(avatar.isFallback, true);
  } finally {
    await context.close();
  }
});

test('explore.html: the feed-avatar circle always has SOME rendered content -- an <img> or the fallback initial -- across a mixed feed of own/other/legacy dreams', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedUser(page, null); // logged in, but no Me photo set at all
    await mockFeed(page, [
      makeDream({ id: 's-1', ownerHandle: '@ownerA' }),
      makeDream({ id: 's-2', ownerHandle: '@ownerB', avatar: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD//2Q==' }),
      makeDream({ id: 's-3', ownerHandle: '@tester' }) // "mine", but no local photo set either
    ]);
    await safeGoto(page, baseUrl + '/explore.html');
    await page.waitForSelector('.feed-card, .feed-slot', { timeout: 5000 });
    await page.waitForTimeout(200);

    var avatars = await page.$$eval('.feed-avatar', function (els) {
      return els.map(function (el) {
        var img = el.querySelector('img');
        return { hasImg: !!img, text: (el.textContent || '').trim(), isFallback: el.classList.contains('feed-avatar-fallback') };
      });
    });
    assert.ok(avatars.length >= 1, 'expected at least one hydrated card\'s avatar circle to inspect');
    avatars.forEach(function (a, i) {
      var hasContent = a.hasImg || (a.isFallback && a.text.length > 0);
      assert.ok(hasContent, 'avatar circle #' + i + ' rendered with no photo AND no fallback content -- this is the exact blank-circle bug: ' + JSON.stringify(a));
    });
  } finally {
    await context.close();
  }
});
