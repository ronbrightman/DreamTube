// test/server-analytics-containment.test.js
//
// Regression coverage for the round-4 root cause on tracker.html's
// for-product-bug-founder-affects-all-funn-0efe7t item.
//
// netlify/functions/lib/posthog-capture.js reads POSTHOG_KEY from
// js/analytics-config.js -- a CHECKED-IN file, not an environment variable
// (a deliberate choice, see that file's own header). The side effect nobody
// noticed: any process that require()s the helper and has network access
// fires REAL events into the founder's REAL production PostHog project.
// Measured on this branch before the guard landed, a single `npm test` run
// POSTed 10 real events to us.i.posthog.com every time:
//   5 x first_dream_email_skipped { reason:'no_job_owner_record',
//       distinct_id:'unknown', auto:true }  (generation-completion-marker.test.js)
//   5 x push_sent to alice/frank/grace/henry (send-daily-claim-pushes.test.js)
//
// Those two signatures are precisely what production analytics reviews
// reported as (a) a "machine-generated skip storm ... something is hammering
// mark-generation-completed" and (b) "395 push_sent in 16h to 4 test-fixture
// accounts -- dedup store not working". Neither was production traffic. The
// contamination made the one instrument this bug was being diagnosed with
// untrustworthy, across multiple build/review rounds.
//
// This file locks that shut: the guard's own signal handling, and -- more
// importantly -- an end-to-end assertion that driving the two real server
// paths that used to leak now produces ZERO outbound calls.
// Run with: node --test test/

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();
// Must be installed before ANY module that requires('web-push') is loaded --
// same require.cache-preloading contract as mock-blobs above.
var mockWebPush = require('./helpers/mock-web-push');
mockWebPush.install();

var { fakeEvent } = require('./helpers/fake-event');

var posthogCapture = require('../netlify/functions/lib/posthog-capture');
var { markInstalledFetchAsTestDouble } = require('./helpers/fetch-double');

var realFetch = global.fetch;

/**
 * Replaces global.fetch with a recorder that never performs a real request,
 * and deliberately does NOT carry test/helpers/fetch-double.js's marker --
 * i.e. one that lib/posthog-capture.js's guard must treat exactly as it
 * treats the real network.
 *
 * That is how "prove nothing escapes" gets asserted without ever letting a
 * real request happen: rather than observing the absence of a request on the
 * actual wire (which, if the guard were broken, would mean emitting real
 * production analytics from a test), this recorder stands in for the wire,
 * and any fire that reaches it is a failure. Tests below that want a fire to
 * be ALLOWED call markInstalledFetchAsTestDouble() on top of this.
 */
function installFetchRecorder() {
  var calls = [];
  global.fetch = async function (url, opts) {
    calls.push({ url: String(url), body: opts && opts.body });
    return { ok: true, status: 200, json: async function () { return {}; }, text: async function () { return ''; } };
  };
  return calls;
}

test.beforeEach(function () {
  mockBlobs.reset();
});

test.after(function () {
  global.fetch = realFetch;
});

// ===== the guard itself =====

test('the guard recognizes Node\'s own test runner (NODE_TEST_CONTEXT), which is how `npm test` runs every file in this directory', function () {
  assert.equal(
    posthogCapture.isNonProductionRun(), true,
    'this assertion runs under `node --test`, so the guard must be active right now -- if this ever fails, every test run is writing to production analytics again'
  );
});

test('captureEvent fires nothing when it would reach the real network from a test process, and says so honestly rather than reporting success', async function () {
  var calls = installFetchRecorder();

  assert.equal(posthogCapture.wouldEscapeToRealNetwork(), true);
  var result = await posthogCapture.captureEvent({
    event: 'first_dream_email_skipped',
    distinct_id: 'someone',
    properties: { reason: 'exhausted' }
  });

  assert.equal(calls.length, 0, 'no outbound request at all');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'suppressed_non_production_run');
});

test('a test that has installed its own fetch spy is left alone -- this suite\'s many "assert the event fired" tests must keep working', async function () {
  var calls = installFetchRecorder();
  markInstalledFetchAsTestDouble();

  assert.equal(posthogCapture.wouldEscapeToRealNetwork(), false, 'a marked test double is in place, so nothing can escape -- suppressing here would break every existing spy-based analytics assertion in this suite');
  var result = await posthogCapture.captureEvent({ event: 'e', distinct_id: 'd' });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /posthog/);
});

test('DREAMTUBE_ALLOW_SERVER_ANALYTICS=1 is an explicit escape hatch for a deliberate staged run', async function () {
  var calls = installFetchRecorder();
  process.env.DREAMTUBE_ALLOW_SERVER_ANALYTICS = '1';
  try {
    assert.equal(posthogCapture.isNonProductionRun(), false);
    var result = await posthogCapture.captureEvent({ event: 'e', distinct_id: 'd' });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /posthog/);
  } finally {
    delete process.env.DREAMTUBE_ALLOW_SERVER_ANALYTICS;
  }
});

test('DREAMTUBE_DISABLE_SERVER_ANALYTICS=1 suppresses fires even outside a test runner (a scratch script, a staging replay)', function () {
  var realCtx = process.env.NODE_TEST_CONTEXT;
  var realArgv = process.argv[1];
  delete process.env.NODE_TEST_CONTEXT;
  process.argv[1] = '/some/prod/like/entry.js';
  try {
    assert.equal(posthogCapture.isNonProductionRun(), false, 'baseline: with no signal at all, production behavior is unchanged -- the guard is fail-safe, never fail-silent');
    process.env.DREAMTUBE_DISABLE_SERVER_ANALYTICS = '1';
    assert.equal(posthogCapture.isNonProductionRun(), true);
  } finally {
    delete process.env.DREAMTUBE_DISABLE_SERVER_ANALYTICS;
    if (realCtx === undefined) delete process.env.NODE_TEST_CONTEXT; else process.env.NODE_TEST_CONTEXT = realCtx;
    process.argv[1] = realArgv;
  }
});

test('running a single test file directly (`node test/foo.test.js`, no --test) is also recognized -- NODE_TEST_CONTEXT alone would miss it', function () {
  var realCtx = process.env.NODE_TEST_CONTEXT;
  var realArgv = process.argv[1];
  delete process.env.NODE_TEST_CONTEXT;
  try {
    process.argv[1] = '/repo/test/send-daily-claim-pushes.test.js';
    assert.equal(posthogCapture.isNonProductionRun(), true);
    process.argv[1] = '/var/task/netlify/functions/mark-generation-completed.js';
    assert.equal(posthogCapture.isNonProductionRun(), false, 'a real deployed function entrypoint must NOT be mistaken for a test');
  } finally {
    if (realCtx === undefined) delete process.env.NODE_TEST_CONTEXT; else process.env.NODE_TEST_CONTEXT = realCtx;
    process.argv[1] = realArgv;
  }
});

// ===== the two paths that actually leaked =====

test('CONTAINMENT: the real mark-generation-completed handler, on the exact no-job-owner-record path that leaked, now makes no outbound analytics call', async function () {
  var calls = installFetchRecorder();
  var handler = require('../netlify/functions/mark-generation-completed').handler;

  // A genuinely-verifying mock operationName with NO job-owners record --
  // byte-for-byte the shape test/generation-completion-marker.test.js drives,
  // which used to fire a real first_dream_email_skipped event per test.
  var res = await handler(fakeEvent({
    method: 'POST',
    body: { operationName: 'mock:' + (Date.now() - 60000) + ':containment' },
    headers: { 'x-nf-client-connection-ip': '10.55.0.1' }
  }));

  assert.equal(res.statusCode, 200, 'behavior is unchanged -- this is about what leaves the process, not what the handler returns');
  var posthogCalls = calls.filter(function (c) { return /posthog/.test(c.url); });
  assert.deepEqual(posthogCalls, [], 'no PostHog capture may leave a test process, ever');
});

test('CONTAINMENT: lib/push-sender.js\'s push_sent fire -- the source of the "395 sends to 4 test-fixture accounts" reading -- is contained too', async function () {
  mockWebPush.reset();
  process.env.VAPID_PRIVATE_KEY = 'test-private-key';

  try {
    var calls = installFetchRecorder();
    var pushSender = require('../netlify/functions/lib/push-sender');
    var accountStore = require('../netlify/functions/lib/account-store');
    var pushSubscriptionStore = require('../netlify/functions/lib/push-subscription-store');
    var event = fakeEvent({});

    await accountStore.createAccount(event, { username: 'alice', password: 'hunter22', email: 'alice@example.com' });
    await pushSubscriptionStore.addOrUpdateSubscription(event, 'alice', {
      endpoint: 'https://push.example/alice',
      keys: { p256dh: 'p256dh-key', auth: 'auth-key' }
    });

    await pushSender.sendToUser(event, 'alice', {
      title: 't', body: 'b', url: './profile.html', type: pushSender.PUSH_TYPES.VIDEO_READY
    });

    assert.equal(
      mockWebPush.getSentCalls().length, 1,
      'the push itself must genuinely have gone through -- otherwise the containment assertion below would pass vacuously'
    );
    var posthogCalls = calls.filter(function (c) { return /posthog/.test(c.url); });
    assert.deepEqual(posthogCalls, [], 'the fixture usernames in this repo\'s tests must never appear in the production PostHog project again');
  } finally {
    delete process.env.VAPID_PRIVATE_KEY;
  }
});
