// test/start-pending-generation-audio-force.test.js
//
// Covers start-pending-generation.js's own audio decision, which used to
// track generate-video.js's own history exactly (see the tracker items
// listed in that file's own audio-toggle test for the full lineage) but is
// a genuinely separate computation — it has no client-facing audio toggle
// to combine with (Part A is style.html-only; wizard.html/start.html's
// pre-signup funnels never send one), so it needed its own fix when the
// contract changed, not just a shared import.
//
// CURRENT CONTRACT (tracker item for-product-turn-off-audio-dialogue-gene-
// ooeyoj, founder directive 2026-08-02): generate_audio is UNCONDITIONALLY
// false here too, regardless of OWNER_EMAIL, geo, or whether the caption
// was condensed. This was a real gap caught while implementing that
// directive — generate-video.js's own three-way AND was replaced with a
// flat `false`, but this file independently re-derived generateAudio
// (`!condensed.wasCondensed && !generationProfileResult.forceAudioOff`)
// and would otherwise have kept generating audio (and possible invented
// lip-synced dialogue) for every pre-signup wizard/start.html generation.

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

test('standard (non-owner, non-IL) request: generate_audio is false — a short, un-condensed caption used to get generate_audio:true here, no longer', async function () {
  var calls = installFetchSpy();
  var res = await handler(genEvent({ headers: { 'x-nf-geo': geoHeaderFor('US') } }));
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.generate_audio, false);
});

test('OWNER_EMAIL match: generate_audio is false, and the response shape/status is unchanged', function () {
  return withEnv({ OWNER_EMAIL: 'wizarduser@example.com' }, async function () {
    var calls = installFetchSpy();
    var res = await handler(genEvent({}));
    assert.equal(res.statusCode, 200);
    var data = JSON.parse(res.body);
    assert.ok(data.pendingId);
    assert.match(data.operationName, /^fal:/);
    assert.equal(calls[0].body.generate_audio, false);
  });
});

test('resolveGenerationProfile still labels the owner for cost-attribution logging on this path, and no longer returns a forceAudioOff field', function () {
  return withEnv({ OWNER_EMAIL: '  WizardUser@Example.com  ' }, async function () {
    var profile = genVideo.resolveGenerationProfile('wizarduser@example.com', fakeEvent({}));
    assert.equal(profile.profile, 'cheap_owner');
    assert.equal('forceAudioOff' in profile, false);
  });
});

test('an Israel-geo request: generate_audio is false, same as everyone else', function () {
  var calls = installFetchSpy();
  return handler(genEvent({ headers: { 'x-nf-geo': geoHeaderFor('IL') } })).then(function (res) {
    assert.equal(res.statusCode, 200);
    assert.equal(calls[0].body.generate_audio, false);
  });
});

test('a malformed x-nf-geo header: generate_audio is still false (the unconditional override doesn\'t depend on geo parsing)', async function () {
  var calls = installFetchSpy();
  await handler(genEvent({ headers: { 'x-nf-geo': 'garbage-not-base64-json' } }));
  assert.equal(calls[0].body.generate_audio, false);
});

test('a self-photo (reference-to-video) submission on this path is also generate_audio:false', function () {
  var calls = installFetchSpy();
  return handler(genEvent({
    body: {
      characterIds: null,
      characters: [{ name: 'Me', isSelf: true, photoDataUrl: 'data:image/png;base64,AAAA' }]
    }
  })).then(function (res) {
    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.generate_audio, false);
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
