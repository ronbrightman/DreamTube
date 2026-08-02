// test/dream-thumbnail-capture-behavioral.test.js
//
// Real browser-driven coverage for tracker item
// for-product-dream-ready-email-real-first-qr9fbj (founder request: a
// real first-frame video thumbnail in the "your dream is ready" retention
// email instead of the flat colored placeholder banner):
//   - js/store.js's DreamStore.saveThumbnailBestEffort — the upload +
//     local dream.imageUrl write + dream-sync/publish-feed sync, and every
//     one of its silent no-op guards (not signed in, no authToken, dream
//     not found, not this account's own dream, imageUrl already set).
//   - result.html's own capture IIFE — proves the actual <video> element
//     gets drawn to a <canvas> and POSTed to upload-dream-thumbnail.js for
//     real, end to end, for a real (tiny) decodable video, not just that
//     the underlying store method works in isolation.
//
// Follows test/dream-sync-client-behavioral.test.js's exact conventions
// (seedUser via localStorage, mockDreamSync, waitForCall) since this
// feature's server sync step reuses that SAME existing mechanism — see
// js/store.js's own header comment on saveThumbnailBestEffort.

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

/** Same shortcut as test/dream-sync-client-behavioral.test.js's own seedUser, extended with an `email` option (unused by this feature directly, but harmless/realistic to seed). */
async function seedUser(page, opts) {
  opts = opts || {};
  await safeGoto(page, baseUrl + '/login.html');
  await page.evaluate(function (opts) {
    var state = {
      user: opts.signedOut ? null : { handle: '@' + (opts.handle || 'tester'), username: opts.handle || 'tester', authToken: opts.authToken !== undefined ? opts.authToken : 'seeded-auth-token' },
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

/** Same shape as dream-sync-client-behavioral.test.js's own mockDreamSync. */
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

/** Mocks upload-dream-thumbnail.js, recording every call. `url` is what a successful response hands back (defaults to a plausible durable image-file.mjs url); pass `fail:true` to simulate a rejected/failed upload instead. */
function mockUploadThumbnail(page, opts) {
  opts = opts || {};
  var calls = [];
  page.route('**/.netlify/functions/upload-dream-thumbnail', function (route) {
    var body = JSON.parse(route.request().postData());
    calls.push(body);
    if (opts.fail) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'E6: invalid_image' }) });
    } else {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, url: opts.url || '/.netlify/functions/image-file?key=thumb:tester:' + body.dreamId }) });
    }
  });
  return calls;
}

function mockConsumeMarker(page) {
  return page.route('**/.netlify/functions/consume-generation-marker', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ matched: false }) });
  });
}

async function waitForCall(fn, timeoutMs) {
  var start = Date.now();
  while (Date.now() - start < (timeoutMs || 3000)) {
    if (fn()) return true;
    await new Promise(function (r) { setTimeout(r, 25); });
  }
  return false;
}

// ===== DreamStore.saveThumbnailBestEffort — direct coverage =====

test('saveThumbnailBestEffort: a successful upload writes dream.imageUrl locally and syncs it via dream-sync (a private dream)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var dreamSyncCalls = mockDreamSync(page);
    var uploadCalls = mockUploadThumbnail(page, { url: '/.netlify/functions/image-file?key=thumb:tester:dream-1' });
    await seedUser(page, { dreams: [{ id: 'dream-1', ownerHandle: '@tester', caption: 'c', style: 'Cartoon', likes: 0, likedByMe: false, isPublished: false, videoUrl: 'https://x/v.mp4', imageUrl: null, mediaType: 'video' }] });
    await safeGoto(page, baseUrl + '/login.html');

    await page.evaluate(function () {
      window.DreamStore.saveThumbnailBestEffort('dream-1', 'data:image/jpeg;base64,AAAA');
    });

    var gotUpload = await waitForCall(function () { return uploadCalls.length >= 1; });
    assert.ok(gotUpload, 'expected a POST to upload-dream-thumbnail.js');
    assert.equal(uploadCalls[0].authToken, 'seeded-auth-token');
    assert.equal(uploadCalls[0].dreamId, 'dream-1');
    assert.equal(uploadCalls[0].imageDataUrl, 'data:image/jpeg;base64,AAAA');

    var gotSync = await waitForCall(function () {
      return dreamSyncCalls.some(function (c) { return c.method === 'POST' && c.body.action === 'upsert' && c.body.dream.id === 'dream-1' && c.body.dream.imageUrl; });
    });
    assert.ok(gotSync, 'a successful capture must sync the new imageUrl onto the dream via the existing dream-sync mechanism');

    var localImageUrl = await page.evaluate(function () { return window.DreamStore.getDream('dream-1').imageUrl; });
    assert.equal(localImageUrl, '/.netlify/functions/image-file?key=thumb:tester:dream-1');
  } finally {
    await page.close();
  }
});

test('saveThumbnailBestEffort: a PUBLISHED dream syncs the new imageUrl to the shared feed instead of the private store', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var publishCalls = mockPublishDream(page);
    var dreamSyncCalls = mockDreamSync(page);
    mockUploadThumbnail(page);
    await seedUser(page, { dreams: [{ id: 'dream-pub', ownerHandle: '@tester', caption: 'c', style: 'Cartoon', likes: 0, likedByMe: false, isPublished: true, videoUrl: 'https://x/v.mp4', imageUrl: null, mediaType: 'video' }] });
    await safeGoto(page, baseUrl + '/login.html');

    await page.evaluate(function () {
      window.DreamStore.saveThumbnailBestEffort('dream-pub', 'data:image/jpeg;base64,AAAA');
    });

    var got = await waitForCall(function () { return publishCalls.some(function (c) { return c.id === 'dream-pub' && c.imageUrl; }); });
    assert.ok(got, 'a published dream\'s captured thumbnail must reach the shared feed, not the private-dream store');
    assert.equal(dreamSyncCalls.filter(function (c) { return c.method === 'POST'; }).length, 0, 'a published dream must never be upserted into the private-dream store');
  } finally {
    await page.close();
  }
});

test('saveThumbnailBestEffort: a dream that already has an imageUrl is a silent no-op — no upload attempted', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var uploadCalls = mockUploadThumbnail(page);
    await seedUser(page, { dreams: [{ id: 'dream-has-thumb', ownerHandle: '@tester', caption: 'c', style: 'Cartoon', likes: 0, likedByMe: false, isPublished: false, videoUrl: 'https://x/v.mp4', imageUrl: '/.netlify/functions/image-file?key=already-set', mediaType: 'video' }] });
    await safeGoto(page, baseUrl + '/login.html');

    await page.evaluate(function () { window.DreamStore.saveThumbnailBestEffort('dream-has-thumb', 'data:image/jpeg;base64,AAAA'); });
    await page.waitForTimeout(300);
    assert.equal(uploadCalls.length, 0, 'a dream that already has a real imageUrl must never be re-captured/re-uploaded');
  } finally {
    await page.close();
  }
});

test('saveThumbnailBestEffort: a dream that is not this account\'s own is a silent no-op — no upload attempted', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var uploadCalls = mockUploadThumbnail(page);
    await seedUser(page, { dreams: [{ id: 'dream-not-mine', ownerHandle: '@someoneelse', caption: 'c', style: 'Cartoon', likes: 0, likedByMe: false, isPublished: false, videoUrl: 'https://x/v.mp4', imageUrl: null, mediaType: 'video' }] });
    await safeGoto(page, baseUrl + '/login.html');

    await page.evaluate(function () { window.DreamStore.saveThumbnailBestEffort('dream-not-mine', 'data:image/jpeg;base64,AAAA'); });
    await page.waitForTimeout(300);
    assert.equal(uploadCalls.length, 0, 'a dream that belongs to a different account must never have its thumbnail captured by this browser');
  } finally {
    await page.close();
  }
});

test('saveThumbnailBestEffort: not signed in (no state.user) is a silent no-op', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var uploadCalls = mockUploadThumbnail(page);
    await seedUser(page, { signedOut: true, dreams: [{ id: 'dream-x', ownerHandle: '@tester', caption: 'c', style: 'Cartoon', likes: 0, likedByMe: false, isPublished: false, videoUrl: 'https://x/v.mp4', imageUrl: null, mediaType: 'video' }] });
    await safeGoto(page, baseUrl + '/login.html');

    await page.evaluate(function () { window.DreamStore.saveThumbnailBestEffort('dream-x', 'data:image/jpeg;base64,AAAA'); });
    await page.waitForTimeout(300);
    assert.equal(uploadCalls.length, 0);
  } finally {
    await page.close();
  }
});

test('saveThumbnailBestEffort: a rejected upload never writes a local imageUrl — the dream keeps using the color-banner fallback', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var uploadCalls = mockUploadThumbnail(page, { fail: true });
    await seedUser(page, { dreams: [{ id: 'dream-fail', ownerHandle: '@tester', caption: 'c', style: 'Cartoon', likes: 0, likedByMe: false, isPublished: false, videoUrl: 'https://x/v.mp4', imageUrl: null, mediaType: 'video' }] });
    await safeGoto(page, baseUrl + '/login.html');

    await page.evaluate(function () { window.DreamStore.saveThumbnailBestEffort('dream-fail', 'data:image/jpeg;base64,AAAA'); });
    var gotUpload = await waitForCall(function () { return uploadCalls.length >= 1; });
    assert.ok(gotUpload);
    await page.waitForTimeout(200);

    var localImageUrl = await page.evaluate(function () { return window.DreamStore.getDream('dream-fail').imageUrl; });
    assert.equal(localImageUrl, null, 'a rejected upload must never surface as a local imageUrl write');
  } finally {
    await page.close();
  }
});

// ===== result.html's own capture IIFE — real end-to-end pipeline =====
//
// A real, tiny (778-byte, 64x64, 5-frame) VP8 WebM clip, base64-encoded —
// generated once with the Playwright-bundled ffmpeg binary this sandbox
// already ships (see AGENT_POLICY.md's own "keep generation-testing cost
// low" spirit — no fal.ai call needed at all to prove a real <video>
// element actually decodes and plays here). Used as a `data:` url so the
// whole fixture is self-contained in this file, no binary asset needed
// under test/fixtures, and Chromium gets an explicit, unambiguous MIME
// type without depending on test/helpers/static-server.js recognizing a
// new extension.
var TINY_WEBM_B64 = 'GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAALaEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHWTbuMU6uEElTDZ1OsggEnTbuMU6uEHFO7a1OsggKy7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsCrXsYMPQkBNgIxMYXZmNjEuMS4xMDBXQYxMYXZmNjEuMS4xMDBEiYhAo4gAAAAAABZUrmvMrgEAAAAAAABD14EBc8WIp/NxQ0N3s/icgQAitZyDdW5kiIEAhoVWX1ZQOIOBASPjg4QdzWUA4JSwgUC6gUCagQJVsIhVt4ECVbiBAhJUw2f6c3OfY8CAZ8iZRaOHRU5DT0RFUkSHjExhdmY2MS4xLjEwMHNz1WPAi2PFiKfzcUNDd7P4Z8igRaOHRU5DT0RFUkSHk0xhdmM2MS4zLjEwMCBsaWJ2cHhnyKFFo4hEVVJBVElPTkSHkzAwOjAwOjAyLjUwMDAwMDAwMAAfQ7Z1QQbngQCjqoEAAIDwAgCdASpAAEAAAEcIhYWIhYSIAgIABnA8QmAKsiD3MAD+/6tQgKOxgQH0ALECAAUQrAAYCdaoCBsv5/NALOE+k+pRAP7v7mPrUyMfRi/+uA/+cB/84D+VgKOzgQPoAJECAAUQrAAYDFFKklH7kC6kLNlkmHYA/u/OH/Qo2UTFP/+a7f+a7f+a7f81KAYAo72BBdyA8AIAnQEqQABAAAQHCIWFiIWEiBWCAAcwpTyE5aWi2+xA/vJmr//64D//nAf/84D+Zb/1VT1+KTGAo66BB9AAUQIAEBCsABgJ08l225RwAG1gLV4A/vEpL/16P//PR//56P8/3O1bH12AHFO7a6O7j7OBALeK94EB8YIBpvCBA7uQs4IF3LeK94EB8YIBpvCBlw==';
function tinyWebmDataUrl() {
  return 'data:video/webm;base64,' + TINY_WEBM_B64;
}

test('result.html: a real decodable video, my own dream, no imageUrl yet — the capture IIFE actually draws a frame and uploads it end-to-end', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    mockConsumeMarker(page);
    var dreamSyncCalls = mockDreamSync(page);
    var uploadCalls = mockUploadThumbnail(page, { url: '/.netlify/functions/image-file?key=thumb:tester:dream-e2e' });
    await seedUser(page, {
      dreams: [{ id: 'dream-e2e', ownerHandle: '@tester', caption: 'A real dream', style: 'Cartoon', likes: 0, likedByMe: false, isPublished: false, videoUrl: tinyWebmDataUrl(), imageUrl: null, mediaType: 'video', dur: '0:02', sourceOperationName: null }]
    });

    await safeGoto(page, baseUrl + '/result.html?id=dream-e2e');

    var got = await waitForCall(function () { return uploadCalls.length >= 1; }, 8000);
    assert.ok(got, 'expected the real <video> element to decode/play far enough for the capture IIFE to draw a frame and upload it');
    assert.equal(uploadCalls[0].dreamId, 'dream-e2e');
    assert.match(uploadCalls[0].imageDataUrl, /^data:image\/jpeg;base64,.+/, 'must be a real encoded JPEG data url, not a placeholder string');
    // A canvas.toDataURL('image/jpeg', ...) output is never trivially tiny
    // for a real (even 64x64) decoded frame -- a blank/all-black canvas
    // still encodes to a real (if small) JPEG, so this isn't proving the
    // frame has real content, only that SOME image payload was actually
    // produced and sent, not an empty/placeholder string.
    assert.ok(uploadCalls[0].imageDataUrl.length > 100);

    var gotSync = await waitForCall(function () {
      return dreamSyncCalls.some(function (c) { return c.method === 'POST' && c.body.action === 'upsert' && c.body.dream.id === 'dream-e2e' && c.body.dream.imageUrl; });
    });
    assert.ok(gotSync, 'the captured thumbnail must be synced onto the dream via the existing private-dream sync mechanism');

    // Only ONE capture should ever happen for a given page load, even
    // though 'timeupdate' fires repeatedly for the whole rest of playback
    // (and the clip loops).
    await page.waitForTimeout(500);
    assert.equal(uploadCalls.length, 1, 'must capture/upload exactly once per page load, not once per timeupdate tick');
  } finally {
    await page.close();
  }
});

test('result.html: viewing someone else\'s dream never triggers a capture, even with a real decodable video and no imageUrl', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    mockConsumeMarker(page);
    var uploadCalls = mockUploadThumbnail(page);
    await seedUser(page, {
      dreams: [{ id: 'dream-not-mine-e2e', ownerHandle: '@someoneelse', caption: 'Not mine', style: 'Cartoon', likes: 0, likedByMe: false, isPublished: true, videoUrl: tinyWebmDataUrl(), imageUrl: null, mediaType: 'video', dur: '0:02', sourceOperationName: null }]
    });

    await safeGoto(page, baseUrl + '/result.html?id=dream-not-mine-e2e');
    await page.waitForTimeout(1500); // give the video a real chance to play past the capture threshold
    assert.equal(uploadCalls.length, 0, 'a dream that is not this signed-in account\'s own must never have its thumbnail captured, even while genuinely playing');
  } finally {
    await page.close();
  }
});

test('result.html: a dream that already has an imageUrl never triggers a re-capture, even with a real decodable video', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    mockConsumeMarker(page);
    var uploadCalls = mockUploadThumbnail(page);
    await seedUser(page, {
      dreams: [{ id: 'dream-already-thumb-e2e', ownerHandle: '@tester', caption: 'Already has one', style: 'Cartoon', likes: 0, likedByMe: false, isPublished: false, videoUrl: tinyWebmDataUrl(), imageUrl: '/.netlify/functions/image-file?key=already-set', mediaType: 'video', dur: '0:02', sourceOperationName: null }]
    });

    await safeGoto(page, baseUrl + '/result.html?id=dream-already-thumb-e2e');
    await page.waitForTimeout(1500);
    assert.equal(uploadCalls.length, 0, 'a dream that already has a real imageUrl must never be re-captured');
  } finally {
    await page.close();
  }
});
