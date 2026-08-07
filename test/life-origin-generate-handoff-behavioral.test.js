// test/life-origin-generate-handoff-behavioral.test.js
//
// Behavioral coverage for tracker item
// for-product-life-origin-generate-handoff-founder-repro-8yc4wm — founder
// repro on dreamtube.life (a newer custom-domain alias for the same
// Netlify site; the browser's localStorage there is a SEPARATE origin from
// wherever the app had been used before, so this was genuinely the FIRST
// time this exact origin ever held a signed-in user for this account):
//
//   BUG 1 (money): create flow -> style screen -> "Generate Video" (tokens
//   visibly charged server-side, 1400 -> 1300) -> instead of landing on a
//   forming/processing state, Home showed the plain, default UNLOGGED
//   "What did you dream?" hero -- no forming room-card, no trace of the
//   generation anywhere.
//
//   Root cause (confirmed by reading style.html/home.html/js/store.js
//   before writing anything): style.html's Generate button does not itself
//   submit the generation -- it persists the draft and redirects to
//   `home.html?generate=1`, which is what actually calls
//   DreamStore.generateVideo()/generateImage() (see home.html's own
//   handleFreshInAppGeneration). shouldShowRoomCard()/renderDay0Card() (the
//   forming room-card renderer) and renderTonightHero() (which hides
//   itself the moment the room card should own the screen) both keyed
//   PURELY off the REAL pendingJob having already landed in DreamStore --
//   which requires that fresh submission's own network round trip (the
//   POST to generate-video.js/generate-image.js) to resolve. home.html's
//   own pollForPendingJobToAppear() only waited a few seconds for that
//   before giving up, with nothing else making shouldShowRoomCard() true
//   in the meantime for a genuinely BRAND-NEW (non-edit) generation --
//   unlike an edit/regenerate of an existing dream, which already had an
//   optimistic path (optimisticEditDreamId, tracker item for-product-bug-
//   founder-repro-edited-dre-jcasn1) precisely because shouldShowRoomCard()
//   was already true via that dream's own today-entry. A brand-new
//   generation had nothing else to lean on: for however long the real
//   round trip took, Home showed its plain default unlogged shape even
//   though the server had already billed real tokens. Worst on a day-0 (or,
//   as here, first-ever-on-this-browser-origin) account, where there is
//   also no existing My-dreams row or any other content to hint that
//   anything is happening at all -- a totally blank-looking Home.
//
//   Fix: home.html now primes an optimisticFreshGenerationPending flag
//   (mirroring optimisticEditDreamId's own shape) the instant `?generate=1`
//   is seen with no pendingJob yet -- synchronously, before this page's own
//   first paint -- so shouldShowRoomCard() (and therefore the room card /
//   Tonight-hero handoff) is correct from the very first frame, regardless
//   of how long the real network round trip takes. Applies uniformly
//   whether this is truly this account's first-ever generation or just the
//   first one on this particular browser origin -- the fix does not
//   distinguish the two, closing exactly the "first-time-on-this-origin"
//   gap the founder hit.
//
//   BUG 2 (entry routing): after logging OUT on dreamtube.life, revisiting
//   the site landed straight on wizard.html's first question ("Who's the
//   dream about?") with no welcome/choice screen (index.html) shown first
//   -- against docs/JOURNEY_MANIFEST.md's own Journey 2, where index.html
//   always comes before wizard.html.
//
//   Root cause: wizard.html has no concept of "resume" at all (its `cur`
//   step index always starts at 0, and it unconditionally clears any
//   leftover draft on load) -- it was never vulnerable to resuming
//   MID-funnel. The actual gap is that it also had no guard recognizing
//   "this exact browser has already had a real account before" --
//   DreamStore logout() deliberately leaves state.accounts (the local
//   account cache) intact, by design (so the same browser can log back
//   into the same account later) -- so a browser/origin that has already
//   held one real, signed-up account still looks, to wizard.html, exactly
//   like a completely new visitor the moment nobody is currently signed
//   in. Landing that returning-but-logged-out visitor in a wizard built to
//   sign up a stranger (no link back to logging into their real account
//   anywhere on it) is a real, lossy entry-routing bug.
//
//   Fix: wizard.html now checks the new DreamStore.hasLocalAccountHistory()
//   (true iff this browser's localStorage has ever held any account, even
//   if nobody is signed in now) right after its existing "already signed
//   in" guard, and redirects to index.html when true -- whose "Already
//   have an account? Log in" link is the correct next step. A genuinely
//   first-time visitor (hasLocalAccountHistory() false) is unaffected --
//   still reaches wizard.html identically, exactly as
//   test/route-organic-to-wizard-behavioral.test.js already covers.
//
// Zero real fal.ai cost -- every generate-video/video-status call is
// mocked via page.route(), per AGENT_POLICY.md's "keep generation-testing
// cost low" guidance. Follows this repo's established Playwright/node:test
// convention (test/home-day0-dream-card-behavioral.test.js's own
// seedDay0Pending shape, test/edit-regeneration-forming-state-behavioral.
// test.js's own optimistic-window coverage) rather than inventing a new
// one.

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

function newMobileContext() {
  return browser.newContext({ viewport: MOBILE_VIEWPORT });
}

/** Aborts requests to third-party hosts every page here loads -- see CLAUDE.md on this sandbox's outbound network. */
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

function mockTokenStatus(page, status) {
  return page.route('**/.netlify/functions/get-token-status*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(status) });
  });
}

function mockGetFeed(page) {
  return page.route('**/.netlify/functions/get-feed', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ feed: [], dreamOfDayId: null }) });
  });
}

// ============================================================================
// BUG 1 -- money-charged-but-orphaned-generation handoff
// ============================================================================

/**
 * Seeds a logged-in account that has NEVER logged anything on this browser
 * origin before -- empty dreams, empty accounts-history-beyond-itself, no
 * pendingJob, no noRecallDates -- i.e. `localStorage.clear()` then a fresh
 * login, exactly the dreamtube.life "first time this exact origin has ever
 * had a signed-in user" scenario the founder hit. `draft` is populated
 * exactly as style.html's own currentDraftPatch()/proceedToGenerate()
 * leaves it right before redirecting to `home.html?generate=1` -- caption
 * already set (from create.html), plus style/mediaType/audioOn from
 * style.html's own Generate tap.
 */
async function seedFirstEverOriginDraft(page, opts) {
  opts = opts || {};
  var username = opts.username || 'lifeoriginuser';
  await safeGoto(page, baseUrl + '/login.html');
  await page.evaluate(function (o) {
    // The literal repro step: a completely clean origin, then seed only
    // what a real login would have written.
    localStorage.clear();
    var handle = '@' + o.username;
    var state = {
      user: { handle: handle, username: o.username },
      accounts: {},
      dreams: [],
      pendingJob: null,
      draft: {
        caption: o.caption, storyText: o.caption, style: o.style,
        mediaType: 'video', sourceImageUrl: null,
        audioOn: true, musicStyle: 'dreamy',
        sourceDreamId: null, isEditDelta: false,
        characterIds: [], cameraView: null, sceneryTime: null, sceneryPlace: null
      }
    };
    state.accounts[o.username] = { password: 'testpass1', email: o.username + '@example.com' };
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, { username: username, caption: opts.caption || 'I was flying over a golden city at night', style: opts.style || 'Realistic' });
}

test('BUG 1 regression: home.html?generate=1 on a first-ever-on-this-origin account shows the forming room card IMMEDIATELY, well before the real generate-video.js round trip resolves -- never the plain unlogged "What did you dream?" hero with no trace of the generation', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockGetFeed(page);
    await mockTokenStatus(page, { balance: 1300, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 100, streak: 0 });

    // Simulates a real-world slow submission round trip (cold Netlify
    // Function, a slow fal.ai handoff) -- deliberately well past the OLD
    // pollForPendingJobToAppear window (10 tries x 400ms = 4s) that this
    // fix's own comment identifies as the actual race. The token debit
    // itself is real and immediate server-side in production (this mock
    // just represents the RESPONSE arriving late, exactly like the
    // founder's repro: tokens already gone, response/UI still pending).
    var generateVideoCalls = 0;
    await page.route('**/.netlify/functions/generate-video', async function (route) {
      generateVideoCalls++;
      await new Promise(function (r) { setTimeout(r, 1500); });
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'fal:fake-model:req-life-origin-1' }) });
    });
    await page.route('**/.netlify/functions/video-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: false }) });
    });

    await seedFirstEverOriginDraft(page, { username: 'lifeoriginuser1' });
    await safeGoto(page, baseUrl + '/home.html?generate=1');

    // Assert almost immediately -- well before the mocked 1.5s delay above
    // resolves -- that the room card is ALREADY showing forming and the
    // plain unlogged Tonight hero is ALREADY hidden. This is the crux of
    // the regression: pre-fix, neither of these would be true yet at this
    // point (shouldShowRoomCard() only went true once the real pendingJob
    // landed, seconds later).
    await page.waitForSelector('#day0-card', { state: 'visible', timeout: 800 });
    assert.equal(await page.locator('#hero-tonight').isVisible(), false, 'the plain unlogged Tonight hero must be replaced by the forming room card immediately, not still showing "What did you dream?"');

    var frameClass = await page.locator('#d0-video').getAttribute('class');
    assert.doesNotMatch(frameClass, /\bready\b/, 'the room card must be in its forming shape, not showing a finished/ready video');

    var quote = await page.locator('#d0-quote').textContent();
    assert.match(quote, /flying over a golden city/i, 'the room card must show the actual submitted dream text immediately, from the draft, not a blank/placeholder quote');

    // Body text sanity check -- the reported symptom verbatim: no trace of
    // the generation, default unlogged copy visible instead.
    var bodyText = await page.locator('#app').innerText();
    assert.doesNotMatch(bodyText, /what did you dream\?/i, 'the default unlogged hero copy must not be visible while a fresh generation is genuinely in flight');

    // Now let the real (mocked) round trip actually land, and confirm the
    // optimistic state hands off cleanly to the REAL pendingJob -- no
    // flicker back to unlogged, no double submission.
    await page.waitForFunction(function () {
      return !!(window.DreamStore && window.DreamStore.getPendingJob());
    }, null, { timeout: 5000 });
    assert.equal(generateVideoCalls, 1, 'must submit exactly once -- the optimistic room card must never trigger (or mask) a duplicate real submission');
    assert.equal(await page.locator('#day0-card').isVisible(), true, 'the room card must still be showing forming once the real pendingJob has landed too');
    assert.equal(await page.locator('#hero-tonight').isVisible(), false);
  } finally {
    await context.close();
  }
});

test('BUG 1 regression: the same first-ever-on-this-origin account, generation genuinely completes -- the room card transitions from the optimistic forming state to the real ready state with no stuck/blank frame in between', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockGetFeed(page);
    await mockTokenStatus(page, { balance: 1300, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 100, streak: 0 });

    await page.route('**/.netlify/functions/generate-video', async function (route) {
      await new Promise(function (r) { setTimeout(r, 600); });
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'fal:fake-model:req-life-origin-2' }) });
    });
    await page.route('**/.netlify/functions/video-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, videoUrl: 'https://example.com/life-origin-ready.mp4' }) });
    });
    await page.route('**/.netlify/functions/mark-generation-completed', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await seedFirstEverOriginDraft(page, { username: 'lifeoriginuser2' });
    await safeGoto(page, baseUrl + '/home.html?generate=1');

    // Optimistic forming state visible immediately.
    await page.waitForSelector('#day0-card', { state: 'visible', timeout: 800 });
    var frameClassBefore = await page.locator('#d0-video').getAttribute('class');
    assert.doesNotMatch(frameClassBefore, /\bready\b/);

    // Genuinely completes -- the SAME card comes alive in place, same
    // contract as home-day0-dream-card-behavioral.test.js's own completion
    // coverage, just starting from the optimistic (not real) forming state.
    await page.waitForFunction(function () {
      var el = document.getElementById('d0-video');
      return el && el.classList.contains('ready');
    }, null, { timeout: 8000 });
    assert.equal(await page.locator('#day0-card').isVisible(), true);
    assert.equal(await page.locator('#hero-tonight').isVisible(), false);
  } finally {
    await context.close();
  }
});

test('BUG 1 regression, control: a returning account with existing dreams gets the same immediate optimistic room card on a fresh ?generate=1 submission, and its existing My-dreams row is unaffected (no duplicate generating tile)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockGetFeed(page);
    await mockTokenStatus(page, { balance: 900, claimable: false, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 100, streak: 2 });

    await page.route('**/.netlify/functions/generate-video', async function (route) {
      await new Promise(function (r) { setTimeout(r, 1500); });
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'fal:fake-model:req-returning-1' }) });
    });
    await page.route('**/.netlify/functions/video-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: false }) });
    });

    var username = 'returningorigin1';
    await safeGoto(page, baseUrl + '/login.html');
    await page.evaluate(function (u) {
      var handle = '@' + u;
      var yesterday = Date.now() - 26 * 60 * 60 * 1000;
      var state = {
        user: { handle: handle, username: u },
        accounts: {},
        dreams: [{
          id: 'old-dream-1', ownerHandle: handle,
          caption: 'A dream from yesterday', storyText: 'A dream from yesterday',
          style: 'Cartoon', mediaType: 'video', videoUrl: 'https://example.com/old.mp4',
          isPublished: false, likes: 0, likedByMe: false, createdAt: yesterday
        }],
        pendingJob: null,
        draft: {
          caption: 'A brand new second dream tonight', storyText: 'A brand new second dream tonight',
          style: 'Anime', mediaType: 'video', sourceImageUrl: null,
          audioOn: false, musicStyle: null, sourceDreamId: null, isEditDelta: false,
          characterIds: [], cameraView: null, sceneryTime: null, sceneryPlace: null
        }
      };
      state.accounts[u] = { password: 'testpass1', email: u + '@example.com' };
      localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    }, username);
    await safeGoto(page, baseUrl + '/home.html?generate=1');

    await page.waitForSelector('#day0-card', { state: 'visible', timeout: 800 });
    assert.equal(await page.locator('#hero-tonight').isVisible(), false);
    var quote = await page.locator('#d0-quote').textContent();
    assert.match(quote, /brand new second dream/i, 'the room card must show the NEW draft text, not the old dream');

    // No duplicate "forming" tile in the My-dreams row while the room card
    // already owns this exact in-flight submission.
    var generatingTiles = await page.locator('#dreams-row .dream-row-tile.generating').count();
    assert.equal(generatingTiles, 0, 'the room card already shows forming -- the row below must not ALSO show a generating tile for the same submission');
  } finally {
    await context.close();
  }
});

// ============================================================================
// BUG 2 -- logged-out revisit skipping the welcome/choice screen
// ============================================================================

test('BUG 2 regression: wizard.html, visited directly while logged out on a browser that has ALREADY held a real account before (stale local account history surviving logout), redirects to index.html instead of rendering the pre-signup wizard', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await safeGoto(page, baseUrl + '/login.html');
    await page.evaluate(function () {
      // Exactly what DreamStore.logout() leaves behind: state.user is
      // null (nobody currently signed in), but state.accounts (and this
      // account's own dreams) survive intact -- logout() deliberately
      // never clears them (see js/store.js's own one-line logout body).
      var state = {
        user: null,
        accounts: { staleoriginuser: { password: 'testpass1', email: 'staleoriginuser@example.com' } },
        dreams: [{
          id: 'stale-dream-1', ownerHandle: '@staleoriginuser',
          caption: 'A dream made earlier this session', storyText: 'A dream made earlier this session',
          style: 'Realistic', mediaType: 'video', videoUrl: 'https://example.com/stale.mp4',
          isPublished: false, likes: 0, likedByMe: false, createdAt: Date.now()
        }],
        pendingJob: null,
        draft: { caption: '', storyText: '', style: null, sourceDreamId: null, characterIds: [] }
      };
      localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    });

    await safeGoto(page, baseUrl + '/wizard.html');
    await page.waitForURL(/\/index\.html$/, { timeout: 5000 });

    var bodyText = await page.locator('.welcome-body').innerText();
    assert.match(bodyText, /already have an account\?/i, 'must land on the welcome/choice screen, whose "Log in" link is the correct next step for a returning-but-logged-out visitor');

    var wizardBodyText = bodyText.toLowerCase();
    assert.doesNotMatch(wizardBodyText, /who.s the dream about/i, 'must never show wizard.html\'s first question to a returning-but-logged-out visitor');
  } finally {
    await page.close();
  }
});

test('BUG 3 regression (tracker item for-product-urgent-founder-repro-index-g-c6boa9): a returning-but-logged-out visitor who explicitly clicks "Get Started" on index.html proceeds into wizard.html -- must NOT bounce straight back to index.html a second time', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await safeGoto(page, baseUrl + '/login.html');
    await page.evaluate(function () {
      // Same stale-but-logged-out state as the BUG 2 regression above --
      // this visitor already saw index.html's own "Log in" link and chose
      // Get Started anyway, an informed choice the guard has no business
      // overriding a second time.
      var state = {
        user: null,
        accounts: { staleoriginuser2: { password: 'testpass1', email: 'staleoriginuser2@example.com' } },
        dreams: [],
        pendingJob: null,
        draft: { caption: '', storyText: '', style: null, sourceDreamId: null, characterIds: [] }
      };
      localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    });

    await safeGoto(page, baseUrl + '/index.html');
    // Promise.all, not sequential awaits (test/route-organic-to-wizard-
    // behavioral.test.js's own established pattern for this exact click):
    // arms the URL wait BEFORE the click fires, so a fast client-side
    // redirect can't complete and settle before this test starts
    // listening for it.
    await Promise.all([
      page.waitForURL(/\/wizard\.html/, { timeout: 5000 }),
      page.click('a.btn-primary')
    ]);
    // waitForFunction (polls/retries), not a one-shot page.evaluate read --
    // the URL settling on wizard.html and wizard.html's own JS having
    // actually rendered its first screen are two different moments; a
    // bare evaluate() has no auto-wait and can read the DOM in the gap
    // between them (real full-suite-load flake observed here once).
    await page.waitForFunction(function () {
      return /What did you dream\?/.test(document.body.innerText);
    }, { timeout: 5000 });

    // The ?entry=index marker must not linger in the address bar once read.
    var url = new URL(page.url());
    assert.equal(url.searchParams.get('entry'), null, 'the entry=index marker must be stripped from the URL after being consumed');
  } finally {
    await page.close();
  }
});

test('BUG 3 regression, control: a DIRECT/bookmarked hit to wizard.html (no ?entry=index marker) with the same stale account history still bounces to index.html -- the marker-based fix must not reopen BUG 2', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await safeGoto(page, baseUrl + '/login.html');
    await page.evaluate(function () {
      var state = {
        user: null,
        accounts: { staleoriginuser3: { password: 'testpass1', email: 'staleoriginuser3@example.com' } },
        dreams: [],
        pendingJob: null,
        draft: { caption: '', storyText: '', style: null, sourceDreamId: null, characterIds: [] }
      };
      localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    });

    await safeGoto(page, baseUrl + '/wizard.html');
    await page.waitForURL(/\/index\.html$/, { timeout: 5000 });

    var bodyText = await page.locator('.welcome-body').innerText();
    assert.match(bodyText, /already have an account\?/i, 'a direct hit with no entry marker must still bounce to the welcome/choice screen');
  } finally {
    await page.close();
  }
});

test('BUG 2 regression, control: wizard.html, visited directly while logged out on a GENUINELY brand-new browser (no local account history at all), still renders the pre-signup wizard normally -- this fix must not affect real first-time visitors', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    // No seeded localStorage at all -- exactly what a brand-new visitor's
    // browser looks like (same setup as test/route-organic-to-wizard-
    // behavioral.test.js's own "completely fresh entry point" test, this
    // one specifically re-asserted here alongside the regression above so
    // the two are read as a matched pair, not coverage living in isolation).
    await safeGoto(page, baseUrl + '/wizard.html');

    assert.match(page.url(), /\/wizard\.html$/, 'a genuinely first-time visitor must still land on wizard.html, not be redirected away');
    var bodyText = await page.evaluate(function () { return document.body.innerText; });
    assert.match(bodyText, /What did you dream\?/, 'a genuinely first-time visitor must still see the wizard\'s first screen (the round-8 entry chooser)');
  } finally {
    await page.close();
  }
});

test('BUG 2 regression: DreamStore.hasLocalAccountHistory() reflects account existence, not current login state -- false on a clean origin, true once any account has ever been created, and STILL true after logging out', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await safeGoto(page, baseUrl + '/login.html');
    await page.evaluate(function () { localStorage.clear(); });
    await safeGoto(page, baseUrl + '/login.html');

    var beforeAny = await page.evaluate(function () { return window.DreamStore.hasLocalAccountHistory(); });
    assert.equal(beforeAny, false, 'a completely clean origin must report no local account history');

    await page.evaluate(function () {
      var state = JSON.parse(localStorage.getItem('dreamtube_state_v1'));
      state.user = { handle: '@historytester', username: 'historytester' };
      state.accounts.historytester = { password: 'testpass1', email: 'historytester@example.com' };
      localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    });
    await safeGoto(page, baseUrl + '/login.html');
    var afterSignup = await page.evaluate(function () { return window.DreamStore.hasLocalAccountHistory(); });
    assert.equal(afterSignup, true, 'must report account history once a real account exists locally');

    await page.evaluate(function () { window.DreamStore.logout(); });
    var afterLogout = await page.evaluate(function () { return window.DreamStore.hasLocalAccountHistory(); });
    assert.equal(afterLogout, true, 'logging out must NOT erase local account history -- logout() deliberately leaves state.accounts intact');
    var currentUser = await page.evaluate(function () { return window.DreamStore.getCurrentUser(); });
    assert.equal(currentUser, null, 'sanity check -- logout() must still actually clear the current session');
  } finally {
    await page.close();
  }
});
