// test/unsubscribe-email.test.js
//
// Covers netlify/functions/unsubscribe-email.js end-to-end (tracker item
// for-product-email-redesign-unsubscribe-l-16ysmp): a valid token
// unsubscribes (and idempotently re-unsubscribes), an invalid/tampered
// token is rejected without suppressing anything, and the usual method/
// missing-params error paths.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');

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

var ENV = { UNSUBSCRIBE_TOKEN_SECRET: 'test-unsub-secret' };

test.beforeEach(function () {
  mockBlobs.reset();
  delete require.cache[require.resolve('../netlify/functions/unsubscribe-email')];
  delete require.cache[require.resolve('../netlify/functions/lib/unsubscribe-token')];
  delete require.cache[require.resolve('../netlify/functions/lib/email-suppression-store')];
});

test('unsubscribe-email: a valid token unsubscribes the email -- suppression store reflects it afterward', function () {
  return withEnv(ENV, async function () {
    var unsubscribeToken = require('../netlify/functions/lib/unsubscribe-token');
    var suppressionStore = require('../netlify/functions/lib/email-suppression-store');
    var handler = require('../netlify/functions/unsubscribe-email').handler;

    var event = fakeEvent({ method: 'GET', headers: { host: 'dreamtube1.netlify.app' } });
    var token = unsubscribeToken.signToken('nora@example.com');

    var res = await handler(fakeEvent({ method: 'GET', query: { email: 'nora@example.com', token: token } }));
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /unsubscribed/i);
    assert.equal(await suppressionStore.isSuppressed(event, 'nora@example.com'), true);
  });
});

test('unsubscribe-email: double-unsubscribe is idempotent -- clicking the link again still succeeds, does not error', function () {
  return withEnv(ENV, async function () {
    var unsubscribeToken = require('../netlify/functions/lib/unsubscribe-token');
    var handler = require('../netlify/functions/unsubscribe-email').handler;
    var token = unsubscribeToken.signToken('nora@example.com');

    var first = await handler(fakeEvent({ method: 'GET', query: { email: 'nora@example.com', token: token } }));
    var second = await handler(fakeEvent({ method: 'GET', query: { email: 'nora@example.com', token: token } }));
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
  });
});

test('unsubscribe-email: an invalid/tampered token is rejected, and the email is NOT suppressed', function () {
  return withEnv(ENV, async function () {
    var unsubscribeToken = require('../netlify/functions/lib/unsubscribe-token');
    var suppressionStore = require('../netlify/functions/lib/email-suppression-store');
    var handler = require('../netlify/functions/unsubscribe-email').handler;
    var event = fakeEvent({ method: 'GET' });

    var token = unsubscribeToken.signToken('nora@example.com');
    var tampered = (token[0] === 'a' ? 'b' : 'a') + token.slice(1);

    var res = await handler(fakeEvent({ method: 'GET', query: { email: 'nora@example.com', token: tampered } }));
    assert.equal(res.statusCode, 400);
    assert.match(JSON.stringify(res.body), /invalid/i);
    assert.equal(await suppressionStore.isSuppressed(event, 'nora@example.com'), false, 'a rejected token must never suppress the email');
  });
});

test('unsubscribe-email: a token that is valid for a DIFFERENT email is rejected -- can\'t unsubscribe a victim by knowing only their address', function () {
  return withEnv(ENV, async function () {
    var unsubscribeToken = require('../netlify/functions/lib/unsubscribe-token');
    var suppressionStore = require('../netlify/functions/lib/email-suppression-store');
    var handler = require('../netlify/functions/unsubscribe-email').handler;
    var event = fakeEvent({ method: 'GET' });

    var attackerToken = unsubscribeToken.signToken('attacker@example.com');
    var res = await handler(fakeEvent({ method: 'GET', query: { email: 'victim@example.com', token: attackerToken } }));
    assert.equal(res.statusCode, 400);
    assert.equal(await suppressionStore.isSuppressed(event, 'victim@example.com'), false);
  });
});

test('unsubscribe-email: missing email/token -> E2', function () {
  return withEnv(ENV, async function () {
    var handler = require('../netlify/functions/unsubscribe-email').handler;
    var res = await handler(fakeEvent({ method: 'GET', query: {} }));
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /invalid link/i);
  });
});

test('unsubscribe-email: an unsupported method (neither GET nor the one-click POST) -> E1', async function () {
  var handler = require('../netlify/functions/unsubscribe-email').handler;
  var res = await handler(fakeEvent({ method: 'PUT', query: {} }));
  assert.equal(res.statusCode, 405);
  assert.match(JSON.parse(res.body).error, /^E1/);
});

// RFC 8058 one-click POST (added for the "unwatched dream" retention-nudge
// round) -- a mail client honoring the List-Unsubscribe-Post header sends a
// machine POST (no browser) to the same url; email/token are on the query
// string. It suppresses exactly like GET but returns a minimal JSON 200,
// never the human confirmation page.
test('unsubscribe-email: a valid one-click POST suppresses and returns a minimal JSON 200 (no HTML page)', function () {
  return withEnv(ENV, async function () {
    var unsubscribeToken = require('../netlify/functions/lib/unsubscribe-token');
    var suppressionStore = require('../netlify/functions/lib/email-suppression-store');
    var handler = require('../netlify/functions/unsubscribe-email').handler;

    var token = unsubscribeToken.signToken('oneclick@example.com');
    var res = await handler(fakeEvent({
      method: 'POST',
      query: { email: 'oneclick@example.com', token: token },
      body: 'List-Unsubscribe=One-Click'
    }));
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).ok, true, 'a machine POST gets JSON, not the confirmation HTML');
    assert.equal(await suppressionStore.isSuppressed(fakeEvent({}), 'oneclick@example.com'), true);
  });
});

test('unsubscribe-email: a one-click POST with a bad token is rejected (400) without suppressing', function () {
  return withEnv(ENV, async function () {
    var suppressionStore = require('../netlify/functions/lib/email-suppression-store');
    var handler = require('../netlify/functions/unsubscribe-email').handler;

    var res = await handler(fakeEvent({
      method: 'POST',
      query: { email: 'victim@example.com', token: 'not-the-real-token' },
      body: 'List-Unsubscribe=One-Click'
    }));
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /^E3/);
    assert.equal(await suppressionStore.isSuppressed(fakeEvent({}), 'victim@example.com'), false, 'a bad token must never suppress an arbitrary address');
  });
});
