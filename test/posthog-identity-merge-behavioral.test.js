// test/posthog-identity-merge-behavioral.test.js
//
// Regression coverage for tracker item
// for-product-data-bug-posthog-identity-br-vytqwy: PostHog identity was
// being split across TWO separate persons for a single real user. Root
// cause: this app calls posthog.identify() TWICE per visitor --
//   1. Once pre-signup, for the marketing-funnel cross-domain handoff (a
//      distinct_id URL param start.html used to hand straight to
//      posthog.identify() -- see js/store.js's linkPreSignupIdentity).
//   2. Again post-signup/login, with the real username
//      (identifyForAnalytics in js/store.js, called from
//      commitLocalSignup/attemptLocalLogin/etc.).
// PostHog only auto-merges a browser's FIRST-EVER identify() call (from
// its default anonymous distinct_id). A SECOND identify() call to a
// different distinct_id does NOT auto-merge -- it silently starts a
// brand-new, disconnected person, orphaning every pre-signup funnel event
// under the first identify's distinct_id. This is exactly what a real
// signup (sabrina21498) showed: her PostHog person history started at
// 'signed_up', with her whole pre-signup funnel sitting on a separate
// person.
//
// Fix (js/store.js): a localStorage marker (PRE_ACCOUNT_DISTINCT_ID_KEY)
// records the pre-signup distinct_id the moment linkPreSignupIdentity
// runs. identifyForAnalytics reads it back -- whenever and wherever the
// real identify() eventually happens, including a completely different
// page load -- and calls posthog.alias(newDistinctId, previousDistinctId)
// (new id first, already-identified id second -- see posthog-js's own
// alias() docs/typings; reversed, this would silently merge in the wrong
// direction) BEFORE calling identify() a second time, so the two
// distinct_ids merge into one PostHog person. The marker is consumed
// (removed) the moment it's read, so it can never mistakenly get aliased
// against a later, unrelated identify() call.
//
// Covers both signup entry points named in the tracker item:
//   - start.html: calls DreamStore.linkPreSignupIdentity() itself (the
//     cross-domain funnel handoff), then later completes a signup on the
//     SAME page load.
//   - wizard.html: has no pre-signup identify() call of its OWN, but a
//     visitor could still arrive with a pre-account marker already set by
//     an earlier, abandoned start.html visit on the same browser (the
//     marker is deliberately persisted to localStorage, not just an
//     in-memory flag, for exactly this reason) -- proven here by seeding
//     the marker directly via DreamStore.linkPreSignupIdentity before
//     signing up on wizard.html, showing the fix is structural (lives in
//     the shared js/store.js identify seam), not tied to either page's own
//     inline script.
// Also proves the negative: an ordinary organic signup with NO prior
// identify() at all must fire exactly one identify() call and ZERO
// alias() calls -- this fix must never fire a spurious merge for the
// common case that was never broken.
//
// Follows test/store-signup-call-sequence-guard-behavioral.test.js's and
// test/funnel-distinct-id-behavioral.test.js's conventions: a plain
// static file server (no real Netlify Functions runtime), register-account
// mocked via page.route() for deterministic signups, blockThirdParty() for
// this sandbox's flaky outbound network, safeGoto() to tolerate a
// transient nav failure, and reading PostHog calls straight out of the
// stub's own pending-call queue (window.posthog stays the pre-init stub
// array the whole test, since blockThirdParty aborts the real array.js
// bundle load).

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

var BASE_RESUME_PARAMS = 'resume=1&recall=vividly&types=flying&motivations=' + encodeURIComponent('Turn them into videos') + '&style=Cartoon&caption=' + encodeURIComponent('Flying over the ocean');

var PRE_ACCOUNT_KEY = 'dreamtube_ph_pre_account_distinct_id';

test('start.html + signup: pre-signup funnel handoff identify, then a completed signup, merge into ONE PostHog person via alias() -- not two separate identify()s', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  await mockSignupSucceeds(page);
  try {
    await safeGoto(page, baseUrl + '/start.html?' + BASE_RESUME_PARAMS + '&distinct_id=ph-anon-uuid-1');

    // Sanity: the pre-signup handoff identify already fired, exactly as
    // test/funnel-distinct-id-behavioral.test.js proves in isolation.
    var beforeSignup = await readPostHogCalls(page);
    var preIdentify = callsNamed(beforeSignup, 'identify');
    assert.equal(preIdentify.length, 1, 'expected exactly one identify() call before signup');
    assert.equal(preIdentify[0][1], 'ph-anon-uuid-1');

    // The marker linkPreSignupIdentity records must be set, so a signup
    // completed later (even on a different page load) can still find it.
    var markerBeforeSignup = await page.evaluate(function (key) { return localStorage.getItem(key); }, PRE_ACCOUNT_KEY);
    assert.equal(markerBeforeSignup, 'ph-anon-uuid-1');

    var result = await page.evaluate(function () {
      return window.DreamStore.signup('mergeduser1', 'password123', 'mergeduser1@example.com');
    });
    assert.equal(result.ok, true, 'signup itself must still succeed normally');

    var afterSignup = await readPostHogCalls(page);
    var identifies = callsNamed(afterSignup, 'identify');
    var aliases = callsNamed(afterSignup, 'alias');

    assert.equal(identifies.length, 2, 'expected exactly two identify() calls total: the pre-signup handoff, then the post-signup username');
    assert.equal(identifies[0][1], 'ph-anon-uuid-1', 'first identify() must still be the funnel handoff id');
    assert.equal(identifies[1][1], 'mergeduser1', 'second identify() must be the real username');

    assert.equal(aliases.length, 1, 'expected exactly one alias() call to merge the two identities');
    assert.deepEqual(aliases[0].slice(1), ['mergeduser1', 'ph-anon-uuid-1'], 'alias() must be called as alias(new_id, already_identified_id) -- new username first, the already-identified funnel distinct_id second');

    // The alias() call must happen BEFORE the second identify() -- it has
    // to run while the browser is still "identified as" the old id for
    // PostHog to have any already-identified distinct_id to merge from.
    var aliasIndex = afterSignup.indexOf(aliases[0]);
    var secondIdentifyIndex = afterSignup.indexOf(identifies[1]);
    assert.ok(aliasIndex < secondIdentifyIndex, 'alias() must fire before the post-signup identify() call, not after');

    // The marker must be consumed so a later, unrelated identify() call
    // (e.g. a different account logging in on a shared/reused browser)
    // can never mistakenly alias against this stale value.
    var markerAfterSignup = await page.evaluate(function (key) { return localStorage.getItem(key); }, PRE_ACCOUNT_KEY);
    assert.equal(markerAfterSignup, null, 'the pre-account marker must be removed once consumed');
  } finally {
    await page.close();
  }
});

test('wizard.html + signup: a pre-account marker set by an EARLIER page load (e.g. an abandoned start.html visit) still gets merged via alias() on a completely different page -- the fix is not tied to either page\'s own inline script', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  await mockSignupSucceeds(page);
  try {
    await safeGoto(page, baseUrl + '/wizard.html');

    // wizard.html itself never calls identify() pre-signup -- simulate an
    // EARLIER, separate page load (e.g. start.html, on a previous visit to
    // this same browser) having already done so, by calling the exact same
    // public entry point start.html itself calls.
    await page.evaluate(function () {
      window.DreamStore.linkPreSignupIdentity('ph-anon-uuid-2');
    });

    var beforeSignup = await readPostHogCalls(page);
    assert.equal(callsNamed(beforeSignup, 'identify').length, 1, 'linkPreSignupIdentity must itself call identify() once');

    var result = await page.evaluate(function () {
      return window.DreamStore.signup('mergeduser2', 'password123', 'mergeduser2@example.com');
    });
    assert.equal(result.ok, true);

    var afterSignup = await readPostHogCalls(page);
    var identifies = callsNamed(afterSignup, 'identify');
    var aliases = callsNamed(afterSignup, 'alias');

    assert.equal(identifies.length, 2);
    assert.equal(identifies[1][1], 'mergeduser2');
    assert.equal(aliases.length, 1, 'wizard.html\'s signup path must merge identities exactly like start.html\'s does');
    assert.deepEqual(aliases[0].slice(1), ['mergeduser2', 'ph-anon-uuid-2']);
  } finally {
    await page.close();
  }
});

test('wizard.html + signup: an ordinary organic signup with NO prior identify() at all fires exactly one identify() and ZERO alias() calls -- never a spurious merge', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  await mockSignupSucceeds(page);
  try {
    await safeGoto(page, baseUrl + '/wizard.html');

    var markerBeforeSignup = await page.evaluate(function (key) { return localStorage.getItem(key); }, PRE_ACCOUNT_KEY);
    assert.equal(markerBeforeSignup, null, 'a fresh browser must have no pre-account marker at all');

    var result = await page.evaluate(function () {
      return window.DreamStore.signup('organicuser', 'password123', 'organicuser@example.com');
    });
    assert.equal(result.ok, true);

    var calls = await readPostHogCalls(page);
    var identifies = callsNamed(calls, 'identify');
    var aliases = callsNamed(calls, 'alias');

    assert.equal(identifies.length, 1, 'an organic signup must call identify() exactly once');
    assert.equal(identifies[0][1], 'organicuser');
    assert.equal(aliases.length, 0, 'an organic signup must never call alias() -- there is nothing to merge');
  } finally {
    await page.close();
  }
});
