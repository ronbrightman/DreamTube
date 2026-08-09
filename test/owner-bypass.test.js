// test/owner-bypass.test.js
//
// Covers the owner generation-rate-limit bypass (tracker.html's
// for-product-founder-hit-the-per-ip-gener-7mjq2l item — the founder hit
// E409 testing his own product because the per-IP generation cap had no
// owner exemption):
//   - netlify/functions/lib/owner-bypass.js: verifyOwnerCredentials
//     (real password check + OWNER_EMAIL match, every failure mode) and
//     createBypassToken/verifyBypassToken (issue, verify, expire).
//   - netlify/functions/verify-owner-bypass.js: the HTTP endpoint —
//     validation, rate limiting, and that only a genuine owner password
//     match ever issues a token.
//   - netlify/functions/generate-video.js / generate-image.js: the actual
//     integration — a verified bypass token skips ONLY the per-IP/
//     per-email rate-limit counters (E109/E409) and the token-init per-IP
//     cap, and CANNOT skip the E112/E412 token-balance gate or (the most
//     important property in this whole feature) DAILY_SPEND_CAP_USD —
//     that stays absolute even with an active, genuinely-verified bypass.
//
// Run with: node --test test/

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');

var ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return '10.9.0.' + ipCounter;
}

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

var OWNER_EMAIL = 'founder@dreamtube.example';
var OWNER_PASSWORD = 'realownerpassword1';

async function registerAccount(username, password, email) {
  var registerHandler = require('../netlify/functions/register-account').handler;
  var res = await registerHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { username: username, password: password, email: email } }));
  assert.equal(JSON.parse(res.body).ok, true, 'test setup: registration should succeed');
}

async function registerOwner() {
  await registerAccount('founder', OWNER_PASSWORD, OWNER_EMAIL);
}

test.beforeEach(function () {
  mockBlobs.reset();
  delete require.cache[require.resolve('../netlify/functions/lib/owner-bypass')];
  delete require.cache[require.resolve('../netlify/functions/verify-owner-bypass')];
  delete require.cache[require.resolve('../netlify/functions/lib/account-store')];
  delete require.cache[require.resolve('../netlify/functions/lib/rate-limit')];
  delete require.cache[require.resolve('../netlify/functions/register-account')];
  delete process.env.MAX_OWNER_BYPASS_VERIFY_PER_IP_PER_DAY;
  delete process.env.MAX_OWNER_BYPASS_VERIFY_PER_IDENTIFIER_PER_DAY;
});

// ===== lib/owner-bypass.js: verifyOwnerCredentials =====

test('owner-bypass: verifyOwnerCredentials fails closed when OWNER_EMAIL is not configured, even with a correct password for a real account', function () {
  return withEnv({ OWNER_EMAIL: undefined }, async function () {
    await registerOwner();
    var ownerBypass = require('../netlify/functions/lib/owner-bypass');
    var event = fakeEvent({ method: 'POST' });
    var result = await ownerBypass.verifyOwnerCredentials(event, 'founder', OWNER_PASSWORD);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'owner_not_configured');
  });
});

test('owner-bypass: verifyOwnerCredentials rejects an unknown username (not_found)', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var ownerBypass = require('../netlify/functions/lib/owner-bypass');
    var event = fakeEvent({ method: 'POST' });
    var result = await ownerBypass.verifyOwnerCredentials(event, 'nobody-registered', 'whatever');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'not_found');
  });
});

test('owner-bypass: verifyOwnerCredentials rejects a REAL owner account with a WRONG password (incorrect_password) -- fails closed, never issues on a bad guess', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    await registerOwner();
    var ownerBypass = require('../netlify/functions/lib/owner-bypass');
    var event = fakeEvent({ method: 'POST' });
    var result = await ownerBypass.verifyOwnerCredentials(event, 'founder', 'attacker-guessed-wrong');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'incorrect_password');
  });
});

test('owner-bypass: verifyOwnerCredentials rejects a REAL, correctly-authenticated account whose email is simply NOT the owner (not_owner) -- a real password alone is not enough', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    await registerAccount('regularuser', 'regularpassword1', 'regular@example.com');
    var ownerBypass = require('../netlify/functions/lib/owner-bypass');
    var event = fakeEvent({ method: 'POST' });
    var result = await ownerBypass.verifyOwnerCredentials(event, 'regularuser', 'regularpassword1');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'not_owner');
  });
});

test('owner-bypass: verifyOwnerCredentials succeeds for the real owner account with the real password', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    await registerOwner();
    var ownerBypass = require('../netlify/functions/lib/owner-bypass');
    var event = fakeEvent({ method: 'POST' });
    var result = await ownerBypass.verifyOwnerCredentials(event, 'founder', OWNER_PASSWORD);
    assert.equal(result.ok, true);
    assert.equal(result.record.email, OWNER_EMAIL);
  });
});

test('owner-bypass: verifyOwnerCredentials also succeeds when the owner logs in by email instead of username', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    await registerOwner();
    var ownerBypass = require('../netlify/functions/lib/owner-bypass');
    var event = fakeEvent({ method: 'POST' });
    var result = await ownerBypass.verifyOwnerCredentials(event, OWNER_EMAIL, OWNER_PASSWORD);
    assert.equal(result.ok, true);
  });
});

// ===== lib/owner-bypass.js: createBypassToken / verifyBypassToken =====
//
// createBypassToken now requires the resolved owner email as its 2nd arg,
// and verifyBypassToken returns { ok:true, email } (the BOUND email) --
// see the "REVIEW FIX" doc comments on both functions: a token that only
// proves "issued once, still live" with no record of whose session it was
// issued for could previously be replayed against an arbitrary email in a
// generation request, letting a leaked/shared/XSS'd token skip the rate
// limit/anti-farming cap for an email that never actually verified
// anything. These tests cover the binding itself; the "match the
// requesting email" enforcement lives in generate-video.js/
// generate-image.js (see the integration tests further down, especially
// "a bypass token bound to a DIFFERENT email must never activate").

test('owner-bypass: a freshly-created token verifies as active AND returns the bound email it was issued for', async function () {
  var ownerBypass = require('../netlify/functions/lib/owner-bypass');
  var event = fakeEvent({ method: 'POST' });
  var issued = await ownerBypass.createBypassToken(event, OWNER_EMAIL);
  assert.equal(typeof issued.token, 'string');
  assert.ok(issued.token.length >= 32, 'expected a real random token, not a short/predictable value');
  var check = await ownerBypass.verifyBypassToken(event, issued.token);
  assert.equal(check.ok, true);
  assert.equal(check.email, OWNER_EMAIL, 'verifyBypassToken must return the exact email this token was bound to at issuance');
});

test('owner-bypass: the bound email is normalized (trim + lowercase), same as every other email in this codebase', async function () {
  var ownerBypass = require('../netlify/functions/lib/owner-bypass');
  var event = fakeEvent({ method: 'POST' });
  var issued = await ownerBypass.createBypassToken(event, '  Founder@DreamTube.Example  ');
  var check = await ownerBypass.verifyBypassToken(event, issued.token);
  assert.equal(check.ok, true);
  assert.equal(check.email, 'founder@dreamtube.example');
});

test('owner-bypass: an unknown token fails closed', async function () {
  var ownerBypass = require('../netlify/functions/lib/owner-bypass');
  var event = fakeEvent({ method: 'POST' });
  var check = await ownerBypass.verifyBypassToken(event, 'totally-made-up-token');
  assert.equal(check.ok, false);
});

test('owner-bypass: a missing/empty/non-string token fails closed', async function () {
  var ownerBypass = require('../netlify/functions/lib/owner-bypass');
  var event = fakeEvent({ method: 'POST' });
  assert.equal((await ownerBypass.verifyBypassToken(event, null)).ok, false);
  assert.equal((await ownerBypass.verifyBypassToken(event, '')).ok, false);
  assert.equal((await ownerBypass.verifyBypassToken(event, undefined)).ok, false);
});

test('owner-bypass: an expired token fails closed', async function () {
  var ownerBypass = require('../netlify/functions/lib/owner-bypass');
  var event = fakeEvent({ method: 'POST' });
  var issued = await ownerBypass.createBypassToken(event, OWNER_EMAIL);
  var { getStore } = require('@netlify/blobs');
  var store = getStore({ name: ownerBypass.STORE_NAME });
  var record = await store.get(issued.token, { type: 'json' });
  record.expiresAt = Date.now() - 1000;
  await store.setJSON(issued.token, record);
  var check = await ownerBypass.verifyBypassToken(event, issued.token);
  assert.equal(check.ok, false);
});

test('owner-bypass: a record with no bound email at all fails closed (defense in depth against a malformed/legacy record)', async function () {
  var ownerBypass = require('../netlify/functions/lib/owner-bypass');
  var event = fakeEvent({ method: 'POST' });
  var { getStore } = require('@netlify/blobs');
  var store = getStore({ name: ownerBypass.STORE_NAME });
  await store.setJSON('a-legacy-style-token-with-no-bound-email', { createdAt: Date.now(), expiresAt: Date.now() + 60000 });
  var check = await ownerBypass.verifyBypassToken(event, 'a-legacy-style-token-with-no-bound-email');
  assert.equal(check.ok, false);
});

test('owner-bypass: a token is revisitable (not single-use) within its TTL', async function () {
  var ownerBypass = require('../netlify/functions/lib/owner-bypass');
  var event = fakeEvent({ method: 'POST' });
  var issued = await ownerBypass.createBypassToken(event, OWNER_EMAIL);
  var first = await ownerBypass.verifyBypassToken(event, issued.token);
  var second = await ownerBypass.verifyBypassToken(event, issued.token);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
});

// ===== verify-owner-bypass.js (the HTTP endpoint) =====

test('verify-owner-bypass: wrong method -> E1', async function () {
  var handler = require('../netlify/functions/verify-owner-bypass').handler;
  var res = await handler(fakeEvent({ method: 'GET', ip: nextIp() }));
  assert.equal(res.statusCode, 405);
  assert.match(JSON.parse(res.body).error, /^E1/);
});

test('verify-owner-bypass: invalid JSON -> E2', async function () {
  var handler = require('../netlify/functions/verify-owner-bypass').handler;
  var res = await handler({ httpMethod: 'POST', headers: { 'x-nf-client-connection-ip': nextIp() }, body: 'not json', queryStringParameters: {} });
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E2/);
});

test('verify-owner-bypass: missing fields -> E3', async function () {
  var handler = require('../netlify/functions/verify-owner-bypass').handler;
  var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { username: 'founder' } }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E3/);
});

test('verify-owner-bypass: a wrong password for the real owner account is rejected E5 -- no token issued, and does not reveal whether the account exists', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    await registerOwner();
    var handler = require('../netlify/functions/verify-owner-bypass').handler;
    var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { username: 'founder', password: 'wrong-password-guess' } }));
    assert.equal(res.statusCode, 403);
    var data = JSON.parse(res.body);
    assert.equal(data.ok, false);
    assert.match(data.error, /^E5/);
    assert.equal(data.token, undefined);
  });
});

test('verify-owner-bypass: a real, correctly-authenticated NON-owner account is rejected E5', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    await registerAccount('regularuser', 'regularpassword1', 'regular@example.com');
    var handler = require('../netlify/functions/verify-owner-bypass').handler;
    var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { username: 'regularuser', password: 'regularpassword1' } }));
    assert.equal(res.statusCode, 403);
    assert.match(JSON.parse(res.body).error, /^E5/);
  });
});

test('verify-owner-bypass: OWNER_EMAIL unset -> E5 (fails closed, never issues a token with no owner configured)', function () {
  return withEnv({ OWNER_EMAIL: undefined }, async function () {
    await registerOwner();
    var handler = require('../netlify/functions/verify-owner-bypass').handler;
    var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { username: 'founder', password: OWNER_PASSWORD } }));
    assert.equal(res.statusCode, 403);
    assert.match(JSON.parse(res.body).error, /^E5/);
  });
});

test('verify-owner-bypass: the real owner with the real password gets a live token back', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    await registerOwner();
    var handler = require('../netlify/functions/verify-owner-bypass').handler;
    var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { username: 'founder', password: OWNER_PASSWORD } }));
    assert.equal(res.statusCode, 200);
    var data = JSON.parse(res.body);
    assert.equal(data.ok, true);
    assert.equal(typeof data.token, 'string');
    assert.ok(data.expiresAt > Date.now());

    var ownerBypass = require('../netlify/functions/lib/owner-bypass');
    var check = await ownerBypass.verifyBypassToken(fakeEvent({ method: 'POST' }), data.token);
    assert.equal(check.ok, true, 'the token this endpoint issued must actually verify');
  });
});

test('verify-owner-bypass: per-IP rate limit blocks further attempts from the same source once exceeded', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, MAX_OWNER_BYPASS_VERIFY_PER_IP_PER_DAY: '2' }, async function () {
    await registerOwner();
    var handler = require('../netlify/functions/verify-owner-bypass').handler;
    var ip = nextIp();
    var r1 = await handler(fakeEvent({ method: 'POST', ip: ip, body: { username: 'founder', password: 'wrong-1' } }));
    var r2 = await handler(fakeEvent({ method: 'POST', ip: ip, body: { username: 'founder', password: 'wrong-2' } }));
    var r3 = await handler(fakeEvent({ method: 'POST', ip: ip, body: { username: 'founder', password: OWNER_PASSWORD } }));
    assert.equal(r1.statusCode, 403);
    assert.equal(r2.statusCode, 403);
    assert.equal(r3.statusCode, 429, 'the 3rd attempt from the same IP must be rate limited, even with the CORRECT password');
    assert.match(JSON.parse(r3.body).error, /^E4/);
  });
});

test('verify-owner-bypass: per-identifier rate limit blocks unlimited password guessing against the owner account spread across many IPs', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, MAX_OWNER_BYPASS_VERIFY_PER_IDENTIFIER_PER_DAY: '2' }, async function () {
    await registerOwner();
    var handler = require('../netlify/functions/verify-owner-bypass').handler;
    var r1 = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { username: 'founder', password: 'wrong-1' } }));
    var r2 = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { username: 'founder', password: 'wrong-2' } }));
    var r3 = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { username: 'founder', password: OWNER_PASSWORD } }));
    assert.equal(r1.statusCode, 403);
    assert.equal(r2.statusCode, 403);
    assert.equal(r3.statusCode, 429, 'a 3rd guess against the SAME account from a DIFFERENT IP must still be rate limited');
  });
});

// ===== Integration: generate-video.js =====

var genVideoIpCounter = 0;
function nextGenVideoIp() {
  genVideoIpCounter += 1;
  return '10.11.0.' + genVideoIpCounter;
}

function stubFalOk() {
  global.fetch = async function () {
    return { ok: true, status: 200, json: async function () { return { request_id: 'fake-request-id' }; } };
  };
}

async function issueOwnerToken() {
  await registerOwner();
  var verifyHandler = require('../netlify/functions/verify-owner-bypass').handler;
  var res = await verifyHandler(fakeEvent({ method: 'POST', ip: nextGenVideoIp(), body: { username: 'founder', password: OWNER_PASSWORD } }));
  return JSON.parse(res.body).token;
}

test('generate-video: WITHOUT a bypass token, the normal per-IP rate limit still fires E109 once exceeded', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, MAX_GENERATIONS_PER_IP_PER_DAY: '1', FAL_KEY: 'test-fal-key', DAILY_SPEND_CAP_USD: undefined }, async function () {
    delete require.cache[require.resolve('../netlify/functions/generate-video')];
    var entitlements = require('../netlify/functions/lib/entitlements');
    var handler = require('../netlify/functions/generate-video').handler;
    var realFetch = global.fetch;
    stubFalOk();
    var ip = nextGenVideoIp();
    await entitlements.setEntitlement({}, 'novibypass@example.com', { tokens: { balance: 100000, lastClaimAt: Date.now() } });
    var body = { caption: 'a dream', style: 'Cartoon', email: 'novibypass@example.com' };
    var r1 = await handler(fakeEvent({ method: 'POST', ip: ip, body: body }));
    var r2 = await handler(fakeEvent({ method: 'POST', ip: ip, body: body }));
    global.fetch = realFetch;
    assert.equal(r1.statusCode, 200);
    assert.equal(r2.statusCode, 429);
    assert.match(JSON.parse(r2.body).error, /^E109: rate_limited/);
  });
});

test('generate-video: a VERIFIED owner bypass token skips the per-IP rate limit that would otherwise return E109', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, MAX_GENERATIONS_PER_IP_PER_DAY: '1', FAL_KEY: 'test-fal-key', DAILY_SPEND_CAP_USD: undefined }, async function () {
    delete require.cache[require.resolve('../netlify/functions/generate-video')];
    delete require.cache[require.resolve('../netlify/functions/verify-owner-bypass')];
    var entitlements = require('../netlify/functions/lib/entitlements');
    var handler = require('../netlify/functions/generate-video').handler;
    var token = await issueOwnerToken();
    var realFetch = global.fetch;
    stubFalOk();
    var ip = nextGenVideoIp();
    await entitlements.setEntitlement({}, OWNER_EMAIL, { tokens: { balance: 100000, lastClaimAt: Date.now() } });
    var body = { caption: 'a dream', style: 'Cartoon', email: OWNER_EMAIL, ownerBypassToken: token };
    // Same IP, same email, 3 requests in a row -- would 429 on the 2nd
    // without the bypass (cap is 1/day), all 3 must succeed with it.
    var r1 = await handler(fakeEvent({ method: 'POST', ip: ip, body: body }));
    var r2 = await handler(fakeEvent({ method: 'POST', ip: ip, body: body }));
    var r3 = await handler(fakeEvent({ method: 'POST', ip: ip, body: body }));
    global.fetch = realFetch;
    assert.equal(r1.statusCode, 200);
    assert.equal(r2.statusCode, 200, 'bypass must skip the per-IP rate limit');
    assert.equal(r3.statusCode, 200, 'bypass must skip the per-email rate limit too');
  });
});

test('generate-video: an INVALID/expired/unknown bypass token is silently ignored -- the normal rate limit still fires (fails closed)', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, MAX_GENERATIONS_PER_IP_PER_DAY: '1', FAL_KEY: 'test-fal-key', DAILY_SPEND_CAP_USD: undefined }, async function () {
    delete require.cache[require.resolve('../netlify/functions/generate-video')];
    var entitlements = require('../netlify/functions/lib/entitlements');
    var handler = require('../netlify/functions/generate-video').handler;
    var realFetch = global.fetch;
    stubFalOk();
    var ip = nextGenVideoIp();
    await entitlements.setEntitlement({}, 'fakebypasser@example.com', { tokens: { balance: 100000, lastClaimAt: Date.now() } });
    var body = { caption: 'a dream', style: 'Cartoon', email: 'fakebypasser@example.com', ownerBypassToken: 'a-completely-made-up-token-nobody-issued' };
    var r1 = await handler(fakeEvent({ method: 'POST', ip: ip, body: body }));
    var r2 = await handler(fakeEvent({ method: 'POST', ip: ip, body: body }));
    global.fetch = realFetch;
    assert.equal(r1.statusCode, 200);
    assert.equal(r2.statusCode, 429, 'a fake/unverified bypass token must never actually bypass anything');
    assert.match(JSON.parse(r2.body).error, /^E109/);
  });
});

test('generate-video: a NON-owner account cannot obtain a working bypass token for themselves at all (verify-owner-bypass rejects them) -- so their generation requests can never carry a live one', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, MAX_GENERATIONS_PER_IP_PER_DAY: '1', FAL_KEY: 'test-fal-key', DAILY_SPEND_CAP_USD: undefined }, async function () {
    await registerAccount('attacker', 'attackerpassword1', 'attacker@example.com');
    var verifyHandler = require('../netlify/functions/verify-owner-bypass').handler;
    var verifyRes = await verifyHandler(fakeEvent({ method: 'POST', ip: nextGenVideoIp(), body: { username: 'attacker', password: 'attackerpassword1' } }));
    assert.equal(verifyRes.statusCode, 403, 'a real, non-owner account must never be issued a bypass token');
    assert.equal(JSON.parse(verifyRes.body).token, undefined);
  });
});

test('generate-video: THE CRITICAL BINDING PROPERTY -- a valid, live bypass token issued for the OWNER email must NEVER activate the bypass for a DIFFERENT email in the request body -- closes the "leaked/replayed token against an arbitrary email" gap review round 1 flagged', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, MAX_GENERATIONS_PER_IP_PER_DAY: '1', FAL_KEY: 'test-fal-key', DAILY_SPEND_CAP_USD: undefined }, async function () {
    delete require.cache[require.resolve('../netlify/functions/generate-video')];
    delete require.cache[require.resolve('../netlify/functions/verify-owner-bypass')];
    var entitlements = require('../netlify/functions/lib/entitlements');
    var handler = require('../netlify/functions/generate-video').handler;
    // A genuinely live, correctly-issued token -- proves the OWNER's own
    // password, not a forged/guessed one.
    var realOwnerToken = await issueOwnerToken();
    var realFetch = global.fetch;
    stubFalOk();
    var ip = nextGenVideoIp();
    var attackerEmail = 'attacker-controlled@example.com';
    await entitlements.setEntitlement({}, attackerEmail, { tokens: { balance: 100000, lastClaimAt: Date.now() } });
    var body = { caption: 'a dream', style: 'Cartoon', email: attackerEmail, ownerBypassToken: realOwnerToken };
    // Cap is 1/day on this IP -- the 2nd request must 429 exactly like it
    // would with no token attached at all, proving the live-but-mismatched
    // token contributed NOTHING toward bypassing the rate limit for this
    // other email.
    var r1 = await handler(fakeEvent({ method: 'POST', ip: ip, body: body }));
    var r2 = await handler(fakeEvent({ method: 'POST', ip: ip, body: body }));
    global.fetch = realFetch;
    assert.equal(r1.statusCode, 200);
    assert.equal(r2.statusCode, 429, 'a live token bound to a DIFFERENT email must never bypass the rate limit for this email');
    assert.match(JSON.parse(r2.body).error, /^E109: rate_limited/);
  });
});

test('generate-video: THE MOST IMPORTANT PROPERTY -- DAILY_SPEND_CAP_USD (E110) is enforced even with a verified, active owner bypass -- the money backstop is never bypassable, under any circumstance this feature builds', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, FAL_KEY: 'test-fal-key', DAILY_SPEND_CAP_USD: '1' }, async function () {
    delete require.cache[require.resolve('../netlify/functions/generate-video')];
    delete require.cache[require.resolve('../netlify/functions/verify-owner-bypass')];
    var entitlements = require('../netlify/functions/lib/entitlements');
    var handler = require('../netlify/functions/generate-video').handler;
    var token = await issueOwnerToken();
    var realFetch = global.fetch;
    stubFalOk();
    await entitlements.setEntitlement({}, OWNER_EMAIL, { tokens: { balance: 100000, lastClaimAt: Date.now() } });
    // Pre-fill today's spend-guard counter right up to the cap, exactly
    // like test/generate-video-tokens.test.js's own E110 test does.
    var todayUtc = new Date().toISOString().slice(0, 10);
    mockBlobs.seed('dreamtube-spend-guard', 'spend:' + todayUtc, 1);
    var res = await handler(fakeEvent({
      method: 'POST', ip: nextGenVideoIp(),
      body: { caption: 'a dream', style: 'Cartoon', email: OWNER_EMAIL, ownerBypassToken: token }
    }));
    global.fetch = realFetch;
    assert.equal(res.statusCode, 503, 'DAILY_SPEND_CAP_USD must still trip even with an active owner bypass');
    assert.match(JSON.parse(res.body).error, /^E110: daily_spend_cap_exceeded/);
  });
});

test('generate-video: THE SECOND MOST IMPORTANT PROPERTY -- E112 (insufficient tokens) is enforced even with a verified, active owner bypass -- the owner still needs a real balance to generate', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, FAL_KEY: 'test-fal-key', DAILY_SPEND_CAP_USD: undefined }, async function () {
    delete require.cache[require.resolve('../netlify/functions/generate-video')];
    delete require.cache[require.resolve('../netlify/functions/verify-owner-bypass')];
    var entitlements = require('../netlify/functions/lib/entitlements');
    var handler = require('../netlify/functions/generate-video').handler;
    var token = await issueOwnerToken();
    var realFetch = global.fetch;
    stubFalOk();
    await entitlements.setEntitlement({}, OWNER_EMAIL, { tokens: { balance: 0, lastClaimAt: Date.now() } });
    var res = await handler(fakeEvent({
      method: 'POST', ip: nextGenVideoIp(),
      body: { caption: 'a dream', style: 'Cartoon', email: OWNER_EMAIL, ownerBypassToken: token }
    }));
    global.fetch = realFetch;
    assert.equal(res.statusCode, 402, 'E112 must still block a zero balance even with an active owner bypass');
    assert.match(JSON.parse(res.body).error, /^E112: insufficient_tokens/);
  });
});

test('generate-video: an owner bypass also lets a brand-new email skip the token-init per-IP cap, but still only ever grants the normal INITIAL_GRANT -- never more', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, FAL_KEY: 'test-fal-key', DAILY_SPEND_CAP_USD: undefined, MAX_TOKEN_GRANTS_PER_IP_PER_DAY: '1' }, async function () {
    delete require.cache[require.resolve('../netlify/functions/generate-video')];
    delete require.cache[require.resolve('../netlify/functions/verify-owner-bypass')];
    var entitlements = require('../netlify/functions/lib/entitlements');
    var handler = require('../netlify/functions/generate-video').handler;
    var token = await issueOwnerToken();
    var realFetch = global.fetch;
    stubFalOk();
    var ip = nextGenVideoIp();
    // Exhaust today's token-init cap on this IP first, for an unrelated
    // brand-new email -- the normal (non-owner) path.
    await entitlements.getTokenStatus(fakeEvent({ method: 'POST', ip: ip }), 'someoneelse-new@example.com');
    var alreadyCapped = await entitlements.getTokenStatus(fakeEvent({ method: 'POST', ip: ip }), 'yetanother-new@example.com');
    assert.equal(alreadyCapped.balance, 0, 'sanity check: the token-init cap is genuinely exhausted on this IP now');

    // A brand-new OWNER email, same capped IP, WITH the bypass -- must
    // still get the real 170-token INITIAL_GRANT, then spend exactly 100
    // on this successful generation (never more than a normal grant would
    // allow).
    var res = await handler(fakeEvent({
      method: 'POST', ip: ip,
      body: { caption: 'a dream', style: 'Cartoon', email: OWNER_EMAIL, ownerBypassToken: token }
    }));
    global.fetch = realFetch;
    assert.equal(res.statusCode, 200);
    var record = await entitlements.getEntitlement({}, OWNER_EMAIL);
    assert.equal(record.tokens.balance, 70, '170 granted (bypassing the token-init cap), 100 spent on this generation -- never more than the normal grant');
  });
});

// ===== Integration: generate-image.js (E409/E410/E412) =====

test('generate-image: a verified owner bypass token skips the per-IP rate limit (E409)', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, MAX_GENERATIONS_PER_IP_PER_DAY: '1', FAL_KEY: 'test-fal-key', DAILY_SPEND_CAP_USD: undefined }, async function () {
    delete require.cache[require.resolve('../netlify/functions/generate-image')];
    delete require.cache[require.resolve('../netlify/functions/verify-owner-bypass')];
    var entitlements = require('../netlify/functions/lib/entitlements');
    var handler = require('../netlify/functions/generate-image').handler;
    var token = await issueOwnerToken();
    var realFetch = global.fetch;
    stubFalOk();
    var ip = nextGenVideoIp();
    await entitlements.setEntitlement({}, OWNER_EMAIL, { tokens: { balance: 100000, lastClaimAt: Date.now() } });
    var body = { caption: 'a dream', style: 'Cartoon', email: OWNER_EMAIL, ownerBypassToken: token };
    var r1 = await handler(fakeEvent({ method: 'POST', ip: ip, body: body }));
    var r2 = await handler(fakeEvent({ method: 'POST', ip: ip, body: body }));
    global.fetch = realFetch;
    assert.equal(r1.statusCode, 200);
    assert.equal(r2.statusCode, 200, 'bypass must skip generate-image.js\'s own E409 rate limit');
  });
});

test('generate-image: a valid, live bypass token bound to the OWNER email must NEVER activate the bypass for a DIFFERENT email in the request body (same binding property as generate-video.js)', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, MAX_GENERATIONS_PER_IP_PER_DAY: '1', FAL_KEY: 'test-fal-key', DAILY_SPEND_CAP_USD: undefined }, async function () {
    delete require.cache[require.resolve('../netlify/functions/generate-image')];
    delete require.cache[require.resolve('../netlify/functions/verify-owner-bypass')];
    var entitlements = require('../netlify/functions/lib/entitlements');
    var handler = require('../netlify/functions/generate-image').handler;
    var realOwnerToken = await issueOwnerToken();
    var realFetch = global.fetch;
    stubFalOk();
    var ip = nextGenVideoIp();
    var attackerEmail = 'attacker-controlled-image@example.com';
    await entitlements.setEntitlement({}, attackerEmail, { tokens: { balance: 100000, lastClaimAt: Date.now() } });
    var body = { caption: 'a dream', style: 'Cartoon', email: attackerEmail, ownerBypassToken: realOwnerToken };
    var r1 = await handler(fakeEvent({ method: 'POST', ip: ip, body: body }));
    var r2 = await handler(fakeEvent({ method: 'POST', ip: ip, body: body }));
    global.fetch = realFetch;
    assert.equal(r1.statusCode, 200);
    assert.equal(r2.statusCode, 429, 'a live token bound to a DIFFERENT email must never bypass generate-image.js\'s rate limit either');
    assert.match(JSON.parse(r2.body).error, /^E409: rate_limited/);
  });
});

test('generate-image: WITHOUT a bypass, E409 still fires normally', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, MAX_GENERATIONS_PER_IP_PER_DAY: '1', FAL_KEY: 'test-fal-key', DAILY_SPEND_CAP_USD: undefined }, async function () {
    delete require.cache[require.resolve('../netlify/functions/generate-image')];
    var entitlements = require('../netlify/functions/lib/entitlements');
    var handler = require('../netlify/functions/generate-image').handler;
    var realFetch = global.fetch;
    stubFalOk();
    var ip = nextGenVideoIp();
    await entitlements.setEntitlement({}, 'imgnobypass@example.com', { tokens: { balance: 100000, lastClaimAt: Date.now() } });
    var body = { caption: 'a dream', style: 'Cartoon', email: 'imgnobypass@example.com' };
    var r1 = await handler(fakeEvent({ method: 'POST', ip: ip, body: body }));
    var r2 = await handler(fakeEvent({ method: 'POST', ip: ip, body: body }));
    global.fetch = realFetch;
    assert.equal(r1.statusCode, 200);
    assert.equal(r2.statusCode, 429);
    assert.match(JSON.parse(r2.body).error, /^E409: rate_limited/);
  });
});

test('generate-image: DAILY_SPEND_CAP_USD (E410) is enforced even with a verified, active owner bypass', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, FAL_KEY: 'test-fal-key', DAILY_SPEND_CAP_USD: '1' }, async function () {
    delete require.cache[require.resolve('../netlify/functions/generate-image')];
    delete require.cache[require.resolve('../netlify/functions/verify-owner-bypass')];
    var entitlements = require('../netlify/functions/lib/entitlements');
    var handler = require('../netlify/functions/generate-image').handler;
    var token = await issueOwnerToken();
    var realFetch = global.fetch;
    stubFalOk();
    await entitlements.setEntitlement({}, OWNER_EMAIL, { tokens: { balance: 100000, lastClaimAt: Date.now() } });
    var todayUtc = new Date().toISOString().slice(0, 10);
    mockBlobs.seed('dreamtube-spend-guard', 'spend:' + todayUtc, 1);
    var res = await handler(fakeEvent({
      method: 'POST', ip: nextGenVideoIp(),
      body: { caption: 'a dream', style: 'Cartoon', email: OWNER_EMAIL, ownerBypassToken: token }
    }));
    global.fetch = realFetch;
    assert.equal(res.statusCode, 503, 'DAILY_SPEND_CAP_USD must still trip on the image path even with an active owner bypass');
    assert.match(JSON.parse(res.body).error, /^E410: daily_spend_cap_exceeded/);
  });
});

test('generate-image: E412 (insufficient tokens) is enforced even with a verified, active owner bypass', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, FAL_KEY: 'test-fal-key', DAILY_SPEND_CAP_USD: undefined }, async function () {
    delete require.cache[require.resolve('../netlify/functions/generate-image')];
    delete require.cache[require.resolve('../netlify/functions/verify-owner-bypass')];
    var entitlements = require('../netlify/functions/lib/entitlements');
    var handler = require('../netlify/functions/generate-image').handler;
    var token = await issueOwnerToken();
    var realFetch = global.fetch;
    stubFalOk();
    await entitlements.setEntitlement({}, OWNER_EMAIL, { tokens: { balance: 5, lastClaimAt: Date.now() } });
    var res = await handler(fakeEvent({
      method: 'POST', ip: nextGenVideoIp(),
      body: { caption: 'a dream', style: 'Cartoon', email: OWNER_EMAIL, ownerBypassToken: token }
    }));
    global.fetch = realFetch;
    assert.equal(res.statusCode, 402);
    assert.match(JSON.parse(res.body).error, /^E412: insufficient_tokens/);
  });
});
