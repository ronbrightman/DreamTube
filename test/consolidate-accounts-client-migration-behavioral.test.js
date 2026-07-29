// test/consolidate-accounts-client-migration-behavioral.test.js
//
// Covers tracker item for-product-rename-dry-run-refused-u-ron-rd0sm9's own
// requirement #7: "confirm migrateLegacyThrowawayAccountData/
// pinLegacyRenameIdentity in js/store.js correctly handles this exact
// old-handle -> new-handle pair on Ron's next real login... verify it
// generalizes to this specific pair rather than assuming."
//
// It does, and this file proves it rather than assumes it:
// netlify/functions/admin-consolidate-accounts.js's whole job is to make
// u:__probe_throwaway_user__'s real data (email/password/tokens/dreams)
// live on the u:ronbrightman account, but the founder's own DEVICE-local
// browser storage (state.dreams/charactersByUser, per CLAUDE.md's
// documented scope) is never touched by ANY server-side endpoint — that's
// what js/store.js's LEGACY_ACCOUNT_RENAME mechanism is for.
//
// js/store.js's LEGACY_ACCOUNT_RENAME constant is ALREADY exactly
// { fromUsername: '__probe_throwaway_user__', toUsername: 'ronbrightman' }
// -- the identical pair this consolidation task also needs, since the
// account was always going to end up at username "ronbrightman" either way
// (whether via the sibling admin-rename-account.js tool, or this
// consolidation tool). That mechanism keys PURELY off username, never
// email, so it does not care that this specific consolidation also changes
// the account's email/password/token balance server-side -- no js/store.js
// code change was needed for this task, and this file is the proof.
//
// The one scenario test/rename-migration-login-behavioral.test.js's existing
// coverage does NOT exercise: a browser that already has REAL local dreams
// under the NEW handle ("@ronbrightman") from actually using that account,
// alongside legacy dreams still sitting under the OLD throwaway handle --
// exactly the founder's real situation (his own u:ronbrightman account has
// 5 real published dreams; if any of those are also cached locally on a
// device he used that account from, this proves they survive ALONGSIDE the
// 2 migrated probe dreams, none lost, none duplicated).
//
// Same conventions as test/rename-migration-login-behavioral.test.js: a
// plain static file server (no real Netlify Functions runtime),
// blockThirdParty() for this sandbox's flaky outbound network, safeGoto()
// to tolerate a transient nav failure, login.html loaded purely as a
// vehicle for js/store.js, and account-login.js mocked via page.route() to
// return the real server-confirmed shape a genuine post-consolidation login
// produces.

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

/** Mocks account-login.js to always affirmatively resolve to the exact shape the CONSOLIDATED account produces: username "ronbrightman", email OWNER_EMAIL (ronbrightman@gmail.com) -- the real post-consolidation server response the founder's next real login gets. */
function mockPostConsolidationLoginSuccess(page) {
  return page.route('**/.netlify/functions/account-login', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, username: 'ronbrightman', email: 'ronbrightman@gmail.com' }) });
  });
}

/** Seeds this browser's localStorage to match the founder's REAL device state around the consolidation: dreams/characters still sitting under the old "@__probe_throwaway_user__" handle (the probe account's 2 real published dreams, mirrored locally too), PLUS real dreams/characters ALREADY under "@ronbrightman" (from actually using that account on this same device) -- proving the migration merges rather than clobbers. Plus one unrelated dream, to prove it's never touched. */
async function seedPreConsolidationLocalData(page) {
  await page.evaluate(function () {
    var state = {
      user: null,
      accounts: {},
      draft: { caption: '', style: null, sourceDreamId: null, restore: false, characterIds: [], cameraView: null, sceneryTime: null, sceneryPlace: null, mediaType: null, sourceImageUrl: null },
      dreams: [
        { id: 'probe-dream-1', ownerHandle: '@__probe_throwaway_user__', caption: 'Flying over mountains', style: 'Cinematic', dur: 5, videoUrl: 'https://cdn.example.com/probe1.mp4', mediaType: 'video', likedByMe: false },
        { id: 'probe-dream-2', ownerHandle: '@__probe_throwaway_user__', caption: 'Underwater city', style: 'Anime', dur: 6, videoUrl: 'https://cdn.example.com/probe2.mp4', mediaType: 'video', likedByMe: false },
        { id: 'ron-dream-1', ownerHandle: '@ronbrightman', caption: 'Already the founders own account', style: 'Noir', dur: 4, videoUrl: 'https://cdn.example.com/ron1.mp4', mediaType: 'video', likedByMe: false },
        { id: 'ron-dream-2', ownerHandle: '@ronbrightman', caption: 'Another real ronbrightman dream', style: 'Realistic', dur: 7, videoUrl: 'https://cdn.example.com/ron2.mp4', mediaType: 'video', likedByMe: false },
        { id: 'unrelated-dream', ownerHandle: '@someone-else', caption: 'Not the founders dream', style: 'Noir', dur: 4, videoUrl: 'https://cdn.example.com/unrelated.mp4', mediaType: 'video', likedByMe: false }
      ],
      pendingJob: null,
      charactersByUser: {
        __probe_throwaway_user__: [
          { id: 'char-probe', name: 'Probe-side self', isSelf: true, description: 'me (probe)', photoDataUrl: null }
        ],
        ronbrightman: [
          { id: 'char-ron', name: 'Ronbrightman-side self', isSelf: true, description: 'me (ronbrightman)', photoDataUrl: null }
        ]
      },
      likedIds: {}
    };
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  });
  await safeGoto(page, baseUrl + '/login.html');
}

test('js/store.js: after the account consolidation, logging in as ronbrightman merges the probes locally-cached dreams onto the existing ronbrightman dreams -- none lost, none duplicated', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await safeGoto(page, baseUrl + '/login.html');
    await seedPreConsolidationLocalData(page);
    await mockPostConsolidationLoginSuccess(page);

    var result = await page.evaluate(function () {
      return window.DreamStore.login('ronbrightman@gmail.com', 'the-consolidated-real-password').then(function (loginResult) {
        return {
          loginResult: loginResult,
          currentUser: window.DreamStore.getCurrentUser(),
          myDreams: window.DreamStore.getMyDreams(),
          characters: window.DreamStore.getCharacters(),
          rawState: JSON.parse(localStorage.getItem('dreamtube_state_v1'))
        };
      });
    });

    assert.equal(result.loginResult.ok, true);
    assert.equal(result.currentUser.handle, '@ronbrightman');
    assert.equal(result.currentUser.username, 'ronbrightman');

    // All 4 real dreams (2 migrated from the probe handle + 2 that were
    // already correctly tagged) are visible together -- the consolidation's
    // whole point (7 real published dreams surviving under one handle,
    // mirrored here at local-cache scale) is proven at the client layer too.
    var myDreamIds = result.myDreams.map(function (d) { return d.id; }).sort();
    assert.deepEqual(myDreamIds, ['probe-dream-1', 'probe-dream-2', 'ron-dream-1', 'ron-dream-2']);

    // The unrelated dream under a different handle was never touched.
    var unrelated = result.rawState.dreams.filter(function (d) { return d.id === 'unrelated-dream'; })[0];
    assert.equal(unrelated.ownerHandle, '@someone-else');

    // Raw persisted state actually reflects the re-tag (survives reload).
    var rawProbe1 = result.rawState.dreams.filter(function (d) { return d.id === 'probe-dream-1'; })[0];
    var rawProbe2 = result.rawState.dreams.filter(function (d) { return d.id === 'probe-dream-2'; })[0];
    assert.equal(rawProbe1.ownerHandle, '@ronbrightman');
    assert.equal(rawProbe2.ownerHandle, '@ronbrightman');
    var rawRon1 = result.rawState.dreams.filter(function (d) { return d.id === 'ron-dream-1'; })[0];
    assert.equal(rawRon1.ownerHandle, '@ronbrightman', 'already-correct dreams must stay exactly as they were');

    // Characters: the migration's own documented, accepted rule is "only
    // move the old character list over if the new handle doesn't already
    // have one of its own" (see migrateLegacyThrowawayAccountData's doc
    // comment: "defensive -- never clobber data that's already legitimately
    // there under the new identity") -- so the REAL ronbrightman character
    // (not the probe one) is what's visible here, matching the founder's
    // actual data taking precedence over throwaway-account test data. The
    // old probe-side character entry is a known, accepted, harmless
    // leftover in this specific scenario (present in state.charactersByUser
    // but never surfaced by getCharacters(), which only ever reads the
    // current handle's own entry) -- not cleaned up here, unlike the
    // "new handle had no characters yet" case
    // test/rename-migration-login-behavioral.test.js already covers.
    assert.equal(result.characters.length, 1);
    assert.equal(result.characters[0].name, 'Ronbrightman-side self');
    assert.ok(result.rawState.charactersByUser.__probe_throwaway_user__, 'a known, accepted no-op: the old probe entry is left in place (harmless, never surfaced) rather than clobbering the real ronbrightman character data already present');
  } finally {
    await page.close();
  }
});

test('js/store.js: the same merge happens via the local-fallback login path (attemptLocalLogin), not just the server-confirmed one', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await safeGoto(page, baseUrl + '/login.html');
    // Force account-login.js to fail so login() degrades to the local
    // fallback -- a real, reachable network-hiccup path, not contrived
    // (see admin-rename-account.js's own header comment on this exact
    // path, and test/rename-migration-login-behavioral.test.js's own
    // coverage of it for the sibling rename tool).
    await page.route('**/.netlify/functions/account-login', function (route) {
      route.abort('failed');
    });
    await page.route('**/.netlify/functions/register-account*', function (route) {
      route.abort('failed');
    });

    await seedPreConsolidationLocalData(page);
    await page.evaluate(function () {
      var raw = JSON.parse(localStorage.getItem('dreamtube_state_v1'));
      // The shape attemptLocalLogin itself requires: a local account
      // record already present under "ronbrightman" (this device already
      // knows this account locally, from before the consolidation ever
      // ran server-side).
      raw.accounts.ronbrightman = { password: 'the-consolidated-real-password', email: 'ronbrightman@gmail.com' };
      localStorage.setItem('dreamtube_state_v1', JSON.stringify(raw));
    });
    await safeGoto(page, baseUrl + '/login.html');

    var result = await page.evaluate(function () {
      return window.DreamStore.login('ronbrightman', 'the-consolidated-real-password').then(function (loginResult) {
        return {
          loginResult: loginResult,
          currentUser: window.DreamStore.getCurrentUser(),
          myDreams: window.DreamStore.getMyDreams()
        };
      });
    });

    assert.equal(result.loginResult.ok, true);
    assert.equal(result.currentUser.handle, '@ronbrightman');
    var myDreamIds = result.myDreams.map(function (d) { return d.id; }).sort();
    assert.deepEqual(myDreamIds, ['probe-dream-1', 'probe-dream-2', 'ron-dream-1', 'ron-dream-2']);
  } finally {
    await page.close();
  }
});
