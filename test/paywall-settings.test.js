// test/paywall-settings.test.js
//
// Unit coverage for netlify/functions/lib/paywall-settings.js's precedence
// rule directly (override wins if set; otherwise fall back to
// PAYWALL_ENABLED) — generate-video.test.js additionally exercises this
// through the actual generate-video.js handler.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var paywallSettings = require('../netlify/functions/lib/paywall-settings');
var fakeEvent = {};

test.beforeEach(function () {
  mockBlobs.reset();
});

test('no override yet, PAYWALL_ENABLED unset -> disabled, source env-default', async function () {
  delete process.env.PAYWALL_ENABLED;
  var state = await paywallSettings.isPaywallEnabled(fakeEvent);
  assert.deepEqual(state, { enabled: false, source: 'env-default' });
});

test('no override yet, PAYWALL_ENABLED="true" -> enabled, source env-default', async function () {
  process.env.PAYWALL_ENABLED = 'true';
  var state = await paywallSettings.isPaywallEnabled(fakeEvent);
  assert.deepEqual(state, { enabled: true, source: 'env-default' });
  delete process.env.PAYWALL_ENABLED;
});

test('override true beats PAYWALL_ENABLED unset', async function () {
  delete process.env.PAYWALL_ENABLED;
  await paywallSettings.setOverride(fakeEvent, true);
  var state = await paywallSettings.isPaywallEnabled(fakeEvent);
  assert.deepEqual(state, { enabled: true, source: 'override' });
});

test('override false beats PAYWALL_ENABLED="true"', async function () {
  process.env.PAYWALL_ENABLED = 'true';
  await paywallSettings.setOverride(fakeEvent, false);
  var state = await paywallSettings.isPaywallEnabled(fakeEvent);
  assert.deepEqual(state, { enabled: false, source: 'override' });
  delete process.env.PAYWALL_ENABLED;
});

test('getOverride returns null until setOverride has been called', async function () {
  assert.equal(await paywallSettings.getOverride(fakeEvent), null);
  await paywallSettings.setOverride(fakeEvent, false);
  // false is a real, meaningful override (not "unset") — must come back as
  // false, not be confused with the null/never-set case.
  assert.equal(await paywallSettings.getOverride(fakeEvent), false);
});
