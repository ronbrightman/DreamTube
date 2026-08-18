// test/generation-fail-panel-behavioral.test.js
//
// Behavioral coverage for js/generation-fail-panel.js — the PERSISTENT
// recovery panel shown on a plain technical generation failure (recovery-UX
// part (b), tracker item for-product-track-avg-video-generation-t-2ci8ue,
// founder ask 2026-08-10: "always show a clear 'your tokens were returned —
// tap to try again' recovery UI on the failure screen"). Mirrors
// test/content-block-panel-behavioral.test.js's isolation-test approach
// exactly (same pageWithPanel() shape, same real-file-over-HTTP loading via
// page.addScriptTag) for the component itself, in Part 1 below.
//
// Part 2 is a real home.html integration test: seeds a resumed pendingJob
// that fails with a real fal-reported error (mocked video-status.js), and
// proves (a) the panel — not a vanishing toast — is what actually shows on
// this real failure path, with the tokensRefunded line correctly gated on
// err.tokensRefunded, and (b) "Try again" actually reuses
// startFreshGenerationFromDraft()'s exact resubmission mechanism end to end
// (a fresh generate-video call, resolving to a real completed dream) —
// not a separately-invented retry path. Also proves the E116 content-policy
// branch is completely untouched: it still shows ContentBlockPanel, never
// this new panel.

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

/** Wraps page.goto with 'domcontentloaded' (not the default 'load') and tolerates a transient nav failure -- see CLAUDE.md's known environment quirk. */
async function safeGoto(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  } catch (e) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  }
}

// ===== Part 1: isolated component coverage (mirrors content-block-panel-behavioral.test.js) =====

/** Loads a minimal page and injects js/generation-fail-panel.js as a real <script> from the static server -- the production file served over HTTP, not a copy. */
async function pageWithPanel(context) {
  var page = await context.newPage();
  await blockThirdParty(page);
  await page.goto(baseUrl + '/offline.html', { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ url: baseUrl + '/js/generation-fail-panel.js' });
  await page.waitForFunction(function () { return !!window.GenerationFailPanel; }, { timeout: 5000 });
  return page;
}

function showPanel(page, opts) {
  return page.evaluate(function (o) {
    window.__gfp = { retried: 0, dismissed: 0 };
    window.GenerationFailPanel.show({
      message: o.message,
      tokensRefunded: o.tokensRefunded,
      onRetry: function () { window.__gfp.retried++; },
      onDismiss: function () { window.__gfp.dismissed++; }
    });
  }, opts);
}

var FAIL_MSG = 'Something went wrong generating your video — nothing was lost. (fal_internal_error)';

test('panel renders, PERSISTS (no auto-dismiss), and the message wraps', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await pageWithPanel(context);
    await showPanel(page, { message: FAIL_MSG, tokensRefunded: false });

    assert.equal(await page.locator('#gfp-root').count(), 1, 'panel is shown');
    var msg = await page.locator('.gfp-msg').innerText();
    assert.match(msg, /Something went wrong generating your video/);
    var ws = await page.locator('.gfp-msg').evaluate(function (el) { return getComputedStyle(el).whiteSpace; });
    assert.notEqual(ws, 'nowrap', 'the failure message must be allowed to wrap, never single-line nowrap');

    // Persists well past the old ~2.2s toast auto-dismiss.
    await page.waitForTimeout(2600);
    assert.equal(await page.locator('#gfp-root').count(), 1, 'panel must still be present -- it never auto-dismisses');
  } finally {
    await context.close();
  }
});

test('tokensRefunded:true shows a prominent, distinct "Your tokens were returned." line', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await pageWithPanel(context);
    await showPanel(page, { message: FAIL_MSG, tokensRefunded: true });

    var refundEl = page.locator('.gfp-refund');
    assert.equal(await refundEl.count(), 1, 'the refund line renders as its own distinct element, not folded into the message');
    assert.match(await refundEl.innerText(), /Your tokens were returned/);
  } finally {
    await context.close();
  }
});

test('tokensRefunded:false (or absent) shows NO refund line -- never fabricated', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await pageWithPanel(context);
    await showPanel(page, { message: FAIL_MSG, tokensRefunded: false });
    assert.equal(await page.locator('.gfp-refund').count(), 0, 'no refund claim is shown unless the caller explicitly says a refund landed');
  } finally {
    await context.close();
  }
});

test('"Try again" calls onRetry and closes the panel; "Dismiss" calls onDismiss and closes without retrying', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await pageWithPanel(context);

    // Try again
    await showPanel(page, { message: FAIL_MSG, tokensRefunded: true });
    await page.locator('.gfp-btn', { hasText: 'Try again' }).click();
    var afterRetry = await page.evaluate(function () { return window.__gfp; });
    assert.equal(afterRetry.retried, 1, 'Try again invokes onRetry exactly once');
    assert.equal(afterRetry.dismissed, 0);
    assert.equal(await page.locator('#gfp-root').count(), 0, 'panel closes on Try again');

    // Dismiss
    await showPanel(page, { message: FAIL_MSG, tokensRefunded: false });
    await page.locator('.gfp-btn', { hasText: 'Dismiss' }).click();
    var afterDismiss = await page.evaluate(function () { return window.__gfp; });
    assert.equal(afterDismiss.dismissed, 1, 'Dismiss invokes onDismiss exactly once');
    assert.equal(afterDismiss.retried, 0, 'Dismiss must never itself trigger a retry');
    assert.equal(await page.locator('#gfp-root').count(), 0, 'panel closes on Dismiss');
  } finally {
    await context.close();
  }
});

test('show() never stacks two panels -- a second call replaces the first', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  try {
    var page = await pageWithPanel(context);
    await showPanel(page, { message: 'first failure', tokensRefunded: false });
    await showPanel(page, { message: 'second failure', tokensRefunded: true });
    assert.equal(await page.locator('#gfp-root').count(), 1, 'exactly one panel in the DOM at a time');
    assert.match(await page.locator('.gfp-msg').innerText(), /second failure/);
  } finally {
    await context.close();
  }
});

// ===== Part 2: real home.html integration =====

/** Same shape as test/generation-instrumentation-behavioral.test.js's own seedLoggedInWithPendingJob. */
async function seedLoggedInWithPendingJob(page, username, password, email, opts) {
  opts = opts || {};
  await safeGoto(page, baseUrl + '/login.html');
  await page.evaluate(function (args) {
    var handle = '@' + args.username;
    var pendingJob = {
      operationName: 'fal:fal-ai/veo3.1/fast:req-' + args.username,
      startedAt: args.startedAt,
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
      draft: { caption: args.username + '\'s in-flight dream', storyText: args.username + '\'s in-flight dream', style: 'Cinematic', sourceDreamId: null, restore: false, characterIds: [], cameraView: null, sceneryTime: null, sceneryPlace: null, mediaType: 'video', sourceImageUrl: null, audioOn: false, musicStyle: null },
      dreams: [],
      pendingJob: pendingJob,
      charactersByUser: {},
      likedIds: {}
    };
    state.accounts[args.username] = { password: args.password, email: args.email };
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, { username: username, password: password, email: email, startedAt: opts.startedAt || Date.now() });

  await safeGoto(page, baseUrl + '/login.html');
}

test('home.html: a real fal-reported failure (E205) shows GenerationFailPanel with the refund line when tokensRefunded is true, and "Try again" resubmits via startFreshGenerationFromDraft to a real completion', { timeout: 30000 }, async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await seedLoggedInWithPendingJob(page, 'gfpintuser', 'gfpintuserpassword1', 'gfpintuser@example.com', { startedAt: Date.now() - 8000 });

    var statusCallCount = 0;
    await page.route('**/.netlify/functions/video-status*', function (route) {
      statusCallCount++;
      if (statusCallCount === 1) {
        // The original resumed job fails for real, WITH a server-confirmed
        // refund -- same tokensRefunded:true shape js/store.js's
        // pollUntilDone attaches from video-status.js's own response.
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, error: 'E205: generation_failed: FAILED', tokensRefunded: true }) });
        return;
      }
      // The RETRY's own poll -- resolves cleanly.
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, videoUrl: 'https://example.com/retry-success.mp4' }) });
    });
    var generateVideoCalls = 0;
    await page.route('**/.netlify/functions/generate-video', function (route) {
      generateVideoCalls++;
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'fal:fal-ai/veo3.1/fast:req-retry-' + generateVideoCalls, modelUsed: 'veo3.1-lite' }) });
    });

    await safeGoto(page, baseUrl + '/home.html');
    await page.waitForSelector('#gfp-root', { state: 'visible', timeout: 10000 });

    // The founder's own specifically-requested copy: a clear, prominent
    // "tokens were returned" statement.
    var refundText = await page.locator('.gfp-refund').innerText();
    assert.match(refundText, /Your tokens were returned/);
    // The base media-aware copy plus the server's reason suffix is present too.
    var msgText = await page.locator('.gfp-msg').innerText();
    assert.match(msgText, /Something went wrong generating your video/);
    assert.match(msgText, /generation_failed: FAILED/);

    // Panel PERSISTS -- no auto-dismiss.
    await page.waitForTimeout(2600);
    assert.equal(await page.locator('#gfp-root').count(), 1, 'the recovery panel must still be present -- it never auto-dismisses like the old toast did');

    // Tap "Try again" -- must reuse the exact same resubmission mechanism
    // as the E112/E412 purchase-sheet retry (startFreshGenerationFromDraft
    // + onGenerationSettled + pollForPendingJobToAppear), ending in a real
    // completed dream.
    await page.locator('.gfp-btn', { hasText: 'Try again' }).click();
    assert.equal(await page.locator('#gfp-root').count(), 0, 'panel closes the moment Try again is tapped');

    await page.waitForSelector('#d0-video.ready', { timeout: 15000 });
    assert.equal(generateVideoCalls, 1, 'Try again must resubmit exactly once via a real fresh generate-video call');

    var myDreams = await page.evaluate(function () { return window.DreamStore.getMyDreams(); });
    assert.equal(myDreams.length, 1, 'the retry must produce exactly one real completed dream');
    assert.equal(myDreams[0].videoUrl, 'https://example.com/retry-success.mp4');
  } finally {
    await page.close();
  }
});

test('home.html: tokensRefunded:false (or absent) shows the panel with NO refund line -- never claims a refund that did not happen', { timeout: 60000 }, async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await seedLoggedInWithPendingJob(page, 'gfpnorefund', 'gfpnorefundpassword1', 'gfpnorefund@example.com', { startedAt: Date.now() - 5000 });
    await page.route('**/.netlify/functions/video-status*', function (route) {
      // A network-level failure repeated past MAX_NETWORK_RETRIES (3
      // consecutive misses, each retried after POLL_INTERVAL_MS=10s -- see
      // js/store.js's own pollUntilDone) -- E302, which never carries
      // tokensRefunded at all (only a real data.error response can set it).
      route.abort('failed');
    });

    await safeGoto(page, baseUrl + '/home.html');
    await page.waitForSelector('#gfp-root', { state: 'visible', timeout: 50000 });

    assert.equal(await page.locator('.gfp-refund').count(), 0, 'no refund claim shown for a failure with no server-confirmed refund');
    var msgText = await page.locator('.gfp-msg').innerText();
    assert.match(msgText, /Something went wrong generating your video/);
  } finally {
    await page.close();
  }
});

test('home.html: the E116 content-policy branch is UNCHANGED -- still shows ContentBlockPanel, never GenerationFailPanel', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await seedLoggedInWithPendingJob(page, 'gfpe116user', 'gfpe116userpassword1', 'gfpe116user@example.com', { startedAt: Date.now() - 3000 });
    await page.route('**/.netlify/functions/video-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, error: "E116: content_policy_blocked: We can't turn explicit sexual content into a video — try describing the scene without it." }) });
    });

    await safeGoto(page, baseUrl + '/home.html');
    await page.waitForSelector('#cbp-root', { state: 'visible', timeout: 10000 });

    assert.equal(await page.locator('#gfp-root').count(), 0, 'an E116 content-policy block must still show ContentBlockPanel only, never the new GenerationFailPanel');
    assert.equal(await page.locator('.cbp-btn', { hasText: 'Soften it for me' }).count(), 1, 'ContentBlockPanel\'s own Soften/Edit/Discard behavior is untouched');
  } finally {
    await page.close();
  }
});
