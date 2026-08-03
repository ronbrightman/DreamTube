// test/sw-fetch-handler.test.js
//
// Structural, no-browser-needed coverage of sw.js's actual fetch-handling
// logic (as opposed to test/pwa-sw-update-behavioral.test.js, which covers
// the update-DETECTION lifecycle -- registration.update()/controllerchange/
// visibilitychange-driven reload -- via a real Chromium browser). Added for
// tracker item for-product-urgent-founder-gets-stale-pa-6dn54z: this
// item's own instruction was to trace the ACTUAL fetch-handling logic for
// HTML navigations and media, not just the update-detection layer the
// previous round touched -- this file is exactly that trace, made
// deterministic and independent of any real network/browser.
//
// WHY A VM SANDBOX INSTEAD OF PLAYWRIGHT: test/pwa-sw-update-behavioral
// .test.js's own header comment already documents, from a real throwaway
// debug script, that Playwright's page/context-level request routing
// CANNOT intercept a navigation once a service worker is actually
// controlling the page -- the fetch happens inside the SW's own separate
// execution context. That makes it impossible to inspect, via Playwright,
// exactly what `fetch()` call (and with what `cache` mode) sw.js's own
// fetch handler actually issues. Loading sw.js's real source into a `vm`
// sandbox with a fake `self`/`caches`/`fetch` lets this file invoke the
// REAL, unmodified fetch-handling code directly and inspect precisely what
// it does -- the only way, without a real browser, to prove the `cache:
// 'no-store'` fix (see sw.js's own networkFirst() header comment) is
// actually wired in, not just present in a comment.
//
// HONEST CAVEAT: this proves the MECHANISM (the exact fetch options this
// code issues, the exact caching decisions it makes) in a controlled,
// synthetic environment -- it does NOT and cannot prove how a real iOS
// Safari/WebKit engine's own underlying HTTP stack actually behaves given
// those options, since no WebKit engine exists anywhere in this repo's
// test tooling (confirmed: grepped this whole test/ directory, Chromium
// only). Per this item's own "don't overclaim a device-level fix is
// proven" standing instruction, this file's tests are named and scoped
// around what they can actually prove.

var test = require('node:test');
var assert = require('node:assert/strict');
var vm = require('node:vm');
var fs = require('node:fs');
var path = require('node:path');

var SW_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');

/**
 * Loads sw.js's real, unmodified source into a fresh vm sandbox with a
 * minimal fake service-worker global environment, and returns the captured
 * event listeners plus the fake caches/fetch mocks so a test can drive
 * them directly. `self.addEventListener` here just records callbacks by
 * type (rather than real EventTarget dispatch machinery) -- sw.js only
 * ever registers one listener per event type it cares about, so this is
 * simpler and just as faithful for these tests' purposes.
 */
function loadServiceWorker(options) {
  options = options || {};
  var fetchCalls = [];
  var respond = options.fetchImpl || function () {
    return Promise.reject(new Error('no fetchImpl provided for this test'));
  };
  // Always record the exact Request/input sw.js's own code passed to
  // fetch() -- regardless of which response a given test wants to hand
  // back -- so tests can assert on the outbound call's own properties
  // (e.g. its `cache` mode) independent of what response they're faking.
  var fetchImpl = function (input) {
    fetchCalls.push(input);
    return respond(input);
  };

  var putCalls = [];
  var matchImpl = options.matchImpl || function () { return Promise.resolve(undefined); };
  var cachesStub = {
    open: function () {
      return Promise.resolve({
        put: function (request, response) {
          putCalls.push({ request: request, response: response });
          return Promise.resolve();
        }
      });
    },
    match: function (request) { return matchImpl(request); },
    keys: function () { return Promise.resolve([]); },
    delete: function () { return Promise.resolve(true); }
  };

  var listeners = {};
  var fakeSelf = {
    addEventListener: function (type, fn) {
      listeners[type] = listeners[type] || [];
      listeners[type].push(fn);
    },
    location: { origin: 'https://dreamtube1.netlify.app' },
    skipWaiting: function () { return Promise.resolve(); },
    clients: { claim: function () { return Promise.resolve(); }, matchAll: function () { return Promise.resolve([]); } },
    registration: {}
  };

  var sandbox = {
    self: fakeSelf,
    caches: cachesStub,
    fetch: fetchImpl,
    Request: Request,
    Response: Response,
    URL: URL,
    Promise: Promise,
    console: console,
    importScripts: function () { /* only used by push/notificationclick handlers, unused here */ }
  };
  vm.createContext(sandbox);
  vm.runInContext(SW_SOURCE, sandbox, { filename: 'sw.js' });

  return {
    listeners: listeners,
    fetchCalls: fetchCalls,
    putCalls: putCalls,
    sandbox: sandbox
  };
}

/** Builds a minimal fake FetchEvent -- just enough of the real interface (request, respondWith, waitUntil) for sw.js's own `fetch` listener to use. Captures whatever promise respondWith() was given so the test can await/inspect it. */
function makeFetchEvent(request) {
  var event = { request: request, respondWithPromise: null };
  event.respondWith = function (p) { event.respondWithPromise = p; };
  event.waitUntil = function () { };
  return event;
}

function dispatchFetch(sw, request) {
  var event = makeFetchEvent(request);
  var handlers = sw.listeners.fetch || [];
  assert.equal(handlers.length, 1, 'expected exactly one fetch listener registered');
  handlers[0](event);
  return event;
}

test('navigation requests are fetched with cache: "no-store" -- never trusts the browser HTTP cache layer', async function () {
  var fakeResponse = new Response('<html>fresh</html>', { status: 200, headers: { 'content-type': 'text/html' } });
  var sw = loadServiceWorker({
    fetchImpl: function () { return Promise.resolve(fakeResponse); }
  });

  var navRequest = new Request('https://dreamtube1.netlify.app/home.html', { mode: 'same-origin' });
  // Real navigation requests have mode 'navigate', but the Request
  // constructor refuses to let script set that directly -- Object.defineProperty
  // it after construction so this fixture is faithful to what sw.js's real
  // `event.request` looks like for an actual page navigation.
  Object.defineProperty(navRequest, 'mode', { value: 'navigate' });

  var event = dispatchFetch(sw, navRequest);
  var response = await event.respondWithPromise;

  assert.equal(sw.fetchCalls.length, 1, 'expected exactly one outbound fetch');
  var issuedRequest = sw.fetchCalls[0];
  assert.equal(issuedRequest.cache, 'no-store', 'the outbound fetch for a navigation must explicitly bypass the HTTP cache');
  assert.equal(await response.text(), '<html>fresh</html>');
});

test('cacheable static assets (js/css/manifest) are ALSO fetched with cache: "no-store"', async function () {
  var fakeResponse = new Response('body{}', { status: 200, headers: { 'content-type': 'text/css' } });
  var sw = loadServiceWorker({
    fetchImpl: function () { return Promise.resolve(fakeResponse); }
  });

  var cssRequest = new Request('https://dreamtube1.netlify.app/css/styles.css', { mode: 'same-origin' });
  dispatchFetch(sw, cssRequest);

  assert.equal(sw.fetchCalls.length, 1);
  assert.equal(sw.fetchCalls[0].cache, 'no-store');
});

test('a successful, complete (200) same-origin response is cached via cache.put', async function () {
  var fakeResponse = new Response('<html>ok</html>', { status: 200 });
  // jsdom/undici Response built like this reports type 'default', not
  // 'basic' (that distinction only really exists inside a real Fetch-API
  // client for cross-origin responses) -- sw.js's own check is
  // `response.type === 'basic'`; simulate that faithfully via a thin proxy
  // rather than relying on the environment to produce it naturally.
  var basicResponse = new Proxy(fakeResponse, { get: function (target, prop) { return prop === 'type' ? 'basic' : target[prop]; } });
  var sw = loadServiceWorker({
    fetchImpl: function () { return Promise.resolve(basicResponse); }
  });

  var request = new Request('https://dreamtube1.netlify.app/js/store.js', { mode: 'same-origin' });
  var event = dispatchFetch(sw, request);
  await event.respondWithPromise;
  // cache.put() runs in a separate, unreturned promise chain inside
  // networkFirst -- give the microtask queue a tick to let it settle.
  await new Promise(function (resolve) { setTimeout(resolve, 10); });

  assert.equal(sw.putCalls.length, 1, 'expected the successful response to be cached');
});

test('a 206 Partial Content response is NEVER cached, even though its status is technically in the 2xx range', async function () {
  var partialResponse = new Response('chunk', { status: 206 });
  var basicPartial = new Proxy(partialResponse, { get: function (target, prop) { return prop === 'type' ? 'basic' : target[prop]; } });
  var sw = loadServiceWorker({
    fetchImpl: function () { return Promise.resolve(basicPartial); }
  });

  var request = new Request('https://dreamtube1.netlify.app/js/store.js', { mode: 'same-origin' });
  var event = dispatchFetch(sw, request);
  var response = await event.respondWithPromise;
  await new Promise(function (resolve) { setTimeout(resolve, 10); });

  assert.equal(response.status, 206, 'the real 206 response must still be returned to the page');
  assert.equal(sw.putCalls.length, 0, 'a partial response must never be handed to cache.put -- the Cache Storage spec disallows storing 206 responses');
});

test('a network failure (fetch rejects) falls back to the cached copy of the SAME request', async function () {
  var cachedResponse = new Response('<html>cached</html>', { status: 200 });
  var sw = loadServiceWorker({
    fetchImpl: function () { return Promise.reject(new Error('network down')); },
    matchImpl: function (request) {
      if (request.url === 'https://dreamtube1.netlify.app/home.html') return Promise.resolve(cachedResponse);
      return Promise.resolve(undefined);
    }
  });

  var navRequest = new Request('https://dreamtube1.netlify.app/home.html', { mode: 'same-origin' });
  Object.defineProperty(navRequest, 'mode', { value: 'navigate' });
  var event = dispatchFetch(sw, navRequest);
  var response = await event.respondWithPromise;

  assert.equal(await response.text(), '<html>cached</html>');
});

test('a network failure with NO cached copy of this exact page falls back to offline.html', async function () {
  var offlineResponse = new Response('<html>offline</html>', { status: 200 });
  var sw = loadServiceWorker({
    fetchImpl: function () { return Promise.reject(new Error('network down')); },
    matchImpl: function (request) {
      if (typeof request === 'string' && request.indexOf('offline.html') !== -1) return Promise.resolve(offlineResponse);
      if (request && request.url && request.url.indexOf('offline.html') !== -1) return Promise.resolve(offlineResponse);
      return Promise.resolve(undefined); // no cached copy of the requested page itself
    }
  });

  var navRequest = new Request('https://dreamtube1.netlify.app/some-never-visited-page.html', { mode: 'same-origin' });
  Object.defineProperty(navRequest, 'mode', { value: 'navigate' });
  var event = dispatchFetch(sw, navRequest);
  var response = await event.respondWithPromise;

  assert.equal(await response.text(), '<html>offline</html>');
});

test('non-GET requests are never intercepted at all -- no respondWith() call', function () {
  var sw = loadServiceWorker();
  var postRequest = new Request('https://dreamtube1.netlify.app/.netlify/functions/start-pending-generation', { method: 'POST' });
  var event = makeFetchEvent(postRequest);
  sw.listeners.fetch[0](event);
  assert.equal(event.respondWithPromise, null, 'a POST must pass straight through to native browser handling, completely unintercepted');
});

test('cross-origin requests (e.g. fal.ai media) are never intercepted -- no respondWith() call', function () {
  var sw = loadServiceWorker();
  var falRequest = new Request('https://fal.media/some-generated-video.mp4', { mode: 'no-cors' });
  var event = makeFetchEvent(falRequest);
  sw.listeners.fetch[0](event);
  assert.equal(event.respondWithPromise, null, 'a cross-origin media request must never be intercepted by this worker');
});

test('/.netlify/functions/* GET requests are never intercepted -- no respondWith() call', function () {
  var sw = loadServiceWorker();
  var fnRequest = new Request('https://dreamtube1.netlify.app/.netlify/functions/video-status?jobId=abc', { method: 'GET' });
  var event = makeFetchEvent(fnRequest);
  sw.listeners.fetch[0](event);
  assert.equal(event.respondWithPromise, null, 'a Netlify Function GET call must never be intercepted by this worker');
});

test('a same-origin GET NOT under /css, /js, /assets, or manifest.json (e.g. a top-level .mp4 like the sage-demo pages use) is never intercepted', function () {
  var sw = loadServiceWorker();
  var videoRequest = new Request('https://dreamtube1.netlify.app/sage-optiona-v16-x7q4.mp4', { method: 'GET' });
  var event = makeFetchEvent(videoRequest);
  sw.listeners.fetch[0](event);
  assert.equal(event.respondWithPromise, null, 'a root-level media file must pass straight through, unintercepted -- this worker only runtime-caches /css, /js, /assets, and manifest.json');
});
