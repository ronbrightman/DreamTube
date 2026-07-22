// test/token-functions.test.js
//
// Covers the new standalone Netlify Function the token economy adds:
// get-token-status.js (thin read-only wrapper around
// entitlements.getTokenStatus, including that it's the actual
// materialization point for a brand-new email's 200-token signup grant).
// Exercised at the handler level, same pattern as
// test/admin-paywall-toggle.test.js. There is no token-purchase function
// yet (grant-topup-bonus.js, the old system's equivalent, was deleted
// outright — see shop.html's own header comment: no payment processor is
// wired up, so there's nothing server-side to test until that exists).

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var entitlements = require('../netlify/functions/lib/entitlements');
var getTokenStatusHandler = require('../netlify/functions/get-token-status').handler;

var ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return '10.4.0.' + ipCounter;
}

test.beforeEach(function () {
  mockBlobs.reset();
});

test('GET with no email -> a zero/inert status, no Blobs touched', async function () {
  var res = await getTokenStatusHandler(fakeEvent({ method: 'GET', ip: nextIp() }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { balance: 0, nextGrantAt: null, dailyGrantAmount: 100 });
});

test('GET with a brand-new email materializes the 200-token signup grant', async function () {
  var res = await getTokenStatusHandler(fakeEvent({ method: 'GET', ip: nextIp(), query: { email: 'fresh@example.com' } }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.balance, 200);
  assert.equal(body.dailyGrantAmount, 100);
  assert.equal(typeof body.nextGrantAt, 'number');
});

test('GET with an already-initialized email reads its real balance straight through', async function () {
  var ev = fakeEvent({ ip: nextIp() });
  await entitlements.setEntitlement(ev, 'existing@example.com', { tokens: { balance: 340, lastGrantAt: Date.now() } });
  var res = await getTokenStatusHandler(fakeEvent({ method: 'GET', ip: nextIp(), query: { email: 'existing@example.com' } }));
  var body = JSON.parse(res.body);
  assert.equal(body.balance, 340);
});

test('the real request IP is what the per-IP new-grant cap keys off, not a shared default', async function () {
  process.env.MAX_TOKEN_GRANTS_PER_IP_PER_DAY = '1';
  var ip = nextIp();
  var res1 = await getTokenStatusHandler(fakeEvent({ method: 'GET', ip: ip, query: { email: 'ip1a@example.com' } }));
  var res2 = await getTokenStatusHandler(fakeEvent({ method: 'GET', ip: ip, query: { email: 'ip1b@example.com' } }));
  assert.equal(JSON.parse(res1.body).balance, 200);
  assert.equal(JSON.parse(res2.body).balance, 0, 'second brand-new email from the same IP today is over the cap');
  delete process.env.MAX_TOKEN_GRANTS_PER_IP_PER_DAY;
});

test('non-GET method rejected E1', async function () {
  var res = await getTokenStatusHandler(fakeEvent({ method: 'POST', ip: nextIp() }));
  assert.equal(res.statusCode, 405);
  assert.match(JSON.parse(res.body).error, /^E1:/);
});
