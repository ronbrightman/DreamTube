// test/admin-submit-whatsapp-template.test.js
//
// Covers netlify/functions/admin-submit-whatsapp-template.js -- the
// one-off, deliberately-triggered tool that submits the Morning Capture
// Ritual's WhatsApp message template to Meta's Graph API for approval
// (tracker item for-product-build-whatsapp-morning-captu-skez3n, step 1
// of the template-submission + sender-wiring follow-up round).
//
// Every Graph API call is mocked (global.fetch stub, same convention as
// test/send-whatsapp-morning-capture.test.js) -- this sandbox has no real
// egress to graph.facebook.com, and even if it did, submitting the real
// template is a deliberate manual step for Manager/Ron, not something a
// test run should ever actually do.
//
// Run with: node --test test/

var test = require('node:test');
var assert = require('node:assert/strict');

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

var BASE_ENV = {
  OWNER_EMAIL: OWNER_EMAIL,
  WHATSAPP_ACCESS_TOKEN: 'test-access-token',
  WHATSAPP_WABA_ID: '1261409435841617',
  WHATSAPP_TEMPLATE_NAME_MORNING_CAPTURE: 'morning_capture_v1'
};

test.beforeEach(function () {
  delete require.cache[require.resolve('../netlify/functions/admin-submit-whatsapp-template')];
  global.fetch = async function (url) {
    throw new Error('unexpected real network call in a test: ' + String(url));
  };
});

test.after(function () {
  global.fetch = realFetch;
});

function stubFetchCapture(responseBody, status) {
  var captured = { calls: [] };
  global.fetch = async function (url, init) {
    captured.calls.push({ url: url, init: init });
    return new Response(JSON.stringify(responseBody || { id: '123456789', status: 'PENDING', category: 'MARKETING' }), {
      status: status || 200,
      headers: { 'content-type': 'application/json' }
    });
  };
  return captured;
}

function stubFetchError(status, body) {
  global.fetch = async function () {
    return new Response(JSON.stringify(body || { error: { message: 'Invalid parameter', code: 100 } }), {
      status: status || 400,
      headers: { 'content-type': 'application/json' }
    });
  };
}

// ===========================================================================
// buildTemplatePayload -- the exact shape submitted to Meta
// ===========================================================================

test('buildTemplatePayload matches Meta\'s documented Message Templates create shape, using the founder-drafted copy verbatim', function () {
  return withEnv(BASE_ENV, function () {
    var mod = require('../netlify/functions/admin-submit-whatsapp-template');
    var payload = mod.buildTemplatePayload();

    assert.equal(payload.name, 'morning_capture_v1');
    assert.equal(payload.language, 'en_US');
    assert.equal(payload.category, 'MARKETING');
    assert.equal(payload.components.length, 2);

    var body = payload.components[0];
    assert.equal(body.type, 'BODY');
    assert.equal(body.text, 'Good morning {{1}} — what did you dream? It\'s already fading. Tap below and just speak it.');

    var buttons = payload.components[1];
    assert.equal(buttons.type, 'BUTTONS');
    assert.equal(buttons.buttons.length, 2);
    assert.equal(buttons.buttons[0].type, 'QUICK_REPLY');
    assert.equal(buttons.buttons[0].text, 'Speak');
    assert.equal(buttons.buttons[1].type, 'QUICK_REPLY');
    assert.equal(buttons.buttons[1].text, 'No recall');
  });
});

test('buildTemplatePayload falls back to a fixed default template name when the env var is unset', function () {
  return withEnv(Object.assign({}, BASE_ENV, { WHATSAPP_TEMPLATE_NAME_MORNING_CAPTURE: undefined }), function () {
    var mod = require('../netlify/functions/admin-submit-whatsapp-template');
    assert.equal(mod.buildTemplatePayload().name, 'morning_capture_v1');
  });
});

// ===========================================================================
// GET -- non-mutating preview, no auth required
// ===========================================================================

test('GET returns a preview payload and configured:true when both env vars are set, without ever calling fetch', function () {
  return withEnv(BASE_ENV, async function () {
    var handler = require('../netlify/functions/admin-submit-whatsapp-template').handler;
    var res = await handler(fakeEvent({ method: 'GET' }));
    assert.equal(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.configured, true);
    assert.deepEqual(body.missing, []);
    assert.equal(body.wouldSubmit.name, 'morning_capture_v1');
    assert.equal(body.wouldSubmit.category, 'MARKETING');
  });
});

test('GET reports exactly which config is missing, without erroring', function () {
  return withEnv(Object.assign({}, BASE_ENV, { WHATSAPP_ACCESS_TOKEN: undefined, WHATSAPP_WABA_ID: undefined }), async function () {
    var handler = require('../netlify/functions/admin-submit-whatsapp-template').handler;
    var res = await handler(fakeEvent({ method: 'GET' }));
    assert.equal(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.configured, false);
    assert.deepEqual(body.missing.sort(), ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_WABA_ID']);
  });
});

test('GET requires no email/auth at all (never a mutation, never a secret in the response)', function () {
  return withEnv(BASE_ENV, async function () {
    var handler = require('../netlify/functions/admin-submit-whatsapp-template').handler;
    var res = await handler(fakeEvent({ method: 'GET' }));
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.stringify(res.body).indexOf('test-access-token'), -1, 'the GET response must never leak the access token');
  });
});

// ===========================================================================
// POST -- real submission, owner-gated
// ===========================================================================

test('POST with no OWNER_EMAIL configured refuses before checking anything else', function () {
  return withEnv(Object.assign({}, BASE_ENV, { OWNER_EMAIL: undefined }), async function () {
    var handler = require('../netlify/functions/admin-submit-whatsapp-template').handler;
    var res = await handler(fakeEvent({ method: 'POST', body: { email: OWNER_EMAIL } }));
    assert.equal(res.statusCode, 500);
    assert.match(JSON.parse(res.body).error, /E2/);
  });
});

test('POST rejects a caller whose email does not match OWNER_EMAIL, never calls fetch', function () {
  return withEnv(BASE_ENV, async function () {
    var handler = require('../netlify/functions/admin-submit-whatsapp-template').handler;
    var res = await handler(fakeEvent({ method: 'POST', body: { email: 'not-the-owner@example.com' } }));
    assert.equal(res.statusCode, 403);
    assert.match(JSON.parse(res.body).error, /E4/);
  });
});

test('POST rejects a missing email the same way as a wrong one', function () {
  return withEnv(BASE_ENV, async function () {
    var handler = require('../netlify/functions/admin-submit-whatsapp-template').handler;
    var res = await handler(fakeEvent({ method: 'POST', body: {} }));
    assert.equal(res.statusCode, 403);
    assert.match(JSON.parse(res.body).error, /E4/);
  });
});

test('POST rejects invalid JSON', function () {
  return withEnv(BASE_ENV, async function () {
    var handler = require('../netlify/functions/admin-submit-whatsapp-template').handler;
    var res = await handler(fakeEvent({ method: 'POST', body: '{not json' }));
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /E3/);
  });
});

test('POST from the real owner, but with config missing, refuses without ever calling fetch', function () {
  return withEnv(Object.assign({}, BASE_ENV, { WHATSAPP_WABA_ID: undefined }), async function () {
    var handler = require('../netlify/functions/admin-submit-whatsapp-template').handler;
    var res = await handler(fakeEvent({ method: 'POST', body: { email: OWNER_EMAIL } }));
    assert.equal(res.statusCode, 500);
    var body = JSON.parse(res.body);
    assert.match(body.error, /E5/);
    assert.deepEqual(body.missing, ['WHATSAPP_WABA_ID']);
  });
});

test('POST from the real owner, fully configured, submits the exact template payload to the documented endpoint', function () {
  return withEnv(BASE_ENV, async function () {
    var handler = require('../netlify/functions/admin-submit-whatsapp-template').handler;
    var captured = stubFetchCapture({ id: 'tmpl_abc123', status: 'PENDING', category: 'MARKETING' });

    var res = await handler(fakeEvent({ method: 'POST', body: { email: OWNER_EMAIL } }));

    assert.equal(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.templateId, 'tmpl_abc123');
    assert.equal(body.status, 'PENDING');
    assert.equal(body.category, 'MARKETING');

    assert.equal(captured.calls.length, 1);
    assert.match(captured.calls[0].url, /^https:\/\/graph\.facebook\.com\/v20\.0\/1261409435841617\/message_templates$/);
    assert.equal(captured.calls[0].init.method, 'POST');
    assert.equal(captured.calls[0].init.headers.Authorization, 'Bearer test-access-token');
    var sent = JSON.parse(captured.calls[0].init.body);
    assert.equal(sent.name, 'morning_capture_v1');
    assert.equal(sent.category, 'MARKETING');
    assert.equal(sent.language, 'en_US');
    assert.equal(sent.components[0].text, 'Good morning {{1}} — what did you dream? It\'s already fading. Tap below and just speak it.');
    assert.equal(sent.components[1].buttons[0].text, 'Speak');
    assert.equal(sent.components[1].buttons[1].text, 'No recall');
  });
});

test('POST is case-insensitive/whitespace-tolerant on the owner email match, same normalizeEmail rule every sibling admin tool uses', function () {
  return withEnv(BASE_ENV, async function () {
    var handler = require('../netlify/functions/admin-submit-whatsapp-template').handler;
    stubFetchCapture();
    var res = await handler(fakeEvent({ method: 'POST', body: { email: '  ' + OWNER_EMAIL.toUpperCase() + '  ' } }));
    assert.equal(res.statusCode, 200);
  });
});

test('POST surfaces a Graph API error (e.g. bad token, already-exists template name) as E6, never throws', function () {
  return withEnv(BASE_ENV, async function () {
    var handler = require('../netlify/functions/admin-submit-whatsapp-template').handler;
    stubFetchError(400, { error: { message: 'A template with this name already exists', code: 100 } });

    var res = await handler(fakeEvent({ method: 'POST', body: { email: OWNER_EMAIL } }));
    assert.equal(res.statusCode, 502);
    var body = JSON.parse(res.body);
    assert.match(body.error, /E6/);
    assert.equal(body.status, 400);
  });
});

test('POST surfaces a network-level failure (fetch rejects) as E7, never throws', function () {
  return withEnv(BASE_ENV, async function () {
    var handler = require('../netlify/functions/admin-submit-whatsapp-template').handler;
    global.fetch = async function () { throw new Error('simulated DNS/network failure'); };

    var res = await handler(fakeEvent({ method: 'POST', body: { email: OWNER_EMAIL } }));
    assert.equal(res.statusCode, 502);
    assert.match(JSON.parse(res.body).error, /E7/);
  });
});

test('rejects methods other than GET/POST', function () {
  return withEnv(BASE_ENV, async function () {
    var handler = require('../netlify/functions/admin-submit-whatsapp-template').handler;
    var res = await handler(fakeEvent({ method: 'DELETE' }));
    assert.equal(res.statusCode, 405);
    assert.match(JSON.parse(res.body).error, /E1/);
  });
});
