// test/start-pending-generation-audio-force.test.js
//
// Covers start-pending-generation.js's half of tracker item for-product-
// cheap-generation-profile-for-yz2ina. This originally forced
// generate_audio:false for OWNER_EMAIL/Israel-geo requests (Part B),
// reusing genVideo.resolveGenerationProfile. FOUNDER OVERRIDE 2026-07-29
// (tracker item for-product-audio-toggle-silently-overri-6qroev, verbatim:
// "Regarding Sound for Israel don't disable it just leave it the same for
// everyone, including myself.") removed that forcing entirely, in both
// this file and generate-video.js — resolveGenerationProfile no longer has
// a forceAudioOff field at all. This file has no client-facing audio
// toggle (Part A is style.html-only) — the base "audio on unless the
// caption was condensed" behavior is now simply unconditional for
// everyone, owner/IL included. The tests below guard against a regression
// back to the old forcing behavior.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var entitlements = require('../netlify/functions/lib/entitlements');
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

test('OWNER_EMAIL match: generate_audio stays true (no forcing) — response shape/status is unaffected', function () {
  return withEnv({ OWNER_EMAIL: 'wizarduser@example.com' }, async function () {
    var calls = installFetchSpy();
    var res = await handler(genEvent({}));
    assert.equal(res.statusCode, 200);
    var data = JSON.parse(res.body);
    assert.ok(data.pendingId);
    assert.match(data.operationName, /^fal:/);
    assert.equal(calls[0].body.generate_audio, true, 'owner status must no longer force audio off on this path either');
  });
});

test('an Israel-geo request: generate_audio stays true (no forcing) for a non-owner email', function () {
  var calls = installFetchSpy();
  return handler(genEvent({ headers: { 'x-nf-geo': geoHeaderFor('IL') } })).then(function (res) {
    assert.equal(res.statusCode, 200);
    assert.equal(calls[0].body.generate_audio, true, 'IL geo must no longer force audio off on this path either');
  });
});

test('a malformed x-nf-geo header: generate_audio stays true (unaffected either way, since geo no longer touches audio)', async function () {
  var calls = installFetchSpy();
  await handler(genEvent({ headers: { 'x-nf-geo': 'garbage-not-base64-json' } }));
  assert.equal(calls[0].body.generate_audio, true);
});

test('a condensed caption still forces audio off regardless of owner/IL status (unrelated, pre-existing gate — must not regress)', function () {
  return withEnv({ OWNER_EMAIL: 'wizarduser@example.com' }, async function () {
    var longCaption = new Array(80).join('I was flying through a golden sky above endless mountains and glowing rivers. ');
    process.env.GEM_API_KEY = 'test-gemini-key';
    var falCalls = [];
    global.fetch = async function (url, opts) {
      if (String(url).indexOf('generativelanguage.googleapis.com') !== -1) {
        return { ok: true, status: 200, json: async function () { return { candidates: [{ content: { parts: [{ text: 'a short condensed dream about flying' }] } }] }; } };
      }
      falCalls.push({ url: url, body: JSON.parse(opts.body) });
      return { ok: true, status: 200, json: async function () { return { request_id: 'fake-request-id' }; } };
    };
    try {
      var res = await handler(genEvent({ body: { caption: longCaption } }));
      assert.equal(res.statusCode, 200);
      assert.equal(falCalls.length, 1);
      assert.equal(falCalls[0].body.generate_audio, false, 'a condensed caption must never be narrated, owner or not');
    } finally {
      delete process.env.GEM_API_KEY;
    }
  });
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
