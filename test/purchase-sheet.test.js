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

test('PACK_INFO matches shop.html\'s Token Economy C lineup', function () {
  assert.deepEqual(PurchaseSheet.PACK_INFO, {
    pack100: { tokens: 100, price: 2.99 },
    pack300: { tokens: 300, price: 7.99 },
    pack700: { tokens: 700, price: 14.99 }
  });
});

test('neededTokens: the exact shortfall, never negative', function () {
  assert.equal(PurchaseSheet.neededTokens(40, 100), 60);
  assert.equal(PurchaseSheet.neededTokens(0, 10), 10);
  assert.equal(PurchaseSheet.neededTokens(100, 100), 0);
  assert.equal(PurchaseSheet.neededTokens(150, 100), 0, 'never negative even if balance already covers the cost');
});

test('pickSmallestSufficientPack: picks the cheapest pack that alone covers the shortfall', function () {
  assert.equal(PurchaseSheet.pickSmallestSufficientPack(1), 'pack100');
  assert.equal(PurchaseSheet.pickSmallestSufficientPack(60), 'pack100');
  assert.equal(PurchaseSheet.pickSmallestSufficientPack(100), 'pack100');
  assert.equal(PurchaseSheet.pickSmallestSufficientPack(101), 'pack300');
  assert.equal(PurchaseSheet.pickSmallestSufficientPack(300), 'pack300');
  assert.equal(PurchaseSheet.pickSmallestSufficientPack(301), 'pack700');
});

test('pickSmallestSufficientPack: falls back to the largest pack when nothing alone is sufficient', function () {
  assert.equal(PurchaseSheet.pickSmallestSufficientPack(5000), 'pack700');
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
