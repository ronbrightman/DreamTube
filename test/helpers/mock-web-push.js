// test/helpers/mock-web-push.js
//
// Minimal in-memory stand-in for the `web-push` npm package — same
// require.cache-preloading trick test/helpers/mock-blobs.js already uses
// for `@netlify/blobs` (see that file's own header comment for the full
// reasoning): every lib/*.js module that requires('web-push') (currently
// just netlify/functions/lib/push-sender.js) resolves to this fake
// instead of hitting a real push service, which this sandbox has no way
// to reach anyway (a real Web Push send needs a real VAPID key pair AND a
// real subscribed browser's push-service endpoint — see
// docs/PWA_PUSH_SETUP.md).
//
// `setResponse(endpoint, response)` lets a test script exactly what
// sendNotification should do for a given subscription's endpoint:
//   - omit / call with no override -> resolves successfully (the default)
//   - `{ reject: true, statusCode }` -> rejects with an Error carrying
//     that statusCode (push-sender.js's own dead-subscription cleanup
//     branch checks statusCode === 404/410)
//
// `reset()` clears every recorded call and override between tests.

var sentCalls = [];
var responseOverrides = {};

function fakeSetVapidDetails(subject, publicKey, privateKey) {
  if (!subject || !publicKey || !privateKey) {
    throw new Error('mock-web-push: setVapidDetails called with a missing argument');
  }
}

function fakeSendNotification(subscription, payload) {
  sentCalls.push({ endpoint: subscription && subscription.endpoint, payload: payload });
  var override = responseOverrides[subscription && subscription.endpoint];
  if (override && override.reject) {
    var err = new Error(override.message || 'mock-web-push: simulated send failure');
    err.statusCode = override.statusCode;
    return Promise.reject(err);
  }
  return Promise.resolve({ statusCode: 201 });
}

function setResponse(endpoint, response) {
  responseOverrides[endpoint] = response;
}

function reset() {
  sentCalls = [];
  responseOverrides = {};
}

function getSentCalls() {
  return sentCalls;
}

/** Installs the fake in place of the real `web-push` for the rest of this process. Call once, before requiring any module that (transitively) requires('web-push'). */
function install() {
  var resolved = require.resolve('web-push');
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: { setVapidDetails: fakeSetVapidDetails, sendNotification: fakeSendNotification }
  };
}

module.exports = { install, reset, setResponse, getSentCalls };
