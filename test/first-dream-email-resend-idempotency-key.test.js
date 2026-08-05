// test/first-dream-email-resend-idempotency-key.test.js
//
// Covers the PROVIDER-SIDE idempotency fix (tracker item
// for-product-triple-first-dream-email-fou-2pyopo, ask #1 only): the
// `Idempotency-Key` header lib/first-dream-email-sender.js's `sendIfEligible`
// now sends on every outbound Resend call.
//
// WHY A SEPARATE FILE rather than folding into
// test/automatic-first-dream-email.test.js or test/first-dream-email-store
// .test.js: this specifically has to reproduce the real incident's own
// failure mechanism -- firstDreamEmailStore.markSentOnce's CAS guard
// deciding "safe to send" a SECOND time for the SAME account, because that
// decision was made against a stale Blobs replica during a real
// consistency-degradation window (see the tracker item's own diagnosis, and
// first-dream-email-store.js's header comment). Under this suite's own
// mock-blobs (test/helpers/mock-blobs.js), the CAS map is a synchronous,
// perfectly-consistent in-memory Map -- it can NEVER be fooled into
// returning `modified:true` twice for the same key, so it cannot reproduce
// the incident on its own. To actually exercise "the code path that WOULD
// duplicate-send if the CAS layer were bypassed/degraded" (this task's own
// verification instruction), this file monkeypatches
// firstDreamEmailStore.markSentOnce itself to return a winning claim on
// EVERY call for the same account -- standing in for "our own storage-side
// dedup marker said yes twice," the exact real-world failure this header
// exists to survive. That is the whole point of a PROVIDER-side defense:
// it must hold even when our own storage layer's answer can't be trusted.
//
// Run with: node --test test/

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var { markInstalledFetchAsTestDouble } = require('./helpers/fetch-double');

var realFetch = global.fetch;

test.beforeEach(function () {
  global.fetch = realFetch;
  mockBlobs.reset();
  delete require.cache[require.resolve('../netlify/functions/lib/first-dream-email-store')];
  delete require.cache[require.resolve('../netlify/functions/lib/first-dream-email-sender')];
  process.env.RESEND_API_KEY = 'resend-test-key';
});
test.after(function () {
  global.fetch = realFetch;
  delete process.env.RESEND_API_KEY;
});

/**
 * Spies on global.fetch, capturing both the parsed body AND the raw headers
 * object for every outbound Resend call -- test/automatic-first-dream-email
 * .test.js's own installFetchSpy only keeps `body`, which is exactly why
 * this file needs its own (the whole point here is asserting on the
 * Idempotency-Key HEADER, not the body).
 */
function installHeaderCapturingFetchSpy() {
  var resendCalls = [];
  global.fetch = async function (url, opts) {
    var urlStr = String(url);
    if (urlStr.indexOf('api.resend.com') !== -1) {
      resendCalls.push({
        url: urlStr,
        headers: (opts && opts.headers) || {},
        body: opts && opts.body ? JSON.parse(opts.body) : null
      });
      return { ok: true, status: 200, json: async function () { return {}; } };
    }
    if (urlStr.indexOf('/capture/') !== -1) {
      return { ok: true, status: 200, json: async function () { return {}; } };
    }
    throw new Error('unexpected fetch to ' + urlStr);
  };
  markInstalledFetchAsTestDouble();
  return resendCalls;
}

/**
 * Forces firstDreamEmailStore.markSentOnce to report a WINNING claim on
 * every call, for any username -- modeling the real incident's own root
 * cause (a CAS decision made against a stale replica during a Blobs
 * consistency-degradation window let 2-3 real send attempts each believe
 * they'd won the once-ever claim). Returns a restore() to put the real
 * function back, same "monkeypatch + restore in finally" shape as
 * test/automatic-first-dream-email.test.js's own withPastClock helper for
 * Date.now.
 */
function forceGuardToAlwaysWin() {
  var firstDreamEmailStore = require('../netlify/functions/lib/first-dream-email-store');
  var realMarkSentOnce = firstDreamEmailStore.markSentOnce;
  firstDreamEmailStore.markSentOnce = async function (event, username) {
    return { ok: true, claimId: 'degraded-cas-claim-' + Math.random().toString(36).slice(2) };
  };
  return function restore() {
    firstDreamEmailStore.markSentOnce = realMarkSentOnce;
  };
}

test('DEGRADED-CAS REPRODUCTION: three send attempts for the SAME account, each believing (via a forced-always-winning guard) it alone won the once-ever claim, all carry the IDENTICAL Idempotency-Key -- the provider-side defense this task exists to add', async function () {
  var resendCalls = installHeaderCapturingFetchSpy();
  var sender = require('../netlify/functions/lib/first-dream-email-sender');
  var restore = forceGuardToAlwaysWin();

  try {
    for (var i = 0; i < 3; i++) {
      var result = await sender.sendIfEligible(fakeEvent({ headers: { host: 'dreamtube1.netlify.app' } }), {
        username: 'triplesenduser',
        email: 'triplesenduser@example.com',
        dreamId: 'dream-' + i,
        auto: true
      });
      assert.equal(result.sent, true, 'test setup: each of the 3 attempts must have genuinely reached (and been accepted by) the Resend call path -- otherwise this isn\'t reproducing the incident at all');
    }
  } finally {
    restore();
  }

  assert.equal(resendCalls.length, 3, 'test setup: this must have actually made 3 separate outbound Resend calls (the storage-side guard alone did NOT stop them -- that is the whole point of needing a provider-side defense)');

  var keys = resendCalls.map(function (c) { return c.headers['Idempotency-Key']; });
  keys.forEach(function (k) {
    assert.equal(typeof k, 'string', 'every Resend call must carry a real Idempotency-Key header value');
    assert.ok(k.length > 0 && k.length <= 256, 'Resend documents a 1-256 char limit on Idempotency-Key');
  });
  assert.equal(keys[0], keys[1], 'attempt 1 and attempt 2, for the SAME underlying send event, must compute the SAME Idempotency-Key -- this is exactly what lets Resend itself collapse the duplicates the storage-side guard failed to catch');
  assert.equal(keys[1], keys[2], 'attempt 2 and attempt 3 must also share the same key as attempt 1');
  // Deterministic, not random/time-based -- see this file's header comment
  // and lib/first-dream-email-sender.js's own derivation comment.
  assert.equal(keys[0], 'first-dream-email:triplesenduser', 'the key must be derived from firstDreamEmailStore\'s own normalizeUsername(username) -- the exact identity markSentOnce\'s own CAS claim already uses');
});

test('a DIFFERENT account never shares a key with another account\'s send -- no cross-account key collision', async function () {
  var resendCalls = installHeaderCapturingFetchSpy();
  var sender = require('../netlify/functions/lib/first-dream-email-sender');

  await sender.sendIfEligible(fakeEvent({ headers: { host: 'dreamtube1.netlify.app' } }), {
    username: 'accountone', email: 'accountone@example.com', dreamId: 'dream-a'
  });
  await sender.sendIfEligible(fakeEvent({ headers: { host: 'dreamtube1.netlify.app' } }), {
    username: 'accounttwo', email: 'accounttwo@example.com', dreamId: 'dream-b'
  });

  assert.equal(resendCalls.length, 2);
  var keyOne = resendCalls[0].headers['Idempotency-Key'];
  var keyTwo = resendCalls[1].headers['Idempotency-Key'];
  assert.notEqual(keyOne, keyTwo, 'two different accounts must never compute the same Idempotency-Key');
  assert.equal(keyOne, 'first-dream-email:accountone');
  assert.equal(keyTwo, 'first-dream-email:accounttwo');
});

test('the key is stable across username case/whitespace variance, matching normalizeUsername -- both layers must agree on identity', async function () {
  var resendCalls = installHeaderCapturingFetchSpy();
  var sender = require('../netlify/functions/lib/first-dream-email-sender');
  var restore = forceGuardToAlwaysWin(); // bypass the real guard so BOTH calls genuinely reach Resend, regardless of casing

  try {
    await sender.sendIfEligible(fakeEvent({ headers: { host: 'dreamtube1.netlify.app' } }), {
      username: 'CaseVariant', email: 'casevariant@example.com', dreamId: 'dream-1'
    });
    await sender.sendIfEligible(fakeEvent({ headers: { host: 'dreamtube1.netlify.app' } }), {
      username: '  casevariant  ', email: 'casevariant@example.com', dreamId: 'dream-2'
    });
  } finally {
    restore();
  }

  assert.equal(resendCalls.length, 2);
  assert.equal(resendCalls[0].headers['Idempotency-Key'], resendCalls[1].headers['Idempotency-Key'], 'differently-cased/whitespaced usernames for the same real account must still collapse to the same key, same as normalizeUsername already guarantees for the CAS guard itself');
});

test('a genuinely different dreamId for the SAME account still computes the SAME key -- the guard\'s own record is per-account, not per-dream, and the idempotency key must agree', async function () {
  var resendCalls = installHeaderCapturingFetchSpy();
  var sender = require('../netlify/functions/lib/first-dream-email-sender');
  var restore = forceGuardToAlwaysWin();

  try {
    await sender.sendIfEligible(fakeEvent({ headers: { host: 'dreamtube1.netlify.app' } }), {
      username: 'perdreamuser', email: 'perdreamuser@example.com', dreamId: 'dream-alpha'
    });
    await sender.sendIfEligible(fakeEvent({ headers: { host: 'dreamtube1.netlify.app' } }), {
      username: 'perdreamuser', email: 'perdreamuser@example.com', dreamId: 'dream-beta'
    });
  } finally {
    restore();
  }

  assert.equal(resendCalls.length, 2);
  assert.equal(resendCalls[0].headers['Idempotency-Key'], resendCalls[1].headers['Idempotency-Key']);
});

test('WITHOUT the forced-guard bypass, the real CAS guard alone already stops a 2nd real attempt -- the Idempotency-Key is genuine belt-and-suspenders, not the only defense in the normal (non-degraded) case', async function () {
  var resendCalls = installHeaderCapturingFetchSpy();
  var sender = require('../netlify/functions/lib/first-dream-email-sender');

  var first = await sender.sendIfEligible(fakeEvent({ headers: { host: 'dreamtube1.netlify.app' } }), {
    username: 'normaluser', email: 'normaluser@example.com', dreamId: 'dream-1'
  });
  var second = await sender.sendIfEligible(fakeEvent({ headers: { host: 'dreamtube1.netlify.app' } }), {
    username: 'normaluser', email: 'normaluser@example.com', dreamId: 'dream-2'
  });

  assert.equal(first.sent, true);
  assert.equal(second.sent, false);
  assert.equal(second.skipped, 'already_sent');
  assert.equal(resendCalls.length, 1, 'the real (non-degraded) CAS guard already prevents a second outbound Resend call entirely -- the header on the one real call is still present as belt-and-suspenders');
  assert.equal(resendCalls[0].headers['Idempotency-Key'], 'first-dream-email:normaluser');
});
