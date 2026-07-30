// test/report-block-behavioral.test.js
//
// Real browser-driven coverage for the public-feed-safety build (tracker
// item for-product-public-feed-safety-in-app-re-ppuw77):
//   1. explore.html's feed-card "More" action only shows on someone else's
//      dream, opens js/report-sheet.js.
//   2. Report: form appears, submits { dreamId, reason, ... } to
//      report-dream.js, shows the "Thanks — reported" confirmation, and
//      fires the dream_reported analytics event. A network failure keeps
//      the sheet open with an inline error instead of silently losing the
//      report.
//   3. Block (logged in): tapping Block immediately removes every dream by
//      that author from the CURRENTLY rendered feed, POSTs to
//      block-user.js, and the block survives a reload (persisted
//      localStorage). Fires user_blocked.
//   4. Block (logged out): routes through the existing signup-nudge modal
//      instead of blocking anything.
//   5. profile.html Settings' "Blocked accounts" list shows a blocked
//      handle and Unblock removes it (and the underlying local flag).

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

async function newMobileContext(opts) {
  return browser.newContext(Object.assign({ viewport: MOBILE_VIEWPORT, hasTouch: true }, opts || {}));
}

function installPosthogStub(page) {
  return page.addInitScript(function () {
    window.__capturedEvents = [];
    window.posthog = {
      __loaded: true,
      init: function () {},
      capture: function (name, props) { window.__capturedEvents.push({ name: name, props: props }); }
    };
  });
}

function capturedEventsNamed(page, name) {
  return page.evaluate(function (n) {
    return (window.__capturedEvents || []).filter(function (e) { return e.name === n; });
  }, name);
}

var FEED = [
  { id: 'd-other-1', ownerHandle: '@other', caption: 'A dream about flying', style: 'Cinematic', videoUrl: null, imageUrl: null, mediaType: 'video', likes: 3 },
  { id: 'd-other-2', ownerHandle: '@other', caption: 'Another dream by the same author', style: 'Anime', videoUrl: null, imageUrl: null, mediaType: 'video', likes: 1 },
  { id: 'd-mine-1', ownerHandle: '@tester', caption: "Tester's own dream", style: 'Cartoon', videoUrl: null, imageUrl: null, mediaType: 'video', likes: 0 }
];

async function routeFeed(page, feed) {
  await page.route('**/.netlify/functions/get-feed*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ feed: feed, dreamOfDayId: null }) });
  });
}

// FAKE_AUTH_TOKEN stands in for a real lib/account-auth-token.js token
// (minted server-side by account-login.js/register-account.js on a real
// success -- see test/account-auth-token.test.js for that wiring). These
// behavioral tests always intercept block-user.js via page.route rather
// than hitting a real backend, so the exact token value doesn't need to
// verify against anything -- it only needs to be a non-empty string so
// js/store.js's blockUser/unblockUser/syncBlockedHandlesFromServer's own
// `if (!state.user.authToken) return` gate passes and the mocked network
// call actually fires, mirroring what a real signed-in browser would send.
var FAKE_AUTH_TOKEN = 'test-auth-token-abc123';

async function loginAs(page, handle, username) {
  await safeGoto(page, baseUrl + '/login.html');
  await page.evaluate(function (o) {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: o.handle, username: o.username, authToken: o.authToken };
    if (!state.accounts) state.accounts = {};
    state.accounts[o.username] = { password: 'testpass1', email: o.username + '@example.com' };
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, { handle: handle, username: username, authToken: FAKE_AUTH_TOKEN });
}

var OPEN_TRANSITION_SETTLE_MS = 350;

async function waitForSheetSettled(page) {
  await page.waitForSelector('#report-sheet-overlay.open');
  await page.waitForTimeout(OPEN_TRANSITION_SETTLE_MS);
}

// ============================================================================
// 1. "More" visibility + sheet open
// ============================================================================

test('explore.html: the "More" action only shows on a dream that is NOT the viewer\'s own', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await routeFeed(page, FEED);
    await loginAs(page, '@tester', 'tester');
    await safeGoto(page, baseUrl + '/explore.html');
    await page.waitForSelector('[data-more="d-other-1"]', { timeout: 5000 });

    assert.equal(await page.locator('[data-more="d-other-1"]').count(), 1);
    assert.equal(await page.locator('[data-more="d-mine-1"]').count(), 0, 'the viewer\'s own dream must not offer Report/Block on itself');
  } finally {
    await context.close();
  }
});

test('explore.html: tapping "More" opens the report/block sheet with a dynamic "Block handle" label (display drops the leading @ — tracker item for-product-ui-founder-directed-2026-07--w3mc4v)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await routeFeed(page, FEED);
    await loginAs(page, '@tester', 'tester');
    await safeGoto(page, baseUrl + '/explore.html');
    await page.waitForSelector('[data-more="d-other-1"]', { timeout: 5000 });

    await page.click('[data-more="d-other-1"]');
    await waitForSheetSettled(page);
    assert.match(await page.textContent('#report-opt-report'), /Report this dream/);
    assert.match(await page.textContent('#report-opt-block'), /Block other/);
    assert.doesNotMatch(await page.textContent('#report-opt-block'), /@other/, 'display must not carry the stored handle\'s leading @');
  } finally {
    await context.close();
  }
});

// ============================================================================
// 2. Report
// ============================================================================

test('report: submitting an optional reason POSTs it to report-dream.js and shows the confirmation view + fires dream_reported', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await installPosthogStub(page);
    await routeFeed(page, FEED);
    await loginAs(page, '@tester', 'tester');

    var capturedBody = null;
    await page.route('**/.netlify/functions/report-dream', function (route) {
      capturedBody = JSON.parse(route.request().postData());
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await safeGoto(page, baseUrl + '/explore.html');
    await page.waitForSelector('[data-more="d-other-1"]', { timeout: 5000 });
    await page.click('[data-more="d-other-1"]');
    await waitForSheetSettled(page);

    await page.click('#report-opt-report');
    await page.waitForSelector('#report-sheet-form:visible', { timeout: 3000 });
    await page.fill('#report-reason-input', 'This looks disturbing');
    await page.click('#report-submit-btn');

    await page.waitForSelector('#report-sheet-done:visible', { timeout: 5000 });
    assert.match(await page.textContent('#report-sheet-done'), /Thanks — reported/);

    assert.ok(capturedBody, 'report-dream.js must have been called');
    assert.equal(capturedBody.dreamId, 'd-other-1');
    assert.equal(capturedBody.dreamOwnerHandle, '@other');
    assert.equal(capturedBody.reason, 'This looks disturbing');
    assert.equal(capturedBody.reporterHandle, '@tester');

    var events = await capturedEventsNamed(page, 'dream_reported');
    assert.equal(events.length, 1);
    assert.equal(events[0].props.dreamId, 'd-other-1');
  } finally {
    await context.close();
  }
});

test('report: an empty reason is still a valid submission (reason is optional)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await routeFeed(page, FEED);

    var capturedBody = null;
    await page.route('**/.netlify/functions/report-dream', function (route) {
      capturedBody = JSON.parse(route.request().postData());
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await safeGoto(page, baseUrl + '/explore.html');
    await page.waitForSelector('[data-more="d-other-1"]', { timeout: 5000 });
    await page.click('[data-more="d-other-1"]');
    await waitForSheetSettled(page);
    await page.click('#report-opt-report');
    await page.waitForSelector('#report-sheet-form:visible', { timeout: 3000 });
    await page.click('#report-submit-btn');

    await page.waitForSelector('#report-sheet-done:visible', { timeout: 5000 });
    assert.equal(capturedBody.reason, null);
    assert.equal(capturedBody.reporterHandle, null, 'a logged-out reporter must be sent as null, not fabricated');
  } finally {
    await context.close();
  }
});

test('report: a server error keeps the form open with an inline error instead of losing the report silently', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await routeFeed(page, FEED);
    await page.route('**/.netlify/functions/report-dream', function (route) {
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) });
    });

    await safeGoto(page, baseUrl + '/explore.html');
    await page.waitForSelector('[data-more="d-other-1"]', { timeout: 5000 });
    await page.click('[data-more="d-other-1"]');
    await waitForSheetSettled(page);
    await page.click('#report-opt-report');
    await page.waitForSelector('#report-sheet-form:visible', { timeout: 3000 });
    await page.click('#report-submit-btn');

    await page.waitForSelector('#report-sheet-error:has-text("Couldn\'t submit")', { timeout: 5000 });
    assert.equal(await page.locator('#report-sheet-form').isVisible(), true, 'the form must stay open (not silently advance) on a failed submit');
    assert.equal(await page.locator('#report-submit-btn').isDisabled(), false, 'the submit button must be re-enabled so the user can retry');
  } finally {
    await context.close();
  }
});

// ============================================================================
// 3. Block (logged in)
// ============================================================================

test('block (logged in): tapping Block immediately hides every dream by that author from the current feed and POSTs to block-user.js', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await installPosthogStub(page);
    await routeFeed(page, FEED);
    await loginAs(page, '@tester', 'tester');

    var capturedBody = null;
    await page.route('**/.netlify/functions/block-user', function (route) {
      if (route.request().method() === 'POST') {
        capturedBody = JSON.parse(route.request().postData());
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, blockedHandles: ['@other'] }) });
      } else {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, blockedHandles: [] }) });
      }
    });

    await safeGoto(page, baseUrl + '/explore.html');
    await page.waitForSelector('[data-more="d-other-1"]', { timeout: 5000 });
    // Both of @other's dreams are present before blocking.
    assert.equal(await page.locator('[data-id="d-other-1"]').count(), 1);

    await page.click('[data-more="d-other-1"]');
    await waitForSheetSettled(page);
    await page.click('#report-opt-block');

    await page.waitForSelector('.toast.show', { timeout: 5000 });
    assert.match(await page.textContent('#toast'), /Blocked other/);
    assert.equal(await page.locator('#report-sheet-overlay.open').count(), 0, 'the sheet must close once Block is tapped');

    // Every dream by @other must be gone from the rendered feed now,
    // including the second one that was never directly acted on.
    assert.equal(await page.locator('[data-id="d-other-1"]').count(), 0);
    assert.equal(await page.locator('[data-id="d-other-2"]').count(), 0);
    assert.equal(await page.locator('[data-id="d-mine-1"]').count(), 1, 'an unrelated dream must remain visible');

    assert.ok(capturedBody, 'block-user.js must have been POSTed to');
    assert.equal(capturedBody.authToken, FAKE_AUTH_TOKEN, 'the acting account must be proven via a verified authToken, never a bare username');
    assert.equal(Object.prototype.hasOwnProperty.call(capturedBody, 'username'), false, 'block-user.js no longer accepts (or needs) a bare client-supplied username at all');
    assert.equal(capturedBody.blockedHandle, '@other');
    assert.equal(capturedBody.action, 'block');

    var events = await capturedEventsNamed(page, 'user_blocked');
    assert.equal(events.length, 1);
    assert.equal(events[0].props.blockedHandle, '@other');
  } finally {
    await context.close();
  }
});

test('block (logged in): the block survives a reload (persisted locally), even if block-user.js is unreachable', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await routeFeed(page, FEED);
    await loginAs(page, '@tester', 'tester');
    await page.route('**/.netlify/functions/block-user', function (route) { route.abort('failed'); });

    await safeGoto(page, baseUrl + '/explore.html');
    await page.waitForSelector('[data-more="d-other-1"]', { timeout: 5000 });
    await page.click('[data-more="d-other-1"]');
    await waitForSheetSettled(page);
    await page.click('#report-opt-block');
    await page.waitForSelector('.toast.show', { timeout: 5000 });
    assert.equal(await page.locator('[data-id="d-other-1"]').count(), 0, 'blocked locally even though the server sync failed');

    await safeGoto(page, baseUrl + '/explore.html');
    await page.waitForSelector('[data-id="d-mine-1"]', { timeout: 5000 });
    assert.equal(await page.locator('[data-id="d-other-1"]').count(), 0, 'the block must still apply after a reload');
    assert.equal(await page.locator('[data-id="d-other-2"]').count(), 0);
  } finally {
    await context.close();
  }
});

// ============================================================================
// 4. Block (logged out)
// ============================================================================

test('block (logged out): tapping Block routes through the signup nudge instead of blocking anything', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await routeFeed(page, FEED);
    var blockUserCalled = false;
    await page.route('**/.netlify/functions/block-user', function (route) {
      blockUserCalled = true;
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, blockedHandles: [] }) });
    });

    await safeGoto(page, baseUrl + '/explore.html');
    await page.waitForSelector('[data-more="d-other-1"]', { timeout: 5000 });
    await page.click('[data-more="d-other-1"]');
    await waitForSheetSettled(page);
    await page.click('#report-opt-block');

    await page.waitForSelector('#modal-signup-nudge.open', { timeout: 5000 });
    assert.equal(await page.locator('[data-id="d-other-1"]').count(), 1, 'nothing must be hidden when blocking was never authorized');
    assert.equal(blockUserCalled, false, 'block-user.js must never be called for a logged-out attempt');
  } finally {
    await context.close();
  }
});

// ============================================================================
// 5. profile.html Settings — Blocked accounts list + Unblock
// ============================================================================

test('profile.html Settings: a blocked handle appears in "Blocked accounts", and Unblock removes it', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.route('**/.netlify/functions/block-user*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, blockedHandles: [] }) });
    });
    await page.route('**/.netlify/functions/get-feed*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ feed: [], dreamOfDayId: null }) });
    });
    await page.route('**/.netlify/functions/get-token-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ balance: 200, claimable: false, nextClaimAt: null }) });
    });

    await safeGoto(page, baseUrl + '/login.html');
    await page.evaluate(function (token) {
      var raw = localStorage.getItem('dreamtube_state_v1');
      var state = raw ? JSON.parse(raw) : {};
      state.user = { handle: '@tester', username: 'tester', authToken: token };
      if (!state.accounts) state.accounts = {};
      state.accounts.tester = { password: 'testpass1', email: 'tester@example.com' };
      // Per-account keying (review finding, fixed) -- see js/store.js's
      // state.blockedByUser doc comment: this is NOT a flat device-level
      // map anymore, it's keyed by the (lowercased) signed-in username,
      // same scheme as charactersByUser.
      state.blockedByUser = { tester: { '@other': true } };
      localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    }, FAKE_AUTH_TOKEN);

    await safeGoto(page, baseUrl + '/profile.html');
    await page.click('#account-btn');
    await page.waitForSelector('#sheet-account-overlay.open', { timeout: 5000 });

    await page.waitForSelector('#blocked-accounts-section:visible', { timeout: 5000 });
    assert.match(await page.textContent('#blocked-accounts-list'), /other/);
    assert.doesNotMatch(await page.textContent('#blocked-accounts-list'), /@other/, 'the blocked-accounts list must display the handle without its leading @ (the data-unblock attribute below still carries the real, @-prefixed stored value)');

    // The data-unblock attribute is NOT a display surface -- it must keep
    // carrying the real, @-prefixed stored handle unchanged, since it's
    // what gets passed straight to DreamStore.unblockUser (an equality/
    // lookup call, out of scope for this display-only change).
    await page.click('[data-unblock="@other"]');
    await page.waitForSelector('.toast.show', { timeout: 5000 });
    assert.match(await page.textContent('#toast'), /Unblocked other/);
    assert.equal(await page.locator('#blocked-accounts-section').isVisible(), false, 'the section hides itself once the list is empty again');

    var stillBlocked = await page.evaluate(function () {
      var state = JSON.parse(localStorage.getItem('dreamtube_state_v1'));
      return !!(state.blockedByUser && state.blockedByUser.tester && state.blockedByUser.tester['@other']);
    });
    assert.equal(stillBlocked, false, 'the underlying local flag must actually be cleared, not just hidden visually');
  } finally {
    await context.close();
  }
});

test('profile.html Settings: a SECOND account signed into the same browser does not see the first account\'s block, and cannot unblock it (review finding, fixed)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.route('**/.netlify/functions/block-user*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, blockedHandles: [] }) });
    });
    await page.route('**/.netlify/functions/get-feed*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ feed: [], dreamOfDayId: null }) });
    });
    await page.route('**/.netlify/functions/get-token-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ balance: 200, claimable: false, nextClaimAt: null }) });
    });

    // Account A (nora) has blocked @other. Then account B (priya) signs in
    // on this SAME browser -- same shared/family-device scenario the
    // review finding described.
    await safeGoto(page, baseUrl + '/login.html');
    await page.evaluate(function () {
      var raw = localStorage.getItem('dreamtube_state_v1');
      var state = raw ? JSON.parse(raw) : {};
      state.user = { handle: '@priya', username: 'priya', authToken: 'priya-token' };
      if (!state.accounts) state.accounts = {};
      state.accounts.nora = { password: 'testpass1', email: 'nora@example.com' };
      state.accounts.priya = { password: 'testpass1', email: 'priya@example.com' };
      // nora's own block, priya's own (empty) entry -- exactly what two
      // real accounts sharing a browser would look like locally.
      state.blockedByUser = { nora: { '@other': true }, priya: {} };
      localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    });

    await safeGoto(page, baseUrl + '/profile.html');
    await page.click('#account-btn');
    await page.waitForSelector('#sheet-account-overlay.open', { timeout: 5000 });

    // priya (the CURRENTLY signed-in account) must not see nora's block at all.
    assert.equal(await page.locator('#blocked-accounts-section').isVisible(), false, "priya must not see nora's block in her own Settings");

    var isolationCheck = await page.evaluate(function () {
      return {
        noraStillBlocked: !!(JSON.parse(localStorage.getItem('dreamtube_state_v1')).blockedByUser.nora['@other']),
        priyaSeesIt: window.DreamStore.getBlockedHandles().indexOf('@other') !== -1
      };
    });
    assert.equal(isolationCheck.priyaSeesIt, false, "DreamStore.getBlockedHandles() must be scoped to the CURRENTLY signed-in account (priya), not the whole device");
    assert.equal(isolationCheck.noraStillBlocked, true, "nora's own block must remain completely intact and untouched by priya's session");
  } finally {
    await context.close();
  }
});
