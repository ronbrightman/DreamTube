// test/store-signup-call-sequence-guard-behavioral.test.js
//
// Regression coverage for tracker item
// dreamstore-signup-commits-state-user-unc-vv6rio: js/store.js's
// signup() called commitLocalSignup(username, password, email)
// unconditionally whenever register-account.js responded (success,
// explicit-shape-but-unexpected, OR network failure -- see the .catch()
// and "unexpected shape" fallback branches, both of which also called
// commitLocalSignup). commitLocalSignup() unconditionally wrote
// state.user = {...}; persist(); identifyForAnalytics(username) --
// BEFORE the Promise it returns ever resolves back to the caller.
//
// wizard.html and start.html each already gate their OWN callback body
// against a stale/abandoned signup attempt's late settlement with a
// per-attempt signupAttemptToken (see funnel-signup-navigation-token-
// guard-behavioral.test.js for that fix's own coverage) -- but that
// guard lives entirely in the CALLER, one layer above
// DreamStore.signup() itself. Since commitLocalSignup's state.user
// write happens INSIDE signup(), before any caller callback (and thus
// before the caller's own token check) ever runs, no caller-side guard
// could prevent it: two concurrent DreamStore.signup() calls (reachable
// via any caller with no such UI-level token at all -- see login.html,
// claim-dream.html -- not just via a devtools bypass of wizard.html's/
// start.html's disabled buttons) would let whichever one's network
// response happened to land LAST silently overwrite state.user set by
// whichever landed first, even when the first one was actually the
// attempt that should still be current.
//
// Fix (js/store.js): a module-level signupCallSeq counter. Every
// signup() call that reaches the network captures the NEXT value of
// this counter, right before firing the request, as its own sequence
// number. By the time its response lands, it only commits
// (state.accounts / state.user / identifyForAnalytics, via
// commitLocalSignupIfCurrent) if it is STILL the most-recently-STARTED
// signup() call -- i.e. no newer signup() call has begun in the
// meantime. A superseded call resolves with
// { ok:false, superseded:true, error } instead, touching no state at
// all. This makes DreamStore.signup() inherently safe for ANY caller,
// not just wizard.html/start.html. Both of those files were also wired
// to pass result.superseded through their own attemptSignup() cb as an
// extra defense-in-depth bail condition alongside their existing
// signupAttemptToken check (see either file's attemptSignup/renderSignup
// comments).
//
// This file exercises DreamStore.signup() directly (window.DreamStore,
// no wizard.html/start.html funnel UI involved at all) -- the most
// direct proof that the fix lives at the store layer, not just gated
// behind either funnel's own UI-level token.
//
// Follows test/logout-clears-pendingjob-behavioral.test.js's conventions:
// a plain static file server (no real Netlify Functions runtime),
// blockThirdParty() for this sandbox's flaky outbound network,
// safeGoto() to tolerate a transient nav failure, and login.html loaded
// purely as a vehicle for js/store.js (any page that includes it would
// do) since DreamStore only exists once attached to a real `window`.
// register-account.js IS mocked here (unlike that file), via
// page.route(), specifically so response timing/ordering can be
// controlled precisely enough to prove call-order (not resolve-order)
// is what decides the winner.

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

test('js/store.js: two concurrent DreamStore.signup() calls -- the LATER-STARTED one must win state.user even when its response lands FIRST, and the earlier-started, later-resolving one must be discarded as superseded, not silently overwrite it', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    // Attempt A is the one a real user would have already abandoned (e.g.
    // via Back-then-resubmit at the UI layer) -- held back well past the
    // point Attempt B (the genuinely current one) has already resolved
    // and committed. This is the exact ordering the original bug got
    // wrong: commitLocalSignup ran for whichever settled LAST, which used
    // to be A here, clobbering B's already-current state.user.
    await page.route('**/.netlify/functions/register-account', async function (route) {
      var body = JSON.parse(route.request().postData());
      if (body.username === 'raceusera') {
        await new Promise(function (r) { setTimeout(r, 400); });
      }
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await safeGoto(page, baseUrl + '/login.html');

    var results = await page.evaluate(function () {
      // Fired back-to-back in the same synchronous tick, exactly like two
      // genuinely concurrent callers would (e.g. an abandoned wizard.html
      // attempt still in flight when a fresh one fires) -- this is what
      // guarantees A captures a LOWER signupCallSeq than B even though
      // A's network response is the one artificially delayed above.
      var pA = window.DreamStore.signup('raceusera', 'racea-password1', 'racea@example.com');
      var pB = window.DreamStore.signup('raceuserb', 'raceb-password1', 'raceb@example.com');
      return Promise.all([pA, pB]).then(function (r) {
        return {
          a: r[0],
          b: r[1],
          currentUser: window.DreamStore.getCurrentUser(),
          accounts: JSON.parse(localStorage.getItem('dreamtube_state_v1')).accounts
        };
      });
    });

    // B (the later-started call) must have committed normally.
    assert.equal(results.b.ok, true, 'the later-started call (B) must succeed normally');
    assert.equal(results.b.user.username, 'raceuserb');

    // A (the earlier-started, later-resolving call) must be discarded as
    // superseded -- NOT silently committed just because its response
    // happened to land after B's.
    assert.equal(results.a.ok, false, 'the earlier-started, later-resolving call (A) must NOT report ok:true');
    assert.equal(results.a.superseded, true, 'A must be flagged superseded -- js/store.js\'s own call-sequence guard, not just a caller-side token');

    // The single source of truth (state.user) must reflect B, the call
    // that should actually be current -- never silently overwritten by
    // A's late, abandoned settlement. This is the core assertion: on the
    // pre-fix code, this would equal 'raceusera' instead, since A settled
    // last and commitLocalSignup ran unconditionally.
    assert.ok(results.currentUser, 'someone must be signed in after both calls settle');
    assert.equal(results.currentUser.username, 'raceuserb', 'state.user must reflect B (the later-started, current attempt), not A (the earlier-started, abandoned one that merely resolved later)');

    // A's superseded commit must have touched NO local state at all --
    // not even an accounts-cache entry for raceusera. (The real account
    // it registered server-side, if any, is picked up later by a normal
    // login() for that username on the device that actually wants it --
    // see login()'s own materialization path.)
    assert.equal(results.accounts.raceusera, undefined, 'a superseded signup call must not write ANY local state, including state.accounts');
    assert.ok(results.accounts.raceuserb, 'B\'s account must be the one actually committed locally');
  } finally {
    await page.close();
  }
});
