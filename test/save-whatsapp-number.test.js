// test/save-whatsapp-number.test.js
//
// Covers netlify/functions/save-whatsapp-number.js — the GET/POST endpoint
// backing profile.html's Settings "Morning reminder" section (tracker item
// for-product-build-whatsapp-morning-captu-skez3n, step 3). Follows
// test/account-store.test.js's direct-handler-call convention (fakeEvent +
// mockBlobs, no HTTP server involved).

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');

var ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return '10.3.0.' + ipCounter;
}

test.beforeEach(function () {
  mockBlobs.reset();
  delete process.env.MAX_SAVE_WHATSAPP_NUMBER_ATTEMPTS_PER_IP_PER_DAY;
  delete require.cache[require.resolve('../netlify/functions/save-whatsapp-number')];
  delete require.cache[require.resolve('../netlify/functions/lib/account-store')];
});

test('save-whatsapp-number: rejects non-POST/non-GET methods', async function () {
  var handler = require('../netlify/functions/save-whatsapp-number').handler;
  var res = await handler(fakeEvent({ method: 'DELETE', ip: nextIp() }));
  assert.equal(res.statusCode, 405);
  assert.match(JSON.parse(res.body).error, /^E1: method_not_allowed/);
});

test('save-whatsapp-number: POST rejects invalid JSON', async function () {
  var handler = require('../netlify/functions/save-whatsapp-number').handler;
  var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: '{not json' }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E2: invalid_json/);
});

test('save-whatsapp-number: POST rejects a missing username', async function () {
  var handler = require('../netlify/functions/save-whatsapp-number').handler;
  var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { whatsappNumber: '+15551234567' } }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E3: missing_fields/);
});

test('save-whatsapp-number: GET without a username is a 400', async function () {
  var handler = require('../netlify/functions/save-whatsapp-number').handler;
  var res = await handler(fakeEvent({ method: 'GET', ip: nextIp() }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E3: missing_fields/);
});

test('save-whatsapp-number: POST saves a valid number, and GET reads it back', async function () {
  var accountStore = require('../netlify/functions/lib/account-store');
  var handler = require('../netlify/functions/save-whatsapp-number').handler;
  var event = fakeEvent({ method: 'POST', ip: nextIp() });
  await accountStore.createAccount(event, { username: 'ruth', password: 'hunter22', email: 'ruth@example.com' });

  var saveRes = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { username: 'ruth', whatsappNumber: '+1 (555) 222-3333' } }));
  assert.equal(saveRes.statusCode, 200);
  var saveBody = JSON.parse(saveRes.body);
  assert.equal(saveBody.ok, true);
  assert.equal(saveBody.whatsappNumber, '+15552223333');

  var getRes = await handler(fakeEvent({ method: 'GET', ip: nextIp(), query: { username: 'ruth' } }));
  var getBody = JSON.parse(getRes.body);
  assert.equal(getBody.ok, true);
  assert.equal(getBody.whatsappNumber, '+15552223333');
});

test('save-whatsapp-number: GET for a username with no saved number reports null, not an error', async function () {
  var accountStore = require('../netlify/functions/lib/account-store');
  var handler = require('../netlify/functions/save-whatsapp-number').handler;
  var event = fakeEvent({ method: 'POST', ip: nextIp() });
  await accountStore.createAccount(event, { username: 'sam', password: 'hunter22', email: 'sam@example.com' });

  var getRes = await handler(fakeEvent({ method: 'GET', ip: nextIp(), query: { username: 'sam' } }));
  var getBody = JSON.parse(getRes.body);
  assert.equal(getBody.ok, true);
  assert.equal(getBody.whatsappNumber, null);
});

test('save-whatsapp-number: GET for an unknown username also reports null (never leaks whether the account exists)', async function () {
  var handler = require('../netlify/functions/save-whatsapp-number').handler;
  var getRes = await handler(fakeEvent({ method: 'GET', ip: nextIp(), query: { username: 'nobody-registered' } }));
  var getBody = JSON.parse(getRes.body);
  assert.equal(getBody.ok, true);
  assert.equal(getBody.whatsappNumber, null);
});

test('save-whatsapp-number: POST with an unusable number returns E4 and saves nothing', async function () {
  var accountStore = require('../netlify/functions/lib/account-store');
  var handler = require('../netlify/functions/save-whatsapp-number').handler;
  var event = fakeEvent({ method: 'POST', ip: nextIp() });
  await accountStore.createAccount(event, { username: 'tara', password: 'hunter22', email: 'tara@example.com' });

  var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { username: 'tara', whatsappNumber: 'not-a-real-number' } }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /^E4: invalid_number/);

  var record = await accountStore.getByUsername(event, 'tara');
  assert.equal(record.whatsappNumber, undefined);
});

test('save-whatsapp-number: POST for an unregistered username returns E6 not_found', async function () {
  var handler = require('../netlify/functions/save-whatsapp-number').handler;
  var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { username: 'never-signed-up', whatsappNumber: '+15551234567' } }));
  assert.equal(res.statusCode, 404);
  assert.match(JSON.parse(res.body).error, /^E6: not_found/);
});

test('save-whatsapp-number: POST with an empty whatsappNumber clears a previously-saved one (opt-out)', async function () {
  var accountStore = require('../netlify/functions/lib/account-store');
  var handler = require('../netlify/functions/save-whatsapp-number').handler;
  var event = fakeEvent({ method: 'POST', ip: nextIp() });
  await accountStore.createAccount(event, { username: 'uma', password: 'hunter22', email: 'uma@example.com' });
  await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { username: 'uma', whatsappNumber: '+15551234567' } }));

  var clearRes = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { username: 'uma', whatsappNumber: '' } }));
  assert.equal(clearRes.statusCode, 200);
  var clearBody = JSON.parse(clearRes.body);
  assert.equal(clearBody.ok, true);
  assert.equal(clearBody.whatsappNumber, null);

  var record = await accountStore.getByUsername(event, 'uma');
  assert.equal(record.whatsappNumber, undefined);
});

test('save-whatsapp-number: enforces a per-IP daily cap', async function () {
  process.env.MAX_SAVE_WHATSAPP_NUMBER_ATTEMPTS_PER_IP_PER_DAY = '2';
  var accountStore = require('../netlify/functions/lib/account-store');
  var handler = require('../netlify/functions/save-whatsapp-number').handler;
  var event = fakeEvent({ method: 'POST' });
  await accountStore.createAccount(event, { username: 'vince', password: 'hunter22', email: 'vince@example.com' });

  var ip = nextIp();
  var first = await handler(fakeEvent({ method: 'POST', ip: ip, body: { username: 'vince', whatsappNumber: '+15551234567' } }));
  var second = await handler(fakeEvent({ method: 'POST', ip: ip, body: { username: 'vince', whatsappNumber: '+15557654321' } }));
  var third = await handler(fakeEvent({ method: 'POST', ip: ip, body: { username: 'vince', whatsappNumber: '+15559998888' } }));

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(third.statusCode, 429);
  assert.match(JSON.parse(third.body).error, /^E5: rate_limited/);
});
