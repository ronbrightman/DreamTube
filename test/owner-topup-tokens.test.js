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
var accountStore = require('../netlify/functions/lib/account-store');

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
    assert.equal(body.balance, 720, '220 signup grant (first-ever read, materialized by addTokens) + 500 top-up');
    assert.equal(body.dailyGrantAmount, 20);

    var record = await entitlements.getEntitlement(fakeEvent({}), OWNER_EMAIL);
    assert.equal(record.tokens.balance, 720);
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
    assert.equal(body.balance, 470, '220 signup grant + 250 top-up');
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
    assert.equal(JSON.parse(res.body).balance, 5220, '220 signup grant + 5000 top-up');
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

// ----- targetUsername (tracker item for-product-extend-owner-top-up-with-a-t-2hmopn) -----

test('self-top-up (no targetUsername) still works exactly as before — regression', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var handler = require('../netlify/functions/owner-topup-tokens').handler;
    var res = await handler(fakeEvent({
      method: 'POST',
      body: { email: OWNER_EMAIL, amount: 500 }
    }));
    assert.equal(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.equal(body.balance, 720, '220 signup grant + 500 top-up, same as before targetUsername existed');
    assert.equal(body.creditedEmail, OWNER_EMAIL);
    assert.equal(body.targetUsername, null);

    var record = await entitlements.getEntitlement(fakeEvent({}), OWNER_EMAIL);
    assert.equal(record.tokens.balance, 720);
  });
});

test('a top-up with a valid targetUsername credits the target account, NOT the owner\'s own', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var setupEvent = fakeEvent({});
    var created = await accountStore.createAccount(setupEvent, {
      username: 'benbrightman14',
      email: 'ben@example.com',
      password: 'somepassword1'
    });
    assert.ok(created.ok);

    var handler = require('../netlify/functions/owner-topup-tokens').handler;
    var res = await handler(fakeEvent({
      method: 'POST',
      body: { email: OWNER_EMAIL, amount: 800, targetUsername: 'benbrightman14' }
    }));
    assert.equal(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.equal(body.creditedEmail, 'ben@example.com');
    assert.equal(body.targetUsername, 'benbrightman14');
    assert.equal(body.balance, 1020, '220 signup grant + 800 gift for the target account');

    var targetRecord = await entitlements.getEntitlement(fakeEvent({}), 'ben@example.com');
    assert.equal(targetRecord.tokens.balance, 1020, 'the target account was credited');

    var ownerRecord = await entitlements.getEntitlement(fakeEvent({}), OWNER_EMAIL);
    assert.equal(ownerRecord, null, "the owner's own balance must be untouched by a gifted top-up");
  });
});

test('a top-up with a targetUsername normalizes case/whitespace the same way account-store.js does', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var setupEvent = fakeEvent({});
    await accountStore.createAccount(setupEvent, {
      username: 'benbrightman14',
      email: 'ben@example.com',
      password: 'somepassword1'
    });

    var handler = require('../netlify/functions/owner-topup-tokens').handler;
    var res = await handler(fakeEvent({
      method: 'POST',
      body: { email: OWNER_EMAIL, amount: 800, targetUsername: '  BenBrightman14  ' }
    }));
    assert.equal(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.equal(body.creditedEmail, 'ben@example.com');

    var targetRecord = await entitlements.getEntitlement(fakeEvent({}), 'ben@example.com');
    assert.equal(targetRecord.tokens.balance, 1020);
  });
});

test('a top-up with a nonexistent targetUsername returns a clear error and credits nothing', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var handler = require('../netlify/functions/owner-topup-tokens').handler;
    var res = await handler(fakeEvent({
      method: 'POST',
      body: { email: OWNER_EMAIL, amount: 800, targetUsername: 'nobody-with-this-username' }
    }));
    assert.equal(res.statusCode, 404);
    assert.match(JSON.parse(res.body).error, /^E6: target_account_not_found/);

    var ownerRecord = await entitlements.getEntitlement(fakeEvent({}), OWNER_EMAIL);
    assert.equal(ownerRecord, null, 'a rejected target lookup must not fall back to crediting the owner');
  });
});

test('requesting-owner auth is still enforced when a targetUsername is named — a non-owner request is rejected regardless', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var setupEvent = fakeEvent({});
    await accountStore.createAccount(setupEvent, {
      username: 'benbrightman14',
      email: 'ben@example.com',
      password: 'somepassword1'
    });

    var handler = require('../netlify/functions/owner-topup-tokens').handler;
    var res = await handler(fakeEvent({
      method: 'POST',
      body: { email: 'not-the-owner@example.com', amount: 800, targetUsername: 'benbrightman14' }
    }));
    assert.equal(res.statusCode, 403);
    assert.match(JSON.parse(res.body).error, /^E5: forbidden/);

    var targetRecord = await entitlements.getEntitlement(fakeEvent({}), 'ben@example.com');
    assert.equal(targetRecord, null, 'a non-owner request must credit nothing, even naming a real targetUsername');
  });
});

test('a blank/whitespace-only targetUsername is treated as no target (self-top-up)', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var handler = require('../netlify/functions/owner-topup-tokens').handler;
    var res = await handler(fakeEvent({
      method: 'POST',
      body: { email: OWNER_EMAIL, amount: 500, targetUsername: '   ' }
    }));
    assert.equal(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.equal(body.creditedEmail, OWNER_EMAIL);
    assert.equal(body.targetUsername, null);
  });
});
