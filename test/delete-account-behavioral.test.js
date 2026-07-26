// test/delete-account-behavioral.test.js
//
// Real browser-driven coverage for the account-deletion flow's CLIENT
// side — profile.html's Settings > Danger zone entry point,
// #modal-delete-account's deliberate-confirmation gate, and js/store.js's
// DreamStore.deleteAccount/wipeAllLocalState. The server side (the actual
// deletion logic — account/entitlement/feed sweep, password re-check,
// rate limiting) is covered directly in test/delete-account.test.js; this
// file covers what a real user's taps/typing actually do, and exactly
// what's left in localStorage afterward.
//
// Follows test/profile-me-character-behavioral.test.js's/
// test/logout-clears-pendingjob-behavioral.test.js's conventions: a plain
// static file server (no real Netlify Functions runtime — delete-account.js
// is intercepted via page.route(), same as get-token-status/track-conversion
// elsewhere in this repo), real Chromium via Playwright, blockThirdParty()
// for this sandbox's flaky outbound network, and safeGoto() to tolerate a
// transient nav failure (see CLAUDE.md's known environment quirk).

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

async function safeGoto(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  } catch (e) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  }
}

/** Same shortcut test/profile-me-character-behavioral.test.js's seedUser uses — seeds a logged-in account directly into localStorage rather than driving signup. Also seeds the small device-level flags (feed backfill + persist-asked) and the account-unrelated sound pref, so tests can confirm deleteAccount's wipe leaves ALL of these alone — none of them are this account's data (see wipeAllLocalState's own comment). */
async function seedUser(page, opts) {
  opts = opts || {};
  await safeGoto(page, baseUrl + '/login.html');
  await page.evaluate(function (opts) {
    var state = {
      user: { handle: '@tester', username: 'tester' },
      accounts: { tester: { password: opts.password, email: 'tester@example.com' } },
      draft: { caption: '', style: null, sourceDreamId: null, restore: false, characterIds: [], cameraView: null, sceneryTime: null, sceneryPlace: null, mediaType: null, sourceImageUrl: null },
      // NOT "d1" -- js/store.js's migrateLegacyState strips any dream id
      // matching /^d[0-5]$/ as stale pre-fal.ai mock seed data on load.
      dreams: [{ id: 'private-dream-1', ownerHandle: '@tester', caption: 'a private dream', style: 'Cartoon', likes: 0, likedByMe: false, isPublished: false, videoUrl: 'https://x/v.mp4', mediaType: 'video' }],
      pendingJob: null,
      charactersByUser: { tester: [{ id: 'c1', name: 'Me', isSelf: true, description: 'tall' }] },
      likedIds: {}
    };
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    localStorage.setItem('dreamtube_feed_backfill_v1_done', '1');
    localStorage.setItem('dreamtube_persist_asked_v1', '1');
    localStorage.setItem('dreamtube_sound_on', '1');
  }, { password: opts.password || 'realpassword1' });
}

/** Intercepts the real network call to delete-account.js — no local Netlify Functions runtime is available to these tests (see test/helpers/static-server.js's own doc comment), same pattern as this repo's other behavioral tests for get-token-status/track-conversion. Also records every request body it saw, so a test can assert the call never fired at all. */
function mockDeleteAccount(page, response) {
  var calls = [];
  page.route('**/.netlify/functions/delete-account', function (route) {
    calls.push(JSON.parse(route.request().postData()));
    route.fulfill({ status: response.status || 200, contentType: 'application/json', body: JSON.stringify(response.body) });
  });
  return calls;
}

async function openSettingsAndDangerZone(page) {
  await page.click('#account-btn');
  await page.waitForSelector('#sheet-account-overlay.open');
  await page.click('#delete-account-row');
  await page.waitForSelector('#modal-delete-account.open');
}

test('profile.html: tapping "Delete account" alone opens the confirmation modal only — nothing destructive fires from that tap, and the confirm button stays disabled until a real password is typed', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var calls = mockDeleteAccount(page, { body: { ok: true } });
    await seedUser(page);
    await safeGoto(page, baseUrl + '/profile.html');

    await openSettingsAndDangerZone(page);

    assert.equal(await page.locator('#delete-account-confirm').isDisabled(), true, 'confirm must start disabled — a stray tap on the row must not be enough to reach a live confirm button');
    assert.equal(calls.length, 0, 'opening the modal alone must never call delete-account.js');

    // Typing a real password is what enables it — not just opening the modal.
    await page.fill('#delete-account-password', 'realpassword1');
    assert.equal(await page.locator('#delete-account-confirm').isDisabled(), false);

    // Clearing it back out disables it again.
    await page.fill('#delete-account-password', '');
    assert.equal(await page.locator('#delete-account-confirm').isDisabled(), true);

    assert.equal(calls.length, 0, 'still no destructive call fired at any point in this test');

    // Cancel closes the modal without ever calling anything either.
    await page.fill('#delete-account-password', 'realpassword1');
    await page.click('#delete-account-cancel');
    await page.waitForSelector('#modal-delete-account:not(.open)');
    assert.equal(calls.length, 0);

    var stateAfter = await page.evaluate(function () { return localStorage.getItem('dreamtube_state_v1'); });
    assert.ok(stateAfter, 'local state must be completely untouched — nothing destructive happened');
  } finally {
    await page.close();
  }
});

test('profile.html: happy path — correct password + explicit confirm tap deletes the account, wipes ITS OWN local state (accounts/dreams/characters entries, in-memory user), leaves device-level flags/prefs untouched, shows the confirmation, and redirects to index.html', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var calls = mockDeleteAccount(page, { body: { ok: true } });
    await seedUser(page);
    await safeGoto(page, baseUrl + '/profile.html');
    await openSettingsAndDangerZone(page);

    await page.fill('#delete-account-password', 'realpassword1');
    await page.click('#delete-account-confirm');

    await page.waitForSelector('#account-deleted-overlay.open');

    assert.equal(calls.length, 1, 'delete-account.js must have been called exactly once');
    assert.deepEqual(calls[0], { username: 'tester', password: 'realpassword1' }, 'must send the real username + the exact password the user typed');

    // Local state is wiped IMMEDIATELY on success, before the redirect even
    // fires — not deferred until after navigation.
    var afterSuccess = await page.evaluate(function () {
      var s = JSON.parse(localStorage.getItem('dreamtube_state_v1') || 'null');
      return {
        mainState: s,
        feedBackfill: localStorage.getItem('dreamtube_feed_backfill_v1_done'),
        persistAsked: localStorage.getItem('dreamtube_persist_asked_v1'),
        soundPref: localStorage.getItem('dreamtube_sound_on'),
        currentUser: window.DreamStore.getCurrentUser()
      };
    });
    assert.ok(afterSuccess.mainState, 'the main state blob must still exist — this is a SCOPED wipe of just this account, not localStorage.removeItem(KEY)');
    assert.equal(afterSuccess.mainState.accounts.tester, undefined, "the deleted account's own accounts[] entry must be gone");
    assert.equal(afterSuccess.mainState.charactersByUser.tester, undefined, "the deleted account's own charactersByUser[] entry must be gone");
    assert.deepEqual(afterSuccess.mainState.dreams, [], "the deleted account's own dreams must be gone from state.dreams");
    // Device-level "have I already done this" flags and prefs are NOT
    // account data — deleting one account has no more reason to touch
    // them than logging out already does (see wipeAllLocalState's comment;
    // a round-2 review caught an earlier version wiping the whole KEY
    // blob outright, which would have destroyed any OTHER local account's
    // data sharing this browser — see the two-account test below).
    assert.equal(afterSuccess.feedBackfill, '1', 'the feed-backfill flag is device-level bookkeeping, not this account\'s data — must survive');
    assert.equal(afterSuccess.persistAsked, '1', 'the persistent-storage-asked flag is device-level bookkeeping, not this account\'s data — must survive');
    assert.equal(afterSuccess.soundPref, '1', 'a genuinely device-level pref (not account data) must survive an account deletion');
    assert.equal(afterSuccess.currentUser, null, 'the in-memory state must also reset immediately, not just the on-disk key');

    // Redirect to index.html follows the confirmation.
    await page.waitForURL(function (url) { return url.pathname === '/index.html'; }, { timeout: 5000 });
  } finally {
    await page.close();
  }
});

test('profile.html: deleting one account on a browser that has a SECOND local account must not touch that other account\'s private dreams, characters, or login entry', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    mockDeleteAccount(page, { body: { ok: true } });
    await seedUser(page);
    // Add a SECOND, different local account sharing this same browser's
    // state blob — realistic on a shared/family device, or after
    // switching accounts via the cross-device login flow. Nothing about
    // deleting "tester" should ever touch "otheruser"'s data.
    await page.evaluate(function () {
      var s = JSON.parse(localStorage.getItem('dreamtube_state_v1'));
      s.accounts.otheruser = { password: 'otherpassword1', email: 'other@example.com' };
      s.charactersByUser.otheruser = [{ id: 'oc1', name: 'Me', isSelf: true, description: 'short' }];
      s.dreams.push({ id: 'other-private-dream', ownerHandle: '@otheruser', caption: 'not tester\'s dream', style: 'Anime', likes: 0, likedByMe: false, isPublished: false, videoUrl: 'https://x/other.mp4', mediaType: 'video' });
      localStorage.setItem('dreamtube_state_v1', JSON.stringify(s));
    });

    await safeGoto(page, baseUrl + '/profile.html');
    await openSettingsAndDangerZone(page);
    await page.fill('#delete-account-password', 'realpassword1');
    await page.click('#delete-account-confirm');
    await page.waitForSelector('#account-deleted-overlay.open');

    var s = await page.evaluate(function () { return JSON.parse(localStorage.getItem('dreamtube_state_v1')); });
    assert.equal(s.accounts.tester, undefined, 'the deleted account itself must be gone');
    assert.ok(s.accounts.otheruser, "the OTHER account's login entry must survive — deleting tester must not lock otheruser out of this device");
    assert.deepEqual(s.accounts.otheruser, { password: 'otherpassword1', email: 'other@example.com' }, "the other account's credentials must be untouched");
    assert.deepEqual(s.charactersByUser.otheruser, [{ id: 'oc1', name: 'Me', isSelf: true, description: 'short' }], "the other account's characters must survive");
    var otherDreams = s.dreams.filter(function (d) { return d.ownerHandle === '@otheruser'; });
    assert.equal(otherDreams.length, 1, "the other account's private (never-published) dream has no copy anywhere else — deleting tester must not destroy it");
    var testerDreams = s.dreams.filter(function (d) { return d.ownerHandle === '@tester'; });
    assert.equal(testerDreams.length, 0, "the deleted account's own dreams must still be gone even with a second account present");
  } finally {
    await page.close();
  }
});

test('profile.html: deleting an account clears ITS OWN pendingJob, but leaves a DIFFERENT account\'s pendingJob (however unusual) untouched', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    mockDeleteAccount(page, { body: { ok: true } });
    await seedUser(page);
    await page.evaluate(function () {
      var s = JSON.parse(localStorage.getItem('dreamtube_state_v1'));
      s.pendingJob = { operationName: 'fal:abc', ownerHandle: '@tester', startedAt: Date.now() };
      localStorage.setItem('dreamtube_state_v1', JSON.stringify(s));
    });

    await safeGoto(page, baseUrl + '/profile.html');
    await openSettingsAndDangerZone(page);
    await page.fill('#delete-account-password', 'realpassword1');
    await page.click('#delete-account-confirm');
    await page.waitForSelector('#account-deleted-overlay.open');

    var s = await page.evaluate(function () { return JSON.parse(localStorage.getItem('dreamtube_state_v1')); });
    assert.equal(s.pendingJob, null, "the deleted account's own in-flight job must be cleared, not left dangling");
  } finally {
    await page.close();
  }
});

test('profile.html: a pendingJob belonging to a DIFFERENT account survives this account\'s deletion', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    mockDeleteAccount(page, { body: { ok: true } });
    await seedUser(page);
    await page.evaluate(function () {
      var s = JSON.parse(localStorage.getItem('dreamtube_state_v1'));
      s.pendingJob = { operationName: 'fal:xyz', ownerHandle: '@otheruser', startedAt: Date.now() };
      localStorage.setItem('dreamtube_state_v1', JSON.stringify(s));
    });

    await safeGoto(page, baseUrl + '/profile.html');
    await openSettingsAndDangerZone(page);
    await page.fill('#delete-account-password', 'realpassword1');
    await page.click('#delete-account-confirm');
    await page.waitForSelector('#account-deleted-overlay.open');

    var s = await page.evaluate(function () { return JSON.parse(localStorage.getItem('dreamtube_state_v1')); });
    assert.equal(s.pendingJob && s.pendingJob.operationName, 'fal:xyz', "a job that isn't this account's own must survive -- scopedPendingJob already hides it from anyone but @otheruser, but deleting tester has no reason to destroy the data outright");
  } finally {
    await page.close();
  }
});

test('profile.html: a WRONG password shows an inline error, never navigates away, and never touches local state', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var calls = mockDeleteAccount(page, { body: { ok: false, error: 'E5: incorrect_password' } });
    await seedUser(page);
    await safeGoto(page, baseUrl + '/profile.html');
    await openSettingsAndDangerZone(page);

    await page.fill('#delete-account-password', 'the-wrong-password');
    await page.click('#delete-account-confirm');

    await page.waitForFunction(function () {
      return document.getElementById('delete-account-error').textContent.length > 0;
    });
    assert.equal(await page.locator('#delete-account-error').textContent(), 'Incorrect password.');

    assert.equal(calls.length, 1);
    // Modal stays open — the user can correct the password and retry,
    // rather than being bounced out of the flow entirely.
    assert.equal(await page.locator('#modal-delete-account').getAttribute('class'), 'modal-overlay open');
    assert.equal(await page.locator('#account-deleted-overlay').getAttribute('class'), 'modal-overlay', 'the success confirmation must never show for a failed attempt');

    var stillLoggedIn = await page.evaluate(function () { return window.DreamStore.getCurrentUser(); });
    assert.deepEqual(stillLoggedIn, { handle: '@tester', username: 'tester' }, 'a rejected deletion attempt must leave the account fully intact');

    var state = await page.evaluate(function () { return JSON.parse(localStorage.getItem('dreamtube_state_v1')); });
    assert.equal(state.dreams.length, 1, 'dreams must be untouched after a failed attempt');
  } finally {
    await page.close();
  }
});

test('profile.html: a server-side deletion FAILURE (E7 -- password verified, but the delete itself failed) shows a distinct message, not the "incorrect password"/generic text', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    mockDeleteAccount(page, { body: { ok: false, error: 'E7: deletion_failed: blobs unavailable' } });
    await seedUser(page);
    await safeGoto(page, baseUrl + '/profile.html');
    await openSettingsAndDangerZone(page);

    await page.fill('#delete-account-password', 'realpassword1');
    await page.click('#delete-account-confirm');

    await page.waitForFunction(function () {
      return document.getElementById('delete-account-error').textContent.length > 0;
    });
    assert.equal(await page.locator('#delete-account-error').textContent(), 'Something went wrong deleting your account — please try again.', 'E7 means the PASSWORD was fine but the delete itself failed -- must not tell the user to re-check credentials that already checked out');
  } finally {
    await page.close();
  }
});

test('js/store.js: DreamStore.deleteAccount rejects locally (no network call at all) when not logged in, and requires a non-empty password before even trying', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var calls = mockDeleteAccount(page, { body: { ok: true } });
    await safeGoto(page, baseUrl + '/login.html');

    var notLoggedInResult = await page.evaluate(function () { return window.DreamStore.deleteAccount('anything1'); });
    assert.equal(notLoggedInResult.ok, false);
    assert.equal(notLoggedInResult.error, 'not_logged_in');

    await seedUser(page);
    await safeGoto(page, baseUrl + '/profile.html');
    var emptyPasswordResult = await page.evaluate(function () { return window.DreamStore.deleteAccount(''); });
    assert.equal(emptyPasswordResult.ok, false);

    assert.equal(calls.length, 0, 'neither case should ever have reached the network');
  } finally {
    await page.close();
  }
});
