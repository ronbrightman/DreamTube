// test/funnel-real-chain-behavioral.test.js
//
// Real browser-driven, real-Netlify-function-handler coverage for the
// EXACT chain tracker.html's for-product-bug-founder-affects-all-funn-0efe7t
// asked for after failing founder QA twice on the same "fix": "the prior
// end-to-end test did NOT mirror the actual real-world call sequence
// (pending-gen fired pre-signup -> adopted post-signup -> resumed via
// home.html polling, formerly processing.html's job before tracker item
// for-product-funnel-ending-v2-founder-ins-tfuu0q removed that page ->
// completed) ... make the end-to-end test mirror the ACTUAL wizard call
// order, not a simplified sequence."
//
// Every prior test covering this bug composed the chain ONE of two ways,
// neither of which is what a real user's browser actually does:
//   - the server-side unit/enqueue tests call the real Netlify function
//     HANDLERS directly (start-pending-generation ->
//     claim-pending-generation -> mark-generation-completed), proving the
//     SERVER-side chain is correct in isolation, but never exercise
//     wizard.html's/home.html's own client-side JS at all (the
//     pendingGenerationToken/comparisonKey guard, adoptPendingGeneration,
//     resumePendingJob, the poll loop, onGenerationSettled) -- exactly the
//     layer the founder's own failed QA run implicated.
//   - test/wizard-ui-behavioral.test.js's own "generate-during-signup" test
//     drives the REAL browser/client code with Playwright, but every
//     function endpoint is a canned, fake JSON response (route.fulfill with
//     a hand-written body) -- it proves the CLIENT calls the right
//     endpoints in the right order, but never proves the REAL server-side
//     job-owners/pending-dreams/account-store/unwatched-dream-nudge
//     logic behind those endpoints actually resolves and sends.
//
// THIS file composes both halves at once: Playwright drives the real
// wizard.html/home.html pages exactly as a real visitor would (click
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
// verifyOperationCompleted + job-owners lookup + unwatched-dream-nudge
// enqueue) -> send-unwatched-dream-nudges.js's scan (the real nudge send)
// -- with a real Resend fetch spy in this Node process proving the actual
// email attempt, not a stand-in assertion. (The retention email a signed-up
// user gets is the "unwatched dream" nudge, the single such email since the
// founder retired the separate first-dream email on 2026-08-11.)
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

/** A FRESH organic wizard-wall signup now shows the post-signup monetization moment (wizard.html's showMonetizationMoment) before the home.html handoff. This test enters wizard.html organically (not a funnel ?resume arrival), so the moment shows; dismissing it ("Not now") reproduces the original home.html?generate=1 navigation the real chain then drives. */
async function dismissMomentIfPresent(page) {
  try { await page.waitForSelector('.mm-overlay', { timeout: 8000 }); }
  catch (e) { return; }
  await page.click('.mm-x'); // paywall dismiss (the 'Not now' link was removed 08-14; X dismisses)
}

/** Date.now monkeypatch -- shifts the embedded mock-operationName timestamp far enough into the past that video-status.js's mock-mode elapsed-time check reports done:true immediately, without this test waiting out the real 20s MOCK_DELAY_MS. */
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

test('REAL CHAIN, END TO END: wizard.html\'s actual client flow (the merged signup wall -> home.html\'s real resume/poll) drives the REAL server handlers (start-pending-generation -> register-account-passwordless -> claim-pending-generation -> video-status -> mark-generation-completed) and the unwatched-dream retention nudge genuinely sends', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  mockBlobs.reset();
  process.env.GENERATION_MOCK_MODE = 'true';
  process.env.RESEND_API_KEY = 'test-resend-key';
  ['start-pending-generation', 'register-account-passwordless', 'claim-pending-generation', 'video-status', 'mark-generation-completed',
    'send-unwatched-dream-nudges', 'check-email', 'lib/job-owners', 'lib/pending-dreams', 'lib/account-store',
    'lib/unwatched-dream-nudge-store', 'lib/unwatched-dream-nudge-sender', 'lib/generation-completion-store', 'lib/rate-limit', 'lib/email-domain-check'
  ].forEach(function (mod) {
    var resolved = require.resolve('../netlify/functions/' + mod);
    delete require.cache[resolved];
  });

  var startHandler = require('../netlify/functions/start-pending-generation').handler;
  var registerHandler = require('../netlify/functions/register-account-passwordless').handler;
  var claimHandler = require('../netlify/functions/claim-pending-generation').handler;
  var videoStatusHandler = require('../netlify/functions/video-status').handler;
  var markHandler = require('../netlify/functions/mark-generation-completed').handler;
  var checkEmailHandler = require('../netlify/functions/check-email').handler;
  // check-email.js's deliverability check is a real DNS lookup (see
  // lib/email-domain-check.js) -- mocked here so this real-server-handler
  // chain never depends on real network/DNS resolution (same reasoning as
  // the resend/fal-webhook fetch stub above and the swapped-out mock video
  // URL below). FUNNEL_EMAIL's domain is a real one either way, but this
  // keeps the test deterministic and fast regardless of this sandbox's own
  // outbound-network reliability.
  require('../netlify/functions/lib/email-domain-check').isDomainDeliverable = function () { return Promise.resolve(true); };

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
    // markCalls records a mark-generation-completed REQUEST the instant the
    // route is intercepted; markCompletions records the real handler
    // actually RESOLVING. They are not the same event, and the assertions
    // below depend on which one they are sequenced behind -- see the
    // markCompletions settle further down for the full reasoning.
    var markCompletions = [];

    await wireRealPostHandler(page, '**/.netlify/functions/check-email', checkEmailHandler);
    // The submission itself is the one call in this chain that needs its
    // mock operationName minted under a shifted clock (see withPastClock's
    // own doc comment) -- every other real handler call runs under the
    // real, unshifted clock.
    await wireRealPostHandler(page, '**/.netlify/functions/start-pending-generation', startHandler, {
      wrap: function (handler, event) { return withPastClock(60000, function () { return handler(event); }); }
    });
    await wireRealPostHandler(page, '**/.netlify/functions/register-account-passwordless', registerHandler);
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
        return Promise.resolve(handler(event)).then(function (res) {
          markCompletions.push(res);
          return res;
        });
      }
    });

    // ===== The actual wizard.html client flow, entered exactly as a real
    // visitor reaches the wall now: a growth-funnel arrival. unify-all-
    // creation-flows (founder 2026-08-14) retired wizard.html's own chip-build
    // flow (a bare hit redirects to /go/); the ?resume=1&caption=... handoff
    // lands DIRECTLY on the signup wall (no shortcuts/localStorage seeding). =====
    await safeGoto(page, baseUrl + '/wizard.html?resume=1&caption=' + encodeURIComponent('a dream of flying over a glowing city of glass, dreamlike') + '&style=Cinematic');

    // The merged signup wall (tracker item for-product-wizard-signup-
    // wall-is-the-ol-lt1l9j) -- this one submit is the exact moment
    // start-pending-generation.js fires for real (pre-account) AND the
    // real register-account-passwordless.js signup runs in parallel;
    // adoptPendingGeneration + claim-pending-generation.js fire the
    // instant both settle, exactly as wizard.html's real
    // renderSignupWall/completeSignupAndAdvance do.
    await page.waitForSelector('#contact-email');
    await page.fill('#contact-email', FUNNEL_EMAIL);
    await page.click('#fn-contact-continue');

    // home.html's own real resume/poll/completion sequence takes it from
    // here (tracker item for-product-funnel-ending-v2-founder-ins-tfuu0q --
    // processing.html removed, wizard.html now lands directly on home.html)
    // -- this is the client code the founder's own failed QA run actually
    // exercised, now running for real against real handlers.
    await dismissMomentIfPresent(page); // fresh organic wall signup -> dismiss the monetization moment to reach the home handoff
    await page.waitForURL(/home\.html/, { timeout: 20000 });
    await page.waitForSelector('#dreams-row .dream-row-tile:not(.generating), #d0-video.ready', { timeout: 20000 });

    await settle(function () { return claimCalls.length >= 1; });
    assert.equal(claimCalls.length, 1, 'claim-pending-generation must have fired exactly once, for the real funnel pendingId');
    assert.equal(claimCalls[0].email, FUNNEL_EMAIL);
    // Same DOM-gate-vs-node-side-observation race this file's own markCompletions
    // fix below addresses (review finding on this same branch, tracker item
    // test-funnel-real-chain-behavioral-test-j-nmhqx0): the #d0-video.ready gate
    // above settles off onGenerationSettled's synchronous refreshHomeState() call,
    // several statements before DreamStore.markGenerationJustCompleted() actually
    // fires the mark-generation-completed.js request markCalls observes. Settle on
    // markCalls itself rather than relying on the unrelated claimCalls settle above
    // (already satisfied minutes earlier in test-time) to happen to cover it too.
    await settle(function () { return markCalls.length >= 1; });
    assert.ok(markCalls.length >= 1, 'home.html must have called the REAL mark-generation-completed.js at least once');
    assert.equal(markCalls[0].operationName.indexOf('mock:'), 0, 'the operationName reaching mark-generation-completed must be the SAME funnel operationName minted by start-pending-generation.js');

    // The real mark-generation-completed.js call above ENQUEUES the
    // "unwatched dream" retention nudge (lib/unwatched-dream-nudge-store.js's
    // markPending) -- the actual Resend attempt happens later, off this
    // request, via send-unwatched-dream-nudges.js's scheduled scan (the
    // single "your dream is ready to watch" email a signed-up user gets since
    // the founder retired the separate first-dream email on 2026-08-11). This
    // test never had a real thumbnail sync or a real 7-minute wait in play, so
    // seed the thumbnail and force the record past the unwatched floor, then
    // run the scan directly in this same Node process -- proving the REAL
    // downstream send still fires off the REAL enqueued record, not a mocked
    // stand-in.
    var nudgeStore = require('../netlify/functions/lib/unwatched-dream-nudge-store');
    var sendNudges = require('../netlify/functions/send-unwatched-dream-nudges');
    // Wait for the real mark-generation-completed.js invocation to actually
    // RESOLVE before reading the record it is supposed to have enqueued.
    //
    // Why this line exists (root-caused for tracker item test-funnel-real-
    // chain-behavioral-test-j-nmhqx0 -- this test was deterministically red
    // on main, ~3/3, not a flake): `markCalls` is pushed by
    // wireRealPostHandler's own wrap the instant the route is intercepted,
    // BEFORE the awaited handler runs. So `markCalls.length >= 1` above is
    // evidence the request was made, never evidence the handler finished --
    // and the enqueue asserted below is the LAST thing that handler does
    // (verifyOperationCompleted -> markCompleted -> job-owners read ->
    // pending-dreams getWithReadyRetry, which spends a real
    // blobs-retry.DEFAULT_RETRY_DELAY_MS on this funnel path since the
    // record legitimately has no readyAt -> account-store read ->
    // markPending). Measured here: the route was intercepted at ~1788ms and
    // markPending did not land until ~1990ms, while this read ran at
    // ~1881ms, i.e. ~110ms too early, every time.
    //
    // Nothing before this point is causally downstream of the handler
    // resolving: the DOM gate above (#dreams-row/#d0-video) is client-side
    // and settles as soon as the poll loop paints, which happens off the
    // video-status response, not off the mark-generation-completed one.
    // This is exactly the unsound-ordering shape test/helpers/settle.js was
    // written for (see its header comment). The production code is not at
    // fault: a real caller gets its 200 only after markPending has returned.
    await settle(function () { return markCompletions.length >= 1; });
    assert.ok(markCompletions.length >= 1, 'the real mark-generation-completed.js handler must have actually resolved before its enqueue is asserted on');
    var pendingRecord = await nudgeStore.getPending(fakeEvent({}), markCalls[0].operationName);
    assert.ok(pendingRecord, 'the real mark-generation-completed.js call must have enqueued a pending nudge for this exact operationName');
    // Seed the synced thumbnail this operationName's nudge is waiting on -- a
    // real thumbnail is the only thing that makes the scan actually send
    // (no thumbnail = defer, then drop -- never a bare send). Model it landing
    // so this real-chain test still exercises a genuine retention send.
    var dreamStore = require('../netlify/functions/lib/dream-store');
    await dreamStore.upsertPrivateDream(fakeEvent({}), pendingRecord.username, {
      id: 'dream-' + markCalls[0].operationName, ownerHandle: '@' + pendingRecord.username,
      caption: 'Funnel dream', style: 'Cinematic', mediaType: 'video',
      videoUrl: 'https://example.com/v.mp4', imageUrl: 'https://img.example/funnel-thumb.jpg',
      sourceOperationName: markCalls[0].operationName
    });
    // Force the pending nudge past the 7-minute unwatched floor so the scan
    // sends it on this run (the user hasn't watched -- no viewed marker).
    mockBlobs.seed(nudgeStore.PENDING_STORE_NAME, markCalls[0].operationName, Object.assign({}, pendingRecord, {
      triggeredAt: Date.now() - (sendNudges.READY_AGE_MS + 5000)
    }));
    // register-account-passwordless.js's new-account branch fires its own
    // fire-and-forget VERIFICATION email through the same Resend spy (see
    // that file's FIRE-AND-FORGET note) -- count only what the retention
    // scan itself adds, so this assertion stays about the retention email
    // and can't be satisfied (or double-counted) by the signup path's own
    // unrelated send.
    var resendCountBeforeScan = resendCalls.length;
    await sendNudges.scanAndSend(fakeEvent({ headers: { host: 'dreamtube1.netlify.app' } }));

    // THE ACTUAL ASSERTION THIS BUG IS ABOUT: the retention email must have
    // genuinely been attempted, through the real job-owners lookup, the real
    // account-store lookup, and the real unwatched-dream-nudge send -- not a
    // mocked stand-in.
    await settle(function () { return resendCalls.length >= resendCountBeforeScan + 1; });
    var retentionSends = resendCalls.slice(resendCountBeforeScan);
    assert.equal(retentionSends.length, 1, 'THE BUG: the real chain (wizard.html\'s actual client flow driving the real server handlers) must result in exactly one real Resend retention-send attempt for the funnel user');
    assert.deepEqual(retentionSends[0].body.to, [FUNNEL_EMAIL], 'the email must go to the funnel user\'s own real email');
  } finally {
    global.fetch = realFetch;
    await page.close();
  }
});

// =====================================================================
// FUNNEL CHARACTER STASH ADOPTION (start.html, 2026-08-08): the growth
// funnel's flo-arm character sheet stashes Me/Someone character records
// (self photo included) in localStorage on same-origin /go/ handoffs;
// start.html's adoptFunnelCharacterStash consumes the stash one-shot
// into the EXISTING pre-signup `staged` machinery, so the records ride
// the REAL start-pending-generation.js payload exactly as if they had
// been entered in the app wizard. Same real-handler wiring as the chain
// test above: the browser drives the real start.html client code, and
// every /.netlify/functions/* route is answered by the real handler
// module in this Node process.
// =====================================================================

var STASH_KEY = 'dreamtube_funnel_character_stash';
var STASH_PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
var RESUME_PARAMS = 'resume=1&recall=vividly&types=flying&motivations=' + encodeURIComponent('Turn them into videos') + '&style=Cartoon&caption=' + encodeURIComponent('Aerial wide shot of myself and someone I know, flying and floating through the air, in an open sky, Dreamy, surreal mood, hazy ethereal light, Cartoon style, dreamlike.');

/** Drives start.html's live passwordless signup wall far enough for the real start-pending-generation.js call to fire (its submit fires getOrStartPendingGeneration in parallel with the real passwordless registration), with `stash` seeded into localStorage before the page's own scripts run — exactly what the funnel's redirectToApp() leaves behind on a same-origin handoff. Returns { startCalls, stashAfterLoad }. */
async function driveStartHtmlEmailStep(page, stash, email) {
  var startCalls = [];
  var checkEmailHandler = require('../netlify/functions/check-email').handler;
  var startHandler = require('../netlify/functions/start-pending-generation').handler;
  var registerHandler = require('../netlify/functions/register-account-passwordless').handler;
  require('../netlify/functions/lib/email-domain-check').isDomainDeliverable = function () { return Promise.resolve(true); };

  await wireRealPostHandler(page, '**/.netlify/functions/check-email', checkEmailHandler);
  await wireRealPostHandler(page, '**/.netlify/functions/register-account-passwordless', registerHandler);
  await wireRealPostHandler(page, '**/.netlify/functions/start-pending-generation', startHandler, {
    wrap: function (handler, event) {
      startCalls.push(JSON.parse(event.body));
      return withPastClock(60000, function () { return handler(event); });
    }
  });

  // Seed the stash BEFORE any page script runs — the adoption block runs
  // during start.html's own top-level script evaluation.
  await page.addInitScript(function (payload) {
    if (payload.stashJson === null) { localStorage.removeItem(payload.key); return; }
    localStorage.setItem(payload.key, payload.stashJson);
  }, { key: STASH_KEY, stashJson: stash === null ? null : JSON.stringify(stash) });

  await safeGoto(page, baseUrl + '/start.html?' + RESUME_PARAMS);
  var stashAfterLoad = await page.evaluate(function (key) { return localStorage.getItem(key); }, STASH_KEY);

  // Live wall = passwordless (SIGNUP_PASSWORDLESS_LIVE, flipped
  // 2026-08-03): one email field, #fn-s13-continue submit, which fires
  // the real start-pending-generation capture call in parallel with
  // registration.
  await page.waitForSelector('#fn-email');
  await page.fill('#fn-email', email);
  await page.click('#fn-s13-continue');
  await settle(function () { return startCalls.length >= 1; });
  return { startCalls: startCalls, stashAfterLoad: stashAfterLoad };
}

/** Drives wizard.html's funnel-arrival WALL leg (the flo arm's routing target since the wall-routing round): stash seeded pre-load, arrive at ?resume=1&caption&style, assert the Layout-B wall renders directly (veil + email, no chooser, no Subject step), submit, and capture the REAL start-pending-generation.js call. */
async function driveWizardWallArrival(page, stash, email) {
  var startCalls = [];
  var checkEmailHandler = require('../netlify/functions/check-email').handler;
  var startHandler = require('../netlify/functions/start-pending-generation').handler;
  var registerHandler = require('../netlify/functions/register-account-passwordless').handler;
  require('../netlify/functions/lib/email-domain-check').isDomainDeliverable = function () { return Promise.resolve(true); };

  await wireRealPostHandler(page, '**/.netlify/functions/check-email', checkEmailHandler);
  await wireRealPostHandler(page, '**/.netlify/functions/register-account-passwordless', registerHandler);
  await wireRealPostHandler(page, '**/.netlify/functions/start-pending-generation', startHandler, {
    wrap: function (handler, event) {
      startCalls.push(JSON.parse(event.body));
      return withPastClock(60000, function () { return handler(event); });
    }
  });

  await page.addInitScript(function (payload) {
    if (payload.stashJson === null) { localStorage.removeItem(payload.key); return; }
    localStorage.setItem(payload.key, payload.stashJson);
  }, { key: STASH_KEY, stashJson: stash === null ? null : JSON.stringify(stash) });

  await safeGoto(page, baseUrl + '/wizard.html?' + RESUME_PARAMS);
  var arrival = await page.evaluate(function (key) {
    return {
      stashAfterLoad: localStorage.getItem(key),
      onWall: !!document.getElementById('contact-email'),
      veil: !!document.querySelector('.fn-forming-frame'),
      noChooser: !document.getElementById('fn-q-grid'),
      noSubjectStep: !document.getElementById('subject-chip-row')
    };
  }, STASH_KEY);

  await page.fill('#contact-email', email);
  await page.click('#fn-contact-continue');
  await settle(function () { return startCalls.length >= 1; });
  return { startCalls: startCalls, arrival: arrival };
}

test('WIZARD WALL ROUTING: a funnel handoff (?resume=1&caption&style) lands DIRECTLY on wizard.html\'s Layout-B wall (veil, no chooser, no steps), adopts the stash, and the REAL start-pending-generation payload carries the funnel caption VERBATIM plus the photo character byte-identical', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  mockBlobs.reset();
  process.env.GENERATION_MOCK_MODE = 'true';
  ['start-pending-generation', 'check-email', 'register-account-passwordless', 'lib/account-store', 'lib/job-owners', 'lib/pending-dreams', 'lib/rate-limit', 'lib/email-domain-check'].forEach(function (mod) {
    delete require.cache[require.resolve('../netlify/functions/' + mod)];
  });
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var res = await driveWizardWallArrival(page, {
      v: 1,
      savedAt: Date.now(),
      characters: [
        { isSelf: true, name: '', description: 'short brown hair and glasses', photoDataUrl: STASH_PHOTO },
        { isSelf: false, name: 'Maya', description: 'tall, red coat' }
      ]
    }, 'wall-routing@example.com');

    assert.ok(res.arrival.onWall, 'the funnel arrival must land DIRECTLY on the signup wall (THE founder-reported bug: it used to land on start.html\'s old screen 13; a wizard.html arrival used to land on the Subject step)');
    assert.ok(res.arrival.veil, 'the wall must show the forming veil — the approved Layout-B wall, not the old email-only screen');
    assert.ok(res.arrival.noChooser && res.arrival.noSubjectStep, 'no chooser and no wizard steps for a funnel arrival — the dream is already built');
    assert.equal(res.arrival.stashAfterLoad, null, 'the stash must be consumed one-shot on arrival');

    assert.equal(res.startCalls.length, 1, 'exactly one real start-pending-generation call');
    var body = res.startCalls[0];
    assert.equal(body.caption, new URLSearchParams(RESUME_PARAMS).get('caption'), 'the funnel-built caption must ride VERBATIM — never re-assembled from wizard.html\'s empty chip state');
    assert.equal(body.style, 'Cartoon', 'the funnel-chosen style must ride');
    var self = body.characters.filter(function (c) { return c.isSelf; })[0];
    var other = body.characters.filter(function (c) { return !c.isSelf; })[0];
    assert.ok(self, 'the adopted self character must ride the wall\'s generation payload');
    assert.equal(self.photoDataUrl, STASH_PHOTO, 'THE POINT: the funnel-uploaded photo must reach the wall\'s generation payload byte-identical');
    assert.equal(self.description, 'short brown hair and glasses');
    assert.ok(other && other.name === 'Maya' && other.description === 'tall, red coat', 'the Someone character must ride too');
    assert.equal(body.characterIdsForGeneration.length, 2, 'both adopted characters must be SELECTED for generation');
  } finally {
    await page.close();
  }
});

test('CHARACTER STASH: a funnel-stashed self photo+description and Someone record are consumed one-shot and ride the REAL start-pending-generation.js payload through the existing staging path', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  mockBlobs.reset();
  process.env.GENERATION_MOCK_MODE = 'true';
  ['start-pending-generation', 'check-email', 'register-account-passwordless', 'lib/account-store', 'lib/job-owners', 'lib/pending-dreams', 'lib/rate-limit', 'lib/email-domain-check'].forEach(function (mod) {
    delete require.cache[require.resolve('../netlify/functions/' + mod)];
  });
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var res = await driveStartHtmlEmailStep(page, {
      v: 1,
      savedAt: Date.now(),
      characters: [
        { isSelf: true, name: '', description: 'short brown hair and glasses', photoDataUrl: STASH_PHOTO },
        { isSelf: false, name: 'Maya', description: 'tall, red coat' }
      ]
    }, 'stash-adopt@example.com');

    assert.equal(res.stashAfterLoad, null, 'the stash must be CONSUMED (removed) during page load — one-shot semantics');
    assert.equal(res.startCalls.length, 1, 'exactly one real start-pending-generation call');
    var body = res.startCalls[0];
    assert.equal(body.characters.length, 2, 'both stashed characters must ride the generation payload');
    var self = body.characters.filter(function (c) { return c.isSelf; })[0];
    var other = body.characters.filter(function (c) { return !c.isSelf; })[0];
    assert.ok(self, 'the self character must be in the payload');
    assert.equal(self.description, 'short brown hair and glasses');
    assert.equal(self.photoDataUrl, STASH_PHOTO, 'THE POINT OF THE STASH: the photo must reach the generation payload byte-identical');
    assert.ok(other, 'the Someone character must be in the payload');
    assert.equal(other.name, 'Maya');
    assert.equal(other.description, 'tall, red coat');
    assert.ok(!other.photoDataUrl, 'photos are self-only, exactly like the app sheet/store contract');
    assert.equal(body.characterIdsForGeneration.length, 2, 'both adopted characters must be SELECTED for generation');
  } finally {
    await page.close();
  }
});

test('CHARACTER STASH: an EXPIRED stash is consumed but adopts nothing, and invalid records (nameless Someone, non-image photo) are dropped — the payload stays character-free', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  mockBlobs.reset();
  process.env.GENERATION_MOCK_MODE = 'true';
  ['start-pending-generation', 'check-email', 'register-account-passwordless', 'lib/account-store', 'lib/job-owners', 'lib/pending-dreams', 'lib/rate-limit', 'lib/email-domain-check'].forEach(function (mod) {
    delete require.cache[require.resolve('../netlify/functions/' + mod)];
  });

  // Expired stash: valid shape, stale savedAt.
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var res = await driveStartHtmlEmailStep(page, {
      v: 1,
      savedAt: Date.now() - (31 * 60 * 1000),
      characters: [{ isSelf: true, name: '', description: 'stale details', photoDataUrl: STASH_PHOTO }]
    }, 'stash-expired@example.com');
    assert.equal(res.stashAfterLoad, null, 'even an expired stash is consumed (never lingers)');
    assert.equal(res.startCalls[0].characters.length, 0, 'an expired stash must adopt nothing');
    assert.equal(res.startCalls[0].characterIdsForGeneration.length, 0);
  } finally {
    await page.close();
  }

  // Invalid records: a nameless Someone and a non-image "photo" must be
  // dropped by the adoption's validation floor (mirrors the sheets' own
  // Save rules + the photo data-URL check).
  var page2 = await browser.newPage();
  await blockThirdParty(page2);
  try {
    var res2 = await driveStartHtmlEmailStep(page2, {
      v: 1,
      savedAt: Date.now(),
      characters: [
        { isSelf: false, name: '', description: 'has no name' },
        { isSelf: true, name: '', description: '', photoDataUrl: 'javascript:alert(1)' }
      ]
    }, 'stash-invalid@example.com');
    assert.equal(res2.startCalls[0].characters.length, 0, 'invalid records must be dropped, not forwarded to generation');
  } finally {
    await page2.close();
  }
});
