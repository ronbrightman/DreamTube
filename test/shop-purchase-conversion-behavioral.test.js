// test/shop-purchase-conversion-behavioral.test.js
//
// Real browser-driven coverage for the Purchase conversion event added to
// shop.html's ?checkout=success return trip (see docs/EVENT_TAXONOMY.md's
// "Purchase / purchase_completed" entry). Before this, a real Dodo Payments
// purchase completing and redirecting back here fired zero conversion
// events -- no PostHog capture, no Meta Pixel/CAPI event -- which meant (1)
// the shop-palette A/B test (test/shop-palette-variant-behavioral.test.js)
// could show variant exposure but never which variant actually converts,
// and (2) Meta ad spend had no Purchase signal at all.
//
// The fix is a sessionStorage marker (dreamtube_pending_purchase),
// following the exact spoofing-resistance pattern
// test/first-video-created-behavioral.test.js already covers for
// result.html's dreamtube_just_generated_id: purchasePack() stashes
// {pack, tokens, price} right before the real outbound redirect to Dodo,
// and handleCheckoutReturn reads + unconditionally removes it exactly once
// on a ?checkout=success load. Without the marker present, the bare query
// param alone must not be enough to fire a Purchase event -- otherwise
// anyone could fake a conversion by hand-visiting the URL. The marker is
// ALSO cleared on ?checkout=cancelled (a review finding on the first pass
// of this branch: cancelled attempts set the exact same marker on their
// way to Dodo, so leaving it in place would let a later, unrelated
// ?checkout=success visit in the same tab consume a stale marker from an
// attempt that never actually completed).
//
// Follows test/shop-behavioral.test.js's seedShopPage/mockTokenStatus/
// blockThirdParty conventions, test/meta-capi-behavioral.test.js's
// installFbqRecorder/captureTrackConversion pattern for the standard
// (non-custom) fbq('track', ...) call Purchase uses, and
// test/shop-palette-variant-behavioral.test.js's/
// test/first-video-created-behavioral.test.js's approach of reading
// PostHog calls straight out of the stub's own pending-call queue.

var test = require('node:test');
var assert = require('node:assert/strict');
var staticServer = require('./helpers/static-server');

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

function mockTokenStatus(page, status) {
  return page.route('**/.netlify/functions/get-token-status*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(status || { balance: 50, nextGrantAt: Date.now() + 3600000, dailyGrantAmount: 100 }) });
  });
}

/** Same recorder as test/meta-capi-behavioral.test.js -- must be installed on the context before any page.goto(). */
async function installFbqRecorder(context) {
  var calls = [];
  await context.exposeBinding('__recordFbqCall', function (source, args) {
    calls.push(args);
  });
  await context.addInitScript(function () {
    var wrapped = null;
    Object.defineProperty(window, 'fbq', {
      configurable: true,
      get: function () { return wrapped; },
      set: function (fn) {
        wrapped = function () {
          try { window.__recordFbqCall(Array.prototype.slice.call(arguments)); } catch (e) { /* recording must never break the real fbq call below */ }
          return fn.apply(this, arguments);
        };
      }
    });
  });
  return calls;
}

/** Intercepts every POST to track-conversion, recording each parsed body and fulfilling with a 200 success response. */
function captureTrackConversion(page) {
  var calls = [];
  return page.route('**/.netlify/functions/track-conversion', function (route) {
    var body = null;
    try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) { /* leave null */ }
    calls.push(body);
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
  }).then(function () { return calls; });
}

/** Reads every posthog call made during this page load straight out of the PostHog stub's own pending-call queue -- see test/first-video-created-behavioral.test.js's header comment for why this is more reliable here than a monkeypatch. */
function readPostHogCalls(page) {
  return page.evaluate(function () {
    var queue = (window.posthog && typeof window.posthog.slice === 'function') ? window.posthog.slice() : [];
    return queue;
  });
}

function fbqTrackCalls(fbqCalls, eventName) {
  return fbqCalls.filter(function (args) { return args[0] === 'track' && args[1] === eventName; });
}

/** Logs a shopper account into localStorage, same shape as test/shop-behavioral.test.js's seedShopPage. */
async function seedAccount(page) {
  await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function () {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@shopper', username: 'shopper' };
    if (!state.accounts) state.accounts = {};
    state.accounts.shopper = { password: 'testpass1', email: 'shopper@example.com' };
    if (!state.dreams) state.dreams = [];
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  });
}

/** Sets the dreamtube_pending_purchase sessionStorage marker purchasePack() writes right before redirecting to Dodo. Must run on a page already on this origin. */
function markPendingPurchase(page, info) {
  return page.evaluate(function (o) {
    sessionStorage.setItem('dreamtube_pending_purchase', JSON.stringify(o));
  }, info);
}

test('a real checkout return (marker present) fires purchase_completed on PostHog and Purchase on Meta, with the correct pack/value, and consumes the marker', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var fbqCalls = await installFbqRecorder(context);
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    var conversionCalls = await captureTrackConversion(page);

    await seedAccount(page);
    // Land directly on the success URL first so sessionStorage is set on
    // the right origin/page before the marker-checking navigation -- same
    // two-step approach test/first-video-created-behavioral.test.js uses
    // for its sessionStorage marker (seed, then navigate to the page that
    // consumes it). Here we seed via an initial shop.html visit, set the
    // marker, then navigate again with ?checkout=success so
    // handleCheckoutReturn's IIFE runs fresh with the marker already in
    // place.
    await page.goto(baseUrl + '/shop.html', { waitUntil: 'domcontentloaded' });
    // eventId here mirrors what create-checkout-session-dodo.js's real
    // response now always carries (Phase 1 reporting instrumentation --
    // shared between this client-side fire and dodo-webhook.js's own
    // server-side Purchase fire, for PostHog/Meta dedup -- see that
    // file's own header comment). A production purchasePack() call always
    // has one; this seed matches that reality rather than the pre-Phase-1
    // shape. pack700/$14.99 matches Token Economy C's 3-pack lineup.
    await markPendingPurchase(page, { pack: 'pack700', tokens: 700, price: 14.99, eventId: 'evt-fixed-test-id' });

    await page.goto(baseUrl + '/shop.html?checkout=success', { waitUntil: 'domcontentloaded' });
    // fireMetaConversion's CAPI POST is fire-and-forget -- give it a moment
    // to land on the intercepted route before asserting on conversionCalls.
    await page.waitForTimeout(300);

    var fbqPurchaseCalls = fbqTrackCalls(fbqCalls, 'Purchase');
    assert.equal(fbqPurchaseCalls.length, 1, 'expected exactly one fbq track Purchase call');
    var eventId = fbqPurchaseCalls[0][3] && fbqPurchaseCalls[0][3].eventID;
    assert.equal(eventId, 'evt-fixed-test-id', 'the fbq Purchase call must use the SHARED event_id from the pending marker, not a freshly generated one, so it dedupes against dodo-webhook.js\'s own server-side Purchase fire');

    var purchaseConversions = conversionCalls.filter(function (body) { return body && body.event_name === 'Purchase'; });
    assert.equal(purchaseConversions.length, 1, 'expected exactly one Purchase POST to track-conversion');
    assert.equal(purchaseConversions[0].event_id, eventId, 'track-conversion event_id must match the fbq call\'s eventID, so Meta can dedupe them');
    assert.deepEqual(purchaseConversions[0].custom_data, { value: 14.99, currency: 'USD' });

    var phCalls = await readPostHogCalls(page);
    var purchaseCaptures = phCalls.filter(function (entry) { return entry[0] === 'capture' && entry[1] === 'purchase_completed'; });
    assert.equal(purchaseCaptures.length, 1, 'expected exactly one posthog.capture(\'purchase_completed\', ...) call');
    assert.deepEqual(purchaseCaptures[0][2], { pack: 'pack700', tokens: 700, value: 14.99, currency: 'USD', $insert_id: 'evt-fixed-test-id' });

    var markerAfter = await page.evaluate(function () { return sessionStorage.getItem('dreamtube_pending_purchase'); });
    assert.equal(markerAfter, null, 'the marker must be consumed (removed) after firing');
  } finally {
    await context.close();
  }
});

test('landing on ?checkout=success WITHOUT the marker (stale bookmark / manual visit) fires neither conversion event', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var fbqCalls = await installFbqRecorder(context);
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    var conversionCalls = await captureTrackConversion(page);

    await seedAccount(page);
    // Deliberately NOT calling markPendingPurchase -- simulates a stale
    // bookmark, a shared link, or someone hand-typing the query param with
    // no real checkout ever having happened.
    await page.goto(baseUrl + '/shop.html?checkout=success', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(300);

    assert.equal(fbqTrackCalls(fbqCalls, 'Purchase').length, 0, 'no marker must mean no fbq Purchase call');
    assert.equal(conversionCalls.filter(function (b) { return b && b.event_name === 'Purchase'; }).length, 0, 'no marker must mean no Purchase POST to track-conversion');
    var phCalls = await readPostHogCalls(page);
    assert.equal(phCalls.filter(function (entry) { return entry[0] === 'capture' && entry[1] === 'purchase_completed'; }).length, 0, 'no marker must mean no posthog purchase_completed capture');

    // The existing toast + query-param-clearing behavior must be
    // unaffected either way -- this feature is additive only.
    await page.waitForFunction(function () {
      var t = document.getElementById('toast');
      return t && t.classList.contains('show') && /payment received/i.test(t.textContent);
    }, null, { timeout: 5000 });
    assert.doesNotMatch(page.url(), /checkout=success/);
  } finally {
    await context.close();
  }
});

test('a cancelled checkout clears the marker, so a LATER bare/bookmarked ?checkout=success visit in the same tab does not fire a false Purchase', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var fbqCalls = await installFbqRecorder(context);
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    var conversionCalls = await captureTrackConversion(page);

    await seedAccount(page);
    // Same marker purchasePack() would have set right before redirecting to
    // Dodo -- but this attempt gets cancelled, not completed.
    await page.goto(baseUrl + '/shop.html', { waitUntil: 'domcontentloaded' });
    await markPendingPurchase(page, { pack: 'pack700', tokens: 700, price: 14.99 });

    await page.goto(baseUrl + '/shop.html?checkout=cancelled', { waitUntil: 'domcontentloaded' });
    var markerAfterCancel = await page.evaluate(function () { return sessionStorage.getItem('dreamtube_pending_purchase'); });
    assert.equal(markerAfterCancel, null, 'a cancelled checkout must clear the marker too, not just a successful one');

    // Same tab, later, lands on a bare ?checkout=success -- e.g. a stale
    // bookmark from a PREVIOUS successful purchase, or someone hand-typing
    // it. With the marker already gone from the cancel above, this must not
    // be mistaken for proof the cancelled attempt actually went through.
    await page.goto(baseUrl + '/shop.html?checkout=success', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(300);

    assert.equal(fbqTrackCalls(fbqCalls, 'Purchase').length, 0, 'the stale-cleared marker must not produce a false Purchase fbq call');
    assert.equal(conversionCalls.filter(function (b) { return b && b.event_name === 'Purchase'; }).length, 0, 'the stale-cleared marker must not produce a false Purchase CAPI POST');
    var phCalls = await readPostHogCalls(page);
    assert.equal(phCalls.filter(function (entry) { return entry[0] === 'capture' && entry[1] === 'purchase_completed'; }).length, 0, 'the stale-cleared marker must not produce a false posthog purchase_completed capture');
  } finally {
    await context.close();
  }
});

test('a reload after a successful first fire does not re-fire (marker already consumed)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var fbqCalls = await installFbqRecorder(context);
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    var conversionCalls = await captureTrackConversion(page);

    await seedAccount(page);
    await page.goto(baseUrl + '/shop.html', { waitUntil: 'domcontentloaded' });
    await markPendingPurchase(page, { pack: 'pack100', tokens: 100, price: 2.99 });

    await page.goto(baseUrl + '/shop.html?checkout=success', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(300);
    assert.equal(fbqTrackCalls(fbqCalls, 'Purchase').length, 1, 'sanity check: the first load fired once');

    // history.replaceState already cleared ?checkout=success from the URL
    // (existing behavior), so reload the plain shop.html the browser is
    // now actually sitting on -- a real user hitting refresh here would do
    // exactly this.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(300);

    assert.equal(fbqTrackCalls(fbqCalls, 'Purchase').length, 1, 'a reload must not re-fire the Pixel Purchase event');
    assert.equal(conversionCalls.filter(function (b) { return b && b.event_name === 'Purchase'; }).length, 1, 'a reload must not re-fire the CAPI Purchase event');
    var phCalls = await readPostHogCalls(page);
    assert.equal(phCalls.filter(function (entry) { return entry[0] === 'capture' && entry[1] === 'purchase_completed'; }).length, 0, 'a reload gets a fresh PostHog queue (new page load) and must not queue a new purchase_completed call either');
  } finally {
    await context.close();
  }
});

test('the REAL click-to-checkout flow -- not a hand-seeded marker -- carries create-checkout-session-dodo.js\'s own returned eventId all the way through to both the Meta and PostHog Purchase fires (Phase 1 reporting instrumentation\'s server-side dedup id)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var fbqCalls = await installFbqRecorder(context);
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    var conversionCalls = await captureTrackConversion(page);

    await seedAccount(page);
    await page.goto(baseUrl + '/shop.html', { waitUntil: 'domcontentloaded' });

    // Mock the real endpoint create-checkout-session-dodo.js exposes --
    // this is the exact link that silently broke once already (an edit
    // made but never actually committed to its branch): the endpoint
    // mints an eventId and returns it, purchasePack() has to actually
    // read data.eventId and store it, and the eventual Purchase fire has
    // to actually use it. A hand-seeded marker (as the other tests in
    // this file use) skips over purchasePack() entirely and can't catch
    // a regression in that specific reading/storing step.
    await page.route('**/.netlify/functions/create-checkout-session-dodo', function (route) {
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ url: baseUrl + '/shop.html?checkout=success', sessionId: 'cks_real_flow', eventId: 'evt-real-server-eventid' })
      });
    });

    await page.click('#shop-buy-pack100');
    await page.waitForURL(/checkout=success/, { timeout: 5000 });
    await page.waitForTimeout(300);

    var fbqPurchaseCalls = fbqTrackCalls(fbqCalls, 'Purchase');
    assert.equal(fbqPurchaseCalls.length, 1);
    var usedEventId = fbqPurchaseCalls[0][3] && fbqPurchaseCalls[0][3].eventID;
    assert.equal(usedEventId, 'evt-real-server-eventid', 'the REAL server-returned eventId must be what the Meta Pixel call actually uses, proving create-checkout-session-dodo.js\'s response -> purchasePack() -> the pending-purchase marker -> the Purchase fire all genuinely connect end to end');

    var purchaseConversions = conversionCalls.filter(function (b) { return b && b.event_name === 'Purchase'; });
    assert.equal(purchaseConversions.length, 1);
    assert.equal(purchaseConversions[0].event_id, 'evt-real-server-eventid');

    var phCalls = await readPostHogCalls(page);
    var purchaseCaptures = phCalls.filter(function (entry) { return entry[0] === 'capture' && entry[1] === 'purchase_completed'; });
    assert.equal(purchaseCaptures.length, 1);
    assert.equal(purchaseCaptures[0][2].$insert_id, 'evt-real-server-eventid', 'PostHog\'s $insert_id must also be the real server-returned eventId, not a client-generated fallback, so dodo-webhook.js\'s own server-side Purchase fire can actually dedupe against this one');
  } finally {
    await context.close();
  }
});
