// test/admin-diagnose-dodo-status.test.js
//
// Covers netlify/functions/admin-diagnose-dodo-status.js: the READ-ONLY
// owner-gated diagnostic that reports (1) the active Dodo mode (live/test)
// and (2) a subscription's true status straight from Dodo's API. Same test
// conventions as test/admin-diagnose-dodo-payment.test.js; the Dodo SDK
// client is injected as a recording spy (via the function's
// __setTestClientFactory seam) so we can assert exactly which client
// methods were called — and that no MUTATING one, and no API key, ever
// leaks — with zero network.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');

var OWNER_EMAIL = 'founder@dreamtube.example';
var FAKE_KEY = 'dodo_live_SUPERSECRETKEY_ABC123xyz';

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
  delete require.cache[require.resolve('../netlify/functions/admin-diagnose-dodo-status')];
  delete require.cache[require.resolve('../netlify/functions/lib/account-store')];
  delete require.cache[require.resolve('../netlify/functions/lib/entitlements')];
});

var ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return '10.7.2.' + ipCounter;
}

async function seedOwnerAccount(event, overrides) {
  var accountStore = require('../netlify/functions/lib/account-store');
  var body = Object.assign({ username: 'ronbrightman', password: 'realfounderpw1', email: OWNER_EMAIL }, overrides || {});
  return accountStore.createAccount(event, body);
}

// A recording fake Dodo client. Every property accessed on `subscriptions`
// / `customers` becomes a call that is recorded; only the read methods we
// stub actually resolve — any other method (i.e. every mutating one:
// update/charge/changePlan/cancel/create/delete/...) rejects loudly AND is
// recorded, so the regression assertion can prove none was touched.
var MUTATING_METHODS = ['update', 'cancel', 'charge', 'changePlan', 'updatePaymentMethod', 'create', 'delete', 'updatePaymentMethod'];

function makeRecordingClient(impls) {
  impls = impls || {};
  var calls = [];
  function recorder(resourceName, methods) {
    return new Proxy({}, {
      get: function (_t, prop) {
        return function () {
          var args = Array.prototype.slice.call(arguments);
          calls.push({ resource: resourceName, method: String(prop), args: args });
          if (methods && typeof methods[prop] === 'function') return methods[prop].apply(null, args);
          return Promise.reject(new Error('unexpected client method called: ' + resourceName + '.' + String(prop)));
        };
      }
    });
  }
  var client = {
    subscriptions: recorder('subscriptions', { retrieve: impls.retrieve, list: impls.list }),
    customers: recorder('customers', { list: impls.customersList })
  };
  return { client: client, calls: calls };
}

function loadHandlerWith(impls) {
  var mod = require('../netlify/functions/admin-diagnose-dodo-status');
  var rec = makeRecordingClient(impls);
  var modes = [];
  mod.__setTestClientFactory(function (activeMode) { modes.push(activeMode); return rec.client; });
  return { handler: mod.handler, calls: rec.calls, modes: modes };
}

// A realistic Dodo Subscription-in-trial (retrieve shape). created_at is
// "now" so the derived trial window is currently open.
function trialSubscriptionFixture() {
  var nowMs = Date.now();
  return {
    subscription_id: 'sub_TRIAL123',
    status: 'active',                       // Dodo has NO 'trialing' status
    trial_period_days: 3,
    created_at: new Date(nowMs).toISOString(),
    next_billing_date: new Date(nowMs + 3 * 86400000).toISOString(),
    previous_billing_date: new Date(nowMs).toISOString(),
    cancel_at_next_billing_date: false,
    cancelled_at: null,
    recurring_pre_tax_amount: 999,          // cents
    currency: 'USD',
    product_id: 'pdt_dreamer_pass',
    // sensitive fields the mapper must NOT echo back:
    customer: { customer_id: 'cus_x', email: 'buyer@example.com', name: 'Real Name', phone_number: '+1555' },
    payment_method_id: 'pm_secret',
    billing: { country: 'US', city: 'Springfield' }
  };
}

// ===== active-mode reporting (both env states), no key configured =====

test('reports activeMode live_mode when DODO_ENVIRONMENT is unset, degrading to mode-only when no key', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, DODO_ENVIRONMENT: undefined, DODO_API_KEY: undefined }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    var h = loadHandlerWith({});
    var res = await h.handler(fakeEvent({
      method: 'POST', ip: nextIp(),
      body: { usernameOrEmail: OWNER_EMAIL, password: 'realfounderpw1', subscriptionId: 'sub_x' }
    }));
    assert.equal(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.activeMode, 'live_mode');
    assert.equal(body.keyPresent, false);
    assert.deepEqual(body.subscriptions, []);
    assert.match(body.warning, /^E7: dodo_not_configured/);
    // No key -> Dodo was never contacted at all.
    assert.equal(h.calls.length, 0);
  });
});

test('reports activeMode test_mode when DODO_ENVIRONMENT=test_mode', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, DODO_ENVIRONMENT: 'test_mode', DODO_API_KEY: undefined }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    var h = loadHandlerWith({});
    var res = await h.handler(fakeEvent({
      method: 'POST', ip: nextIp(),
      body: { usernameOrEmail: OWNER_EMAIL, password: 'realfounderpw1', email: 'someone@example.com' }
    }));
    assert.equal(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.equal(body.activeMode, 'test_mode');
    assert.equal(body.keyPresent, false);
  });
});

// ===== subscriptions.retrieve happy path (the mapped shape + mode passthrough) =====

test('retrieve happy path returns the mapped, non-sensitive status shape with derived trialing/trial_end', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, DODO_ENVIRONMENT: 'test_mode', DODO_API_KEY: FAKE_KEY }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);

    var fixture = trialSubscriptionFixture();
    var h = loadHandlerWith({ retrieve: function () { return Promise.resolve(fixture); } });

    var res = await h.handler(fakeEvent({
      method: 'POST', ip: nextIp(),
      body: { usernameOrEmail: OWNER_EMAIL, password: 'realfounderpw1', subscriptionId: 'sub_TRIAL123' }
    }));
    assert.equal(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.activeMode, 'test_mode');    // client built with the active mode
    assert.deepEqual(h.modes, ['test_mode']);
    assert.equal(body.keyPresent, true);

    var s = body.subscription;
    assert.equal(s.subscription_id, 'sub_TRIAL123');
    assert.equal(s.status, 'active');
    assert.equal(s.trialing, true);                 // DERIVED: within trial window
    assert.equal(s.trial_period_days, 3);
    assert.ok(s.trial_end, 'trial_end computed from created_at + trial_period_days');
    assert.equal(s.recurring_pre_tax_amount, 999);
    assert.equal(s.currency, 'USD');
    assert.equal(s.amount_display, '9.99 USD');
    assert.equal(s.product_id, 'pdt_dreamer_pass');
    assert.ok(s.next_billing_date);

    // The retrieve was called with the exact id, and NO other resource touched.
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.calls[0], { resource: 'subscriptions', method: 'retrieve', args: ['sub_TRIAL123'] });

    // No sensitive customer/PII/payment fields leak into the mapped shape.
    var raw = res.body;
    assert.equal(raw.indexOf('Real Name'), -1);
    assert.equal(raw.indexOf('buyer@example.com'), -1);
    assert.equal(raw.indexOf('pm_secret'), -1);
    assert.equal(raw.indexOf('phone_number'), -1);
  });
});

test('a non-trial active subscription derives trialing:false and trial_end:null', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, DODO_ENVIRONMENT: 'live_mode', DODO_API_KEY: FAKE_KEY }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    var sub = {
      subscription_id: 'sub_ACTIVE', status: 'active', trial_period_days: 0,
      created_at: '2026-01-01T00:00:00.000Z', next_billing_date: '2026-08-01T00:00:00.000Z',
      recurring_pre_tax_amount: 4999, currency: 'USD', product_id: 'pdt_x'
    };
    var h = loadHandlerWith({ retrieve: function () { return Promise.resolve(sub); } });
    var res = await h.handler(fakeEvent({
      method: 'POST', ip: nextIp(),
      body: { usernameOrEmail: OWNER_EMAIL, password: 'realfounderpw1', subscriptionId: 'sub_ACTIVE' }
    }));
    var s = JSON.parse(res.body).subscription;
    assert.equal(s.trialing, false);
    assert.equal(s.trial_end, null);
    assert.equal(s.amount_display, '49.99 USD');
  });
});

test('subscriptionId wins when both email and subscriptionId are supplied', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, DODO_ENVIRONMENT: 'test_mode', DODO_API_KEY: FAKE_KEY }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    var h = loadHandlerWith({
      retrieve: function () { return Promise.resolve(trialSubscriptionFixture()); },
      customersList: function () { throw new Error('customers.list must NOT be called when a subscriptionId is given'); }
    });
    var res = await h.handler(fakeEvent({
      method: 'POST', ip: nextIp(),
      body: { usernameOrEmail: OWNER_EMAIL, password: 'realfounderpw1', email: 'x@example.com', subscriptionId: 'sub_TRIAL123' }
    }));
    assert.equal(res.statusCode, 200);
    assert.ok(JSON.parse(res.body).subscription);
    // Only the retrieve happened; the email path (customers.list) never ran.
    assert.deepEqual(h.calls.map(function (c) { return c.resource + '.' + c.method; }), ['subscriptions.retrieve']);
  });
});

// ===== email-lookup path =====

test('email lookup resolves customer(s) then their subscriptions, most-recent-first, capped at 3', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, DODO_ENVIRONMENT: 'live_mode', DODO_API_KEY: FAKE_KEY }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);

    var subsByCustomer = {
      cus_1: {
        data: [
          { subscription_id: 'sub_old', status: 'expired', trial_period_days: 0, created_at: '2026-01-01T00:00:00.000Z', recurring_pre_tax_amount: 999, currency: 'USD', product_id: 'pdt_x' },
          { subscription_id: 'sub_new', status: 'active', trial_period_days: 0, created_at: '2026-08-01T00:00:00.000Z', recurring_pre_tax_amount: 999, currency: 'USD', product_id: 'pdt_x' }
        ]
      }
    };

    var h = loadHandlerWith({
      customersList: function (query) {
        assert.equal(query.email, 'buyer@example.com', 'customers.list filters by the normalized email server-side');
        return Promise.resolve({ data: [{ customer_id: 'cus_1', email: 'buyer@example.com' }] });
      },
      list: function (query) {
        assert.equal(query.customer_id, 'cus_1', 'subscriptions.list filters by the resolved customer_id');
        return Promise.resolve(subsByCustomer[query.customer_id]);
      }
    });

    var res = await h.handler(fakeEvent({
      method: 'POST', ip: nextIp(),
      body: { usernameOrEmail: OWNER_EMAIL, password: 'realfounderpw1', email: 'Buyer@Example.com' }
    }));
    assert.equal(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.activeMode, 'live_mode');
    assert.equal(body.subscriptions.length, 2);
    // Most-recent-first ordering by created_at.
    assert.equal(body.subscriptions[0].subscription_id, 'sub_new');
    assert.equal(body.subscriptions[1].subscription_id, 'sub_old');

    assert.deepEqual(h.calls.map(function (c) { return c.resource + '.' + c.method; }), ['customers.list', 'subscriptions.list']);
  });
});

test('email lookup with no matching customer returns an empty subscriptions list, no subscriptions.list call', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, DODO_ENVIRONMENT: 'live_mode', DODO_API_KEY: FAKE_KEY }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    var h = loadHandlerWith({ customersList: function () { return Promise.resolve({ data: [] }); } });
    var res = await h.handler(fakeEvent({
      method: 'POST', ip: nextIp(),
      body: { usernameOrEmail: OWNER_EMAIL, password: 'realfounderpw1', email: 'nobody@example.com' }
    }));
    var body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.deepEqual(body.subscriptions, []);
    assert.deepEqual(h.calls.map(function (c) { return c.resource + '.' + c.method; }), ['customers.list']);
  });
});

// ===== Dodo-API-error path (safe, E-coded, no key leak) =====

test('a Dodo API error returns 502 E8 with a SAFE message and the API key redacted even if it appears in the error', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, DODO_ENVIRONMENT: 'test_mode', DODO_API_KEY: FAKE_KEY }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    // Worst case: the SDK error message itself embeds the bearer token.
    var h = loadHandlerWith({
      retrieve: function () { return Promise.reject(new Error('401 unauthorized for bearer ' + FAKE_KEY)); }
    });
    var res = await h.handler(fakeEvent({
      method: 'POST', ip: nextIp(),
      body: { usernameOrEmail: OWNER_EMAIL, password: 'realfounderpw1', subscriptionId: 'sub_x' }
    }));
    assert.equal(res.statusCode, 502);
    var body = JSON.parse(res.body);
    assert.equal(body.ok, false);
    assert.equal(body.activeMode, 'test_mode');    // mode still reported on the error path
    assert.match(body.error, /^E8: dodo_api_error/);
    // The key must NOT appear anywhere in the response, and must be redacted.
    assert.equal(res.body.indexOf(FAKE_KEY), -1, 'the bearer token must never appear in the response');
    assert.ok(res.body.indexOf('[REDACTED]') !== -1, 'the token occurrence was redacted');
  });
});

// ===== REGRESSION: read-only + no key ever leaks across every success path =====

test('REGRESSION: no mutating client method is ever called, and the API key never appears in any response', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, DODO_ENVIRONMENT: 'live_mode', DODO_API_KEY: FAKE_KEY }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);

    var h = loadHandlerWith({
      retrieve: function () { return Promise.resolve(trialSubscriptionFixture()); },
      customersList: function () { return Promise.resolve({ data: [{ customer_id: 'cus_1', email: 'buyer@example.com' }] }); },
      list: function () { return Promise.resolve({ data: [{ subscription_id: 'sub_1', status: 'active', trial_period_days: 0, created_at: '2026-08-01T00:00:00.000Z', recurring_pre_tax_amount: 999, currency: 'USD', product_id: 'pdt_x' }] }); }
    });

    var byId = await h.handler(fakeEvent({
      method: 'POST', ip: nextIp(),
      body: { usernameOrEmail: OWNER_EMAIL, password: 'realfounderpw1', subscriptionId: 'sub_TRIAL123' }
    }));
    var byEmail = await h.handler(fakeEvent({
      method: 'POST', ip: nextIp(),
      body: { usernameOrEmail: OWNER_EMAIL, password: 'realfounderpw1', email: 'buyer@example.com' }
    }));

    // No mutating method ever recorded across both paths.
    h.calls.forEach(function (c) {
      assert.equal(MUTATING_METHODS.indexOf(c.method), -1, 'must never call a mutating method, saw: ' + c.resource + '.' + c.method);
    });
    // Only the three read methods were ever used.
    var methodsUsed = h.calls.map(function (c) { return c.resource + '.' + c.method; });
    methodsUsed.forEach(function (m) {
      assert.ok(['subscriptions.retrieve', 'subscriptions.list', 'customers.list'].indexOf(m) !== -1, 'only read methods allowed, saw: ' + m);
    });

    // Key never appears in either response body.
    assert.equal(byId.body.indexOf(FAKE_KEY), -1);
    assert.equal(byEmail.body.indexOf(FAKE_KEY), -1);
  });
});

// ===== request shape =====

test('rejects missing usernameOrEmail/password with 400 E4', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var h = loadHandlerWith({});
    var res = await h.handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: 'someone', subscriptionId: 'sub_x' } }));
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /^E4: missing_fields/);
  });
});

test('rejects when neither email nor subscriptionId is supplied with 400 E4', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    var h = loadHandlerWith({});
    var res = await h.handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: OWNER_EMAIL, password: 'realfounderpw1' } }));
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /^E4: missing_fields/);
  });
});

test('rejects invalid JSON (E3) and non-POST methods (E1)', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var h = loadHandlerWith({});
    var badJson = await h.handler(fakeEvent({ method: 'POST', ip: nextIp(), body: '{not json' }));
    assert.equal(badJson.statusCode, 400);
    assert.match(JSON.parse(badJson.body).error, /^E3: invalid_json/);

    var wrongMethod = await h.handler(fakeEvent({ method: 'GET' }));
    assert.equal(wrongMethod.statusCode, 405);
    assert.match(JSON.parse(wrongMethod.body).error, /^E1: method_not_allowed/);
  });
});

test('is rejected with 500 E2 when OWNER_EMAIL is not configured', function () {
  return withEnv({ OWNER_EMAIL: undefined }, async function () {
    var h = loadHandlerWith({});
    var res = await h.handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: 'anyone', password: 'whatever123', subscriptionId: 'sub_x' } }));
    assert.equal(res.statusCode, 500);
    assert.match(JSON.parse(res.body).error, /^E2: missing_owner_email/);
  });
});

// ===== auth (owner-gating) =====

test('rejects a wrong password for the owner account (403 E5), never contacting Dodo', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, DODO_API_KEY: FAKE_KEY }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    var h = loadHandlerWith({ retrieve: function () { throw new Error('Dodo must never be contacted on a failed auth'); } });
    var res = await h.handler(fakeEvent({
      method: 'POST', ip: nextIp(),
      body: { usernameOrEmail: OWNER_EMAIL, password: 'totallywrongpw', subscriptionId: 'sub_x' }
    }));
    assert.equal(res.statusCode, 403);
    assert.match(JSON.parse(res.body).error, /^E5: forbidden/);
    assert.equal(h.calls.length, 0, 'no Dodo call on a rejected auth');
  });
});

test('rejects a real, correct password belonging to a non-owner account (403 E5)', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, DODO_API_KEY: FAKE_KEY }, async function () {
    var accountStore = require('../netlify/functions/lib/account-store');
    var event = fakeEvent({ method: 'POST' });
    await accountStore.createAccount(event, { username: 'randomguy', password: 'randompw123', email: 'random@example.com' });
    var h = loadHandlerWith({});
    var res = await h.handler(fakeEvent({
      method: 'POST', ip: nextIp(),
      body: { usernameOrEmail: 'randomguy', password: 'randompw123', subscriptionId: 'sub_x' }
    }));
    assert.equal(res.statusCode, 403);
    assert.match(JSON.parse(res.body).error, /^E5: forbidden/);
    assert.equal(h.calls.length, 0);
  });
});

// ===== rate limiting =====

test('exceeding MAX_ADMIN_DIAGNOSE_DODO_STATUS_PER_IP_PER_DAY is rejected with 429 E6', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, MAX_ADMIN_DIAGNOSE_DODO_STATUS_PER_IP_PER_DAY: '1' }, async function () {
    var h = loadHandlerWith({});
    var ip = nextIp();
    var first = await h.handler(fakeEvent({ method: 'POST', ip: ip, body: { usernameOrEmail: 'nobody', password: 'wrongpw123', subscriptionId: 'sub_x' } }));
    assert.equal(first.statusCode, 403);
    var second = await h.handler(fakeEvent({ method: 'POST', ip: ip, body: { usernameOrEmail: OWNER_EMAIL, password: 'realfounderpw1', subscriptionId: 'sub_x' } }));
    assert.equal(second.statusCode, 429);
    assert.match(JSON.parse(second.body).error, /^E6: rate_limited/);
  });
});

test('exceeding MAX_ADMIN_DIAGNOSE_DODO_STATUS_PER_IDENTIFIER_PER_DAY is rejected with 429 E6', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, DODO_API_KEY: FAKE_KEY, MAX_ADMIN_DIAGNOSE_DODO_STATUS_PER_IDENTIFIER_PER_DAY: '1' }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    var h = loadHandlerWith({ retrieve: function () { return Promise.resolve(trialSubscriptionFixture()); } });
    var first = await h.handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: OWNER_EMAIL, password: 'realfounderpw1', subscriptionId: 'sub_TRIAL123' } }));
    assert.equal(first.statusCode, 200);
    var second = await h.handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: OWNER_EMAIL, password: 'realfounderpw1', subscriptionId: 'sub_TRIAL123' } }));
    assert.equal(second.statusCode, 429);
    assert.match(JSON.parse(second.body).error, /^E6: rate_limited/);
  });
});
