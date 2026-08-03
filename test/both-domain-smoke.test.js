// test/both-domain-smoke.test.js
//
// Covers netlify/functions/both-domain-smoke.js's own pass/fail assertion
// logic (checkPage/checkFunction/runDomainChecks/scanAndCheck) — tracker
// item for-product-reliability-net-spec-v1-smok-x1o5zc. Uses a fully
// FAKE fetch implementation (no real network calls, and none of this
// codebase's real endpoints are hit) so this suite exercises exactly the
// decision logic ("what counts as a passing page/function check") in
// isolation, independent of real production behaving one way or another
// on the day this runs — real-production behavior is what
// test/prod-smoke/*.test.js is for instead (see that directory's own
// README.md).
//
// Run with: node --test test/

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var bothDomainSmoke = require('../netlify/functions/both-domain-smoke');
var smokeStatusStore = require('../netlify/functions/lib/smoke-status-store');

test.beforeEach(function () {
  mockBlobs.reset();
});

/** Minimal fake Response -- just enough shape for checkPage/checkFunction (status, text()). */
function fakeResponse(status, body) {
  return { status: status, text: async function () { return body; } };
}

/** Builds a fake fetch that answers every PAGE_CHECKS/FUNCTION_CHECKS url with `handler(url, options)`. */
function fakeFetchFrom(handler) {
  return async function (url, options) {
    return handler(url, options);
  };
}

test('checkPage passes on a real 200 whose body contains the expected marker', async function () {
  var fetchImpl = fakeFetchFrom(function () { return fakeResponse(200, '<title>Home — DreamTube</title>'); });
  var result = await bothDomainSmoke.checkPage(fetchImpl, 'https://dreamtube.life', { path: '/home.html', marker: 'Home — DreamTube' });
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
});

test('checkPage fails on a non-200 status', async function () {
  var fetchImpl = fakeFetchFrom(function () { return fakeResponse(500, 'Internal Server Error'); });
  var result = await bothDomainSmoke.checkPage(fetchImpl, 'https://dreamtube.life', { path: '/home.html', marker: 'Home — DreamTube' });
  assert.equal(result.ok, false);
  assert.match(result.error, /expected 200/);
});

test('checkPage fails on a 200 whose body is missing the expected marker (a mislabeled error page)', async function () {
  var fetchImpl = fakeFetchFrom(function () { return fakeResponse(200, '<html>something else entirely</html>'); });
  var result = await bothDomainSmoke.checkPage(fetchImpl, 'https://dreamtube.life', { path: '/home.html', marker: 'Home — DreamTube' });
  assert.equal(result.ok, false);
  assert.match(result.error, /missing expected marker/);
});

test('checkPage fails (not throws) on a network error', async function () {
  var fetchImpl = fakeFetchFrom(function () { throw new Error('getaddrinfo ENOTFOUND'); });
  var result = await bothDomainSmoke.checkPage(fetchImpl, 'https://dreamtube.life', { path: '/home.html', marker: 'Home — DreamTube' });
  assert.equal(result.ok, false);
  assert.match(result.error, /ENOTFOUND/);
});

test('checkFunction (get-feed) passes on a 200 with a real feed array', async function () {
  var check = bothDomainSmoke.FUNCTION_CHECKS.find(function (c) { return c.name === 'get-feed'; });
  var fetchImpl = fakeFetchFrom(function () { return fakeResponse(200, JSON.stringify({ feed: [], dreamOfDayId: null })); });
  var result = await bothDomainSmoke.checkFunction(fetchImpl, 'https://dreamtube.life', check);
  assert.equal(result.ok, true);
});

test('checkFunction (get-feed) fails on a 200 whose body has no feed array', async function () {
  var check = bothDomainSmoke.FUNCTION_CHECKS.find(function (c) { return c.name === 'get-feed'; });
  var fetchImpl = fakeFetchFrom(function () { return fakeResponse(200, JSON.stringify({ oops: true })); });
  var result = await bothDomainSmoke.checkFunction(fetchImpl, 'https://dreamtube.life', check);
  assert.equal(result.ok, false);
  assert.match(result.error, /no feed array/);
});

test('checkFunction (get-token-status) passes on the documented no-email zero-touch 200', async function () {
  var check = bothDomainSmoke.FUNCTION_CHECKS.find(function (c) { return c.name === 'get-token-status'; });
  var fetchImpl = fakeFetchFrom(function () { return fakeResponse(200, JSON.stringify({ balance: 0, claimable: false, nextClaimAt: null, dailyClaimAmount: 20, streak: 0, hasMadeFirstPurchase: false })); });
  var result = await bothDomainSmoke.checkFunction(fetchImpl, 'https://dreamtube.life', check);
  assert.equal(result.ok, true);
});

test('checkFunction (check-email) treats a 429 rate_limited response as a PASS, not a failure -- see this file\'s own header comment on why', async function () {
  var check = bothDomainSmoke.FUNCTION_CHECKS.find(function (c) { return c.name === 'check-email'; });
  var fetchImpl = fakeFetchFrom(function () { return fakeResponse(429, JSON.stringify({ ok: false, error: 'E4: rate_limited' })); });
  var result = await bothDomainSmoke.checkFunction(fetchImpl, 'https://dreamtube.life', check);
  assert.equal(result.ok, true, 'a 429 must count as "the endpoint is alive and correctly enforcing its own rate limit", not a broken-function signal');
});

test('checkFunction (check-email) fails on a real 500', async function () {
  var check = bothDomainSmoke.FUNCTION_CHECKS.find(function (c) { return c.name === 'check-email'; });
  var fetchImpl = fakeFetchFrom(function () { return fakeResponse(500, 'Internal Server Error'); });
  var result = await bothDomainSmoke.checkFunction(fetchImpl, 'https://dreamtube.life', check);
  assert.equal(result.ok, false);
});

test('checkFunction (check-email) fails on a 200 that does not report ok:true', async function () {
  var check = bothDomainSmoke.FUNCTION_CHECKS.find(function (c) { return c.name === 'check-email'; });
  var fetchImpl = fakeFetchFrom(function () { return fakeResponse(200, JSON.stringify({ ok: false, available: false })); });
  var result = await bothDomainSmoke.checkFunction(fetchImpl, 'https://dreamtube.life', check);
  assert.equal(result.ok, false);
});

test('runDomainChecks is ok:true only when every page AND function check passes', async function () {
  var fetchImpl = fakeFetchFrom(function (url) {
    // Every page check gets its own real marker; every function check gets a shape that satisfies its verify().
    var pageMatch = bothDomainSmoke.PAGE_CHECKS.find(function (p) { return url.indexOf(p.path) !== -1; });
    if (pageMatch) return fakeResponse(200, '<title>' + pageMatch.marker + '</title>');
    if (url.indexOf('get-feed') !== -1) return fakeResponse(200, JSON.stringify({ feed: [] }));
    if (url.indexOf('get-token-status') !== -1) return fakeResponse(200, JSON.stringify({ balance: 0 }));
    if (url.indexOf('get-tracker-items') !== -1) return fakeResponse(200, JSON.stringify({ items: [] }));
    if (url.indexOf('check-email') !== -1) return fakeResponse(200, JSON.stringify({ ok: true, available: true }));
    return fakeResponse(404, 'not found');
  });

  var result = await bothDomainSmoke.runDomainChecks('dreamtube.life', fetchImpl);
  assert.equal(result.ok, true);
  assert.equal(result.pages.length, bothDomainSmoke.PAGE_CHECKS.length);
  assert.equal(result.functions.length, bothDomainSmoke.FUNCTION_CHECKS.length);
});

test('runDomainChecks is ok:false the moment a single check fails, e.g. one page 500ing', async function () {
  var fetchImpl = fakeFetchFrom(function (url) {
    if (url.indexOf('/shop.html') !== -1) return fakeResponse(500, 'boom');
    var pageMatch = bothDomainSmoke.PAGE_CHECKS.find(function (p) { return url.indexOf(p.path) !== -1; });
    if (pageMatch) return fakeResponse(200, '<title>' + pageMatch.marker + '</title>');
    if (url.indexOf('get-feed') !== -1) return fakeResponse(200, JSON.stringify({ feed: [] }));
    if (url.indexOf('get-token-status') !== -1) return fakeResponse(200, JSON.stringify({ balance: 0 }));
    if (url.indexOf('get-tracker-items') !== -1) return fakeResponse(200, JSON.stringify({ items: [] }));
    if (url.indexOf('check-email') !== -1) return fakeResponse(200, JSON.stringify({ ok: true }));
    return fakeResponse(404, 'not found');
  });

  var result = await bothDomainSmoke.runDomainChecks('dreamtube.life', fetchImpl);
  assert.equal(result.ok, false);
  var shopResult = result.pages.find(function (p) { return p.path === '/shop.html'; });
  assert.equal(shopResult.ok, false);
});

test('scanAndCheck runs BOTH domains and writes one status-store record per domain', async function () {
  var fetchImpl = fakeFetchFrom(function (url) {
    var pageMatch = bothDomainSmoke.PAGE_CHECKS.find(function (p) { return url.indexOf(p.path) !== -1; });
    if (pageMatch) return fakeResponse(200, '<title>' + pageMatch.marker + '</title>');
    if (url.indexOf('get-feed') !== -1) return fakeResponse(200, JSON.stringify({ feed: [] }));
    if (url.indexOf('get-token-status') !== -1) return fakeResponse(200, JSON.stringify({ balance: 0 }));
    if (url.indexOf('get-tracker-items') !== -1) return fakeResponse(200, JSON.stringify({ items: [] }));
    if (url.indexOf('check-email') !== -1) return fakeResponse(200, JSON.stringify({ ok: true }));
    return fakeResponse(404, 'not found');
  });

  var results = await bothDomainSmoke.scanAndCheck(fakeEvent({}), fetchImpl);
  assert.equal(results.length, bothDomainSmoke.DOMAINS.length);
  results.forEach(function (r) { assert.equal(r.ok, true); });

  var stored = await smokeStatusStore.getAllResults(fakeEvent({}));
  assert.equal(stored.length, bothDomainSmoke.DOMAINS.length);
  var storedDomains = stored.map(function (r) { return r.domain; }).sort();
  assert.deepEqual(storedDomains, bothDomainSmoke.DOMAINS.slice().sort());
  stored.forEach(function (r) { assert.equal(r.checkGroup, 'both-domain-smoke'); });
});

test('scanAndCheck still writes a record (ok:false, with a summary naming what failed) when a domain has real failures', async function () {
  var fetchImpl = fakeFetchFrom(function (url) {
    if (url.indexOf('dreamtube1.netlify.app') !== -1 && url.indexOf('/profile.html') !== -1) return fakeResponse(502, 'bad gateway');
    var pageMatch = bothDomainSmoke.PAGE_CHECKS.find(function (p) { return url.indexOf(p.path) !== -1; });
    if (pageMatch) return fakeResponse(200, '<title>' + pageMatch.marker + '</title>');
    if (url.indexOf('get-feed') !== -1) return fakeResponse(200, JSON.stringify({ feed: [] }));
    if (url.indexOf('get-token-status') !== -1) return fakeResponse(200, JSON.stringify({ balance: 0 }));
    if (url.indexOf('get-tracker-items') !== -1) return fakeResponse(200, JSON.stringify({ items: [] }));
    if (url.indexOf('check-email') !== -1) return fakeResponse(200, JSON.stringify({ ok: true }));
    return fakeResponse(404, 'not found');
  });

  var results = await bothDomainSmoke.scanAndCheck(fakeEvent({}), fetchImpl);
  var netlifyAppResult = results.find(function (r) { return r.domain === 'dreamtube1.netlify.app'; });
  var lifeResult = results.find(function (r) { return r.domain === 'dreamtube.life'; });
  assert.equal(netlifyAppResult.ok, false);
  assert.match(netlifyAppResult.summary, /profile\.html/);
  assert.equal(lifeResult.ok, true);
});
