// test/rename-migration-login-behavioral.test.js
//
// Regression coverage for a gap review round 1 caught in
// netlify/functions/admin-rename-account.js's own PR (the one-off
// __probe_throwaway_user__ -> ronbrightman account rename, tracker item
// for-product-correct-founder-account-user-flutrx): that endpoint only
// ever touches SERVER-side state (the account record, the shared feed) —
// it cannot reach into any browser's localStorage at all. Without a
// client-side fix, the very first login after the server-side rename
// would hit js/store.js's login()'s existing "brand-new-to-this-device
// account" branch and silently show an EMPTY account: state.dreams
// (filtered by `d.ownerHandle === state.user.handle`, see getMyDreams())
// and state.charactersByUser (keyed by lowercased username) both stay
// local-only and keyed to the OLD identity forever. On the founder's own
// real, actively-used account, that would look exactly like his dreams
// had been destroyed by the rename.
//
// Fix: js/store.js's login() now calls migrateLegacyThrowawayAccountData()
// (see that function's own doc comment) the moment a login resolves to
// the hardcoded target username, re-stamping any dreams/characters still
// sitting under the old handle/key onto the new one before state.user is
// even set.
//
// Follows test/store-signup-call-sequence-guard-behavioral.test.js's
// conventions: a plain static file server (no real Netlify Functions
// runtime), blockThirdParty() for this sandbox's flaky outbound network,
// safeGoto() to tolerate a transient nav failure, and login.html loaded
// purely as a vehicle for js/store.js. Unlike
// test/logout-clears-pendingjob-behavioral.test.js (which deliberately
// leaves DreamStore.login() unmocked so it degrades to the local-only
// fallback), THIS file mocks account-login.js via page.route — the
// migration only runs on the SERVER-CONFIRMED success branch of login()
// (the realistic path after a real server-side rename: the founder logs
// in by email/new-username and the server affirmatively resolves the
// renamed account), not the local-fallback path, so exercising it
// requires a real `data.ok:true` response to land.

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

/** Wraps page.goto with 'domcontentloaded' (not the default 'load') and tolerates a transient nav failure — see CLAUDE.md's known environment quirk. */
async function safeGoto(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  } catch (e) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  }
}

/** Mocks account-login.js to always affirmatively resolve to { username, email } — the exact response shape a real, already-renamed server-side account produces (see account-login.js's own header comment). */
function mockServerLoginSuccess(page, username, email) {
  return page.route('**/.netlify/functions/account-login', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, username: username, email: email }) });
  });
}

/** Seeds this browser's localStorage exactly as the founder's real, pre-rename device would look: logged OUT (a fresh login is what triggers the migration), no local `accounts` entry for the new username yet, but real dreams/characters still sitting under the OLD throwaway handle/key — plus one unrelated dream under a totally different handle, to prove the migration never touches data that isn't its own. */
async function seedPreRenameLocalData(page) {
  await page.evaluate(function () {
    var state = {
      user: null,
      accounts: {},
      draft: { caption: '', style: null, sourceDreamId: null, restore: false, characterIds: [], cameraView: null, sceneryTime: null, sceneryPlace: null, mediaType: null, sourceImageUrl: null },
      dreams: [
        { id: 'legacy-dream-1', ownerHandle: '@__probe_throwaway_user__', caption: 'Flying over mountains', style: 'Cinematic', dur: 5, videoUrl: 'https://cdn.example.com/legacy1.mp4', mediaType: 'video', likedByMe: false },
        { id: 'legacy-dream-2', ownerHandle: '@__probe_throwaway_user__', caption: 'Underwater city', style: 'Anime', dur: 6, videoUrl: 'https://cdn.example.com/legacy2.mp4', mediaType: 'video', likedByMe: false },
        { id: 'unrelated-dream', ownerHandle: '@someone-else', caption: 'Not the founder\'s dream', style: 'Noir', dur: 4, videoUrl: 'https://cdn.example.com/unrelated.mp4', mediaType: 'video', likedByMe: false }
      ],
      pendingJob: null,
      charactersByUser: {
        __probe_throwaway_user__: [
          { id: 'char-1', name: 'Founder Self', isSelf: true, description: 'me', photoDataUrl: null }
        ]
      },
      likedIds: {}
    };
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  });
  // Reload so js/store.js's IIFE reads the seeded state above (it's only
  // loaded from localStorage once, at page load).
  await safeGoto(page, baseUrl + '/login.html');
}

test('js/store.js: logging in as the renamed account migrates locally-cached dreams and characters from the old throwaway handle/key onto the new identity', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await safeGoto(page, baseUrl + '/login.html');
    await seedPreRenameLocalData(page);
    await mockServerLoginSuccess(page, 'ronbrightman', 'ronbrightman@gmail.com');

    var result = await page.evaluate(function () {
      return window.DreamStore.login('ronbrightman@gmail.com', 'whatever-the-real-password-is').then(function (loginResult) {
        return {
          loginResult: loginResult,
          currentUser: window.DreamStore.getCurrentUser(),
          myDreams: window.DreamStore.getMyDreams(),
          characters: window.DreamStore.getCharacters(),
          rawState: JSON.parse(localStorage.getItem('dreamtube_state_v1'))
        };
      });
    });

    assert.equal(result.loginResult.ok, true, 'login itself must succeed');
    assert.equal(result.currentUser.handle, '@ronbrightman');
    assert.equal(result.currentUser.username, 'ronbrightman');

    // The two legacy dreams are now visible under the NEW identity...
    var myDreamIds = result.myDreams.map(function (d) { return d.id; }).sort();
    assert.deepEqual(myDreamIds, ['legacy-dream-1', 'legacy-dream-2'], 'both legacy dreams must be visible to the renamed account, not lost');

    // ...and the unrelated dream under a different handle was never touched.
    var unrelated = result.rawState.dreams.filter(function (d) { return d.id === 'unrelated-dream'; })[0];
    assert.equal(unrelated.ownerHandle, '@someone-else', 'a dream under an unrelated handle must never be re-tagged');

    // The character is now visible under the new identity too.
    assert.equal(result.characters.length, 1);
    assert.equal(result.characters[0].name, 'Founder Self');

    // The raw persisted state actually reflects the migration, not just
    // the in-memory getters (i.e. this survives a reload).
    var rawDreams = result.rawState.dreams;
    var legacy1 = rawDreams.filter(function (d) { return d.id === 'legacy-dream-1'; })[0];
    var legacy2 = rawDreams.filter(function (d) { return d.id === 'legacy-dream-2'; })[0];
    assert.equal(legacy1.ownerHandle, '@ronbrightman');
    assert.equal(legacy2.ownerHandle, '@ronbrightman');
    assert.ok(!result.rawState.charactersByUser.__probe_throwaway_user__, 'the old charactersByUser key should be cleaned up after migrating, not left as a stale duplicate');
    assert.equal(result.rawState.charactersByUser.ronbrightman.length, 1);
  } finally {
    await page.close();
  }
});

test('js/store.js: the migration never fires for an ordinary login unrelated to the ronbrightman rename', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await safeGoto(page, baseUrl + '/login.html');
    // Same pre-rename-shaped legacy data present in this browser, but this
    // login resolves to a totally unrelated real account — the legacy
    // throwaway data must stay exactly where it is, untouched.
    await seedPreRenameLocalData(page);
    await mockServerLoginSuccess(page, 'someoneelse', 'someoneelse@example.com');

    var result = await page.evaluate(function () {
      return window.DreamStore.login('someoneelse@example.com', 'whatever-password').then(function () {
        return {
          currentUser: window.DreamStore.getCurrentUser(),
          myDreams: window.DreamStore.getMyDreams(),
          rawState: JSON.parse(localStorage.getItem('dreamtube_state_v1'))
        };
      });
    });

    assert.equal(result.currentUser.handle, '@someoneelse');
    assert.equal(result.myDreams.length, 0, 'an unrelated new account must start empty, exactly as before this fix');

    var legacy1 = result.rawState.dreams.filter(function (d) { return d.id === 'legacy-dream-1'; })[0];
    assert.equal(legacy1.ownerHandle, '@__probe_throwaway_user__', 'legacy throwaway-account dreams must be left alone for any login that is not the ronbrightman rename');
    assert.ok(result.rawState.charactersByUser.__probe_throwaway_user__, 'legacy throwaway-account characters must be left alone too');
  } finally {
    await page.close();
  }
});

test('js/store.js: migration is idempotent — logging in as ronbrightman twice never duplicates or re-clobbers anything', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await safeGoto(page, baseUrl + '/login.html');
    await seedPreRenameLocalData(page);
    await mockServerLoginSuccess(page, 'ronbrightman', 'ronbrightman@gmail.com');

    await page.evaluate(function () {
      return window.DreamStore.login('ronbrightman@gmail.com', 'pw1');
    });
    // Second login for the SAME already-migrated account (e.g. logging out
    // and back in again later) — must be a clean no-op, not a re-migration
    // that duplicates dreams or overwrites already-correct data.
    var result = await page.evaluate(function () {
      window.DreamStore.logout();
      return window.DreamStore.login('ronbrightman@gmail.com', 'pw1').then(function () {
        return {
          myDreams: window.DreamStore.getMyDreams(),
          characters: window.DreamStore.getCharacters()
        };
      });
    });

    var myDreamIds = result.myDreams.map(function (d) { return d.id; }).sort();
    assert.deepEqual(myDreamIds, ['legacy-dream-1', 'legacy-dream-2'], 'no duplicate entries from running the migration twice');
    assert.equal(result.characters.length, 1, 'no duplicate characters from running the migration twice');
  } finally {
    await page.close();
  }
});

test('js/store.js: dreams stay visible even when the ronbrightman username is typed with different casing across two logins', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await safeGoto(page, baseUrl + '/login.html');
    await seedPreRenameLocalData(page);
    // account-login.js always resolves to the canonical lowercase
    // username server-side, regardless of what was typed — mocked the
    // same way here, since typedIsUsername/displayUsername in login()
    // only look at the RAW usernameOrEmail the caller passed in.
    await mockServerLoginSuccess(page, 'ronbrightman', 'ronbrightman@gmail.com');

    var result = await page.evaluate(function () {
      // First login: typed as a username, unusual casing.
      return window.DreamStore.login('Ronbrightman', 'pw1').then(function () {
        window.DreamStore.logout();
        // Second login: typed as a username again, DIFFERENT casing —
        // this is the exact scenario the review found broken pre-fix:
        // without pinning displayUsername, this session's state.user.handle
        // would be '@ronBRIGHTMAN', which would never `===`-match the
        // '@ronbrightman' the first login's migration already re-tagged
        // the dreams onto.
        return window.DreamStore.login('ronBRIGHTMAN', 'pw1');
      }).then(function () {
        return {
          currentUser: window.DreamStore.getCurrentUser(),
          myDreams: window.DreamStore.getMyDreams(),
          characters: window.DreamStore.getCharacters()
        };
      });
    });

    assert.equal(result.currentUser.handle, '@ronbrightman', 'handle must always be pinned to the canonical lowercase form for this account, regardless of typed casing');
    var myDreamIds = result.myDreams.map(function (d) { return d.id; }).sort();
    assert.deepEqual(myDreamIds, ['legacy-dream-1', 'legacy-dream-2'], 'dreams must stay visible across logins typed with different casing, not just the first one');
    assert.equal(result.characters.length, 1);
  } finally {
    await page.close();
  }
});

test('js/store.js: the local-fallback login path (attemptLocalLogin, used when account-login.js is unreachable) also pins casing and migrates legacy data, not just the server-confirmed path', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await safeGoto(page, baseUrl + '/login.html');
    // Force every account-login.js call to fail outright, so login()'s
    // .catch() always degrades to attemptLocalLogin — this is a real,
    // reachable path (a network hiccup), not a contrived one; see
    // admin-rename-account.js's own header comment.
    await page.route('**/.netlify/functions/account-login', function (route) {
      route.abort('failed');
    });
    // Also block whatever backfillAccountServerSide's fire-and-forget
    // registration call hits — it must never block or fail this test.
    await page.route('**/.netlify/functions/account-register*', function (route) {
      route.abort('failed');
    });

    await seedPreRenameLocalData(page);
    await page.evaluate(function () {
      var raw = JSON.parse(localStorage.getItem('dreamtube_state_v1'));
      // Seed a LOCAL-ONLY account record for ronbrightman (the shape
      // attemptLocalLogin itself requires — it only ever checks
      // state.accounts, never the server) alongside the legacy throwaway
      // dreams/characters seedPreRenameLocalData already put in place.
      raw.accounts.ronbrightman = { password: 'localpw1', email: 'ronbrightman@gmail.com' };
      localStorage.setItem('dreamtube_state_v1', JSON.stringify(raw));
    });
    // js/store.js only reads localStorage once, at page load — reload so
    // its in-memory state actually picks up the account record just
    // written above (same requirement seedPreRenameLocalData's own
    // comment documents).
    await safeGoto(page, baseUrl + '/login.html');

    var result = await page.evaluate(function () {
      // First fallback login, typed with one casing.
      return window.DreamStore.login('Ronbrightman', 'localpw1').then(function (firstResult) {
        window.DreamStore.logout();
        // Second fallback login, typed with DIFFERENT casing — the exact
        // scenario the round-3 review found unfixed on this path.
        return window.DreamStore.login('RONBRIGHTMAN', 'localpw1').then(function (secondResult) {
          return {
            firstOk: firstResult.ok,
            secondOk: secondResult.ok,
            currentUser: window.DreamStore.getCurrentUser(),
            myDreams: window.DreamStore.getMyDreams(),
            characters: window.DreamStore.getCharacters()
          };
        });
      });
    });

    assert.equal(result.firstOk, true, 'the local fallback must still succeed for a real local account');
    assert.equal(result.secondOk, true);
    assert.equal(result.currentUser.handle, '@ronbrightman', 'the local-fallback path must pin casing exactly like the server-confirmed path does');
    var myDreamIds = result.myDreams.map(function (d) { return d.id; }).sort();
    assert.deepEqual(myDreamIds, ['legacy-dream-1', 'legacy-dream-2'], 'legacy dreams must be migrated and stay visible across differently-cased fallback logins too');
    assert.equal(result.characters.length, 1);
  } finally {
    await page.close();
  }
});
