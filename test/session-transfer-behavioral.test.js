// test/session-transfer-behavioral.test.js
//
// Real browser-driven coverage for the CLIENT side of tracker.html's
// for-product-bug-fix-founder-high-in-app--sv3mym item (founder-reported,
// HIGH priority): the session-transfer token round trip added to
// processing.html/result.html via js/store.js's mintSessionTransferToken/
// maintainSessionTransferUrl/consumeSessionTransferTokenFromUrlSync, plus
// the "Copy link for your browser" fix for the iOS in-app-nudge button
// that used to do nothing (see test/wait-screen-reassurance-and-inapp-
// nudge-behavioral.test.js for the pre-existing nudge-card coverage this
// builds on — that file's own iOS test still passes unchanged: this fix
// adds a real action alongside the existing hint-emphasis behavior, it
// doesn't remove it).
//
// EXTENDED for tracker item for-product-webview-notify-escape-nudge--5yray5
// (founder round-2 feedback, real live FB in-app-webview funnel test): (1)
// a persistent (non-auto-dismissing) post-copy instruction line alongside
// the existing toast, and (2) porting the same "Copy link for your browser"
// fix to create.html's SEPARATE, previously-unfixed copy of this same
// pattern (#rec-inapp-open-btn, shown when Record mode detects mic access
// is blocked in a webview) — that one still unconditionally said "Open in
// my browser" and did nothing on non-Android, the exact "misleading fake
// button" the founder reported. Wires create.html into the session-transfer
// chain for the first time in the process, since it never consumed/minted
// ?bt= tokens before this fix.
//
// The REAL server-side token mechanics (single-use, TTL, password-gated
// minting) have direct Node-level coverage in test/session-transfer.test.js
// — this file stubs both endpoints via page.route() (this repo's static
// test server doesn't run real Netlify Functions, see helpers/
// static-server.js's own header comment) and focuses purely on what the
// BROWSER does with those responses: does it attach ?bt= to its own URL,
// does it commit a session from a valid token, does it strip the param,
// does an invalid token fall through silently, and — the specific leak
// this feature's own security notes call out — does the token ever end up
// on a URL other than processing.html/result.html's own address bar.

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

/** Aborts requests to third-party hosts every page here loads -- see CLAUDE.md on this sandbox's outbound network, and every other *-behavioral.test.js's identical helper. */
function blockThirdParty(page) {
  return page.route(/fonts\.(googleapis|gstatic)\.com|connect\.facebook\.net|i\.posthog\.com/, function (route) {
    route.abort();
  });
}

var IG_ANDROID_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/119.0.0.0 Mobile Safari/537.36 Instagram 302.0.0.23.114 Android (33/13; 420dpi; 1080x2246; google/redfin/redfin:13; en_US; 538815920)';
var FB_IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/400.0.0.0.100;FBBV/1;FBDV/iPhone14,2;FBMD/iPhone;FBSN/iOS;FBSV/16.0;FBSS/3;FBID/phone;FBLC/en_US]';
var NORMAL_IOS_SAFARI_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';

/** Same shape as wait-screen-reassurance-and-inapp-nudge-behavioral.test.js's seedAccountWithDraft -- a signed-in account (with a real cached password, required for mintSessionTransferToken to have anything to send) plus a caption+style draft, landing processing.html on its normal fresh-generation path. */
async function seedAccountWithDraft(page, opts) {
  await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function (o) {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@' + o.username, username: o.username };
    if (!state.accounts) state.accounts = {};
    state.accounts[o.username] = { password: o.password || 'testpass1', email: o.email || (o.username + '@example.com') };
    if (!state.dreams) state.dreams = [];
    state.draft = Object.assign({ caption: 'A dream about flying over the city', style: 'Cinematic', mediaType: 'video' }, o.draft || {});
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, opts);
}

/** Signed-in account (with a completed, optionally published dream) for result.html, mirroring test/ui-behavioral.test.js's seedResultPage shape. */
async function seedAccountWithDream(page, opts) {
  await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function (o) {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@' + o.username, username: o.username };
    if (!state.accounts) state.accounts = {};
    state.accounts[o.username] = { password: o.password || 'testpass1', email: o.email || (o.username + '@example.com') };
    if (!state.dreams) state.dreams = [];
    state.dreams.push({
      id: o.dreamId, ownerHandle: '@' + o.username, caption: 'A test dream', style: 'Cinematic',
      videoUrl: 'https://example.com/fake-video.mp4', isPublished: !!o.isPublished,
      likes: 0, likedByMe: false, dur: '0:08', sourceOperationName: null
    });
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, opts);
}

/** A SIGNED-OUT browser (no state.user at all) that already knows about one account/dream pair -- simulates "the real server already has this account+dream; this particular browser/context just doesn't have a local session for it yet", the exact situation a session-transfer token is meant to fix. */
async function seedSignedOutWithDream(page, opts) {
  await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function (o) {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    // Deliberately no state.user -- this browser starts signed out.
    if (!state.accounts) state.accounts = {};
    if (!state.dreams) state.dreams = [];
    state.dreams.push({
      id: o.dreamId, ownerHandle: '@' + o.username, caption: 'A test dream', style: 'Cinematic',
      videoUrl: 'https://example.com/fake-video.mp4', isPublished: false,
      likes: 0, likedByMe: false, dur: '0:08', sourceOperationName: null
    });
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, opts);
}

/** Stubs POST /.netlify/functions/create-session-transfer to always mint a fixed token, recording every request body it saw. */
function mockCreateSessionTransfer(page, token) {
  var calls = [];
  return page.route('**/.netlify/functions/create-session-transfer', function (route) {
    var body = null;
    try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) { /* leave null */ }
    calls.push(body);
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, token: token }) });
  }).then(function () { return calls; });
}

/**
 * Stubs POST /.netlify/functions/verify-session-transfer -- ok:true
 * resolves once (then falls back to ok:false, mirroring the real
 * single-use server behavior) for `okOnce`, everything else is ok:false.
 *
 * authToken (tracker item publish-dream-js-trusts-client-supplied--lkppcu,
 * review finding): the real verify-session-transfer.js now mints a real
 * lib/account-auth-token.js token on every successful verify -- this stub
 * includes one too (defaulting to a fixed, recognizable string derived
 * from the token if `okOnce.authToken` isn't given) so tests below can
 * confirm js/store.js's commitTransferredSession actually threads it
 * through into state.user, and that publish-dream.js's own mocked stub
 * later sees that exact value on a real Publish tap.
 */
function mockVerifySessionTransfer(page, okOnce) {
  var consumed = false;
  return page.route('**/.netlify/functions/verify-session-transfer', function (route) {
    var body = null;
    try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) { /* leave null */ }
    var match = okOnce && !consumed && body && body.token === okOnce.token;
    if (match) {
      consumed = true;
      var authToken = okOnce.authToken !== undefined ? okOnce.authToken : ('minted-authtoken-for-' + okOnce.username);
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, username: okOnce.username, email: okOnce.email, authToken: authToken }) });
    } else {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false }) });
    }
  });
}

/** Stubs POST /.netlify/functions/publish-dream, recording every request body it saw (so a test can assert on the authToken a real Publish tap actually sent), and always reports success. */
function mockPublishDreamCapture(page) {
  var calls = [];
  return page.route('**/.netlify/functions/publish-dream', function (route) {
    var body = null;
    try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) { /* leave null */ }
    calls.push(body);
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, dream: body }) });
  }).then(function () { return calls; });
}

// ===== "Copy link for your browser" (non-Android nudge button fix) =====

test('home.html: on iOS, the webview-escape card\'s button is labeled "Copy link for your browser" and actually copies the current URL (including the ?bt= token) to the clipboard, confirmed by a persistent ON-PAGE note (no toast at all for this success path)', async function (t) {
  // Founder walkthrough punch list (2026-08-01, tracker item
  // for-product-founder-walkthrough-punch-li-t33k3y, item 5 / Manager
  // addition C): a real FB-webview screenshot showed the old toast
  // confirmation clipped mid-sentence ("Keep it to yo...") and it
  // auto-dismissed too fast (~2.2s) to read anyway. Fixed by dropping the
  // toast for this success path entirely (the failure paths -- clipboard
  // write rejected / Clipboard API unsupported -- keep their own short
  // toasts, unchanged) and relying solely on the on-page
  // #webview-card-note, which now also carries the "keep it to yourself"
  // warning the old toast had, and auto-hides itself after ~1 minute
  // (not instantly, not forever) -- see home.html's copyLinkForBrowser
  // doc comment for the full reasoning.
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ userAgent: FB_IOS_UA, permissions: ['clipboard-read', 'clipboard-write'] });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockCreateSessionTransfer(page, 'ios-copy-token-abc123');
    await seedAccountWithDraft(page, { username: 'ioscopyuser' });
    // Tracker item for-product-funnel-ending-v2-founder-ins-tfuu0q --
    // processing.html removed; this webview-escape mechanism is now
    // ORPHAN (b), folded into home.html's "Add DreamTube to your phone"
    // quiet row as an elevated .webview-card. Real escape logic (Android
    // intent://, iOS copy-link, ?bt= session-transfer token round trip)
    // ported verbatim -- see that page's own "ORPHAN (b)" script block.
    await page.clock.install({ time: Date.now() });
    await page.goto(baseUrl + '/home.html', { waitUntil: 'domcontentloaded' });

    await page.waitForSelector('#webview-card', { state: 'visible', timeout: 5000 });
    var btnLabel = await page.textContent('#webview-card-btn');
    assert.match(btnLabel, /Copy link for your browser/, 'non-Android must show the "Copy link" action');

    // Wait for maintainSessionTransferUrl's mint to land on the address bar.
    await page.waitForFunction(function () { return location.href.indexOf('bt=') !== -1; }, null, { timeout: 5000 });
    var urlAtClick = page.url();
    assert.match(urlAtClick, /[?&]bt=ios-copy-token-abc123(&|$)/, 'the token must actually be on the address bar before the button is used');

    await page.click('#webview-card-btn');

    var noteEl = page.locator('#webview-card-note');
    await noteEl.waitFor({ state: 'visible', timeout: 2000 });
    var noteText = await noteEl.textContent();
    assert.match(noteText, /open your browser/i, 'the on-page note must give the exact next step, not just confirm the copy');
    assert.match(noteText, /paste/i, 'the on-page note must tell the visitor to paste the link');
    assert.match(noteText, /keep it to yourself/i, 'the security warning the old toast carried must survive the move to the on-page note');

    var clipboardText = await page.evaluate(function () { return navigator.clipboard.readText(); });
    assert.equal(clipboardText, urlAtClick, 'clipboard must contain exactly the current URL, including its ?bt= token');

    // No toast at all for this success path -- the on-page note fully
    // replaces it now, it doesn't just supplement it.
    assert.equal(await page.locator('.toast.show').count(), 0, 'the success path must not show a toast at all -- the on-page note is the only confirmation now');

    // Persists well past the old toast's ~2.2s auto-dismiss window...
    await page.waitForTimeout(2500);
    assert.equal(await noteEl.isVisible(), true, 'the note must still be visible several seconds later');

    // ...but is not permanent -- it clears itself after ~1 minute.
    await page.clock.fastForward(60000);
    assert.equal(await noteEl.isVisible(), false, 'the note must auto-hide itself roughly a minute after the copy, so it does not read as stale forever');
  } finally {
    await context.close();
  }
});

test('home.html: on Android, the webview-escape card\'s button keeps the "Open in my browser" label and its intent:// URL carries the ?bt= session-transfer token too', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var IG_ANDROID = IG_ANDROID_UA;
  var context = await browser.newContext({ userAgent: IG_ANDROID });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockCreateSessionTransfer(page, 'android-intent-token-xyz789');
    await seedAccountWithDraft(page, { username: 'androidtokenuser' });
    await page.goto(baseUrl + '/home.html', { waitUntil: 'domcontentloaded' });

    await page.waitForSelector('#webview-card', { state: 'visible', timeout: 5000 });
    var btnLabel = await page.textContent('#webview-card-btn');
    assert.match(btnLabel, /Open in my browser/, 'Android must keep the "Open in my browser" label -- this only changes the non-Android branch');

    await page.waitForFunction(function () { return location.href.indexOf('bt=') !== -1; }, null, { timeout: 5000 });

    var intentUrl = await page.evaluate(function () { return buildAndroidChromeIntentUrl(); });
    assert.match(intentUrl, /^intent:\/\//);
    assert.match(intentUrl, /bt=android-intent-token-xyz789/, 'the Android intent:// URL must also carry the session-transfer token');
  } finally {
    await context.close();
  }
});

// ===== create.html's OWN copy of the same escape pattern (tracker item
// for-product-webview-notify-escape-nudge--5yray5, ask 3): before this fix,
// #rec-inapp-open-btn unconditionally said "Open in my browser" and did
// NOTHING on non-Android -- a genuinely misleading button-shaped element,
// the exact bug the founder reported from a live FB in-app-webview test.
// This ports processing.html's already-correct fix (above) to create.html's
// record-blocked panel, plus wires create.html into the session-transfer
// chain for the first time (it never consumed/minted ?bt= tokens before) so
// the copied link actually lands signed in, not just on the right page. =====

/** Seeds a signed-in account (real cached password, required for mintSessionTransferToken) with no draft requirement -- create.html's own top-of-script guard only requires being signed in, unlike processing.html's draft/pendingJob requirement. */
async function seedAccountForCreate(page, opts) {
  await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function (o) {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@' + o.username, username: o.username };
    if (!state.accounts) state.accounts = {};
    state.accounts[o.username] = { password: o.password || 'testpass1', email: o.email || (o.username + '@example.com') };
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, opts);
}

test('create.html: on iOS, the record-blocked panel\'s button is relabeled "Copy link for your browser" and actually copies the current URL (including a freshly-minted ?bt= token) to the clipboard, with a persistent post-copy instruction', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ userAgent: FB_IOS_UA, permissions: ['clipboard-read', 'clipboard-write'] });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockCreateSessionTransfer(page, 'create-ios-copy-token-1');
    await seedAccountForCreate(page, { username: 'createioscopyuser' });
    await page.goto(baseUrl + '/create.html?record=1', { waitUntil: 'domcontentloaded' });

    await page.waitForSelector('#create-record-blocked[style*="display: flex"]', { timeout: 5000 });
    var btnLabel = await page.textContent('#rec-inapp-open-btn');
    assert.match(btnLabel, /Copy link for your browser/, 'non-Android must show the same honest "Copy link" action processing.html already has, not the old "Open in my browser" label that did nothing');

    // create.html never consumed/minted ?bt= tokens before this fix -- must
    // now, so the copied link actually works.
    await page.waitForFunction(function () { return location.href.indexOf('bt=') !== -1; }, null, { timeout: 5000 });
    var urlAtClick = page.url();
    assert.match(urlAtClick, /[?&]bt=create-ios-copy-token-1(&|$)/, 'the token must be on the address bar before the button is used');

    await page.click('#rec-inapp-open-btn');
    await page.waitForSelector('.toast.show', { timeout: 3000 });
    var toastText = await page.textContent('#toast');
    assert.match(toastText, /Link copied.*Safari/i);

    var clipboardText = await page.evaluate(function () { return navigator.clipboard.readText(); });
    assert.equal(clipboardText, urlAtClick, 'clipboard must contain exactly the current URL, including its ?bt= token and ?record=1');
    assert.match(clipboardText, /record=1/, 'the copied link must preserve ?record=1 so pasting it back in a real browser lands right back in the record flow');

    var noteEl = page.locator('#rec-inapp-copied-note');
    await noteEl.waitFor({ state: 'visible', timeout: 2000 });
    var noteText = await noteEl.textContent();
    assert.match(noteText, /open your browser/i, 'must give the founder\'s own verbatim next-step instruction');
    assert.match(noteText, /paste/i);

    // The pre-existing hint-emphasis fallback must still work alongside the
    // new copy action.
    var hintHasEmphasis = await page.evaluate(function () {
      return document.getElementById('rec-inapp-hint').classList.contains('proc-nudge-hint-emph');
    });
    assert.equal(hintHasEmphasis, true);
  } finally {
    await context.close();
  }
});

test('create.html: on Android, the record-blocked panel keeps a REAL "Open in my browser" button (intent:// escape, carrying the ?bt= token and ?record=1)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ userAgent: IG_ANDROID_UA });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockCreateSessionTransfer(page, 'create-android-token-1');
    await seedAccountForCreate(page, { username: 'createandroidtokenuser' });
    await page.goto(baseUrl + '/create.html?record=1', { waitUntil: 'domcontentloaded' });

    await page.waitForSelector('#create-record-blocked[style*="display: flex"]', { timeout: 5000 });
    var btnLabel = await page.textContent('#rec-inapp-open-btn');
    assert.match(btnLabel, /Open in my browser/, 'Android keeps the real, working intent:// escape button -- this fix only changes the non-Android branch');

    await page.waitForFunction(function () { return location.href.indexOf('bt=') !== -1; }, null, { timeout: 5000 });
    var intentUrl = await page.evaluate(function () { return buildAndroidChromeIntentUrl(); });
    assert.match(intentUrl, /^intent:\/\//);
    assert.match(intentUrl, /bt=create-android-token-1/, 'the Android intent:// URL must carry the session-transfer token too, so the visitor lands signed in');
    assert.ok(intentUrl.indexOf('record%3D1') !== -1 || intentUrl.indexOf('record=1') !== -1, 'must still preserve ?record=1');
  } finally {
    await context.close();
  }
});

// ===== token round-trip: mint -> land with ?bt= -> verify/consume -> session committed -> param stripped =====

test('result.html: landing with a VALID ?bt= token commits a real local session (without ever hitting the sign-in redirect) and strips the param from the URL', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockVerifySessionTransfer(page, { token: 'valid-roundtrip-token', username: 'transferreduser', email: 'transferred@example.com' });

    await seedSignedOutWithDream(page, { username: 'transferreduser', dreamId: 'd-transfer-1' });
    await page.goto(baseUrl + '/result.html?id=d-transfer-1&bt=valid-roundtrip-token', { waitUntil: 'domcontentloaded' });

    // A signed-out visitor without a valid token would have been redirected
    // to login.html immediately -- this must NOT happen here.
    await page.waitForTimeout(300);
    assert.match(page.url(), /result\.html/, 'a valid transfer token must commit the session before the sign-in guard runs, never redirecting to login.html');

    var committedUser = await page.evaluate(function () { return DreamStore.getCurrentUser(); });
    assert.ok(committedUser, 'a session must actually be committed');
    assert.equal(committedUser.username, 'transferreduser');
    assert.equal(committedUser.handle, '@transferreduser');
    assert.equal(committedUser.authToken, 'minted-authtoken-for-transferreduser', 'the authToken verify-session-transfer.js mints on success (tracker item publish-dream-js-trusts-client-supplied--lkppcu) must actually land on state.user, not just username/email');

    assert.equal(page.url().indexOf('bt='), -1, 'the ?bt= param must be stripped from the address bar once consumed, valid or not');
    assert.match(page.url(), /id=d-transfer-1/, 'stripping bt= must not disturb the ?id= param this page actually needs');
  } finally {
    await context.close();
  }
});

// ===== authToken threading + Publish (tracker item
// publish-dream-js-trusts-client-supplied--lkppcu, review finding): no
// existing test in this file exercised "session established via
// commitTransferredSession, then tap Publish" -- every test in
// test/publish-unpublish-dream-auth.test.js mints its authToken directly
// via accountAuthToken.mintToken, bypassing this client-side construction
// path entirely, which is exactly why the missing-authToken regression
// wasn't caught. This closes that gap end-to-end through the real browser
// flow: land with a valid ?bt=, then actually tap Publish and confirm the
// real outgoing publish-dream request carries the session-transfer-minted
// authToken. =====

test('result.html: a session established via the session-transfer link (?bt=) can actually Publish -- the real outgoing publish-dream request carries the authToken verify-session-transfer.js minted, closing the review finding that this flow silently broke Publish', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockVerifySessionTransfer(page, { token: 'publish-after-transfer-token', username: 'transferpublisher', email: 'transferpublisher@example.com' });
    var publishCalls = await mockPublishDreamCapture(page);

    // Signed-out browser, exactly like the round-trip test above, but with
    // an UNPUBLISHED dream so tapping Publish is a real state transition,
    // not a no-op re-sync.
    await seedSignedOutWithDream(page, { username: 'transferpublisher', dreamId: 'd-transfer-publish-1' });
    await page.goto(baseUrl + '/result.html?id=d-transfer-publish-1&bt=publish-after-transfer-token', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(300);

    // Confirm the session really was established via the transfer link
    // (not some other path) before treating the Publish assertion below as
    // meaningful.
    var committedUser = await page.evaluate(function () { return DreamStore.getCurrentUser(); });
    assert.equal(committedUser.username, 'transferpublisher');
    assert.equal(committedUser.authToken, 'minted-authtoken-for-transferpublisher');

    await page.click('#publish-btn');
    await page.waitForSelector('#modal-publish.open');
    await page.click('#publish-confirm');

    assert.equal(publishCalls.length, 1, 'Publish must have actually sent a real publish-dream request');
    assert.equal(publishCalls[0].authToken, 'minted-authtoken-for-transferpublisher', 'the outgoing publish-dream request must carry the session-transfer-minted authToken -- before this fix, commitTransferredSession never set one at all, so this would have been null/undefined and publish-dream.js would reject it (E4 auth_token_required)');
    assert.equal(publishCalls[0].ownerHandle, '@transferpublisher');

    var isPublished = await page.evaluate(function () { return DreamStore.getDream('d-transfer-publish-1').isPublished; });
    assert.equal(isPublished, true, 'Publish must still succeed locally regardless -- this test is specifically about the SHARED-feed sync request now carrying a real token');
  } finally {
    await context.close();
  }
});

test('result.html: the SAME ?bt= token cannot commit a session a second time (server-side single-use is respected client-side too)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockVerifySessionTransfer(page, { token: 'once-only-token', username: 'onceonlyuser', email: 'onceonly@example.com' });
    await seedSignedOutWithDream(page, { username: 'onceonlyuser', dreamId: 'd-once-1' });

    // First load: consumes the token, commits the session -- same as the
    // round-trip test above.
    await page.goto(baseUrl + '/result.html?id=d-once-1&bt=once-only-token', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(200);
    var firstUser = await page.evaluate(function () { return DreamStore.getCurrentUser(); });
    assert.ok(firstUser);

    // A completely fresh, still-signed-out browser context re-uses the
    // exact same token string (the mock's own `consumed` flag makes the
    // stub degrade to ok:false on this second call, exactly like the real
    // single-use server would) -- must fall through to login.html, never
    // commit a second session from the same token.
    var context2 = await browser.newContext();
    try {
      var page2 = await context2.newPage();
      await blockThirdParty(page2);
      await seedSignedOutWithDream(page2, { username: 'onceonlyuser', dreamId: 'd-once-1' });
      await page2.goto(baseUrl + '/result.html?id=d-once-1&bt=once-only-token', { waitUntil: 'domcontentloaded' });
      await page2.waitForURL('**/login.html', { timeout: 5000 });
      assert.match(page2.url(), /login\.html/, 'a reused token must fall through to the ordinary signed-out flow');
    } finally {
      await context2.close();
    }
  } finally {
    await context.close();
  }
});

test('result.html: a valid ?bt= token for a DIFFERENT account never silently replaces an already-signed-in session (round-2 review fix) -- but a valid token for the SAME already-signed-in account still commits cleanly', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockVerifySessionTransfer(page, { token: 'stranger-token', username: 'strangeraccount', email: 'stranger@example.com' });

    // This browser is ALREADY signed in as ownaccount -- e.g. a shared
    // device, or someone else's own valid session-transfer link landing
    // here (deliberately or via a copy-paste mistake).
    await seedAccountWithDream(page, { username: 'ownaccount', dreamId: 'd-guard-1' });
    await page.goto(baseUrl + '/result.html?id=d-guard-1&bt=stranger-token', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(300);

    var user = await page.evaluate(function () { return DreamStore.getCurrentUser(); });
    assert.ok(user, 'must still be signed in as SOMEONE -- must not have been signed out either');
    assert.equal(user.username, 'ownaccount', 'a valid token minted for a DIFFERENT account must never silently replace the already-signed-in session');
    assert.equal(page.url().indexOf('bt='), -1, 'the bt= param is still stripped from the URL regardless of whether it was honored');
  } finally {
    await context.close();
  }
});

test('result.html: a valid ?bt= token for the SAME already-signed-in account is a harmless no-op refresh, not blocked by the different-account guard', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockVerifySessionTransfer(page, { token: 'same-account-token', username: 'sameaccountuser', email: 'sameaccountuser@example.com' });

    await seedAccountWithDream(page, { username: 'sameaccountuser', dreamId: 'd-guard-2' });
    await page.goto(baseUrl + '/result.html?id=d-guard-2&bt=same-account-token', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(300);

    var user = await page.evaluate(function () { return DreamStore.getCurrentUser(); });
    assert.ok(user);
    assert.equal(user.username, 'sameaccountuser', 'a token confirming the SAME identity that was already signed in must not be treated as a conflicting switch');
  } finally {
    await context.close();
  }
});

test('result.html: an invalid/expired ?bt= token is a silent no-op -- falls through to the normal signed-out redirect, no error shown', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    var consoleErrors = [];
    page.on('pageerror', function (err) { consoleErrors.push(String(err)); });
    await blockThirdParty(page);
    // No okOnce match at all -- every verify call returns ok:false, exactly
    // like a garbage/expired/already-consumed token would server-side.
    await mockVerifySessionTransfer(page, null);
    await seedSignedOutWithDream(page, { username: 'nobodyhome', dreamId: 'd-invalid-1' });

    await page.goto(baseUrl + '/result.html?id=d-invalid-1&bt=totally-made-up-garbage-token', { waitUntil: 'domcontentloaded' });
    await page.waitForURL('**/login.html', { timeout: 5000 });
    assert.match(page.url(), /login\.html/, 'an invalid token must fall through to the ordinary signed-out redirect');

    assert.equal(consoleErrors.length, 0, 'an invalid token must never surface a JS error to the page');
  } finally {
    await context.close();
  }
});

test('home.html: an invalid ?bt= token is also a silent no-op there, with the normal signed-out redirect to login.html still applying', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockVerifySessionTransfer(page, null);
    // No seedAccountWithDraft -- signed out, exactly like a stale/garbage
    // bt link landing on a browser with no session at all.
    await page.goto(baseUrl + '/home.html?bt=garbage-token-here', { waitUntil: 'domcontentloaded' });
    await page.waitForURL('**/login.html', { timeout: 5000 });
    assert.match(page.url(), /login\.html/);
  } finally {
    await context.close();
  }
});

// ===== leak prevention: the token must never end up on a share link =====

test('result.html: the session-transfer token minted for the address bar never leaks onto the Share button\'s shared link (share mini-sheet\'s "Share link" option)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ userAgent: IG_ANDROID_UA, permissions: ['clipboard-read', 'clipboard-write'] });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockCreateSessionTransfer(page, 'share-leak-check-token');
    // navigator.share is stripped so ShareSheet's chooseLink() falls back
    // to the same clipboard-copy path result.html's old doShare() already
    // used on a browser without the native share sheet -- lets this test
    // read the exact URL that would have been shared.
    await context.addInitScript(function () { delete navigator.__proto__.share; Object.defineProperty(navigator, 'share', { value: undefined }); });

    await seedAccountWithDream(page, { username: 'shareleaktest', dreamId: 'd-share-1', isPublished: true });
    await page.goto(baseUrl + '/result.html?id=d-share-1', { waitUntil: 'domcontentloaded' });

    // Confirm the transfer token really did land on THIS page's own
    // address bar first -- otherwise the negative assertion below would
    // be vacuous.
    await page.waitForFunction(function () { return location.href.indexOf('bt=') !== -1; }, null, { timeout: 5000 });
    assert.match(page.url(), /bt=share-leak-check-token/);

    await page.click('#share-btn');
    await page.waitForSelector('#share-sheet-overlay.open');
    await page.click('#share-opt-link');
    await page.waitForSelector('.toast.show', { timeout: 3000 });
    var sharedUrl = await page.evaluate(function () { return navigator.clipboard.readText(); });

    assert.match(sharedUrl, /\/\.netlify\/functions\/share-dream\?id=d-share-1$/, 'the shared link must be the share-dream.js preview-card link (which itself redirects to the plain explore.html dream link) -- not the raw explore.html URL directly');
    assert.equal(sharedUrl.indexOf('bt='), -1, 'the session-transfer token living on THIS page\'s own address bar must never appear on a link handed out to someone else');
  } finally {
    await context.close();
  }
});

test('result.html: a normal (non-webview) browser never gets a ?bt= token attached to its URL at all', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ userAgent: NORMAL_IOS_SAFARI_UA });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    var mintCalls = await mockCreateSessionTransfer(page, 'should-never-be-used');
    await seedAccountWithDream(page, { username: 'normalbrowseruser', dreamId: 'd-normal-1' });
    await page.goto(baseUrl + '/result.html?id=d-normal-1', { waitUntil: 'domcontentloaded' });

    // Give the (in this case, correctly-never-fired) mint a moment it
    // would have used if maintainSessionTransferUrl mistakenly ran outside
    // a detected webview.
    await page.waitForTimeout(300);
    assert.equal(page.url().indexOf('bt='), -1, 'a normal browser must never get a session-transfer token attached to its URL');
    assert.equal(mintCalls.length, 0, 'create-session-transfer must never even be called outside a detected FB/IG webview');
  } finally {
    await context.close();
  }
});
