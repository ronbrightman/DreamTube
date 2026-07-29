// test/block-user.test.js
//
// Covers the new public-feed-safety block flow (tracker item
// for-product-public-feed-safety-in-app-re-ppuw77):
//   - block-user.js: GET (read a signed-in account's durable blocklist),
//     POST block/unblock, validation, the cannot-block-self guard.
//   - lib/block-store.js: normalization, add/remove idempotency.
// Run with: node --test test/

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');

test.beforeEach(function () {
  mockBlobs.reset();
  delete require.cache[require.resolve('../netlify/functions/block-user')];
  delete require.cache[require.resolve('../netlify/functions/lib/block-store')];
});

// ===== block-user.js: GET =====

test('block-user GET: an account with no blocks on file gets an empty list back, not an error', async function () {
  var handler = require('../netlify/functions/block-user').handler;
  var res = await handler(fakeEvent({ method: 'GET', query: { username: 'nora' } }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { blockedHandles: [] });
});

test('block-user GET: rejects a missing username with E3', async function () {
  var handler = require('../netlify/functions/block-user').handler;
  var res = await handler(fakeEvent({ method: 'GET' }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E3: username_required/);
});

// ===== block-user.js: POST block/unblock =====

test('block-user POST: blocking a handle persists it, and GET reads it back', async function () {
  var handler = require('../netlify/functions/block-user').handler;
  var res = await handler(fakeEvent({ method: 'POST', body: { username: 'nora', blockedHandle: '@alice' } }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true, blockedHandles: ['@alice'] });

  var getRes = await handler(fakeEvent({ method: 'GET', query: { username: 'nora' } }));
  assert.deepEqual(JSON.parse(getRes.body), { blockedHandles: ['@alice'] });
});

test('block-user POST: default action is "block" when action is omitted', async function () {
  var handler = require('../netlify/functions/block-user').handler;
  var res = await handler(fakeEvent({ method: 'POST', body: { username: 'nora', blockedHandle: '@alice' } }));
  assert.deepEqual(JSON.parse(res.body).blockedHandles, ['@alice']);
});

test('block-user POST: blocking the same handle twice does not duplicate it', async function () {
  var handler = require('../netlify/functions/block-user').handler;
  await handler(fakeEvent({ method: 'POST', body: { username: 'nora', blockedHandle: '@alice' } }));
  var res = await handler(fakeEvent({ method: 'POST', body: { username: 'nora', blockedHandle: '@alice' } }));
  assert.deepEqual(JSON.parse(res.body).blockedHandles, ['@alice']);
});

test('block-user POST: unblock removes a handle; unblocking something never blocked is a harmless no-op', async function () {
  var handler = require('../netlify/functions/block-user').handler;
  await handler(fakeEvent({ method: 'POST', body: { username: 'nora', blockedHandle: '@alice' } }));
  await handler(fakeEvent({ method: 'POST', body: { username: 'nora', blockedHandle: '@bob' } }));

  var unblockRes = await handler(fakeEvent({ method: 'POST', body: { username: 'nora', blockedHandle: '@alice', action: 'unblock' } }));
  assert.equal(unblockRes.statusCode, 200);
  assert.deepEqual(JSON.parse(unblockRes.body).blockedHandles, ['@bob']);

  var noopRes = await handler(fakeEvent({ method: 'POST', body: { username: 'nora', blockedHandle: '@someone-never-blocked', action: 'unblock' } }));
  assert.equal(noopRes.statusCode, 200);
  assert.deepEqual(JSON.parse(noopRes.body).blockedHandles, ['@bob']);
});

test('block-user POST: two different accounts on the same server keep entirely separate blocklists', async function () {
  var handler = require('../netlify/functions/block-user').handler;
  await handler(fakeEvent({ method: 'POST', body: { username: 'nora', blockedHandle: '@alice' } }));
  await handler(fakeEvent({ method: 'POST', body: { username: 'priya', blockedHandle: '@carlos' } }));

  var noraRes = await handler(fakeEvent({ method: 'GET', query: { username: 'nora' } }));
  assert.deepEqual(JSON.parse(noraRes.body).blockedHandles, ['@alice']);
  var priyaRes = await handler(fakeEvent({ method: 'GET', query: { username: 'priya' } }));
  assert.deepEqual(JSON.parse(priyaRes.body).blockedHandles, ['@carlos']);
});

test('block-user POST: username is normalized case/whitespace-insensitively, same account either way', async function () {
  var handler = require('../netlify/functions/block-user').handler;
  await handler(fakeEvent({ method: 'POST', body: { username: '  Nora  ', blockedHandle: '@alice' } }));
  var res = await handler(fakeEvent({ method: 'GET', query: { username: 'nora' } }));
  assert.deepEqual(JSON.parse(res.body).blockedHandles, ['@alice']);
});

test('block-user POST: rejects blocking yourself (by handle, case-insensitive) with E5', async function () {
  var handler = require('../netlify/functions/block-user').handler;
  var res = await handler(fakeEvent({ method: 'POST', body: { username: 'nora', blockedHandle: '@NORA' } }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E5: cannot_block_self/);
});

test('block-user POST: rejects missing username/blockedHandle, invalid JSON, and non-GET/POST methods', async function () {
  var handler = require('../netlify/functions/block-user').handler;

  var noUsername = await handler(fakeEvent({ method: 'POST', body: { blockedHandle: '@alice' } }));
  assert.equal(noUsername.statusCode, 400);
  assert.match(JSON.parse(noUsername.body).error, /^E3: username_required/);

  var noHandle = await handler(fakeEvent({ method: 'POST', body: { username: 'nora' } }));
  assert.equal(noHandle.statusCode, 400);
  assert.match(JSON.parse(noHandle.body).error, /^E4: blocked_handle_required/);

  var badJson = await handler(fakeEvent({ method: 'POST', body: '{not json' }));
  assert.equal(badJson.statusCode, 400);
  assert.match(JSON.parse(badJson.body).error, /^E2: invalid_json/);

  var wrongMethod = await handler(fakeEvent({ method: 'DELETE' }));
  assert.equal(wrongMethod.statusCode, 405);
  assert.match(JSON.parse(wrongMethod.body).error, /^E1: method_not_allowed/);
});

// ===== lib/block-store.js directly =====

test('lib/block-store.js: getBlockedHandles returns [] for a username that has never blocked anyone', async function () {
  var blockStore = require('../netlify/functions/lib/block-store');
  var handles = await blockStore.getBlockedHandles(fakeEvent({ method: 'GET' }), 'brand-new-user');
  assert.deepEqual(handles, []);
});

test('lib/block-store.js: addBlockedHandle/removeBlockedHandle reject an invalid/empty handle', async function () {
  var blockStore = require('../netlify/functions/lib/block-store');
  var event = fakeEvent({ method: 'GET' });
  var addRes = await blockStore.addBlockedHandle(event, 'nora', '   ');
  assert.equal(addRes.ok, false);
  assert.equal(addRes.error, 'invalid_handle');
  var removeRes = await blockStore.removeBlockedHandle(event, 'nora', '');
  assert.equal(removeRes.ok, false);
  assert.equal(removeRes.error, 'invalid_handle');
});
