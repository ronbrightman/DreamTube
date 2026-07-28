// test/posthog-test-traffic-tagging-behavioral.test.js
//
// Covers tracker item for-product-data-hygiene-tag-exclude-tes-2lp0uw: 22 of
// 23 purchase_completed events in PostHog turned out to be test fixtures
// (@example.com emails, __probe_..._..__-style throwaway usernames) that the
// existing Israel-geo filter never catches, contaminating the Business
// Overview dashboard's Purchases/Revenue tiles. Fix (js/store.js's
// identifyForAnalytics, via the new isTestOrInternalIdentity helper): tag a
// PostHog person property, is_test:true, via posthog.setPersonProperties()
// right after identify(), whenever the identity being identified is a known
// founder account, an @example.com email, or a probe-style username.
//
// This is capture-time tagging only -- it deliberately does NOT touch any
// dashboard/project-level filter configuration (that's Manager's own
// follow-up per the tracker item).
//
// Follows test/posthog-identity-merge-behavioral.test.js's own conventions:
// a plain static file server (no real Netlify Functions runtime),
// register-account mocked via page.route() for deterministic signups,
// blockThirdParty() for this sandbox's flaky outbound network, safeGoto()
// to tolerate a transient nav failure, and reading PostHog calls straight
// out of the stub's own pending-call queue (window.posthog stays the
// pre-init stub array the whole test, since blockThirdParty aborts the real
// array.js bundle load).

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

/** Wraps page.goto with 'domcontentloaded' (not the default 'load') and tolerates a transient nav failure -- see CLAUDE.md's known environment quirk. */
async function safeGoto(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  } catch (e) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  }
}

/** Mocks register-account.js to always succeed, so DreamStore.signup() resolves deterministically without a real Netlify Functions runtime. */
function mockSignupSucceeds(page) {
  return page.route('**/.netlify/functions/register-account', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
}

/** Reads every posthog call made so far straight out of the PostHog stub's own pending-call queue. */
function readPostHogCalls(page) {
  return page.evaluate(function () {
    var queue = (window.posthog && typeof window.posthog.slice === 'function') ? window.posthog.slice() : [];
    return queue;
  });
}

function callsNamed(calls, name) {
  return calls.filter(function (entry) { return entry[0] === name; });
}

test('identifyForAnalytics: an @example.com signup email gets tagged is_test:true via setPersonProperties, right after identify()', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  await mockSignupSucceeds(page);
  try {
    await safeGoto(page, baseUrl + '/wizard.html');

    var result = await page.evaluate(function () {
      return window.DreamStore.signup('exampletestuser', 'password123', 'exampletestuser@example.com');
    });
    assert.equal(result.ok, true);

    var calls = await readPostHogCalls(page);
    var identifies = callsNamed(calls, 'identify');
    var setProps = callsNamed(calls, 'setPersonProperties');

    assert.equal(identifies.length, 1);
    assert.equal(setProps.length, 1, 'an @example.com identity must be tagged exactly once');
    assert.deepEqual(setProps[0].slice(1), [{ is_test: true }]);

    var identifyIndex = calls.indexOf(identifies[0]);
    var setPropsIndex = calls.indexOf(setProps[0]);
    assert.ok(identifyIndex < setPropsIndex, 'setPersonProperties must fire after identify(), not before');
  } finally {
    await page.close();
  }
});

test('identifyForAnalytics: a normal real-looking email does NOT get tagged is_test', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  await mockSignupSucceeds(page);
  try {
    await safeGoto(page, baseUrl + '/wizard.html');

    var result = await page.evaluate(function () {
      return window.DreamStore.signup('realgenuineuser', 'password123', 'realgenuineuser@gmail.com');
    });
    assert.equal(result.ok, true);

    var calls = await readPostHogCalls(page);
    assert.equal(callsNamed(calls, 'identify').length, 1, 'sanity: identify() must still fire normally');
    assert.equal(callsNamed(calls, 'setPersonProperties').length, 0, 'a genuine-looking email/username must never be tagged is_test');
  } finally {
    await page.close();
  }
});

test('identifyForAnalytics: the founder\'s own known accounts (ronbrightman, benbrightman14) get tagged is_test regardless of their email', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  await mockSignupSucceeds(page);
  try {
    await safeGoto(page, baseUrl + '/wizard.html');

    var ronResult = await page.evaluate(function () {
      return window.DreamStore.signup('ronbrightman', 'password123', 'ron@gmail.com');
    });
    assert.equal(ronResult.ok, true);

    var afterRon = await readPostHogCalls(page);
    var ronSetProps = callsNamed(afterRon, 'setPersonProperties');
    assert.equal(ronSetProps.length, 1, 'ronbrightman must be tagged is_test even with a normal-looking email');
    assert.deepEqual(ronSetProps[0].slice(1), [{ is_test: true }]);
  } finally {
    await page.close();
  }

  var page2 = await browser.newPage();
  await blockThirdParty(page2);
  await mockSignupSucceeds(page2);
  try {
    await safeGoto(page2, baseUrl + '/wizard.html');

    var benResult = await page2.evaluate(function () {
      return window.DreamStore.signup('benbrightman14', 'password123', 'ben@gmail.com');
    });
    assert.equal(benResult.ok, true);

    var afterBen = await readPostHogCalls(page2);
    var benSetProps = callsNamed(afterBen, 'setPersonProperties');
    assert.equal(benSetProps.length, 1, 'benbrightman14 (founder\'s confirmed secondary account) must be tagged is_test too');
    assert.deepEqual(benSetProps[0].slice(1), [{ is_test: true }]);
  } finally {
    await page2.close();
  }
});

test('identifyForAnalytics: a probe-style throwaway username (__word__ shape) gets tagged is_test', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await safeGoto(page, baseUrl + '/wizard.html');

    // signup() itself already rejects the __word__ shape client-side (the
    // same E10-equivalent guard register-account.js enforces server-side),
    // so exercise identifyForAnalytics the way a real probe-shaped account
    // reaches it today: importAccountBackup(), the one public DreamStore
    // entry point that accepts an arbitrary username (a restored backup's
    // own recorded identity) without that guard and calls
    // identifyForAnalytics(username) directly -- mirroring how the actual
    // founder account was originally created under the literal username
    // "__probe_throwaway_user__" before ever being renamed (see
    // LEGACY_ACCOUNT_RENAME's own comment).
    var result = await page.evaluate(function () {
      return window.DreamStore.importAccountBackup({
        dreamtubeBackupVersion: 1,
        username: '__probe_2nd_throwaway__',
        account: { password: 'password123', email: 'probe2@example.com' },
        dreams: [],
        characters: []
      });
    });
    assert.equal(result.ok, true, 'importAccountBackup must succeed for a fresh, not-yet-locally-known username');

    var calls = await readPostHogCalls(page);
    var setProps = callsNamed(calls, 'setPersonProperties');
    assert.equal(setProps.length, 1, 'a __word__-shaped username must be tagged is_test');
    assert.deepEqual(setProps[0].slice(1), [{ is_test: true }]);
  } finally {
    await page.close();
  }
});

test('identifyForAnalytics: a missing/unavailable PostHog object never throws -- signup still succeeds normally', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  await mockSignupSucceeds(page);
  try {
    await safeGoto(page, baseUrl + '/wizard.html');

    // Simulate PostHog genuinely unavailable (e.g. POSTHOG_KEY still the
    // placeholder -- see js/analytics-config.js -- or the array.js bundle
    // failed to load) by removing the stub entirely before signing up.
    await page.evaluate(function () { delete window.posthog; });

    var result = await page.evaluate(function () {
      return window.DreamStore.signup('noposthogaccount', 'password123', 'noposthogaccount@example.com');
    });
    assert.equal(result.ok, true, 'signup must succeed even with no PostHog object at all -- analytics must never break auth');

    var posthogStillMissing = await page.evaluate(function () { return typeof window.posthog === 'undefined'; });
    assert.equal(posthogStillMissing, true, 'no code path may resurrect window.posthog as a side effect');
  } finally {
    await page.close();
  }
});
