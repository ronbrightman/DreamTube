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

// ───────────────────── $1 ("fifty"/trial50) trial RETIRED 2026-08-11 ─────────────────────
// The trial is always the 3-day FREE trial now; no override or flag can bring
// the $1 paid trial back.

test('assignTrialArm always resolves to free (the $1 arm is retired)', function () {
  var st = fakeStorage();
  var hash = PM.hashAccount('trialuser@example.com');
  assert.equal(PM.assignTrialArm(hash, st, {}), 'free');
  assert.equal(PM.assignTrialArm(hash, st, { forced: 'fifty' }), 'free', 'even a forced fifty resolves to free');
});

test('effectiveTrialArm always returns free — no flag or override revives trial50', function () {
  assert.equal(PM.effectiveTrialArm(), 'free');
  assert.equal(PM.effectiveTrialArm('free'), 'free');
  assert.equal(PM.effectiveTrialArm('fifty', { trial50Enabled: true, forced: 'fifty' }), 'free');
});

test('checkout never selects trial50: a would-be fifty user checks out as freetrial', function () {
  var effective = PM.effectiveTrialArm('fifty');
  assert.equal(effective, 'free');
  assert.equal(PM.passVariantFor(true, effective), 'freetrial', 'toggle-ON is always freetrial, never trial50');
});

// ───────────────────────── passVariant mapping (toggle × trial-arm) ─────────────────────────

test('passVariant mapping table: toggle OFF is always notrial regardless of arm', function () {
  assert.equal(PM.passVariantFor(false, 'free'), 'notrial');
  assert.equal(PM.passVariantFor(false, 'fifty'), 'notrial');
});

test('passVariant mapping table: toggle ON + free -> freetrial', function () {
  assert.equal(PM.passVariantFor(true, 'free'), 'freetrial');
});

test('passVariant is always freetrial for toggle-ON (the $1/trial50 arm is retired)', function () {
  assert.equal(PM.passVariantFor(true, 'fifty'), 'freetrial');
  assert.equal(PM.passVariantFor(true, 'free'), 'freetrial');
});

test('hashAccount normalizes email casing (same account hash regardless of case)', function () {
  assert.equal(PM.hashAccount('MixedCase@Example.com'), PM.hashAccount('mixedcase@example.com'));
});
