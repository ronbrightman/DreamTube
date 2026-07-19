// test/admin-paywall-toggle.test.js
//
// Covers netlify/functions/admin-paywall-toggle.js: reading the effective
// state, the owner-only write (and its 403 for anyone else), and that a
// bad/missing `enabled` value is rejected before ever touching Blobs.
// Run with: node --test test/

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');

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
  delete require.cache[require.resolve('../netlify/functions/admin-paywall-toggle')];
});

test('GET with no override yet falls back to PAYWALL_ENABLED env var (off by default)', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, PAYWALL_ENABLED: undefined }, async function () {
    var handler = require('../netlify/functions/admin-paywall-toggle').handler;
    var res = await handler(fakeEvent({ method: 'GET' }));
    assert.equal(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.equal(body.enabled, false);
    assert.equal(body.source, 'env-default');
  });
});

test('GET reflects PAYWALL_ENABLED="true" when no override has been set', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, PAYWALL_ENABLED: 'true' }, async function () {
    var handler = require('../netlify/functions/admin-paywall-toggle').handler;
    var res = await handler(fakeEvent({ method: 'GET' }));
    var body = JSON.parse(res.body);
    assert.equal(body.enabled, true);
    assert.equal(body.source, 'env-default');
  });
});

test('GET ?email=<owner> reports isOwner true; a random email reports false', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var handler = require('../netlify/functions/admin-paywall-toggle').handler;

    var ownerRes = await handler(fakeEvent({ method: 'GET', query: { email: ' Founder@DreamTube.example ' } }));
    assert.equal(JSON.parse(ownerRes.body).isOwner, true);

    var strangerRes = await handler(fakeEvent({ method: 'GET', query: { email: 'someone-else@example.com' } }));
    assert.equal(JSON.parse(strangerRes.body).isOwner, false);
  });
});

test('POST from the owner sets the override and GET reflects it immediately', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, PAYWALL_ENABLED: undefined }, async function () {
    var handler = require('../netlify/functions/admin-paywall-toggle').handler;

    var postRes = await handler(fakeEvent({
      method: 'POST',
      body: { enabled: true, email: OWNER_EMAIL }
    }));
    assert.equal(postRes.statusCode, 200);
    var postBody = JSON.parse(postRes.body);
    assert.equal(postBody.enabled, true);
    assert.equal(postBody.source, 'override');

    var getRes = await handler(fakeEvent({ method: 'GET' }));
    var getBody = JSON.parse(getRes.body);
    assert.equal(getBody.enabled, true);
    assert.equal(getBody.source, 'override');
  });
});

test('POST override wins over PAYWALL_ENABLED even when they disagree', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, PAYWALL_ENABLED: 'true' }, async function () {
    var handler = require('../netlify/functions/admin-paywall-toggle').handler;

    await handler(fakeEvent({ method: 'POST', body: { enabled: false, email: OWNER_EMAIL } }));
    var getRes = await handler(fakeEvent({ method: 'GET' }));
    var getBody = JSON.parse(getRes.body);
    // Env var says "true", but the explicit override (false) must win.
    assert.equal(getBody.enabled, false);
    assert.equal(getBody.source, 'override');
  });
});

test('POST from a non-owner email is rejected with 403 and does not write anything', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, PAYWALL_ENABLED: undefined }, async function () {
    var handler = require('../netlify/functions/admin-paywall-toggle').handler;

    var res = await handler(fakeEvent({
      method: 'POST',
      body: { enabled: true, email: 'not-the-owner@example.com' }
    }));
    assert.equal(res.statusCode, 403);
    assert.match(JSON.parse(res.body).error, /^E5: forbidden/);

    // Confirm nothing was actually written — GET still falls back to env-default.
    var getRes = await handler(fakeEvent({ method: 'GET' }));
    assert.equal(JSON.parse(getRes.body).source, 'env-default');
  });
});

test('POST with a missing email is rejected with 403, same as a wrong one', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var handler = require('../netlify/functions/admin-paywall-toggle').handler;
    var res = await handler(fakeEvent({ method: 'POST', body: { enabled: true } }));
    assert.equal(res.statusCode, 403);
  });
});

test('POST with a non-boolean `enabled` is rejected with 400 before the owner check even matters', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var handler = require('../netlify/functions/admin-paywall-toggle').handler;
    var res = await handler(fakeEvent({ method: 'POST', body: { enabled: 'true', email: OWNER_EMAIL } }));
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /^E4: enabled_must_be_boolean/);
  });
});

test('POST is rejected with 500 when OWNER_EMAIL is not configured at all', function () {
  return withEnv({ OWNER_EMAIL: undefined }, async function () {
    var handler = require('../netlify/functions/admin-paywall-toggle').handler;
    var res = await handler(fakeEvent({ method: 'POST', body: { enabled: true, email: 'anyone@example.com' } }));
    assert.equal(res.statusCode, 500);
    assert.match(JSON.parse(res.body).error, /^E2: missing_owner_email/);
  });
});

test('unsupported method is rejected with 405', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var handler = require('../netlify/functions/admin-paywall-toggle').handler;
    var res = await handler(fakeEvent({ method: 'DELETE' }));
    assert.equal(res.statusCode, 405);
  });
});
