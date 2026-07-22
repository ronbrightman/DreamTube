// test/helpers/mock-blobs.js
//
// A minimal in-memory stand-in for @netlify/blobs, since there's no real
// Blobs store available in this environment (or in CI) — every
// lib/*.js module in netlify/functions/lib requires('@netlify/blobs')
// directly, so the way to mock it without a real HTTP-mocking or DI
// framework is to pre-populate Node's own require() cache: once
// install() has run, any later require('@netlify/blobs') anywhere in the
// process (from entitlements.js, paywall-settings.js, rate-limit.js,
// spend-guard.js, or the functions that require those) resolves to this
// fake instead of hitting the real package.
//
// Storage is a plain object of storeName -> Map(key -> value), mirroring
// getStore({name}).get(key)/.setJSON(key, value)/.delete(key) closely
// enough for every call site in this codebase (verify-password-reset.js is
// the one caller that uses .delete, to consume a one-time reset token).
// `reset()` clears everything between tests so one test's writes can't
// leak into another's.

var stores = {};

function storeFor(name) {
  if (!stores[name]) stores[name] = new Map();
  return stores[name];
}

function fakeGetStore(opts) {
  // Real @netlify/blobs' getStore() accepts either a plain string (treated
  // as the store name — see request-password-reset.js/verify-password-
  // reset.js's getStore(RESET_STORE) calls) or an { name } options object
  // (every other lib/*.js file's convention) — mirror both here.
  var name = typeof opts === 'string' ? opts : opts.name;
  var map = storeFor(name);
  return {
    get: async function (key) {
      return map.has(key) ? map.get(key) : undefined;
    },
    setJSON: async function (key, value) {
      map.set(key, value);
    },
    delete: async function (key) {
      map.delete(key);
    }
  };
}

function fakeConnectLambda() {
  // Real @netlify/blobs uses this to pull Blobs credentials out of the
  // Lambda-compatible event/context. Nothing to do in the fake — getStore
  // above works with no credentials at all.
}

/** Directly seeds a value into a given store's key — used by tests that need to arrange pre-existing state (e.g. "this IP already hit today's rate limit") without going through a handler first. */
function seed(storeName, key, value) {
  storeFor(storeName).set(key, value);
}

/** Clears all fake store state. Call between tests. */
function reset() {
  stores = {};
}

/** Installs the fake in place of the real @netlify/blobs for the rest of this process. Call once, before requiring any module that (transitively) requires('@netlify/blobs'). */
function install() {
  var resolved = require.resolve('@netlify/blobs');
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: { getStore: fakeGetStore, connectLambda: fakeConnectLambda }
  };
}

module.exports = { install, reset, seed };
