// test/sound-nudge-behavioral.test.js
//
// Real browser-driven coverage for tracker item
// for-product-p1-founder-repro-08-04-12-40-6icx89. Music beds
// (js/music-bed.js, always on since the 2026-08-03 founder simplification)
// were the first real audio this app ever shipped, but DreamStore.
// getSoundPref (js/store.js) defaults to muted until a user has EXPLICITLY
// tapped an unmute control -- harmless while every video was permanently
// silent, but now it silently mutes the one thing worth hearing for
// virtually the entire installed base, with nothing telling a first-time-
// in-this-era visitor that sound even exists.
//
// The fix: a one-time, device-level nudge (a toast + a bounded pulse on
// the EXISTING mute icon -- no new modal/banner) shown the first time a
// bed-eligible video plays for a visitor who has never explicitly touched
// their sound preference. See:
//   - js/store.js's DreamStore.hasEverSetSoundPref/hasSeenSoundNudge for
//     the two device-level flags that gate it.
//   - result.html's/explore.html's own maybeShowSoundNudge() for the
//     per-page wiring (result.html: called from render() whenever a video
//     dream is shown; explore.html: called from videoObserver's
//     isIntersecting branch, the moment a card actually becomes the
//     playing one).
//
// This file does NOT re-test music-bed eligibility/sync itself -- see
// test/music-bed-behavioral.test.js for that. It covers only the nudge's
// own firing contract:
//   1. Fires exactly once on a fresh device for a bed-eligible video.
//   2. Does NOT fire again on a second visit/video (device-level, not
//      per-page/per-video).
//   3. Does NOT fire at all once the user has explicitly touched sound
//      (either the existing mute button, or a pre-existing sound pref).
//   4. Never fires for a dream with no eligible music bed.

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

function newMobileContext() {
  return browser.newContext({ viewport: MOBILE_VIEWPORT });
}

async function seedLoggedInUserWithDreams(page, username, dreams, extraState) {
  await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function (args) {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@' + args.u, username: args.u };
    if (!state.accounts) state.accounts = {};
    state.accounts[args.u] = { password: 'testpass1', email: args.u + '@example.com' };
    if (!state.dreams) state.dreams = [];
    args.dreams.forEach(function (d) { state.dreams.push(d); });
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    if (args.extraState) {
      Object.keys(args.extraState).forEach(function (k) {
        localStorage.setItem(k, args.extraState[k]);
      });
    }
  }, { u: username, dreams: dreams, extraState: extraState || null });
}

/** Reads the toast element's current text + visibility, and the mute button's pulse-class state, in one round trip. */
async function readNudgeState(page, muteBtnSelector) {
  return page.evaluate(function (sel) {
    var t = document.getElementById('toast');
    var btn = document.querySelector(sel);
    return {
      toastShown: t.classList.contains('show'),
      toastText: t.textContent,
      pulsing: btn ? btn.classList.contains('sound-nudge-pulse') : null
    };
  }, muteBtnSelector);
}

var BED_ELIGIBLE_DREAM = {
  id: 'dream-nudge-eligible', ownerHandle: '@nudgetester', caption: 'A dream about the sea',
  style: 'Cartoon', mediaType: 'video', videoUrl: '/assets/music-beds/anime.wav',
  dur: '0:08', isPublished: false, likes: 0, likedByMe: false
};

// The only bed-INELIGIBLE case left after the 2026-08-08 tier-3 default bed
// (js/music-bed.js): a non-video dream. Every VIDEO dream now resolves a bed
// (mood -> style -> neutral default), so an unrecognized style no longer
// yields silence — the way to have "no eligible bed" is to have no video to
// loop a bed against at all. An image-only dream shows no mute button on
// result.html, so the sound nudge has nothing to point at and never fires.
var NO_BED_DREAM = {
  id: 'dream-nudge-no-bed', ownerHandle: '@nudgetester', caption: 'An image, no video',
  style: 'Surrealist', mediaType: 'image', imageUrl: '/assets/logo-v4.png', videoUrl: null,
  dur: null, isPublished: false, likes: 0, likedByMe: false
};

test('result.html: the sound nudge fires exactly once on a fresh device for a bed-eligible video', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedLoggedInUserWithDreams(page, 'nudgetester1', [BED_ELIGIBLE_DREAM]);
    await page.goto(baseUrl + '/result.html?id=' + BED_ELIGIBLE_DREAM.id, { waitUntil: 'domcontentloaded' });

    await page.waitForFunction(function () {
      var t = document.getElementById('toast');
      return t && t.classList.contains('show');
    }, { timeout: 5000 });

    var state = await readNudgeState(page, '#mute-btn');
    assert.equal(state.toastShown, true);
    assert.match(state.toastText, /sound/i, 'toast copy should mention sound/tapping for it');
    assert.equal(state.pulsing, true, 'the mute icon should be pulsing alongside the toast');

    var flags = await page.evaluate(function () {
      return { seen: DreamStore.hasSeenSoundNudge(), everSet: DreamStore.hasEverSetSoundPref() };
    });
    assert.equal(flags.seen, true, 'the device-level "nudge already shown" flag must be set immediately, not deferred to a tap');
    assert.equal(flags.everSet, false, 'showing the nudge itself must NOT count as the user having set a sound preference');
  } finally {
    await context.close();
  }
});

test('result.html: the nudge does NOT fire again on a second visit/video once already seen on this device', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var secondDream = Object.assign({}, BED_ELIGIBLE_DREAM, { id: 'dream-nudge-second', style: 'Anime' });
    await seedLoggedInUserWithDreams(page, 'nudgetester2', [BED_ELIGIBLE_DREAM, secondDream], {
      dreamtube_sound_nudge_seen: '1' // simulates "already shown once on this device" (e.g. from an earlier dream)
    });

    await page.goto(baseUrl + '/result.html?id=' + secondDream.id, { waitUntil: 'domcontentloaded' });
    // Give the page's own render()/maybeShowSoundNudge a real tick to run
    // before asserting a negative.
    await page.waitForTimeout(500);

    var state = await readNudgeState(page, '#mute-btn');
    assert.equal(state.toastShown, false, 'a device that has already seen the nudge must not see it again for a different eligible video');
    assert.equal(state.pulsing, false);
  } finally {
    await context.close();
  }
});

test('result.html: the nudge does NOT fire once the user has explicitly touched sound (real mute-button tap)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var firstDream = Object.assign({}, BED_ELIGIBLE_DREAM, { id: 'dream-nudge-first-touch' });
    var secondDream = Object.assign({}, BED_ELIGIBLE_DREAM, { id: 'dream-nudge-after-touch', style: 'Realistic' });
    await seedLoggedInUserWithDreams(page, 'nudgetester3', [firstDream, secondDream]);

    // First visit: nudge fires (fresh device), then the visitor taps the
    // real mute button themselves -- the same action the nudge is meant to
    // draw attention to.
    await page.goto(baseUrl + '/result.html?id=' + firstDream.id, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(function () {
      var t = document.getElementById('toast');
      return t && t.classList.contains('show');
    }, { timeout: 5000 });
    await page.click('#mute-btn');

    var afterTouch = await page.evaluate(function () {
      return { everSet: DreamStore.hasEverSetSoundPref(), soundOn: DreamStore.getSoundPref() };
    });
    assert.equal(afterTouch.everSet, true, 'a real mute-button tap must mark the sound pref as explicitly set');
    assert.equal(afterTouch.soundOn, true, 'tapping mute-btn from its default muted state should turn sound on');

    // A brand-new device flag isn't even needed here -- hasEverSetSoundPref
    // alone should be enough to suppress any future nudge. Reset the
    // "seen" flag to prove THIS is the mechanism doing the suppressing,
    // not leftover state from the first visit.
    await page.evaluate(function () { localStorage.removeItem('dreamtube_sound_nudge_seen'); });

    await page.goto(baseUrl + '/result.html?id=' + secondDream.id, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);
    var state = await readNudgeState(page, '#mute-btn');
    assert.equal(state.toastShown, false, 'once sound has been explicitly touched, the nudge must never fire again even with the "seen" flag cleared');
  } finally {
    await context.close();
  }
});

test('result.html: the nudge does NOT fire when a pre-existing sound preference was already set (never touched the mute button, but the pref exists)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedLoggedInUserWithDreams(page, 'nudgetester4', [BED_ELIGIBLE_DREAM], {
      dreamtube_sound_on: '0' // explicitly muted, not merely defaulted -- localStorage key exists
    });
    await page.goto(baseUrl + '/result.html?id=' + BED_ELIGIBLE_DREAM.id, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);

    var state = await readNudgeState(page, '#mute-btn');
    assert.equal(state.toastShown, false, 'an explicitly-set sound pref (even if still muted) must suppress the nudge -- getSoundPref()===false alone is not enough to decide "never touched"');
  } finally {
    await context.close();
  }
});

test('result.html: the nudge never fires for a dream with no eligible music bed (an image-only dream — the only bed-ineligible case after the tier-3 default bed)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedLoggedInUserWithDreams(page, 'nudgetester5', [NO_BED_DREAM]);
    await page.goto(baseUrl + '/result.html?id=' + NO_BED_DREAM.id, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);

    var state = await readNudgeState(page, '#mute-btn');
    assert.equal(state.toastShown, false, 'an image-only dream has no video to loop a bed against, so the nudge must never fire');
    var flags = await page.evaluate(function () { return { seen: DreamStore.hasSeenSoundNudge() }; });
    assert.equal(flags.seen, false, 'the "seen" flag must stay false so a LATER bed-eligible dream can still nudge');
  } finally {
    await context.close();
  }
});

test('explore.html: the sound nudge fires once for a bed-eligible feed card that actually becomes the playing one, and is device-level (does not re-fire after result.html already showed it)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.route('**/.netlify/functions/get-feed*', function (route) {
      route.fulfill({
        status: 200, contentType: 'application/json', body: JSON.stringify({
          feed: [
            { id: 'feed-nudge-eligible', ownerHandle: '@someone', caption: 'A dream', style: 'Cartoon', videoUrl: '/assets/music-beds/anime.wav', mediaType: 'video', likes: 3, dur: '0:08' }
          ],
          dreamOfDayId: null
        })
      });
    });

    await page.goto(baseUrl + '/explore.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.feed-card', { timeout: 8000 });

    await page.waitForFunction(function () {
      var t = document.getElementById('toast');
      return t && t.classList.contains('show');
    }, { timeout: 8000 });

    var state = await readNudgeState(page, '.feed-mute-btn');
    assert.equal(state.toastShown, true);
    assert.match(state.toastText, /sound/i);
    assert.equal(state.pulsing, true);

    var flags = await page.evaluate(function () { return DreamStore.hasSeenSoundNudge(); });
    assert.equal(flags, true);

    // Device-level, not page-level: reloading (still no explicit sound
    // touch) must not fire it a second time.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.feed-card', { timeout: 8000 });
    await page.waitForTimeout(1000);
    var state2 = await readNudgeState(page, '.feed-mute-btn');
    assert.equal(state2.toastShown, false, 'the nudge must not re-fire on a later visit once this device has already seen it');
  } finally {
    await context.close();
  }
});

test('cross-page: a device that already saw the nudge on result.html must not see it again on explore.html', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedLoggedInUserWithDreams(page, 'nudgetester6', [BED_ELIGIBLE_DREAM]);
    await page.goto(baseUrl + '/result.html?id=' + BED_ELIGIBLE_DREAM.id, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(function () {
      var t = document.getElementById('toast');
      return t && t.classList.contains('show');
    }, { timeout: 5000 });

    await page.route('**/.netlify/functions/get-feed*', function (route) {
      route.fulfill({
        status: 200, contentType: 'application/json', body: JSON.stringify({
          feed: [
            { id: 'feed-cross-page', ownerHandle: '@someone', caption: 'A dream', style: 'Anime', videoUrl: '/assets/music-beds/anime.wav', mediaType: 'video', likes: 1, dur: '0:08' }
          ],
          dreamOfDayId: null
        })
      });
    });
    await page.goto(baseUrl + '/explore.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.feed-card', { timeout: 8000 });
    await page.waitForTimeout(1500);

    var state = await readNudgeState(page, '.feed-mute-btn');
    assert.equal(state.toastShown, false, 'the nudge is device-level (localStorage-backed), so it must not fire again on a different page in the same session');
  } finally {
    await context.close();
  }
});
