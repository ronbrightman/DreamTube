// test/channel-republish-license-behavioral.test.js
//
// Covers tracker item for-product-terms-republish-license-per--fhpcxk:
// terms.html's new "Your content" republish-license clause, the passive
// (non-interactive) copy line under result.html's Publish button, the
// per-dream "Feature on DreamTube's channels" opt-out toggle in result.html's
// Edit sheet, and the channel-license consent fields js/store.js's
// publishDream/unpublishDream/deleteDream/setOkToFeatureOnChannels stamp.
//
// Deliberately does NOT test any auto-posting/social-publishing mechanism —
// that's separate, later work, not built here (see the tracker item's own
// "what not to build" scope note). This only covers the terms clause, the
// passive publish-time copy, the opt-out toggle, and the underlying
// license-consent data model.
//
// Follows test/phase1-product-events-behavioral.test.js's conventions:
// node:test + real Chromium via Playwright, DreamStore called directly via
// page.evaluate (cheaper than clicking through full generation flows, per
// AGENT_POLICY.md's "keep generation-testing cost low" guidance — no real
// fal.ai call anywhere in this file), every page.goto wrapped against this
// sandbox's known intermittent third-party-host network stalls.

var test = require('node:test');
var assert = require('node:assert/strict');
var staticServer = require('./helpers/static-server');

var CHROMIUM_PATH = '/opt/pw-browsers/chromium';

var playwright = null;
var unavailableReason = null;
try {
  playwright = require('playwright');
} catch (e1) {
  try {
    playwright = require('/opt/node22/lib/node_modules/playwright');
  } catch (e2) {
    unavailableReason = 'Playwright is not resolvable in this environment (' + e2.message + ')';
  }
}

var server = null;
var browser = null;
var baseUrl = null;

test.before(async function () {
  if (unavailableReason) return;
  server = await staticServer.start();
  baseUrl = server.url;
  try {
    browser = await playwright.chromium.launch({ executablePath: CHROMIUM_PATH });
  } catch (e) {
    unavailableReason = 'Could not launch Chromium at ' + CHROMIUM_PATH + ': ' + e.message;
  }
});

test.after(async function () {
  if (browser) await browser.close();
  if (server) await server.close();
});

function blockThirdParty(page) {
  return page.route(/fonts\.(googleapis|gstatic)\.com|connect\.facebook\.net|i\.posthog\.com/, function (route) {
    route.abort();
  });
}

/** Wraps page.goto with 'domcontentloaded' and tolerates a transient nav failure -- see CLAUDE.md's known environment quirk. */
async function safeGoto(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  } catch (e) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  }
}

/** Mocks the real publish-dream sync call so no network dependency is needed for any of this file's assertions. */
function mockPublishSync(page) {
  return page.route('**/.netlify/functions/publish-dream', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
}
function mockUnpublishSync(page) {
  return page.route('**/.netlify/functions/unpublish-dream', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
}

/** Seeds a logged-in account with one dream directly into localStorage -- mirrors test/phase1-product-events-behavioral.test.js's seedAccount. */
async function seedAccount(page, opts) {
  await safeGoto(page, baseUrl + '/login.html');
  await page.evaluate(function (o) {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@' + o.username, username: o.username };
    if (!state.accounts) state.accounts = {};
    state.accounts[o.username] = { password: 'testpass1', email: o.email || (o.username + '@example.com') };
    if (!state.dreams) state.dreams = [];
    (o.dreams || []).forEach(function (d) {
      state.dreams.push(Object.assign({
        ownerHandle: '@' + o.username,
        caption: 'A test dream',
        style: 'Cinematic',
        isPublished: false,
        likes: 0, likedByMe: false
      }, d));
    });
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, opts);
}

/**
 * Signs a SECOND account into the SAME browser without touching
 * state.dreams -- mirrors test/report-block-behavioral.test.js's loginAs.
 * Deliberately does NOT clear/reset dreams: state.dreams is one array
 * shared across every account that's ever used this browser (see
 * CLAUDE.md), so whatever the first account's seedAccount call already
 * pushed stays sitting there exactly like the real account-scoping gotcha
 * this file's ownership-guard tests below exercise.
 */
async function switchToAccount(page, username) {
  await page.evaluate(function (o) {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@' + o.username, username: o.username };
    if (!state.accounts) state.accounts = {};
    state.accounts[o.username] = { password: 'testpass1', email: o.username + '@example.com' };
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, { username: username });
}

// ===== terms.html clause =====

test('terms.html "Your content" names the republish license, the official channels, the opt-out, and no-backfill', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await safeGoto(page, baseUrl + '/terms.html');
    var bodyText = await page.locator('body').innerText();

    assert.ok(/non-exclusive/i.test(bodyText), 'expected a non-exclusive license grant');
    assert.ok(/worldwide/i.test(bodyText), 'expected "worldwide" in the grant');
    assert.ok(/royalty-free/i.test(bodyText), 'expected "royalty-free" in the grant');
    assert.ok(/social media|social\/promotional|promotional channels/i.test(bodyText), 'expected DreamTube\'s own channels to be named, not just in-app Explore');
    assert.ok(/settings/i.test(bodyText) && /off/i.test(bodyText), 'expected the per-dream opt-out to be mentioned');
    assert.ok(/on or after|not.*retroactiv|never.*retroactiv/i.test(bodyText), 'expected the no-backfill / not-retroactive statement');
  } finally {
    await page.close();
  }
});

// ===== result.html passive publish-time copy =====

test('result.html: passive "may feature it on DreamTube\'s channels" line sits under the Publish modal\'s button, with no checkbox/toggle anywhere in that modal', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  await mockPublishSync(page);
  try {
    await seedAccount(page, {
      username: 'publishcopyuser',
      dreams: [{ id: 'dream-unpublished', videoUrl: 'https://example.com/v.mp4', dur: '0:08', isPublished: false }]
    });
    await safeGoto(page, baseUrl + '/result.html?id=dream-unpublished');

    await page.click('#publish-btn');
    await page.waitForSelector('#modal-publish.open');

    var fineText = await page.locator('#modal-publish-fine').innerText();
    assert.equal(fineText, "Publishing makes your dream public and may feature it on DreamTube's channels.");

    // Zero-click: the modal must not contain any checkbox/toggle input of its own.
    var inputCount = await page.locator('#modal-publish input, #modal-publish .toggle-switch').count();
    assert.equal(inputCount, 0, 'the publish modal must have no checkbox/toggle -- passive copy only');

    // Confirming publish works exactly as before, unaffected by the new copy line.
    await page.click('#publish-confirm');
    var isPublished = await page.evaluate(function () { return window.DreamStore.getDream('dream-unpublished').isPublished; });
    assert.equal(isPublished, true);
  } finally {
    await page.close();
  }
});

// ===== result.html per-dream "Feature on DreamTube's channels" opt-out toggle =====

test('result.html: feature toggle is hidden on an unpublished dream, visible and ON by default once published', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  await mockPublishSync(page);
  try {
    await seedAccount(page, {
      username: 'toggleuser1',
      dreams: [{ id: 'dream-priv', videoUrl: 'https://example.com/v.mp4', dur: '0:08', isPublished: false }]
    });
    await safeGoto(page, baseUrl + '/result.html?id=dream-priv');
    // #open-edit-sheet now opens the new edit-delta sheet by default (docs/
    // EDIT_MECHANISM_SPEC.md) — "Start over instead" reaches the OLD full
    // mini-wizard sheet this test's #feature-toggle-row lives in.
    await page.click('#open-edit-sheet');
    await page.waitForSelector('#sheet-edit-delta-overlay.open');
    await page.click('#delta-start-over-link');
    await page.waitForSelector('#sheet-edit-overlay.open');
    assert.equal(await page.locator('#feature-toggle-row').isVisible(), false, 'must be hidden for a private dream');
    await page.click('#edit-cancel');

    await page.click('#publish-btn'); // opens the publish modal
    await page.click('#publish-confirm');
    // #open-edit-sheet now opens the new edit-delta sheet by default (docs/
    // EDIT_MECHANISM_SPEC.md) — "Start over instead" reaches the OLD full
    // mini-wizard sheet this test's #feature-toggle-row lives in.
    await page.click('#open-edit-sheet');
    await page.waitForSelector('#sheet-edit-delta-overlay.open');
    await page.click('#delta-start-over-link');
    await page.waitForSelector('#sheet-edit-overlay.open');

    assert.equal(await page.locator('#feature-toggle-row').isVisible(), true, 'must be visible once published');
    assert.equal(await page.locator('#feature-toggle').evaluate(function (el) { return el.classList.contains('on'); }), true, 'must default ON -- zero-click means opted-in by default');
    assert.equal(await page.locator('#feature-toggle').getAttribute('aria-checked'), 'true');

    var okToFeature = await page.evaluate(function () { return window.DreamStore.getDream('dream-priv').okToFeatureOnChannels; });
    assert.notEqual(okToFeature, false, 'a freshly-published dream must never be explicitly opted out');
  } finally {
    await page.close();
  }
});

test('result.html: clicking the feature toggle opts a published dream out, persists it, and survives reload', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  await mockPublishSync(page);
  try {
    await seedAccount(page, {
      username: 'toggleuser2',
      dreams: [{ id: 'dream-pub', videoUrl: 'https://example.com/v.mp4', dur: '0:08', isPublished: true }]
    });
    await safeGoto(page, baseUrl + '/result.html?id=dream-pub');
    // #open-edit-sheet now opens the new edit-delta sheet by default (docs/
    // EDIT_MECHANISM_SPEC.md) — "Start over instead" reaches the OLD full
    // mini-wizard sheet this test's #feature-toggle-row lives in.
    await page.click('#open-edit-sheet');
    await page.waitForSelector('#sheet-edit-delta-overlay.open');
    await page.click('#delta-start-over-link');
    await page.waitForSelector('#sheet-edit-overlay.open');

    await page.click('#feature-toggle');
    assert.equal(await page.locator('#feature-toggle').evaluate(function (el) { return el.classList.contains('on'); }), false);
    assert.equal(await page.locator('#feature-toggle-sub').innerText(), 'Off — this dream will never be featured on our channels');

    var okToFeature = await page.evaluate(function () { return window.DreamStore.getDream('dream-pub').okToFeatureOnChannels; });
    assert.equal(okToFeature, false);

    // Reload the page entirely -- confirms this is a real persisted write, not just in-memory UI state.
    await safeGoto(page, baseUrl + '/result.html?id=dream-pub');
    // #open-edit-sheet now opens the new edit-delta sheet by default (docs/
    // EDIT_MECHANISM_SPEC.md) — "Start over instead" reaches the OLD full
    // mini-wizard sheet this test's #feature-toggle-row lives in.
    await page.click('#open-edit-sheet');
    await page.waitForSelector('#sheet-edit-delta-overlay.open');
    await page.click('#delta-start-over-link');
    await page.waitForSelector('#sheet-edit-overlay.open');
    assert.equal(await page.locator('#feature-toggle').evaluate(function (el) { return el.classList.contains('on'); }), false, 'opt-out must survive a reload');

    // Toggling back on flips it back to true and updates the copy.
    await page.click('#feature-toggle');
    assert.equal(await page.locator('#feature-toggle-sub').innerText(), 'On — may appear on our official social/promotional channels');
    var backOn = await page.evaluate(function () { return window.DreamStore.getDream('dream-pub').okToFeatureOnChannels; });
    assert.equal(backOn, true);
  } finally {
    await page.close();
  }
});

// ===== js/store.js: channel-license consent-state fields =====

test('DreamStore.publishDream: a fresh publish stamps channelLicenseGrantedAt and clears any earlier revocation', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  await mockPublishSync(page);
  await mockUnpublishSync(page);
  try {
    await seedAccount(page, {
      username: 'licenseuser1',
      dreams: [{ id: 'd-fresh', videoUrl: 'https://example.com/v.mp4', dur: '0:08', isPublished: false }]
    });
    await safeGoto(page, baseUrl + '/login.html');

    var before = Date.now();
    var afterPublish = await page.evaluate(function () {
      window.DreamStore.publishDream('d-fresh');
      return window.DreamStore.getDream('d-fresh');
    });
    assert.ok(typeof afterPublish.channelLicenseGrantedAt === 'number' && afterPublish.channelLicenseGrantedAt >= before, 'expected a real stamped timestamp');
    assert.equal(afterPublish.channelLicenseRevokedAt, null);

    var afterUnpublish = await page.evaluate(function () {
      window.DreamStore.unpublishDream('d-fresh');
      return window.DreamStore.getDream('d-fresh');
    });
    assert.ok(typeof afterUnpublish.channelLicenseRevokedAt === 'number', 'unpublish must stamp a revocation for a licensed dream');
    assert.equal(afterUnpublish.isPublished, false);

    // Republishing is a FRESH publish action -- re-grants and clears the earlier revocation.
    var republishGrantedAt = afterPublish.channelLicenseGrantedAt;
    var afterRepublish = await page.evaluate(function () {
      window.DreamStore.publishDream('d-fresh');
      return window.DreamStore.getDream('d-fresh');
    });
    assert.equal(afterRepublish.channelLicenseRevokedAt, null, 'a fresh republish must clear the earlier revocation');
    assert.ok(afterRepublish.channelLicenseGrantedAt >= republishGrantedAt, 'expected a new (or equal, if same ms) grant stamp');
  } finally {
    await page.close();
  }
});

test('a dream already published before this shipped (seeded isPublished:true, no stamp) stays unlicensed until it goes through a real publish action -- no backfill', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await seedAccount(page, {
      username: 'legacyuser1',
      // Simulates a dream that was already public before this code shipped:
      // isPublished true, but no channelLicenseGrantedAt at all -- exactly
      // what a pre-existing published dream looks like, since nothing
      // backfills this field onto old records.
      dreams: [{ id: 'd-legacy', videoUrl: 'https://example.com/v.mp4', dur: '0:08', isPublished: true }]
    });
    await safeGoto(page, baseUrl + '/login.html');

    var d = await page.evaluate(function () { return window.DreamStore.getDream('d-legacy'); });
    assert.equal(d.isPublished, true);
    assert.ok(d.channelLicenseGrantedAt === undefined || d.channelLicenseGrantedAt === null, 'a pre-existing published dream must NOT be silently granted the new license');
  } finally {
    await page.close();
  }
});

test('DreamStore.deleteDream: flips channelLicenseRevokedAt on a licensed, published dream before removing it', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  await mockPublishSync(page);
  await mockUnpublishSync(page);
  try {
    await seedAccount(page, {
      username: 'deleteuser1',
      dreams: [{ id: 'd-to-delete', videoUrl: 'https://example.com/v.mp4', dur: '0:08', isPublished: false }]
    });
    await safeGoto(page, baseUrl + '/login.html');

    var result = await page.evaluate(function () {
      window.DreamStore.publishDream('d-to-delete');
      var licensed = window.DreamStore.getDream('d-to-delete');
      var grantedAt = licensed.channelLicenseGrantedAt;
      // Hold the SAME object reference js/store.js mutates in place, so we
      // can observe the revocation stamp landing on it even though the
      // record is about to be removed from state.dreams entirely.
      var deleted = window.DreamStore.deleteDream('d-to-delete');
      return { grantedAt: grantedAt, deleted: deleted, revokedAt: licensed.channelLicenseRevokedAt, stillFound: !!window.DreamStore.getDream('d-to-delete') };
    });
    assert.equal(result.deleted, true);
    assert.equal(result.stillFound, false, 'the dream record itself is gone after delete');
    assert.ok(typeof result.revokedAt === 'number' && result.revokedAt > 0, 'expected the in-place object to have been stamped with a revocation before removal');
  } finally {
    await page.close();
  }
});

test('okToFeatureOnChannels reads as true (on) by default for a dream that never had the field set at all', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await seedAccount(page, {
      username: 'defaultoptuser',
      dreams: [{ id: 'd-no-field', videoUrl: 'https://example.com/v.mp4', dur: '0:08', isPublished: true }]
    });
    await safeGoto(page, baseUrl + '/login.html');
    var d = await page.evaluate(function () { return window.DreamStore.getDream('d-no-field'); });
    assert.notEqual(d.okToFeatureOnChannels, false, 'undefined must read as ON, not off');
  } finally {
    await page.close();
  }
});

// ===== Review finding 1: ownership guard on publishDream/unpublishDream/
// setOkToFeatureOnChannels (two accounts sharing one browser) =====

test('DreamStore.publishDream/unpublishDream/setOkToFeatureOnChannels all refuse to act on another account\'s dream shared in the same browser\'s state.dreams', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  await mockPublishSync(page);
  await mockUnpublishSync(page);
  try {
    // Account A: a never-published dream (for the publishDream attempt --
    // kept untouched by anything else so a leftover grant timestamp can
    // never be mistaken for one B's blocked attempt produced), a
    // sanity-only dream (to prove account A itself can still publish, kept
    // entirely separate so the reset doesn't leave a stale grant on the
    // dream B's attempt is checked against), and an already-published-and-
    // licensed dream with the opt-out explicitly OFF (a value distinct
    // from the true-by-default reading, so a no-op is unambiguous to
    // detect) for the unpublishDream/setOkToFeatureOnChannels attempts.
    await seedAccount(page, {
      username: 'ownerA',
      dreams: [
        { id: 'sanity-dream', videoUrl: 'https://example.com/v.mp4', dur: '0:08', isPublished: false },
        { id: 'shared-unpublished', videoUrl: 'https://example.com/v.mp4', dur: '0:08', isPublished: false },
        {
          id: 'shared-published', videoUrl: 'https://example.com/v.mp4', dur: '0:08',
          isPublished: true, channelLicenseGrantedAt: 1700000000000, okToFeatureOnChannels: false
        }
      ]
    });
    // seedAccount only writes localStorage -- js/store.js reads it into its
    // own in-memory `state` once, at page-load time, so a fresh navigation
    // is required before any DreamStore.* call actually sees the seeded
    // data (same reason every other test in this file that seeds then
    // immediately calls DreamStore.* re-navigates first).
    await safeGoto(page, baseUrl + '/login.html');

    // Sanity check: account A really can act on its own dreams (proves any
    // failure below is the ownership guard, not a broken publishDream) --
    // uses its own dedicated dream so this doesn't leave a stray grant
    // timestamp on 'shared-unpublished', which B's blocked attempt below
    // asserts has NO grant at all.
    var sanity = await page.evaluate(function () {
      return window.DreamStore.publishDream('sanity-dream');
    });
    assert.ok(sanity && sanity.isPublished, 'sanity: the owning account must still be able to publish its own dream');

    // Same browser, second account signs in -- state.dreams (all of
    // account A's dreams above) is still sitting there in localStorage,
    // untouched by switchToAccount itself. Another fresh navigation is
    // needed again here, for the same reason as above, before evaluating
    // as account B.
    await switchToAccount(page, 'ownerB');
    await safeGoto(page, baseUrl + '/login.html');

    var result = await page.evaluate(function () {
      var publishReturn = window.DreamStore.publishDream('shared-unpublished');
      var afterPublish = window.DreamStore.getDream('shared-unpublished');

      var unpublishReturn = window.DreamStore.unpublishDream('shared-published');
      var afterUnpublish = window.DreamStore.getDream('shared-published');

      var toggleReturn = window.DreamStore.setOkToFeatureOnChannels('shared-published', true);
      var afterToggle = window.DreamStore.getDream('shared-published');

      return {
        publishReturn: publishReturn, afterPublishIsPublished: afterPublish.isPublished, afterPublishGrantedAt: afterPublish.channelLicenseGrantedAt,
        unpublishReturn: unpublishReturn, afterUnpublishIsPublished: afterUnpublish.isPublished, afterUnpublishRevokedAt: afterUnpublish.channelLicenseRevokedAt,
        toggleReturn: toggleReturn, afterToggleOkToFeature: afterToggle.okToFeatureOnChannels
      };
    });

    // publishDream: a non-owner must not be able to publish account A's dream.
    assert.ok(!result.publishReturn, 'publishDream must return falsy for another account\'s dream');
    assert.equal(result.afterPublishIsPublished, false, 'the dream must stay unpublished');
    assert.ok(!result.afterPublishGrantedAt, 'no license must be granted by a non-owner\'s publish attempt');

    // unpublishDream: a non-owner must not be able to unpublish account A's dream.
    assert.ok(!result.unpublishReturn, 'unpublishDream must return falsy for another account\'s dream');
    assert.equal(result.afterUnpublishIsPublished, true, 'the dream must stay published');
    assert.ok(!result.afterUnpublishRevokedAt, 'no revocation must be stamped by a non-owner\'s unpublish attempt');

    // setOkToFeatureOnChannels: a non-owner must not be able to flip account A's opt-out.
    assert.ok(!result.toggleReturn, 'setOkToFeatureOnChannels must return falsy for another account\'s dream');
    assert.equal(result.afterToggleOkToFeature, false, 'the opt-out must stay exactly as account A left it');
  } finally {
    await page.close();
  }
});

// ===== Review finding 2: result.html hides owner-only actions on a dream
// that isn't the signed-in account's own =====

test('result.html: Publish/Edit/Delete are hidden (and the feature toggle stays hidden) when the loaded dream belongs to a different account, while viewing itself still works', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  await mockPublishSync(page);
  await mockUnpublishSync(page);
  try {
    // Account A publishes a dream (so it's the "someone else's published
    // dream, viewed via a direct link" case this finding is about).
    await seedAccount(page, {
      username: 'resultOwnerA',
      dreams: [{
        id: 'not-mine-dream', videoUrl: 'https://example.com/v.mp4', dur: '0:08',
        caption: 'A dream that is not the viewer\'s own', isPublished: true,
        channelLicenseGrantedAt: 1700000000000, okToFeatureOnChannels: true
      }]
    });

    // Account B (same browser) is signed in when it opens the link.
    await switchToAccount(page, 'resultViewerB');
    await safeGoto(page, baseUrl + '/result.html?id=not-mine-dream');

    // Viewing stays open: the page must load this dream's own content, not
    // redirect away or blank out.
    assert.match(await page.locator('#result-quote').innerText(), /A dream that is not the viewer's own/);

    // Owner-only actions must be hidden.
    assert.equal(await page.locator('#publish-btn').isVisible(), false, 'Publish must be hidden for a dream that is not the viewer\'s own');
    assert.equal(await page.locator('#open-edit-sheet').isVisible(), false, 'Edit must be hidden for a dream that is not the viewer\'s own');
    assert.equal(await page.locator('#delete-btn').isVisible(), false, 'Delete must be hidden for a dream that is not the viewer\'s own');
    assert.equal(await page.locator('#feature-toggle-row').isVisible(), false, 'the feature-on-channels toggle must be hidden for a dream that is not the viewer\'s own');

    // "Make another" doesn't touch this dream at all -- must stay visible.
    assert.equal(await page.locator('#make-another-btn').isVisible(), true, 'Make another is unrelated to this dream\'s ownership and must stay visible');

    // Defense in depth: even if a hidden control were clicked directly,
    // js/store.js's own ownership guard (finding 1) must still refuse it.
    var stillNotMine = await page.evaluate(function () {
      window.DreamStore.publishDream('not-mine-dream'); // already published -- this call is a no-op either way, but must not throw or grant a fresh license under account B
      return window.DreamStore.getDream('not-mine-dream').okToFeatureOnChannels;
    });
    assert.equal(stillNotMine, true, 'account A\'s own opt-out choice must be untouched');

    // Now load the SAME dream signed in as its real owner -- the actions
    // must be visible again, proving this is a real ownership comparison,
    // not just "always hidden".
    await switchToAccount(page, 'resultOwnerA');
    await safeGoto(page, baseUrl + '/result.html?id=not-mine-dream');
    assert.equal(await page.locator('#publish-btn').isVisible(), true, 'Publish must be visible again for the actual owner');
    assert.equal(await page.locator('#open-edit-sheet').isVisible(), true, 'Edit must be visible again for the actual owner');
    assert.equal(await page.locator('#delete-btn').isVisible(), true, 'Delete must be visible again for the actual owner');
  } finally {
    await page.close();
  }
});

// ===== SECOND round (superseded by Interpretation Wave 1, tracker item
// for-product-build-interpretation-wave-1--xuftyn): the ownership guard on
// the OLD generateInterpretation/getInterpretation methods is now a guard
// on their replacements, DreamStore.requestInterpretationQuestions/
// generateInterpretationReading/getInterpretations (see js/store.js's own
// header comment) -- same ownership comparison, same "hidden pill /
// rejected write / null read for a non-owner" contract, re-verified below
// against the actual current methods rather than left testing code that no
// longer exists. THIRD round's `?openInterp=1` deep-link angle is gone
// entirely too (see test/home-behavioral.test.js's own comment on that
// mechanism's removal) -- the private-read leak this originally guarded
// against is re-verified directly against getInterpretations instead,
// since that's the only path into a saved reading now (no query-param
// synthetic-click surface left to worry about). =====

/** Mocks interpret-dream.js's mode:"reading" response, matching js/store.js's generateInterpretationReading's expected {interpretation} shape. */
function mockInterpretDreamReading(page, text) {
  return page.route('**/.netlify/functions/interpret-dream', function (route) {
    var body = JSON.parse(route.request().postData() || '{}');
    if (body.mode === 'reading') {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ interpretation: text || 'A reflection.' }) });
      return;
    }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ questions: [] }) });
  });
}

test('DreamStore.requestInterpretationQuestions/generateInterpretationReading refuse to act on another account\'s dream shared in the same browser\'s state.dreams, and the interpretation pill is hidden for it -- both work normally for the real owner', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  await mockInterpretDreamReading(page, 'Should never be reached by a non-owner.');
  try {
    // Account A: a dream with no saved interpretation yet.
    await seedAccount(page, {
      username: 'interpOwnerA',
      dreams: [{ id: 'not-mine-interp-dream', videoUrl: 'https://example.com/v.mp4', dur: '0:08', isPublished: false }]
    });

    // Account B (same browser) signs in and opens the same dream via a
    // direct link -- state.dreams still has account A's dream sitting there.
    await switchToAccount(page, 'interpViewerB');
    await safeGoto(page, baseUrl + '/result.html?id=not-mine-interp-dream');

    // The pill must never even appear for a dream that isn't this account's own.
    assert.equal(await page.locator('#interp-cta-btn').isVisible(), false, 'the interpretation pill must be hidden for a dream that is not the viewer\'s own');

    // Defense in depth: even if invoked directly, js/store.js's own
    // ownership guard must reject the promise and leave the dream untouched.
    var blockedQuestions = await page.evaluate(function () {
      return window.DreamStore.requestInterpretationQuestions('not-mine-interp-dream', 'jung').then(
        function (resolved) { return { rejected: false, resolved: resolved }; },
        function (err) { return { rejected: true, message: err.message }; }
      );
    });
    assert.equal(blockedQuestions.rejected, true, 'requestInterpretationQuestions must reject for another account\'s dream');
    var blockedReading = await page.evaluate(function () {
      return window.DreamStore.generateInterpretationReading('not-mine-interp-dream', 'jung', []).then(
        function (resolved) { return { rejected: false, resolved: resolved }; },
        function (err) { return { rejected: true, message: err.message }; }
      );
    });
    assert.equal(blockedReading.rejected, true, 'generateInterpretationReading must reject for another account\'s dream');
    var stillUntouched = await page.evaluate(function () { return window.DreamStore.getDream('not-mine-interp-dream'); });
    assert.equal(stillUntouched.interpretations, undefined, 'no interpretation must be written by a non-owner\'s attempt');

    // Now sign back in as the real owner -- both the pill and the store
    // functions must work normally again, proving this is a real
    // ownership comparison and not just "always blocked".
    await switchToAccount(page, 'interpOwnerA');
    await safeGoto(page, baseUrl + '/result.html?id=not-mine-interp-dream');
    assert.equal(await page.locator('#interp-cta-btn').isVisible(), true, 'the interpretation pill must be visible again for the actual owner');

    await page.click('#interp-cta-btn');
    await page.waitForSelector('.itp-persona-card[data-key="jung"]', { state: 'visible', timeout: 5000 });
    await page.click('.itp-persona-card[data-key="jung"]');
    await page.waitForSelector('#itp-reading-text', { state: 'visible', timeout: 5000 });
    var bodyText = await page.locator('#itp-reading-text').textContent();
    assert.equal(bodyText, 'Should never be reached by a non-owner.');

    var allowedResult = await page.evaluate(function () { return window.DreamStore.getDream('not-mine-interp-dream'); });
    assert.equal(allowedResult.interpretations.jung.text, 'Should never be reached by a non-owner.', 'the real owner must still be able to generate an interpretation for their own dream');
  } finally {
    await page.close();
  }
});

test('DreamStore.getInterpretations refuses to return another account\'s already-saved interpretation (even a pre-wave-1 legacy one) -- still returns it correctly for the real owner', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    // Account A: a dream that ALREADY has a saved, private interpretation
    // -- the OLD legacy shape (pre-wave-1), the exact kind
    // ensureInterpretationsMigrated's lazy migration reads.
    await seedAccount(page, {
      username: 'interpReadOwnerA',
      dreams: [{
        id: 'already-interpreted-dream', videoUrl: 'https://example.com/v.mp4', dur: '0:08', isPublished: false,
        interpretationText: 'Account A\'s private reflection -- must never leak to account B.',
        interpretationAt: Date.now()
      }]
    });

    // Account B (same browser, same shared state.dreams) reads it directly.
    // A safeGoto is required after switchToAccount -- js/store.js reads
    // localStorage into its in-memory state once at page load, so an
    // evaluate() immediately after a localStorage write would still see the
    // PREVIOUS account's in-memory state (same reload requirement this
    // file's own round-2 test discovered).
    await switchToAccount(page, 'interpReadViewerB');
    await safeGoto(page, baseUrl + '/result.html?id=already-interpreted-dream');
    var leaked = await page.evaluate(function () { return window.DreamStore.getInterpretations('already-interpreted-dream'); });
    assert.equal(leaked, null, 'getInterpretations must return null for a dream that is not the current account\'s own, even when a saved interpretation exists');

    // The pill itself must also stay hidden for account B, and no trace of
    // the saved text can appear anywhere on the page.
    assert.equal(await page.locator('#interp-cta-btn').isVisible(), false, 'the pill stays hidden for a non-owned dream');
    var pageText = await page.locator('#app').textContent();
    assert.doesNotMatch(pageText, /must never leak to account B/, 'account A\'s saved interpretation text must not appear anywhere on the page for account B');

    // Sign back in as the real owner -- the exact same read must succeed
    // normally, migrated into interpretations.classic.
    await switchToAccount(page, 'interpReadOwnerA');
    await safeGoto(page, baseUrl + '/result.html?id=already-interpreted-dream');
    var ownResult = await page.evaluate(function () { return window.DreamStore.getInterpretations('already-interpreted-dream'); });
    assert.equal(ownResult.classic.text, 'Account A\'s private reflection -- must never leak to account B.', 'the real owner must still read their own saved interpretation normally, migrated under the classic key');
  } finally {
    await page.close();
  }
});
