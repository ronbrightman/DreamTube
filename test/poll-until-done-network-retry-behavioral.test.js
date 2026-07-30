// test/poll-until-done-network-retry-behavioral.test.js
//
// Regression coverage for tracker item
// startgeneration-clears-pendingjob-on-any-s7wr0b: js/store.js's
// pollUntilDone rejected immediately (E302) on the very FIRST
// network/fetch-level failure while polling video-status.js/
// image-status.js -- no retry at all, unlike the ordinary "not done yet"
// path which already retries via setTimeout(poll, POLL_INTERVAL_MS).
// startGeneration's outer .catch then unconditionally clearPendingJob()'d,
// so a single dropped poll request (a momentary connectivity blip, not a
// real generation failure or a genuine sustained outage) orphaned a real,
// still-in-flight job and forced the next attempt into a completely FRESH
// submission -- a double token/fal.ai charge for what was really one
// generation.
//
// Fix: pollUntilDone now tracks CONSECUTIVE network-level failures with a
// per-call counter, reset on any real response, and only actually rejects
// with E302 (letting the outer clearPendingJob run) once that counter
// exceeds MAX_NETWORK_RETRIES. A single miss retries exactly like the
// ordinary not-done-yet path; only a sustained run of failures past the
// threshold gives up.
//
// Follows test/auto-refund-behavioral.test.js's conventions exactly: a
// plain static file server, page.route() standing in for
// video-status.js, blockThirdParty() for this sandbox's flaky outbound
// network, and safeGoto() to tolerate a transient nav failure. A
// pendingJob is seeded directly into localStorage so processing.html's
// runGeneration() takes the RESUME path straight into pollUntilDone.
//
// Timing note: js/store.js's own POLL_INTERVAL_MS (10s) is the real
// retry delay reused for the network-failure-retry path too (deliberately
// unchanged by the fix -- see js/store.js's own doc comment on
// pollUntilDone) -- these tests wait out real 10s intervals rather than
// faking timers, so they run slower than most of this repo's other
// behavioral tests. That's an inherent cost of testing the real retry
// delay end to end, not a flake.

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

/** Same shape as auto-refund-behavioral.test.js's own seedLoggedInWithPendingJob. */
async function seedLoggedInWithPendingJob(page, username, password, email) {
  await page.evaluate(function (args) {
    var handle = '@' + args.username;
    var pendingJob = {
      operationName: 'fal:fal-ai/veo3.1/fast:req-' + args.username,
      startedAt: Date.now(),
      caption: args.username + '\'s in-flight dream',
      style: 'Cinematic',
      sourceDreamId: null,
      mediaType: 'video',
      ownerHandle: handle,
      notify: false
    };
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
  }, { username: username, password: password, email: email });

  await safeGoto(page, baseUrl + '/login.html');
}

test('js/store.js pollUntilDone: one transient network failure mid-poll is retried, NOT treated as a genuine failure -- the pendingJob survives it and the SAME job still resolves successfully with no duplicate submission', { timeout: 30000 }, async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await safeGoto(page, baseUrl + '/login.html');
    await seedLoggedInWithPendingJob(page, 'transientmiss', 'transientmisspassword1', 'transientmiss@example.com');

    var statusCallCount = 0;
    await page.route('**/.netlify/functions/video-status*', function (route) {
      statusCallCount += 1;
      if (statusCallCount === 1) {
        // Simulate one dropped/transient fetch -- a network-level failure,
        // not a real server response of any kind.
        route.abort('failed');
        return;
      }
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, videoUrl: 'https://example.com/fake-video.mp4' }) });
    });

    var generateVideoCallCount = 0;
    await page.route('**/.netlify/functions/generate-video', function (route) {
      generateVideoCallCount += 1;
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'fal:fal-ai/veo3.1/fast:req-should-never-be-submitted' }) });
    });

    await safeGoto(page, baseUrl + '/processing.html');

    // Give the first (aborted) poll attempt time to actually reject and run
    // its .catch handler, then confirm the job was NOT wiped by that one
    // miss -- this is the core of the fix: a transient failure must not
    // look like a genuine give-up.
    await page.waitForTimeout(1500);
    assert.ok(statusCallCount >= 1, 'sanity check: the first (aborted) poll attempt should have already fired');
    var pendingJobAfterOneMiss = await page.evaluate(function () { return window.DreamStore.getPendingJob(); });
    assert.ok(pendingJobAfterOneMiss, 'a single transient network failure must not clear the in-flight pendingJob');
    assert.equal(pendingJobAfterOneMiss.operationName, 'fal:fal-ai/veo3.1/fast:req-transientmiss');

    // The retry (same POLL_INTERVAL_MS delay as the ordinary not-done-yet
    // path) should land on the SAME operationName and eventually resolve,
    // redirecting to result.html -- proving this was one continuous
    // generation, not a fresh resubmission.
    await page.waitForURL('**/result.html?id=*', { timeout: 20000 });

    assert.equal(generateVideoCallCount, 0, 'a transient poll failure must never trigger a fresh generate-video submission -- the original in-flight job must be resumed, not resubmitted');
    assert.ok(statusCallCount >= 2, 'the poll must have retried past the first transient failure to reach the eventual done:true response');
  } finally {
    await page.close();
  }
});

test('js/store.js pollUntilDone: a SUSTAINED run of network failures past the retry threshold still eventually gives up -- rejects with E302 and clears the pendingJob (does not retry forever)', { timeout: 60000 }, async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await safeGoto(page, baseUrl + '/login.html');
    await seedLoggedInWithPendingJob(page, 'sustainedmiss', 'sustainedmisspassword1', 'sustainedmiss@example.com');

    var statusCallCount = 0;
    await page.route('**/.netlify/functions/video-status*', function (route) {
      statusCallCount += 1;
      // Every single attempt fails at the network level -- a genuine,
      // sustained outage, never a real server response.
      route.abort('failed');
    });

    await safeGoto(page, baseUrl + '/processing.html');

    // Must eventually give up (bounded retries, not infinite) -- the
    // processing.html failure screen appears and shows the E302 code.
    await page.waitForSelector('#proc-fail', { state: 'visible', timeout: 50000 });

    var failCode = await page.textContent('#proc-fail-code');
    assert.equal(failCode, 'E302', 'a sustained run of network failures must still eventually surface as E302, not hang forever');

    // And the pendingJob must actually be cleared once it genuinely gives
    // up -- this is the legitimate case where clearPendingJob() SHOULD run
    // (unlike the single-miss case in the sibling test above).
    var pendingJobAfterGiveUp = await page.evaluate(function () { return window.DreamStore.getPendingJob(); });
    assert.equal(pendingJobAfterGiveUp, null, 'a genuine sustained failure must still clear the pendingJob once retries are exhausted');

    // More than one attempt must have happened (proves it retried at
    // least once) but it must not be unbounded -- a handful of attempts at
    // most, not hundreds.
    assert.ok(statusCallCount > 1, 'must have retried at least once before giving up');
    assert.ok(statusCallCount <= 10, 'must not retry an unbounded number of times for a sustained failure -- got ' + statusCallCount + ' attempts');
  } finally {
    await page.close();
  }
});
