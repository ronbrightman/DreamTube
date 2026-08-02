// test/home-hero-whisper-mky-copy-behavioral.test.js
//
// Behavioral coverage for the two disjoint pieces of tracker item
// for-product-build-ship-today-founder-app-zn9zyy's home-related portion
// (the founder-amendment comment, 2026-08-02T08:18):
//
//   1. Tonight hero "empty sky" — moon (the existing .hero-tonight
//      background glow, untouched) + a cycling whisper line ONLY, no
//      streak-sky constellation stars (those already live on the ritual
//      module tile below -- test/home-round4-behavioral.test.js already
//      covers that the ritual module's own constellation renders; this
//      file proves the Tonight hero never duplicates it). Copy + the 8s-
//      fade cycling mechanism are verbatim from home-mock5-x7q4.html's own
//      WHISPERS array / whisper-cycling code -- see home.html's own
//      renderTonightHero()/the module-level whisper setInterval it added.
//   2. The Make-it-yours card's "install" vs "add to your home screen"
//      copy split -- unified everywhere on that card (reward line,
//      done-state, the inline install-row CTA + its supporting text, the
//      no-PwaInstall webview fallback note) plus js/install-nudge.js's
//      own small nudge card's fallback CTA button (the same split existed
//      there too -- its head already said "Add DreamTube to your home
//      screen", but its button underneath said "Install").
//
// Follows this repo's established Playwright/node:test convention (test/
// home-round4-behavioral.test.js's own seedHomeUser/mockTokenStatus/
// mockFeed/blockThirdParty shape) rather than inventing a new one. The
// viewport-sweep helper below (VIEWPORTS) is new to this file -- no
// existing home.html test iterates multiple sizes in one test (they all
// use one fixed MOBILE_VIEWPORT) -- built directly from Playwright's own
// browser.newContext({ viewport }) API, same shape this codebase already
// uses per-test, just looped.

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

/** Aborts requests to third-party hosts every page here loads -- see CLAUDE.md on this sandbox's outbound network. */
function blockThirdParty(page) {
  return page.route(/fonts\.(googleapis|gstatic)\.com|connect\.facebook\.net|i\.posthog\.com/, function (route) {
    route.abort();
  });
}

function mockTokenStatus(page, status) {
  return page.route('**/.netlify/functions/get-token-status*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(status || { balance: 220, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 2 }) });
  });
}

function mockFeed(page, feed) {
  return page.route('**/.netlify/functions/get-feed*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ feed: feed || [], dreamOfDayId: null }) });
  });
}

/** Seeds a logged-in account directly into localStorage and navigates to home.html -- same shape as test/home-round4-behavioral.test.js's own seedHomeUser. */
async function seedHomeUser(page, opts) {
  opts = opts || {};
  var username = opts.username || 'tester';
  await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function (args) {
    var state = {
      user: { handle: '@' + args.username, username: args.username },
      accounts: {},
      draft: {},
      dreams: args.dreams || []
    };
    state.accounts[args.username] = Object.assign({ password: 'testpass1', email: args.username + '@example.com', noRecallDates: args.noRecallDates || [] }, args.accountExtra || {});
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, { username: username, dreams: opts.dreams, noRecallDates: opts.noRecallDates, accountExtra: opts.accountExtra });
  await page.goto(baseUrl + '/home.html', { waitUntil: 'domcontentloaded' });
}

var WHISPERS = [
  'Falling? Flying? A face you knew?',
  'A door that wasn’t there before?',
  'A place you’ve never been — but knew.'
];

// ============================================================================
// 1a. TONIGHT HERO -- moon + whisper only, no streak-sky stars
// ============================================================================

test('home.html: the Tonight hero shows a non-empty whisper line while unlogged, and carries NO streak-sky/constellation markup -- the founder\'s own "already on the ritual tile, duplication" call', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await mockFeed(page, []);
    await seedHomeUser(page, { username: 'whispertester1', dreams: [] });
    await page.waitForSelector('#hero-tonight', { state: 'visible', timeout: 5000 });

    var whisperEl = page.locator('#tonight-whisper');
    assert.equal(await whisperEl.isHidden(), false, 'the whisper must be visible while tonight is unlogged');
    var whisperText = (await whisperEl.textContent()).trim();
    assert.ok(WHISPERS.indexOf(whisperText) !== -1, 'expected one of the mock\'s own approved whisper lines, got: ' + JSON.stringify(whisperText));

    // No streak-sky/constellation DOM anywhere inside the Tonight hero --
    // it was dropped entirely per the founder's amendment, not just hidden.
    var streakSkyCount = await page.locator('#hero-tonight .streak-sky, #hero-tonight #streak-sky, #hero-tonight .sstar, #hero-tonight .sline').count();
    assert.equal(streakSkyCount, 0, 'the Tonight hero must never render a streak-sky constellation -- that already lives on the ritual module tile');
  } finally {
    await context.close();
  }
});

test('home.html: the whisper is hidden once tonight is logged (both the plain logged-hero state and the embedded room-card state where the hero itself is hidden)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await mockFeed(page, []);
    // "No recall" logged tonight -- the plain hero-tonight.logged state, no embedded room card.
    await seedHomeUser(page, { username: 'whispertester2', dreams: [], noRecallDates: [new Date().toDateString()] });
    await page.waitForSelector('#hero-tonight.logged', { timeout: 5000 });
    assert.equal(await page.locator('#tonight-whisper').isHidden(), true, 'the whisper must be hidden once tonight is logged');
  } finally {
    await context.close();
  }
});

test('home.html: the whisper cycles through its 3 approved lines on a slow 8s fade, without ever landing on empty or repeating a line before the other two have shown (page.clock, no real wait)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.clock.install({ time: Date.now() });
    await mockTokenStatus(page);
    await mockFeed(page, []);
    await seedHomeUser(page, { username: 'whispercycletester', dreams: [] });
    await page.waitForSelector('#hero-tonight', { state: 'visible', timeout: 5000 });

    var seen = [(await page.locator('#tonight-whisper').textContent()).trim()];
    for (var i = 0; i < 4; i++) {
      // 8000ms until the fade starts + 1250ms fade/swap timeout, plus a
      // little slack so the swap has genuinely landed before we read it.
      // runFor (not fastForward) -- the swap's own setTimeout is scheduled
      // FROM INSIDE the 8s interval's callback, i.e. during the jump
      // itself; fastForward only fires timers that were already scheduled
      // before the jump started, so a nested one like this needs runFor's
      // sequential tick-through semantics to actually fire in the same call.
      await page.clock.runFor(9400);
      seen.push((await page.locator('#tonight-whisper').textContent()).trim());
    }

    seen.forEach(function (text, idx) {
      assert.ok(WHISPERS.indexOf(text) !== -1, 'tick ' + idx + ' landed on a non-empty, approved whisper line, got: ' + JSON.stringify(text));
    });
    // Exactly the 3 approved lines, seen across 5 samples of a 3-line cycle.
    assert.deepEqual(Array.from(new Set(seen)).sort(), Array.from(new Set(WHISPERS)).sort());
    // Consecutive ticks must actually advance, not repeat the same line twice in a row.
    for (var j = 1; j < seen.length; j++) {
      assert.notEqual(seen[j], seen[j - 1], 'tick ' + j + ' must advance to the next line, not repeat tick ' + (j - 1));
    }
  } finally {
    await context.close();
  }
});

// ============================================================================
// 1b. TONIGHT HERO -- no text-overlap at any viewport (the founder's
// screenshot bug: "whisper/label colliding with the image/moon area").
// Exercised at the WORST-CASE state for vertical crowding -- a brand-new,
// never-logged account (hasEverLogged:false) shows the extra "First night
// -- any entry counts" d1 line AND, at narrow widths, the "What did you
// dream?" title wraps to 2 lines -- both eat into the same top clearance
// the whisper needs. See home.html's own .hero-tonight comment for the
// real numbers this was tuned against.
// ============================================================================

var VIEWPORTS = [
  { width: 320, height: 568, name: 'iPhone SE (1st gen) -- narrowest common width' },
  { width: 375, height: 667, name: 'iPhone SE2/8' },
  { width: 390, height: 844, name: 'iPhone 12/13' },
  { width: 412, height: 915, name: 'Pixel 7' },
  { width: 360, height: 740, name: 'common small Android' },
  { width: 375, height: 600, name: 'squeezed height (short viewport, e.g. split-screen/landscape-adjacent)' },
  { width: 320, height: 480, name: 'very short legacy device' }
];

test('home.html: the whisper never overlaps the Tonight eyebrow/title text, and keeps clear of the moon\'s own glow zone, across several representative mobile widths/heights', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  for (var i = 0; i < VIEWPORTS.length; i++) {
    var vp = VIEWPORTS[i];
    var context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    try {
      var page = await context.newPage();
      await blockThirdParty(page);
      await mockTokenStatus(page);
      await mockFeed(page, []);
      // Brand-new account -- day-1 state, the tallest realistic content
      // stack (whisper + eyebrow + title + pill + entry links + d1line).
      await seedHomeUser(page, { username: 'overlaptester' + i, dreams: [] });
      await page.waitForSelector('#hero-tonight', { state: 'visible', timeout: 5000 });

      var hero = await page.locator('#hero-tonight').boundingBox();
      var whisper = await page.locator('#tonight-whisper').boundingBox();
      var eyebrow = await page.locator('#hero-tonight .eyebrow').boundingBox();
      var title = await page.locator('#tonight-title').boundingBox();
      assert.ok(hero && whisper && eyebrow && title, vp.name + ': expected all four elements to have a real bounding box');

      // No overlap with the real text below it -- the whisper's bottom edge
      // must sit strictly above the eyebrow's top edge.
      assert.ok(whisper.y + whisper.height <= eyebrow.y + 0.5, vp.name + ': whisper (bottom ' + (whisper.y + whisper.height).toFixed(1) + ') must not overlap the eyebrow (top ' + eyebrow.y.toFixed(1) + ')');
      assert.ok(whisper.y + whisper.height <= title.y + 0.5, vp.name + ': whisper must not overlap the title either');

      // Keeps clear of the moon's own glow zone -- the hero's background
      // carries two radial-gradients centered at 15% from the card's top:
      // a bright 56px-diameter disc (the moon itself, ~28px radius) and a
      // softer 150px-diameter halo (~75px radius, fading to transparent).
      // On a 436px-tall card that's roughly y=59 (15%) +/- 75 = a halo
      // reaching to about y=134 from the card's top -- this asserts the
      // whisper's own top edge sits below that with real margin, not just
      // technically past the bright disc.
      var clearance = whisper.y - hero.y;
      assert.ok(clearance >= 140, vp.name + ': expected the whisper to start at least 140px below the hero\'s top edge (clear of the moon\'s glow zone), got ' + clearance.toFixed(1));
    } finally {
      await context.close();
    }
  }
});

// ============================================================================
// 2. MAKE-IT-YOURS CARD -- "install" vs "add to your home screen" unified
// ============================================================================

test('home.html: the Make-it-yours reward line and done-state both say "add to your home screen"/"phone", never bare "install"', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT, permissions: ['clipboard-read', 'clipboard-write'] });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var currentBalance = 220;
    await page.route('**/.netlify/functions/get-token-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ balance: currentBalance, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, streak: 2 }) });
    });
    await mockFeed(page, []);
    await page.route('**/.netlify/functions/claim-install-bonus', function (route) {
      currentBalance = 320;
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ granted: true, balance: 320 }) });
    });
    await page.addInitScript(function () {
      var real = window.matchMedia ? window.matchMedia.bind(window) : null;
      window.matchMedia = function (q) {
        if (String(q).indexOf('display-mode') !== -1) return { matches: true, media: q, addListener: function () {}, removeListener: function () {}, addEventListener: function () {}, removeEventListener: function () {} };
        return real ? real(q) : { matches: false, media: q };
      };
    });
    await seedHomeUser(page, { username: 'mkycopytester', dreams: [] });
    await page.waitForSelector('#mky', { state: 'visible', timeout: 5000 });

    var rewardText = await page.textContent('.mky-reward');
    assert.match(rewardText, /add.*your home screen/i, 'reward line must say "add ... your home screen", got: ' + rewardText);
    assert.doesNotMatch(rewardText, /\binstall\b/i, 'reward line must not say bare "install" anymore, got: ' + rewardText);

    // Claim it -- the done-state copy must ALSO use the unified phrase.
    await page.click('#mky-claim');
    await page.waitForSelector('#mky-done', { state: 'visible', timeout: 5000 });
    var doneText = await page.textContent('.mky-done-line');
    assert.match(doneText, /added to your phone/i, 'done-state must say "Added to your phone", got: ' + doneText);
    assert.match(doneText, /claimed/i);
    assert.doesNotMatch(doneText, /\binstalled\b/i, 'done-state must not say "Installed" anymore, got: ' + doneText);
  } finally {
    await context.close();
  }
});

test('home.html: the Make-it-yours install row\'s inline CTA (native prompt available) says "Add to home screen", not "Install" -- and its supporting copy above it uses the unified phrase too', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT }); // default desktop-ish UA -- not iOS, no Android menu-fallback branch
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await mockFeed(page, []);
    await seedHomeUser(page, { username: 'mkyinlinectatester', dreams: [] });
    await page.waitForSelector('#mky', { state: 'visible', timeout: 5000 });

    await page.click('#mky-install-row');
    await page.waitForSelector('#mky-inline-install-btn', { state: 'visible', timeout: 2000 });
    var btnText = (await page.textContent('#mky-inline-install-btn')).trim();
    assert.match(btnText, /add to home screen/i, 'expected the inline CTA to say "Add to home screen", got: ' + btnText);
    assert.doesNotMatch(btnText, /^install\b/i, 'must not still say "Install", got: ' + btnText);

    var expText = await page.textContent('#mky-install-exp');
    assert.match(expText, /adding it to your home screen verifies/i, 'the supporting copy above the CTA must use the unified phrase too, got: ' + expText);
  } finally {
    await context.close();
  }
});

test('home.html: the Make-it-yours webview-fallback note (no PwaInstall/InstallNudge available) says "add DreamTube to your home screen", not "install DreamTube"', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await mockFeed(page, []);
    // Prevent js/pwa.js and js/install-nudge.js from ever loading, so
    // window.PwaInstall/InstallNudge stay genuinely undefined -- the exact
    // branch this note is scoped to (see home.html's own
    // renderMkyInstallExp). A plain window.PwaInstall=undefined stub via
    // addInitScript does NOT work here -- those scripts reassign it
    // themselves once they load, clobbering the stub.
    await page.route('**/js/pwa.js', function (route) { route.fulfill({ status: 200, contentType: 'application/javascript', body: '' }); });
    await page.route('**/js/install-nudge.js', function (route) { route.fulfill({ status: 200, contentType: 'application/javascript', body: '' }); });
    await seedHomeUser(page, { username: 'mkywebviewfallbacktester', dreams: [] });
    await page.waitForSelector('#mky', { state: 'visible', timeout: 5000 });

    await page.click('#mky-install-row');
    var expText = await page.textContent('#mky-install-exp');
    assert.match(expText, /add dreamtube to your home screen/i, 'expected the unified phrase, got: ' + expText);
    assert.doesNotMatch(expText, /install dreamtube/i, 'must not still say "install DreamTube", got: ' + expText);
  } finally {
    await context.close();
  }
});

/** Same technique test/install-first-door-behavioral.test.js's own mockBeforeInstallPromptCapturedEarly uses -- fires a synthetic beforeinstallprompt BEFORE the page's real js/pwa.js listener attaches, so PwaInstall.canPromptInstall() is genuinely true by the time InstallNudge.render() runs (a one-shot synchronous call, no later re-render), landing on the real-native-prompt "else" branch rather than the iOS/Android-menu-fallback branches. */
function mockBeforeInstallPromptCapturedEarly(page, outcome) {
  return page.addInitScript(function (o) {
    var realAdd = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, listener, opts) {
      if (type === 'beforeinstallprompt' && this === window && typeof listener === 'function') {
        var fakeEvent = new Event('beforeinstallprompt', { cancelable: true });
        fakeEvent.prompt = function () { fakeEvent.__prompted = true; };
        fakeEvent.userChoice = Promise.resolve({ outcome: o });
        try { listener(fakeEvent); } catch (e) { /* ignore */ }
      }
      return realAdd.call(this, type, listener, opts);
    };
  }, outcome || 'accepted');
}

test('js/install-nudge.js: the small nudge card\'s own fallback CTA (a captured native prompt, non-iOS) also says "Add to home screen", matching its own head\'s "Add DreamTube to your home screen" -- same naming split the founder flagged, fixed in the same sweep', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36' });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await mockFeed(page, []);
    await mockBeforeInstallPromptCapturedEarly(page, 'accepted');
    await seedHomeUser(page, { username: 'nudgectatester', dreams: [] });
    // profile.html's repeat-visit trigger -- 2nd real-browser visit fires the small card.
    await page.goto(baseUrl + '/profile.html', { waitUntil: 'domcontentloaded' });
    await page.goto(baseUrl + '/profile.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#install-nudge-card', { state: 'visible', timeout: 5000 });

    var headText = await page.textContent('.install-nudge-head');
    assert.match(headText, /add dreamtube to your home screen/i);

    await page.waitForSelector('#install-nudge-action', { state: 'visible', timeout: 2000 });
    var btnText = (await page.textContent('#install-nudge-action')).trim();
    assert.match(btnText, /add to home screen/i, 'expected the small card\'s own CTA to match its head\'s phrasing, got: ' + btnText);
    assert.doesNotMatch(btnText, /^install\b/i, 'must not still say "Install", got: ' + btnText);
  } finally {
    await context.close();
  }
});
