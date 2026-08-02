// test/upload-dream-thumbnail.test.js
//
// Covers netlify/functions/upload-dream-thumbnail.js — the upload half of
// tracker item for-product-dream-ready-email-real-first-qr9fbj (founder
// request: a real first-frame video thumbnail in the "your dream is
// ready" retention email instead of the flat colored placeholder banner).
// Same conventions as test/dream-sync.test.js (mockBlobs + fakeEvent, a
// real register-account.js round trip to get a genuine authToken, not a
// hand-typed one) since this endpoint shares that file's exact
// authToken-verified identity bar. Also proves the write lands in a shape
// image-file.mjs (untouched by this feature) can already stream straight
// back out — see test/media-file-functions.test.js for that file's own
// direct coverage.
// Run with: node --test test/

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');

var registerHandler = require('../netlify/functions/register-account').handler;
var uploadHandler = require('../netlify/functions/upload-dream-thumbnail').handler;

var ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return '10.9.0.' + ipCounter;
}

test.beforeEach(function () {
  mockBlobs.reset();
});

/** Registers a brand-new real account and returns its freshly-minted authToken, same helper shape as test/dream-sync.test.js's registerAndGetToken. */
async function registerAndGetToken(username, password, email) {
  var res = await registerHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { username: username, password: password, email: email } }));
  var body = JSON.parse(res.body);
  assert.equal(body.ok, true, 'test setup: registration must succeed');
  assert.ok(body.authToken, 'test setup: register-account.js must mint a real authToken');
  return body.authToken;
}

// A real (tiny, 1x1) JPEG, base64-encoded — small enough to keep this
// file self-contained without a binary fixture, same spirit as this
// suite's other inline base64 fixtures.
var TINY_JPEG_B64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=';

function validImageDataUrl() {
  return 'data:image/jpeg;base64,' + TINY_JPEG_B64;
}

// ===== Method / body validation =====

test('rejects a non-POST method', async function () {
  var res = await uploadHandler(fakeEvent({ method: 'GET' }));
  assert.equal(res.statusCode, 405);
  assert.match(JSON.parse(res.body).error, /^E1: method_not_allowed/);
});

test('rejects invalid JSON', async function () {
  var res = await uploadHandler({ httpMethod: 'POST', headers: {}, body: 'not json{' });
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E2: invalid_json/);
});

test('rejects a request with no authToken', async function () {
  var res = await uploadHandler(fakeEvent({ method: 'POST', body: { dreamId: 'd1', imageDataUrl: validImageDataUrl() } }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E3: auth_token_required/);
});

test('rejects an invalid/unknown authToken with a 200 ok:false — a normal business outcome, not a 4xx/5xx, same shape dream-sync.js uses', async function () {
  var res = await uploadHandler(fakeEvent({ method: 'POST', body: { authToken: 'not-a-real-token', dreamId: 'd1', imageDataUrl: validImageDataUrl() } }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.match(body.error, /^E4: invalid_or_expired_token/);
});

test('rejects a missing/blank dreamId', async function () {
  var token = await registerAndGetToken('alice', 'realpassword1', 'alice@example.com');
  var res = await uploadHandler(fakeEvent({ method: 'POST', body: { authToken: token, imageDataUrl: validImageDataUrl() } }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E5: dream_id_required/);
});

test('rejects a missing imageDataUrl', async function () {
  var token = await registerAndGetToken('alice', 'realpassword1', 'alice@example.com');
  var res = await uploadHandler(fakeEvent({ method: 'POST', body: { authToken: token, dreamId: 'd1' } }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E6: invalid_image/);
});

test('rejects an imageDataUrl that is not a real data:image/(jpeg|png) url', async function () {
  var token = await registerAndGetToken('alice', 'realpassword1', 'alice@example.com');
  var cases = [
    'https://example.com/x.jpg',          // a plain url, not a data: url
    'data:text/plain;base64,aGVsbG8=',    // wrong mime type
    'data:image/gif;base64,R0lGODlhAQAB', // unsupported image type
    'not-a-data-url-at-all',
    ''
  ];
  for (var i = 0; i < cases.length; i++) {
    var res = await uploadHandler(fakeEvent({ method: 'POST', body: { authToken: token, dreamId: 'd1', imageDataUrl: cases[i] } }));
    assert.equal(res.statusCode, 400, 'case: ' + JSON.stringify(cases[i]));
    assert.match(JSON.parse(res.body).error, /^E6: invalid_image/, 'case: ' + JSON.stringify(cases[i]));
  }
});

test('rejects an image over MAX_THUMBNAIL_BYTES', async function () {
  var token = await registerAndGetToken('alice', 'realpassword1', 'alice@example.com');
  // 2 MiB + a bit of real (non-repeating-friendly) base64 data — big enough
  // to decode over the 2 MiB cap regardless of base64's ~4/3 expansion.
  var bigBase64 = Buffer.alloc(3 * 1024 * 1024, 'A').toString('base64');
  var res = await uploadHandler(fakeEvent({ method: 'POST', body: { authToken: token, dreamId: 'd1', imageDataUrl: 'data:image/jpeg;base64,' + bigBase64 } }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E7: image_too_large/);
});

// ===== Real success path =====

test('a verified account can upload a thumbnail and gets back a durable image-file.mjs url', async function () {
  var token = await registerAndGetToken('bob', 'realpassword1', 'bob@example.com');
  var res = await uploadHandler(fakeEvent({ method: 'POST', body: { authToken: token, dreamId: 'dream-1', imageDataUrl: validImageDataUrl() } }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.url, '/.netlify/functions/image-file?key=thumb%3Abob%3Adream-1', 'the key is namespaced by the VERIFIED username, not any client-claimed identity (encoded via lib/media-rehost.js\'s own durableUrl -- see its own encodeURIComponent)');
});

test('accepts a PNG too, not just JPEG', async function () {
  var token = await registerAndGetToken('bob', 'realpassword1', 'bob@example.com');
  // A real, tiny 1x1 PNG.
  var pngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  var res = await uploadHandler(fakeEvent({ method: 'POST', body: { authToken: token, dreamId: 'dream-png', imageDataUrl: 'data:image/png;base64,' + pngB64 } }));
  var body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.url, '/.netlify/functions/image-file?key=thumb%3Abob%3Adream-png');
});

test('the stored record is actually served back by the EXISTING, untouched image-file.mjs endpoint with the right content-type', async function () {
  var token = await registerAndGetToken('carol', 'realpassword1', 'carol@example.com');
  await uploadHandler(fakeEvent({ method: 'POST', body: { authToken: token, dreamId: 'dream-serve', imageDataUrl: validImageDataUrl() } }));

  var imageFile = (await import('../netlify/functions/image-file.mjs')).default;
  var res = await imageFile({ url: 'https://dreamtube1.netlify.app/.netlify/functions/image-file?key=thumb:carol:dream-serve' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'image/jpeg');
  var buf = await res.arrayBuffer();
  assert.ok(buf.byteLength > 0);
});

test('a second upload for the same account+dreamId overwrites the first — idempotent, not an error', async function () {
  var token = await registerAndGetToken('dave', 'realpassword1', 'dave@example.com');
  var first = await uploadHandler(fakeEvent({ method: 'POST', body: { authToken: token, dreamId: 'dream-dup', imageDataUrl: validImageDataUrl() } }));
  var second = await uploadHandler(fakeEvent({ method: 'POST', body: { authToken: token, dreamId: 'dream-dup', imageDataUrl: validImageDataUrl() } }));
  assert.equal(JSON.parse(first.body).ok, true);
  assert.equal(JSON.parse(second.body).ok, true);
  assert.equal(JSON.parse(first.body).url, JSON.parse(second.body).url);
});

// ===== Cross-account isolation =====

test('two different accounts uploading a thumbnail for the SAME dreamId string get independent keys — one can never overwrite the other', async function () {
  var tokenA = await registerAndGetToken('erin', 'realpassword1', 'erin@example.com');
  var tokenB = await registerAndGetToken('frank', 'realpassword1', 'frank@example.com');

  var resA = await uploadHandler(fakeEvent({ method: 'POST', body: { authToken: tokenA, dreamId: 'shared-dream-id', imageDataUrl: validImageDataUrl() } }));
  var resB = await uploadHandler(fakeEvent({ method: 'POST', body: { authToken: tokenB, dreamId: 'shared-dream-id', imageDataUrl: validImageDataUrl() } }));

  var urlA = JSON.parse(resA.body).url;
  var urlB = JSON.parse(resB.body).url;
  assert.notEqual(urlA, urlB);
  assert.equal(urlA, '/.netlify/functions/image-file?key=thumb%3Aerin%3Ashared-dream-id');
  assert.equal(urlB, '/.netlify/functions/image-file?key=thumb%3Afrank%3Ashared-dream-id');
});
