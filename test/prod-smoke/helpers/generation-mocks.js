// test/prod-smoke/helpers/generation-mocks.js
//
// Installs Playwright page.route() interceptors for EVERY netlify function
// this app can call that would otherwise spend real fal.ai (or LLM) money,
// or write a completion marker for a job that was never real to begin
// with — regardless of which origin this suite is pointed at. This is the
// one and only thing standing between this suite and a real, billed fal.ai
// call, so it is intentionally broad rather than minimal: every endpoint
// on the generation-adjacent surface is mocked here, not just
// generate-video/video-status.
//
// Mocked, and why each one is on this list:
//   - start-pending-generation  — the funnel's pre-signup "generate while
//     you type your password" call (see docs/JOURNEY_MANIFEST.md) — a
//     REAL, billed fal.ai submission if left unmocked, fired the moment an
//     email is captured, before any account even exists yet.
//   - claim-pending-generation  — best-effort adoption call for the above;
//     mocked purely so it doesn't fire a real (harmless but noisy) lookup
//     against a pendingId that was never real (see below).
//   - generate-video / generate-image — the actual fal.ai submission
//     endpoints for an in-app "make a dream" / edit-regenerate / Make
//     Another.
//   - video-status / image-status — polled by the client until a job
//     reports done — must stay consistent with whatever operationName this
//     file's own generate-video/generate-image mock just handed back.
//   - mark-generation-completed / consume-generation-marker — real Blobs
//     writes/reads keyed by operationName once a job finishes; mocked so
//     this suite's fake operationNames never touch a real Blobs store at
//     all (the "no pollution of real data" requirement), not because
//     either one costs money.
//   - realign-dream-prompt / rewrite-dream-story — real LLM calls (not
//     fal.ai video, but still a real, billed request) used by the edit
//     sheet / Record-it review step. Same "cheapest option that verifies
//     the flow" posture AGENT_POLICY.md already applies to fal.ai calls.
//
// NOT mocked, deliberately — every other netlify function this suite's
// flow touches (register-account, check-email, claim-daily-tokens,
// get-token-status, publish-dream, unpublish-dream, get-feed,
// delete-account, ...) hits the REAL target origin for real. That's the
// entire point of this suite versus test/*.test.js's fully-mocked-backend
// behavioral suite — see this directory's own README.
//
// ALWAYS installed, regardless of origin (production or a local/preview
// override) — unlike test/*.test.js's GENERATION_MOCK_MODE (a server-side
// env var this suite has no ability to set on a real target origin
// anyway), this mocking happens entirely client-side, in the browser
// context Playwright controls, so the real server never even sees these
// requests leave the page.

var settle = require('../../helpers/settle').settle;

var videoCounter = 0;
var opCounter = 0;

/**
 * Installs every generation-adjacent mock on `page`. Returns a small
 * controller: `nextVideoUrl()` mints (and wires a route for) a fresh,
 * unique, small stand-in mp4 URL — call it once per distinct generation so
 * two different dreams/edits in the same test run never render the same
 * finished video, which matters for this suite's own
 * new-content-survives-a-reload regression check.
 * `waitForNextVideoStatusRequest(timeoutMs)` resolves once the client has
 * made a `video-status` poll for the CURRENT job (held open, not yet
 * fulfilled) — the moment a test can safely assert the forming/veil UI
 * state, without completing the job yet. `resolveNextVideoStatus(videoUrl,
 * timeoutMs)` waits for (and fulfills) a LIVE held request with
 * `{ done:true, videoUrl }`, letting the job "complete" — safe to call
 * right after a navigation (see its own doc comment for why).
 */
function installGenerationMocks(page) {
  var pendingVideoStatusRoute = null;

  page.route('**/.netlify/functions/start-pending-generation', function (route) {
    opCounter += 1;
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ pendingId: 'prod-smoke-pending-' + opCounter, operationName: 'mock:prod-smoke-' + opCounter })
    });
  });

  page.route('**/.netlify/functions/claim-pending-generation', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  page.route('**/.netlify/functions/generate-video', function (route) {
    opCounter += 1;
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ operationName: 'mock:prod-smoke-' + opCounter, modelUsed: 'veo3.1-lite' })
    });
  });

  page.route('**/.netlify/functions/generate-image', function (route) {
    opCounter += 1;
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ operationName: 'mock:prod-smoke-img-' + opCounter })
    });
  });

  // Held open (never auto-fulfilled) — same "capture the route, release it
  // explicitly" pattern as test/edit-regeneration-forming-state-
  // behavioral.test.js's own routeA, so a test can observe the real
  // forming/veil UI state before choosing to complete the job.
  //
  // IMPORTANT: js/store.js's pollUntilDone() only ever has ONE video-status
  // request in flight at a time — its own setTimeout(poll, ...) for the
  // NEXT poll is chained off the PREVIOUS fetch's .then(), so as long as
  // this mock never fulfills a request, the client never issues another
  // one. There is no "a fresh request shows up every 10s regardless" —
  // there is exactly one outstanding request per job, until this mock
  // resolves it. `waitForNextVideoStatusRequest` below relies on this: it
  // does NOT discard an already-held route by default (there may never be
  // a "next" one to replace it with).
  page.route('**/.netlify/functions/video-status*', function (route) {
    pendingVideoStatusRoute = route;
  });

  page.route('**/.netlify/functions/image-status*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, imageUrl: nextVideoUrl() }) });
  });

  page.route('**/.netlify/functions/mark-generation-completed', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  page.route('**/.netlify/functions/consume-generation-marker', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ matched: false }) });
  });

  page.route('**/.netlify/functions/realign-dream-prompt', function (route) {
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ promptText: 'prod-smoke realigned engineered prompt', storyText: 'prod-smoke realigned story text' })
    });
  });

  page.route('**/.netlify/functions/rewrite-dream-story', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ storyText: 'prod-smoke rewritten story text' }) });
  });

  function nextVideoUrl() {
    videoCounter += 1;
    var url = 'https://example.com/prod-smoke-video-' + videoCounter + '.mp4';
    page.route(url, function (route) {
      route.fulfill({ status: 200, contentType: 'video/mp4', body: Buffer.from('prod-smoke-fake-video-' + videoCounter) });
    });
    return url;
  }

  /**
   * Resolves once a video-status request is currently held open —
   * whatever's ALREADY held (e.g. the very first poll, captured back when
   * the job started, possibly several test steps ago), or the next one to
   * arrive if none is held yet. Use this when a test just needs to know a
   * poll happened (nothing to fulfill yet).
   */
  async function waitForNextVideoStatusRequest(timeoutMs) {
    var arrived = await settle(function () { return pendingVideoStatusRoute !== null; }, { timeout: timeoutMs || 15000 });
    if (!arrived) throw new Error('generation-mocks: timed out waiting for a video-status poll');
    return pendingVideoStatusRoute;
  }

  /**
   * Waits for a video-status request and fulfills it with
   * `{ done:true, videoUrl }`, completing the job — retrying if the first
   * route it grabs turns out to be STALE (a request from a page this test
   * has since navigated away from; the browser cancels an in-flight
   * request on navigation, and Playwright's route.fulfill() throws for a
   * cancelled request). This is the one safe way to resolve a job right
   * after navigating: there's no reliable way to tell, purely from this
   * side, whether an already-held route belongs to the page that's live
   * right now or one that's already gone — so this tries whatever it has,
   * and if fulfilling it fails, discards it and waits for a genuinely new
   * one instead of guessing up front.
   */
  async function resolveNextVideoStatus(videoUrl, timeoutMs) {
    var deadline = Date.now() + (timeoutMs || 15000);
    for (;;) {
      var remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('generation-mocks: timed out resolving a live video-status request');
      await waitForNextVideoStatusRequest(remaining);
      var route = pendingVideoStatusRoute;
      pendingVideoStatusRoute = null;
      try {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, videoUrl: videoUrl }) });
        return;
      } catch (e) {
        // Stale/cancelled (almost certainly a request from a page this
        // test has since navigated away from) -- loop and wait for the
        // real, live one instead.
      }
    }
  }

  return {
    nextVideoUrl: nextVideoUrl,
    waitForNextVideoStatusRequest: waitForNextVideoStatusRequest,
    resolveNextVideoStatus: resolveNextVideoStatus
  };
}

module.exports = { installGenerationMocks: installGenerationMocks };
