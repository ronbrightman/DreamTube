// test/funnel-real-chain-behavioral.test.js
//
// Real browser-driven, real-Netlify-function-handler coverage for the
// EXACT chain tracker.html's for-product-bug-founder-affects-all-funn-0efe7t
// asked for after failing founder QA twice on the same "fix": "the prior
// end-to-end test did NOT mirror the actual real-world call sequence
// (pending-gen fired pre-signup -> adopted post-signup -> resumed via
// processing.html polling -> completed) ... make the end-to-end test
// mirror the ACTUAL wizard call order, not a simplified sequence."
//
// Every prior test covering this bug composed the chain ONE of two ways,
// neither of which is what a real user's browser actually does:
//   - test/automatic-first-dream-email.test.js's END-TO-END tests call the
//     real Netlify function HANDLERS directly (start-pending-generation ->
//     claim-pending-generation -> mark-generation-completed), proving the
//     SERVER-side chain is correct in isolation, but never exercise
//     wizard.html's/processing.html's own client-side JS at all (the
//     pendingGenerationToken/comparisonKey guard, adoptPendingGeneration,
//     resumePendingJob, the poll loop, attachTaskHandlers) -- exactly the
//     layer the founder's own failed QA run implicated.
//   - test/wizard-ui-behavioral.test.js's own "generate-during-signup" test
//     drives the REAL browser/client code with Playwright, but every
//     function endpoint is a canned, fake JSON response (route.fulfill with
//     a hand-written body) -- it proves the CLIENT calls the right
//     endpoints in the right order, but never proves the REAL server-side
//     job-owners/pending-dreams/account-store/first-dream-email-sender
//     logic behind those endpoints actually resolves and sends.
//
// THIS file composes both halves at once: Playwright drives the real
// wizard.html/processing.html pages exactly as a real visitor would (click
// chips, fill the contact-capture email, fill signup fields, wait for the
// real client-side poll loop to resume and complete) -- but every
// intercepted /.netlify/functions/* route.fulfill()s with the response of
// actually CALLING the real handler module in this same Node process
// (mock-blobs standing in for the real Blobs backend, matching every other
// unit test in this suite). So the full, real sequence actually runs:
// check-email.js -> start-pending-generation.js (mints a real job-owners +
// pending-dreams record) -> register-account.js (a real account-store
// record) -> claim-pending-generation.js -> video-status.js (real mock-mode
// completion check) -> mark-generation-completed.js (the real
// verifyOperationCompleted + job-owners lookup + first-dream-email-sender
// send) -- with a real Resend fetch spy in this Node process proving the
// actual email attempt, not a stand-in assertion.
//
// GENERATION_MOCK_MODE is used (no real fal.ai call), and start-pending-
// generation's mock operationName is minted with Date.now() shifted back
// (see withPastClock) so video-status.js's mock-mode elapsed-time check
// reports done:true on the very FIRST poll -- this test would otherwise
// need to wait video-status.js's own real MOCK_DELAY_MS (20s) for no
// additional coverage.

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

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();
var { fakeEvent } = require('./helpers/fake-event');
var settle = require('./helpers/settle').settle;

var server = null;
var browser = null;
var baseUrl = null;
var realFetch = global.fetch;

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
  global.fetch = realFetch;
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

/** Same Date.now monkeypatch as test/automatic-first-dream-email.test.js's own withPastClock -- shifts the embedded mock-operationName timestamp far enough into the past that video-status.js's mock-mode elapsed-time check reports done:true immediately, without this test waiting out the real 20s MOCK_DELAY_MS. */
async function withPastClock(pastMs, fn) {
  var realNow = Date.now;
  Date.now = function () { return realNow() - pastMs; };
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}

/** Builds a fakeEvent from a Playwright POST route's request, and fulfills the route with the REAL handler's response. */
async function wireRealPostHandler(page, urlGlob, handler, opts) {
  await page.route(urlGlob, async function (route) {
    var req = route.request();
    var bodyStr = req.postData() || '{}';
    var event = fakeEvent({ method: 'POST', ip: (opts && opts.ip) || '10.50.0.1', headers: { host: 'dreamtube1.netlify.app' }, body: bodyStr });
    var res = (opts && opts.wrap) ? await opts.wrap(handler, event) : await handler(event);
    route.fulfill({ status: res.statusCode, contentType: 'application/json', body: res.body });
  });
}

/** Same shape as wireRealPostHandler, for the one GET endpoint this chain needs (video-status.js) -- parses the query string off the request URL instead of a POST body, and lets a caller post-process the parsed response body (used to swap the mock video URL for a safe local one before it ever reaches the real browser page). */
async function wireRealGetHandler(page, urlGlob, handler, transformBody) {
  await page.route(urlGlob, async function (route) {
    var req = route.request();
    var url = new URL(req.url());
    var query = {};
    url.searchParams.forEach(function (v, k) { query[k] = v; });
    var event = { httpMethod: 'GET', headers: {}, queryStringParameters: query, body: null };
    var res = await handler(event);
    var body = res.body;
    if (transformBody) {
      var parsed = JSON.parse(body);
      body = JSON.stringify(transformBody(parsed));
    }
    route.fulfill({ status: res.statusCode, contentType: 'application/json', body: body });
  });
}

test('REAL CHAIN, END TO END: wizard.html\'s actual client flow (contact capture -> signup -> processing.html\'s real resume/poll) drives the REAL server handlers (start-pending-generation -> register-account -> claim-pending-generation -> video-status -> mark-generation-completed) and the automatic retention email genuinely sends', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  mockBlobs.reset();
  process.env.GENERATION_MOCK_MODE = 'true';
  process.env.RESEND_API_KEY = 'test-resend-key';
  ['start-pending-generation', 'register-account', 'claim-pending-generation', 'video-status', 'mark-generation-completed',
    'check-email', 'lib/job-owners', 'lib/pending-dreams', 'lib/account-store', 'lib/first-dream-email-store',
    'lib/first-dream-email-sender', 'lib/generation-completion-store', 'lib/rate-limit'
  ].forEach(function (mod) {
    var resolved = require.resolve('../netlify/functions/' + mod);
    delete require.cache[resolved];
  });

  var startHandler = require('../netlify/functions/start-pending-generation').handler;
  var registerHandler = require('../netlify/functions/register-account').handler;
  var claimHandler = require('../netlify/functions/claim-pending-generation').handler;
  var videoStatusHandler = require('../netlify/functions/video-status').handler;
  var markHandler = require('../netlify/functions/mark-generation-completed').handler;
  var checkEmailHandler = require('../netlify/functions/check-email').handler;

  var resendCalls = [];
  global.fetch = async function (url, opts) {
    var urlStr = String(url);
    if (urlStr.indexOf('api.resend.com') !== -1) {
      var body = opts && opts.body ? JSON.parse(opts.body) : null;
      resendCalls.push({ url: urlStr, body: body });
      return { ok: true, status: 200, json: async function () { return {}; } };
    }
    if (urlStr.indexOf('/capture/') !== -1) {
      return { ok: true, status: 200, json: async function () { return {}; } };
    }
    throw new Error('unexpected real fetch to ' + urlStr + ' during the real-chain test');
  };

  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var FUNNEL_EMAIL = 'real-chain-funnel@example.com';
    var claimCalls = [];
    var markCalls = [];

    await wireRealPostHandler(page, '**/.netlify/functions/check-email', checkEmailHandler);
    // The submission itself is the one call in this chain that needs its
    // mock operationName minted under a shifted clock (see withPastClock's
    // own doc comment) -- every other real handler call runs under the
    // real, unshifted clock.
    await wireRealPostHandler(page, '**/.netlify/functions/start-pending-generation', startHandler, {
      wrap: function (handler, event) { return withPastClock(60000, function () { return handler(event); }); }
    });
    await wireRealPostHandler(page, '**/.netlify/functions/register-account', registerHandler);
    await wireRealPostHandler(page, '**/.netlify/functions/claim-pending-generation', claimHandler, {
      wrap: function (handler, event) {
        claimCalls.push(JSON.parse(event.body));
        return handler(event);
      }
    });
    // video-status.js's real mock-mode branch returns a genuine external
    // URL (MOCK_SAMPLE_VIDEO_URL) -- swapped out here for a safe, local,
    // never-actually-fetched placeholder so this test never depends on
    // reaching a real third-party host at all (this sandbox's outbound
    // network can stall intermittently -- see CLAUDE.md).
    await wireRealGetHandler(page, '**/.netlify/functions/video-status*', videoStatusHandler, function (parsed) {
      if (parsed.videoUrl) parsed.videoUrl = 'https://example.com/fake-video.mp4';
      return parsed;
    });
    await page.route('https://example.com/fake-video.mp4', function (route) {
      route.fulfill({ status: 200, contentType: 'video/mp4', body: Buffer.from('x') });
    });
    await wireRealPostHandler(page, '**/.netlify/functions/mark-generation-completed', markHandler, {
      wrap: function (handler, event) {
        markCalls.push(JSON.parse(event.body));
        return handler(event);
      }
    });

    // ===== The actual wizard.html click-through, exactly as a real visitor
    // would drive it (no shortcuts/localStorage seeding) =====
    await safeGoto(page, baseUrl + '/wizard.html');
    await page.click('[data-subj-other="none"]');
    await page.click('#fn-subject-continue');
    await page.click('#fn-setting-skip');
    await page.waitForSelector('[data-action="flying"]');
    await page.click('[data-action="flying"]');
    await page.click('#fn-action-continue');
    await page.click('#fn-mood-skip');
    await page.click('#fn-style-skip');
    await page.click('#fn-freetext-skip');

    // Contact capture -- this is the exact moment start-pending-
    // generation.js fires for real, pre-signup.
    await page.waitForSelector('#contact-email');
    await page.fill('#contact-email', FUNNEL_EMAIL);
    await page.click('#fn-contact-continue');

    // Signup -- adoptPendingGeneration + claim-pending-generation.js fire
    // the instant this succeeds, exactly as wizard.html's real renderSignup
    // does.
    await page.waitForSelector('#fn-username', { timeout: 5000 });
    await page.fill('#fn-username', 'realchaintester');
    await page.fill('#fn-password', 'longenoughpassword1');
    await page.click('#fn-signup-continue');

    // processing.html's own real resume/poll/completion sequence takes it
    // from here -- this is the client code the founder's own failed QA run
    // actually exercised, now running for real against real handlers.
    await page.waitForURL(/result\.html\?id=/, { timeout: 20000 });

    await settle(function () { return claimCalls.length >= 1; });
    assert.equal(claimCalls.length, 1, 'claim-pending-generation must have fired exactly once, for the real funnel pendingId');
    assert.equal(claimCalls[0].email, FUNNEL_EMAIL);
    assert.ok(markCalls.length >= 1, 'processing.html must have called the REAL mark-generation-completed.js at least once');
    assert.equal(markCalls[0].operationName.indexOf('mock:'), 0, 'the operationName reaching mark-generation-completed must be the SAME funnel operationName minted by start-pending-generation.js');

    // THE ACTUAL ASSERTION THIS BUG IS ABOUT: the automatic retention email
    // must have genuinely been attempted, through the real job-owners
    // lookup, the real account-store lookup, and the real
    // first-dream-email-sender send -- not a mocked stand-in.
    await settle(function () { return resendCalls.length >= 1; });
    assert.equal(resendCalls.length, 1, 'THE BUG: the real chain (wizard.html\'s actual client flow driving the real server handlers) must result in exactly one real Resend send attempt for the funnel user');
    assert.deepEqual(resendCalls[0].body.to, [FUNNEL_EMAIL], 'the email must go to the funnel user\'s own real email');
  } finally {
    global.fetch = realFetch;
    await page.close();
  }
});
