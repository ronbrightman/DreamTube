// test/generate-video-audio-toggle.test.js
//
// Covers netlify/functions/generate-video.js's two audio-related tracker
// items, both founder-approved 2026-07-28:
//   - for-product-audio-on-off-choice-at-creat-dyyr98 (Part A): style.html's
//     client-side audio/music toggle — DEFAULT OFF, only sent to fal when
//     the client actually asked for it (and the caption wasn't condensed —
//     existing, pre-dating behavior this must not regress), with the
//     musicStyle preset folded into the prompt only when audio ends up
//     actually on.
//   - for-product-cheap-generation-profile-for-yz2ina (Part B, SCOPED to
//     audio-off-forcing only): OWNER_EMAIL or an Israel-geo request forces
//     generate_audio:false server-side, silently, regardless of what the
//     client asked for.
//   - Token cost stays flat at 100 regardless of audio on/off (founder
//     explicit — no split pricing).

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var entitlements = require('../netlify/functions/lib/entitlements');
var handler = require('../netlify/functions/generate-video').handler;

var realFetch = global.fetch;
var ipCounter = 0;

function nextIp() {
  ipCounter += 1;
  return '10.2.0.' + ipCounter;
}

var DEFAULT_EMAIL = 'audiotoggle@example.com';

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
    headers: overrides.headers,
    body: Object.assign({ caption: 'a dream about flying over mountains', style: 'Cartoon', email: DEFAULT_EMAIL }, overrides.body)
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
  delete process.env.GENERATION_MOCK_MODE;
  delete process.env.GENERATION_TEST_DURATION;
  delete process.env.OWNER_EMAIL;
  process.env.FAL_KEY = 'test-fal-key';
  await entitlements.setEntitlement({}, DEFAULT_EMAIL, { tokens: { balance: 100000, lastClaimAt: Date.now() } });
});

test.after(function () {
  global.fetch = realFetch;
  delete process.env.OWNER_EMAIL;
});

// ----- Part A: client toggle, default off -----

test('audioOn omitted entirely (every pre-existing caller): generate_audio is false, same as an explicit audioOn:false', async function () {
  var calls = installFetchSpy();
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.generate_audio, false);
});

test('audioOn:true, no musicStyle: generate_audio is true, prompt gets no music modifier appended', async function () {
  var calls = installFetchSpy();
  var res = await handler(genEvent({ body: { audioOn: true } }));
  assert.equal(res.statusCode, 200);
  assert.equal(calls[0].body.generate_audio, true);
});

test('audioOn:true + musicStyle:"cinematic": generate_audio true, prompt carries the cinematic modifier', async function () {
  var calls = installFetchSpy();
  await handler(genEvent({ body: { audioOn: true, musicStyle: 'cinematic' } }));
  assert.equal(calls[0].body.generate_audio, true);
  assert.match(calls[0].body.prompt, /cinematic orchestral score/);
});

test('each of the four music presets maps to its own distinct prompt modifier', async function () {
  var presets = { dreamy: /dreamy ambient/, cinematic: /cinematic orchestral/, upbeat: /upbeat, energetic/, 'none-ambient': /no distinct music/ };
  for (var style in presets) {
    var calls = installFetchSpy();
    await handler(genEvent({ body: { audioOn: true, musicStyle: style } }));
    assert.match(calls[0].body.prompt, presets[style], 'musicStyle=' + style);
  }
});

test('an unrecognized musicStyle is silently ignored (no modifier appended, no crash) rather than guessed at', async function () {
  var calls = installFetchSpy();
  var res = await handler(genEvent({ body: { audioOn: true, musicStyle: 'not-a-real-style' } }));
  assert.equal(res.statusCode, 200);
  assert.equal(calls[0].body.generate_audio, true);
  assert.doesNotMatch(calls[0].body.prompt, /dreamy ambient|cinematic orchestral|upbeat, energetic|no distinct music/, 'no known music modifier should appear for an unrecognized key');
  assert.match(calls[0].body.prompt, /cartoon animation style\.$/, 'the prompt must still end cleanly with the style modifier, unaffected by the bad musicStyle');
});

test('audioOn:"true" (a truthy string, not the literal boolean) is treated as off — only === true counts, matching this codebase\'s other strict boolean-flag checks', async function () {
  var calls = installFetchSpy();
  await handler(genEvent({ body: { audioOn: 'true' } }));
  assert.equal(calls[0].body.generate_audio, false);
});

// ----- Token cost stays flat regardless of audio on/off -----

test('token cost is exactly 100 whether audio is on or off (founder explicit: no split pricing)', async function () {
  installFetchSpy();
  await entitlements.setEntitlement({}, 'audiooncost@example.com', { tokens: { balance: 500, lastClaimAt: Date.now() } });
  await handler(genEvent({ body: { email: 'audiooncost@example.com', audioOn: true, musicStyle: 'upbeat' } }));
  var afterOn = await entitlements.getTokenStatus(fakeEvent({}), 'audiooncost@example.com');
  assert.equal(afterOn.balance, 400);

  await entitlements.setEntitlement({}, 'audiooffcost@example.com', { tokens: { balance: 500, lastClaimAt: Date.now() } });
  await handler(genEvent({ body: { email: 'audiooffcost@example.com', audioOn: false } }));
  var afterOff = await entitlements.getTokenStatus(fakeEvent({}), 'audiooffcost@example.com');
  assert.equal(afterOff.balance, 400);
});

// ----- Part B: the owner/IL audio force-off is RETIRED (founder
// directive 2026-07-29: "Regarding Sound for Israel don't disable it
// just leave it the same for everyone, including myself") — these tests
// now pin the NEW contract: the client's audioOn is honored identically
// for owner-email and Israel-geo requests. The profile label itself is
// still computed (cost-attribution logging) via resolveGenerationProfile.

test('OWNER_EMAIL match no longer overrides audio: audioOn:true is honored for the owner', function () {
  return withEnv({ OWNER_EMAIL: DEFAULT_EMAIL }, async function () {
    var calls = installFetchSpy();
    var res = await handler(genEvent({ body: { audioOn: true, musicStyle: 'dreamy' } }));
    assert.equal(res.statusCode, 200);
    assert.equal(calls[0].body.generate_audio, true);
    assert.match(calls[0].body.prompt, /dreamy ambient/, 'the music modifier flows through now that audio is honored');
  });
});

test('resolveGenerationProfile still labels the owner (normalized email match) for cost attribution, without forcing audio off', function () {
  return withEnv({ OWNER_EMAIL: '  Founder@DreamTube.Example  ' }, async function () {
    var mod = require('../netlify/functions/generate-video.js');
    var profile = mod.resolveGenerationProfile('founder@dreamtube.example', fakeEvent({}));
    assert.equal(profile.profile, 'cheap_owner');
    assert.equal(profile.forceAudioOff, false);
  });
});

test('an Israel-geo request (x-nf-geo) keeps audioOn:true honored, same as everyone else', function () {
  var calls = installFetchSpy();
  return handler(genEvent({ headers: { 'x-nf-geo': geoHeaderFor('IL') }, body: { audioOn: true, musicStyle: 'upbeat' } })).then(function (res) {
    assert.equal(res.statusCode, 200);
    assert.equal(calls[0].body.generate_audio, true);
  });
});

test('a non-owner, non-IL request keeps the client\'s own audioOn:true untouched', function () {
  var calls = installFetchSpy();
  return handler(genEvent({ headers: { 'x-nf-geo': geoHeaderFor('US') }, body: { audioOn: true } })).then(function (res) {
    assert.equal(res.statusCode, 200);
    assert.equal(calls[0].body.generate_audio, true);
  });
});

test('a malformed/missing x-nf-geo header fails open toward "not Israel" (audio stays on if the client asked for it) rather than silently forcing the cheap path', async function () {
  var calls = installFetchSpy();
  await handler(genEvent({ headers: { 'x-nf-geo': 'not-valid-base64-json!!!' }, body: { audioOn: true } }));
  assert.equal(calls[0].body.generate_audio, true);
});

test('OWNER_EMAIL unset entirely: no request can ever match it, so forcing only ever comes from geo', function () {
  return withEnv({ OWNER_EMAIL: undefined }, async function () {
    var calls = installFetchSpy();
    await handler(genEvent({ body: { audioOn: true } }));
    assert.equal(calls[0].body.generate_audio, true);
  });
});

// ----- Interaction with the pre-existing prompt-condenser audio-off rule -----
// (generate-video.js's own long-standing rule: a condensed caption always
// disables narration, regardless of anything else — this must still hold
// even with a client audioOn:true, since Part A is additive, not a
// replacement for that existing guardrail.)

test('a condensed caption still forces audio off even when the client asked for audioOn:true', async function () {
  var longCaption = new Array(80).join('I was flying through a golden sky above endless mountains and glowing rivers. ');
  process.env.GEM_API_KEY = 'test-gemini-key';
  // Stub fetch to serve BOTH calls this request makes: the Gemini condense
  // call (must return a real candidates[0].content.parts[0].text so
  // wasCondensed comes back true) and the fal submission itself (recorded,
  // same shape as installFetchSpy above).
  var falCalls = [];
  global.fetch = async function (url, opts) {
    if (String(url).indexOf('generativelanguage.googleapis.com') !== -1) {
      return { ok: true, status: 200, json: async function () { return { candidates: [{ content: { parts: [{ text: 'a short condensed dream about flying' }] } }] }; } };
    }
    falCalls.push({ url: url, body: JSON.parse(opts.body) });
    return { ok: true, status: 200, json: async function () { return { request_id: 'fake-request-id' }; } };
  };
  try {
    var res = await handler(genEvent({ body: { caption: longCaption, audioOn: true } }));
    assert.equal(res.statusCode, 200);
    assert.equal(falCalls.length, 1);
    assert.equal(falCalls[0].body.generate_audio, false, 'a condensed caption must never be narrated, regardless of the client\'s own audioOn toggle');
    assert.equal(falCalls[0].body.prompt.indexOf('a short condensed dream about flying'), 0);
  } finally {
    delete process.env.GEM_API_KEY;
  }
});
