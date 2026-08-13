// test/generate-image.test.js
//
// Covers netlify/functions/generate-image.js end to end: validation,
// guardrail order (rate limit -> token gate -> spend guard), the E412
// token gate specifically (10 tokens flat, not video's 100), spendTokens
// firing on every success (mock and real) but never on a rejected/failed
// submission, and GENERATION_MOCK_MODE's zero-cost path — same shape as
// test/generate-video-mock.test.js and test/generate-video-tokens.test.js,
// adapted for this function's own E4xx error-code range and 10-token cost.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var entitlements = require('../netlify/functions/lib/entitlements');
var genImageModule = require('../netlify/functions/generate-image');
var handler = genImageModule.handler;

var realFetch = global.fetch;
var ipCounter = 0;

function nextIp() {
  ipCounter += 1;
  return '10.20.0.' + ipCounter;
}

var DEFAULT_EMAIL = 'imagegen@example.com';

function genEvent(overrides) {
  return fakeEvent({
    method: 'POST',
    ip: (overrides && overrides.ip) || nextIp(),
    body: Object.assign({ caption: 'a dream about flying', style: 'Cartoon', email: DEFAULT_EMAIL }, overrides && overrides.body)
  });
}

function stubFetchOk() {
  global.fetch = async function () {
    return { ok: true, status: 200, json: async function () { return { request_id: 'fake-image-request-id' }; } };
  };
}

function stubFetchRejected() {
  global.fetch = async function () {
    return { ok: false, status: 422, json: async function () { return { detail: 'nope' }; } };
  };
}

/** Spies on global.fetch so tests can assert whether the real fal.ai call ever actually fired a request, and inspect its body + headers. */
function installFetchSpy() {
  var calls = [];
  global.fetch = async function (url, opts) {
    calls.push({ url: url, body: opts && opts.body ? JSON.parse(opts.body) : null, headers: opts && opts.headers });
    return { ok: true, status: 200, json: async function () { return { request_id: 'fake-image-request-id' }; } };
  };
  return calls;
}

async function balance(email, amount) {
  return entitlements.setEntitlement({}, email, { tokens: { balance: amount, lastClaimAt: Date.now() } });
}

test.beforeEach(async function () {
  mockBlobs.reset();
  global.fetch = realFetch;
  process.env.FAL_KEY = 'test-fal-key';
  delete process.env.GENERATION_MOCK_MODE;
  delete process.env.DAILY_SPEND_CAP_USD;
  delete process.env.MAX_GENERATIONS_PER_IP_PER_DAY;
  delete process.env.TURNSTILE_SECRET_KEY;
  // Content-tier gate (generate-image.js's E116, added 2026-08-08): force a
  // deterministic no-network 'clean' verdict here so the classifier never
  // fires its own fetch — this suite counts/inspects the FAL submission
  // fetch specifically and is not the gate's own coverage (that lives in
  // test/content-gate-generation.test.js). Cleared in test.after.
  process.env.CONTENT_CLASSIFIER_MOCK_TIER = 'clean';
  await entitlements.setEntitlement({}, DEFAULT_EMAIL, { tokens: { balance: 100000, lastClaimAt: Date.now() } });
});

test.after(function () {
  global.fetch = realFetch;
  delete process.env.CONTENT_CLASSIFIER_MOCK_TIER;
});

// ----- Validation -----

test('wrong method -> E401', async function () {
  var res = await handler(fakeEvent({ method: 'GET' }));
  assert.equal(res.statusCode, 405);
  assert.match(JSON.parse(res.body).error, /^E401:/);
});

test('missing FAL_KEY (mock mode off) -> E402', async function () {
  delete process.env.FAL_KEY;
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 500);
  assert.match(JSON.parse(res.body).error, /^E402:/);
});

test('invalid JSON body -> E403', async function () {
  var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: 'not json' }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E403:/);
});

test('missing caption/style -> E404', async function () {
  var res = await handler(genEvent({ body: { caption: '', style: '' } }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E404:/);
});

// ----- Real fal.ai call shape -----

test('a real submission posts to fal-ai/flux/dev with prompt + image_size: portrait_16_9', async function () {
  var calls = installFetchSpy();
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /fal-ai\/flux\/dev$/);
  assert.equal(calls[0].body.image_size, 'portrait_16_9');
  assert.equal(typeof calls[0].body.prompt, 'string');
  assert.ok(calls[0].body.prompt.indexOf('a dream about flying') !== -1);
  var body = JSON.parse(res.body);
  assert.equal(body.operationName.indexOf('fal:fal-ai/flux/dev:'), 0);
});

// tracker item for-product-bug-build-re-host-image-drea-0hpbm0 — fal's
// media-expiration docs say generated media (images included) is
// retained "for at least 7 days by default," and this is the only fal
// call site in generate-image.js — so its submission must disable that
// expiry, or every published image dream 404s roughly a week after
// creation (this handler hands back fal's own image URL directly, no
// re-host step).
test('the fal submission sends the X-Fal-Object-Lifecycle-Preference header disabling expiry', async function () {
  var calls = installFetchSpy();
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].headers['X-Fal-Object-Lifecycle-Preference']), { expiration_duration_seconds: null });
});

test('FAL_NO_EXPIRY_HEADER is exported and shaped exactly as fal\'s docs specify', function () {
  assert.deepEqual(JSON.parse(genImageModule.FAL_NO_EXPIRY_HEADER['X-Fal-Object-Lifecycle-Preference']), { expiration_duration_seconds: null });
});

test('a fal submission rejection -> E405, no tokens spent', async function () {
  stubFetchRejected();
  await balance('rejected-image@example.com', 300);
  var res = await handler(genEvent({ body: { email: 'rejected-image@example.com' } }));
  assert.equal(res.statusCode, 422);
  assert.match(JSON.parse(res.body).error, /^E405:/);
  var record = await entitlements.getEntitlement({}, 'rejected-image@example.com');
  assert.equal(record.tokens.balance, 300, 'balance must be unchanged after a rejected submission');
});

test('a network failure reaching fal -> E407, no tokens spent', async function () {
  global.fetch = async function () { throw new Error('network down'); };
  await balance('netfail-image@example.com', 300);
  var res = await handler(genEvent({ body: { email: 'netfail-image@example.com' } }));
  assert.equal(res.statusCode, 500);
  assert.match(JSON.parse(res.body).error, /^E407:/);
  var record = await entitlements.getEntitlement({}, 'netfail-image@example.com');
  assert.equal(record.tokens.balance, 300);
});

// ----- E412 token gate (10 tokens flat, not video's 100) -----

test('balance under 10 -> E412, fal never called', async function () {
  var calls = 0;
  global.fetch = async function () { calls++; return { ok: true, status: 200, json: async function () { return { request_id: 'x' }; } }; };
  await balance('broke-image@example.com', 5);
  var res = await handler(genEvent({ body: { email: 'broke-image@example.com' } }));
  assert.equal(res.statusCode, 402);
  assert.match(JSON.parse(res.body).error, /^E412: insufficient_tokens: not enough tokens to generate an image/);
  assert.equal(calls, 0);
});

test('balance exactly 9 -> still blocked (10 is the flat cost of one image)', async function () {
  await balance('almost-image@example.com', 9);
  var res = await handler(genEvent({ body: { email: 'almost-image@example.com' } }));
  assert.equal(res.statusCode, 402);
  assert.match(JSON.parse(res.body).error, /^E412:/);
});

test('balance exactly 10 -> proceeds (E412 only fires below 10, not at it)', async function () {
  stubFetchOk();
  await balance('exact-image@example.com', 10);
  var res = await handler(genEvent({ body: { email: 'exact-image@example.com' } }));
  assert.equal(res.statusCode, 200);
});

test('a request with no email at all -> E412 (balance resolves to 0)', async function () {
  var res = await handler(genEvent({ body: { email: '' } }));
  assert.equal(res.statusCode, 402);
  assert.match(JSON.parse(res.body).error, /^E412:/);
});

test('a brand-new email gets its 150-token signup grant materialized right here and proceeds', async function () {
  stubFetchOk();
  var res = await handler(genEvent({ body: { email: 'first-time-image@example.com' } }));
  assert.equal(res.statusCode, 200);
  var record = await entitlements.getEntitlement({}, 'first-time-image@example.com');
  assert.equal(record.tokens.balance, 140, '150 granted, 10 spent on this successful generation');
});

// ----- spendTokens on success (10, not 100) -----

test('mock mode success spends exactly 10 tokens', async function () {
  process.env.GENERATION_MOCK_MODE = 'true';
  await balance('mockimageuser@example.com', 300);
  var res = await handler(genEvent({ body: { email: 'mockimageuser@example.com' } }));
  assert.equal(res.statusCode, 200);
  var record = await entitlements.getEntitlement({}, 'mockimageuser@example.com');
  assert.equal(record.tokens.balance, 290);
});

test('real fal success spends exactly 10 tokens', async function () {
  stubFetchOk();
  await balance('realimageuser@example.com', 300);
  var res = await handler(genEvent({ body: { email: 'realimageuser@example.com' } }));
  assert.equal(res.statusCode, 200);
  var record = await entitlements.getEntitlement({}, 'realimageuser@example.com');
  assert.equal(record.tokens.balance, 290);
});

// ----- E409 rate limit / E410 spend guard — same shared guardrails -----

test('E409 rate limit fires independently of the token gate', async function () {
  var ip = nextIp();
  var todayUtc = new Date().toISOString().slice(0, 10);
  mockBlobs.seed('dreamtube-rate-limits', 'ip:' + todayUtc + ':' + ip, 40); // cap default 40, founder directive 2026-07-29
  var res = await handler(genEvent({ ip: ip }));
  assert.equal(res.statusCode, 429);
  assert.match(JSON.parse(res.body).error, /^E409: rate_limited/);
});

test('E410 spend guard fires independently of the token gate', async function () {
  process.env.DAILY_SPEND_CAP_USD = '1';
  var todayUtc = new Date().toISOString().slice(0, 10);
  mockBlobs.seed('dreamtube-spend-guard', 'spend:' + todayUtc, 1);
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 503);
  assert.match(JSON.parse(res.body).error, /^E410: daily_spend_cap_exceeded/);
});

// ----- GENERATION_MOCK_MODE -----

test('mock mode: valid 200 response shaped { operationName } with a "mock:" prefix, no FAL_KEY needed', async function () {
  process.env.GENERATION_MOCK_MODE = 'true';
  delete process.env.FAL_KEY;
  var calls = installFetchSpy();
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.operationName.indexOf('mock:'), 0);
  assert.equal(calls.length, 0, 'no real fal.ai call should ever fire in mock mode');
});

test('mock mode: two calls produce two distinct operationNames', async function () {
  process.env.GENERATION_MOCK_MODE = 'true';
  var res1 = await handler(genEvent({}));
  var res2 = await handler(genEvent({}));
  var name1 = JSON.parse(res1.body).operationName;
  var name2 = JSON.parse(res2.body).operationName;
  assert.notEqual(name1, name2);
});

test('mock mode: only the exact string "true" turns it on — any other value behaves as unset (real path)', async function () {
  process.env.GENERATION_MOCK_MODE = 'yes';
  var calls = installFetchSpy();
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.operationName.indexOf('fal:'), 0);
  assert.equal(calls.length, 1);
});

test('mock mode: validation still runs — E404, no fetch at all', async function () {
  process.env.GENERATION_MOCK_MODE = 'true';
  var calls = installFetchSpy();
  var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: JSON.stringify({ caption: '', style: '' }) }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E404:/);
  assert.equal(calls.length, 0);
});

test('mock mode: the E412 token gate still applies to an email with insufficient balance', async function () {
  process.env.GENERATION_MOCK_MODE = 'true';
  await entitlements.setEntitlement({}, 'broke-mock-image@example.com', { tokens: { balance: 0, lastClaimAt: Date.now() } });
  var res = await handler(genEvent({ body: { email: 'broke-mock-image@example.com' } }));
  assert.equal(res.statusCode, 402);
  assert.match(JSON.parse(res.body).error, /^E412: insufficient_tokens/);
});

// ----- buildImagePrompt / exports -----

test('buildImagePrompt folds style/camera/scenery in, omits any reference-photo pointer line even when a photo self character is present, but still includes that character\'s text description', function () {
  var genImage = require('../netlify/functions/generate-image');
  var prompt = genImage.buildImagePrompt(
    'a dream about flying',
    'Cartoon',
    [{ name: 'Me', isSelf: true, photoDataUrl: 'data:image/png;base64,AAAA', description: 'no beard, short hair' }],
    'Close-up', 'Night', 'Urban'
  );
  assert.ok(prompt.indexOf('a dream about flying') !== -1);
  assert.ok(prompt.indexOf('close-up shot') !== -1);
  assert.ok(prompt.indexOf('nighttime') !== -1);
  assert.ok(prompt.indexOf('urban setting') !== -1);
  assert.ok(prompt.indexOf('reference photo') === -1, 'flux/dev has no photo-conditioning path — no pointer line should ever be emitted');
  assert.ok(prompt.indexOf('no beard, short hair') !== -1, 'flux/dev never sees the photo, so a description on a photo-having character must still reach the prompt as the only appearance signal it gets');
});

test('buildImagePrompt includes a text-described character (non-photo)', function () {
  var genImage = require('../netlify/functions/generate-image');
  var prompt = genImage.buildImagePrompt('a dream', 'Anime', [{ name: 'Alex', isSelf: false, description: 'tall with a red hat' }], null, null, null);
  assert.ok(prompt.indexOf('Alex') !== -1);
  assert.ok(prompt.indexOf('tall with a red hat') !== -1);
});

test('buildImagePrompt appends the ethnicity-neutrality sentence with its explicit-specification carve-out (parity with generate-video, founder 2026-08-11)', function () {
  var genImage = require('../netlify/functions/generate-image');
  var prompt = genImage.buildImagePrompt('a woman in a garden', 'Cartoon', [], null, null, null);
  // Reframed 2026-08-13 (tracker item for-product-investigate-no-specific-ethn-zz0fyv):
  // the negative fragment now sits mid-sentence after the positive lead
  // (reinforcement, not the sole instruction), so it's lowercase here rather
  // than the capitalized sentence-starter it used to be — see the dedicated
  // positive-lead test below for the full before/after reasoning.
  assert.ok(prompt.indexOf('do not assign the subject any specific ethnicity, skin tone, or racial appearance') !== -1,
    'the ethnicity-neutrality sentence must be present');
  assert.ok(prompt.indexOf('unless the description explicitly specifies one') !== -1,
    'the carve-out must be present so a stated ethnicity is never suppressed');
});

test('buildImagePrompt\'s ethnicity clause LEADS with a positive instruction, not just the negative one (reframed 2026-08-13, tracker item for-product-investigate-no-specific-ethn-zz0fyv — negative-only instructions are more weakly followed by these models; parity with generate-video.js)', function () {
  var genImage = require('../netlify/functions/generate-image');
  var prompt = genImage.buildImagePrompt('a woman in a garden', 'Cartoon', [], null, null, null);

  // Positive lead: states the desired outcome directly (render neutrally),
  // not just what NOT to do.
  var positiveLeadIndex = prompt.indexOf('Render the subject with a neutral, unspecified ethnicity, skin tone, and racial appearance by default');
  assert.ok(positiveLeadIndex !== -1, 'the clause must lead with a positive instruction describing the desired neutral rendering, not just a negative one');

  // The negative phrasing must still be present too, but strictly AFTER the
  // positive lead — reinforcement, not the sole/first instruction.
  var negativeIndex = prompt.indexOf('do not assign the subject any specific ethnicity, skin tone, or racial appearance');
  assert.ok(negativeIndex !== -1, 'the negative phrasing must still be present as reinforcement');
  assert.ok(negativeIndex > positiveLeadIndex, 'the positive instruction must come before the negative reinforcement, not after it');

  // The carve-out must come after both, and survive completely unchanged
  // from the original negative-only phrasing (this is the load-bearing part
  // that must never be weakened by the reframe).
  var carveOutIndex = prompt.indexOf('unless the description explicitly specifies one');
  assert.ok(carveOutIndex !== -1 && carveOutIndex > negativeIndex,
    'the "unless explicitly specifies one" carve-out must survive unchanged and stay after the negative reinforcement');
});

test('IMAGE_TOKEN_COST is exported as 10', function () {
  var genImage = require('../netlify/functions/generate-image');
  assert.equal(genImage.IMAGE_TOKEN_COST, 10);
});
