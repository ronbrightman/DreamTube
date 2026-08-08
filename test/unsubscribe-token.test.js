// test/unsubscribe-token.test.js
//
// Covers netlify/functions/lib/unsubscribe-token.js (tracker item
// for-product-email-redesign-unsubscribe-l-16ysmp) — the stateless,
// per-email HMAC token gating netlify/functions/unsubscribe-email.js.

var test = require('node:test');
var assert = require('node:assert/strict');

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

test('unsubscribe-token: signToken is deterministic -- the same email always produces the same token', function () {
  return withEnv(ENV, function () {
    var unsubscribeToken = require('../netlify/functions/lib/unsubscribe-token');
    var a = unsubscribeToken.signToken('nora@example.com');
    var b = unsubscribeToken.signToken('nora@example.com');
    assert.equal(a, b);
    assert.equal(typeof a, 'string');
    assert.ok(a.length > 0);
  });
});

test('unsubscribe-token: normalizes case/whitespace before signing -- equivalent emails produce the same token', function () {
  return withEnv(ENV, function () {
    var unsubscribeToken = require('../netlify/functions/lib/unsubscribe-token');
    assert.equal(unsubscribeToken.signToken('  Nora@Example.COM  '), unsubscribeToken.signToken('nora@example.com'));
  });
});

test('unsubscribe-token: verifyToken accepts a real token for the email it was signed for', function () {
  return withEnv(ENV, function () {
    var unsubscribeToken = require('../netlify/functions/lib/unsubscribe-token');
    var token = unsubscribeToken.signToken('nora@example.com');
    assert.equal(unsubscribeToken.verifyToken('nora@example.com', token), true);
    // Case/whitespace-insensitive on the verify side too, same normalization.
    assert.equal(unsubscribeToken.verifyToken('  NORA@EXAMPLE.com', token), true);
  });
});

test('unsubscribe-token: a token minted for one email is rejected for a DIFFERENT email -- knowing an address alone is never enough', function () {
  return withEnv(ENV, function () {
    var unsubscribeToken = require('../netlify/functions/lib/unsubscribe-token');
    var token = unsubscribeToken.signToken('nora@example.com');
    assert.equal(unsubscribeToken.verifyToken('attacker-victim@example.com', token), false);
  });
});

test('unsubscribe-token: a tampered (single-character-flipped) token is rejected', function () {
  return withEnv(ENV, function () {
    var unsubscribeToken = require('../netlify/functions/lib/unsubscribe-token');
    var token = unsubscribeToken.signToken('nora@example.com');
    var tampered = (token[0] === 'a' ? 'b' : 'a') + token.slice(1);
    assert.equal(unsubscribeToken.verifyToken('nora@example.com', tampered), false);
  });
});

test('unsubscribe-token: missing/empty/garbage tokens are rejected, never throw', function () {
  return withEnv(ENV, function () {
    var unsubscribeToken = require('../netlify/functions/lib/unsubscribe-token');
    assert.equal(unsubscribeToken.verifyToken('nora@example.com', ''), false);
    assert.equal(unsubscribeToken.verifyToken('nora@example.com', null), false);
    assert.equal(unsubscribeToken.verifyToken('nora@example.com', 'not-a-real-token'), false);
  });
});

test('unsubscribe-token: a DIFFERENT secret produces a different token for the same email (real signing, not a stub)', function () {
  return withEnv({ UNSUBSCRIBE_TOKEN_SECRET: 'secret-one' }, function () {
    var unsubscribeToken = require('../netlify/functions/lib/unsubscribe-token');
    var tokenOne = unsubscribeToken.signToken('nora@example.com');
    return withEnv({ UNSUBSCRIBE_TOKEN_SECRET: 'secret-two' }, function () {
      var tokenTwo = unsubscribeToken.signToken('nora@example.com');
      assert.notEqual(tokenOne, tokenTwo);
    });
  });
});

test('unsubscribe-token: works with no UNSUBSCRIBE_TOKEN_SECRET configured at all (falls back gracefully rather than breaking the mechanism)', function () {
  return withEnv({ UNSUBSCRIBE_TOKEN_SECRET: undefined, RESEND_API_KEY: undefined }, function () {
    var unsubscribeToken = require('../netlify/functions/lib/unsubscribe-token');
    var token = unsubscribeToken.signToken('nora@example.com');
    assert.ok(token.length > 0);
    assert.equal(unsubscribeToken.verifyToken('nora@example.com', token), true);
  });
});

test('unsubscribe-token: buildUnsubscribeUrl builds a working, self-consistent link', function () {
  return withEnv(ENV, function () {
    var unsubscribeToken = require('../netlify/functions/lib/unsubscribe-token');
    var event = fakeEvent({ method: 'GET', headers: { host: 'dreamtube1.netlify.app' } });
    var url = unsubscribeToken.buildUnsubscribeUrl(event, 'Nora@Example.com');
    assert.match(url, /^https:\/\/dreamtube\.life\/\.netlify\/functions\/unsubscribe-email\?email=nora%40example\.com&token=[0-9a-f]{64}$/);

    var params = new URL(url).searchParams;
    assert.equal(unsubscribeToken.verifyToken(params.get('email'), params.get('token')), true);
  });
});
