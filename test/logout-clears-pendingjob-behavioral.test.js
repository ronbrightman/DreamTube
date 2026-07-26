// test/logout-clears-pendingjob-behavioral.test.js
//
// Regression coverage for tracker.html's
// state-pendingjob-not-cleared-on-logout-s-p2ivk2: js/store.js's logout()
// cleared state.user but never state.pendingJob, the in-flight generation
// job set by adoptPendingGeneration/savePendingJob (used by both
// wizard.html's and start.html's generate-during-signup flows). Same
// recurring "local state not re-scoped per account across logout/login in
// one browser" bug class already fixed for state.dreams/charactersByUser
// (see js/store.js's getMyDreams() comment) — this is a new instance of it
// for a piece of state not previously noticed.
//
// Concrete risk this closes: account A starts a generation, logs out
// before it resolves, and account B signs up in the same browser before
// A's job clears — B's signup-success handler could observe or overwrite
// a stale pendingJob tied to A. This test reproduces that exact scenario:
// account A has a pendingJob set, logs out, account B signs up in the same
// browser, and asserts B never sees A's stale pendingJob.
//
// Follows test/wizard-ui-behavioral.test.js's conventions exactly: a plain
// static file server (no real Netlify Functions runtime), blockThirdParty()
// for this sandbox's flaky outbound network to fonts/PostHog/Pixel, and
// safeGoto() to tolerate a transient nav failure. DreamStore.signup() is
// left UNMOCKED deliberately — an unmocked POST to register-account.js
// 404s against the static file server, and js/store.js's signup() already
// degrades that to a local-only signup (see that function's own doc
// comment), exactly like every other browser test in this repo that
// exercises signup.

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

test('js/store.js: logout() clears state.pendingJob -- account B never sees account A\'s stale in-flight generation job after A logs out and B signs up in the same browser', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    // Land on any page that loads js/store.js so window.DreamStore exists.
    await safeGoto(page, baseUrl + '/login.html');

    // Seed localStorage as if account A is logged in with a real in-flight
    // pendingJob (operationName must be "fal:"- or "mock:"-prefixed or
    // migrateLegacyState() strips it as a stale pre-fal.ai leftover on next
    // load -- see js/store.js's own comment on that migration).
    await page.evaluate(function () {
      var state = {
        user: { handle: '@accounta', username: 'accounta' },
        accounts: { accounta: { password: 'accountapassword1', email: 'accounta@example.com' } },
        draft: { caption: '', style: null, sourceDreamId: null, restore: false, characterIds: [], cameraView: null, sceneryTime: null, sceneryPlace: null, mediaType: null, sourceImageUrl: null },
        dreams: [],
        pendingJob: {
          operationName: 'fal:veo-3.1-fast:req-account-a',
          startedAt: Date.now(),
          caption: 'account A\'s in-flight dream',
          style: 'Cinematic',
          sourceDreamId: null,
          mediaType: 'video',
          notify: false
        },
        charactersByUser: {},
        likedIds: {}
      };
      localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    });

    // Reload so js/store.js's IIFE reads the seeded state above (it's only
    // loaded from localStorage once, at page load).
    await safeGoto(page, baseUrl + '/login.html');

    var pendingJobBeforeLogout = await page.evaluate(function () { return window.DreamStore.getPendingJob(); });
    assert.ok(pendingJobBeforeLogout, 'sanity check: pendingJob should be seeded before logout');
    assert.equal(pendingJobBeforeLogout.operationName, 'fal:veo-3.1-fast:req-account-a');

    // Account A logs out.
    await page.evaluate(function () { window.DreamStore.logout(); });

    var pendingJobAfterLogout = await page.evaluate(function () { return window.DreamStore.getPendingJob(); });
    assert.equal(pendingJobAfterLogout, null, 'logout() must clear pendingJob, not just state.user');

    var persistedAfterLogout = await page.evaluate(function () {
      return JSON.parse(localStorage.getItem('dreamtube_state_v1')).pendingJob;
    });
    assert.equal(persistedAfterLogout, null, 'the cleared pendingJob must actually be persisted to localStorage, not just in-memory');

    // Account B signs up in the same browser, before A's job would have
    // resolved. register-account.js 404s against the static file server,
    // so this exercises signup()'s documented local-only fallback path --
    // same as every other browser test in this repo that calls signup().
    var signupResult = await page.evaluate(function () {
      return window.DreamStore.signup('accountb', 'accountbpassword1', 'accountb@example.com');
    });
    assert.equal(signupResult.ok, true, 'account B signup should succeed');

    var pendingJobForAccountB = await page.evaluate(function () { return window.DreamStore.getPendingJob(); });
    assert.equal(pendingJobForAccountB, null, 'account B must never see account A\'s stale pendingJob after signing up in the same browser');

    // Sanity check: confirm this really is account B now signed in (not,
    // say, a no-op signup call that left A's session intact).
    var currentUser = await page.evaluate(function () { return window.DreamStore.getCurrentUser(); });
    assert.equal(currentUser.username, 'accountb');
  } finally {
    await page.close();
  }
});
