// test/paywall-moment.test.js
//
// Pure-logic coverage for js/paywall-moment.js (window.PaywallMoment), the
// post-signup monetization moment's A/B assignment, trial50 gate, and
// passVariant mapping. DOM-free — the browser wiring in wizard.html is
// covered separately by test/paywall-moment-behavioral.test.js.

var test = require('node:test');
var assert = require('node:assert/strict');
var PM = require('../js/paywall-moment');

function fakeStorage() {
  var m = {};
  return {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
    setItem: function (k, v) { m[k] = String(v); },
    _raw: m
  };
}

// ───────────────────────── arm assignment + persistence ─────────────────────────

test('assignArm returns a valid arm and persists it keyed to the account hash', function () {
  var st = fakeStorage();
  var hash = PM.hashAccount('newuser@example.com');
  var arm = PM.assignArm(hash, st, {});
  assert.ok(arm === 'subscription' || arm === 'tokens', 'arm is one of the two arms');
  var persisted = JSON.parse(st._raw[PM.ARM_KEY]);
  assert.equal(persisted.h, hash, 'persisted record carries the account hash');
  assert.equal(persisted.arm, arm, 'persisted arm matches the returned arm');
});

test('assignArm is STABLE for the same account across calls (assigned once per account)', function () {
  var st = fakeStorage();
  var hash = PM.hashAccount('stable@example.com');
  var first = PM.assignArm(hash, st, {});
  var second = PM.assignArm(hash, st, {});
  var third = PM.assignArm(hash, st, {});
  assert.equal(second, first);
  assert.equal(third, first);
});

test('assignArm REASSIGNS when the persisted record belongs to a different account', function () {
  var st = fakeStorage();
  // Pre-seed a record for a DIFFERENT account hash.
  st.setItem(PM.ARM_KEY, JSON.stringify({ h: 'someotherhash', arm: 'tokens' }));
  var hash = PM.hashAccount('mine@example.com');
  var arm = PM.assignArm(hash, st, {});
  var persisted = JSON.parse(st._raw[PM.ARM_KEY]);
  assert.equal(persisted.h, hash, 'the record is rewritten for THIS account');
  assert.equal(persisted.arm, arm);
});

test('assignArm deterministic split: the arm is a pure function of the account hash', function () {
  var st1 = fakeStorage(), st2 = fakeStorage();
  var hash = PM.hashAccount('determinism@example.com');
  assert.equal(PM.assignArm(hash, st1, {}), PM.assignArm(hash, st2, {}), 'same hash -> same arm regardless of storage');
  assert.equal(PM.pickArm(hash), PM.assignArm(hash, st1, {}), 'assignArm agrees with the pure pickArm seed');
});

test('assignArm founder override (?paywall=) wins and is persisted', function () {
  var st = fakeStorage();
  var hash = PM.hashAccount('founder@example.com');
  assert.equal(PM.assignArm(hash, st, { forced: 'tokens' }), 'tokens');
  assert.equal(JSON.parse(st._raw[PM.ARM_KEY]).arm, 'tokens');
  assert.equal(PM.assignArm(hash, st, { forced: 'subscription' }), 'subscription', 'a new forced value overrides the persisted one');
});

test('both arms are reachable across accounts (the split is not degenerate)', function () {
  var seen = {};
  for (var i = 0; i < 200; i++) { seen[PM.pickArm(PM.hashAccount('user' + i + '@example.com'))] = true; }
  assert.ok(seen.subscription && seen.tokens, 'both subscription and tokens occur across a population');
});

test('assignTrialArm persists a raw free/fifty arm, stable per account, override wins', function () {
  var st = fakeStorage();
  var hash = PM.hashAccount('trialuser@example.com');
  var arm = PM.assignTrialArm(hash, st, {});
  assert.ok(arm === 'free' || arm === 'fifty');
  assert.equal(PM.assignTrialArm(hash, st, {}), arm, 'stable per account');
  assert.equal(PM.assignTrialArm(hash, st, { forced: 'fifty' }), 'fifty', 'forced fifty wins');
  assert.equal(PM.assignTrialArm(hash, st, { forced: 'free' }), 'free', 'forced free wins');
});

// ───────────────────────── trial50 gate ─────────────────────────

test('GATE: a raw fifty assignment collapses to free for real users while trial50 is disabled', function () {
  assert.equal(PM.effectiveTrialArm('fifty', { trial50Enabled: false }), 'free', 'real user never sees trial50 when gated');
  assert.equal(PM.effectiveTrialArm('free', { trial50Enabled: false }), 'free', 'free stays free');
});

test('GATE: the ?trialarm=fifty founder override force-reveals trial50 even while gated off', function () {
  assert.equal(PM.effectiveTrialArm('free', { trial50Enabled: false, forced: 'fifty' }), 'fifty', 'founder override reveals trial50');
  assert.equal(PM.effectiveTrialArm('fifty', { trial50Enabled: false, forced: 'fifty' }), 'fifty');
});

test('GATE: when trial50 is enabled globally, a raw fifty stays fifty', function () {
  assert.equal(PM.effectiveTrialArm('fifty', { trial50Enabled: true }), 'fifty');
});

test('GATE (end to end): a real user assigned raw fifty checks out as freetrial, NEVER trial50', function () {
  // Find an account hash that raw-assigns to 'fifty' so this exercises the
  // real collapse path (not just a coincidental 'free').
  var fiftyHash = null;
  for (var i = 0; i < 500 && !fiftyHash; i++) {
    var h = PM.hashAccount('gate' + i + '@example.com');
    if (PM.pickTrialArm(h) === 'fifty') fiftyHash = h;
  }
  assert.ok(fiftyHash, 'found an account that raw-assigns to fifty');
  var st = fakeStorage();
  var raw = PM.assignTrialArm(fiftyHash, st, {});
  assert.equal(raw, 'fifty', 'raw assignment is fifty');
  var effective = PM.effectiveTrialArm(raw, { trial50Enabled: false }); // real user, gate closed
  assert.equal(effective, 'free', 'the real user is shown free, not fifty');
  assert.equal(PM.passVariantFor(true, effective), 'freetrial', 'toggle-ON checks out as freetrial, never trial50');
});

// ───────────────────────── passVariant mapping (toggle × trial-arm) ─────────────────────────

test('passVariant mapping table: toggle OFF is always notrial regardless of arm', function () {
  assert.equal(PM.passVariantFor(false, 'free'), 'notrial');
  assert.equal(PM.passVariantFor(false, 'fifty'), 'notrial');
});

test('passVariant mapping table: toggle ON + free -> freetrial', function () {
  assert.equal(PM.passVariantFor(true, 'free'), 'freetrial');
});

test('passVariant mapping table: toggle ON + fifty -> trial50', function () {
  assert.equal(PM.passVariantFor(true, 'fifty'), 'trial50');
});

test('hashAccount normalizes email casing (same account hash regardless of case)', function () {
  assert.equal(PM.hashAccount('MixedCase@Example.com'), PM.hashAccount('mixedcase@example.com'));
});
