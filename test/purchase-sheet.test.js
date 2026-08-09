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

test('PACK_INFO matches shop.html\'s "The Vault" lineup (founder-updated 2026-08-09: $0.99/300 starter, $2.99/500, $4.99/1000, $9.99/2500)', function () {
  assert.deepEqual(PurchaseSheet.PACK_INFO, {
    pack099: { tokens: 300, price: 0.99 },
    pack199: { tokens: 500, price: 2.99 },
    pack499: { tokens: 1000, price: 4.99 },
    pack999: { tokens: 2500, price: 9.99 }
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

test('pickContextualPack: offers the $2.99 pack (pack199), never the starter, once this account has already bought a pack', function () {
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

test('waitLineText: when claimable, renders NOTHING — the de-emphasized quiet claim link below the buy CTA is the affordance now (founder 2026-08-09), and it must never fall through to a stale countdown', function () {
  var now = Date.now();
  assert.equal(
    PurchaseSheet.waitLineText({ dailyClaimAmount: 20, nextClaimAt: now - 999999, claimable: true }),
    ''
  );
});

test('waitLineText: no tokenStatus / no nextClaimAt -> empty, never throws', function () {
  assert.equal(PurchaseSheet.waitLineText(null), '');
  assert.equal(PurchaseSheet.waitLineText({ dailyClaimAmount: 20, nextClaimAt: null, claimable: false }), '');
});

test('waitLineText: the not-yet-claimable countdown reads the live first-claim-bonus amount when the server reports it, not a hardcoded 20 (2026-07-28 amendment; claimable amount now lives on the quiet claim button)', function () {
  var now = Date.now();
  assert.match(
    PurchaseSheet.waitLineText({ dailyClaimAmount: 100, nextClaimAt: now + 999999, claimable: false }),
    /^Or claim 100 free tokens in /
  );
});

// claimErrorCopy (2026-08-05, tracker item for-product-p1-urgent-fresh-
// signup-can-d-qhrrqy round 2, ask #3): a rejected claim must show
// outcome-specific copy, not the same generic message for a genuine
// rate-limit (E4/429) and a genuine transient write failure (E5/500) —
// see this function's own doc comment in js/purchase-sheet.js.
test('claimErrorCopy: E4 rate-limit gets its own honest "try again tomorrow" copy, distinct from the generic retry message', function () {
  var e4 = PurchaseSheet.claimErrorCopy(new Error('E4: rate_limited: too many claim attempts from this network today, try again tomorrow'));
  assert.match(e4, /tomorrow/i);
  assert.doesNotMatch(e4, /try again in a moment/i);
});

test('claimErrorCopy: E5 write-failed and a plain network error both fall through to the generic transient-retry copy (both genuinely worth retrying immediately)', function () {
  var e5 = PurchaseSheet.claimErrorCopy(new Error('E5: claim_write_failed: entitlements.claimDailyTokens: exhausted attempts'));
  var network = PurchaseSheet.claimErrorCopy(new Error('Failed to fetch'));
  var noMessage = PurchaseSheet.claimErrorCopy(new Error());
  var noErrorAtAll = PurchaseSheet.claimErrorCopy(undefined);
  [e5, network, noMessage, noErrorAtAll].forEach(function (copy) {
    assert.match(copy, /try again in a moment/i);
  });
});
