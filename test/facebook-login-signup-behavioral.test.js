// test/facebook-login-signup-behavioral.test.js
//
// Real browser-driven coverage for start.html's Facebook Login path
// (docs/SIGNUP_FACEBOOK_LOGIN_SPEC.md; tracker items
// for-product-priority-founder-2026-07-30--ruzc5u and
// for-product-signup-screen-the-single-big-bkwhbe).
//
// What this file specifically exists to prove, beyond the server-side
// unit coverage in test/facebook-oauth-callback.test.js:
//   - the feature flag genuinely removes the button from the DOM (absent,
//     not hidden) while js/facebook-config.js still holds its placeholder;
//   - with a real App ID configured, the button appears and its click
//     builds a correct OAuth dialog URL + first-party CSRF cookie, and
//     invalidates any in-flight manual signup first;
//   - `staged` characters survive the redirect (persist -> restore ->
//     key cleared), which is the spec's §2.5 "non-obvious requirement";
//   - the return leg with a valid ?bt= skips screen 13 entirely and lands
//     on screen 14 (spec §2.1 step 8);
//   - the return leg with ?fb_error= shows an inline error while leaving
//     the manual email/password fields fully usable (spec §2.4);
//   - the FB-return reload is tagged resumed_from_facebook_redirect
//     (spec §2.6).
//
// The feature flag is turned on for the "configured" tests by
// intercepting the request for js/facebook-config.js and rewriting the
// placeholder — deliberately, rather than by poking window state after
// load, because the file declares `var FACEBOOK_APP_ID` and a pre-load
// window assignment would simply be overwritten. This also exercises the
// real file, not a stand-in.
//
// Playwright itself is NOT a project dependency -- see CLAUDE.md's "No
// test framework is wired in..." section. Every test below skips itself
// with a clear reason if Playwright/the pinned Chromium binary isn't
// resolvable in whatever environment runs `npm test`.

var test = require('node:test');
var assert = require('node:assert/strict');
var staticServer = require('./helpers/static-server');
var signupFlow = require('./helpers/signup-flow');

var CHROMIUM_PATH = '/opt/pw-browsers/chromium';
var FAKE_APP_ID = '1234509876';

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

/** Same base resume params the other funnel behavioral tests use. */
function resumeUrl(caption, extra) {
  return baseUrl + '/start.html?resume=1&signup=unified&style=Cartoon&caption=' + encodeURIComponent(caption) + (extra || '');
}

/**
 * Turns the feature flag ON by rewriting the placeholder in the real
 * js/facebook-config.js as it is served. See this file's header comment
 * for why this and not a window assignment.
 */
function configureFacebookApp(page, appId) {
  return page.route('**/js/facebook-config.js', async function (route) {
    var response = await route.fetch();
    var body = await response.text();
    route.fulfill({
      status: 200,
      contentType: 'text/javascript; charset=utf-8',
      body: body.replace("'REPLACE_WITH_REAL_FACEBOOK_APP_ID'", JSON.stringify(appId || FAKE_APP_ID))
    });
  });
}

/** Catches the full-page navigation to Facebook's OAuth dialog instead of actually leaving for facebook.com. */
function catchFacebookDialog(page) {
  return page.route('https://www.facebook.com/**', function (route) {
    route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>facebook oauth dialog stub</body></html>' });
  });
}

/** Stands in for verify-session-transfer.js, which js/store.js's consumeSessionTransferTokenFromUrlSync posts to (synchronously) on a ?bt= load. */
function mockSessionTransfer(page, result) {
  return page.route('**/.netlify/functions/verify-session-transfer', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(result) });
  });
}

/** The signup-adjacent endpoints the post-signin continuation fires. */
function mockPostSignupRoutes(page) {
  return Promise.all([
    page.route('**/.netlify/functions/start-pending-generation', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pendingId: 'pd-fb-1', operationName: 'fal:fake-model:req-fb-1' }) });
    }),
    page.route('**/.netlify/functions/claim-pending-generation', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, found: true }) });
    }),
    page.route('**/.netlify/functions/track-conversion', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    }),
    page.route('**/.netlify/functions/get-feed', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ feed: [], dreamOfDayId: null }) });
    })
  ]);
}

/** As of 2026-07-31 (tracker item for-product-urgent-founder-screenshots-i-g64gjp), start.html's former characters and "preparing" transition screens were removed outright -- a fresh ?resume=1 load lands directly on screen 13. */
async function reachScreen13(page, caption, extra) {
  await safeGoto(page, resumeUrl(caption, extra));
  await page.waitForSelector('#fn-email', { timeout: 5000 });
}

function readPostHogCalls(page) {
  return page.evaluate(function () {
    return (window.posthog && typeof window.posthog.slice === 'function') ? window.posthog.slice() : [];
  });
}

// ===========================================================================
// Feature flag — the button must be ABSENT, not hidden, until a real App ID
// exists (spec §2.4's "Flag OFF" row, §4).
// ===========================================================================

test('feature flag OFF (placeholder App ID): renders NO Facebook button anywhere in the DOM', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await reachScreen13(page, 'Flying over the ocean at sunset');

    assert.ok((await page.$('#fn-fb-continue')) === null, 'the button element must not exist at all');
    // Scoped to the funnel's own rendered screen (NOT document.body,
    // which also contains this page's inline <script> source and would
    // match on a code comment rather than real markup).
    var anyFbMarkup = await page.evaluate(function () {
      return document.getElementById('fnScreen').innerHTML.indexOf('Facebook') !== -1;
    });
    assert.equal(anyFbMarkup, false, 'no Facebook markup may be written into the screen while the flag is a placeholder');

    // And the screen is otherwise exactly as before.
    assert.ok(await page.$('#fn-email'), 'the email field is untouched');
  } finally {
    await context.close();
  }
});

test('feature flag ON: renders the Facebook button above the email field, Meta-brand-compliant', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await configureFacebookApp(page);
    await reachScreen13(page, 'Flying over the ocean at sunset');

    var btn = await page.$('#fn-fb-continue');
    assert.ok(btn, 'the button must render once a real App ID is configured');
    assert.equal((await btn.textContent()).trim(), 'Continue with Facebook', 'Meta requires this exact copy');
    var bg = await btn.evaluate(function (el) { return getComputedStyle(el).backgroundColor; });
    assert.equal(bg, 'rgb(24, 119, 242)', 'Meta requires the approved #1877F2 blue');

    // Direction Y placement: additive, ABOVE the existing email field,
    // with nothing else restructured.
    var buttonIsAboveEmail = await page.evaluate(function () {
      var b = document.getElementById('fn-fb-continue').getBoundingClientRect();
      var e = document.getElementById('fn-email').getBoundingClientRect();
      return b.top < e.top;
    });
    assert.equal(buttonIsAboveEmail, true);
    assert.ok(await page.$('#fn-email'), 'the email field still exists (Direction Y: nothing removed)');
    assert.ok((await page.$('#fn-fb-divider')) === null, 'Direction Y adds no divider');
  } finally {
    await context.close();
  }
});

// ===========================================================================
// Mobile-webview QA -- this traffic is FB/IG in-app-browser dominant (spec
// §1). Real Instagram/Facebook in-app UA + a real FB/IG-webview-sized
// viewport (same 390x844 convention test/record-mode-behavioral.test.js
// uses), not just an assumption that the desktop-viewport coverage above
// generalizes. Capability-detected (real UA), not guessed.
// ===========================================================================

var MOBILE_WEBVIEW_VIEWPORT = { width: 390, height: 844 };
var IG_ANDROID_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/119.0.0.0 Mobile Safari/537.36 Instagram 302.0.0.23.114 Android (33/13; 420dpi; 1080x2246; google/redfin/redfin:13; en_US; 538815920)';
var FB_IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/400.0.0.0.100;FBBV/1;FBDV/iPhone14,2;FBMD/iPhone;FBSN/iOS;FBSV/16.0;FBSS/3;FBID/phone;FBLC/en_US]';

[
  { host: 'Instagram', userAgent: IG_ANDROID_UA },
  { host: 'Facebook', userAgent: FB_IOS_UA }
].forEach(function (scenario) {
  test('mobile-webview QA (' + scenario.host + '): the Facebook button meets a real tap-target minimum, causes no horizontal overflow, and the password step\'s hardened input attributes are present, all inside a real ' + scenario.host + ' in-app-browser UA + viewport', async function (t) {
    if (unavailableReason) { t.skip(unavailableReason); return; }
    var context = await browser.newContext({ viewport: MOBILE_WEBVIEW_VIEWPORT, userAgent: scenario.userAgent });
    try {
      var page = await context.newPage();
      await blockThirdParty(page);
      await configureFacebookApp(page);
      await reachScreen13(page, 'Flying over the ocean at sunset');

      var btnBox = await page.evaluate(function () {
        var r = document.getElementById('fn-fb-continue').getBoundingClientRect();
        return { width: r.width, height: r.height };
      });
      // 44px is the widely-cited minimum comfortable tap target (Apple HIG /
      // Meta's own button spec both meet or exceed it) -- this app has a
      // documented history of tap-target-sizing regressions (see CLAUDE.md),
      // so this is checked directly rather than assumed from desktop layout.
      assert.ok(btnBox.height >= 44, 'the Facebook button must meet a real tap-target minimum on a real mobile webview viewport, got height=' + btnBox.height);

      var overflowsHorizontally = await page.evaluate(function () {
        return document.documentElement.scrollWidth > document.documentElement.clientWidth;
      });
      assert.equal(overflowsHorizontally, false, 'the signup screen must not cause horizontal overflow at a real FB/IG in-app-browser viewport width (390px)');

      // The password step, one interaction further in, must be reachable
      // -- not just the email step's first paint -- and carry the silent
      // webview-safe input attributes (see start.html's own WEBVIEW
      // PASSWORD MITIGATION doc comment; deliberately no on-screen
      // explainer text here, per FOUNDER_PRINCIPLES.md's "capability-
      // detect and HIDE, don't handhold" lesson).
      await page.fill('#fn-email', 'mobile-webview-qa@example.com');
      await page.click('#fn-s13-email-continue');
      await page.waitForSelector('#fn-password', { timeout: 5000 });

      var overflowsAfterPasswordStep = await page.evaluate(function () {
        return document.documentElement.scrollWidth > document.documentElement.clientWidth;
      });
      assert.equal(overflowsAfterPasswordStep, false, 'the password step must not cause horizontal overflow either');

      var pwAttrs = await page.evaluate(function () {
        var el = document.getElementById('fn-password');
        return { autocapitalize: el.getAttribute('autocapitalize'), autocorrect: el.getAttribute('autocorrect'), spellcheck: el.getAttribute('spellcheck') };
      });
      assert.equal(pwAttrs.autocapitalize, 'off');
      assert.equal(pwAttrs.autocorrect, 'off');
      assert.equal(pwAttrs.spellcheck, 'false');
    } finally {
      await context.close();
    }
  });
});

// ===========================================================================
// The click handler — CSRF cookie, OAuth URL, in-flight-signup invalidation.
// ===========================================================================

test('clicking the Facebook button sets a first-party CSRF cookie and navigates to a correctly-formed OAuth dialog URL whose state carries that same nonce', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await configureFacebookApp(page);
    await catchFacebookDialog(page);
    await reachScreen13(page, 'Flying over the ocean at sunset');

    await Promise.all([
      page.waitForURL(/facebook\.com/, { timeout: 5000 }),
      page.click('#fn-fb-continue')
    ]);

    var dialog = new URL(page.url());
    assert.equal(dialog.pathname.indexOf('/dialog/oauth') !== -1, true);
    assert.equal(dialog.searchParams.get('client_id'), FAKE_APP_ID);
    assert.equal(dialog.searchParams.get('scope'), 'email');
    assert.equal(dialog.searchParams.get('response_type'), 'code');
    assert.equal(dialog.searchParams.get('redirect_uri'), baseUrl + '/.netlify/functions/facebook-oauth-callback');

    var state = dialog.searchParams.get('state');
    assert.ok(state, 'a state param is required');
    var decoded = JSON.parse(Buffer.from(state.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    assert.match(decoded.n, /^[0-9a-f]{32}$/, 'the nonce must be random hex');
    // The funnel's own params are packed in, so the callback can bring
    // the visitor back to the same dream.
    var resume = new URLSearchParams(decoded.r);
    assert.equal(resume.get('resume'), '1');
    assert.equal(resume.get('style'), 'Cartoon');
    assert.equal(resume.get('caption'), 'Flying over the ocean at sunset');

    var cookies = await context.cookies();
    var stateCookie = cookies.filter(function (c) { return c.name === 'dt_fb_state'; })[0];
    assert.ok(stateCookie, 'the CSRF cookie must be set before leaving');
    assert.equal(stateCookie.value, decoded.n, 'the cookie must carry the SAME nonce the state does');
    assert.equal(stateCookie.sameSite, 'Lax', 'Strict would be dropped on the return navigation from facebook.com');
  } finally {
    await context.close();
  }
});

test('tapping Facebook after backing out of a mid-manual-signup attempt (via "Change email") invalidates it a SECOND, independent time — a late-settling register-account response can no longer force-navigate or commit a session', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await configureFacebookApp(page);
    // Answer the outbound navigation with 204 No Content: a browser
    // leaves the current document in place for a 204 on a top-level
    // navigation, so the page survives and the abandoned attempt's late
    // settlement stays observable. (An abort() would replace the document
    // with an error page and take DreamStore with it.) The navigation
    // itself is covered by the test above; the point here is what happens
    // to the attempt that was left behind.
    await page.route('https://www.facebook.com/**', function (route) { route.fulfill({ status: 204, body: '' }); });

    var releaseRegister = null;
    await page.route('**/.netlify/functions/check-email', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, available: true }) });
    });
    await page.route('**/.netlify/functions/register-account', function (route) {
      // Held open, so the manual attempt is genuinely in flight when the
      // Facebook button is tapped, and only released afterwards.
      releaseRegister = function () {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, username: 'inflight', email: 'inflight@example.com', authToken: 'auth-inflight' }) });
      };
    });
    await page.route('**/.netlify/functions/start-pending-generation', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pendingId: 'pd-x', operationName: 'op-x' }) });
    });

    await reachScreen13(page, 'Flying over the ocean at sunset');

    await signupFlow.advanceToPasswordStep(page, 'inflight@example.com');
    await page.fill('#fn-password', 'apassword1');
    await page.click('#fn-s13-continue');
    await page.waitForFunction(function () {
      var b = document.getElementById('fn-s13-continue');
      return b && b.disabled;
    }, null, { timeout: 5000 });

    // Direction Y placement means the Facebook button lives on the EMAIL
    // step's markup only (facebookSignupButtonHtml() is called from
    // renderEmailStep, never renderPasswordStep -- see that function's own
    // comment) -- unlike the retired single-step control variant, where
    // both the button and the password field sat on the same screen at
    // once, there is no DOM state where #fn-fb-continue and an in-flight
    // #fn-s13-continue submission coexist anymore. The reachable path to
    // Facebook from mid-flight is via "Change email" first (already its
    // own, separately-tested invalidation trigger -- see the money-leak/
    // navigation-guard test files) -- this test's job is to prove
    // Facebook's OWN invalidation call is a real, independent second layer
    // on top of that, not a no-op that happens to pass only because
    // Change-email already did the job.
    await page.click('#fn-s13-change-email');
    await page.waitForSelector('#fn-fb-continue', { timeout: 5000 });

    var calls = await page.evaluate(function () {
      window.__invalidateCalls = 0;
      var original = DreamStore.invalidatePendingSignup;
      DreamStore.invalidatePendingSignup = function () { window.__invalidateCalls++; return original.apply(DreamStore, arguments); };
      document.getElementById('fn-fb-continue').click();
      return window.__invalidateCalls;
    });
    assert.equal(calls, 1, 'the Facebook click must call DreamStore.invalidatePendingSignup itself, a real second layer on top of Change-email\'s own call');
    await page.waitForFunction(function () { return true; });

    // Now let the abandoned signup finally settle.
    assert.ok(releaseRegister, 'register-account must have been reached');
    releaseRegister();
    await page.waitForTimeout(500);

    assert.ok((await page.$('#fn-s14-continue')) === null, 'an abandoned attempt must never force-navigate the visitor forward');
    var user = await page.evaluate(function () { return DreamStore.getCurrentUser(); });
    assert.equal(user, null, 'the store-level commit must have been stopped too');
  } finally {
    await context.close();
  }
});

test('the Facebook click calls DreamStore.invalidatePendingSignup (store-level guard), not just the page-local token bump', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await configureFacebookApp(page);
    // Block the navigation entirely so the page survives to be inspected.
    await page.route('https://www.facebook.com/**', function (route) { route.abort(); });
    await reachScreen13(page, 'Flying over the ocean at sunset');

    var calls = await page.evaluate(function () {
      window.__invalidateCalls = 0;
      var original = DreamStore.invalidatePendingSignup;
      DreamStore.invalidatePendingSignup = function () { window.__invalidateCalls++; return original.apply(DreamStore, arguments); };
      document.getElementById('fn-fb-continue').click();
      return window.__invalidateCalls;
    });
    assert.equal(calls, 1, 'invalidatePendingSignup must be called exactly once, before navigating');
  } finally {
    await context.close();
  }
});

// ===========================================================================
// staged characters must survive the redirect (spec §2.5).
//
// REMOVED (not replaced): the test that used to prove persistence -- reach
// start.html's Advanced > Characters screen via the real UI, stage a
// character, then click "Continue with Facebook" and check the persisted
// localStorage snapshot -- is gone. That screen (renderScreenAdvChars) was
// removed outright 2026-07-31 (tracker item
// for-product-urgent-founder-screenshots-i-g64gjp), and `staged` is a
// private closure variable inside start.html's own script (never exposed on
// window), so there is no longer any way -- real UI or test-only injection
// -- to get non-empty staged character data into this page before a
// Facebook click. persistStagedForFacebookRedirect() itself is untouched
// and still fires on every real Facebook click (see start.html's own
// comment on that function), it just now always serializes an empty
// `staged` -- functionally identical to any caption that never triggered
// the old screen in the first place. The RESTORE half below still gets
// full, real coverage: it seeds the post-redirect localStorage snapshot
// directly (never depends on the removed screen), so it keeps proving
// restoreStagedFromFacebookRedirect's own correctness on real, live code.
// ===========================================================================

test('on the Facebook return leg, staged characters are restored into real DreamStore characters and the localStorage key is cleared', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    // Simulate exactly what the pre-redirect persist wrote.
    await context.addInitScript(function () {
      localStorage.setItem('dreamtube_fb_staged_characters', JSON.stringify({
        savedAt: Date.now(),
        staged: {
          characters: [{ id: 'local-1', name: 'Sister', description: 'long dark hair, red coat', isSelf: false, photoDataUrl: null }],
          selectedIds: ['local-1']
        }
      }));
    });
    var page = await context.newPage();
    await blockThirdParty(page);
    await configureFacebookApp(page);
    await mockPostSignupRoutes(page);
    await mockSessionTransfer(page, { ok: true, username: 'fbreturner', email: 'fbreturner@example.com', authToken: 'auth-1' });

    await safeGoto(page, resumeUrl('Flying over the ocean at sunset', '&bt=transfer-token-1&fb=signup'));
    await page.waitForSelector('#fn-s14-continue', { timeout: 8000 });

    var result = await page.evaluate(function () {
      return {
        characters: DreamStore.getCharacters().map(function (c) { return c.name; }),
        draftIds: (DreamStore.getDraft().characterIds || []).length,
        leftover: localStorage.getItem('dreamtube_fb_staged_characters')
      };
    });
    assert.deepEqual(result.characters, ['Sister'], 'the staged character must become a real DreamStore character');
    assert.equal(result.draftIds, 1, 'and stay selected on the draft');
    assert.equal(result.leftover, null, 'the scoped key must be cleared immediately after restoring');
  } finally {
    await context.close();
  }
});

test('a stale staged snapshot from an abandoned round trip is discarded, not silently applied to a later, different dream', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await context.addInitScript(function () {
      localStorage.setItem('dreamtube_fb_staged_characters', JSON.stringify({
        savedAt: Date.now() - (2 * 60 * 60 * 1000), // two hours ago
        staged: { characters: [{ id: 'old-1', name: 'Ghost', description: 'from a previous dream', isSelf: false }], selectedIds: ['old-1'] }
      }));
    });
    var page = await context.newPage();
    await blockThirdParty(page);
    await configureFacebookApp(page);
    await mockPostSignupRoutes(page);
    await mockSessionTransfer(page, { ok: true, username: 'staleuser', email: 'staleuser@example.com', authToken: 'auth-2' });

    await safeGoto(page, resumeUrl('Flying over the ocean at sunset', '&bt=transfer-token-2'));
    await page.waitForSelector('#fn-s14-continue', { timeout: 8000 });

    var names = await page.evaluate(function () { return DreamStore.getCharacters().map(function (c) { return c.name; }); });
    assert.deepEqual(names, [], 'an aged-out snapshot must never resurface');
  } finally {
    await context.close();
  }
});

test('a normal (non-Facebook) load clears any orphaned staged snapshot rather than leaving it to linger', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await context.addInitScript(function () {
      localStorage.setItem('dreamtube_fb_staged_characters', JSON.stringify({ savedAt: Date.now(), staged: { characters: [], selectedIds: [] } }));
    });
    var page = await context.newPage();
    await blockThirdParty(page);
    await safeGoto(page, resumeUrl('Flying over the ocean at sunset'));
    await page.waitForSelector('#fn-email', { timeout: 5000 });
    var leftover = await page.evaluate(function () { return localStorage.getItem('dreamtube_fb_staged_characters'); });
    assert.equal(leftover, null);
  } finally {
    await context.close();
  }
});

// ===========================================================================
// The return leg: skip screen 13 when already signed in (spec §2.1 step 8).
// ===========================================================================

test('returning with a valid ?bt= skips screen 13 entirely and lands on screen 14, signed in', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await configureFacebookApp(page);
    await mockPostSignupRoutes(page);
    await mockSessionTransfer(page, { ok: true, username: 'skipuser', email: 'skipuser@example.com', authToken: 'auth-3' });

    await safeGoto(page, resumeUrl('Flying over the ocean at sunset', '&bt=transfer-token-3&fb=signup'));
    await page.waitForSelector('#fn-s14-continue', { timeout: 8000 });

    assert.ok((await page.$('#fn-email')) === null, 'the signup screen must never render for an already-signed-in visitor');
    assert.ok((await page.$('#fn-password')) === null);
    var user = await page.evaluate(function () { return DreamStore.getCurrentUser(); });
    assert.equal(user.username, 'skipuser');
    // And the ?bt= is not left sitting in the address bar.
    assert.equal(new URL(page.url()).searchParams.get('bt'), null);
  } finally {
    await context.close();
  }
});

// REMOVED (not replaced): the test that used to prove the ?bt= skip was
// index-based rather than hardcoded -- by reaching screen 14 for a dream
// whose caption also brought up the (conditionally included)
// characters screen, shifting screen 13/SIGNUP_STEP's index by one -- no
// longer applies. The characters screen (renderScreenAdvChars) was removed
// outright 2026-07-31 (tracker item
// for-product-urgent-founder-screenshots-i-g64gjp) and is never
// conditionally included anymore, so SIGNUP_STEP is now always trivially 0
// -- there is no longer a variable-index case to guard against here. The
// test just above this one (a plain, no-characters dream) still covers the
// ?bt= skip itself.

test('the return leg fires the generate-during-signup kickoff with the now-known email, and adopts the pending generation', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await configureFacebookApp(page);
    await mockPostSignupRoutes(page);
    await mockSessionTransfer(page, { ok: true, username: 'genuser', email: 'genuser@example.com', authToken: 'auth-4' });

    var pendingBodies = [];
    var claimBodies = [];
    await page.route('**/.netlify/functions/start-pending-generation', function (route) {
      pendingBodies.push(JSON.parse(route.request().postData() || '{}'));
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pendingId: 'pd-fb-9', operationName: 'fal:fake-model:req-fb-9' }) });
    });
    await page.route('**/.netlify/functions/claim-pending-generation', function (route) {
      claimBodies.push(JSON.parse(route.request().postData() || '{}'));
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, found: true }) });
    });

    await safeGoto(page, resumeUrl('Flying over the ocean at sunset', '&bt=transfer-token-4'));
    await page.waitForSelector('#fn-s14-continue', { timeout: 8000 });
    await page.waitForFunction(function () { return true; });

    assert.equal(pendingBodies.length, 1, 'exactly one generation is started');
    assert.equal(pendingBodies[0].email, 'genuser@example.com', 'fired with the server-verified email, not a client-typed one');
    assert.equal(pendingBodies[0].caption, 'Flying over the ocean at sunset');
    assert.equal(claimBodies.length, 1);
    assert.equal(claimBodies[0].pendingId, 'pd-fb-9');
  } finally {
    await context.close();
  }
});

test('the return leg fires CompleteRegistration with the signed-in email, exactly once', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await configureFacebookApp(page);
    await mockPostSignupRoutes(page);
    await mockSessionTransfer(page, { ok: true, username: 'cruser', email: 'cruser@example.com', authToken: 'auth-5' });

    var conversions = [];
    await page.route('**/.netlify/functions/track-conversion', function (route) {
      conversions.push(JSON.parse(route.request().postData() || '{}'));
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await safeGoto(page, resumeUrl('Flying over the ocean at sunset', '&bt=transfer-token-5&fb=signup'));
    await page.waitForSelector('#fn-s14-continue', { timeout: 8000 });

    var registrations = conversions.filter(function (c) { return c.event_name === 'CompleteRegistration'; });
    assert.equal(registrations.length, 1, 'exactly one CompleteRegistration');
    assert.equal(registrations[0].email, 'cruser@example.com');
    assert.ok(registrations[0].event_id, 'the shared Pixel/CAPI event_id convention must be preserved');
    // Screen 13's own impression event must NOT have fired -- the visitor
    // never saw that screen.
    var reached = conversions.filter(function (c) { return c.event_name === 'ReachedEmailEntry'; });
    assert.equal(reached.length, 0, 'a skipped screen 13 must not report an email-entry impression');
  } finally {
    await context.close();
  }
});

test('the return leg with fb=login (an existing email match) fires ZERO CompleteRegistration events -- spec §2.2, counted as a login, not a new signup', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await configureFacebookApp(page);
    await mockPostSignupRoutes(page);
    await mockSessionTransfer(page, { ok: true, username: 'loginuser', email: 'loginuser@example.com', authToken: 'auth-6' });

    var conversions = [];
    await page.route('**/.netlify/functions/track-conversion', function (route) {
      conversions.push(JSON.parse(route.request().postData() || '{}'));
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await safeGoto(page, resumeUrl('Flying over the ocean at sunset', '&bt=transfer-token-6&fb=login'));
    await page.waitForSelector('#fn-s14-continue', { timeout: 8000 });

    var registrations = conversions.filter(function (c) { return c.event_name === 'CompleteRegistration'; });
    assert.equal(registrations.length, 0, 'a returning Facebook user logging back in must never fire a duplicate CompleteRegistration');
  } finally {
    await context.close();
  }
});

test('a ?bt= that does not resolve fails closed to the ordinary signup screen with an inline error, fields fully usable', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await configureFacebookApp(page);
    await mockPostSignupRoutes(page);
    await mockSessionTransfer(page, { ok: false });

    await safeGoto(page, resumeUrl('Flying over the ocean at sunset', '&bt=expired-token'));
    await page.waitForSelector('#fn-email', { timeout: 8000 });

    var err = (await page.textContent('#fn-signup-error')).trim();
    assert.ok(err.length > 0, 'an inline explanation is required');
    assert.ok(/facebook/i.test(err), 'the message must say what actually failed: ' + err);
    assert.equal(await page.isEnabled('#fn-email'), true);
    assert.equal(await page.isEnabled('#fn-s13-email-continue'), true);
    // The password step, one field further in, is reachable too — the
    // fallback is fully usable end to end, not just its first field.
    await signupFlow.advanceToPasswordStep(page, 'fallback-after-failed-bt@example.com');
    assert.equal(await page.isEnabled('#fn-password'), true);
    assert.equal(await page.isEnabled('#fn-s13-continue'), true);
    var user = await page.evaluate(function () { return DreamStore.getCurrentUser(); });
    assert.equal(user, null, 'no session may be established from an unresolvable token');
  } finally {
    await context.close();
  }
});

// ===========================================================================
// Error states on the return leg (spec §2.4).
// ===========================================================================

[
  { slug: 'csrf', match: /went wrong/i },
  { slug: 'denied', match: /cancelled/i },
  { slug: 'exchange_failed', match: /went wrong/i },
  { slug: 'rate_limited', match: /too many/i }
].forEach(function (scenario) {
  test('fb_error=' + scenario.slug + ' renders an inline error while leaving the manual signup path fully usable', async function (t) {
    if (unavailableReason) { t.skip(unavailableReason); return; }
    var context = await browser.newContext();
    try {
      var page = await context.newPage();
      await blockThirdParty(page);
      await configureFacebookApp(page);
      await mockPostSignupRoutes(page);

      await safeGoto(page, resumeUrl('Flying over the ocean at sunset', '&fb_error=' + scenario.slug));
      await page.waitForSelector('#fn-email', { timeout: 8000 });

      var err = (await page.textContent('#fn-signup-error')).trim();
      assert.match(err, scenario.match);
      assert.equal(await page.isEnabled('#fn-email'), true, 'the email field must remain usable as the fallback');
      assert.ok(await page.$('#fn-fb-continue'), 'the Facebook button stays available to retry');
    } finally {
      await context.close();
    }
  });
});

// ===========================================================================
// The "needs email" edge case (spec §2.4 / §3 step 3).
// ===========================================================================

test('fb_needs_email renders one minimal extra email field (no password), and completing it re-enters through the normal ?bt= path', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await configureFacebookApp(page);
    await mockPostSignupRoutes(page);
    await mockSessionTransfer(page, { ok: true, username: 'needsemail', email: 'needsemail@example.com', authToken: 'auth-6' });

    var completions = [];
    await page.route('**/.netlify/functions/facebook-complete-signup', function (route) {
      completions.push(JSON.parse(route.request().postData() || '{}'));
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, transferToken: 'transfer-from-completion', created: true }) });
    });

    await safeGoto(page, resumeUrl('Flying over the ocean at sunset', '&fb_needs_email=marker-abc'));
    await page.waitForSelector('#fn-fb-email-continue', { timeout: 8000 });

    assert.ok((await page.$('#fn-password')) === null, 'a Facebook-only account never asks for a password');
    assert.ok(await page.$('#fn-email'));

    await page.fill('#fn-email', 'supplied@example.com');
    await page.click('#fn-fb-email-continue');
    await page.waitForSelector('#fn-s14-continue', { timeout: 8000 });

    assert.equal(completions.length, 1);
    assert.equal(completions[0].token, 'marker-abc');
    assert.equal(completions[0].email, 'supplied@example.com');
    var user = await page.evaluate(function () { return DreamStore.getCurrentUser(); });
    assert.equal(user.username, 'needsemail');
  } finally {
    await context.close();
  }
});

test('fb_needs_email: a server-refused (already-registered) email shows an inline error and keeps the escape hatch back to ordinary email signup', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await configureFacebookApp(page);
    await mockPostSignupRoutes(page);
    await page.route('**/.netlify/functions/facebook-complete-signup', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'E5: email_taken' }) });
    });

    await safeGoto(page, resumeUrl('Flying over the ocean at sunset', '&fb_needs_email=marker-def'));
    await page.waitForSelector('#fn-fb-email-continue', { timeout: 8000 });
    await page.fill('#fn-email', 'taken@example.com');
    await page.click('#fn-fb-email-continue');

    await page.waitForFunction(function () {
      var el = document.getElementById('fn-signup-error');
      return el && el.textContent.indexOf('already have an account') !== -1;
    }, null, { timeout: 5000 });

    // The escape hatch drops back to the ordinary signup form -- its email
    // step first (the sole screen 13 entry point now), then the password
    // step one interaction further in, same as any other fresh arrival.
    await page.click('#fn-fb-email-fallback');
    await page.waitForSelector('#fn-s13-email-continue', { timeout: 5000 });
    await signupFlow.advanceToPasswordStep(page, 'ordinary-fallback@example.com');
    assert.ok(await page.$('#fn-s13-continue'), 'the normal signup form is reachable');
  } finally {
    await context.close();
  }
});

// ===========================================================================
// Analytics fidelity (spec §2.6).
// ===========================================================================

test('every event on a Facebook-return load carries resumed_from_facebook_redirect:true, and a normal load carries none', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await configureFacebookApp(page);
    await mockPostSignupRoutes(page);
    await mockSessionTransfer(page, { ok: true, username: 'analyticsuser', email: 'analyticsuser@example.com', authToken: 'auth-7' });

    await safeGoto(page, resumeUrl('Flying over the ocean at sunset', '&bt=transfer-token-7'));
    await page.waitForSelector('#fn-s14-continue', { timeout: 8000 });

    var calls = await readPostHogCalls(page);
    var captures = calls.filter(function (c) { return c[0] === 'capture'; });
    assert.ok(captures.length > 0, 'expected some captured events');
    captures.forEach(function (c) {
      assert.equal(c[2] && c[2].resumed_from_facebook_redirect, true, c[1] + ' must be tagged as a Facebook-return event');
    });
    // And critically, the skipped screen 13 never reported an impression.
    var stepViews = captures.filter(function (c) { return c[1] === 'funnel_step_viewed'; });
    assert.ok(stepViews.every(function (c) { return c[2].screen !== 'email_capture'; }),
      'a skipped screen 13 must not appear as a funnel_step_viewed impression');
  } finally {
    await context.close();
  }
});

test('a normal (non-Facebook) load is NOT tagged with resumed_from_facebook_redirect', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await reachScreen13(page, 'Flying over the ocean at sunset');

    var calls = await readPostHogCalls(page);
    calls.filter(function (c) { return c[0] === 'capture'; }).forEach(function (c) {
      assert.equal(c[2] && c[2].resumed_from_facebook_redirect, undefined, c[1] + ' must not be tagged on a normal load');
    });
  } finally {
    await context.close();
  }
});

// ===========================================================================
// No regression to the existing manual signup path.
// ===========================================================================

test('manual email/password signup still completes end-to-end through the refactored shared continuation', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await configureFacebookApp(page);
    await mockPostSignupRoutes(page);

    var claimBodies = [];
    await page.route('**/.netlify/functions/check-email', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, available: true }) });
    });
    await page.route('**/.netlify/functions/register-account', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, username: 'manualuser', email: 'manual@example.com', authToken: 'auth-m' }) });
    });
    await page.route('**/.netlify/functions/claim-pending-generation', function (route) {
      claimBodies.push(JSON.parse(route.request().postData() || '{}'));
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, found: true }) });
    });

    await reachScreen13(page, 'Flying over the ocean at sunset');
    await signupFlow.advanceToPasswordStep(page, 'manual@example.com');
    await page.fill('#fn-password', 'apassword1');
    await page.click('#fn-s13-continue');
    await page.waitForSelector('#fn-s14-continue', { timeout: 8000 });

    var user = await page.evaluate(function () { return DreamStore.getCurrentUser(); });
    assert.ok(user, 'a real session must exist after manual signup');
    assert.equal(claimBodies.length, 1, 'the pending generation must still be claimed exactly once');
    assert.equal(claimBodies[0].email, 'manual@example.com');
  } finally {
    await context.close();
  }
});
