// test/send-whatsapp-morning-capture.test.js
//
// Covers netlify/functions/send-whatsapp-morning-capture.js — the
// WhatsApp channel for the Morning Capture Ritual (tracker item
// for-product-build-whatsapp-morning-captu-skez3n, steps 3-4). Two halves,
// following test/send-daily-claim-pushes.test.js's own conventions for
// this repo's first scheduled function:
//
//   1. sendMorningCaptureMessage in isolation — stubs global.fetch the
//      same way test/create-checkout-session-dodo.test.js stubs the Dodo
//      SDK's outbound call, since the WhatsApp Cloud API call here is a
//      plain fetch() too (no SDK).
//   2. scanAndSend — mocked Blobs (account-store.js's real store) + a
//      captured sendMorningCaptureMessage call list, mirroring send-daily-
//      claim-pushes.test.js's seedSubscribedAccount/scanAndSend shape.
//
// Run with: node --test test/

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var accountStore = require('../netlify/functions/lib/account-store');

var realFetch = global.fetch;

var REQUIRED_ENV = {
  WHATSAPP_ACCESS_TOKEN: 'test-access-token',
  WHATSAPP_PHONE_NUMBER_ID: '1022231790969271',
  WHATSAPP_TEMPLATE_NAME_MORNING_CAPTURE: 'morning_capture_v1'
};

function setRequiredEnv() {
  Object.keys(REQUIRED_ENV).forEach(function (key) { process.env[key] = REQUIRED_ENV[key]; });
}

function clearRequiredEnv() {
  Object.keys(REQUIRED_ENV).forEach(function (key) { delete process.env[key]; });
}

test.beforeEach(function () {
  mockBlobs.reset();
  clearRequiredEnv();
  global.fetch = async function (url) {
    throw new Error('unexpected real network call in a test: ' + String(url));
  };
  delete require.cache[require.resolve('../netlify/functions/send-whatsapp-morning-capture')];
});

test.after(function () {
  global.fetch = realFetch;
  clearRequiredEnv();
});

function stubFetchCapture(responseBody, status) {
  var captured = { calls: [] };
  global.fetch = async function (url, init) {
    captured.calls.push({ url: url, init: init });
    return new Response(JSON.stringify(responseBody || { messages: [{ id: 'wamid.test123' }] }), {
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
// 1. sendMorningCaptureMessage
// ===========================================================================

test('sendMorningCaptureMessage: sends a real template call and returns the message id on success', async function () {
  setRequiredEnv();
  var sender = require('../netlify/functions/send-whatsapp-morning-capture');
  var captured = stubFetchCapture({ messages: [{ id: 'wamid.abc' }] });

  var result = await sender.sendMorningCaptureMessage('+15551234567', 'Alice');

  assert.equal(result.ok, true);
  assert.equal(result.messageId, 'wamid.abc');
  assert.equal(captured.calls.length, 1);
  assert.match(captured.calls[0].url, /^https:\/\/graph\.facebook\.com\/v20\.0\/1022231790969271\/messages$/);
  var body = JSON.parse(captured.calls[0].init.body);
  assert.equal(body.messaging_product, 'whatsapp');
  assert.equal(body.to, '+15551234567');
  assert.equal(body.type, 'template');
  assert.equal(body.template.name, 'morning_capture_v1');
  assert.equal(body.template.language.code, 'en_US');
  assert.equal(body.template.components[0].parameters[0].text, 'Alice');
  assert.equal(captured.calls[0].init.headers.Authorization, 'Bearer test-access-token');
});

test('sendMorningCaptureMessage: falls back to "there" when no firstName is given', async function () {
  setRequiredEnv();
  var sender = require('../netlify/functions/send-whatsapp-morning-capture');
  var captured = stubFetchCapture();

  await sender.sendMorningCaptureMessage('+15551234567');

  var body = JSON.parse(captured.calls[0].init.body);
  assert.equal(body.template.components[0].parameters[0].text, 'there');
});

test('sendMorningCaptureMessage: no recipient is a soft no-op, no network call made', async function () {
  setRequiredEnv();
  var sender = require('../netlify/functions/send-whatsapp-morning-capture');
  global.fetch = async function () { throw new Error('must not call fetch with no recipient'); };

  var result = await sender.sendMorningCaptureMessage('', 'Alice');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_recipient');
});

test('sendMorningCaptureMessage: soft-fails as not_configured when WHATSAPP_ACCESS_TOKEN is unset, no network call made', async function () {
  setRequiredEnv();
  delete process.env.WHATSAPP_ACCESS_TOKEN;
  var sender = require('../netlify/functions/send-whatsapp-morning-capture');
  global.fetch = async function () { throw new Error('must not call the Graph API while unconfigured'); };

  assert.equal(sender.isConfigured(), false);
  var result = await sender.sendMorningCaptureMessage('+15551234567', 'Alice');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_configured');
});

test('sendMorningCaptureMessage: soft-fails as not_configured when WHATSAPP_PHONE_NUMBER_ID is unset, no network call made', async function () {
  setRequiredEnv();
  delete process.env.WHATSAPP_PHONE_NUMBER_ID;
  var sender = require('../netlify/functions/send-whatsapp-morning-capture');
  global.fetch = async function () { throw new Error('must not call the Graph API while unconfigured'); };

  assert.equal(sender.isConfigured(), false);
  var result = await sender.sendMorningCaptureMessage('+15551234567', 'Alice');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_configured');
});

test('sendMorningCaptureMessage: soft-fails as not_configured when WHATSAPP_TEMPLATE_NAME_MORNING_CAPTURE is unset, no network call made', async function () {
  setRequiredEnv();
  delete process.env.WHATSAPP_TEMPLATE_NAME_MORNING_CAPTURE;
  var sender = require('../netlify/functions/send-whatsapp-morning-capture');
  global.fetch = async function () { throw new Error('must not call the Graph API while unconfigured'); };

  assert.equal(sender.isConfigured(), false);
  var result = await sender.sendMorningCaptureMessage('+15551234567', 'Alice');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_configured');
});

test('sendMorningCaptureMessage: with none of the three env vars set at all (the real out-of-the-box state before any Meta setup), still soft-fails cleanly', async function () {
  var sender = require('../netlify/functions/send-whatsapp-morning-capture');
  global.fetch = async function () { throw new Error('must not call the Graph API while unconfigured'); };

  assert.equal(sender.isConfigured(), false);
  var result = await sender.sendMorningCaptureMessage('+15551234567', 'Alice');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_configured');
});

test('sendMorningCaptureMessage: a Graph API error response (e.g. expired token / unapproved template) soft-fails, never throws', async function () {
  setRequiredEnv();
  var sender = require('../netlify/functions/send-whatsapp-morning-capture');
  stubFetchError(401, { error: { message: 'Error validating access token', code: 190 } });

  var result = await sender.sendMorningCaptureMessage('+15551234567', 'Alice');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'graph_api_error');
  assert.equal(result.status, 401);
});

test('sendMorningCaptureMessage: a network-level failure (fetch rejects) soft-fails, never throws', async function () {
  setRequiredEnv();
  var sender = require('../netlify/functions/send-whatsapp-morning-capture');
  global.fetch = async function () { throw new Error('simulated DNS/network failure'); };

  var result = await sender.sendMorningCaptureMessage('+15551234567', 'Alice');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unexpected_error');
});

// ===========================================================================
// 2. scanAndSend
// ===========================================================================

async function seedOptedInAccount(username, email, whatsappNumber) {
  var event = fakeEvent({});
  await accountStore.createAccount(event, { username: username, password: 'hunter22', email: email });
  if (whatsappNumber) await accountStore.setWhatsappNumber(event, username, whatsappNumber);
}

test('scanAndSend: sends to every opted-in account once configured', async function () {
  setRequiredEnv();
  var sender = require('../netlify/functions/send-whatsapp-morning-capture');
  var captured = stubFetchCapture();

  await seedOptedInAccount('wendy', 'wendy@example.com', '+15551110000');
  await seedOptedInAccount('xavier', 'xavier@example.com', '+15552220000');
  await seedOptedInAccount('yolanda', 'yolanda@example.com', null); // never opted in

  var result = await sender.scanAndSend(fakeEvent({}));

  assert.equal(result.scanned, 3);
  assert.equal(result.sent, 2);
  assert.equal(captured.calls.length, 2);
});

test('scanAndSend: skips accounts with no whatsappNumber on file at all', async function () {
  setRequiredEnv();
  var sender = require('../netlify/functions/send-whatsapp-morning-capture');
  stubFetchCapture();
  await accountStore.createAccount(fakeEvent({}), { username: 'zack', password: 'hunter22', email: 'zack@example.com' });

  var result = await sender.scanAndSend(fakeEvent({}));
  assert.equal(result.sent, 0);
});

test('scanAndSend: does not double-send to the SAME account twice on the same UTC day (dedup guard)', async function () {
  setRequiredEnv();
  var sender = require('../netlify/functions/send-whatsapp-morning-capture');
  var captured = stubFetchCapture();
  await seedOptedInAccount('amy', 'amy@example.com', '+15551234567');

  var first = await sender.scanAndSend(fakeEvent({}));
  var second = await sender.scanAndSend(fakeEvent({}));

  assert.equal(first.sent, 1);
  assert.equal(second.sent, 0);
  assert.equal(second.skipped, 1);
  assert.equal(captured.calls.length, 1, 'the real Graph API call must only ever fire once for the same account on the same day');
});

test('scanAndSend: two DIFFERENT accounts each get their own independent dedup marker', async function () {
  setRequiredEnv();
  var sender = require('../netlify/functions/send-whatsapp-morning-capture');
  var captured = stubFetchCapture();
  await seedOptedInAccount('ben', 'ben@example.com', '+15551110000');
  await seedOptedInAccount('cara', 'cara@example.com', '+15552220000');

  await sender.scanAndSend(fakeEvent({})); // sends to both
  var pushDedupStore = require('../netlify/functions/lib/push-dedup-store');
  var today = new Date().toISOString().slice(0, 10);
  // Ben already sent today; independently mark Cara's OWN key as already
  // sent too and confirm Ben's own dedup marker is untouched by it.
  var benAlreadySent = await pushDedupStore.hasSent(fakeEvent({}), 'whatsapp-morning-capture:ben:' + today);
  var caraAlreadySent = await pushDedupStore.hasSent(fakeEvent({}), 'whatsapp-morning-capture:cara:' + today);
  assert.equal(benAlreadySent, true);
  assert.equal(caraAlreadySent, true);
  assert.equal(captured.calls.length, 2);
});

test('scanAndSend: a real Graph API failure for one account never blocks sending to the next', async function () {
  setRequiredEnv();
  var sender = require('../netlify/functions/send-whatsapp-morning-capture');
  await seedOptedInAccount('dana', 'dana@example.com', '+15551110000');
  await seedOptedInAccount('evan', 'evan@example.com', '+15552220000');

  var callIndex = 0;
  global.fetch = async function () {
    callIndex++;
    if (callIndex === 1) {
      return new Response(JSON.stringify({ error: { message: 'template not approved' } }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ messages: [{ id: 'wamid.ok' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  var result = await sender.scanAndSend(fakeEvent({}));
  assert.equal(result.scanned, 2);
  assert.equal(result.sent, 1, 'exactly one of the two sends should have actually succeeded');
});

test('scanAndSend: with WhatsApp not configured at all, scans but sends nothing (never throws)', async function () {
  var sender = require('../netlify/functions/send-whatsapp-morning-capture');
  global.fetch = async function () { throw new Error('must not call the Graph API while unconfigured'); };
  await seedOptedInAccount('fiona', 'fiona@example.com', '+15551234567');

  var result = await sender.scanAndSend(fakeEvent({}));
  assert.equal(result.scanned, 1);
  assert.equal(result.sent, 0);
});

test('exports.handler (the scheduled wrapper, an identity passthrough of scanAndSend under @netlify/functions\' own schedule()) resolves 200 on a normal configured run', async function () {
  setRequiredEnv();
  var sender = require('../netlify/functions/send-whatsapp-morning-capture');
  stubFetchCapture();
  await seedOptedInAccount('grace', 'grace@example.com', '+15551234567');

  var res = await sender.handler(fakeEvent({}));
  assert.equal(res.statusCode, 200);
});

test('exports.handler resolves 200 even while completely unconfigured (never crashes the schedule)', async function () {
  var sender = require('../netlify/functions/send-whatsapp-morning-capture');
  global.fetch = async function () { throw new Error('must not call the Graph API while unconfigured'); };
  await seedOptedInAccount('henry', 'henry@example.com', '+15551234567');

  var res = await sender.handler(fakeEvent({}));
  assert.equal(res.statusCode, 200);
});
