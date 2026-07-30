// test/start-pending-generation-audio-force.test.js
//
// Covers start-pending-generation.js's half of tracker item for-product-
// cheap-generation-profile-for-yz2ina (Part B): this path resolves the
// same generation profile generate-video.js's own handler does (see
// genVideo.resolveGenerationProfile, reused here rather than
// reimplemented) so the two submission paths can never drift apart.
//
// The profile's audio-off FORCING was retired by founder directive on
// 2026-07-29 ("Regarding Sound for Israel don't disable it just leave it
// the same for everyone, including myself") — resolveGenerationProfile
// now always returns forceAudioOff:false and the profile label survives
// for cost-attribution logging only. What this file pins today is
// therefore the absence of any override: generate_audio is decided purely
// by the pre-existing "audio on unless the caption was condensed" rule,
// identically for owner, Israel-geo, and everyone else. (This file has no
// client-facing audio toggle to combine with — Part A is style.html-only.)

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var entitlements = require('../netlify/functions/lib/entitlements');
var genVideo = require('../netlify/functions/generate-video');
var handler = require('../netlify/functions/start-pending-generation').handler;

var realFetch = global.fetch;
var ipCounter = 0;
function nextIp() { ipCounter += 1; return '10.10.0.' + ipCounter; }

function withEnv(vars, fn) {
  var previous = {};
  Object.keys(vars).forEach(function (k) { previous[k] = process.env[k]; });
  Object.keys(vars).forEach(function (k) {
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  });
  return Promise.resolve()
    .then(fn)
    .finally(function () {
      Object.keys(previous).forEach(function (k) {
        if (previous[k] === undefined) delete process.env[k];
        else process.env[k] = previous[k];
      });
    });
}

/** Base64-encodes a country code the same shape Netlify's real x-nf-geo header carries — see netlify/functions/lib/geo.js. */
function geoHeaderFor(countryCode) {
  return Buffer.from(JSON.stringify({ city: 'Test City', country: { code: countryCode, name: 'Test' } }), 'utf8').toString('base64');
}

function genEvent(overrides) {
  overrides = overrides || {};
  return fakeEvent({
    method: 'POST',
    ip: overrides.ip || nextIp(),
    headers: Object.assign({ host: 'dreamtube1.netlify.app' }, overrides.headers),
    body: Object.assign({ email: 'wizarduser@example.com', caption: 'a short wizard dream', style: 'Cinematic' }, overrides.body)
  });
}

function installFetchSpy() {
  var calls = [];
  global.fetch = async function (url, opts) {
    calls.push({ url: url, body: opts && opts.body ? JSON.parse(opts.body) : null });
    return { ok: true, status: 200, json: async function () { return { request_id: 'fake-request-id' }; } };
  };
  return calls;
}

test.beforeEach(async function () {
  mockBlobs.reset();
  global.fetch = realFetch;
  process.env.FAL_KEY = 'test-fal-key';
  delete process.env.DAILY_SPEND_CAP_USD;
  delete process.env.MAX_GENERATIONS_PER_IP_PER_DAY;
  delete process.env.MAX_TOKEN_GRANTS_PER_IP_PER_DAY;
  delete process.env.GENERATION_MOCK_MODE;
  delete process.env.TURNSTILE_SECRET_KEY;
  delete process.env.OWNER_EMAIL;
  await entitlements.setEntitlement({}, 'wizarduser@example.com', { tokens: { balance: 100000, lastClaimAt: Date.now() } });
});
test.after(function () { global.fetch = realFetch; delete process.env.OWNER_EMAIL; });

test('standard (non-owner, non-IL) request keeps the pre-existing "audio on unless condensed" default — a short caption gets generate_audio:true, unaffected', async function () {
  var calls = installFetchSpy();
  var res = await handler(genEvent({ headers: { 'x-nf-geo': geoHeaderFor('US') } }));
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.generate_audio, true);
});

// ----- The owner/IL audio force-off is RETIRED (founder directive
// 2026-07-29: "Regarding Sound for Israel don't disable it just leave it
// the same for everyone, including myself" — see
// genVideo.resolveGenerationProfile, which now always returns
// forceAudioOff:false). test/generate-video-audio-toggle.test.js was
// updated to pin that new contract on generate-video.js's own path at the
// time; THIS file was missed and kept asserting the removed behavior, so
// these two tests have been failing deterministically on main ever since
// — red on every full-suite run, in isolation too. Rewritten here to pin
// the same contract this path actually has: audio is decided purely by
// the "on unless the caption was condensed" rule, identically for owner,
// Israel-geo, and everyone else; the profile label survives for
// cost-attribution logging only.

test('OWNER_EMAIL match no longer forces generate_audio:false — audio is unaffected, and the response shape/status is unchanged', function () {
  return withEnv({ OWNER_EMAIL: 'wizarduser@example.com' }, async function () {
    var calls = installFetchSpy();
    var res = await handler(genEvent({}));
    assert.equal(res.statusCode, 200);
    var data = JSON.parse(res.body);
    assert.ok(data.pendingId);
    assert.match(data.operationName, /^fal:/);
    assert.equal(calls[0].body.generate_audio, true);
  });
});

test('resolveGenerationProfile still labels the owner for cost attribution on this path, without forcing audio off', function () {
  return withEnv({ OWNER_EMAIL: '  WizardUser@Example.com  ' }, async function () {
    var profile = genVideo.resolveGenerationProfile('wizarduser@example.com', fakeEvent({}));
    assert.equal(profile.profile, 'cheap_owner');
    assert.equal(profile.forceAudioOff, false);
  });
});

test('an Israel-geo request keeps generate_audio:true, same as everyone else', function () {
  var calls = installFetchSpy();
  return handler(genEvent({ headers: { 'x-nf-geo': geoHeaderFor('IL') } })).then(function (res) {
    assert.equal(res.statusCode, 200);
    assert.equal(calls[0].body.generate_audio, true);
  });
});

test('a malformed x-nf-geo header fails open (generate_audio stays true) rather than silently forcing the cheap path', async function () {
  var calls = installFetchSpy();
  await handler(genEvent({ headers: { 'x-nf-geo': 'garbage-not-base64-json' } }));
  assert.equal(calls[0].body.generate_audio, true);
});

test('mediaType:"image" requests are untouched by this profile entirely (no generate_audio concept for a still image)', function () {
  return withEnv({ OWNER_EMAIL: 'wizarduser@example.com' }, async function () {
    var calls = [];
    global.fetch = async function (url, opts) {
      calls.push({ url: url, body: opts && opts.body ? JSON.parse(opts.body) : null });
      return { ok: true, status: 200, json: async function () { return { images: [{ url: 'https://example.com/fake.jpg' }] }; } };
    };
    var res = await handler(genEvent({ body: { mediaType: 'image' } }));
    assert.equal(res.statusCode, 200);
    // generate-image.js's own request body has no generate_audio key at all.
    assert.equal(Object.prototype.hasOwnProperty.call(calls[0].body, 'generate_audio'), false);
  });
});
