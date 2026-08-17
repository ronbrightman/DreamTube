// test/paywall-moment-behavioral.test.js
//
// Real browser-driven coverage for the post-signup monetization moment wired
// into wizard.html (showMonetizationMoment): the overlay renders for a fresh
// signup on the organic wizard wall, the founder ?paywall=/?trialarm=
// overrides force each arm/variant, the CTA POSTs the correct passVariant to
// create-checkout-session-dodo, trial50 is gated off for real users, and
// DISMISS goes straight to home.html.
//
// Same conventions as test/wizard-ui-behavioral.test.js: a plain static file
// server, page.route() intercepts for the endpoints each test needs,
// signupPasswordless left UNMOCKED (register-account-passwordless 404s -> the
// store degrades to a local-only signup with created:true, which is exactly a
// fresh signup — the moment's trigger).

var test = require('node:test');
var assert = require('node:assert/strict');
var staticServer = require('./helpers/static-server');
var settleMod = require('./helpers/settle');
var settle = settleMod.settle;

var CHROMIUM_PATH = '/opt/pw-browsers/chromium';

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
  try { await page.goto(url, { waitUntil: 'domcontentloaded' }); }
  catch (e) { await page.goto(url, { waitUntil: 'domcontentloaded' }); }
}

/** Stubs the generation/claim/email endpoints a wall signup touches, and captures every create-checkout-session-dodo POST body. Returns the captured-calls array. */
async function stubBackend(page) {
  await page.route('**/.netlify/functions/check-email', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, available: true, deliverable: true }) });
  });
  await page.route('**/.netlify/functions/start-pending-generation', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pendingId: 'pd-mm-1', operationName: 'fal:fake-model:req-mm-1' }) });
  });
  await page.route('**/.netlify/functions/claim-pending-generation', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, found: true }) });
  });
  await page.route('**/.netlify/functions/video-status**', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: false }) });
  });
  var checkoutCalls = [];
  await page.route('**/.netlify/functions/create-checkout-session-dodo', function (route) {
    checkoutCalls.push(JSON.parse(route.request().postData() || '{}'));
    // Return to home.html so the CTA's location.href stays on the test server.
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ url: baseUrl + '/home.html', eventId: 'evt-mm-test' }) });
  });
  return checkoutCalls;
}

/** Drives a fresh signup to the wizard.html signup wall and submits an email.
 * The wall is reached as a growth-funnel arrival now (unify-all-creation-flows,
 * founder 2026-08-14, retired wizard.html's own chip-build flow — a bare hit
 * redirects to /go/); a ?resume=1&caption=... handoff lands DIRECTLY on the
 * wall. The post-signup monetization moment still shows for a fresh signup here
 * regardless of how the wall was reached. Does NOT wait for the moment overlay
 * — used both by signupToMoment (which then waits) and by the robustness test
 * (where the module is blocked so no overlay ever appears). `search` carries
 * founder overrides (?paywall=/?trialarm=). */
async function driveToWallAndSubmit(page, search, email) {
  var extra = search || '';
  var glue = extra.indexOf('?') !== -1 ? '&' : '?';
  await safeGoto(page, baseUrl + '/wizard.html' + extra + glue + 'resume=1&caption=' + encodeURIComponent('a dream of flying over a glowing city of glass, dreamlike'));
  await page.waitForSelector('#contact-email');
  await page.fill('#contact-email', email || ('mm-' + Date.now() + '@example.com'));
  await page.click('#fn-contact-continue');
}

/** driveToWallAndSubmit + wait for the moment overlay to appear. */
async function signupToMoment(page, search, email) {
  await driveToWallAndSubmit(page, search, email);
  await page.waitForSelector('.mm-overlay', { timeout: 8000 });
}

test('SUBSCRIPTION arm (forced): the Dreamer Pass paywall renders with the toggle DEFAULT OFF ($7.99 no-trial CTA)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await stubBackend(page);
    await signupToMoment(page, '?paywall=subscription&trialarm=free', 'sub-default@example.com');
    assert.equal(await page.locator('.mm-hero').count(), 1, 'the Dreamer Pass hero renders');
    assert.match(await page.locator('.mm-name').textContent(), /Dreamer Pass/);
    // Toggle default OFF -> no-trial $7.99 CTA + SAVE badge visible.
    assert.match(await page.locator('#mm-cta').textContent(), /\$7\.99/);
    assert.equal(await page.locator('#mm-sw.on').count(), 0, 'toggle starts OFF');
  } finally { await page.close(); }
});

test('SUBSCRIPTION arm: toggle OFF -> CTA POSTs passVariant "notrial"; DISMISS then goes straight to home.html', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var checkoutCalls = await stubBackend(page);
    await signupToMoment(page, '?paywall=subscription&trialarm=free', 'sub-notrial@example.com');
    await page.click('#mm-cta'); // toggle OFF
    await settle(function () { return checkoutCalls.length >= 1; });
    assert.equal(checkoutCalls[0].plan, 'dreamer_pass');
    assert.equal(checkoutCalls[0].passVariant, 'notrial', 'toggle OFF maps to notrial');
    assert.equal(checkoutCalls[0].email, 'sub-notrial@example.com');
    // FINDING 1: the cancel leg must carry ?generate=1 so a pendingStartFailed
    // fresh signup that cancels the Dodo checkout still auto-generates at home.
    assert.equal(checkoutCalls[0].cancelUrl, '/home.html?generate=1&checkout=cancelled', 'the subscription cancel URL carries ?generate=1 (dream-loss fix)');
  } finally { await page.close(); }
});

test('SUBSCRIPTION arm: toggle ON + trial-arm free -> passVariant "freetrial"', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var checkoutCalls = await stubBackend(page);
    await signupToMoment(page, '?paywall=subscription&trialarm=free', 'sub-freetrial@example.com');
    await page.click('#mm-sw'); // toggle ON
    await page.waitForSelector('#mm-sw.on');
    await page.click('#mm-cta');
    await settle(function () { return checkoutCalls.length >= 1; });
    assert.equal(checkoutCalls[0].passVariant, 'freetrial', 'toggle ON + free arm maps to freetrial');
  } finally { await page.close(); }
});

test('GATE: with NO founder override, a real user toggling ON always checks out as "freetrial", NEVER "trial50"', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var checkoutCalls = await stubBackend(page);
    // Force the subscription arm but leave the trial arm to real assignment
    // (no ?trialarm). Whatever the raw 50/50 lands on, the gate collapses a
    // raw 'fifty' to 'free', so the effective checkout is always freetrial.
    await signupToMoment(page, '?paywall=subscription', 'gate-real-user@example.com');
    await page.click('#mm-sw');
    await page.waitForSelector('#mm-sw.on');
    await page.click('#mm-cta');
    await settle(function () { return checkoutCalls.length >= 1; });
    assert.equal(checkoutCalls[0].passVariant, 'freetrial', 'a real user can never reach trial50 while the gate is closed');
  } finally { await page.close(); }
});

// NOTE (2026-08-16): the "?trialarm=fifty force-reveals trial50" test was
// REMOVED here — the one-time $1 paid-trial arm (trial50 / ?trialarm=fifty) was
// RETIRED by the founder 2026-08-11 (Dodo couldn't deliver a clean one-time-$1
// paid trial; see js/paywall-moment.js's header). The override no longer reveals
// trial50, so that test had been deterministically failing on main for days —
// dead-test noise that masks real failures. The retired arm's live behavior is
// still covered by the test above ("a real user can never reach trial50 while
// the gate is closed" -> passVariant 'freetrial').

test('TOKENS arm (forced): the 99c/300-token starter renders and its CTA POSTs pack "pack099"', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var checkoutCalls = await stubBackend(page);
    await signupToMoment(page, '?paywall=tokens', 'tokens-arm@example.com');
    assert.match(await page.locator('#mm-cta').textContent(), /\$0\.99|300 tokens/);
    // Founder 2026-08-14: the token wall now sells the real value points the
    // Dreamer Pass wall does (Dream Meaning / Watch & Share / private journal —
    // all available to a token buyer), replacing the weaker "Full dream quality"
    // / "Tokens never expire" / "No subscription" cards. The no-subscription
    // message stays in the price row + fine print, not a benefit card.
    var mmBody = await page.locator('.mm-body').innerText();
    assert.match(mmBody, /Dream Meaning/i, 'the token wall must surface Dream Meaning (interpretation is not Pass-gated)');
    assert.match(mmBody, /Watch (&|and) Share/i, 'the token wall must surface Watch & Share');
    assert.match(mmBody, /private dream journal/i, 'the token wall must surface the private dream journal');
    assert.doesNotMatch(mmBody, /Full dream quality/i, 'the dropped "Full dream quality" card must be gone');
    assert.match(mmBody, /no subscription/i, 'the no-subscription message must still appear (price badge / fine print)');
    await page.click('#mm-cta');
    await settle(function () { return checkoutCalls.length >= 1; });
    assert.equal(checkoutCalls[0].pack, 'pack099', 'the tokens arm reuses the pack099 starter checkout path');
    assert.ok(!checkoutCalls[0].plan, 'the tokens arm is a pack checkout, not a subscription');
    // FINDING 1: same cancel-leg fix on the tokens arm.
    assert.equal(checkoutCalls[0].cancelUrl, '/home.html?generate=1&checkout=cancelled', 'the tokens cancel URL carries ?generate=1 (dream-loss fix)');
  } finally { await page.close(); }
});

// ============================================================================
// fbc/fbp ad-attribution threading into the checkout REQUEST (tracker item
// for-product-for-manager-purchase-meta-ro-nfrfl5, item 2): this is the
// post-signup paywall moment shown to every fresh signup, so it's a real
// ad-attributed conversion surface in its own right — review round 1 found
// it had been missed when shop.html's purchasePack()/purchasePlan() were
// first threaded. Both arms funnel through startPaywallCheckout(), so one
// pair of tests (subscription arm) covers the shared threading point; the
// pack (tokens) arm is exercised for the pack-checkout body shape.
// ============================================================================

test('fbc/fbp: the subscription arm CTA sends fbc/fbp in the checkout request body when Meta\'s cookies are present', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await context.addCookies([
      { name: '_fbc', value: 'fb.1.1700000000000.mmfbc', url: baseUrl },
      { name: '_fbp', value: 'fb.1.1700000000000.mmfbp', url: baseUrl }
    ]);
    var page = await context.newPage();
    await blockThirdParty(page);
    var checkoutCalls = await stubBackend(page);
    await signupToMoment(page, '?paywall=subscription&trialarm=free', 'sub-fbc@example.com');
    await page.click('#mm-cta');
    await settle(function () { return checkoutCalls.length >= 1; });
    assert.equal(checkoutCalls[0].fbc, 'fb.1.1700000000000.mmfbc', 'the checkout request body must carry the real _fbc cookie value');
    assert.equal(checkoutCalls[0].fbp, 'fb.1.1700000000000.mmfbp', 'the checkout request body must carry the real _fbp cookie value');
  } finally {
    await context.close();
  }
});

test('fbc/fbp: the tokens (pack099) arm CTA sends fbc/fbp as null (not omitted, not an error) when Meta\'s cookies are absent', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    // Deliberately no addCookies call -- simulates a real fresh signup with
    // no Meta Pixel cookies at all (e.g. ad blocker, organic).
    var page = await context.newPage();
    await blockThirdParty(page);
    var checkoutCalls = await stubBackend(page);
    await signupToMoment(page, '?paywall=tokens', 'tokens-nofbc@example.com');
    await page.click('#mm-cta');
    await settle(function () { return checkoutCalls.length >= 1; });
    assert.equal(checkoutCalls[0].fbc, null, 'no _fbc cookie must mean a null fbc field, not an error and not a fabricated value');
    assert.equal(checkoutCalls[0].fbp, null);
  } finally {
    await context.close();
  }
});

test('DISMISS (topbar X) goes straight to home.html with no checkout POST', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var checkoutCalls = await stubBackend(page);
    await signupToMoment(page, '?paywall=subscription&trialarm=free', 'dismiss-home@example.com');
    // The redundant "Not now" link was removed (founder 08-14); the topbar X
    // is now the sole dismiss affordance.
    await page.click('.mm-x');
    await page.waitForURL(/home\.html/, { timeout: 8000 });
    assert.match(page.url(), /home\.html/, 'dismiss lands on home.html');
    assert.equal(checkoutCalls.length, 0, 'dismiss fires no checkout');
  } finally { await page.close(); }
});

test('DISMISS via the big X also goes straight to home.html', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await stubBackend(page);
    await signupToMoment(page, '?paywall=tokens', 'dismiss-x@example.com');
    await page.click('.mm-x');
    await page.waitForURL(/home\.html/, { timeout: 8000 });
    assert.match(page.url(), /home\.html/);
  } finally { await page.close(); }
});

// ===========================================================================
// FINDING 1 (end to end): the fixed cancel URL (home.html?generate=1&
// checkout=cancelled) must still auto-generate the drafted dream when NO
// pendingJob was adopted (the real pendingStartFailed case). This drives the
// exact URL the CTA now hands Dodo as its cancel_url, landing on home.html
// with an intact draft and no pendingJob, and asserts the fresh generation
// still fires. The contrast test proves the OLD url (?checkout=cancelled with
// no ?generate=1) is what would have silently dropped the dream.
// ===========================================================================

/** Seeds a signed-in account with an intact draft (no pendingJob) and stubs home.html's boot + generation endpoints. Returns the captured generate-video call array. */
async function seedHomeUserWithDraftAndStubs(page, email, draft) {
  var generateCalls = [];
  await page.route('**/.netlify/functions/get-feed', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ feed: [], dreamOfDayId: null }) });
  });
  await page.route('**/.netlify/functions/get-token-status*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ balance: 1000, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 10 }) });
  });
  await page.route('**/.netlify/functions/get-profile*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await page.route('**/.netlify/functions/video-status**', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: false }) });
  });
  await page.route('**/.netlify/functions/generate-video', function (route) {
    generateCalls.push(JSON.parse(route.request().postData() || '{}'));
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'fal:fake-model:req-cancelleg-1', status: 'queued' }) });
  });
  await safeGoto(page, baseUrl + '/login.html');
  await page.evaluate(function (args) {
    var username = args.email.split('@')[0];
    var state = { user: { handle: '@' + username, username: username }, accounts: {}, dreams: [], likedIds: {}, charactersByUser: {}, draft: args.draft };
    state.accounts[username] = { password: 'testpass1', email: args.email };
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, { email: email, draft: draft });
  return generateCalls;
}

var CANCEL_LEG_DRAFT = { caption: 'Aerial wide shot of me flying through an open sky, dreamlike.', storyText: 'I was flying through an open sky.', style: 'Cinematic', characterIds: [], sceneryTime: null, sceneryPlace: null, restore: false };

test('FINDING 1: the fixed cancel URL (home.html?generate=1&checkout=cancelled) auto-generates the drafted dream when no pendingJob was adopted', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var generateCalls = await seedHomeUserWithDraftAndStubs(page, 'cancel-leg-ok@example.com', CANCEL_LEG_DRAFT);
    await safeGoto(page, baseUrl + '/home.html?generate=1&checkout=cancelled');
    await settle(function () { return generateCalls.length >= 1; });
    assert.ok(generateCalls.length >= 1, 'the drafted dream must auto-generate on the cancel leg — the dream is not dropped');
    assert.equal(generateCalls[0].caption, CANCEL_LEG_DRAFT.caption, 'it generates from the intact draft');
  } finally { await page.close(); }
});

test('FINDING 1 (contrast): the OLD cancel URL (checkout=cancelled, NO generate=1) would have dropped the dream — no generation fires', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var generateCalls = await seedHomeUserWithDraftAndStubs(page, 'cancel-leg-old@example.com', CANCEL_LEG_DRAFT);
    await safeGoto(page, baseUrl + '/home.html?checkout=cancelled');
    // Wait for boot to genuinely progress (token-status resolved -> the page's
    // own render ran) before asserting the negative, so this isn't racing an
    // un-booted page. The bottom nav is present on every booted home render.
    await page.waitForSelector('#bottom-nav, .bottom-nav, nav', { timeout: 8000 }).catch(function () {});
    await settle(function () { return true; }); // let any microtasks flush
    assert.equal(generateCalls.length, 0, 'without ?generate=1 the drafted dream is NOT auto-generated — this is the dream-loss bug the fix closes');
  } finally { await page.close(); }
});

// ===========================================================================
// FINDING 3 (robustness): if js/paywall-moment.js fails to load (a deploy
// hiccup, CDN blip), window.PaywallMoment is undefined and
// showMonetizationMoment throws. The try/catch around the moment call must
// swallow that and fall through to the normal home handoff, so a user whose
// account already exists is NEVER stranded on wizard.html.
// ===========================================================================
test('FINDING 3: a failed paywall-moment.js load (PaywallMoment undefined) still navigates a fresh signup to home.html — never stranded on wizard', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    // Block the module so window.PaywallMoment never gets defined.
    await page.route('**/js/paywall-moment.js', function (route) { route.abort(); });
    await stubBackend(page);
    await driveToWallAndSubmit(page, '?paywall=subscription', 'module-missing@example.com');
    // The moment call throws (PaywallMoment undefined) -> caught -> home handoff.
    await page.waitForURL(/home\.html/, { timeout: 8000 });
    assert.match(page.url(), /home\.html/, 'the signed-up user still lands on home, not stranded on wizard');
    assert.equal(await page.locator('.mm-overlay').count(), 0, 'no overlay renders when the module failed to load');
  } finally { await page.close(); }
});
