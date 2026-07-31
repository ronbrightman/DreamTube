// test/email-domain-check.test.js
//
// Covers netlify/functions/lib/email-domain-check.js -- the lightweight,
// no-vendor MX/A/AAAA deliverability heuristic added for check-email.js
// (tracker item for-product-signup-email-micro-step-foun-ns8uve).
//
// Node's own `dns.promises` module is a single, process-wide singleton
// (require('dns').promises always returns the same object) -- same
// require-cache-mutation approach test/helpers/mock-blobs.js already uses
// for @netlify/blobs, just applied directly here rather than via a shared
// helper, since this is the only file that needs it. Each test restores
// the real methods in `finally` so no other test/file (including any real
// network-touching code elsewhere in the suite) is affected.

var test = require('node:test');
var assert = require('node:assert/strict');

var dns = require('dns');
var emailDomainCheck = require('../netlify/functions/lib/email-domain-check');

function withMockedDns(mocks, fn) {
  var realResolveMx = dns.promises.resolveMx;
  var realResolve4 = dns.promises.resolve4;
  var realResolve6 = dns.promises.resolve6;
  dns.promises.resolveMx = mocks.resolveMx || function () { return Promise.reject(enotfound()); };
  dns.promises.resolve4 = mocks.resolve4 || function () { return Promise.reject(enotfound()); };
  dns.promises.resolve6 = mocks.resolve6 || function () { return Promise.reject(enotfound()); };
  return Promise.resolve().then(fn).finally(function () {
    dns.promises.resolveMx = realResolveMx;
    dns.promises.resolve4 = realResolve4;
    dns.promises.resolve6 = realResolve6;
  });
}

function enotfound() {
  var e = new Error('queryMx ENOTFOUND');
  e.code = 'ENOTFOUND';
  return e;
}
function enodata() {
  var e = new Error('queryMx ENODATA');
  e.code = 'ENODATA';
  return e;
}
function servfail() {
  var e = new Error('queryMx SERVFAIL');
  e.code = 'ESERVFAIL';
  return e;
}

test('email-domain-check: empty/falsy domain is undeliverable without ever touching dns', async function () {
  var called = false;
  await withMockedDns({
    resolveMx: function () { called = true; return Promise.resolve([]); }
  }, async function () {
    assert.equal(await emailDomainCheck.isDomainDeliverable(''), false);
    assert.equal(await emailDomainCheck.isDomainDeliverable(null), false);
  });
  assert.equal(called, false, 'must never call dns.resolveMx for an empty domain');
});

test('email-domain-check: a domain with MX records is deliverable', async function () {
  await withMockedDns({
    resolveMx: function () { return Promise.resolve([{ exchange: 'mx1.example.com', priority: 10 }]); }
  }, async function () {
    assert.equal(await emailDomainCheck.isDomainDeliverable('example.com'), true);
  });
});

test('email-domain-check: no MX but a valid A record falls back to deliverable (RFC 5321 §5.1)', async function () {
  await withMockedDns({
    resolveMx: function () { return Promise.reject(enodata()); },
    resolve4: function () { return Promise.resolve(['93.184.216.34']); }
  }, async function () {
    assert.equal(await emailDomainCheck.isDomainDeliverable('no-mx-has-a.example.com'), true);
  });
});

test('email-domain-check: no MX, no A, but a valid AAAA record falls back to deliverable', async function () {
  await withMockedDns({
    resolveMx: function () { return Promise.reject(enotfound()); },
    resolve4: function () { return Promise.reject(enotfound()); },
    resolve6: function () { return Promise.resolve(['2606:2800:220:1:248:1893:25c8:1946']); }
  }, async function () {
    assert.equal(await emailDomainCheck.isDomainDeliverable('ipv6-only.example.com'), true);
  });
});

test('email-domain-check: no MX, no A, no AAAA -- confirmed undeliverable', async function () {
  await withMockedDns({
    resolveMx: function () { return Promise.reject(enotfound()); },
    resolve4: function () { return Promise.reject(enotfound()); },
    resolve6: function () { return Promise.reject(enotfound()); }
  }, async function () {
    assert.equal(await emailDomainCheck.isDomainDeliverable('definitely-does-not-exist-xyz123.invalid'), false);
  });
});

test('email-domain-check: an empty (but not errored) MX list falls through to the A-record check, same as ENODATA would', async function () {
  await withMockedDns({
    resolveMx: function () { return Promise.resolve([]); },
    resolve4: function () { return Promise.resolve(['1.2.3.4']); }
  }, async function () {
    assert.equal(await emailDomainCheck.isDomainDeliverable('empty-mx-list.example.com'), true);
  });
});

test('email-domain-check: an unexpected DNS error (not ENOTFOUND/ENODATA) fails OPEN at the MX step, never reaching the A-record fallback', async function () {
  var resolve4Called = false;
  await withMockedDns({
    resolveMx: function () { return Promise.reject(servfail()); },
    resolve4: function () { resolve4Called = true; return Promise.reject(enotfound()); }
  }, async function () {
    assert.equal(await emailDomainCheck.isDomainDeliverable('flaky-resolver.example.com'), true);
  });
  assert.equal(resolve4Called, false, 'a genuine infra error must fail open immediately, not fall through to the A-record check');
});

test('email-domain-check: an unexpected DNS error at the A-record step (after a confirmed no-MX) also fails OPEN', async function () {
  await withMockedDns({
    resolveMx: function () { return Promise.reject(enodata()); },
    resolve4: function () { return Promise.reject(servfail()); }
  }, async function () {
    assert.equal(await emailDomainCheck.isDomainDeliverable('flaky-a-lookup.example.com'), true);
  });
});

test('email-domain-check: a slow resolver that never settles fails OPEN once the internal timeout fires', async function () {
  await withMockedDns({
    resolveMx: function () { return new Promise(function () { /* never resolves */ }); }
  }, async function () {
    assert.equal(await emailDomainCheck.isDomainDeliverable('slow-resolver.example.com'), true);
  });
});
