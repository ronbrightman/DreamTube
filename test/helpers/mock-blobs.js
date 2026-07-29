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

// Per-store read overrides, for tests simulating a hazard the plain
// synchronous in-memory Map can't otherwise reproduce (e.g. Blobs' lack
// of a read-your-own-write guarantee, or a read that never converges
// within a bounded retry loop) — see setReadOverride's own doc comment.
// Keyed by storeName -> { fn, callCount }. This lives INSIDE
// fakeGetStore's own closure, not on the exports object, deliberately:
// every lib/*.js module destructures `var { getStore } = require(...)`
// at require-time, copying a reference to this exact `fakeGetStore`
// function — reassigning a property on the exports object afterward
// would never reach those already-bound locals, only mutating this
// function's own behavior does.
var readOverrides = {};

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
      var override = readOverrides[name];
      if (override) {
        override.callCount++;
        var result = override.fn(key, override.callCount);
        // `result` is `{ value }` to substitute a value (possibly
        // `undefined`, to simulate "not visible yet"), or a falsy
        // non-object to fall through to the real stored value.
        if (result) return result.value;
      }
      return map.has(key) ? map.get(key) : undefined;
    },
    setJSON: async function (key, value) {
      map.set(key, value);
    },
    delete: async function (key) {
      map.delete(key);
    },
    // Minimal stand-in for real @netlify/blobs' list() — added for
    // tracker item for-product-build-stage-0-pwa-web-push-f-jbutt5's
    // send-daily-claim-pushes.js (this repo's first scheduled function),
    // which has no per-record key to read directly and must enumerate an
    // entire store instead. Only the non-paginated, no-options shape
    // (`Promise<{ blobs, directories }>`) is implemented — every real
    // call site added alongside this comment uses exactly that shape;
    // `directories` is always empty (this mock has no concept of blob
    // "directories", a real-Blobs-only feature no caller here uses).
    list: async function () {
      return {
        blobs: Array.from(map.keys()).map(function (key) { return { key: key, etag: 'mock-etag' }; }),
        directories: []
      };
    }
  };
}

/**
 * Installs a temporary override on every get() call against `storeName`:
 * `fn(key, callIndex)` (callIndex starts at 1, incrementing per get()
 * against this store since the override was installed) is called on
 * every read; if it returns `{ value }`, that value is returned instead
 * of whatever is actually in the store (use `{ value: undefined }` to
 * simulate "this read doesn't see it yet"); returning a falsy value
 * falls through to the real stored value for that call. setJSON/delete
 * are never intercepted — only reads, since the hazards this exists to
 * simulate (stale/lagging reads, reads that never converge) are read-side
 * phenomena in real Blobs, not write-side ones.
 *
 * Used for exercising exactly the class of bug the mock's normal
 * perfectly-consistent synchronous Map can't otherwise reproduce: a read
 * landing behind a write that already happened, or a verify-read that
 * never converges within a bounded retry loop. Call clearReadOverride
 * (or reset(), which clears all overrides too) when done — a stray
 * override lingering into a later test would silently corrupt it.
 */
function setReadOverride(storeName, fn) {
  readOverrides[storeName] = { fn: fn, callCount: 0 };
}

/** Removes a single store's read override, if any. */
function clearReadOverride(storeName) {
  delete readOverrides[storeName];
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

/** Clears all fake store state, including any read overrides. Call between tests. */
function reset() {
  stores = {};
  readOverrides = {};
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

module.exports = { install, reset, seed, setReadOverride, clearReadOverride };
