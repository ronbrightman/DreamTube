// test/purchase-sheet.test.js
//
// Unit coverage for js/purchase-sheet.js's pure (no-DOM) logic — the
// smallest-sufficient-pack selection, the shortfall arithmetic, and the
// daily-grant countdown/wait-line text — required() directly the same way
// test/wizard-chips.test.js already does for js/wizard-chips.js (see that
// file's own dual window/module.exports pattern). DOM/flow behavior (the
// sheet actually appearing, draft persistence, checkout redirect, auto-
// resume, the honest-degrade path) is covered by
// test/out-of-tokens-purchase-sheet-behavioral.test.js instead, since that
// needs a real browser.

var test = require('node:test');
var assert = require('node:assert/strict');

var PurchaseSheet = require('../js/purchase-sheet');

test('PACK_INFO matches shop.html\'s "The Vault" lineup (founder-approved 2026-08-02: $0.99/300 starter, $1.99/500, $4.99/1500, $9.99/4000)', function () {
  assert.deepEqual(PurchaseSheet.PACK_INFO, {
    pack099: { tokens: 300, price: 0.99 },
    pack199: { tokens: 500, price: 1.99 },
    pack499: { tokens: 1500, price: 4.99 },
    pack999: { tokens: 4000, price: 9.99 }
  });
});

test('STARTER_PACK_ID is pack099', function () {
  assert.equal(PurchaseSheet.STARTER_PACK_ID, 'pack099');
});

test('neededTokens: the exact shortfall, never negative', function () {
  assert.equal(PurchaseSheet.neededTokens(40, 100), 60);
  assert.equal(PurchaseSheet.neededTokens(0, 10), 10);
  assert.equal(PurchaseSheet.neededTokens(100, 100), 0);
  assert.equal(PurchaseSheet.neededTokens(150, 100), 0, 'never negative even if balance already covers the cost');
});

test('pickContextualPack: offers the starter (pack099) when this account has never bought a pack before', function () {
  assert.equal(PurchaseSheet.pickContextualPack(1, false), 'pack099');
  assert.equal(PurchaseSheet.pickContextualPack(60, false), 'pack099');
  assert.equal(PurchaseSheet.pickContextualPack(100, false), 'pack099', 'the real max shortfall (a blocked video) is well within the starter\'s 300 tokens');
});

test('pickContextualPack: offers the $1.99 pack (pack199), never the starter, once this account has already bought a pack', function () {
  assert.equal(PurchaseSheet.pickContextualPack(1, true), 'pack199');
  assert.equal(PurchaseSheet.pickContextualPack(100, true), 'pack199');
});

test('pickContextualPack: never offers the two larger packs (pack499/pack999) for a real generation-blocked shortfall, in either eligibility state', function () {
  assert.notEqual(PurchaseSheet.pickContextualPack(100, false), 'pack499');
  assert.notEqual(PurchaseSheet.pickContextualPack(100, false), 'pack999');
  assert.notEqual(PurchaseSheet.pickContextualPack(100, true), 'pack499');
  assert.notEqual(PurchaseSheet.pickContextualPack(100, true), 'pack999');
});

test('pickContextualPack: falls back to the largest ELIGIBLE pack when nothing alone is sufficient, never crossing back into the starter once ineligible', function () {
  assert.equal(PurchaseSheet.pickContextualPack(5000, false), 'pack999');
  assert.equal(PurchaseSheet.pickContextualPack(5000, true), 'pack999', 'still pack999, not pack099, even though pack099 is technically the "first" entry in PACK_ORDER');
});

test('formatTokenCountdown: hours+minutes / minutes-only / "now"', function () {
  var now = Date.now();
  assert.equal(PurchaseSheet.formatTokenCountdown(now + (6 * 3600000) + (12 * 60000)), '6h 12m');
  assert.equal(PurchaseSheet.formatTokenCountdown(now + (42 * 60000)), '42m');
  assert.equal(PurchaseSheet.formatTokenCountdown(now - 1000), 'now');
  assert.equal(PurchaseSheet.formatTokenCountdown(null), '');
});

test('waitLineText: the honest free-path escape line, read live off tokenStatus (2026-07-28 daily-claim switch, claim-framed not grant-framed)', function () {
  var now = Date.now();
  assert.equal(
    PurchaseSheet.waitLineText({ dailyClaimAmount: 20, nextClaimAt: now + (3 * 3600000), claimable: false }),
    'Or claim 20 free tokens in 3h 0m'
  );
});

test('waitLineText: claimable renders a "claim now" line, never a stale countdown (tracker item for-product-build-the-daily-token-claim--fngrwd)', function () {
  var now = Date.now();
  assert.equal(
    PurchaseSheet.waitLineText({ dailyClaimAmount: 20, nextClaimAt: now - 999999, claimable: true }),
    'Or claim 20 free tokens above'
  );
});

test('waitLineText: no tokenStatus / no nextClaimAt -> empty, never throws', function () {
  assert.equal(PurchaseSheet.waitLineText(null), '');
  assert.equal(PurchaseSheet.waitLineText({ dailyClaimAmount: 20, nextClaimAt: null, claimable: false }), '');
});

test('waitLineText: reads the live 100-token first-claim-bonus amount when the server reports it, not a hardcoded 20 (2026-07-28 first-claim-bonus amendment)', function () {
  var now = Date.now();
  assert.equal(
    PurchaseSheet.waitLineText({ dailyClaimAmount: 100, nextClaimAt: now - 999999, claimable: true }),
    'Or claim 100 free tokens above'
  );
});
