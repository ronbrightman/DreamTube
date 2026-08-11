// test/dream-sync-client-behavioral.test.js
//
// Real browser-driven coverage for js/store.js's CLIENT side of tracker
// item for-product-build-p0-server-side-dream-p-zl3rb2 (server-side
// private dream persistence): state.user.authToken plumbing through
// login()/signup(), and the three internal sync helpers
// (syncPrivateDreamBestEffort/deletePrivateDreamBestEffort/
// reconcilePrivateDreamsFromServer) fired from every real dream-mutating
// public method. The server side (dream-sync.js, lib/dream-store.js,
// lib/account-auth-token.js) is covered directly in test/dream-sync.test.js
// and test/dream-store.test.js and test/account-auth-token.test.js — this
// file covers what actually fires from real browser interaction with
// js/store.js's own public API, same division of labor
// test/delete-account-behavioral.test.js documents for its own client/
// server split.
//
// Follows test/delete-account-behavioral.test.js's exact conventions: a
// plain static file server (no real Netlify Functions runtime),
// page.route() interception for every netlify function this touches, real
// Chromium via Playwright, blockThirdParty()/safeGoto() for this sandbox's
// flaky outbound network (see CLAUDE.md's known environment quirk).

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

async function safeGoto(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  } catch (e) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  }
}

/** Seeds a signed-in account with a real authToken directly into localStorage, bypassing a real login round trip — same shortcut test/delete-account-behavioral.test.js's own seedUser uses, extended with authToken/updatedAt (both new fields this feature adds). Every dream id this file seeds is deliberately NOT "d0".."d5" — js/store.js's migrateLegacyState strips any dream id matching /^d[0-5]$/ as stale pre-fal.ai mock seed data on the very next page load/navigation (found the hard way: an earlier version of this file used plain "d1" ids, which silently vanished from state.dreams before publishDream/unpublishDream/deleteDream ever ran, making every assertion here fail against a null dream). */
async function seedUser(page, opts) {
  opts = opts || {};
  await safeGoto(page, baseUrl + '/login.html');
  await page.evaluate(function (opts) {
    var state = {
      user: { handle: '@tester', username: 'tester', authToken: opts.authToken !== undefined ? opts.authToken : 'seeded-auth-token' },
      accounts: { tester: { password: 'realpassword1', email: 'tester@example.com' } },
      draft: { caption: '', storyText: '', needsStoryRewrite: false, style: null, sourceDreamId: null, restore: false, characterIds: [], cameraView: null, sceneryTime: null, sceneryPlace: null, mediaType: null, sourceImageUrl: null, audioOn: false, musicStyle: null },
      dreams: opts.dreams || [],
      pendingJob: null,
      charactersByUser: { tester: [] },
      likedIds: {}
    };
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    localStorage.setItem('dreamtube_feed_backfill_v1_done', '1');
  }, opts);
}

/** Intercepts dream-sync.js calls (both GET reconcile and POST upsert/delete), recording every one seen. `getResponse` is what a GET call returns. */
function mockDreamSync(page, getResponse) {
  var calls = [];
  page.route('**/.netlify/functions/dream-sync*', function (route) {
    var req = route.request();
    if (req.method() === 'GET') {
      calls.push({ method: 'GET' });
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(getResponse || { ok: true, dreams: [] }) });
    } else {
      var body = JSON.parse(req.postData());
      calls.push({ method: 'POST', body: body });
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    }
  });
  return calls;
}

function mockPublishDream(page) {
  var calls = [];
  page.route('**/.netlify/functions/publish-dream', function (route) {
    calls.push(JSON.parse(route.request().postData()));
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  return calls;
}
function mockUnpublishDream(page) {
  page.route('**/.netlify/functions/unpublish-dream', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
}

async function waitForCall(fn, timeoutMs) {
  var start = Date.now();
  while (Date.now() - start < (timeoutMs || 2000)) {
    if (fn()) return true;
    await new Promise(function (r) { setTimeout(r, 25); });
  }
  return false;
}

// ===== authToken plumbing through login()/signup() =====

test('login(): a real server-confirmed login stores the server\'s authToken on state.user, and fires a reconcile GET', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var dreamSyncCalls = mockDreamSync(page, { ok: true, dreams: [] });
    page.route('**/.netlify/functions/account-login', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, username: 'tester', email: 'tester@example.com', authToken: 'real-server-token-abc' }) });
    });
    await safeGoto(page, baseUrl + '/login.html');
    await page.evaluate(function () {
      window.DreamStore.__loginResult = null;
      window.DreamStore.login('tester', 'realpassword1').then(function (r) { window.DreamStore.__loginResult = r; });
    });
    await page.waitForFunction(function () { return window.DreamStore.__loginResult !== null; });

    var user = await page.evaluate(function () { return window.DreamStore.getCurrentUser(); });
    assert.equal(user.authToken, 'real-server-token-abc');

    var got = await waitForCall(function () { return dreamSyncCalls.some(function (c) { return c.method === 'GET'; }); });
    assert.ok(got, 'a real server-confirmed login must fire a reconcile GET against dream-sync.js');
  } finally {
    await page.close();
  }
});

test('login(): the fully-local fallback path (server unreachable) sets authToken:null and never calls dream-sync at all', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var dreamSyncCalls = mockDreamSync(page, { ok: true, dreams: [] });
    // Simulate the server being unreachable -- account-login.js aborts.
    page.route('**/.netlify/functions/account-login', function (route) { route.abort(); });
    await seedUser(page, { authToken: null }); // 'tester' already exists locally so attemptLocalLogin can succeed
    await safeGoto(page, baseUrl + '/login.html');
    await page.evaluate(function () {
      window.DreamStore.__loginResult = null;
      window.DreamStore.login('tester', 'realpassword1').then(function (r) { window.DreamStore.__loginResult = r; });
    });
    await page.waitForFunction(function () { return window.DreamStore.__loginResult !== null; });

    var result = await page.evaluate(function () { return window.DreamStore.__loginResult; });
    assert.equal(result.ok, true, 'sanity: the local fallback must still succeed');
    var user = await page.evaluate(function () { return window.DreamStore.getCurrentUser(); });
    assert.equal(user.authToken, null);

    // Give any errant async call a moment, then confirm none fired.
    await new Promise(function (r) { setTimeout(r, 200); });
    assert.equal(dreamSyncCalls.length, 0, 'a fully-local (no real server check) login must never call dream-sync.js');
  } finally {
    await page.close();
  }
});

test('signup(): a real server-confirmed signup stores the server\'s authToken', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    mockDreamSync(page, { ok: true, dreams: [] });
    page.route('**/.netlify/functions/register-account', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, username: 'newperson', email: 'newperson@example.com', authToken: 'fresh-signup-token' }) });
    });
    await safeGoto(page, baseUrl + '/login.html');
    await page.evaluate(function () {
      window.DreamStore.__signupResult = null;
      window.DreamStore.signup('newperson', 'realpassword1', 'newperson@example.com').then(function (r) { window.DreamStore.__signupResult = r; });
    });
    await page.waitForFunction(function () { return window.DreamStore.__signupResult !== null; });

    var user = await page.evaluate(function () { return window.DreamStore.getCurrentUser(); });
    assert.equal(user.authToken, 'fresh-signup-token');
  } finally {
    await page.close();
  }
});

// ===== mutation call sites fire the right sync call =====

test('saveClaimedDream fires a best-effort upsert to dream-sync with the new dream\'s content', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var calls = mockDreamSync(page);
    await seedUser(page);
    await safeGoto(page, baseUrl + '/login.html');

    await page.evaluate(function () {
      window.DreamStore.saveClaimedDream('a claimed dream', 'Cartoon', 'https://x/v.mp4', 'a claimed dream');
    });

    var got = await waitForCall(function () { return calls.some(function (c) { return c.method === 'POST' && c.body.action === 'upsert'; }); });
    assert.ok(got);
    var upsertCall = calls.filter(function (c) { return c.method === 'POST' && c.body.action === 'upsert'; })[0];
    assert.equal(upsertCall.body.dream.caption, 'a claimed dream');
    assert.equal(upsertCall.body.authToken, 'seeded-auth-token');
  } finally {
    await page.close();
  }
});

// ===== createdAt (tracker item for-product-media-library-stamp-durable--
// u4oju3, root-cause fix): js/store.js's own POST payload builders now
// actually forward the client's real createdAt to both server sync
// endpoints -- before this fix, dream.createdAt existed on the local object
// (finalizeDream stamped it) but was silently dropped before it ever left
// the browser, which was the actual root cause of the founder's "no
// timestamp" report for private dreams. =====

test('saveClaimedDream stamps a real createdAt locally and forwards it in the dream-sync upsert payload', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var calls = mockDreamSync(page);
    await seedUser(page);
    await safeGoto(page, baseUrl + '/login.html');

    var before = Date.now();
    await page.evaluate(function () {
      window.DreamStore.saveClaimedDream('a claimed dream', 'Cartoon', 'https://x/v.mp4', 'a claimed dream');
    });
    var after = Date.now();

    var got = await waitForCall(function () { return calls.some(function (c) { return c.method === 'POST' && c.body.action === 'upsert'; }); });
    assert.ok(got);
    var upsertCall = calls.filter(function (c) { return c.method === 'POST' && c.body.action === 'upsert'; })[0];
    assert.ok(typeof upsertCall.body.dream.createdAt === 'number' && upsertCall.body.dream.createdAt >= before && upsertCall.body.dream.createdAt <= after, 'saveClaimedDream must stamp and forward a real createdAt, not leave it undefined');

    var myDreams = await page.evaluate(function () { return window.DreamStore.getMyDreams(); });
    assert.equal(myDreams[0].createdAt, upsertCall.body.dream.createdAt, 'the same createdAt stamped locally must be what gets synced');
  } finally {
    await page.close();
  }
});

test('publishing a private dream with a real local createdAt forwards it to publish-dream.js\'s shared feed record', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var dreamSyncCalls = mockDreamSync(page);
    var publishCalls = mockPublishDream(page);
    var realCreatedAt = 1780000000000;
    await seedUser(page, { dreams: [{ id: 'private-dream-createdat', ownerHandle: '@tester', caption: 'c', style: 'Cartoon', likes: 0, likedByMe: false, isPublished: false, videoUrl: 'https://x/v.mp4', mediaType: 'video', createdAt: realCreatedAt }] });
    await safeGoto(page, baseUrl + '/login.html');

    await page.evaluate(function () { window.DreamStore.publishDream('private-dream-createdat'); });

    var got = await waitForCall(function () { return publishCalls.length > 0; });
    assert.ok(got, 'publishDream must call publish-dream.js');
    assert.equal(publishCalls[0].createdAt, realCreatedAt, 'the dream\'s real local createdAt must be forwarded to the shared feed record, not omitted');
  } finally {
    await page.close();
  }
});

test('publishDream fires a best-effort DELETE against dream-sync (a published dream leaves the private store)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var dreamSyncCalls = mockDreamSync(page);
    mockPublishDream(page);
    await seedUser(page, { dreams: [{ id: 'private-dream-1', ownerHandle: '@tester', caption: 'c', style: 'Cartoon', likes: 0, likedByMe: false, isPublished: false, videoUrl: 'https://x/v.mp4', mediaType: 'video' }] });
    await safeGoto(page, baseUrl + '/login.html');

    await page.evaluate(function () { window.DreamStore.publishDream('private-dream-1'); });

    var got = await waitForCall(function () { return dreamSyncCalls.some(function (c) { return c.method === 'POST' && c.body.action === 'delete' && c.body.dreamId === 'private-dream-1'; }); });
    assert.ok(got, 'publishing a dream must remove it from the private-dream server store');
  } finally {
    await page.close();
  }
});

test('unpublishDream fires a best-effort upsert against dream-sync (an unpublished dream is private again)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var dreamSyncCalls = mockDreamSync(page);
    mockUnpublishDream(page);
    await seedUser(page, { dreams: [{ id: 'private-dream-1', ownerHandle: '@tester', caption: 'c', style: 'Cartoon', likes: 0, likedByMe: false, isPublished: true, videoUrl: 'https://x/v.mp4', mediaType: 'video' }] });
    await safeGoto(page, baseUrl + '/login.html');

    await page.evaluate(function () { window.DreamStore.unpublishDream('private-dream-1'); });

    var got = await waitForCall(function () { return dreamSyncCalls.some(function (c) { return c.method === 'POST' && c.body.action === 'upsert' && c.body.dream.id === 'private-dream-1'; }); });
    assert.ok(got, 'unpublishing a dream must give it a fresh durable private-store copy');
  } finally {
    await page.close();
  }
});

test('deleteDream fires a best-effort DELETE against dream-sync', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var dreamSyncCalls = mockDreamSync(page);
    await seedUser(page, { dreams: [{ id: 'private-dream-1', ownerHandle: '@tester', caption: 'c', style: 'Cartoon', likes: 0, likedByMe: false, isPublished: false, videoUrl: 'https://x/v.mp4', mediaType: 'video' }] });
    await safeGoto(page, baseUrl + '/login.html');

    await page.evaluate(function () { window.DreamStore.deleteDream('private-dream-1'); });

    var got = await waitForCall(function () { return dreamSyncCalls.some(function (c) { return c.method === 'POST' && c.body.action === 'delete' && c.body.dreamId === 'private-dream-1'; }); });
    assert.ok(got);
  } finally {
    await page.close();
  }
});

test('a signed-in session with NO authToken (a legacy/local-only login) never calls dream-sync from any mutation', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var dreamSyncCalls = mockDreamSync(page);
    await seedUser(page, { authToken: null, dreams: [{ id: 'private-dream-1', ownerHandle: '@tester', caption: 'c', style: 'Cartoon', likes: 0, likedByMe: false, isPublished: false, videoUrl: 'https://x/v.mp4', mediaType: 'video' }] });
    await safeGoto(page, baseUrl + '/login.html');

    await page.evaluate(function () {
      window.DreamStore.saveClaimedDream('x', 'Cartoon', 'https://x/v2.mp4', 'x');
      window.DreamStore.deleteDream('private-dream-1');
    });
    await new Promise(function (r) { setTimeout(r, 200); });
    assert.equal(dreamSyncCalls.length, 0, 'no authToken on file must mean every dream-sync call site silently no-ops');
  } finally {
    await page.close();
  }
});

// ===== reconcile merge logic =====

test('reconcile: a dream missing locally entirely (webview wipe) is restored from the server copy on login', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var serverDream = { id: 'restored-1', ownerHandle: '@tester', caption: 'restored from server', style: 'Cartoon', mediaType: 'video', videoUrl: 'https://x/v.mp4', isPublished: false, updatedAt: Date.now() };
    mockDreamSync(page, { ok: true, dreams: [serverDream] });
    page.route('**/.netlify/functions/account-login', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, username: 'tester', email: 'tester@example.com', authToken: 'tok' }) });
    });
    await seedUser(page, { dreams: [] });
    await safeGoto(page, baseUrl + '/login.html');
    await page.evaluate(function () {
      window.DreamStore.__loginResult = null;
      window.DreamStore.login('tester', 'realpassword1').then(function (r) { window.DreamStore.__loginResult = r; });
    });
    await page.waitForFunction(function () { return window.DreamStore.__loginResult !== null; });

    var restored = await waitForCall(function () { return true; }); // placeholder to allow the async reconcile to run
    await new Promise(function (r) { setTimeout(r, 300); }); // let the fire-and-forget reconcile's .then() actually apply

    var dreams = await page.evaluate(function () { return window.DreamStore.getMyDreams(); });
    assert.ok(dreams.some(function (d) { return d.id === 'restored-1'; }), 'the server-known dream must be restored into local state after login');
  } finally {
    await page.close();
  }
});

test('reconcile: a PUBLISHED local dream is never overwritten by a stale dream-sync record for the same id', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    // Simulates publishDream's own best-effort delete-from-dream-sync
    // having silently failed once -- the (private, stale) copy still
    // exists server-side even though this device knows it's published.
    var staleServerDream = { id: 'private-dream-1', ownerHandle: '@tester', caption: 'STALE PRE-PUBLISH TEXT', style: 'Cartoon', mediaType: 'video', videoUrl: 'https://x/old.mp4', isPublished: false, updatedAt: Date.now() - 100000 };
    mockDreamSync(page, { ok: true, dreams: [staleServerDream] });
    page.route('**/.netlify/functions/account-login', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, username: 'tester', email: 'tester@example.com', authToken: 'tok' }) });
    });
    await seedUser(page, { dreams: [{ id: 'private-dream-1', ownerHandle: '@tester', caption: 'REAL PUBLISHED CAPTION', style: 'Cartoon', likes: 0, likedByMe: false, isPublished: true, videoUrl: 'https://x/new.mp4', mediaType: 'video', updatedAt: Date.now() }] });
    await safeGoto(page, baseUrl + '/login.html');
    await page.evaluate(function () {
      window.DreamStore.__loginResult = null;
      window.DreamStore.login('tester', 'realpassword1').then(function (r) { window.DreamStore.__loginResult = r; });
    });
    await page.waitForFunction(function () { return window.DreamStore.__loginResult !== null; });
    await new Promise(function (r) { setTimeout(r, 300); });

    var dream = await page.evaluate(function () { return window.DreamStore.getDream('private-dream-1'); });
    assert.equal(dream.caption, 'REAL PUBLISHED CAPTION', 'a published dream must never be overwritten by a stale private-store snapshot');
    assert.equal(dream.isPublished, true);
  } finally {
    await page.close();
  }
});

test('reconcile: a NEWER local edit is re-pushed to the server rather than being overwritten by an older server copy', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var olderServerDream = { id: 'private-dream-1', ownerHandle: '@tester', caption: 'OLD SERVER CAPTION', style: 'Cartoon', mediaType: 'video', videoUrl: 'https://x/old.mp4', isPublished: false, updatedAt: 1000 };
    var dreamSyncCalls = mockDreamSync(page, { ok: true, dreams: [olderServerDream] });
    page.route('**/.netlify/functions/account-login', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, username: 'tester', email: 'tester@example.com', authToken: 'tok' }) });
    });
    await seedUser(page, { dreams: [{ id: 'private-dream-1', ownerHandle: '@tester', caption: 'NEWER LOCAL CAPTION', style: 'Cartoon', likes: 0, likedByMe: false, isPublished: false, videoUrl: 'https://x/new.mp4', mediaType: 'video', updatedAt: Date.now() }] });
    await safeGoto(page, baseUrl + '/login.html');
    await page.evaluate(function () {
      window.DreamStore.__loginResult = null;
      window.DreamStore.login('tester', 'realpassword1').then(function (r) { window.DreamStore.__loginResult = r; });
    });
    await page.waitForFunction(function () { return window.DreamStore.__loginResult !== null; });
    await new Promise(function (r) { setTimeout(r, 300); });

    var dream = await page.evaluate(function () { return window.DreamStore.getDream('private-dream-1'); });
    assert.equal(dream.caption, 'NEWER LOCAL CAPTION', 'the device with the newer edit must keep it, not silently lose it to an older server copy');

    var rePushed = dreamSyncCalls.some(function (c) { return c.method === 'POST' && c.body.action === 'upsert' && c.body.dream.id === 'private-dream-1' && c.body.dream.caption === 'NEWER LOCAL CAPTION'; });
    assert.ok(rePushed, 'the newer local edit should also be re-pushed to catch the server copy up');
  } finally {
    await page.close();
  }
});

test('reconcile: a NEWER server copy (edited on a different device) overwrites this device\'s older local copy', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var newerServerDream = { id: 'private-dream-1', ownerHandle: '@tester', caption: 'NEWER FROM OTHER DEVICE', style: 'Cartoon', mediaType: 'video', videoUrl: 'https://x/new.mp4', isPublished: false, updatedAt: Date.now() };
    mockDreamSync(page, { ok: true, dreams: [newerServerDream] });
    page.route('**/.netlify/functions/account-login', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, username: 'tester', email: 'tester@example.com', authToken: 'tok' }) });
    });
    await seedUser(page, { dreams: [{ id: 'private-dream-1', ownerHandle: '@tester', caption: 'OLDER LOCAL CAPTION', style: 'Cartoon', likes: 0, likedByMe: false, isPublished: false, videoUrl: 'https://x/old.mp4', mediaType: 'video', updatedAt: 1000 }] });
    await safeGoto(page, baseUrl + '/login.html');
    await page.evaluate(function () {
      window.DreamStore.__loginResult = null;
      window.DreamStore.login('tester', 'realpassword1').then(function (r) { window.DreamStore.__loginResult = r; });
    });
    await page.waitForFunction(function () { return window.DreamStore.__loginResult !== null; });
    await new Promise(function (r) { setTimeout(r, 300); });

    var dream = await page.evaluate(function () { return window.DreamStore.getDream('private-dream-1'); });
    assert.equal(dream.caption, 'NEWER FROM OTHER DEVICE', 'a genuinely newer server-side edit must win over this device\'s stale local copy');
  } finally {
    await page.close();
  }
});

// ===== password-reset -> login navigation race (tracker item nsbbg5) =====
//
// Real production data-loss report: a forgot-password reset, followed
// immediately by login.html's own auto-login-then-redirect, lost every
// private dream that should have been restored from the server. Root
// cause (see reconcilePrivateDreamsFromServer's own doc comment): the
// reconcile GET was fire-and-forget, so login.html's `location.href =
// nextUrl` right after DreamStore.login() resolved could -- and, on any
// real network latency, reliably did -- abort the in-flight fetch mid-
// flight before its merge-into-localStorage ever ran. This drives the
// REAL reset-password UI end-to-end (not a direct DreamStore.login()
// call, unlike every other test in this file) specifically because only
// a real page navigation can exercise the race: a delayed-but-successful
// dream-sync response must still land in localStorage even though
// login.html redirects to home.html the instant DreamStore.login()'s
// promise resolves.

/** Same shape as mockDreamSync's GET branch, but resolves after `delayMs` -- long enough that, pre-fix, login.html's redirect reliably wins the race and the merge never lands. */
function mockDreamSyncDelayedGet(page, dreams, delayMs) {
  var calls = [];
  page.route('**/.netlify/functions/dream-sync*', function (route) {
    var req = route.request();
    if (req.method() === 'GET') {
      calls.push({ method: 'GET' });
      setTimeout(function () {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, dreams: dreams }) });
      }, delayMs);
    } else {
      calls.push({ method: 'POST', body: JSON.parse(req.postData()) });
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    }
  });
  return calls;
}

/** Mocks verify-password-reset.js for both the page-load peek (consume falsy) and the actual reset-submit consume:true+newPassword call login.html's reset form fires — same {token,username,email} identity throughout, matching the real endpoint's response shape. */
function mockVerifyPasswordReset(page, username, email) {
  page.route('**/.netlify/functions/verify-password-reset', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, username: username, email: email }) });
  });
}

test('reset-then-login (regression, nsbbg5): a real reset-password UI flow followed by login restores private dreams from the server despite network latency', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var serverDream = { id: 'ben-dream-1', ownerHandle: '@benbrightman14', caption: 'a dream from before the reset', style: 'Cartoon', mediaType: 'video', videoUrl: 'https://x/ben.mp4', isPublished: false, likes: 0, likedByMe: false, updatedAt: Date.now() - 100000 };
    // Deliberately delayed -- this is what the pre-fix code raced against
    // login.html's immediate post-login redirect.
    mockDreamSyncDelayedGet(page, [serverDream], 400);
    mockVerifyPasswordReset(page, 'benbrightman14', 'ben@example.com');
    page.route('**/.netlify/functions/account-login', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, username: 'benbrightman14', email: 'ben@example.com', authToken: 'fresh-token-after-reset' }) });
    });

    // A fresh-to-this-device login is the exact scenario this feature
    // exists for -- no seedUser() call here, deliberately: this device
    // has no local `accounts`/`dreams` entry for benbrightman14 at all,
    // same as a real webview wipe or a genuinely new browser.
    await safeGoto(page, baseUrl + '/login.html?reset=fake-reset-token');
    await page.waitForSelector('#reset-form', { state: 'visible' });
    await page.fill('#reset-password', 'newpassword1');
    await page.click('#reset-submit');

    // login.html's reset-submit handler chains DreamStore.resetPasswordLocally()
    // -> DreamStore.login() -> location.href = nextUrl (home.html by
    // default) -- this is the exact real redirect the race is about.
    await page.waitForURL(/home\.html/, { timeout: 5000 });

    var dreams = await page.evaluate(function () { return window.DreamStore.getMyDreams(); });
    assert.ok(
      dreams.some(function (d) { return d.id === 'ben-dream-1'; }),
      'a private dream synced to the server before the reset must be restored by the post-reset login, even though the dream-sync response landed after the redirect started'
    );
  } finally {
    await page.close();
  }
});
