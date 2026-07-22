// test/generate-video-tokens.test.js
//
// Covers the token economy's server-side enforcement in
// netlify/functions/generate-video.js: the E112 gate (unconditional — no
// PAYWALL_ENABLED-style flag, no OWNER_EMAIL bypass, unlike the old
// E108/E111 gate this replaces), that spendTokens fires on every
// successful 200 (mock mode and the real fal path) but never on a fal
// submission rejection (E105/E106) or network failure (E107), and that a
// brand-new email's 200-token signup grant materializes correctly through
// this same call path. See test/entitlements-tokens.test.js for direct
// unit coverage of getTokenStatus/spendTokens themselves.

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
  return '10.3.0.' + ipCounter;
}

function stubFetchOk() {
  global.fetch = async function () {
    return { ok: true, status: 200, json: async function () { return { request_id: 'fake-request-id' }; } };
  };
}

function stubFetchRejected() {
  global.fetch = async function () {
    return { ok: false, status: 422, json: async function () { return { detail: 'nope' }; } };
  };
}

function genEvent(overrides) {
  var base = {
    method: 'POST',
    ip: nextIp(),
    body: Object.assign({ caption: 'a dream about flying', style: 'Cartoon' }, overrides && overrides.body)
  };
  if (overrides && overrides.ip) base.ip = overrides.ip;
  return fakeEvent(base);
}

async function balance(email, amount) {
  return entitlements.setEntitlement({}, email, { tokens: { balance: amount, lastGrantAt: Date.now() } });
}

test.beforeEach(async function () {
  mockBlobs.reset();
  global.fetch = realFetch;
  process.env.FAL_KEY = 'test-fal-key';
  delete process.env.OWNER_EMAIL;
  delete process.env.DAILY_SPEND_CAP_USD;
  delete process.env.MAX_GENERATIONS_PER_IP_PER_DAY;
  delete process.env.MAX_TOKEN_GRANTS_PER_IP_PER_DAY;
  delete process.env.GENERATION_MOCK_MODE;
});

test.after(function () {
  global.fetch = realFetch;
});

// ----- E112 gate -----

test('balance under 100 -> E112, fal never called', async function () {
  var calls = 0;
  global.fetch = async function () { calls++; return { ok: true, status: 200, json: async function () { return { request_id: 'x' }; } }; };
  await balance('broke@example.com', 50);
  var res = await handler(genEvent({ body: { email: 'broke@example.com' } }));
  assert.equal(res.statusCode, 402);
  assert.match(JSON.parse(res.body).error, /^E112: insufficient_tokens/);
  assert.equal(calls, 0);
});

test('balance exactly 99 -> still blocked (100 is the flat cost of one generation)', async function () {
  await balance('almost@example.com', 99);
  var res = await handler(genEvent({ body: { email: 'almost@example.com' } }));
  assert.equal(res.statusCode, 402);
  assert.match(JSON.parse(res.body).error, /^E112:/);
});

test('balance exactly 100 -> proceeds (E112 only fires below 100, not at it)', async function () {
  stubFetchOk();
  await balance('exact@example.com', 100);
  var res = await handler(genEvent({ body: { email: 'exact@example.com' } }));
  assert.equal(res.statusCode, 200);
});

test('a request with no email at all -> E112 (balance resolves to 0, nothing to identify a balance with)', async function () {
  var res = await handler(genEvent({}));
  assert.equal(res.statusCode, 402);
  assert.match(JSON.parse(res.body).error, /^E112:/);
});

test('a brand-new email (never seen before) gets its 200-token signup grant materialized right here and proceeds', async function () {
  stubFetchOk();
  var res = await handler(genEvent({ body: { email: 'first-time@example.com' } }));
  assert.equal(res.statusCode, 200);
  var record = await entitlements.getEntitlement({}, 'first-time@example.com');
  assert.equal(record.tokens.balance, 100, '200 granted, 100 spent on this successful generation');
});

// ----- No flag, no owner bypass — unconditional, unlike the old E108/E111 gate -----

test('OWNER_EMAIL does NOT bypass the token gate — an owner with insufficient balance is still blocked E112', async function () {
  var OWNER_EMAIL = 'founder@dreamtube.example';
  process.env.OWNER_EMAIL = OWNER_EMAIL;
  await balance(OWNER_EMAIL, 0);
  var res = await handler(genEvent({ body: { email: OWNER_EMAIL } }));
  assert.equal(res.statusCode, 402);
  assert.match(JSON.parse(res.body).error, /^E112:/);
});

// ----- spendTokens on success -----

test('mock mode success spends 100 tokens', async function () {
  process.env.GENERATION_MOCK_MODE = 'true';
  await balance('mockuser@example.com', 300);
  var res = await handler(genEvent({ body: { email: 'mockuser@example.com' } }));
  assert.equal(res.statusCode, 200);
  var record = await entitlements.getEntitlement({}, 'mockuser@example.com');
  assert.equal(record.tokens.balance, 200);
});

test('real fal success spends 100 tokens', async function () {
  stubFetchOk();
  await balance('realuser@example.com', 300);
  var res = await handler(genEvent({ body: { email: 'realuser@example.com' } }));
  assert.equal(res.statusCode, 200);
  var record = await entitlements.getEntitlement({}, 'realuser@example.com');
  assert.equal(record.tokens.balance, 200);
});

test('a fal submission rejection (E105) does NOT spend tokens', async function () {
  stubFetchRejected();
  await balance('rejected@example.com', 300);
  var res = await handler(genEvent({ body: { email: 'rejected@example.com' } }));
  assert.match(JSON.parse(res.body).error, /^E105:/);
  var record = await entitlements.getEntitlement({}, 'rejected@example.com');
  assert.equal(record.tokens.balance, 300, 'balance must be unchanged after a rejected submission');
});

test('a network failure reaching fal (E107) does NOT spend tokens', async function () {
  global.fetch = async function () { throw new Error('network down'); };
  await balance('netfail@example.com', 300);
  var res = await handler(genEvent({ body: { email: 'netfail@example.com' } }));
  assert.match(JSON.parse(res.body).error, /^E107:/);
  var record = await entitlements.getEntitlement({}, 'netfail@example.com');
  assert.equal(record.tokens.balance, 300);
});

test('E109 rate limit and E110 spend guard are untouched by the token gate — still fire independently', async function () {
  process.env.DAILY_SPEND_CAP_USD = '1';
  var todayUtc = new Date().toISOString().slice(0, 10);
  mockBlobs.seed('dreamtube-spend-guard', 'spend:' + todayUtc, 1);
  await balance('spendcapped@example.com', 300);
  var res = await handler(genEvent({ body: { email: 'spendcapped@example.com' } }));
  assert.equal(res.statusCode, 503);
  assert.match(JSON.parse(res.body).error, /^E110: daily_spend_cap_exceeded/);
});
