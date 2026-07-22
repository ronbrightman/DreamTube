// test/owner-topup-tokens.test.js
//
// Covers netlify/functions/owner-topup-tokens.js: owner-only enforcement
// (same shape as admin-paywall-toggle.test.js), amount validation (positive
// integer, capped at MAX_AMOUNT_PER_CALL), that it doesn't touch
// lastGrantAt, and that a non-owner or malformed request changes nothing.
// Run with: node --test test/

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var entitlements = require('../netlify/functions/lib/entitlements');

var OWNER_EMAIL = 'founder@dreamtube.example';

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

test.beforeEach(function () {
  mockBlobs.reset();
  delete require.cache[require.resolve('../netlify/functions/owner-topup-tokens')];
});

test('POST from the owner credits the amount and returns the refreshed token status', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var handler = require('../netlify/functions/owner-topup-tokens').handler;

    var res = await handler(fakeEvent({
      method: 'POST',
      body: { email: OWNER_EMAIL, amount: 500 }
    }));
    assert.equal(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.equal(body.balance, 700, '200 signup grant (first-ever read, materialized by addTokens) + 500 top-up');
    assert.equal(body.dailyGrantAmount, 100);

    var record = await entitlements.getEntitlement(fakeEvent({}), OWNER_EMAIL);
    assert.equal(record.tokens.balance, 700);
  });
});

test('POST normalizes the owner email the same way admin-paywall-toggle.js does (trim + case-insensitive)', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var handler = require('../netlify/functions/owner-topup-tokens').handler;
    var res = await handler(fakeEvent({
      method: 'POST',
      body: { email: '  Founder@DreamTube.Example  ', amount: 250 }
    }));
    assert.equal(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.equal(body.balance, 450);
  });
});

test('POST from a non-owner email is rejected with 403 and credits nothing', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var handler = require('../netlify/functions/owner-topup-tokens').handler;
    var res = await handler(fakeEvent({
      method: 'POST',
      body: { email: 'not-the-owner@example.com', amount: 500 }
    }));
    assert.equal(res.statusCode, 403);
    assert.match(JSON.parse(res.body).error, /^E5: forbidden/);

    var record = await entitlements.getEntitlement(fakeEvent({}), 'not-the-owner@example.com');
    assert.equal(record, null, 'nothing should have been written for the rejected email');
  });
});

test('POST with a missing email is rejected with 403, same as a wrong one', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var handler = require('../netlify/functions/owner-topup-tokens').handler;
    var res = await handler(fakeEvent({ method: 'POST', body: { amount: 500 } }));
    assert.equal(res.statusCode, 403);
  });
});

test('POST is rejected with 500 when OWNER_EMAIL is not configured at all, and credits nothing', function () {
  return withEnv({ OWNER_EMAIL: undefined }, async function () {
    var handler = require('../netlify/functions/owner-topup-tokens').handler;
    var res = await handler(fakeEvent({
      method: 'POST',
      body: { email: 'anyone@example.com', amount: 500 }
    }));
    assert.equal(res.statusCode, 500);
    assert.match(JSON.parse(res.body).error, /^E2: missing_owner_email/);

    var record = await entitlements.getEntitlement(fakeEvent({}), 'anyone@example.com');
    assert.equal(record, null);
  });
});

test('unsupported method is rejected with 405', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var handler = require('../netlify/functions/owner-topup-tokens').handler;
    var res = await handler(fakeEvent({ method: 'GET' }));
    assert.equal(res.statusCode, 405);
  });
});

test('POST with invalid JSON is rejected with 400', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var handler = require('../netlify/functions/owner-topup-tokens').handler;
    var res = await handler(fakeEvent({ method: 'POST', body: '{not json' }));
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /^E3: invalid_json/);
  });
});

// ----- amount validation -----

test('a non-integer amount is rejected with 400 before the owner check even matters', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var handler = require('../netlify/functions/owner-topup-tokens').handler;
    var res = await handler(fakeEvent({
      method: 'POST',
      body: { email: OWNER_EMAIL, amount: 12.5 }
    }));
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /^E4: amount_invalid/);
  });
});

test('a zero or negative amount is rejected with 400', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var handler = require('../netlify/functions/owner-topup-tokens').handler;
    var zeroRes = await handler(fakeEvent({ method: 'POST', body: { email: OWNER_EMAIL, amount: 0 } }));
    assert.equal(zeroRes.statusCode, 400);
    var negRes = await handler(fakeEvent({ method: 'POST', body: { email: OWNER_EMAIL, amount: -50 } }));
    assert.equal(negRes.statusCode, 400);
  });
});

test('a missing/non-numeric amount is rejected with 400', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var handler = require('../netlify/functions/owner-topup-tokens').handler;
    var missingRes = await handler(fakeEvent({ method: 'POST', body: { email: OWNER_EMAIL } }));
    assert.equal(missingRes.statusCode, 400);
    var stringRes = await handler(fakeEvent({ method: 'POST', body: { email: OWNER_EMAIL, amount: '500' } }));
    assert.equal(stringRes.statusCode, 400);
  });
});

test('an amount over the per-call cap (5000) is rejected with 400 and credits nothing', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var handler = require('../netlify/functions/owner-topup-tokens').handler;
    var res = await handler(fakeEvent({
      method: 'POST',
      body: { email: OWNER_EMAIL, amount: 5001 }
    }));
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /^E4: amount_invalid/);

    var record = await entitlements.getEntitlement(fakeEvent({}), OWNER_EMAIL);
    assert.equal(record, null, 'a rejected over-cap request must not credit anything');
  });
});

test('an amount exactly at the per-call cap (5000) is accepted', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var handler = require('../netlify/functions/owner-topup-tokens').handler;
    var res = await handler(fakeEvent({
      method: 'POST',
      body: { email: OWNER_EMAIL, amount: 5000 }
    }));
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).balance, 5200, '200 signup grant + 5000 top-up');
  });
});

// ----- lastGrantAt untouched -----

test('a successful top-up does not touch lastGrantAt', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var handler = require('../netlify/functions/owner-topup-tokens').handler;
    var seedEvent = fakeEvent({});
    var staleTime = Date.now() - 1000;
    await entitlements.setEntitlement(seedEvent, OWNER_EMAIL, { tokens: { balance: 100, lastGrantAt: staleTime } });

    await handler(fakeEvent({ method: 'POST', body: { email: OWNER_EMAIL, amount: 250 } }));

    var record = await entitlements.getEntitlement(seedEvent, OWNER_EMAIL);
    assert.equal(record.tokens.balance, 350);
    assert.equal(record.tokens.lastGrantAt, staleTime, 'lastGrantAt must be unchanged by a manual top-up');
  });
});

test('a rejected (non-owner) request changes lastGrantAt for no one — no record touched at all', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var handler = require('../netlify/functions/owner-topup-tokens').handler;
    var res = await handler(fakeEvent({
      method: 'POST',
      body: { email: 'stranger@example.com', amount: 250 }
    }));
    assert.equal(res.statusCode, 403);
    var record = await entitlements.getEntitlement(fakeEvent({}), 'stranger@example.com');
    assert.equal(record, null);
  });
});
