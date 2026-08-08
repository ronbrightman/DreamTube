// test/generate-video-audio-toggle.test.js
//
// Covers netlify/functions/generate-video.js's audio-related history:
//   - for-product-audio-on-off-choice-at-creat-dyyr98 (Part A, 2026-07-28):
//     style.html's client-side audio/music toggle — DEFAULT OFF, only sent
//     to fal when the client actually asked for it.
//   - for-product-cheap-generation-profile-for-yz2ina (Part B, 2026-07-28):
//     OWNER_EMAIL/Israel-geo forced generate_audio:false silently.
//   - for-product-audio-toggle-silently-overri-6qroev / founder directive
//     2026-07-29: Part B's owner/IL force-off was RETIRED — the client
//     toggle was honored identically for everyone.
//   - for-product-turn-off-audio-dialogue-gene-ooeyoj / founder directive
//     2026-08-02 (CURRENT CONTRACT, what this file now asserts):
//     generate_audio is UNCONDITIONALLY false for every request, regardless
//     of audioOn, musicStyle, OWNER_EMAIL, geo, or caption condensing. Two
//     reasons: (1) audio-on bills meaningfully more per second on fal's
//     veo3.1 endpoints; (2) Veo's native audio can lip-sync invented
//     dialogue the user never wrote, which is unacceptable regardless of
//     cost. There is no longer any code path that can turn generate_audio
//     back on — see generate-video.js's own `var generateAudio = false;`
//     comment for the full history of what this line used to be.
//   - Token cost stays flat at 100 regardless of audio on/off (founder
//     explicit — no split pricing) — unaffected by this directive.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

// Content-tier safety gate (netlify/functions/lib/content-classifier.js) —
// isolate the fal-call assertions in THIS file from the classifier's own
// LLM fetch by forcing the classifier to a deterministic 'clean' verdict
// with no network call (its CONTENT_CLASSIFIER_MOCK_TIER hook). Without
// this, the classifier's fetch would count as an extra call here and the
// fetch-shape/count assertions below (which are about the fal submission,
// not the classifier) would mis-read call[0]. The gate itself is covered
// directly in test/content-classifier.test.js and test/content-gate-generation.test.js.
process.env.CONTENT_CLASSIFIER_MOCK_TIER = 'clean';

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

// ----- Unconditional off, regardless of what the client's audioOn toggle sends -----

test('audioOn omitted entirely (every pre-existing caller): generate_audio is false', async function () {
  var calls = installFetchSpy();
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.generate_audio, false);
});

test('audioOn:true is NOT honored — generate_audio stays false, overriding the client explicitly', async function () {
  var calls = installFetchSpy();
  var res = await handler(genEvent({ body: { audioOn: true } }));
  assert.equal(res.statusCode, 200);
  assert.equal(calls[0].body.generate_audio, false);
});

// ----- Every real call shape this file can produce, not just the default plain path -----

test('reference-to-video (self-photo) call shape: generate_audio is false even with audioOn:true', async function () {
  var calls = installFetchSpy();
  var res = await handler(genEvent({
    body: {
      audioOn: true,
      characters: [{ name: 'Me', isSelf: true, photoDataUrl: 'data:image/png;base64,AAAA' }]
    }
  }));
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /reference-to-video$/);
  assert.equal(calls[0].body.generate_audio, false);
});

test('PixVerse V6 rotation call shape (requestedModel:"pixverse-v6"): generate_audio is false even with audioOn:true', async function () {
  var calls = installFetchSpy();
  var res = await handler(genEvent({ body: { audioOn: true, requestedModel: 'pixverse-v6' } }));
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /pixverse\/v6\/text-to-video$/);
  assert.equal(calls[0].body.generate_audio, false);
});

test('audioOn:true + musicStyle:"cinematic": generate_audio still false, and no music modifier reaches the prompt', async function () {
  var calls = installFetchSpy();
  await handler(genEvent({ body: { audioOn: true, musicStyle: 'cinematic' } }));
  assert.equal(calls[0].body.generate_audio, false);
  assert.doesNotMatch(calls[0].body.prompt, /cinematic orchestral score/, 'a music modifier is meaningless once generate_audio is false and must never be appended');
});

test('every music preset is silently skipped now — none of them ever reach the prompt, since generate_audio is always false', async function () {
  var presets = ['dreamy', 'cinematic', 'upbeat', 'none-ambient'];
  for (var i = 0; i < presets.length; i++) {
    var calls = installFetchSpy();
    await handler(genEvent({ body: { audioOn: true, musicStyle: presets[i] } }));
    assert.equal(calls[0].body.generate_audio, false, 'musicStyle=' + presets[i]);
    assert.doesNotMatch(calls[0].body.prompt, /dreamy ambient|cinematic orchestral|upbeat, energetic|no distinct music/, 'musicStyle=' + presets[i]);
  }
});

test('an unrecognized musicStyle is silently ignored (no modifier appended, no crash)', async function () {
  var calls = installFetchSpy();
  var res = await handler(genEvent({ body: { audioOn: true, musicStyle: 'not-a-real-style' } }));
  assert.equal(res.statusCode, 200);
  assert.equal(calls[0].body.generate_audio, false);
  assert.doesNotMatch(calls[0].body.prompt, /dreamy ambient|cinematic orchestral|upbeat, energetic|no distinct music/, 'no known music modifier should appear for an unrecognized key');
  assert.match(calls[0].body.prompt, /cartoon animation style\.$/, 'the prompt must still end cleanly with the style modifier, unaffected by the bad musicStyle');
});

test('audioOn:"true" (a truthy string, not the literal boolean) is also false — moot now, but must not crash or be treated specially', async function () {
  var calls = installFetchSpy();
  await handler(genEvent({ body: { audioOn: 'true' } }));
  assert.equal(calls[0].body.generate_audio, false);
});

// ----- Token cost stays flat regardless of audio on/off -----

test('token cost is exactly 100 whether the client asked for audio or not (founder explicit: no split pricing)', async function () {
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

// ----- resolveGenerationProfile: classifier-only now, forceAudioOff removed -----

test('resolveGenerationProfile still labels the owner (normalized email match) for cost-attribution logging, and no longer returns a forceAudioOff field at all', function () {
  return withEnv({ OWNER_EMAIL: '  Founder@DreamTube.Example  ' }, async function () {
    var mod = require('../netlify/functions/generate-video.js');
    var profile = mod.resolveGenerationProfile('founder@dreamtube.example', fakeEvent({}));
    assert.equal(profile.profile, 'cheap_owner');
    assert.equal('forceAudioOff' in profile, false, 'forceAudioOff was removed as dead weight once generateAudio became unconditionally false');
  });
});

test('resolveGenerationProfile labels an Israel-geo request "cheap_il" for logging only — does not affect generate_audio', function () {
  var mod = require('../netlify/functions/generate-video.js');
  var profile = mod.resolveGenerationProfile(null, fakeEvent({ headers: { 'x-nf-geo': geoHeaderFor('IL') } }));
  assert.equal(profile.profile, 'cheap_il');
});

// ----- generate_audio:false holds for owner email / Israel geo / any geo / no OWNER_EMAIL configured -----
// (these used to be meaningfully different branches before 2026-08-02; now every one of them collapses to the same outcome)

test('OWNER_EMAIL match: generate_audio is still false even with audioOn:true', function () {
  return withEnv({ OWNER_EMAIL: DEFAULT_EMAIL }, async function () {
    var calls = installFetchSpy();
    var res = await handler(genEvent({ body: { audioOn: true, musicStyle: 'dreamy' } }));
    assert.equal(res.statusCode, 200);
    assert.equal(calls[0].body.generate_audio, false);
  });
});

test('an Israel-geo request (x-nf-geo): generate_audio is still false even with audioOn:true', function () {
  var calls = installFetchSpy();
  return handler(genEvent({ headers: { 'x-nf-geo': geoHeaderFor('IL') }, body: { audioOn: true, musicStyle: 'upbeat' } })).then(function (res) {
    assert.equal(res.statusCode, 200);
    assert.equal(calls[0].body.generate_audio, false);
  });
});

test('a non-owner, non-IL request: generate_audio is still false even with audioOn:true', function () {
  var calls = installFetchSpy();
  return handler(genEvent({ headers: { 'x-nf-geo': geoHeaderFor('US') }, body: { audioOn: true } })).then(function (res) {
    assert.equal(res.statusCode, 200);
    assert.equal(calls[0].body.generate_audio, false);
  });
});

test('a malformed/missing x-nf-geo header: generate_audio is still false (the unconditional override doesn\'t depend on geo parsing at all anymore)', async function () {
  var calls = installFetchSpy();
  await handler(genEvent({ headers: { 'x-nf-geo': 'not-valid-base64-json!!!' }, body: { audioOn: true } }));
  assert.equal(calls[0].body.generate_audio, false);
});

test('OWNER_EMAIL unset entirely: generate_audio is still false', function () {
  return withEnv({ OWNER_EMAIL: undefined }, async function () {
    var calls = installFetchSpy();
    await handler(genEvent({ body: { audioOn: true } }));
    assert.equal(calls[0].body.generate_audio, false);
  });
});

// ----- Interaction with the pre-existing prompt-condenser audio-off rule -----
// (this rule predates the 2026-08-02 unconditional-off directive and is now
// fully subsumed by it — generate_audio was already false for a condensed
// caption before, and still is, for the same underlying reason: narrating
// text the user didn't write. Kept as a regression check that condensing
// still works correctly and doesn't somehow re-enable audio.)

test('a condensed caption still results in generate_audio:false (now doubly true — the caption-condense rule AND the unconditional override both apply)', async function () {
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
    assert.equal(falCalls[0].body.generate_audio, false, 'a condensed caption must never be narrated');
    assert.equal(falCalls[0].body.prompt.indexOf('a short condensed dream about flying'), 0);
  } finally {
    delete process.env.GEM_API_KEY;
  }
});
