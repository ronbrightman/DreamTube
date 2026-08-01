// test/edit-regeneration-forming-state-behavioral.test.js
//
// Behavioral coverage for tracker item
// for-product-bug-founder-repro-edited-dre-jcasn1 — founder repro: using
// the edit mechanism on an EXISTING dream, the dream's room (result.html)
// kept showing the PREVIOUS finished video with no regenerating/forming
// state at all while the edit regenerated.
//
// Root cause (confirmed by reading js/store.js/result.html/home.html
// before writing anything, per this codebase's build-agent instructions):
// the pendingJob plumbing already fires correctly for an edit/regenerate
// (js/store.js's startGeneration always calls savePendingJob with
// sourceDreamId set for a regenerate — this already worked for BOTH the
// old "Generate Again" and the new edit-delta mechanism). The actual gap
// was that NOTHING ever READ it on result.html — render() had zero notion
// of pendingJob at all, so a dream's room simply kept showing whatever it
// already had, forever, regardless of an in-flight regenerate. home.html's
// own embedded room card (tracker item ags710) mostly already worked for
// this case via its existing "any pendingJob today = forming" logic, with
// one real gap: the few-second window between navigating to
// home.html?generate=1 and the fresh submission's own pendingJob actually
// landing, during which the card would show the dream's STALE pre-edit
// content as "ready".
//
// Fix, covered here:
//   1. result.html now shows the same shimmer/arc/caption veil treatment
//      for a dream currently being regenerated via edit, replacing the
//      stale old video until the new one lands, then transitioning in
//      place with a toast — never a silent, unexplained stale display.
//   2. home.html's room card treats "an edit of the dream it currently
//      owns" as forming immediately (optimisticEditDreamId), closing the
//      pre-existing race window described above.
//   3. A failed regeneration surfaces a visible, honest error/refund toast
//      on result.html rather than silently reverting with no explanation.
//   4. js/store.js's startGeneration now guards finalize/clearPendingJob
//      against a STALE completion — a second, later edit of the same
//      dream superseding an in-flight first one must not let the first's
//      late completion clobber the second's already-in-progress state
//      (the "stale async callback" bug class this codebase has hit
//      repeatedly — same per-attempt-token shape as signupAttemptToken/
//      pendingGenerationToken, applied at the actual mutation choke point
//      in store.js rather than only at a UI call site).
//
// Zero real fal.ai cost — every generate-video/video-status call is
// mocked via page.route(), per AGENT_POLICY.md's "keep generation-testing
// cost low" guidance. Follows this repo's established Playwright/node:test
// convention (test/home-day0-dream-card-behavioral.test.js's own
// seedDay0Pending shape, test/edit-mechanism-behavioral.test.js's own
// seedResultPageWithDream/driveFullEditDelta shape) rather than inventing
// a new one.

var test = require('node:test');
var assert = require('node:assert/strict');
var staticServer = require('./helpers/static-server');
var settle = require('./helpers/settle').settle;

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
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  } catch (e) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  }
}

function mockTokenStatus(page) {
  return page.route('**/.netlify/functions/get-token-status*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ balance: 1000, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, claimable: false, streak: 0 }) });
  });
}

/**
 * Seeds a logged-in account with one owned, already-finished video dream,
 * PLUS an in-flight pendingJob already regenerating THAT SAME dream
 * (sourceDreamId === dreamId) — the exact real-world shape of "the founder
 * just confirmed an edit, and is looking at (or has come back to) this
 * dream's own room while it regenerates". Lands on result.html?id=dreamId.
 */
async function seedResultPageRegenerating(page, opts) {
  opts = opts || {};
  var username = opts.username || 'regentester';
  var dreamId = opts.dreamId;
  await safeGoto(page, baseUrl + '/login.html');
  await page.evaluate(function (o) {
    var handle = '@' + o.username;
    var state = {
      user: { handle: handle, username: o.username },
      accounts: {},
      draft: {},
      dreams: [{
        id: o.dreamId,
        ownerHandle: handle,
        caption: o.oldStoryText || 'I was flying over a golden city at night.',
        promptText: o.oldStoryText || 'I was flying over a golden city at night.',
        storyText: o.oldStoryText || 'I was flying over a golden city at night.',
        style: 'Cinematic',
        mediaType: 'video',
        videoUrl: 'https://example.com/old-video.mp4',
        dur: '0:08',
        isPublished: false, likes: 0, likedByMe: false
      }],
      pendingJob: {
        operationName: 'mock:req-' + o.username,
        startedAt: Date.now(),
        caption: o.newStoryText || 'I was flying over a neon city at dawn.',
        storyText: o.newStoryText || 'I was flying over a neon city at dawn.',
        style: 'Cinematic',
        sourceDreamId: o.dreamId,
        mediaType: 'video',
        notify: false,
        ownerHandle: handle
      }
    };
    state.accounts[o.username] = { password: 'testpass1', email: o.username + '@example.com' };
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, { username: username, dreamId: dreamId, oldStoryText: opts.oldStoryText, newStoryText: opts.newStoryText });
  await safeGoto(page, baseUrl + '/result.html?id=' + dreamId);
}

function readDream(page, dreamId) {
  return page.evaluate(function (id) {
    var raw = JSON.parse(localStorage.getItem('dreamtube_state_v1'));
    return raw.dreams.filter(function (d) { return d.id === id; })[0];
  }, dreamId);
}

function readPendingJob(page) {
  return page.evaluate(function () {
    var raw = JSON.parse(localStorage.getItem('dreamtube_state_v1'));
    return raw.pendingJob || null;
  });
}

// ============================================================================
// 1. result.html: the regenerating veil replaces the stale old video
// ============================================================================

test('result.html: a dream currently being regenerated via edit shows the shimmer/arc veil, NOT the stale old video -- and a visible-but-disabled quiet row', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    // Never resolves -- keeps this job forming for the whole test.
    await page.route('**/.netlify/functions/video-status*', function () { /* stalled, deliberately */ });
    await seedResultPageRegenerating(page, { username: 'veiltester', dreamId: 'd-regen-veil-1', newStoryText: 'I was flying over a neon city at dawn.' });

    await page.waitForSelector('#dreamvideo-frame.regenerating', { timeout: 5000 });
    // The veil is opacity-driven (a CSS transition, not display:none) --
    // Playwright's isVisible() doesn't factor in opacity, so check the
    // computed style directly, same as home.html's own day0-card
    // crossfade coverage does.
    var veilOpacity = await page.locator('#result-forming-veil').evaluate(function (el) { return getComputedStyle(el).opacity; });
    assert.equal(parseFloat(veilOpacity) > 0.99, true, 'the veil must be opaque (visible) while regenerating');
    assert.equal(await page.locator('#watch-pill').isVisible(), false, 'no watch pill for stale content while regenerating');
    assert.equal(await page.locator('#mute-btn').isVisible(), false);

    // The live (NEW, being-generated) quote shows immediately -- confirms
    // the edit was received, rather than the stale pre-edit text sitting
    // there unexplained.
    var quote = await page.locator('#result-quote').textContent();
    assert.match(quote, /neon city at dawn/i, 'must show the pendingJob\'s own new story text, not the stale old one');

    var quietButtons = await page.locator('.result-quiet-links .quietlink').all();
    assert.ok(quietButtons.length >= 4);
    for (var i = 0; i < quietButtons.length; i++) {
      assert.equal(await quietButtons[i].isDisabled(), true, 'every quiet-row action must be disabled while regenerating');
    }
    assert.equal(await page.locator('#interp-cta-btn').isDisabled(), true);
  } finally {
    await context.close();
  }
});

// ============================================================================
// 2. result.html: transitions to the new result in place, with a toast
// ============================================================================

test('result.html: on completion the SAME room transitions in place -- new video, a toast, controls re-enable -- no reload, no navigation', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await page.route('**/.netlify/functions/video-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, videoUrl: 'https://example.com/new-video.mp4' }) });
    });
    await page.route('**/.netlify/functions/mark-generation-completed', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    await seedResultPageRegenerating(page, { username: 'readytester', dreamId: 'd-regen-ready-1' });
    var beforeUrl = page.url();

    // No intermediate "still regenerating" checkpoint here -- with an
    // instantly-fulfilling mock, the whole forming->ready cycle can settle
    // in a handful of milliseconds, and this test's job is the FINAL
    // settled state (test 1, above, already covers the regenerating state
    // itself in isolation with a deliberately stalled response).
    await page.waitForFunction(function () { return !document.getElementById('dreamvideo-frame').classList.contains('regenerating'); }, null, { timeout: 5000 });
    assert.equal(page.url(), beforeUrl, 'must resolve in place -- no navigation anywhere');

    await page.waitForSelector('.toast.show', { state: 'visible', timeout: 3000 });
    assert.match(await page.locator('.toast').textContent(), /your dream is ready/i);

    var videoSrc = await page.locator('#result-video').getAttribute('src');
    assert.match(videoSrc, /new-video\.mp4/);
    assert.equal(await page.locator('#watch-pill').isVisible(), true);

    var quietButtons = await page.locator('.result-quiet-links .quietlink').all();
    for (var i = 0; i < quietButtons.length; i++) {
      assert.equal(await quietButtons[i].isDisabled(), false, 'quiet-row actions must re-enable once ready');
    }
    assert.equal(await page.locator('#interp-cta-btn').isDisabled(), false);

    var dream = await readDream(page, 'd-regen-ready-1');
    assert.equal(dream.videoUrl, 'https://example.com/new-video.mp4');
    var pendingJob = await readPendingJob(page);
    assert.equal(pendingJob, null, 'pendingJob must be cleared once this dream\'s own regenerate completes');
  } finally {
    await context.close();
  }
});

// ============================================================================
// 3. result.html: a failed regeneration surfaces a visible refund/error
//    toast, rather than silently reverting to the old video
// ============================================================================

test('result.html: a FAILED regeneration surfaces a visible error toast with the refund note, drops back to the OLD video (not silently) -- and re-enables controls', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    await page.route('**/.netlify/functions/video-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ error: 'E205: fal_generation_failed', tokensRefunded: true }) });
    });
    await seedResultPageRegenerating(page, { username: 'failtester', dreamId: 'd-regen-fail-1' });

    // No intermediate "still regenerating" checkpoint -- see the identical
    // reasoning in the completion test above.
    await page.waitForFunction(function () { return !document.getElementById('dreamvideo-frame').classList.contains('regenerating'); }, null, { timeout: 5000 });

    await page.waitForSelector('.toast.show', { state: 'visible', timeout: 3000 });
    var toastText = await page.locator('.toast').textContent();
    assert.match(toastText, /something went wrong regenerating/i, 'the failure must be surfaced honestly, not silently swallowed');
    assert.match(toastText, /tokens were returned/i, 'the existing refund-note UX must surface here too');

    // Reverts to the OLD video (nothing was lost) -- WITH the explanation
    // above, not a silent, unexplained revert.
    var videoSrc = await page.locator('#result-video').getAttribute('src');
    assert.match(videoSrc, /old-video\.mp4/);

    var quietButtons = await page.locator('.result-quiet-links .quietlink').all();
    for (var i = 0; i < quietButtons.length; i++) {
      assert.equal(await quietButtons[i].isDisabled(), false, 'controls must re-enable after a failed regenerate too');
    }

    var pendingJob = await readPendingJob(page);
    assert.equal(pendingJob, null, 'pendingJob must be cleared after a real (non-superseded) failure');
  } finally {
    await context.close();
  }
});

// ============================================================================
// 4. home.html: the room card treats an edit of the dream it already owns
//    as forming, immediately (closing the pre-existing race window)
// ============================================================================

test('home.html: an edit of TONIGHT\'s own already-ready dream flips the room card to forming immediately on landing, then back to ready with a toast on completion', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);
    var videoStatusRoute = null;
    await page.route('**/.netlify/functions/video-status*', function (route) {
      videoStatusRoute = route; // held, not fulfilled yet -- released explicitly below
    });
    // Deliberately delayed (not instant) -- makes the optimistic-edit
    // window (js/store.js has no real pendingJob yet, only state.draft's
    // own sourceDreamId is known synchronously) actually observable in a
    // real test run, rather than racing an instant mocked response that
    // could land before the very first assertion even runs.
    await page.route('**/.netlify/functions/generate-video', function (route) {
      return new Promise(function (resolve) {
        setTimeout(function () {
          route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'mock:req-editflip', modelUsed: 'pixverse-v6' }) });
          resolve();
        }, 500);
      });
    });

    await safeGoto(page, baseUrl + '/login.html');
    await page.evaluate(function () {
      var handle = '@editfliptester';
      var state = {
        user: { handle: handle, username: 'editfliptester' },
        accounts: { editfliptester: { password: 'testpass1', email: 'editfliptester@example.com', noRecallDates: [] } },
        draft: {
          caption: 'engineered prompt, daylight version', storyText: 'I was flying over a golden city in daylight.',
          style: 'Cinematic', sourceDreamId: 'd-tonight-own-1', isEditDelta: true, editDeltaLength: 20,
          restore: false, characterIds: [], cameraView: null, sceneryTime: null, sceneryPlace: null,
          mediaType: 'video', sourceImageUrl: null
        },
        dreams: [{
          id: 'd-tonight-own-1', ownerHandle: handle,
          caption: 'I was flying over a golden city at night.', storyText: 'I was flying over a golden city at night.',
          promptText: 'engineered prompt, night version',
          style: 'Cinematic', mediaType: 'video', videoUrl: 'https://example.com/old-tonight.mp4',
          isPublished: false, likes: 0, createdAt: Date.now()
        }]
      };
      localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    });
    await safeGoto(page, baseUrl + '/home.html?generate=1');

    // Forming from the very first paint -- the optimistic-edit window
    // (js/store.js has no real pendingJob yet at this instant; only the
    // draft's own sourceDreamId is known synchronously).
    await page.waitForSelector('#day0-card', { state: 'visible', timeout: 5000 });
    var frameClassEarly = await page.locator('#d0-video').getAttribute('class');
    assert.doesNotMatch(frameClassEarly, /\bready\b/, 'must not show the STALE pre-edit "ready" state, even for the brief window before the real pendingJob lands');

    // Real pendingJob lands a beat later (pollForPendingJobToAppear) -- still forming.
    await settle(function () { return videoStatusRoute !== null; }, { timeout: 5000 });
    assert.equal(await page.locator('#d0-forming-veil').isVisible(), true);

    // Completes -- transitions to ready, in place, with a toast.
    videoStatusRoute.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, videoUrl: 'https://example.com/new-tonight.mp4' }) });
    await page.waitForSelector('#d0-video.ready', { timeout: 8000 });
    await page.waitForSelector('.toast.show', { state: 'visible', timeout: 3000 });
    assert.match(await page.locator('.toast').textContent(), /your dream is ready/i);

    var dream = await readDream(page, 'd-tonight-own-1');
    assert.equal(dream.videoUrl, 'https://example.com/new-tonight.mp4');
  } finally {
    await context.close();
  }
});

// ============================================================================
// 5. Stale-completion guard: a second edit superseding the first must not
//    let the first's late completion clobber the second's state
//    (js/store.js's isPendingJobStillCurrent, applied inside startGeneration)
// ============================================================================

test('js/store.js: a SECOND edit of the same dream, submitted before the first resolves, wins -- the first\'s late completion is silently ignored, never clobbers the dream/pendingJob', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  // Two Pages in the SAME context -- same origin, same localStorage,
  // separate JS realms -- exactly models two tabs/devices on one account,
  // the actual real-world shape of this race (this app's own MPA
  // architecture kills a page's own poll loop on every navigation, so the
  // race can only ever happen across two live pages, never within one).
  var context = await browser.newContext();
  try {
    var pageA = await context.newPage();
    var pageB = await context.newPage();
    await blockThirdParty(pageA);
    await blockThirdParty(pageB);
    await mockTokenStatus(pageA);
    await mockTokenStatus(pageB);

    var dreamId = 'd-stale-guard-1';
    var opA = 'mock:req-stale-a';
    var opB = 'mock:req-stale-b';

    // Page A: dream X's room, already regenerating via job A (first edit).
    // video-status held open, never auto-fulfilled -- released explicitly
    // once job B has already landed, below.
    var routeA = null;
    await pageA.route('**/.netlify/functions/video-status*', function (route) {
      // decodeURIComponent -- pollUntilDone's own `?name=` query param is
      // built via encodeURIComponent(operationName), so the ':' in
      // 'mock:req-stale-a' arrives as '%3A' on the wire.
      var url = decodeURIComponent(route.request().url());
      if (url.indexOf(opA) !== -1) { routeA = route; return; }
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: false }) });
    });
    await safeGoto(pageA, baseUrl + '/login.html');
    await pageA.evaluate(function (o) {
      var handle = '@' + o.username;
      var state = {
        user: { handle: handle, username: o.username },
        accounts: {},
        draft: {},
        dreams: [{
          id: o.dreamId, ownerHandle: handle,
          caption: 'original', storyText: 'original', style: 'Cinematic', mediaType: 'video',
          videoUrl: 'https://example.com/original.mp4', isPublished: false, likes: 0
        }],
        pendingJob: {
          operationName: o.opA, startedAt: Date.now(), caption: 'edit A text', storyText: 'edit A text',
          style: 'Cinematic', sourceDreamId: o.dreamId, mediaType: 'video', notify: false, ownerHandle: handle
        }
      };
      state.accounts[o.username] = { password: 'testpass1', email: o.username + '@example.com' };
      localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    }, { username: 'staleguardtester', dreamId: dreamId, opA: opA });
    await safeGoto(pageA, baseUrl + '/result.html?id=' + dreamId);
    await pageA.waitForSelector('#dreamvideo-frame.regenerating', { timeout: 5000 });
    await settle(function () { return routeA !== null; }, { timeout: 5000 });

    // Page B: a SECOND edit of the SAME dream, submitted (and completing)
    // before job A ever resolves -- overwrites the account's single
    // pendingJob slot with job B's own operationName the moment it starts.
    // Calls DreamStore.startDreamEdit directly (same call home.html's own
    // startFreshGenerationFromDraft makes for a real edit-delta submission
    // -- test/edit-mechanism-behavioral.test.js's own "model_used" test
    // uses this exact same direct-call pattern) rather than driving it
    // through home.html's `?generate=1` UI flow: that flow has its OWN,
    // separate "don't double-submit while a job is already showing"
    // page-level guard (`if(pendingJob) return`) which would legitimately
    // skip submitting job B here since job A is still on record -- a
    // different, unrelated safeguard from the one this test targets
    // (js/store.js's own stale-COMPLETION guard, for whenever two
    // operationNames for the same dream genuinely do end up racing, e.g.
    // via a narrower timing window than that page-level guard covers, or a
    // future change to it).
    await pageB.route('**/.netlify/functions/generate-video', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: opB, modelUsed: 'veo3.1-lite' }) });
    });
    await pageB.route('**/.netlify/functions/video-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, videoUrl: 'https://example.com/edit-b.mp4' }) });
    });
    // profile.html (not home.html) -- loads js/store.js the same way every
    // page does, but has no "resume the account's pendingJob on load" side
    // effect of its own (unlike home.html/result.html/explore.html), so it
    // doesn't ALSO auto-resume job A the instant it loads (job A is still
    // on record in localStorage) racing against the explicit job-B call
    // below -- keeps this test isolated to exactly the one thing it means
    // to exercise.
    await safeGoto(pageB, baseUrl + '/profile.html');
    var afterB = await pageB.evaluate(function (id) {
      return DreamStore.startDreamEdit(id, { promptText: 'edit B prompt', storyText: 'edit B text', deltaLength: 10 });
    }, dreamId);
    assert.equal(afterB.videoUrl, 'https://example.com/edit-b.mp4', 'job B (the newer edit) must win');
    assert.equal((afterB.editHistory || []).length, 1, 'exactly one editHistory entry so far -- job B\'s own');
    var pendingJobAfterB = await readPendingJob(pageB);
    assert.equal(pendingJobAfterB, null, 'job B\'s own completion clears pendingJob normally');

    // NOW let job A (the superseded, stale first edit) finally resolve.
    routeA.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, videoUrl: 'https://example.com/edit-a-stale.mp4' }) });
    // Give the stale resolution a moment to flow through pageA's own
    // (already-superseded) promise chain.
    await pageA.waitForTimeout(400);

    var afterA = await readDream(pageA, dreamId);
    assert.equal(afterA.videoUrl, 'https://example.com/edit-b.mp4', 'job A\'s stale, late completion must NOT clobber job B\'s already-landed result');
    assert.equal((afterA.editHistory || []).length, 1, 'job A\'s stale completion must not push a second, bogus editHistory entry');
    var pendingJobAfterA = await readPendingJob(pageA);
    assert.equal(pendingJobAfterA, null, 'job A\'s stale completion must not resurrect/disturb the (already-null) pendingJob slot');

    // Page A itself must not show a confusing "ready"/error toast for the
    // attempt it no longer owns.
    var toastVisible = await pageA.locator('.toast.show').count();
    assert.equal(toastVisible, 0, 'a superseded, stale completion must not surface any toast on the page that started it');
  } finally {
    await context.close();
  }
});
