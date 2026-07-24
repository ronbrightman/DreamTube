// test/support-feedback.test.js
//
// Covers the new Settings support/feedback flow (tracker.html's
// support-and-feedback-atms4a item):
//   - submit-support-message.js: validation, the Resend send (mocked, same
//     spy pattern as test/password-reset-account.test.js), persistence to
//     lib/support-store.js, the account-store email-resolution defense-in-
//     depth, and per-IP rate limiting.
//   - get-support-messages.js: owner-only read.
// Run with: node --test test/

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');

var realFetch = global.fetch;
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

/** Spies on global.fetch (Resend) so tests never make a real network call — same convention as test/password-reset-account.test.js's installFetchSpy(). */
function installFetchSpy(ok) {
  var calls = [];
  global.fetch = async function (url, opts) {
    calls.push({ url: url, body: opts && opts.body ? JSON.parse(opts.body) : null });
    return { ok: ok !== false, status: ok !== false ? 200 : 500, json: async function () { return {}; } };
  };
  return calls;
}

test.beforeEach(function () {
  global.fetch = realFetch;
  mockBlobs.reset();
  delete require.cache[require.resolve('../netlify/functions/submit-support-message')];
  delete require.cache[require.resolve('../netlify/functions/get-support-messages')];
  delete require.cache[require.resolve('../netlify/functions/register-account')];
  delete require.cache[require.resolve('../netlify/functions/lib/account-store')];
  delete require.cache[require.resolve('../netlify/functions/lib/support-store')];
  delete require.cache[require.resolve('../netlify/functions/lib/rate-limit')];
});
test.after(function () {
  global.fetch = realFetch;
});

var ENV = { RESEND_API_KEY: 'resend-test-key', OWNER_EMAIL: OWNER_EMAIL };

// ===== submit-support-message.js =====

test('submit-support-message: a real registered account gets emailed to the owner (reply-to the user) and persisted', function () {
  return withEnv(ENV, async function () {
    var registerHandler = require('../netlify/functions/register-account').handler;
    await registerHandler(fakeEvent({ method: 'POST', body: { username: 'nora', password: 'realpassword1', email: 'nora@example.com' } }));

    var sentCalls = installFetchSpy(true);
    var handler = require('../netlify/functions/submit-support-message').handler;
    var res = await handler(fakeEvent({
      method: 'POST',
      ip: '1.1.1.1',
      body: { type: 'support', username: 'nora', message: 'My video keeps failing.', videoCount: 3, daysSinceSignup: 5 }
    }));

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true });

    assert.equal(sentCalls.length, 1);
    assert.deepEqual(sentCalls[0].body.to, [OWNER_EMAIL]);
    assert.equal(sentCalls[0].body.reply_to, 'nora@example.com');
    assert.match(sentCalls[0].body.subject, /Support/);
    assert.match(sentCalls[0].body.html, /My video keeps failing\./);

    var supportStore = require('../netlify/functions/lib/support-store');
    var messages = await supportStore.getMessages(fakeEvent({ method: 'GET' }));
    assert.equal(messages.length, 1);
    assert.equal(messages[0].username, 'nora');
    assert.equal(messages[0].email, 'nora@example.com');
    assert.equal(messages[0].type, 'support');
    assert.equal(messages[0].videoCount, 3);
    assert.equal(messages[0].daysSinceSignup, 5);
    assert.ok(messages[0].id);
    assert.ok(messages[0].submittedAt);
  });
});

test('submit-support-message: feedback type is tagged distinctly in the email subject and the persisted record', function () {
  return withEnv(ENV, async function () {
    var registerHandler = require('../netlify/functions/register-account').handler;
    await registerHandler(fakeEvent({ method: 'POST', body: { username: 'priya', password: 'realpassword1', email: 'priya@example.com' } }));

    var sentCalls = installFetchSpy(true);
    var handler = require('../netlify/functions/submit-support-message').handler;
    var res = await handler(fakeEvent({
      method: 'POST',
      ip: '2.2.2.2',
      body: { type: 'feedback', username: 'priya', message: 'Love the app, wish styles had more variety.' }
    }));

    assert.equal(res.statusCode, 200);
    assert.match(sentCalls[0].body.subject, /Feedback/);

    var supportStore = require('../netlify/functions/lib/support-store');
    var messages = await supportStore.getMessages(fakeEvent({ method: 'GET' }));
    assert.equal(messages[0].type, 'feedback');
    // Optional context omitted by the client -> stored as null, not fabricated.
    assert.equal(messages[0].videoCount, null);
    assert.equal(messages[0].daysSinceSignup, null);
  });
});

test('submit-support-message: server-side account email wins over a spoofed client-supplied email for a real username (defense in depth)', function () {
  return withEnv(ENV, async function () {
    var registerHandler = require('../netlify/functions/register-account').handler;
    await registerHandler(fakeEvent({ method: 'POST', body: { username: 'oscar', password: 'realpassword1', email: 'oscar-real@example.com' } }));

    var sentCalls = installFetchSpy(true);
    var handler = require('../netlify/functions/submit-support-message').handler;
    await handler(fakeEvent({
      method: 'POST',
      ip: '3.3.3.3',
      body: { type: 'support', username: 'oscar', email: 'attacker-supplied@example.com', message: 'hello' }
    }));

    assert.equal(sentCalls[0].body.reply_to, 'oscar-real@example.com');
  });
});

test('submit-support-message: a username with no server-side account record falls back to the client-supplied email (legacy local-only account)', function () {
  return withEnv(ENV, async function () {
    var sentCalls = installFetchSpy(true);
    var handler = require('../netlify/functions/submit-support-message').handler;
    var res = await handler(fakeEvent({
      method: 'POST',
      ip: '4.4.4.4',
      body: { type: 'support', username: 'legacyuser', email: 'legacy@example.com', message: 'still here' }
    }));
    assert.equal(res.statusCode, 200);
    assert.equal(sentCalls[0].body.reply_to, 'legacy@example.com');
  });
});

test('submit-support-message: message is still persisted even with no usable email at all rejected as E5, and nothing sent without RESEND_API_KEY/OWNER_EMAIL', function () {
  return withEnv({ RESEND_API_KEY: undefined, OWNER_EMAIL: undefined }, async function () {
    var sentCalls = installFetchSpy(true);
    var handler = require('../netlify/functions/submit-support-message').handler;
    var res = await handler(fakeEvent({
      method: 'POST',
      ip: '5.5.5.5',
      body: { type: 'support', username: 'noemailuser', email: 'anon@example.com', message: 'test' }
    }));
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true });
    assert.equal(sentCalls.length, 0, 'no Resend call should be attempted without config');

    var supportStore = require('../netlify/functions/lib/support-store');
    var messages = await supportStore.getMessages(fakeEvent({ method: 'GET' }));
    assert.equal(messages.length, 1, 'the message must still be persisted even though nothing was emailed');
  });
});

test('submit-support-message: rejects missing username/message, bad type, an over-length message, invalid JSON, and non-POST methods', function () {
  return withEnv(ENV, async function () {
    var handler = require('../netlify/functions/submit-support-message').handler;

    var badType = await handler(fakeEvent({ method: 'POST', ip: '6.6.6.1', body: { type: 'nonsense', username: 'a', message: 'hi' } }));
    assert.equal(badType.statusCode, 400);
    assert.match(JSON.parse(badType.body).error, /^E3: invalid_type/);

    var noUsername = await handler(fakeEvent({ method: 'POST', ip: '6.6.6.2', body: { type: 'support', message: 'hi' } }));
    assert.equal(noUsername.statusCode, 400);
    assert.match(JSON.parse(noUsername.body).error, /^E4: username_required/);

    var noMessage = await handler(fakeEvent({ method: 'POST', ip: '6.6.6.3', body: { type: 'support', username: 'a', email: 'a@example.com' } }));
    assert.equal(noMessage.statusCode, 400);
    assert.match(JSON.parse(noMessage.body).error, /^E6: message_required/);

    var tooLong = await handler(fakeEvent({ method: 'POST', ip: '6.6.6.4', body: { type: 'support', username: 'a', email: 'a@example.com', message: 'x'.repeat(4001) } }));
    assert.equal(tooLong.statusCode, 400);
    assert.match(JSON.parse(tooLong.body).error, /^E7: message_too_long/);

    var noEmailAtAll = await handler(fakeEvent({ method: 'POST', ip: '6.6.6.5', body: { type: 'support', username: 'nobodyregistered', message: 'hi' } }));
    assert.equal(noEmailAtAll.statusCode, 400);
    assert.match(JSON.parse(noEmailAtAll.body).error, /^E5: email_required/);

    var badJson = await handler(fakeEvent({ method: 'POST', ip: '6.6.6.6', body: '{not json' }));
    assert.equal(badJson.statusCode, 400);
    assert.match(JSON.parse(badJson.body).error, /^E2: invalid_json/);

    var wrongMethod = await handler(fakeEvent({ method: 'GET' }));
    assert.equal(wrongMethod.statusCode, 405);
    assert.match(JSON.parse(wrongMethod.body).error, /^E1: method_not_allowed/);
  });
});

test('submit-support-message: per-IP daily cap rejects further submissions with 429/E8 once exceeded', function () {
  return withEnv(Object.assign({ MAX_SUPPORT_MESSAGES_PER_IP_PER_DAY: '2' }, ENV), async function () {
    installFetchSpy(true);
    var handler = require('../netlify/functions/submit-support-message').handler;
    var ip = '7.7.7.7';
    var body = { type: 'support', username: 'capped', email: 'capped@example.com', message: 'hi' };

    var first = await handler(fakeEvent({ method: 'POST', ip: ip, body: body }));
    assert.equal(first.statusCode, 200);
    var second = await handler(fakeEvent({ method: 'POST', ip: ip, body: body }));
    assert.equal(second.statusCode, 200);
    var third = await handler(fakeEvent({ method: 'POST', ip: ip, body: body }));
    assert.equal(third.statusCode, 429);
    assert.match(JSON.parse(third.body).error, /^E8: rate_limited/);
  });
});

// ===== get-support-messages.js =====

test('get-support-messages: the owner can read back everything submitted; a non-owner (or no email) is forbidden', function () {
  return withEnv(ENV, async function () {
    installFetchSpy(true);
    var submitHandler = require('../netlify/functions/submit-support-message').handler;
    await submitHandler(fakeEvent({ method: 'POST', ip: '8.8.8.1', body: { type: 'support', username: 'reader-test', email: 'reader@example.com', message: 'read me back' } }));

    var getHandler = require('../netlify/functions/get-support-messages').handler;

    var ownerRes = await getHandler(fakeEvent({ method: 'GET', query: { email: ' Founder@DreamTube.example ' } }));
    assert.equal(ownerRes.statusCode, 200);
    var ownerBody = JSON.parse(ownerRes.body);
    assert.equal(ownerBody.messages.length, 1);
    assert.equal(ownerBody.messages[0].message, 'read me back');

    var strangerRes = await getHandler(fakeEvent({ method: 'GET', query: { email: 'someone-else@example.com' } }));
    assert.equal(strangerRes.statusCode, 403);
    assert.match(JSON.parse(strangerRes.body).error, /^E3: forbidden/);

    var noEmailRes = await getHandler(fakeEvent({ method: 'GET' }));
    assert.equal(noEmailRes.statusCode, 403);
  });
});

test('get-support-messages: rejects with 500 when OWNER_EMAIL is not configured, and 405 on a non-GET method', function () {
  return withEnv({ OWNER_EMAIL: undefined }, async function () {
    var getHandler = require('../netlify/functions/get-support-messages').handler;
    var res = await getHandler(fakeEvent({ method: 'GET', query: { email: 'anyone@example.com' } }));
    assert.equal(res.statusCode, 500);
    assert.match(JSON.parse(res.body).error, /^E2: missing_owner_email/);
  });
});

test('get-support-messages: rejects a non-GET method with 405', function () {
  return withEnv(ENV, async function () {
    var getHandler = require('../netlify/functions/get-support-messages').handler;
    var res = await getHandler(fakeEvent({ method: 'POST', body: {} }));
    assert.equal(res.statusCode, 405);
    assert.match(JSON.parse(res.body).error, /^E1: method_not_allowed/);
  });
});
