// test/share-dream.test.js
//
// Unit coverage for netlify/functions/share-dream.js — tracker item
// for-product-build-share-mini-sheet-share-r42tc4, Part B (the researched
// gap: zero og: tags existed anywhere in this app before this file).
// Same mockBlobs + fakeEvent convention as test/publish-dream.test.js.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var { getStore } = require('@netlify/blobs');
var handler = require('../netlify/functions/share-dream').handler;

test.beforeEach(function () {
  mockBlobs.reset();
});

function getEvent(query, host) {
  return fakeEvent({ method: 'GET', query: query, headers: { host: host || 'dreamtube1.netlify.app' } });
}

function seedFeed(dreams) {
  return getStore('dreamtube-feed').setJSON('feed-index', dreams);
}

test('wrong method -> 405', async function () {
  var res = await handler(fakeEvent({ method: 'POST' }));
  assert.equal(res.statusCode, 405);
});

test('missing id -> 302 redirect to explore.html?notice=dream_gone', async function () {
  var res = await handler(getEvent(null));
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.Location, 'https://dreamtube1.netlify.app/explore.html?notice=dream_gone');
});

test('unknown/deleted dream id -> 302 redirect to explore.html?notice=dream_gone, never a raw error', async function () {
  await seedFeed([{ id: 'd-other', ownerHandle: '@x', caption: 'c', style: 'Cinematic', videoUrl: 'https://x/v.mp4', imageUrl: null, mediaType: 'video', likes: 0 }]);
  var res = await handler(getEvent({ id: 'd-does-not-exist' }));
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.Location, 'https://dreamtube1.netlify.app/explore.html?notice=dream_gone');
});

test('empty feed (Blobs read returns nothing yet) -> still a gentle redirect, not a crash', async function () {
  var res = await handler(getEvent({ id: 'd-anything' }));
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.Location, 'https://dreamtube1.netlify.app/explore.html?notice=dream_gone');
});

test('an image dream -> og:image is the dream\'s own imageUrl, og:title is the caption, og:url points at explore.html?id=', async function () {
  await seedFeed([{
    id: 'd-image-1', ownerHandle: '@artist', caption: 'Flying over a glass city',
    style: 'Cinematic', videoUrl: null, imageUrl: 'https://fal.media/files/image123.png', mediaType: 'image', likes: 5
  }]);
  var res = await handler(getEvent({ id: 'd-image-1' }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'text/html; charset=utf-8');

  var html = res.body;
  assert.match(html, /<meta property="og:title" content="Flying over a glass city">/);
  assert.match(html, /<meta property="og:image" content="https:\/\/fal\.media\/files\/image123\.png">/);
  assert.match(html, /<meta property="og:url" content="https:\/\/dreamtube1\.netlify\.app\/explore\.html\?id=d-image-1">/);
  assert.match(html, /<meta property="og:description" content="Create your own AI dream video on DreamTube">/);
});

test('a video dream -> og:image falls back to the static branded image (no poster-frame extraction in v1)', async function () {
  await seedFeed([{
    id: 'd-video-1', ownerHandle: '@artist', caption: 'A dream about the ocean',
    style: 'Realistic', videoUrl: 'https://fal.media/files/video123.mp4', imageUrl: null, mediaType: 'video', likes: 2
  }]);
  var res = await handler(getEvent({ id: 'd-video-1' }));
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /<meta property="og:image" content="https:\/\/dreamtube1\.netlify\.app\/assets\/logo-v3\.png">/);
  assert.match(res.body, /<meta property="og:title" content="A dream about the ocean">/);
});

test('a dream with mediaType "video" but a lingering imageUrl (post "Turn this into a video") still uses the branded fallback, not the stale image -- videoUrl wins the same way it does everywhere else in this app', async function () {
  await seedFeed([{
    id: 'd-both-1', ownerHandle: '@artist', caption: 'Both fields present',
    style: 'Cartoon', videoUrl: 'https://fal.media/files/v.mp4', imageUrl: 'https://fal.media/files/i.png', mediaType: 'video', likes: 0
  }]);
  var res = await handler(getEvent({ id: 'd-both-1' }));
  assert.match(res.body, /<meta property="og:image" content="https:\/\/dreamtube1\.netlify\.app\/assets\/logo-v3\.png">/);
});

test('caption/title values are HTML-escaped (a caption containing quotes/HTML must not break out of the meta tag or inject markup)', async function () {
  await seedFeed([{
    id: 'd-escape-1', ownerHandle: '@artist', caption: 'A "wild" <script>alert(1)</script> dream',
    style: 'Cartoon', videoUrl: null, imageUrl: 'https://fal.media/files/i.png', mediaType: 'image', likes: 0
  }]);
  var res = await handler(getEvent({ id: 'd-escape-1' }));
  assert.equal(res.statusCode, 200);
  assert.doesNotMatch(res.body, /<script>alert\(1\)<\/script>/, 'a raw <script> tag from the caption must never appear unescaped in the response');
  assert.match(res.body, /&lt;script&gt;/);
  assert.match(res.body, /&quot;wild&quot;/);
});

test('a caption-less/malformed dream record still renders a generic title rather than throwing', async function () {
  await seedFeed([{ id: 'd-no-caption', ownerHandle: '@x', caption: null, style: 'Cartoon', videoUrl: null, imageUrl: 'https://x/i.png', mediaType: 'image', likes: 0 }]);
  var res = await handler(getEvent({ id: 'd-no-caption' }));
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /<meta property="og:title" content="A dream on DreamTube">/);
});

test('human-visitor redirect: the page carries both a meta-refresh and a JS location.replace pointing at the canonical explore.html?id= URL', async function () {
  await seedFeed([{ id: 'd-redirect-1', ownerHandle: '@x', caption: 'c', style: 'Cartoon', videoUrl: null, imageUrl: 'https://x/i.png', mediaType: 'image', likes: 0 }]);
  var res = await handler(getEvent({ id: 'd-redirect-1' }));
  assert.match(res.body, /<meta http-equiv="refresh" content="0;url=https:\/\/dreamtube1\.netlify\.app\/explore\.html\?id=d-redirect-1">/);
  assert.match(res.body, /location\.replace\("https:\/\/dreamtube1\.netlify\.app\/explore\.html\?id=d-redirect-1"\)/);
});

test('host header respected via x-forwarded-host, same pattern every other emailed/shared-link function in this codebase uses', async function () {
  await seedFeed([{ id: 'd-host-1', ownerHandle: '@x', caption: 'c', style: 'Cartoon', videoUrl: null, imageUrl: 'https://x/i.png', mediaType: 'image', likes: 0 }]);
  var event = fakeEvent({ method: 'GET', query: { id: 'd-host-1' }, headers: { host: 'wrong.example', 'x-forwarded-host': 'dreamtube1.netlify.app' } });
  var res = await handler(event);
  assert.match(res.body, /<meta property="og:url" content="https:\/\/dreamtube1\.netlify\.app\/explore\.html\?id=d-host-1">/);
});

test('a crafted x-forwarded-host header cannot break out of the inline <script> tag (JSON.stringify alone does not escape < / >)', async function () {
  await seedFeed([{ id: 'd-xss-1', ownerHandle: '@x', caption: 'c', style: 'Cartoon', videoUrl: null, imageUrl: 'https://x/i.png', mediaType: 'image', likes: 0 }]);
  var evilHost = 'evil.example</script><script>alert(1)</script>';
  var event = fakeEvent({ method: 'GET', query: { id: 'd-xss-1' }, headers: { host: 'dreamtube1.netlify.app', 'x-forwarded-host': evilHost } });
  var res = await handler(event);
  assert.equal(res.statusCode, 200);
  assert.doesNotMatch(res.body, /<\/script><script>alert\(1\)<\/script>/, 'a crafted Host header must never produce an unescaped </script><script> sequence in the response body');
});

test('a well-formed x-forwarded-host with a port still works exactly as before (HOSTNAME_RE allows hostname:port)', async function () {
  await seedFeed([{ id: 'd-port-1', ownerHandle: '@x', caption: 'c', style: 'Cartoon', videoUrl: null, imageUrl: 'https://x/i.png', mediaType: 'image', likes: 0 }]);
  var event = fakeEvent({ method: 'GET', query: { id: 'd-port-1' }, headers: { host: 'wrong.example', 'x-forwarded-host': 'preview-123.netlify.app:8888' } });
  var res = await handler(event);
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /<meta property="og:url" content="https:\/\/preview-123\.netlify\.app:8888\/explore\.html\?id=d-port-1">/);
});

test('a CRLF-laden x-forwarded-host does not survive verbatim into the Location header of a redirect -- missing id case', async function () {
  var event = fakeEvent({ method: 'GET', query: null, headers: { host: 'dreamtube1.netlify.app', 'x-forwarded-host': 'evil.example\r\nSet-Cookie: pwned=1' } });
  var res = await handler(event);
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.Location, 'https://dreamtube1.netlify.app/explore.html?notice=dream_gone');
  assert.doesNotMatch(res.headers.Location, /[\r\n]/);
});

test('a CRLF-laden x-forwarded-host does not survive verbatim into the Location header of a redirect -- dream-not-found case', async function () {
  await seedFeed([{ id: 'd-other', ownerHandle: '@x', caption: 'c', style: 'Cartoon', videoUrl: null, imageUrl: 'https://x/i.png', mediaType: 'image', likes: 0 }]);
  var event = fakeEvent({ method: 'GET', query: { id: 'd-does-not-exist' }, headers: { host: 'dreamtube1.netlify.app', 'x-forwarded-host': 'evil.example\r\nSet-Cookie: pwned=1' } });
  var res = await handler(event);
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.Location, 'https://dreamtube1.netlify.app/explore.html?notice=dream_gone');
  assert.doesNotMatch(res.headers.Location, /[\r\n]/);
});

test('a CRLF-laden x-forwarded-host falls back to the safe default host for the OG-preview-page path too, not just redirects', async function () {
  await seedFeed([{ id: 'd-crlf-og-1', ownerHandle: '@x', caption: 'c', style: 'Cartoon', videoUrl: null, imageUrl: 'https://x/i.png', mediaType: 'image', likes: 0 }]);
  var event = fakeEvent({ method: 'GET', query: { id: 'd-crlf-og-1' }, headers: { host: 'dreamtube1.netlify.app', 'x-forwarded-host': 'evil.example\r\nX-Injected: 1' } });
  var res = await handler(event);
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /<meta property="og:url" content="https:\/\/dreamtube1\.netlify\.app\/explore\.html\?id=d-crlf-og-1">/);
  assert.doesNotMatch(res.body, /[\r\n]X-Injected/);
});

test('a Blobs read failure is treated the same as "not found" -- a gentle redirect, never a raw 500', async function () {
  mockBlobs.setReadOverride('dreamtube-feed', function () { throw new Error('boom'); });
  var res = await handler(getEvent({ id: 'd-whatever' }));
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.Location, 'https://dreamtube1.netlify.app/explore.html?notice=dream_gone');
  mockBlobs.clearReadOverride('dreamtube-feed');
});
