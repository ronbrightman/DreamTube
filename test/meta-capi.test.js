// test/meta-capi.test.js
//
// Covers netlify/functions/lib/meta-capi.js (the shared sendCapiEvent()
// helper) and netlify/functions/track-conversion.js (the client-facing
// endpoint that wraps it). No real META_CAPI_ACCESS_TOKEN exists in this
// sandbox, so every outbound call to graph.facebook.com is mocked via a
// global.fetch spy — same convention as
// test/generate-video-mock.test.js's installFetchSpy() for fal.ai.
//
// What this suite confirms:
//   - hash() produces a correct, stable SHA-256 hex digest for a known
//     input, lowercased+trimmed first per Meta's spec.
//   - track-conversion.js rejects any event_name outside the fixed
//     CompleteRegistration/InitiateCheckout/Purchase/Subscribe allowlist
//     — this endpoint is not a general-purpose event-forwarding proxy.
//   - the payload actually sent to Meta has the right shape: data: [...],
//     correct field names (event_name, event_time, event_id,
//     action_source, user_data.em/external_id/fbc/fbp, custom_data).
//   - track-conversion.js never leaks META_CAPI_ACCESS_TOKEN in any
//     response body, including on a Meta-side failure or a network
//     failure.
// Run with: node --test test/

var test = require('node:test');
var assert = require('node:assert/strict');
var crypto = require('crypto');

var { fakeEvent } = require('./helpers/fake-event');

var realFetch = global.fetch;
var REAL_TOKEN = 'EAAtest-super-secret-capi-token-12345';

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

/** Spies on global.fetch so tests can assert the exact payload sent to Meta, without ever making a real network call. */
function installFetchSpy(responseBody, ok, status) {
  var calls = [];
  global.fetch = async function (url, opts) {
    calls.push({ url: url, body: opts && opts.body ? JSON.parse(opts.body) : null });
    return {
      ok: ok !== false,
      status: status || (ok !== false ? 200 : 400),
      json: async function () { return responseBody || { events_received: 1 }; }
    };
  };
  return calls;
}

test.beforeEach(function () {
  global.fetch = realFetch;
});
test.after(function () {
  global.fetch = realFetch;
});

// ----- lib/meta-capi.js: hash() -----

test('hash(): known input produces the correct, stable SHA-256 hex digest, lowercased+trimmed first', function () {
  var metaCapi = require('../netlify/functions/lib/meta-capi');
  // Meta's own documented example: sha256("joe@eg.com") after normalization.
  var expected = crypto.createHash('sha256').update('joe@eg.com', 'utf8').digest('hex');
  assert.equal(metaCapi.hash('  Joe@EG.com  '), expected);
  assert.equal(metaCapi.hash('joe@eg.com'), expected);
});

test('hash(): empty/missing input returns null rather than hashing an empty string', function () {
  var metaCapi = require('../netlify/functions/lib/meta-capi');
  assert.equal(metaCapi.hash(''), null);
  assert.equal(metaCapi.hash(null), null);
  assert.equal(metaCapi.hash(undefined), null);
  assert.equal(metaCapi.hash('   '), null);
});

test('hash(): two different-case/whitespace variants of the same email hash identically (dedup requires this)', function () {
  var metaCapi = require('../netlify/functions/lib/meta-capi');
  assert.equal(metaCapi.hash('User@Example.COM'), metaCapi.hash(' user@example.com'));
});

// ----- lib/meta-capi.js: sendCapiEvent() payload shape -----

test('sendCapiEvent(): payload sent to Meta has the documented shape — data: [...], correct field names', function () {
  return withEnv({ META_CAPI_ACCESS_TOKEN: REAL_TOKEN }, async function () {
    var metaCapi = require('../netlify/functions/lib/meta-capi');
    var calls = installFetchSpy();

    var result = await metaCapi.sendCapiEvent({
      event_name: 'CompleteRegistration',
      event_id: 'evt-123',
      event_source_url: 'https://example.com/start.html',
      email: 'Test@Example.com',
      external_id: 'user-42',
      fbc: 'fb.1.1234.abc',
      fbp: 'fb.1.5678.def',
      client_ip_address: '1.2.3.4',
      client_user_agent: 'TestAgent/1.0',
      custom_data: { value: 9.99, currency: 'USD' }
    });

    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);

    assert.match(calls[0].url, /^https:\/\/graph\.facebook\.com\/v21\.0\/2464464964036457\/events\?access_token=/);

    var sent = calls[0].body;
    assert.ok(Array.isArray(sent.data), 'body.data must be an array');
    assert.equal(sent.data.length, 1);

    var evt = sent.data[0];
    assert.equal(evt.event_name, 'CompleteRegistration');
    assert.equal(evt.event_id, 'evt-123');
    assert.equal(evt.action_source, 'website');
    assert.equal(evt.event_source_url, 'https://example.com/start.html');
    assert.equal(typeof evt.event_time, 'number');
    assert.deepEqual(evt.custom_data, { value: 9.99, currency: 'USD' });

    // PII hashed, non-PII sent as-is.
    assert.equal(evt.user_data.em, crypto.createHash('sha256').update('test@example.com', 'utf8').digest('hex'));
    assert.equal(evt.user_data.external_id, crypto.createHash('sha256').update('user-42', 'utf8').digest('hex'));
    assert.equal(evt.user_data.fbc, 'fb.1.1234.abc');
    assert.equal(evt.user_data.fbp, 'fb.1.5678.def');
    assert.equal(evt.user_data.client_ip_address, '1.2.3.4');
    assert.equal(evt.user_data.client_user_agent, 'TestAgent/1.0');

    // Raw email/external_id must never appear anywhere in the outbound body.
    assert.equal(JSON.stringify(sent).indexOf('Test@Example.com'), -1);
    assert.equal(JSON.stringify(sent).indexOf('user-42'), -1);
  });
});

test('sendCapiEvent(): fbc/fbp are passed through unhashed', function () {
  return withEnv({ META_CAPI_ACCESS_TOKEN: REAL_TOKEN }, async function () {
    var metaCapi = require('../netlify/functions/lib/meta-capi');
    var calls = installFetchSpy();
    await metaCapi.sendCapiEvent({ event_name: 'InitiateCheckout', event_id: 'evt-1', fbc: 'raw-fbc-value', fbp: 'raw-fbp-value' });
    assert.equal(calls[0].body.data[0].user_data.fbc, 'raw-fbc-value');
    assert.equal(calls[0].body.data[0].user_data.fbp, 'raw-fbp-value');
  });
});

test('sendCapiEvent(): omitted event_source_url is left out of the payload entirely (e.g. the stripe-webhook.js call site)', function () {
  return withEnv({ META_CAPI_ACCESS_TOKEN: REAL_TOKEN }, async function () {
    var metaCapi = require('../netlify/functions/lib/meta-capi');
    var calls = installFetchSpy();
    await metaCapi.sendCapiEvent({ event_name: 'Purchase', event_id: 'evt-2' });
    assert.equal('event_source_url' in calls[0].body.data[0], false);
  });
});

test('sendCapiEvent(): missing META_CAPI_ACCESS_TOKEN fails without making any network call', function () {
  return withEnv({ META_CAPI_ACCESS_TOKEN: undefined }, async function () {
    var metaCapi = require('../netlify/functions/lib/meta-capi');
    var calls = installFetchSpy();
    var result = await metaCapi.sendCapiEvent({ event_name: 'Purchase', event_id: 'evt-3' });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'missing_access_token');
    assert.equal(calls.length, 0);
  });
});

test('sendCapiEvent(): a non-2xx response from Meta is surfaced as ok:false with the status code', function () {
  return withEnv({ META_CAPI_ACCESS_TOKEN: REAL_TOKEN }, async function () {
    var metaCapi = require('../netlify/functions/lib/meta-capi');
    installFetchSpy({ error: { message: 'Invalid parameter' } }, false, 400);
    var result = await metaCapi.sendCapiEvent({ event_name: 'Purchase', event_id: 'evt-4' });
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 400);
    assert.match(result.error, /Invalid parameter/);
  });
});

test('sendCapiEvent(): a fetch-level network failure is caught, not thrown', function () {
  return withEnv({ META_CAPI_ACCESS_TOKEN: REAL_TOKEN }, async function () {
    var metaCapi = require('../netlify/functions/lib/meta-capi');
    global.fetch = async function () { throw new Error('getaddrinfo ENOTFOUND graph.facebook.com'); };
    var result = await metaCapi.sendCapiEvent({ event_name: 'Purchase', event_id: 'evt-5' });
    assert.equal(result.ok, false);
    assert.match(result.error, /meta_capi_network_failure/);
  });
});

test('sendCapiEvent(): the access token never appears in an error message, even one that echoes the request URL back', function () {
  return withEnv({ META_CAPI_ACCESS_TOKEN: REAL_TOKEN }, async function () {
    var metaCapi = require('../netlify/functions/lib/meta-capi');
    global.fetch = async function (url) {
      throw new Error('request to ' + url + ' failed, reason: connect ETIMEDOUT');
    };
    var result = await metaCapi.sendCapiEvent({ event_name: 'Purchase', event_id: 'evt-6' });
    assert.equal(result.ok, false);
    assert.equal(result.error.indexOf(REAL_TOKEN), -1, 'raw token must not appear in the error message');
    assert.equal(result.error.indexOf(encodeURIComponent(REAL_TOKEN)), -1, 'URI-encoded token must not appear either');
    assert.match(result.error, /\[REDACTED\]/);
  });
});

// ----- track-conversion.js -----

function convEvent(overrides) {
  return fakeEvent({
    method: 'POST',
    body: Object.assign({
      event_name: 'CompleteRegistration',
      event_id: 'evt-abc',
      event_source_url: 'https://example.com/start.html',
      email: 'someone@example.com'
    }, overrides)
  });
}

test('track-conversion.js: rejects an event_name outside the fixed allowlist — not a general-purpose proxy', function () {
  return withEnv({ META_CAPI_ACCESS_TOKEN: REAL_TOKEN }, async function () {
    installFetchSpy();
    var handler = require('../netlify/functions/track-conversion').handler;
    var res = await handler(convEvent({ event_name: 'ViewContent' }));
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /^E4: invalid_event_name/);
  });
});

test('track-conversion.js: accepts each of the four allowed event names', function () {
  return withEnv({ META_CAPI_ACCESS_TOKEN: REAL_TOKEN }, async function () {
    var handler = require('../netlify/functions/track-conversion').handler;
    var names = ['CompleteRegistration', 'InitiateCheckout', 'Purchase', 'Subscribe'];
    for (var i = 0; i < names.length; i++) {
      installFetchSpy();
      var res = await handler(convEvent({ event_name: names[i], event_id: 'evt-' + i }));
      assert.equal(res.statusCode, 200, names[i] + ' should be accepted');
    }
  });
});

test('track-conversion.js: missing event_id or event_source_url is rejected with E5, no Meta call made', function () {
  return withEnv({ META_CAPI_ACCESS_TOKEN: REAL_TOKEN }, async function () {
    var calls = installFetchSpy();
    var handler = require('../netlify/functions/track-conversion').handler;
    var res = await handler(convEvent({ event_id: '' }));
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /^E5:/);
    assert.equal(calls.length, 0);
  });
});

test('track-conversion.js: missing METATOKEN env fails E2 before touching the request body', function () {
  return withEnv({ META_CAPI_ACCESS_TOKEN: undefined }, async function () {
    var calls = installFetchSpy();
    var handler = require('../netlify/functions/track-conversion').handler;
    var res = await handler(convEvent({}));
    assert.equal(res.statusCode, 500);
    assert.match(JSON.parse(res.body).error, /^E2: missing_access_token/);
    assert.equal(calls.length, 0);
  });
});

test('track-conversion.js: invalid JSON body is rejected E3', function () {
  return withEnv({ META_CAPI_ACCESS_TOKEN: REAL_TOKEN }, async function () {
    var handler = require('../netlify/functions/track-conversion').handler;
    var res = await handler(fakeEvent({ method: 'POST', body: 'not json' }));
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /^E3: invalid_json/);
  });
});

test('track-conversion.js: wrong HTTP method rejected E1', function () {
  return withEnv({ META_CAPI_ACCESS_TOKEN: REAL_TOKEN }, async function () {
    var handler = require('../netlify/functions/track-conversion').handler;
    var res = await handler(fakeEvent({ method: 'GET' }));
    assert.equal(res.statusCode, 405);
    assert.match(JSON.parse(res.body).error, /^E1: method_not_allowed/);
  });
});

test('track-conversion.js: pulls client IP/UA from request headers, not the body, and forwards them to Meta', function () {
  return withEnv({ META_CAPI_ACCESS_TOKEN: REAL_TOKEN }, async function () {
    var calls = installFetchSpy();
    var handler = require('../netlify/functions/track-conversion').handler;
    var event = convEvent({});
    event.headers['x-nf-client-connection-ip'] = '9.9.9.9';
    event.headers['user-agent'] = 'RealUA/1.0';
    await handler(event);
    assert.equal(calls[0].body.data[0].user_data.client_ip_address, '9.9.9.9');
    assert.equal(calls[0].body.data[0].user_data.client_user_agent, 'RealUA/1.0');
  });
});

test('track-conversion.js: never leaks the access token in a successful response body', function () {
  return withEnv({ META_CAPI_ACCESS_TOKEN: REAL_TOKEN }, async function () {
    installFetchSpy();
    var handler = require('../netlify/functions/track-conversion').handler;
    var res = await handler(convEvent({}));
    assert.equal(res.body.indexOf(REAL_TOKEN), -1);
  });
});

test('track-conversion.js: never leaks the access token when Meta itself rejects the event', function () {
  return withEnv({ META_CAPI_ACCESS_TOKEN: REAL_TOKEN }, async function () {
    installFetchSpy({ error: { message: 'Invalid access token' } }, false, 401);
    var handler = require('../netlify/functions/track-conversion').handler;
    var res = await handler(convEvent({}));
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.indexOf(REAL_TOKEN), -1);
    assert.equal(res.body.indexOf(encodeURIComponent(REAL_TOKEN)), -1);
  });
});

test('track-conversion.js: never leaks the access token on a network-level failure that echoes the request URL', function () {
  return withEnv({ META_CAPI_ACCESS_TOKEN: REAL_TOKEN }, async function () {
    global.fetch = async function (url) { throw new Error('request to ' + url + ' failed'); };
    var handler = require('../netlify/functions/track-conversion').handler;
    var res = await handler(convEvent({}));
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.indexOf(REAL_TOKEN), -1);
    assert.equal(res.body.indexOf(encodeURIComponent(REAL_TOKEN)), -1);
  });
});
