// test/result-generation-fail-panel-behavioral.test.js
//
// Parity-fix coverage for result.html's own generic-failure catch branch
// inside its "regenerating resume driver" (regeneratingThisDream() ->
// DreamStore.resumePendingJob().catch(...) -- see that block's own header
// comment for the "resume watching an in-flight regeneration after a
// reload" scenario this covers). Follow-up to tracker item
// for-product-track-avg-video-generation-t-2ci8ue: home.html's identical
// generic-failure branch got upgraded to the persistent GenerationFailPanel
// (js/generation-fail-panel.js) already (test/generation-fail-panel-
// behavioral.test.js); this branch was explicitly disclosed/deferred at
// review time rather than missed, and is the follow-up this file covers.
//
// The one real design decision here (see result.html's own onRetry comment
// for the full reasoning): "Try again" must resubmit whatever draft
// actually produced the failed attempt, AS IS -- not rebuild one from
// `dream`'s own always-unchanged fields (persistGenerateAgainDraft), which
// would silently downgrade a failed "turn this into a video" attempt back
// into a same-mediaType, sourceImageUrl-less regenerate. Test 3 below is
// the regression guard for exactly that case. Test 5 covers the safety
// fallback for when the draft can no longer be trusted (overwritten by an
// unrelated action elsewhere while the job was in flight).
//
// Zero real fal.ai cost -- every generate-video/generate-image/video-status
// call is mocked via page.route(), per AGENT_POLICY.md's "keep
// generation-testing cost low" guidance. Follows this repo's established
// Playwright/node:test convention (test/edit-regeneration-forming-state-
// behavioral.test.js's own seedResultPageRegenerating shape,
// test/generation-fail-panel-behavioral.test.js's own Part 2 integration
// shape) rather than inventing a new one.

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

function mockTokenStatus(page) {
  return page.route('**/.netlify/functions/get-token-status*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ balance: 1000, nextClaimAt: Date.now() + 3600000, dailyClaimAmount: 20, claimable: false, streak: 0 }) });
  });
}

// js/store.js's own default draft shape (see state.draft's seed() literal) --
// replicated here (rather than a partial object) so a real submission off
// this seeded draft never trips over a field the app code assumes exists.
var DEFAULT_DRAFT = { caption: '', storyText: '', needsStoryRewrite: false, style: null, sourceDreamId: null, restore: false, characterIds: [], cameraView: null, sceneryTime: null, sceneryPlace: null, mediaType: null, sourceImageUrl: null, audioOn: false, musicStyle: null, mood: null, isEditDelta: false, editDeltaLength: null };

/**
 * Seeds a logged-in account with one owned dream, an in-flight pendingJob
 * already regenerating it (sourceDreamId === dreamId, so result.html's own
 * regeneratingThisDream() picks it up on load), and a draft -- the same
 * three-piece shape a real submission leaves behind (see
 * test/edit-regeneration-forming-state-behavioral.test.js's identical
 * seedResultPageRegenerating). Lands on result.html?id=dreamId.
 */
async function seedResultPageRegenerating(page, o) {
  o = o || {};
  await safeGoto(page, baseUrl + '/login.html');
  await page.evaluate(function (args) {
    var handle = '@' + args.username;
    var state = {
      user: { handle: handle, username: args.username },
      accounts: {},
      draft: args.draft,
      dreams: [args.dream],
      pendingJob: args.pendingJob
    };
    state.accounts[args.username] = { password: 'testpass1', email: args.username + '@example.com' };
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, { username: o.username, dream: o.dream, pendingJob: o.pendingJob, draft: o.draft });
  await safeGoto(page, baseUrl + '/result.html?id=' + o.dream.id);
}

function readState(page) {
  return page.evaluate(function () { return JSON.parse(localStorage.getItem('dreamtube_state_v1')); });
}

// ============================================================================
// 1. Panel shows (not a toast) on a plain regenerate failure, refund line
//    gated on tokensRefunded, and "Try again" resubmits the SAME (plain
//    video regenerate) draft end-to-end to a real completion.
// ============================================================================

test('result.html: a real fal-reported failure (E205) on the resume-on-load path shows GenerationFailPanel with the refund line, and "Try again" resubmits the intact draft via home.html?generate=1 to a real completion', { timeout: 30000 }, async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);

    var dreamId = 'd-gfp-plain-1';
    var dream = {
      id: dreamId, ownerHandle: '@plaintester', caption: 'old prompt', promptText: 'old prompt', storyText: 'I was flying over a golden city at night.',
      style: 'Cinematic', mediaType: 'video', videoUrl: 'https://example.com/old-video.mp4', dur: '0:08',
      // createdAt = today -- required for home.html's own
      // getDreamLogStatus()/shouldShowRoomCard() to treat this as "logged
      // tonight" so the day0 room card (and its #d0-video.ready check
      // below) actually renders once pendingJob clears after the retry.
      isPublished: false, likes: 0, likedByMe: false, createdAt: Date.now()
    };
    var pendingJob = {
      operationName: 'mock:req-plain-fail', startedAt: Date.now(),
      caption: 'new prompt', storyText: 'I was flying over a neon city at dawn.', style: 'Cinematic',
      sourceDreamId: dreamId, mediaType: 'video', notify: false, ownerHandle: '@plaintester'
    };
    var draft = Object.assign({}, DEFAULT_DRAFT, {
      caption: 'new prompt', storyText: 'I was flying over a neon city at dawn.', style: 'Cinematic',
      sourceDreamId: dreamId, mediaType: 'video'
    });

    var statusCallCount = 0;
    await page.route('**/.netlify/functions/video-status*', function (route) {
      statusCallCount++;
      if (statusCallCount === 1) {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, error: 'E205: fal_generation_failed', tokensRefunded: true }) });
        return;
      }
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, videoUrl: 'https://example.com/retry-success.mp4' }) });
    });
    var generateVideoCalls = 0;
    var generateImageCalls = 0;
    await page.route('**/.netlify/functions/generate-video', function (route) {
      generateVideoCalls++;
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'mock:req-retry-' + generateVideoCalls, modelUsed: 'veo3.1-lite' }) });
    });
    await page.route('**/.netlify/functions/generate-image', function (route) {
      generateImageCalls++;
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'mock:img-retry-' + generateImageCalls }) });
    });

    await seedResultPageRegenerating(page, { username: 'plaintester', dream: dream, pendingJob: pendingJob, draft: draft });

    await page.waitForSelector('#gfp-root', { state: 'visible', timeout: 5000 });
    var msgText = await page.locator('.gfp-msg').innerText();
    assert.match(msgText, /something went wrong regenerating your video/i);
    assert.match(msgText, /fal_generation_failed/);
    assert.match(await page.locator('.gfp-refund').innerText(), /Your tokens were returned/);
    // Some other unrelated toast (e.g. the video player's own "Tap for
    // sound" mute-state hint) may legitimately be showing at the same
    // time -- only assert the OLD failure-toast copy specifically never
    // appears, not that .toast.show is empty outright.
    var toastTexts = await page.locator('.toast').allInnerTexts();
    assert.equal(toastTexts.some(function (tx) { return /something went wrong regenerating/i.test(tx); }), false, 'must not ALSO show the old vanishing failure toast');

    // Persists well past the old ~2.2s toast auto-dismiss.
    await page.waitForTimeout(2600);
    assert.equal(await page.locator('#gfp-root').count(), 1, 'the recovery panel must still be present -- it never auto-dismisses');

    await page.locator('.gfp-btn', { hasText: 'Try again' }).click();
    assert.equal(await page.locator('#gfp-root').count(), 0, 'panel closes the moment Try again is tapped');

    await page.waitForURL(/home\.html/, { timeout: 8000 });
    await page.waitForSelector('#d0-video.ready', { timeout: 15000 });
    assert.equal(generateVideoCalls, 1, 'Try again must resubmit exactly once via a real fresh generate-video call');
    assert.equal(generateImageCalls, 0, 'a plain video regenerate must never route through generate-image');

    var state = await readState(page);
    var updated = state.dreams.filter(function (d) { return d.id === dreamId; })[0];
    assert.equal(state.dreams.length, 1, 'a regenerate retry updates the SAME dream, never creates a second one');
    assert.equal(updated.videoUrl, 'https://example.com/retry-success.mp4');
    assert.equal(updated.mediaType, 'video');
  } finally {
    await context.close();
  }
});

// ============================================================================
// 2. tokensRefunded:false -- no refund line shown, never fabricated.
// ============================================================================

test('result.html: tokensRefunded:false (or absent) shows the panel with NO refund line', { timeout: 60000 }, async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);

    var dreamId = 'd-gfp-norefund-1';
    var dream = {
      id: dreamId, ownerHandle: '@norefundtester', caption: 'old prompt', promptText: 'old prompt', storyText: 'old story',
      style: 'Cinematic', mediaType: 'video', videoUrl: 'https://example.com/old-video.mp4',
      isPublished: false, likes: 0, likedByMe: false
    };
    var pendingJob = {
      operationName: 'mock:req-norefund-fail', startedAt: Date.now(),
      caption: 'new prompt', storyText: 'new story', style: 'Cinematic',
      sourceDreamId: dreamId, mediaType: 'video', notify: false, ownerHandle: '@norefundtester'
    };
    var draft = Object.assign({}, DEFAULT_DRAFT, { caption: 'new prompt', storyText: 'new story', style: 'Cinematic', sourceDreamId: dreamId, mediaType: 'video' });

    await page.route('**/.netlify/functions/video-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, error: 'E205: fal_generation_failed' }) });
    });

    await seedResultPageRegenerating(page, { username: 'norefundtester', dream: dream, pendingJob: pendingJob, draft: draft });

    await page.waitForSelector('#gfp-root', { state: 'visible', timeout: 5000 });
    assert.equal(await page.locator('.gfp-refund').count(), 0, 'no refund claim shown for a failure with no server-confirmed refund');
  } finally {
    await context.close();
  }
});

// ============================================================================
// 3. THE critical case: a failed "turn this into a video" regeneration --
//    Try again must resume the VIDEO attempt, never silently downgrade to
//    a same-mediaType image regenerate (which persistGenerateAgainDraft's
//    dream-rebuilt-from-scratch approach would have caused -- see
//    result.html's own onRetry comment).
// ============================================================================

test('result.html: a failed "turn this into a video" regeneration -- Try again resumes the VIDEO attempt from the intact draft, never silently downgrades to an image regenerate', { timeout: 30000 }, async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);

    var dreamId = 'd-gfp-turnvideo-1';
    // The underlying dream is (and, since finalizeDream never ran on the
    // failed attempt, STAYS) an image the whole time this catch handler runs.
    var dream = {
      id: dreamId, ownerHandle: '@turnvideotester', caption: 'a lighthouse at dusk', promptText: 'a lighthouse at dusk', storyText: 'a lighthouse at dusk',
      style: 'Cinematic', mediaType: 'image', imageUrl: 'https://example.com/source-image.png',
      // createdAt = today -- see test 1's identical comment above.
      isPublished: false, likes: 0, likedByMe: false, createdAt: Date.now()
    };
    // js/store.js's turnImageIntoVideo sets sourceDreamId to the SAME image
    // dream's id -- this is exactly what makes result.html's
    // regeneratingThisDream() (a plain `pendingJob.sourceDreamId === dreamId`
    // check, blind to mediaType) treat this in-flight VIDEO job the same as
    // any plain same-mediaType regenerate.
    var pendingJob = {
      operationName: 'mock:req-turnvideo-fail', startedAt: Date.now(),
      caption: 'a lighthouse at dusk', storyText: 'a lighthouse at dusk', style: 'Cinematic',
      sourceDreamId: dreamId, mediaType: 'video', notify: false, ownerHandle: '@turnvideotester'
    };
    var draft = Object.assign({}, DEFAULT_DRAFT, {
      caption: 'a lighthouse at dusk', storyText: 'a lighthouse at dusk', style: 'Cinematic',
      sourceDreamId: dreamId, mediaType: 'video', sourceImageUrl: 'https://example.com/source-image.png'
    });

    var statusCallCount = 0;
    await page.route('**/.netlify/functions/video-status*', function (route) {
      statusCallCount++;
      if (statusCallCount === 1) {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, error: 'E205: fal_generation_failed', tokensRefunded: true }) });
        return;
      }
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, videoUrl: 'https://example.com/turned-into-video.mp4' }) });
    });
    var generateVideoCalls = [];
    var generateImageCalls = 0;
    await page.route('**/.netlify/functions/generate-video', function (route) {
      var body = route.request().postDataJSON ? route.request().postDataJSON() : JSON.parse(route.request().postData() || '{}');
      generateVideoCalls.push(body);
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'mock:req-turnvideo-retry', modelUsed: 'veo3.1-lite' }) });
    });
    await page.route('**/.netlify/functions/generate-image', function (route) {
      generateImageCalls++;
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'mock:img-turnvideo-retry' }) });
    });

    await seedResultPageRegenerating(page, { username: 'turnvideotester', dream: dream, pendingJob: pendingJob, draft: draft });

    await page.waitForSelector('#gfp-root', { state: 'visible', timeout: 5000 });
    // The base copy is media-aware off the DREAM's own (still-image)
    // mediaType -- this is just display copy for the ALREADY-FAILED
    // attempt's framing, not what gets resubmitted (see result.html's own
    // mediaTypeForCopy comment) -- the resubmission correctness is the
    // generate-video/generate-image assertions below, not this string.
    await page.locator('.gfp-btn', { hasText: 'Try again' }).click();

    await page.waitForURL(/home\.html/, { timeout: 8000 });
    await page.waitForSelector('#d0-video.ready', { timeout: 15000 });

    assert.equal(generateVideoCalls.length, 1, 'the retry must resubmit as a VIDEO generation -- the attempt that actually failed');
    assert.equal(generateImageCalls, 0, 'must NEVER silently downgrade the retry to an image regenerate');
    assert.equal(generateVideoCalls[0].sourceImageUrl, 'https://example.com/source-image.png', 'the source image reference must survive the retry -- this is still a turn-into-video generation');

    var state = await readState(page);
    var updated = state.dreams.filter(function (d) { return d.id === dreamId; })[0];
    assert.equal(updated.mediaType, 'video', 'the dream must become a real video on this successful retry, not stay/revert to image');
    assert.equal(updated.videoUrl, 'https://example.com/turned-into-video.mp4');
  } finally {
    await context.close();
  }
});

// ============================================================================
// 4. E116 branch is completely unaffected by this change.
// ============================================================================

test('result.html: the E116 content-policy branch is UNCHANGED -- still shows ContentBlockPanel, never GenerationFailPanel', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);

    var dreamId = 'd-gfp-e116-1';
    var dream = {
      id: dreamId, ownerHandle: '@e116tester', caption: 'old prompt', promptText: 'old prompt', storyText: 'old story',
      style: 'Cinematic', mediaType: 'video', videoUrl: 'https://example.com/old-video.mp4',
      isPublished: false, likes: 0, likedByMe: false
    };
    var pendingJob = {
      operationName: 'mock:req-e116-fail', startedAt: Date.now(),
      caption: 'blocked prompt', storyText: 'blocked story', style: 'Cinematic',
      sourceDreamId: dreamId, mediaType: 'video', notify: false, ownerHandle: '@e116tester'
    };
    var draft = Object.assign({}, DEFAULT_DRAFT, { caption: 'blocked prompt', storyText: 'blocked story', style: 'Cinematic', sourceDreamId: dreamId, mediaType: 'video' });

    await page.route('**/.netlify/functions/video-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, error: "E116: content_policy_blocked: We can't turn explicit sexual content into a video — try describing the scene without it." }) });
    });

    await seedResultPageRegenerating(page, { username: 'e116tester', dream: dream, pendingJob: pendingJob, draft: draft });

    await page.waitForSelector('#cbp-root', { state: 'visible', timeout: 5000 });
    assert.equal(await page.locator('#gfp-root').count(), 0, 'an E116 content-policy block must still show ContentBlockPanel only, never the new GenerationFailPanel');
    assert.equal(await page.locator('.cbp-btn', { hasText: 'Soften it for me' }).count(), 1, 'ContentBlockPanel\'s own Soften/Edit/Discard behavior is untouched');
  } finally {
    await context.close();
  }
});

// ============================================================================
// 5. Safety fallback: if the draft no longer targets this dream (overwritten
//    by an unrelated action elsewhere while the job was in flight), "Try
//    again" must NOT blindly resubmit -- it opens the manual edit sheet.
// ============================================================================

test('result.html: "Try again" with a draft that no longer matches this dream does NOT auto-resubmit -- opens the manual edit sheet instead', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockTokenStatus(page);

    var dreamId = 'd-gfp-staledraft-1';
    var dream = {
      id: dreamId, ownerHandle: '@staledrafttester', caption: 'old prompt', promptText: 'old prompt', storyText: 'old story',
      style: 'Cinematic', mediaType: 'video', videoUrl: 'https://example.com/old-video.mp4',
      isPublished: false, likes: 0, likedByMe: false
    };
    var pendingJob = {
      operationName: 'mock:req-staledraft-fail', startedAt: Date.now(),
      caption: 'new prompt', storyText: 'new story', style: 'Cinematic',
      sourceDreamId: dreamId, mediaType: 'video', notify: false, ownerHandle: '@staledrafttester'
    };
    // The draft now points at a DIFFERENT dream entirely -- models an
    // unrelated action (another tab, or this same account starting a
    // different dream's edit) that overwrote it while this job was in
    // flight.
    var draft = Object.assign({}, DEFAULT_DRAFT, { caption: 'unrelated', storyText: 'unrelated', style: 'Cinematic', sourceDreamId: 'some-other-dream-id', mediaType: 'video' });

    var generateVideoCalls = 0;
    await page.route('**/.netlify/functions/video-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, error: 'E205: fal_generation_failed', tokensRefunded: false }) });
    });
    await page.route('**/.netlify/functions/generate-video', function (route) {
      generateVideoCalls++;
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'mock:should-not-happen', modelUsed: 'veo3.1-lite' }) });
    });

    await seedResultPageRegenerating(page, { username: 'staledrafttester', dream: dream, pendingJob: pendingJob, draft: draft });

    await page.waitForSelector('#gfp-root', { state: 'visible', timeout: 5000 });
    await page.locator('.gfp-btn', { hasText: 'Try again' }).click();

    // Never navigates away, never resubmits -- the manual edit sheet opens
    // instead so the user can review/submit deliberately.
    await page.waitForSelector('#sheet-edit-overlay.open', { timeout: 3000 });
    assert.equal(page.url().indexOf('result.html') !== -1, true, 'must stay on result.html -- no blind auto-resubmit to home.html');
    assert.equal(generateVideoCalls, 0, 'must never resubmit a generation off a draft that no longer targets this dream');
  } finally {
    await context.close();
  }
});
