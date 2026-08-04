// test/email-suppression-store.test.js
//
// Covers netlify/functions/lib/email-suppression-store.js (tracker item
// for-product-email-redesign-unsubscribe-l-16ysmp) — the suppression-list
// half of the unsubscribe mechanism every retention/marketing sender must
// check before sending.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');

test.beforeEach(function () {
  mockBlobs.reset();
});

test('email-suppression-store: an email with no record is not suppressed', async function () {
  var store = require('../netlify/functions/lib/email-suppression-store');
  var event = fakeEvent({ method: 'GET' });
  assert.equal(await store.isSuppressed(event, 'nora@example.com'), false);
});

test('email-suppression-store: suppress() marks an email suppressed, and isSuppressed reports it true', async function () {
  var store = require('../netlify/functions/lib/email-suppression-store');
  var event = fakeEvent({ method: 'GET' });

  var result = await store.suppress(event, 'nora@example.com');
  assert.equal(result.ok, true);
  assert.equal(await store.isSuppressed(event, 'nora@example.com'), true);
});

test('email-suppression-store: suppressing the same email twice is idempotent -- no error, still suppressed', async function () {
  var store = require('../netlify/functions/lib/email-suppression-store');
  var event = fakeEvent({ method: 'GET' });

  var first = await store.suppress(event, 'nora@example.com');
  var second = await store.suppress(event, 'nora@example.com');
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(await store.isSuppressed(event, 'nora@example.com'), true);
});

test('email-suppression-store: normalizes case/whitespace -- suppressing one form suppresses every equivalent form', async function () {
  var store = require('../netlify/functions/lib/email-suppression-store');
  var event = fakeEvent({ method: 'GET' });

  await store.suppress(event, '  Nora@Example.COM  ');
  assert.equal(await store.isSuppressed(event, 'nora@example.com'), true);
  assert.equal(await store.isSuppressed(event, 'NORA@EXAMPLE.COM'), true);
});

test('email-suppression-store: a DIFFERENT email is unaffected by another email\'s suppression', async function () {
  var store = require('../netlify/functions/lib/email-suppression-store');
  var event = fakeEvent({ method: 'GET' });

  await store.suppress(event, 'nora@example.com');
  assert.equal(await store.isSuppressed(event, 'someone-else@example.com'), false);
});

test('email-suppression-store: an empty/invalid email is never treated as suppressed, and suppress() on one is a safe no-op', async function () {
  var store = require('../netlify/functions/lib/email-suppression-store');
  var event = fakeEvent({ method: 'GET' });

  assert.equal(await store.isSuppressed(event, ''), false);
  assert.equal(await store.isSuppressed(event, null), false);
  var result = await store.suppress(event, '');
  assert.equal(result.ok, false);
});
