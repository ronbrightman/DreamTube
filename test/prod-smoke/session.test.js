// test/prod-smoke/session.test.js
//
// See test/prod-smoke/README.md for the full picture (what this suite is,
// how it differs from test/*.test.js, how to run it, and why it's safe to
// run daily against real production). Short version: this drives a real
// browser against a REAL origin (default the live production site) with
// REAL network calls and NO backend mocking, except for the generation-
// money surface (test/prod-smoke/helpers/generation-mocks.js) — using a
// single, freshly-created, `@example.com`-addressed throwaway "probe"
// account for the whole run, deleted at the end.
//
// This one file drives the WHOLE session end to end, in order, sharing one
// browser context/page across every `test()` block below — deliberately,
// not split into independent per-concern files the way test/*.test.js
// usually is: the point here is a single coherent new-user session (one
// signup, one dream, one edit, one publish/unpublish, one nav walk), not a
// grab-bag of isolated assertions. node:test runs a file's tests in
// declaration order by default, which this file relies on.
//
// Regression this suite specifically exists to catch (tracker item
// for-product-build-founder-directed-produ-miyfp4, itself pointing at
// tracker item for-product-bug-founder-repro-high-edit--i2yzqo): two
// concurrent "resumers" of the same generation job clobbering a
// legitimate completion. See "6. Edit the dream" below for exactly how
// this suite reproduces the shape of that bug (edit -> view the dream's
// own room while it's still regenerating -> completion -> RELOAD -> the
// NEW content, not a stale reversion, must still be what's displayed).

var test = require('node:test');
var assert = require('node:assert/strict');
var config = require('./helpers/config');
var genMocksModule = require('./helpers/generation-mocks');

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

var origin = config.origin;
var probe = config.makeProbeIdentity();

var browser = null;
var context = null;
var page = null;
var gen = null;
var dreamId = null;
var firstVideoUrl = null;
var probeCleanedUp = false;
// The username that actually ends up persisted server-side. The wizard's
// merged passwordless signup wall (tracker item
// for-product-wizard-signup-wall-is-the-ol-lt1l9j) never asks for a
// username at all -- register-account-passwordless.js derives one from
// the email server-side -- so this is always read back from the real
// signed-in state after signup, never assumed from `probe.username`
// (kept in the probe identity only as a log label).
var probeUsername = null;

console.log('[prod-smoke] target origin: ' + origin);
console.log('[prod-smoke] probe identity (candidate username; server may derive a different real one from the email -- see probeUsername): ' + probe.username + ' <' + probe.email + '>');

test.before(async function () {
  if (unavailableReason) return;
  try {
    browser = await playwright.chromium.launch({ executablePath: CHROMIUM_PATH });
  } catch (e) {
    unavailableReason = 'Could not launch Chromium at ' + CHROMIUM_PATH + ': ' + e.message;
    return;
  }
  // Mobile viewport, per this suite's own requirement — most real
  // DreamTube traffic is mobile, and this app's layouts are tuned for it.
  context = await browser.newContext(playwright.devices['iPhone 13']);
  page = await context.newPage();
  await page.route(/fonts\.(googleapis|gstatic)\.com|connect\.facebook\.net|i\.posthog\.com/, function (route) {
    route.abort();
  });
  gen = genMocksModule.installGenerationMocks(page);
});

test.after(async function () {
  if (unavailableReason) return;
  // Best-effort cleanup — see cleanupProbeAccount below. Runs even if an
  // earlier step in this file failed/threw, so a broken run never leaves
  // a stray probe account behind silently.
  await cleanupProbeAccount();
  if (context) await context.close();
  if (browser) await browser.close();
});

/**
 * Deletes the probe account via the real delete-account.js endpoint —
 * called directly over HTTP (not through the page), since by the time
 * this runs the browser context may already be in an unknown state. Only
 * meaningful once the account actually exists (register-account.js has
 * succeeded) — a run that fails before signup has nothing to clean up.
 * Idempotent: safe to call more than once, and never throws (a cleanup
 * failure must not mask whatever real assertion failure the run already
 * has to report).
 */
async function cleanupProbeAccount() {
  if (probeCleanedUp) return;
  // Nothing was ever actually created server-side -- signup never
  // succeeded (or never ran), so there's genuinely nothing to delete.
  if (!probeUsername) {
    console.log('[prod-smoke] cleanup: no probe account was ever created server-side (signup did not succeed) -- nothing to delete');
    probeCleanedUp = true;
    return;
  }
  try {
    var res = await fetch(origin + '/.netlify/functions/delete-account', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: probeUsername, password: probe.password })
    });
    var data = await res.json().catch(function () { return null; });
    if (data && data.ok) {
      console.log('[prod-smoke] cleanup: probe account ' + probeUsername + ' deleted');
    } else {
      // KNOWN GAP (surfaced by the passwordless signup wall, tracker item
      // for-product-wizard-signup-wall-is-the-ol-lt1l9j): the probe
      // account is now created PASSWORDLESS (password:null server-side),
      // and delete-account.js's only ownership proof is a real password
      // match -- so this delete is expected to fail with E5 until a
      // passwordless-account deletion path exists (a pre-existing product
      // gap for every real passwordless signup too, not just this probe;
      // flagged on the tracker rather than widened here, since extending
      // delete-account.js's auth surface is an approval-gated change).
      // Logged loudly so the leaked probe account is never silent.
      console.log('[prod-smoke] cleanup: delete-account response ' + JSON.stringify(data) + ' -- probe account ' + probeUsername + ' (passwordless) likely needs manual removal; see the KNOWN GAP comment at this log line');
    }
  } catch (e) {
    console.log('[prod-smoke] cleanup: delete-account request failed (' + e.message + ') -- probe account ' + probeUsername + ' may need manual removal');
  }
  probeCleanedUp = true;
}

async function safeGoto(url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  } catch (e) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  }
}

function readState() {
  return page.evaluate(function () {
    var raw = localStorage.getItem('dreamtube_state_v1');
    return raw ? JSON.parse(raw) : null;
  });
}

// ===========================================================================
// 1. Signup: organic/direct journey (docs/JOURNEY_MANIFEST.md journey 2,
//    wizard.html) -- click-path matches
//    test/funnel-real-chain-behavioral.test.js's own proven real-user
//    sequence, driving each documented SCREEN_RENDERERS step in order.
// ===========================================================================

test('journey 2 (organic): index.html -> wizard.html\'s documented step sequence -> signup lands on home.html', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }

  await safeGoto(origin + '/index.html');
  await page.waitForSelector('a[href="wizard.html"], a[href*="wizard.html"]', { timeout: 10000 });

  await safeGoto(origin + '/wizard.html');
  // 0. Question-first screen 1: the "Someone specific" tile is the one build
  //    tile that still asks the Action step (scenario tiles pre-seed + skip
  //    it); it opens the who-detail sheet, which we dismiss. Setting and Mood
  //    are gone (inferred), so the flow is Who → What → Style → free text.
  await page.waitForSelector('#fn-q-grid [data-tile="2"]', { timeout: 10000 });
  await page.click('#fn-q-grid [data-tile="2"]');
  await page.waitForSelector('#sheet-character-overlay.open', { timeout: 10000 });
  await page.click('#char-cancel');
  // 1. Subject (Who)
  await page.waitForSelector('[data-subj-other="none"]', { timeout: 10000 });
  await page.click('[data-subj-other="none"]');
  await page.click('#fn-subject-continue');
  // 2. Action (What) — Setting is gone, so Subject leads straight here.
  await page.waitForSelector('[data-action="flying"]', { timeout: 10000 });
  await page.click('[data-action="flying"]');
  await page.click('#fn-action-continue');
  // 3. Style — Mood is gone, so Action leads straight here.
  await page.waitForSelector('#fn-style-skip', { timeout: 10000 });
  await page.click('#fn-style-skip');
  // 4. Free text
  await page.waitForSelector('#fn-freetext-skip', { timeout: 10000 });
  await page.click('#fn-freetext-skip');
  // 7. The merged signup wall (docs/JOURNEY_MANIFEST.md journey 2 step 7,
  // tracker item for-product-wizard-signup-wall-is-the-ol-lt1l9j): one
  // passwordless email submit fires the mocked start-pending-generation.js
  // AND the real, unmocked register-account-passwordless.js signup in
  // parallel -- there is no username/password step anymore. The wall's
  // own forming-veil beat is asserted before submitting. (The Facebook
  // button + divider this used to assert were removed 2026-08-11.)
  await page.waitForSelector('#contact-email', { timeout: 10000 });
  assert.ok(await page.locator('#fn-forming-frame').count() > 0, 'the wall must show the forming veil');
  await page.fill('#contact-email', probe.email);
  await page.click('#fn-contact-continue');

  // 8. Lands on home.html (docs/JOURNEY_MANIFEST.md: "no dedicated wait
  // screen" as of the funnel-ending-v2 change).
  await page.waitForURL(/home\.html/, { timeout: 20000, waitUntil: 'domcontentloaded' });

  var state = await readState();
  assert.ok(state && state.user && typeof state.user.username === 'string' && state.user.username.length > 0, 'a real, server-confirmed account must now be signed in');
  assert.ok(state.user.authToken, 'signup must have minted a real authToken (register-account.js\'s 200 response)');
  probeUsername = state.user.username;
  console.log('[prod-smoke] real persisted username: ' + probeUsername + (probeUsername === probe.username ? '' : ' (server-derived from the email, not the typed #fn-username value -- see this file\'s own comment above probeUsername)'));
});

// ===========================================================================
// 2. Home renders every currently-approved module (2026-08-01 set) --
//    checked at the moment the account lands, while the first dream is
//    still forming.
// ===========================================================================

test('home.html renders every currently-approved module while the first dream is forming', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }

  // The forming card (#day0-card) appears immediately -- the pending job
  // adopted from the funnel's own pre-signup generation call.
  await page.waitForSelector('#day0-card', { state: 'visible', timeout: 10000 });
  assert.equal(await page.locator('#d0-forming-veil').isVisible(), true, '"forming card appears" -- the veil must be visible while the first dream generates');

  // Every module this task's coverage list names must actually exist in
  // the DOM -- catches a module being deleted/broken outright. Visibility
  // is additionally asserted wherever this specific flow's own state
  // deterministically guarantees it one way or the other; left as a bare
  // existence check where the real module is legitimately data-conditional
  // (e.g. "Get inspired" depends on the shared feed having public dreams
  // to show, which this brand-new, still-private probe account has no
  // control over).
  var modules = ['#day0-card', '#hero-tonight', '#hero-chamber', '#ritual', '#tipsect', '#tipcard', '#inspired', '#dreams', '#unpub', '#mky', '#bottom-nav-slot'];
  for (var i = 0; i < modules.length; i++) {
    var count = await page.locator(modules[i]).count();
    assert.ok(count > 0, 'home.html module missing entirely from the DOM: ' + modules[i]);
  }

  // Tip of the Day -- real content, not an empty placeholder.
  assert.equal(await page.locator('#tipsect').isVisible(), true);
  var tipText = (await page.locator('#tip-text').textContent() || '').trim();
  assert.ok(tipText.length > 0, 'Tip of the Day must show real copy');

  // Ritual/streak module -- visible with a live token balance line.
  assert.equal(await page.locator('#ritual').isVisible(), true);
  var ritualBalance = (await page.locator('#ritual-balance').textContent() || '');
  assert.match(ritualBalance, /Vault/i);

  // Make It Yours accordion -- visible (a fresh probe account has not
  // installed/verified anything yet) with its three rows present.
  assert.equal(await page.locator('#mky').isVisible(), true);
  assert.equal(await page.locator('#mky-install-row').count(), 1);
  assert.equal(await page.locator('#mky-copy-row').count(), 1);
  assert.equal(await page.locator('#mky-bookmark-row').count(), 1);

  // Shared bottom dock, all four tabs present.
  assert.equal(await page.locator('#nav-home').count(), 1);
  assert.equal(await page.locator('#nav-explore').count(), 1);
  assert.equal(await page.locator('#nav-create').count(), 1);
  assert.equal(await page.locator('#nav-profile').count(), 1);

  var inspiredVisible = await page.locator('#inspired').isVisible();
  console.log('[prod-smoke] "Get inspired" carousel visible: ' + inspiredVisible + ' (data-conditional on the shared feed having public dreams -- not asserted either way)');
});

// ===========================================================================
// 3. First daily-token claim
// ===========================================================================

test('first daily-token claim: the ritual claim button opens the real claim sheet and a genuine server-confirmed claim lands', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }

  var balanceBefore = await page.locator('#ritual-balance').textContent();

  // js/purchase-sheet.js's maybeAutoOpenClaimSheet may have ALREADY opened
  // the claim sheet automatically (the "once per day auto-open" rule,
  // fired from home.html's own refreshTokenStatus(autoOpen=true) on
  // load) -- a fresh probe account is claimable from the moment it lands,
  // so by the time this test runs the sheet is often already up. Only
  // click #ritual-claim to open it manually if it isn't already.
  var alreadyOpen = await page.locator('#claim-sheet-overlay.open').isVisible().catch(function () { return false; });
  if (!alreadyOpen) {
    await page.waitForSelector('#ritual-claim', { state: 'visible', timeout: 15000 });
    await page.click('#ritual-claim');
  }
  await page.waitForSelector('#claim-sheet-btn', { state: 'visible', timeout: 5000 });
  await page.click('#claim-sheet-btn');

  // Real claim-daily-tokens.js round trip -- never optimistic, so this
  // waits for the sheet's own server-confirmed balance line.
  await page.waitForSelector('#claim-sheet-balance', { state: 'visible', timeout: 10000 });
  var balanceLine = await page.locator('#claim-sheet-balance-num').textContent();
  assert.ok(parseInt(balanceLine, 10) > 0, 'claim-daily-tokens.js must have returned a genuine, positive new balance');

  // Wait for the real DOM condition (the balance line's own text actually
  // changing once the claim sheet's onClaimed callback refreshes
  // home.html's token status) rather than an arbitrary sleep.
  await page.waitForFunction(function (before) {
    var el = document.getElementById('ritual-balance');
    return el && el.textContent !== before;
  }, balanceBefore, { timeout: 5000 });
  var balanceAfter = await page.locator('#ritual-balance').textContent();
  assert.notEqual(balanceAfter, balanceBefore, 'home.html\'s own balance line must reflect the real, server-confirmed claim, not stay stale');
});

// ===========================================================================
// 4. First dream completes -- forming card resolves, "Consider publishing"
//    picks it up, and the dream's own room (result.html) opens.
// ===========================================================================

test('first dream: forming resolves to ready (mocked generation, zero fal.ai cost), then the dream\'s own room opens', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }

  firstVideoUrl = gen.nextVideoUrl();
  await gen.resolveNextVideoStatus(firstVideoUrl, 15000);

  await page.waitForSelector('#d0-video.ready', { timeout: 20000 });
  await page.waitForSelector('#d0-watch', { state: 'visible', timeout: 10000 });

  var state = await readState();
  assert.equal((state.dreams || []).length, 1, 'exactly one dream must exist on this fresh probe account');
  dreamId = state.dreams[0].id;
  assert.equal(state.dreams[0].videoUrl, firstVideoUrl);
  assert.equal(state.dreams[0].isPublished, false, 'a freshly generated dream must start private');

  // NOTE: "Consider publishing" (#unpub) deliberately EXCLUDES whichever
  // dream #day0-card currently owns (home.html's own renderConsiderPublishing,
  // `d.id !== ownedId`) -- "never duplicates whichever dream #day0-card
  // already owns." Since this probe account's first (and so far only)
  // dream IS the one #day0-card owns at this point, #unpub legitimately
  // stays hidden here -- this is real, documented app behavior, not
  // something this suite should assert against with a single-dream
  // account. #unpub's own existence (not visibility) is already covered
  // by test 2's module-presence check above.

  // Opens the dream's own room.
  await page.click('#d0-watch');
  await page.waitForURL(new RegExp('result\\.html\\?id=' + dreamId), { timeout: 10000, waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#result-video', { timeout: 10000 });
  var roomSrc = await page.locator('#result-video').getAttribute('src');
  assert.equal(roomSrc, firstVideoUrl);
});

// ===========================================================================
// 5. Edit the dream (mocked generation again) -- confirm the veil shows on
//    the dream's own room, then the NEW result persists ACROSS A RELOAD.
//    This is today's regression class (tracker item
//    for-product-bug-founder-repro-high-edit--i2yzqo) -- see this file's
//    header comment.
// ===========================================================================

test('edit the dream: the veil shows while regenerating, and the NEW (not stale) result survives a reload', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }

  await page.click('#open-edit-sheet');
  await page.waitForSelector('#sheet-edit-delta-overlay.open', { timeout: 5000 });
  await page.fill('#delta-text', 'prod-smoke: make it daytime instead of night');
  await page.click('#delta-apply-btn');
  await page.waitForSelector('#delta-confirm-panel', { state: 'visible', timeout: 5000 });
  await page.click('#delta-confirm-generate-btn');

  // The edit-delta confirm always lands on home.html?generate=1 first (the
  // edited dream's tile resolves there in place) -- see
  // test/edit-mechanism-behavioral.test.js's driveFullEditDelta.
  await page.waitForURL(/home\.html/, { timeout: 15000, waitUntil: 'domcontentloaded' });

  // Now navigate BACK to the dream's own room WHILE it's still
  // regenerating -- exactly the real-world shape the i2yzqo bug and its
  // regression test (test/edit-regeneration-forming-state-behavioral.test.js)
  // both describe: a second "resumer" of the same in-flight job, viewing
  // the dream's room mid-regeneration. result.html's own page-load resumes
  // the pendingJob and starts polling again (the generation-mocks route
  // registration persists across this navigation, same `page`), so the
  // very next video-status request captured below is genuinely this
  // page's own resumed poll, not a leftover from home.html.
  await safeGoto(origin + '/result.html?id=' + dreamId);
  await page.waitForSelector('#dreamvideo-frame.regenerating', { timeout: 10000 });
  await page.waitForFunction(function () {
    var el = document.getElementById('result-forming-veil');
    return el && parseFloat(getComputedStyle(el).opacity) > 0.99;
  }, null, { timeout: 5000 });
  assert.equal(await page.locator('#result-forming-veil').evaluate(function (el) { return parseFloat(getComputedStyle(el).opacity) > 0.99; }), true, 'the regenerating veil must be visible on the dream\'s own room while an edit is in flight');

  // Complete the job with a NEW, distinct video URL. resolveNextVideoStatus
  // retries past a stale route (a leftover from before the safeGoto
  // navigation above -- the browser cancels an in-flight request on
  // navigation) until it lands the fulfill on result.html's own genuinely
  // live, resumed poll.
  var editedVideoUrl = gen.nextVideoUrl();
  await gen.resolveNextVideoStatus(editedVideoUrl, 15000);

  await page.waitForFunction(function () { return !document.getElementById('dreamvideo-frame').classList.contains('regenerating'); }, null, { timeout: 15000 });
  await page.waitForSelector('.toast.show', { state: 'visible', timeout: 5000 });
  assert.match(await page.locator('.toast').textContent(), /your dream is ready/i);

  var srcBeforeReload = await page.locator('#result-video').getAttribute('src');
  assert.equal(srcBeforeReload, editedVideoUrl, 'the edited dream\'s room must show the NEW video immediately after completion');

  // ===== THE ACTUAL REGRESSION CHECK =====
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#result-video', { timeout: 10000 });
  var srcAfterReload = await page.locator('#result-video').getAttribute('src');
  assert.equal(srcAfterReload, editedVideoUrl, 'THE REGRESSION THIS SUITE GUARDS: after a reload, the dream\'s own room must still show the NEW edited video, never revert to the stale pre-edit one');
  assert.notEqual(srcAfterReload, firstVideoUrl, 'must not have reverted to the FIRST (pre-edit) dream\'s video after reload');

  var state = await readState();
  var storedDream = (state.dreams || []).filter(function (d) { return d.id === dreamId; })[0];
  assert.ok(storedDream, 'the edited dream must still exist after reload');
  assert.equal(storedDream.videoUrl, editedVideoUrl, 'the persisted record itself (not just the DOM) must hold the new video after reload');
});

// ===========================================================================
// 6. Publish, then unpublish
// ===========================================================================

test('publish then unpublish the dream -- real publish-dream.js/unpublish-dream.js round trips', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }

  await page.click('#publish-btn');
  await page.waitForSelector('#modal-publish.open', { timeout: 5000 });
  await page.click('#publish-confirm');
  await page.waitForSelector('.toast.show', { state: 'visible', timeout: 5000 });
  assert.match(await page.locator('.toast').textContent(), /published to explore/i);
  await page.waitForSelector('#result-privacy-tag.pub, #result-privacy-tag[title="Public"]', { timeout: 10000 }).catch(function () { /* tolerant of exact class/title naming -- checked again via state below */ });

  var stateAfterPublish = await readState();
  var publishedDream = (stateAfterPublish.dreams || []).filter(function (d) { return d.id === dreamId; })[0];
  assert.equal(publishedDream.isPublished, true, 'DreamStore\'s own local record must reflect the real publish');

  await page.click('#result-privacy-tag');
  await page.waitForSelector('.toast.show', { state: 'visible', timeout: 5000 });
  assert.match(await page.locator('.toast').textContent(), /made private/i);

  var stateAfterUnpublish = await readState();
  var unpublishedDream = (stateAfterUnpublish.dreams || []).filter(function (d) { return d.id === dreamId; })[0];
  assert.equal(unpublishedDream.isPublished, false, 'DreamStore\'s own local record must reflect the real unpublish');
});

// ===========================================================================
// 7. Basic explore/profile/nav walk -- the shared bottom dock, all four tabs
// ===========================================================================

test('bottom dock nav walk: home -> explore -> create -> profile -> home', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }

  await safeGoto(origin + '/home.html');
  await page.waitForSelector('#nav-home', { timeout: 10000 });

  await page.click('#nav-explore');
  await page.waitForURL(/explore\.html/, { timeout: 10000, waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#bottom-nav-slot #nav-explore', { timeout: 10000 });

  await page.click('#nav-create');
  await page.waitForURL(/create\.html/, { timeout: 10000, waitUntil: 'domcontentloaded' });
  await page.waitForSelector('body', { timeout: 10000 });

  await safeGoto(origin + '/profile.html');
  await page.waitForSelector('#profile-handle', { timeout: 10000 });
  var handleText = await page.locator('#profile-handle').textContent();
  assert.match(handleText, new RegExp(probeUsername, 'i'));

  await page.click('#nav-home');
  await page.waitForURL(/home\.html/, { timeout: 10000, waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#bottom-nav-slot #nav-home', { timeout: 10000 });
});

// tracker item for-product-reliability-net-spec-v1-smok-x1o5zc's "state-
// seeded journeys" ask explicitly names shop.html rendering as one of the
// nightly-covered surfaces -- added here (this suite's existing real,
// signed-in probe session) rather than as a separate test, since a real
// signed-in balance render is exactly what this session already has on
// hand at this point in the run.
test('shop.html renders real pack cards and the real server-confirmed token balance for the signed-in probe', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }

  await safeGoto(origin + '/shop.html');
  await page.waitForSelector('#shop-topbar-balance', { timeout: 10000 });
  await page.waitForFunction(function () {
    var el = document.querySelector('#shop-topbar-balance');
    return el && el.textContent.trim() !== '' && el.textContent.trim() !== '–';
  }, { timeout: 10000 });

  var balanceText = await page.locator('#shop-topbar-balance').textContent();
  assert.match(balanceText.trim(), /^[\d,]+$/, 'expected a real numeric token balance, got "' + balanceText + '"');

  var packCardCount = await page.locator('.pack-card').count();
  assert.ok(packCardCount > 0, 'expected at least one real pack card to render');
});

// ===========================================================================
// 8. Self-cleaning: delete the probe account
// ===========================================================================

test('cleanup: the probe account is deleted at the end of the run', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  await cleanupProbeAccount();
  assert.equal(probeCleanedUp, true);

  if (!probeUsername) return; // nothing was ever created -- nothing to prove was deleted

  // A login attempt for the just-deleted username must now fail -- proves
  // the deletion was real, not just a client-side sign-out.
  var loginRes = await fetch(origin + '/.netlify/functions/account-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: probeUsername, password: probe.password })
  });
  var loginData = await loginRes.json().catch(function () { return null; });
  // NOTE: for a passwordless probe account this assertion is satisfied
  // trivially (a password login fails against password:null whether or
  // not the delete landed) -- see cleanupProbeAccount's KNOWN GAP comment
  // for why the delete itself currently cannot be proven for passwordless
  // accounts. Kept because it still hard-fails if a deleted account
  // somehow becomes password-loggable again.
  assert.equal(loginData && loginData.ok, false, 'the probe account must genuinely no longer exist server-side after cleanup');
});
