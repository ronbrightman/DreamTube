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
    await page.click('#open-edit-sheet');
    await page.waitForSelector('#sheet-edit-overlay.open');
    assert.equal(await page.locator('#feature-toggle-row').isVisible(), false, 'must be hidden for a private dream');
    await page.click('#edit-cancel');

    await page.click('#publish-btn'); // opens the publish modal
    await page.click('#publish-confirm');
    await page.click('#open-edit-sheet');
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
    await page.click('#open-edit-sheet');
    await page.waitForSelector('#sheet-edit-overlay.open');

    await page.click('#feature-toggle');
    assert.equal(await page.locator('#feature-toggle').evaluate(function (el) { return el.classList.contains('on'); }), false);
    assert.equal(await page.locator('#feature-toggle-sub').innerText(), 'Off — this dream will never be featured on our channels');

    var okToFeature = await page.evaluate(function () { return window.DreamStore.getDream('dream-pub').okToFeatureOnChannels; });
    assert.equal(okToFeature, false);

    // Reload the page entirely -- confirms this is a real persisted write, not just in-memory UI state.
    await safeGoto(page, baseUrl + '/result.html?id=dream-pub');
    await page.click('#open-edit-sheet');
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
