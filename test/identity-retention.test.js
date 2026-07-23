// test/identity-retention.test.js
//
// Covers Phase 1 of the identity/retention project (see
// docs/IDENTITY_RETENTION_PROJECT_SPEC.md):
//   - lib/account-store.js's additive phone/phoneConsentAt/
//     pendingReminderSid fields (Section 1.4)
//   - request-magic-link.js / verify-magic-link.js (Section 1.2)
//   - lib/reminder.js's Twilio-gated scheduleReminderForAccount /
//     cancelPendingReminder (Section 1.3), both with TWILIO_* env vars
//     present and absent. lib/reminder.js is a plain module (like
//     lib/account-store.js), not a Netlify Function — a standalone,
//     unauthenticated, un-rate-limited HTTP handler here would have been
//     a real cost/harassment vector (each call creates a new,
//     non-idempotent Twilio scheduled message) with no page in this app
//     ever calling it, so there is deliberately no exports.handler/public
//     endpoint for this piece at all — see that file's header comment.
//   - register-account.js's phone/phoneConsent capture (Section 1.1) and
//     account-login.js's cancel-on-login wiring
// Same patterns as test/password-reset-account.test.js / test/account-
// store.test.js. Run with: node --test test/

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');

var realFetch = global.fetch;

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

var REAL_TWILIO_ENV = {
  TWILIO_ACCOUNT_SID: 'AC_test_sid_1234567890',
  TWILIO_AUTH_TOKEN: 'test_auth_token_1234567890',
  TWILIO_PHONE_NUMBER: '+15551234567'
};
var NO_TWILIO_ENV = {
  TWILIO_ACCOUNT_SID: undefined,
  TWILIO_AUTH_TOKEN: undefined,
  TWILIO_PHONE_NUMBER: undefined
};

/** Fetch spy that branches on URL — Resend vs Twilio — so tests never make a real network call, same convention as test/password-reset-account.test.js's installFetchSpy(). */
function installFetchSpy(opts) {
  opts = opts || {};
  var calls = [];
  global.fetch = async function (url, fetchOpts) {
    var bodyStr = fetchOpts && fetchOpts.body;
    var parsedBody = null;
    if (typeof bodyStr === 'string') {
      try { parsedBody = JSON.parse(bodyStr); } catch (e) { parsedBody = bodyStr; } // Twilio bodies are form-encoded, not JSON
    }
    calls.push({ url: url, method: fetchOpts && fetchOpts.method, body: parsedBody });

    if (typeof url === 'string' && url.indexOf('api.resend.com') !== -1) {
      return { ok: opts.resendOk !== false, status: opts.resendOk !== false ? 200 : 500, json: async function () { return {}; } };
    }
    if (typeof url === 'string' && url.indexOf('api.twilio.com') !== -1) {
      if (url.indexOf('/Messages.json') !== -1) {
        // Schedule call
        return {
          ok: opts.twilioScheduleOk !== false,
          status: opts.twilioScheduleOk !== false ? 201 : 500,
          json: async function () { return opts.twilioScheduleOk !== false ? { sid: opts.sid || 'SM_test_sid_0001' } : { message: 'schedule failed' }; }
        };
      }
      // Cancel call (POST .../Messages/<sid>.json)
      return {
        ok: opts.twilioCancelOk !== false,
        status: opts.twilioCancelOk !== false ? 200 : 400,
        json: async function () { return opts.twilioCancelOk !== false ? { status: 'canceled' } : { message: 'cannot cancel — already sent' }; }
      };
    }
    throw new Error('unexpected fetch to ' + url);
  };
  return calls;
}

function freshModules() {
  [
    '../netlify/functions/request-magic-link',
    '../netlify/functions/verify-magic-link',
    '../netlify/functions/lib/reminder',
    '../netlify/functions/register-account',
    '../netlify/functions/account-login',
    '../netlify/functions/lib/account-store',
    '../netlify/functions/lib/magic-link',
    '../netlify/functions/lib/twilio-client'
  ].forEach(function (m) {
    delete require.cache[require.resolve(m)];
  });
}

test.beforeEach(function () {
  global.fetch = realFetch;
  mockBlobs.reset();
  delete process.env.MAX_REGISTRATIONS_PER_IP_PER_DAY;
  delete process.env.MAX_LOGIN_ATTEMPTS_PER_IP_PER_DAY;
  delete process.env.MAX_LOGIN_ATTEMPTS_PER_IDENTIFIER_PER_DAY;
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_PHONE_NUMBER;
  freshModules();
});
test.after(function () {
  global.fetch = realFetch;
});

var ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return '10.3.0.' + ipCounter;
}

// ===== lib/twilio-client.js: isConfigured() gating =====

test('twilio-client: isConfigured is false with no env vars, false with placeholder-looking values, true only with all three real values', async function () {
  return withEnv(NO_TWILIO_ENV, async function () {
    freshModules();
    var twilioClient = require('../netlify/functions/lib/twilio-client');
    assert.equal(twilioClient.isConfigured(), false, 'unset env vars');

    return withEnv({ TWILIO_ACCOUNT_SID: 'REPLACE_WITH_REAL_SID', TWILIO_AUTH_TOKEN: 'REPLACE_WITH_REAL_TOKEN', TWILIO_PHONE_NUMBER: 'REPLACE_WITH_REAL_NUMBER' }, async function () {
      freshModules();
      var tc2 = require('../netlify/functions/lib/twilio-client');
      assert.equal(tc2.isConfigured(), false, 'placeholder-looking values');

      return withEnv(REAL_TWILIO_ENV, async function () {
        freshModules();
        var tc3 = require('../netlify/functions/lib/twilio-client');
        assert.equal(tc3.isConfigured(), true, 'all three real values');
      });
    });
  });
});

// ===== lib/reminder.js: scheduleReminderForAccount =====

test('reminder: scheduleReminderForAccount skips cleanly (no crash, no fetch) when the account has no phone on file', async function () {
  return withEnv(REAL_TWILIO_ENV, async function () {
    freshModules();
    var scheduleReminder = require('../netlify/functions/lib/reminder');
    var calls = installFetchSpy();
    var result = await scheduleReminder.scheduleReminderForAccount(fakeEvent({ method: 'POST' }), { username: 'nophone', email: 'nophone@example.com' });
    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'no_phone_on_file');
    assert.equal(calls.length, 0);
  });
});

test('reminder: scheduleReminderForAccount skips cleanly (no crash, no fetch) when Twilio env vars are not configured', async function () {
  return withEnv(NO_TWILIO_ENV, async function () {
    freshModules();
    var scheduleReminder = require('../netlify/functions/lib/reminder');
    var calls = installFetchSpy();
    var result = await scheduleReminder.scheduleReminderForAccount(fakeEvent({ method: 'POST' }), { username: 'hasphone', email: 'hasphone@example.com', phone: '+15559990000' });
    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'twilio_not_configured');
    assert.equal(calls.length, 0, 'must never call Twilio (or anything else) when not configured');
  });
});

test('reminder: scheduleReminderForAccount schedules a real SMS and persists the SID when Twilio IS configured', async function () {
  return withEnv(REAL_TWILIO_ENV, async function () {
    freshModules();
    var accountStore = require('../netlify/functions/lib/account-store');
    var scheduleReminder = require('../netlify/functions/lib/reminder');
    var event = fakeEvent({ method: 'POST' });

    var created = await accountStore.createAccount(event, {
      username: 'uma', password: 'realpassword1', email: 'uma@example.com',
      phone: '+15551234567', phoneConsentAt: Date.now()
    });
    assert.equal(created.ok, true);

    var calls = installFetchSpy({ sid: 'SM_uma_reminder' });
    var result = await scheduleReminder.scheduleReminderForAccount(event, created.record);
    assert.equal(result.ok, true);
    assert.equal(result.sid, 'SM_uma_reminder');

    var scheduleCalls = calls.filter(function (c) { return c.url.indexOf('/Messages.json') !== -1; });
    assert.equal(scheduleCalls.length, 1);
    assert.match(scheduleCalls[0].body, /ScheduleType=fixed/);
    // Twilio's body is application/x-www-form-urlencoded, where spaces are
    // encoded as "+" (not "%20") -- decodeURIComponent alone doesn't turn
    // "+" back into a space, so swap those first.
    var decodedBody = decodeURIComponent(scheduleCalls[0].body.replace(/\+/g, ' '));
    assert.match(decodedBody, /come see your dream/i, 'SMS body should use the promotional framing (builder\'s call per spec Section 1.5 — "your call on tone")');
    assert.match(decodedBody, /login\.html\?magic=/, 'SMS body should include a magic-link URL');

    var stored = await accountStore.getByUsername(event, 'uma');
    assert.equal(stored.pendingReminderSid, 'SM_uma_reminder');
  });
});

test('reminder: scheduleReminderForAccount never throws even if Twilio itself fails', async function () {
  return withEnv(REAL_TWILIO_ENV, async function () {
    freshModules();
    var scheduleReminder = require('../netlify/functions/lib/reminder');
    installFetchSpy({ twilioScheduleOk: false });
    var result = await scheduleReminder.scheduleReminderForAccount(fakeEvent({ method: 'POST' }), { username: 'vic', email: 'vic@example.com', phone: '+15551110000' });
    assert.equal(result.ok, true, 'a Twilio failure must never surface as a failure to the signup caller');
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'schedule_failed');
  });
});

// ===== lib/reminder.js: cancelPendingReminder =====

test('reminder: cancelPendingReminder skips cleanly with no pending reminder on file', async function () {
  return withEnv(REAL_TWILIO_ENV, async function () {
    freshModules();
    var scheduleReminder = require('../netlify/functions/lib/reminder');
    var calls = installFetchSpy();
    var result = await scheduleReminder.cancelPendingReminder(fakeEvent({ method: 'POST' }), { username: 'nobody', pendingReminderSid: null });
    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
    assert.equal(calls.length, 0);
  });
});

test('reminder: cancelPendingReminder skips the Twilio API call (but still clears the field) when Twilio is not configured', async function () {
  return withEnv(NO_TWILIO_ENV, async function () {
    freshModules();
    var accountStore = require('../netlify/functions/lib/account-store');
    var scheduleReminder = require('../netlify/functions/lib/reminder');
    var event = fakeEvent({ method: 'POST' });

    var created = await accountStore.createAccount(event, { username: 'wade', password: 'realpassword1', email: 'wade@example.com' });
    await accountStore.setPendingReminderSid(event, 'wade', 'SM_wade_pending');

    var calls = installFetchSpy();
    var result = await scheduleReminder.cancelPendingReminder(event, Object.assign({}, created.record, { pendingReminderSid: 'SM_wade_pending' }));
    assert.equal(result.ok, true);
    assert.equal(calls.length, 0, 'must never call Twilio when not configured');

    var stored = await accountStore.getByUsername(event, 'wade');
    assert.equal(stored.pendingReminderSid, null, 'field should still be cleared locally even with Twilio unconfigured');
  });
});

test('reminder: cancelPendingReminder calls Twilio and clears the field when Twilio IS configured', async function () {
  return withEnv(REAL_TWILIO_ENV, async function () {
    freshModules();
    var accountStore = require('../netlify/functions/lib/account-store');
    var scheduleReminder = require('../netlify/functions/lib/reminder');
    var event = fakeEvent({ method: 'POST' });

    var created = await accountStore.createAccount(event, { username: 'xena', password: 'realpassword1', email: 'xena@example.com' });
    await accountStore.setPendingReminderSid(event, 'xena', 'SM_xena_pending');

    var calls = installFetchSpy();
    var record = Object.assign({}, created.record, { pendingReminderSid: 'SM_xena_pending' });
    var result = await scheduleReminder.cancelPendingReminder(event, record);
    assert.equal(result.ok, true);

    var cancelCalls = calls.filter(function (c) { return c.url.indexOf('/Messages/SM_xena_pending.json') !== -1; });
    assert.equal(cancelCalls.length, 1);

    var stored = await accountStore.getByUsername(event, 'xena');
    assert.equal(stored.pendingReminderSid, null);
  });
});

test('reminder: cancelPendingReminder still clears the field even if Twilio reports the cancel failed (e.g. already sent)', async function () {
  return withEnv(REAL_TWILIO_ENV, async function () {
    freshModules();
    var accountStore = require('../netlify/functions/lib/account-store');
    var scheduleReminder = require('../netlify/functions/lib/reminder');
    var event = fakeEvent({ method: 'POST' });

    var created = await accountStore.createAccount(event, { username: 'yara', password: 'realpassword1', email: 'yara@example.com' });
    await accountStore.setPendingReminderSid(event, 'yara', 'SM_yara_already_sent');

    installFetchSpy({ twilioCancelOk: false });
    var record = Object.assign({}, created.record, { pendingReminderSid: 'SM_yara_already_sent' });
    var result = await scheduleReminder.cancelPendingReminder(event, record);
    assert.equal(result.ok, true, 'a Twilio cancel failure must never surface as a login failure');

    var stored = await accountStore.getByUsername(event, 'yara');
    assert.equal(stored.pendingReminderSid, null, 'field is cleared regardless — this login no longer needs a reminder either way');
  });
});

// ===== account-store.js: additive phone / pendingReminderSid fields =====

test('account-store: createAccount only stores phone/phoneConsentAt when both were explicitly passed', async function () {
  var accountStore = require('../netlify/functions/lib/account-store');
  var event = fakeEvent({ method: 'POST' });

  var withPhone = await accountStore.createAccount(event, { username: 'zoe', password: 'realpassword1', email: 'zoe@example.com', phone: '+15550001111', phoneConsentAt: 12345 });
  assert.equal(withPhone.record.phone, '+15550001111');
  assert.equal(withPhone.record.pendingReminderSid, undefined);

  var withoutPhone = await accountStore.createAccount(event, { username: 'amara', password: 'realpassword1', email: 'amara@example.com' });
  assert.equal(withoutPhone.record.phone, undefined);
  assert.equal(withoutPhone.record.phoneConsentAt, undefined);
});

test('account-store: setPendingReminderSid / clearPendingReminderSid update just that one field, additively', async function () {
  var accountStore = require('../netlify/functions/lib/account-store');
  var event = fakeEvent({ method: 'POST' });
  await accountStore.createAccount(event, { username: 'bram', password: 'realpassword1', email: 'bram@example.com' });

  var set = await accountStore.setPendingReminderSid(event, 'bram', 'SM_bram_1');
  assert.equal(set.ok, true);
  assert.equal(set.record.pendingReminderSid, 'SM_bram_1');
  assert.equal(set.record.email, 'bram@example.com', 'other fields must survive the update');

  var cleared = await accountStore.clearPendingReminderSid(event, 'bram');
  assert.equal(cleared.ok, true);
  assert.equal(cleared.record.pendingReminderSid, null);
});

// ===== register-account.js: phone + consent capture, never blocking signup =====

test('register-account: signup with no phone at all succeeds exactly as before, regardless of whether Twilio is configured', async function () {
  return withEnv(NO_TWILIO_ENV, async function () {
    freshModules();
    var handler = require('../netlify/functions/register-account').handler;
    var accountStore = require('../netlify/functions/lib/account-store');
    var event = fakeEvent({ method: 'POST', ip: nextIp(), body: { username: 'carlos', password: 'realpassword1', email: 'carlos@example.com' } });

    var res = await handler(event);
    var body = JSON.parse(res.body);
    assert.equal(body.ok, true);

    var stored = await accountStore.getByUsername(event, 'carlos');
    assert.equal(stored.phone, undefined);
  });
});

test('register-account: a phone number with consent unchecked is never stored, and signup still succeeds', async function () {
  return withEnv(REAL_TWILIO_ENV, async function () {
    freshModules();
    var handler = require('../netlify/functions/register-account').handler;
    var accountStore = require('../netlify/functions/lib/account-store');
    var event = fakeEvent({ method: 'POST', ip: nextIp(), body: { username: 'dana', password: 'realpassword1', email: 'dana@example.com', phone: '+15552223333', phoneConsent: false } });

    var calls = installFetchSpy();
    var res = await handler(event);
    assert.equal(JSON.parse(res.body).ok, true);

    var stored = await accountStore.getByUsername(event, 'dana');
    assert.equal(stored.phone, undefined, 'phone must not be stored without consent');
    assert.equal(calls.filter(function (c) { return c.url.indexOf('twilio') !== -1; }).length, 0, 'no reminder should ever be scheduled without consent');
  });
});

test('register-account: phone + consent together are stored, and (Twilio not configured) signup succeeds with the reminder cleanly skipped', async function () {
  return withEnv(NO_TWILIO_ENV, async function () {
    freshModules();
    var handler = require('../netlify/functions/register-account').handler;
    var accountStore = require('../netlify/functions/lib/account-store');
    var event = fakeEvent({ method: 'POST', ip: nextIp(), body: { username: 'ellis', password: 'realpassword1', email: 'ellis@example.com', phone: '+15554445555', phoneConsent: true } });

    var res = await handler(event);
    assert.equal(JSON.parse(res.body).ok, true, 'signup must succeed even though Twilio is not configured');

    var stored = await accountStore.getByUsername(event, 'ellis');
    assert.equal(stored.phone, '+15554445555');
    assert.ok(stored.phoneConsentAt);
    assert.equal(stored.pendingReminderSid, undefined, 'no reminder actually got scheduled — Twilio is not configured yet');
  });
});

test('register-account: phone + consent together, with Twilio configured, actually schedules the reminder and stores the SID', async function () {
  return withEnv(REAL_TWILIO_ENV, async function () {
    freshModules();
    var handler = require('../netlify/functions/register-account').handler;
    var accountStore = require('../netlify/functions/lib/account-store');
    var event = fakeEvent({ method: 'POST', ip: nextIp(), body: { username: 'frankie', password: 'realpassword1', email: 'frankie@example.com', phone: '+15556667777', phoneConsent: true } });

    installFetchSpy({ sid: 'SM_frankie_reminder' });
    var res = await handler(event);
    assert.equal(JSON.parse(res.body).ok, true);

    var stored = await accountStore.getByUsername(event, 'frankie');
    assert.equal(stored.pendingReminderSid, 'SM_frankie_reminder');
  });
});

// ===== account-login.js: cancels a pending reminder on real login =====

test('account-login: a successful login cancels a pending reminder (Twilio configured) and clears the field', async function () {
  return withEnv(REAL_TWILIO_ENV, async function () {
    freshModules();
    var accountStore = require('../netlify/functions/lib/account-store');
    var loginHandler = require('../netlify/functions/account-login').handler;
    var event = fakeEvent({ method: 'POST', ip: nextIp() });

    await accountStore.createAccount(event, { username: 'gina', password: 'realpassword1', email: 'gina@example.com' });
    await accountStore.setPendingReminderSid(event, 'gina', 'SM_gina_pending');

    var calls = installFetchSpy();
    var res = await loginHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: 'gina', password: 'realpassword1' } }));
    assert.equal(JSON.parse(res.body).ok, true);

    var cancelCalls = calls.filter(function (c) { return c.url.indexOf('/Messages/SM_gina_pending.json') !== -1; });
    assert.equal(cancelCalls.length, 1);

    var stored = await accountStore.getByUsername(event, 'gina');
    assert.equal(stored.pendingReminderSid, null);
  });
});

test('account-login: a successful login with no pending reminder, and Twilio unconfigured, behaves exactly as before (no crash)', async function () {
  return withEnv(NO_TWILIO_ENV, async function () {
    freshModules();
    var accountStore = require('../netlify/functions/lib/account-store');
    var loginHandler = require('../netlify/functions/account-login').handler;
    var event = fakeEvent({ method: 'POST', ip: nextIp() });

    await accountStore.createAccount(event, { username: 'hank', password: 'realpassword1', email: 'hank@example.com' });

    var res = await loginHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: 'hank', password: 'realpassword1' } }));
    assert.equal(JSON.parse(res.body).ok, true);
  });
});

// ===== request-magic-link.js / verify-magic-link.js =====

var RESEND_KEY = 'resend-test-key';

test('request-magic-link: a registered email gets a real Resend send containing a login link; response is a plain ok:true either way', async function () {
  return withEnv({ RESEND_API_KEY: RESEND_KEY }, async function () {
    freshModules();
    var registerHandler = require('../netlify/functions/register-account').handler;
    await registerHandler(fakeEvent({ method: 'POST', ip: nextIp(), body: { username: 'ivy', password: 'realpassword1', email: 'ivy@example.com' } }));

    var calls = installFetchSpy();
    var handler = require('../netlify/functions/request-magic-link').handler;
    var res = await handler(fakeEvent({ method: 'POST', body: { email: 'Ivy@Example.com' } }));

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true });
    var resendCalls = calls.filter(function (c) { return c.url.indexOf('resend') !== -1; });
    assert.equal(resendCalls.length, 1);
    assert.deepEqual(resendCalls[0].body.to, ['ivy@example.com']);
    assert.match(resendCalls[0].body.html, /login\.html\?magic=/);
  });
});

test('request-magic-link: an email with no matching account sends nothing, but returns the exact same ok:true response (anti-enumeration)', async function () {
  return withEnv({ RESEND_API_KEY: RESEND_KEY }, async function () {
    freshModules();
    var calls = installFetchSpy();
    var handler = require('../netlify/functions/request-magic-link').handler;
    var res = await handler(fakeEvent({ method: 'POST', body: { email: 'nobody-here@example.com' } }));

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true });
    assert.equal(calls.length, 0);
  });
});

test('request-magic-link: rejects missing email, invalid JSON, non-POST methods, and missing RESEND_API_KEY', async function () {
  return withEnv({ RESEND_API_KEY: RESEND_KEY }, async function () {
    freshModules();
    var handler = require('../netlify/functions/request-magic-link').handler;

    var missingEmail = await handler(fakeEvent({ method: 'POST', body: {} }));
    assert.equal(missingEmail.statusCode, 400);
    assert.match(JSON.parse(missingEmail.body).error, /^E3: email_required/);

    var badJson = await handler(fakeEvent({ method: 'POST', body: '{not json' }));
    assert.equal(badJson.statusCode, 400);
    assert.match(JSON.parse(badJson.body).error, /^E2: invalid_json/);

    var wrongMethod = await handler(fakeEvent({ method: 'GET' }));
    assert.equal(wrongMethod.statusCode, 405);
    assert.match(JSON.parse(wrongMethod.body).error, /^E1: method_not_allowed/);
  });
});

test('request-magic-link: rejects every request with a 500 when RESEND_API_KEY is not configured', async function () {
  return withEnv({ RESEND_API_KEY: undefined }, async function () {
    freshModules();
    var handler = require('../netlify/functions/request-magic-link').handler;
    var res = await handler(fakeEvent({ method: 'POST', body: { email: 'anyone@example.com' } }));
    assert.equal(res.statusCode, 500);
    assert.match(JSON.parse(res.body).error, /^E4: missing_api_key/);
  });
});

test('verify-magic-link: a valid token logs the user in and is single-use', async function () {
  return withEnv(NO_TWILIO_ENV, async function () {
    freshModules();
    var accountStore = require('../netlify/functions/lib/account-store');
    var magicLink = require('../netlify/functions/lib/magic-link');
    var event = fakeEvent({ method: 'POST' });

    var created = await accountStore.createAccount(event, { username: 'jules', password: 'realpassword1', email: 'jules@example.com' });
    var token = await magicLink.createToken(event, created.record);

    var handler = require('../netlify/functions/verify-magic-link').handler;
    var res = await handler(fakeEvent({ method: 'POST', body: { token: token } }));
    var body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.username, 'jules');
    assert.equal(body.email, 'jules@example.com');

    var reused = await handler(fakeEvent({ method: 'POST', body: { token: token } }));
    assert.equal(JSON.parse(reused.body).ok, false, 'token must not be reusable');
  });
});

test('verify-magic-link: an invalid/expired token is rejected with E4', async function () {
  var handler = require('../netlify/functions/verify-magic-link').handler;
  var res = await handler(fakeEvent({ method: 'POST', body: { token: 'never-existed-token' } }));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).ok, false);
  assert.match(JSON.parse(res.body).error, /^E4: invalid_or_expired/);
});

test('verify-magic-link: a successful verify also cancels a pending SMS reminder for that account (Twilio configured)', async function () {
  return withEnv(REAL_TWILIO_ENV, async function () {
    freshModules();
    var accountStore = require('../netlify/functions/lib/account-store');
    var magicLink = require('../netlify/functions/lib/magic-link');
    var event = fakeEvent({ method: 'POST' });

    var created = await accountStore.createAccount(event, { username: 'kara', password: 'realpassword1', email: 'kara@example.com' });
    await accountStore.setPendingReminderSid(event, 'kara', 'SM_kara_pending');
    var token = await magicLink.createToken(event, created.record);

    var calls = installFetchSpy();
    var handler = require('../netlify/functions/verify-magic-link').handler;
    var res = await handler(fakeEvent({ method: 'POST', body: { token: token } }));
    assert.equal(JSON.parse(res.body).ok, true);

    var cancelCalls = calls.filter(function (c) { return c.url.indexOf('/Messages/SM_kara_pending.json') !== -1; });
    assert.equal(cancelCalls.length, 1);

    var stored = await accountStore.getByUsername(event, 'kara');
    assert.equal(stored.pendingReminderSid, null);
  });
});

test('verify-magic-link: rejects missing token, invalid JSON, and non-POST methods', async function () {
  var handler = require('../netlify/functions/verify-magic-link').handler;

  var missingToken = await handler(fakeEvent({ method: 'POST', body: {} }));
  assert.equal(missingToken.statusCode, 400);
  assert.match(JSON.parse(missingToken.body).error, /^E3: token_required/);

  var badJson = await handler(fakeEvent({ method: 'POST', body: '{not json' }));
  assert.equal(badJson.statusCode, 400);
  assert.match(JSON.parse(badJson.body).error, /^E2: invalid_json/);

  var wrongMethod = await handler(fakeEvent({ method: 'DELETE' }));
  assert.equal(wrongMethod.statusCode, 405);
  assert.match(JSON.parse(wrongMethod.body).error, /^E1: method_not_allowed/);
});
