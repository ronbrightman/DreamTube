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
// ALSO fakes the `blobs10` aliased package the same way (tracker.html's
// for-product-spike-conditional-write-only-rnurgw item —
// lib/first-dream-email-store.js and lib/push-dedup-store.js's CAS
// rewrite, `npm install blobs10@npm:@netlify/blobs@^10` per package.json),
// against the SAME underlying storeName -> Map state as the
// `@netlify/blobs` fake below — both real SDK versions are just different
// clients talking to the same physical Blobs backend for a given store
// name, so a test reading a record back out via
// `require('@netlify/blobs').getStore(...)` (the convention every existing
// test in this suite already uses) sees exactly what a CAS write made
// through `require('blobs10')` actually persisted, with no separate mock
// state to keep in sync.
//
// Storage is a plain object of storeName -> Map(key -> value), mirroring
// getStore({name}).get(key)/.setJSON(key, value)/.delete(key) closely
// enough for every call site in this codebase (verify-password-reset.js is
// the one caller that uses .delete, to consume a one-time reset token).
// `reset()` clears everything between tests so one test's writes can't
// leak into another's.
//
// CAS SUPPORT (`{ onlyIfNew: true }`, added for the same tracker item):
// mirrors the real 10.x SDK's own documented contract (see
// node_modules/blobs10/dist/main.d.ts's SetOptions/WriteResult, and
// dist/main.cjs's Store.setJSON) — a conditional write either resolves
// with `{ modified: true, etag }` (the key didn't exist, ours now does) or
// `{ modified: false }` (the key already existed, write atomically
// rejected) — it NEVER throws for an ordinary "already exists" collision,
// only for a genuine transport/server failure (simulated here the same way
// as every unconditional write, via setWriteOverride). `{ onlyIfMatch }`
// (etag-based conditional update) is intentionally NOT implemented here —
// neither rewritten store uses it, only `onlyIfNew` (fresh-claim creation).

var stores = {};

// Per-store metadata map (storeName -> Map(key -> metadata object)) for the
// binary set()/getMetadata()/getWithMetadata() trio below — kept SEPARATE
// from `stores` (which backs get()/setJSON()) rather than folding metadata
// into the same map's values, since the two call-shapes never mix for any
// one store name in this codebase today (dreamtube-videos/dreamtube-images
// are ONLY ever written via set()+read via getWithMetadata(), every other
// store is ONLY ever JSON via get()/setJSON()) — added for
// lib/media-rehost.js/video-file.mjs/image-file.mjs (tracker item
// for-product-owner-media-library-page-fou-1fwxaw), mirroring the real
// @netlify/blobs SDK's own Store.getMetadata/getWithMetadata/set (see
// node_modules/@netlify/blobs/dist/main.cjs).
var metaStores = {};

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

// Per-store write overrides — the write-side counterpart to readOverrides
// above, for tests simulating a Blobs write failure (e.g. a quota error, a
// transient storage-layer fault) that the plain synchronous in-memory Map
// can't otherwise reproduce. Keyed by storeName -> { fn, callCount }, same
// closure-scoped-not-on-exports reasoning as readOverrides (see that
// variable's own comment) — every lib/*.js module already has its own
// bound reference to fakeGetStore by the time a test installs an override.
var writeOverrides = {};

// Per-store CAS-result overrides — narrower than writeOverrides above:
// writeOverrides can only make setJSON either throw or perform an ordinary
// write, which can't express "the write resolved normally but with a
// shape blobs10's own real implementation should never actually produce"
// (see lib/first-dream-email-store.js / lib/push-dedup-store.js's own
// defensive "unexpected shape" fail-closed branch, kept even though
// reading node_modules/blobs10/dist/main.cjs's own Store.setJSON shows it
// can only ever resolve with a real `{ modified: boolean }` or throw).
// `fn(key, value, options, callIndex)` returning `{ result }` makes setJSON
// resolve with `result` directly, bypassing the map entirely; a falsy
// return falls through to the normal CAS/unconditional write below.
var resultOverrides = {};

// Monotonic counter for fake etags handed back on a successful CAS write
// (`{ modified: true, etag }`) — real Blobs etags are opaque strings, and
// nothing in this codebase's two CAS call sites reads the etag value back
// (only `modified`), so uniqueness is the only property that matters here.
var etagCounter = 0;

function storeFor(name) {
  if (!stores[name]) stores[name] = new Map();
  return stores[name];
}

function metaStoreFor(name) {
  if (!metaStores[name]) metaStores[name] = new Map();
  return metaStores[name];
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
    setJSON: async function (key, value, options) {
      var override = writeOverrides[name];
      if (override) {
        override.callCount++;
        // `fn` returning a truthy Error (or any truthy value) means "throw
        // this instead of writing" — mirrors real @netlify/blobs' setJSON
        // rejecting on a storage-layer failure. A falsy return falls
        // through to a normal write, same shape as setReadOverride's `fn`.
        var err = override.fn(key, value, override.callCount);
        if (err) throw (err instanceof Error ? err : new Error(String(err)));
      }
      var resultOverride = resultOverrides[name];
      if (resultOverride) {
        resultOverride.callCount++;
        var substituted = resultOverride.fn(key, value, options, resultOverride.callCount);
        if (substituted) return substituted.result;
      }
      // CAS path (`{ onlyIfNew: true }`, blobs10 only — see this file's
      // header comment): the real SDK never throws for an ordinary
      // "already exists" collision, it resolves with `modified: false`
      // instead. Mirrored exactly here, ahead of the unconditional
      // fallthrough below.
      if (options && options.onlyIfNew) {
        if (map.has(key)) return { modified: false };
        map.set(key, value);
        etagCounter++;
        return { modified: true, etag: 'mock-etag-' + etagCounter };
      }
      map.set(key, value);
    },
    delete: async function (key) {
      map.delete(key);
      metaStoreFor(name).delete(key);
    },
    // Binary write, mirroring real @netlify/blobs' Store.set(key, data,
    // {metadata}) — see this file's header comment on `metaStores`. `data`
    // is stored as-is (an ArrayBuffer/Buffer in every real call site this
    // mock supports) — nothing here re-encodes it, same as the real SDK.
    set: async function (key, data, options) {
      var override = writeOverrides[name];
      if (override) {
        override.callCount++;
        var err = override.fn(key, data, override.callCount);
        if (err) throw (err instanceof Error ? err : new Error(String(err)));
      }
      map.set(key, data);
      metaStoreFor(name).set(key, (options && options.metadata) || {});
    },
    // Mirrors real @netlify/blobs' Store.getMetadata(key): { etag,
    // metadata } if the key exists (via either set() or setJSON()), null
    // if not — see this file's header comment.
    getMetadata: async function (key) {
      if (!map.has(key)) return null;
      return { etag: 'mock-etag', metadata: metaStoreFor(name).get(key) || {} };
    },
    // Mirrors real @netlify/blobs' Store.getWithMetadata(key, {type}):
    // { data, etag, metadata } if the key exists, null if not. `type` is
    // ignored here (unlike the real SDK, which converts based on it) —
    // every real call site in this codebase (video-file.mjs/image-file.mjs)
    // just hands `data` straight to a Response constructor, which accepts
    // the raw ArrayBuffer/Buffer this mock already stores just as well as
    // it would a real stream.
    getWithMetadata: async function (key) {
      if (!map.has(key)) return null;
      return { data: map.get(key), etag: 'mock-etag', metadata: metaStoreFor(name).get(key) || {} };
    },
    // Minimal stand-in for real @netlify/blobs' list() — added for
    // tracker item for-product-build-stage-0-pwa-web-push-f-jbutt5's
    // send-daily-claim-pushes.js (this repo's first scheduled function),
    // which has no per-record key to read directly and must enumerate an
    // entire store instead. Only the non-paginated shape
    // (`Promise<{ blobs, directories }>`) is implemented — no real call
    // site in this codebase uses `paginate: true` yet; `directories` is
    // always empty (this mock has no concept of blob "directories", a
    // real-Blobs-only feature no caller here uses).
    //
    // `{ prefix }` filtering added for lib/deploy-log-store.js (tracker
    // item for-product-surface-deploys-day-as-a-vis-xld1vk), the first
    // caller in this codebase to need it — mirrors real @netlify/blobs'
    // own server-side prefix filtering (see ListOptions in
    // node_modules/@netlify/blobs/dist/main.d.ts). Purely additive: no
    // `prefix` (every existing call site) still returns every key in the
    // store, unchanged.
    list: async function (options) {
      var prefix = options && options.prefix;
      var keys = Array.from(map.keys());
      if (prefix) {
        keys = keys.filter(function (key) { return key.indexOf(prefix) === 0; });
      }
      return {
        blobs: keys.map(function (key) { return { key: key, etag: 'mock-etag' }; }),
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

/**
 * Installs a temporary override on every setJSON() call against
 * `storeName`: `fn(key, value, callIndex)` (callIndex starts at 1) is
 * called on every write; returning a truthy value (an Error, or any
 * truthy value) makes setJSON reject with that Error instead of writing,
 * simulating a real Blobs write failure (quota, transient storage fault).
 * Returning a falsy value performs a normal write. Call clearWriteOverride
 * (or reset(), which clears all overrides too) when done.
 */
function setWriteOverride(storeName, fn) {
  writeOverrides[storeName] = { fn: fn, callCount: 0 };
}

/** Removes a single store's write override, if any. */
function clearWriteOverride(storeName) {
  delete writeOverrides[storeName];
}

/**
 * Installs a temporary override on every setJSON() call against
 * `storeName` that substitutes the RESOLVED VALUE directly (rather than
 * throwing, or performing a real write): `fn(key, value, options,
 * callIndex)` (callIndex starts at 1) is called on every write; returning
 * `{ result }` makes setJSON resolve with `result` as-is, bypassing the
 * map entirely (no write happens). A falsy return falls through to the
 * normal CAS/unconditional write. See this override's own declaration
 * comment (near `resultOverrides`) for why this exists separately from
 * setWriteOverride above — it exists for shapes the real SDK's own
 * implementation should never produce, only reachable by deliberately
 * forcing them here. Call clearResultOverride (or reset()) when done.
 */
function setResultOverride(storeName, fn) {
  resultOverrides[storeName] = { fn: fn, callCount: 0 };
}

/** Removes a single store's CAS-result override, if any. */
function clearResultOverride(storeName) {
  delete resultOverrides[storeName];
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

/** Clears all fake store state, including any read/write/result overrides. Call between tests. */
function reset() {
  stores = {};
  metaStores = {};
  readOverrides = {};
  writeOverrides = {};
  resultOverrides = {};
}

/**
 * Installs the fake in place of the real @netlify/blobs AND the real
 * `blobs10` alias (see this file's header comment) for the rest of this
 * process. Call once, before requiring any module that (transitively)
 * requires either package.
 */
function install() {
  var fakeExports = { getStore: fakeGetStore, connectLambda: fakeConnectLambda };
  [require.resolve('@netlify/blobs'), require.resolve('blobs10')].forEach(function (resolved) {
    require.cache[resolved] = {
      id: resolved,
      filename: resolved,
      loaded: true,
      exports: fakeExports
    };
  });
}

module.exports = {
  install, reset, seed,
  setReadOverride, clearReadOverride,
  setWriteOverride, clearWriteOverride,
  setResultOverride, clearResultOverride
};
