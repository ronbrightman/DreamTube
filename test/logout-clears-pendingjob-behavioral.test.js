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
// FIRST FIX (round 1, reverted): unconditionally cleared state.pendingJob
// in logout(). Closed the cross-account leak but review (round 2) caught a
// real regression it introduced: a logged-in user with no lock preventing
// logout mid-generation (profile.html's logout link) who logs out and back
// into the SAME account mid-flight would find their pendingJob gone —
// silently wasting an already-spent generation (tokens are spent at
// submission time, see generate-video.js's E112 doc block) with no error
// surfaced, since home.html/explore.html's resume machinery had nothing
// left to resume.
//
// FINAL FIX (round 2, this file): logout() no longer touches
// state.pendingJob at all. Instead savePendingJob tags every pendingJob
// with an ownerHandle at write time (both write sites -- startGeneration
// and adoptPendingGeneration -- always run with state.user already set,
// verified directly at both call sites in wizard.html/start.html), and
// every read (getPendingJob/resumePendingJob/requestNotifyOnReady) is
// scoped through scopedPendingJob() to only return/act on a job whose
// ownerHandle matches whoever is CURRENTLY logged in -- same filter shape
// as getMyDreams()'s `d.ownerHandle === myHandle`. This closes the
// cross-account leak (a different account can never observe or resume
// another account's job) while preserving the same-account resume case
// (logging back into the SAME account mid-generation still sees and can
// resume its own job).
//
// ROUND 3 FIX (this file, latest): round 2's scopedPendingJob() treats a
// pendingJob with no ownerHandle as belonging to no one -- correct for a
// legitimately-ownerless pre-signup adopted job, but review caught that it
// also silently orphans every REAL, already-in-flight job that existed in
// a user's localStorage from before this branch shipped, since those were
// written by the OLD savePendingJob, which never set ownerHandle at all.
// Without a fix, every such user hits the exact same "paid-for job
// silently vanishes with zero error" failure mode round 1 was rejected
// for -- just triggered by deploy timing instead of a logout action, and
// needing zero user action (not even a page reload beyond the next
// natural one) to hit. processing.html's `location.href = 'create.html'`
// fallback when getPendingJob() is null means affected users get silently
// bounced with no explanation. Fixed by backfilling ownerHandle onto a
// pre-existing, owner-less pendingJob inside migrateLegacyState() the
// moment it's loaded, whenever s.user is set (a pre-signup adopted job
// with no account yet legitimately has no owner and is left alone).
//
// This file covers all three scenarios end to end:
//   1. Cross-account: account A has a pendingJob, logs out, account B
//      signs up in the same browser -- B must never see or be able to
//      resume A's stale pendingJob.
//   2. Same-account: account A has a pendingJob, logs out, then logs back
//      into the SAME account -- the pendingJob must still be there and
//      resumable (not silently discarded).
//   3. Legacy/pre-branch-deploy: a pendingJob with NO ownerHandle at all
//      (the exact shape the old, pre-fix savePendingJob produced) for a
//      user who is still logged into the same account they submitted it
//      under (never logged out) -- the migration must backfill its
//      ownerHandle on load so the rightful owner can still resume it.
//
// Follows test/wizard-ui-behavioral.test.js's conventions exactly: a plain
// static file server (no real Netlify Functions runtime), blockThirdParty()
// for this sandbox's flaky outbound network to fonts/PostHog/Pixel, and
// safeGoto() to tolerate a transient nav failure. DreamStore.signup()/
// DreamStore.login() are left UNMOCKED deliberately -- an unmocked POST to
// register-account.js/account-login.js 404s against the static file
// server, and js/store.js's signup()/login() already degrade that to their
// documented local-only fallback paths (commitLocalSignup/
// attemptLocalLogin), exactly like every other browser test in this repo
// that exercises signup/login.

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

/**
 * Seeds localStorage as if `username` is logged in with a real in-flight
 * pendingJob -- operationName must be "fal:"- or "mock:"-prefixed or
 * migrateLegacyState() strips it as a stale pre-fal.ai leftover on next
 * load, see js/store.js's own comment on that migration. `password`/
 * `email` are also seeded into `accounts` so a later DreamStore.login()
 * for the SAME account can succeed via the documented local fallback
 * (attemptLocalLogin) against the static test server, which has no real
 * account-login.js to answer it.
 *
 * By default the seeded job already carries its ownerHandle (matching
 * what the current savePendingJob would have written for a real user on
 * this branch). Pass `omitOwnerHandle: true` to instead seed the exact
 * shape the OLD, pre-fix savePendingJob produced -- no ownerHandle field
 * at all -- simulating a real user's browser at the moment this branch
 * first deploys, still logged into the same account they submitted the
 * job under.
 */
async function seedLoggedInWithPendingJob(page, username, password, email, opts) {
  opts = opts || {};
  await page.evaluate(function (args) {
    var handle = '@' + args.username;
    var pendingJob = {
      operationName: 'fal:veo-3.1-fast:req-' + args.username,
      startedAt: Date.now(),
      caption: args.username + '\'s in-flight dream',
      style: 'Cinematic',
      sourceDreamId: null,
      mediaType: 'video',
      notify: false
    };
    if (!args.omitOwnerHandle) pendingJob.ownerHandle = handle;
    var state = {
      user: { handle: handle, username: args.username },
      accounts: {},
      draft: { caption: '', style: null, sourceDreamId: null, restore: false, characterIds: [], cameraView: null, sceneryTime: null, sceneryPlace: null, mediaType: null, sourceImageUrl: null },
      dreams: [],
      pendingJob: pendingJob,
      charactersByUser: {},
      likedIds: {}
    };
    state.accounts[args.username] = { password: args.password, email: args.email };
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, { username: username, password: password, email: email, omitOwnerHandle: !!opts.omitOwnerHandle });

  // Reload so js/store.js's IIFE reads the seeded state above (it's only
  // loaded from localStorage once, at page load) -- this is also the exact
  // moment migrateLegacyState()'s ownerHandle backfill (round 3) would run
  // for a real user's browser on this branch's first deploy.
  await safeGoto(page, baseUrl + '/login.html');
}

test('js/store.js: cross-account -- account B never sees or can resume account A\'s stale pendingJob after A logs out and B signs up in the same browser', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await safeGoto(page, baseUrl + '/login.html');
    await seedLoggedInWithPendingJob(page, 'accounta', 'accountapassword1', 'accounta@example.com');

    var pendingJobBeforeLogout = await page.evaluate(function () { return window.DreamStore.getPendingJob(); });
    assert.ok(pendingJobBeforeLogout, 'sanity check: pendingJob should be seeded and visible to account A before logout');
    assert.equal(pendingJobBeforeLogout.operationName, 'fal:veo-3.1-fast:req-accounta');

    // Account A logs out.
    await page.evaluate(function () { window.DreamStore.logout(); });

    var pendingJobAfterLogout = await page.evaluate(function () { return window.DreamStore.getPendingJob(); });
    assert.equal(pendingJobAfterLogout, null, 'no one is logged in right after logout, so getPendingJob() must read as absent');

    // logout() itself must NOT have wiped the job out of storage -- the
    // same-account resume case (covered in the next test) depends on it
    // still being there, tagged to account A, for whenever A logs back in.
    var persistedAfterLogout = await page.evaluate(function () {
      return JSON.parse(localStorage.getItem('dreamtube_state_v1')).pendingJob;
    });
    assert.ok(persistedAfterLogout, 'logout() must NOT delete the pendingJob from storage -- only scope who can see it');
    assert.equal(persistedAfterLogout.ownerHandle, '@accounta');

    // Account B signs up in the same browser, before A's job would have
    // resolved. register-account.js 404s against the static file server,
    // so this exercises signup()'s documented local-only fallback path --
    // same as every other browser test in this repo that calls signup().
    var signupResult = await page.evaluate(function () {
      return window.DreamStore.signup('accountb', 'accountbpassword1', 'accountb@example.com');
    });
    assert.equal(signupResult.ok, true, 'account B signup should succeed');

    var currentUser = await page.evaluate(function () { return window.DreamStore.getCurrentUser(); });
    assert.equal(currentUser.username, 'accountb', 'sanity check: account B is really the one signed in now');

    var pendingJobForAccountB = await page.evaluate(function () { return window.DreamStore.getPendingJob(); });
    assert.equal(pendingJobForAccountB, null, 'account B must never see account A\'s stale pendingJob after signing up in the same browser');

    // Nor can B resume it (the read-scoping must hold for resumePendingJob
    // too, not just the getPendingJob() accessor).
    var resumeRejected = await page.evaluate(function () {
      return window.DreamStore.resumePendingJob().then(
        function () { return { rejected: false }; },
        function (err) { return { rejected: true, message: err && err.message }; }
      );
    });
    assert.equal(resumeRejected.rejected, true, 'resumePendingJob() must reject for account B -- there is nothing that belongs to them to resume');
  } finally {
    await page.close();
  }
});

test('js/store.js: same-account -- a user who logs out mid-generation and logs back into the SAME account still sees and can resume their own pendingJob', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await safeGoto(page, baseUrl + '/login.html');
    await seedLoggedInWithPendingJob(page, 'accounta', 'accountapassword1', 'accounta@example.com');

    var pendingJobBeforeLogout = await page.evaluate(function () { return window.DreamStore.getPendingJob(); });
    assert.ok(pendingJobBeforeLogout, 'sanity check: pendingJob should be seeded and visible before logout');

    // Logs out mid-generation (e.g. tapping profile.html's logout link with
    // no lock preventing it while a job is in flight).
    await page.evaluate(function () { window.DreamStore.logout(); });
    assert.equal(await page.evaluate(function () { return window.DreamStore.getPendingJob(); }), null, 'nobody logged in right after logout -- getPendingJob() reads as absent, not deleted');

    // Logs back into the SAME account. account-login.js 404s against the
    // static file server, so this exercises login()'s documented
    // local-only fallback (attemptLocalLogin) against the accounts entry
    // seeded above -- same as every other browser test in this repo that
    // calls login() against the static server.
    var loginResult = await page.evaluate(function () {
      return window.DreamStore.login('accounta', 'accountapassword1');
    });
    assert.equal(loginResult.ok, true, 'account A should be able to log back in with its own credentials');

    var pendingJobAfterRelogin = await page.evaluate(function () { return window.DreamStore.getPendingJob(); });
    assert.ok(pendingJobAfterRelogin, 'account A must still see its own pendingJob after logging back in -- a real, already-paid-for generation must not silently vanish');
    assert.equal(pendingJobAfterRelogin.operationName, 'fal:veo-3.1-fast:req-accounta');
    assert.equal(pendingJobAfterRelogin.caption, 'accounta\'s in-flight dream');

    // requestNotifyOnReady must also act on it post-relogin (not just
    // getPendingJob()).
    await page.evaluate(function () { window.DreamStore.requestNotifyOnReady(); });
    var notifyFlag = await page.evaluate(function () { return window.DreamStore.getPendingJob().notify; });
    assert.equal(notifyFlag, true, 'requestNotifyOnReady() must be able to mark the resumed job for account A');
  } finally {
    await page.close();
  }
});

test('js/store.js: legacy/pre-branch-deploy -- a pendingJob with no ownerHandle at all (the OLD savePendingJob\'s shape) is backfilled on load so its rightful, still-logged-in owner can still resume it', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await safeGoto(page, baseUrl + '/login.html');
    // Simulates exactly what a real user's browser looked like the moment
    // this branch first deploys: still logged into the account that
    // submitted the generation, never logged out, but the job in storage
    // predates ownerHandle entirely (written by the pre-fix savePendingJob).
    // seedLoggedInWithPendingJob's own internal seed step writes the raw
    // pendingJob with NO ownerHandle at all (omitOwnerHandle: true -- see
    // that helper's own code just above), matching the old pre-fix
    // savePendingJob's exact shape, THEN reloads -- which is the exact
    // point migrateLegacyState()'s backfill must run.
    await seedLoggedInWithPendingJob(page, 'accounta', 'accountapassword1', 'accounta@example.com', { omitOwnerHandle: true });
    var pendingJob = await page.evaluate(function () { return window.DreamStore.getPendingJob(); });
    assert.ok(pendingJob, 'the rightful, still-logged-in owner must still see their own pendingJob after the migration backfill -- this must NOT read as absent just because it predates ownerHandle');
    assert.equal(pendingJob.operationName, 'fal:veo-3.1-fast:req-accounta');

    // The backfill must actually persist ownerHandle to storage too, not
    // just patch the in-memory copy for this one read -- otherwise the
    // very next load (no code path re-runs the migration on an object that
    // already looks migrated once `changed` isn't tripped again) would be
    // back to square one for a job that still hasn't resolved yet.
    var rawPendingJobAfterLoad = await page.evaluate(function () {
      return JSON.parse(localStorage.getItem('dreamtube_state_v1')).pendingJob;
    });
    assert.equal(rawPendingJobAfterLoad.ownerHandle, '@accounta', 'migrateLegacyState() must persist the backfilled ownerHandle, not just patch it in memory for one read');

    // And it must actually be resumable, not just visible to getPendingJob().
    var resumeAttempted = await page.evaluate(function () {
      return typeof window.DreamStore.resumePendingJob === 'function';
    });
    assert.ok(resumeAttempted, 'sanity check: resumePendingJob exists to attempt this with');
    // resumePendingJob() itself is not invoked here (it would kick off a
    // real poll against video-status.js, which 404s against this static
    // test server and would hang/retry) -- resumePendingJob() reads
    // through the same scopedPendingJob() helper getPendingJob() does (see
    // js/store.js), so proving getPendingJob() sees the backfilled job
    // above already proves resumePendingJob() would too.
  } finally {
    await page.close();
  }
});
