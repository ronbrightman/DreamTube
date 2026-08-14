// test/wizard-ui-behavioral.test.js
//
// Real browser-driven coverage for the dream-builder wizard
// (wizard.html), the "generate during signup" timing seam
// (start-pending-generation.js -> DreamStore.adoptPendingGeneration ->
// processing.html resuming with zero changes there), and create.html's
// "Build it" logged-in retrofit — see dreamtube-growth/WIZARD_SPEC.md and
// tracker items for-product-build-the-dream-builder-wiza-28did1 /
// for-product-generate-during-signup-aband-73jyud.
//
// Follows test/ui-behavioral.test.js's/test/first-video-created-behavioral.test.js's
// conventions exactly: a plain static file server (no real Netlify
// Functions runtime — see test/helpers/static-server.js's own header),
// page.route() intercepts for the handful of function endpoints each test
// actually needs, blockThirdParty() for this sandbox's flaky outbound
// network to fonts/PostHog/Pixel. DreamStore.signup() itself is left
// UNMOCKED deliberately — an unmocked POST to register-account.js 404s
// against the static file server, and js/store.js's signup() already
// degrades that to a local-only signup (see that function's own doc
// comment: "the functions runtime isn't available at all (e.g. this
// repo's own static-file-server-only browser tests)") — exactly this
// suite's situation, no different from every other browser test in this
// repo that exercises signup.

var test = require('node:test');
var assert = require('node:assert/strict');
var staticServer = require('./helpers/static-server');
var settleMod = require('./helpers/settle');
var settle = settleMod.settle;
var gate = settleMod.gate;

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

/** Wraps page.goto with 'domcontentloaded' (not the default 'load') and tolerates a transient nav failure -- see CLAUDE.md's known environment quirk. */
async function safeGoto(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  } catch (e) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  }
}

/**
 * The post-signup monetization moment (wizard.html's showMonetizationMoment)
 * now sits between a FRESH organic wall signup and the home.html handoff.
 * These tests aren't about that moment — they dismiss it ("Not now"), which
 * reproduces the exact original navigation (home.html?generate=1). A funnel
 * ?resume arrival or a returning-user code-step LOGIN never shows the moment,
 * so this is a harmless no-op there (the 8s wait just times out and returns).
 */
async function dismissMomentIfPresent(page) {
  try { await page.waitForSelector('.mm-overlay', { timeout: 8000 }); }
  catch (e) { return; }
  await page.click('.mm-x'); // paywall dismiss (the 'Not now' link was removed 08-14; X dismisses)
}

// (gotoWizardBuild — which drove wizard.html's own chip-build creation flow —
// was removed with the tests that used it: that flow is retired to a
// funnel-arrival receiver (unify-all-creation-flows, founder 2026-08-14), so
// it is no longer user-reachable. wizard.html coverage now lives on the
// funnel-arrival wall (reachWall) and the retirement redirect; create.html's
// own Build flow is still covered via gotoCreateBuild below.)

/** Seeds a logged-in account and opens create.html's "Build it" flow at the Subject step — the logged-in Layout-B retrofit (no signup wall; straight to generation). */
async function gotoCreateBuild(page) {
  await safeGoto(page, baseUrl + '/login.html');
  await page.evaluate(function () {
    var state = { user: { handle: '@buildtester', username: 'buildtester' }, accounts: { buildtester: { password: 'testpass1', email: 'buildtester@example.com' } }, dreams: [], draft: { caption: '', style: null, characterIds: [], sceneryTime: null, sceneryPlace: null, restore: false }, charactersByUser: {}, likedIds: {} };
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  });
  await safeGoto(page, baseUrl + '/create.html');
  await page.click('#choice-build');
  await page.waitForSelector('#build-subject-chip-row');
}

// A 1x1 PNG, used to exercise the Me character's Upload-photo path.
var TINY_PNG_BUFFER = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQAY3Y2wAAAAAElFTkSuQmCC', 'base64');

// ============================================================================
// Subject step (Step 1) multi-select model -- tracker item
// for-product-wizard-characters-step-is-si-paxp07, founder repro
// 2026-08-02: "choosing Me and then adding another character (e.g. a
// stranger) UNCHECKS Me -- the step behaves as one-choice when a dream can
// contain multiple characters (Me AND someone known AND a stranger)."
// Fixed to a real toggle model: any number of staged characters can be
// selected at once (independent toggles), composed with at most one of the
// four "other" chips (stranger/animal/none/other, still single-select
// among just those four). See wizard.html's own design note above
// renderSubject for the full reasoning, and
// test/sheet-dismiss-behavioral.test.js's own section 7c for the same
// scenario exercised through a normally-opened character sheet (the
// interaction with the 75ob70 sheet-dismiss fix this exact step was
// originally reported against).
// ============================================================================

async function stageDescribedCharacter(page, mode, name, description) {
  // Round 8: tapping the Me row selects it immediately AND opens the
  // character sheet in self mode (describe + photo, no name field) --
  // the same sheet grammar "+ Someone I know" uses, which is exactly
  // what the founder asked for. Both paths go through the sheet now.
  await page.click(mode === 'self' ? '#subj-me-row' : '#subj-add-other');
  await page.waitForSelector('#sheet-character-overlay.open');
  if (mode !== 'self') await page.fill('#char-name-input', name);
  await page.fill('#char-desc-input', description);
  await page.click('#char-save-btn');
  await page.waitForSelector('#sheet-character-overlay:not(.open)');
}

function charChipSelected(page, name) {
  return page.evaluate(function (n) {
    var areas = document.querySelectorAll('.char-chip .chip-edit-area[data-char-edit]');
    for (var i = 0; i < areas.length; i++) {
      if (areas[i].textContent.indexOf(n) !== -1) return areas[i].closest('.char-chip').classList.contains('selected');
    }
    return null;
  }, name);
}

/** Clicks a staged character's chip BODY directly (the #subject-chip-row toggle path, data-char-select) -- NOT its edit-area/pencil (data-char-edit, which opens the sheet instead) and NOT via the character sheet's own Save button. Proves the direct chip-click multi-select toggle handler itself, independent of the sheet-save path. */
function clickCharChipDirectly(page, name) {
  return page.evaluate(function (n) {
    var areas = document.querySelectorAll('.char-chip .chip-edit-area[data-char-edit]');
    for (var i = 0; i < areas.length; i++) {
      if (areas[i].textContent.indexOf(n) !== -1) {
        var chip = areas[i].closest('.char-chip');
        // Click the chip's own check area, not the edit-area itself
        // (clicking inside .chip-edit-area would hit the [data-char-edit]
        // branch of the click handler and open the sheet instead of
        // toggling selection) -- .chip-check is the other direct child of
        // the chip body, exactly the part a real tap on the chip (outside
        // its name/pencil) would land on.
        chip.querySelector('.chip-check').click();
        return;
      }
    }
  }, name);
}

// ===========================================================================
// The signup wall (renderSignupWall) — ONE hybrid screen at parity with
// start.html's live screen 13 (founder order, tracker item
// for-product-wizard-signup-wall-is-the-ol-lt1l9j), replacing the former
// Contact-capture + username/password Signup pair. Passwordless-first
// (DreamStore.signupPasswordless — no password field exists on this page
// at all anymore), with the forming veil on top, above the email field.
//
// DreamStore.signupPasswordless is left UNMOCKED in the tests that only
// need a signup to complete — its POST to register-account-passwordless
// 404s against the static file server and js/store.js degrades that to a
// local-only passwordless signup (same convention as this file's header
// comment describes for the old DreamStore.signup). Tests that need the
// pendingVerification (already-registered → code step) branch mock the
// endpoint explicitly.
// ===========================================================================

/** Walks a fresh page through the trimmed wizard up to the signup wall — shared by every wall test below. Enters via the "Flying" question tile (index 0), which seeds the Action and skips the What step, so the path is Subject → Style → free text → recap → wall; Setting and Mood are gone (inferred). */
// The dream text the funnel-arrival handoff carries onto the wall. It only
// needs to be non-empty (the wall's own content gate runs against it) — the
// specific words don't matter to any wall/code-step test below.
var WALL_CAPTION = 'a dream of flying over a city made of glass, dreamlike';

/**
 * Reaches wizard.html's signup wall THE ONLY WAY a real user can now
 * (unify-all-creation-flows, founder 2026-08-14): as a growth-funnel arrival.
 * wizard.html's own chip-build creation flow was retired to a funnel-arrival
 * receiver — a bare hit redirects to /go/ — so the live path onto
 * renderSignupWall is the ?resume=1&caption=... handoff, which lands DIRECTLY
 * on the wall (see wizard.html boot()'s funnel-arrival leg). Every wall/
 * code-step test below exercises that real arrival.
 */
async function reachWall(page) {
  return reachWallWithSearch(page, '');
}

/** Same funnel arrival as reachWall, but with an extra query string merged in (used to force the wall_subtext_arm override). */
async function reachWallWithSearch(page, search) {
  var extra = search || '';
  var glue = extra.indexOf('?') !== -1 ? '&' : '?';
  await safeGoto(page, baseUrl + '/wizard.html' + extra + glue + 'resume=1&caption=' + encodeURIComponent(WALL_CAPTION));
  await page.waitForSelector('#contact-email');
}

/**
 * Supersedes an IN-FLIGHT wall submit with a fresh second submit, the way a
 * user retyping their email would. This is the live, page-staying analog of
 * the retired chip-flow's "Back to the recap step": the funnel-arrival wall's
 * Back now leaves the page entirely (history.back to the funnel), so the
 * on-page way to invalidate a still-settling attempt is a new trySubmit, which
 * bumps signupAttemptToken exactly as the old Back did. Mid-flight the controls
 * are disabled (defense-in-depth); this force-enables the continue button (the
 * tests already force-enable Back for the same reason) and submits `newEmail`,
 * making the first attempt's late settlement provably stale.
 */
async function supersedeInFlightAttempt(page, newEmail) {
  await page.evaluate(function () {
    var c = document.getElementById('fn-contact-continue');
    if (c) c.disabled = false;
  });
  await page.fill('#contact-email', newEmail);
  await page.click('#fn-contact-continue');
}

test('wizard.html signup wall: the wall_subtext_arm A/B is assigned (persisted, stable) before the wall renders, and each arm renders correctly — "shown" keeps the reassurance line, "hidden" drops it with nothing else on the wall changing', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var SUBTEXT = 'Free to start, no card needed';

  // (a) shown arm (forced via ?wallsubtext=shown, mirroring ?lbskin) — the
  // reassurance line renders, and the override persists to localStorage.
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await reachWallWithSearch(page, '?wallsubtext=shown');
    var arm = await page.evaluate(function () { return localStorage.getItem('dt_wall_subtext_arm'); });
    assert.equal(arm, 'shown', 'the ?wallsubtext override must force and persist the arm');
    assert.equal(await page.locator('.fn-microcopy', { hasText: SUBTEXT }).count(), 1, 'the "shown" arm must render the reassurance subtext line');
    // The rest of the wall is intact regardless of arm.
    assert.equal(await page.locator('#contact-email').count(), 1);
    assert.equal(await page.locator('#fn-contact-continue').count(), 1);
  } finally {
    await page.close();
  }

  // (b) hidden arm — the SAME wall, but the reassurance line is gone and
  // nothing else changes (fnStageHtml filters the falsy group cleanly).
  page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await reachWallWithSearch(page, '?wallsubtext=hidden');
    var arm2 = await page.evaluate(function () { return localStorage.getItem('dt_wall_subtext_arm'); });
    assert.equal(arm2, 'hidden', 'the ?wallsubtext override must force and persist the hidden arm');
    assert.equal(await page.locator('.fn-microcopy', { hasText: SUBTEXT }).count(), 0, 'the "hidden" arm must NOT render the reassurance subtext line');
    assert.equal(await page.locator('#contact-email').count(), 1, 'the wall itself must be unchanged in the hidden arm');
    assert.equal(await page.locator('#fn-contact-continue').count(), 1, 'the CTA must be unchanged in the hidden arm');
  } finally {
    await page.close();
  }

  // (c) no override -> the A/B was CONCLUDED on 'shown' (founder 2026-08-11,
  // commit 82e6aaf: "always show wall reassurance" — with Facebook Login
  // removed, the 'hidden' arm left the wall looking empty). assignWallSubtextArm
  // now returns the fixed 'shown' default for every unforced visitor instead of
  // a random 50/50, and — correctly — does NOT persist that fixed default to
  // localStorage (there is no live per-visitor assignment left to persist;
  // only the explicit ?wallsubtext= override path above still writes to
  // localStorage, so a forced preview session stays consistent). The
  // reassurance line must still render before first paint either way.
  page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await reachWallWithSearch(page, '');
    var arm3 = await page.evaluate(function () { return localStorage.getItem('dt_wall_subtext_arm'); });
    assert.equal(arm3, null, 'the concluded A/B no longer persists an arm for an unforced visitor — only the ?wallsubtext override path does');
    var lineCount = await page.locator('.fn-microcopy', { hasText: SUBTEXT }).count();
    assert.equal(lineCount, 1, 'the concluded A/B defaults every unforced visitor to the "shown" arm — the reassurance line always renders');
  } finally {
    await page.close();
  }
});

test('wizard.html signup wall: renders the forming veil on top, above the email field, a "Send me my dream" CTA, the story recap card — and NO username/password fields anywhere', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await reachWall(page);

    // (a) The forming-veil indicator, with its live nebula layer — the
    // founder's "your dream is already forming" beat, at the top.
    assert.equal(await page.locator('#fn-forming-frame').count(), 1, 'the forming veil must render on the wall');
    assert.equal(await page.locator('#fn-forming-frame .fn-form-nebula').count(), 1, 'the veil must carry the live nebula layer, not a flat fill');
    assert.match(await page.locator('#fn-forming-frame .fn-form-caption').textContent(), /forming/i);

    // (c) The forming veil sits above the email field (email-only wall —
    // Facebook Login was removed 2026-08-11).
    var order = await page.evaluate(function () {
      var email = document.getElementById('contact-email');
      return {
        frameBeforeEmail: !!(document.getElementById('fn-forming-frame').compareDocumentPosition(email) & Node.DOCUMENT_POSITION_FOLLOWING)
      };
    });
    assert.equal(order.frameBeforeEmail, true, 'the forming veil must sit above the email field');

    // (b) Passwordless email entry — screen 13's CTA copy (never "Sign
    // up"), and no trace of the old username+password wall.
    assert.equal(await page.locator('#fn-contact-continue').textContent(), 'Send me my dream');
    assert.ok((await page.$('#fn-username')) === null, 'the old username field must be gone');
    assert.ok((await page.$('#fn-password')) === null, 'the old password field must be gone — this wall is passwordless');

    // Round 8: the editable recap moved to its OWN step BEFORE this wall
    // ("it was supposed to be editable in a previous page") — the wall
    // itself must carry NO recap remnants. (Boolean asserts on
    // ElementHandles per this repo's landmine rule.)
    assert.ok((await page.$('#fn-story-recap-text')) === null, 'the recap textarea must NOT live on the wall anymore — it is its own step (renderRecap)');
    assert.ok((await page.$('#fn-story-recap-card')) === null, 'no leftover recap card markup on the wall');
  } finally {
    await page.close();
  }
});

test('wizard.html signup wall: submitting an email starts the real pending generation BEFORE any account exists, and the passwordless signup then claims + adopts it and lands on home.html with no second submission — the founder\'s generation-first ordering, end to end', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var startPendingCalls = [];
    var claimCalls = [];
    var videoStatusCalls = 0;
    // Held until this test has PROVEN the pre-account state — the
    // generation call must be observable while signup is still genuinely
    // unresolved, not just "they both happened eventually".
    var slowSignup = gate();

    await page.route('**/.netlify/functions/check-email', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, available: true, deliverable: true }) });
    });
    await page.route('**/.netlify/functions/start-pending-generation', function (route) {
      startPendingCalls.push(JSON.parse(route.request().postData()));
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pendingId: 'pd-wall-1', operationName: 'fal:fake-model:req-wall-1' }) });
    });
    await page.route('**/.netlify/functions/register-account-passwordless', async function (route) {
      await slowSignup.wait();
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, username: 'walltester', email: 'wall-seam-test@example.com', authToken: 'tok-wall-1', emailVerified: false, created: true }) });
    });
    await page.route('**/.netlify/functions/claim-pending-generation', function (route) {
      claimCalls.push(JSON.parse(route.request().postData()));
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, found: true, claimed: true }) });
    });
    // home.html resumes the adopted pendingJob by polling video-status
    // with the SAME operationName the pre-account call returned above —
    // resolving it proves no second submission ever happened.
    await page.route('**/.netlify/functions/video-status*', function (route) {
      videoStatusCalls++;
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, videoUrl: 'https://example.com/fake-video.mp4' }) });
    });
    await page.route('https://example.com/fake-video.mp4', function (route) {
      route.fulfill({ status: 200, contentType: 'video/mp4', body: Buffer.from('x') });
    });

    await reachWall(page);
    await page.fill('#contact-email', 'wall-seam-test@example.com');
    await page.click('#fn-contact-continue');

    // The real, billed generation call fires while the signup call is
    // still held open — i.e. genuinely BEFORE any account exists.
    await settle(function () { return startPendingCalls.length >= 1; });
    assert.equal(startPendingCalls.length, 1, 'start-pending-generation must fire from the wall submit');
    assert.equal(startPendingCalls[0].email, 'wall-seam-test@example.com');
    assert.ok(startPendingCalls[0].caption, 'the assembled caption must ride the pre-account generation call');
    var userMidFlight = await page.evaluate(function () { return window.DreamStore.getCurrentUser(); });
    assert.equal(userMidFlight, null, 'NO account may exist yet at the moment the generation started — that is the founder\'s generation-first ordering');
    assert.equal(claimCalls.length, 0, 'claim must not fire until signup actually succeeds');

    // Now let signup resolve — the already-running generation gets
    // claimed by the new account and the visitor lands on home.html.
    slowSignup.open();
    await dismissMomentIfPresent(page); // fresh signup -> the monetization moment shows here; dismiss reproduces the original home.html?generate=1 nav
    await page.waitForURL(/home\.html/, { timeout: 15000 });
    await settle(function () { return claimCalls.length >= 1; });
    assert.equal(claimCalls.length, 1, 'claim-pending-generation must fire exactly once, right after signup succeeds');
    assert.equal(claimCalls[0].pendingId, 'pd-wall-1');
    assert.equal(claimCalls[0].email, 'wall-seam-test@example.com');
    await page.waitForSelector('#dreams-row .dream-row-tile:not(.generating), #d0-video.ready', { timeout: 15000 });
    await settle(function () { return startPendingCalls.length >= 1; });
    assert.equal(startPendingCalls.length, 1, 'must never re-submit generation after signup — the whole point of adoptPendingGeneration');
    assert.ok(videoStatusCalls >= 1, 'home.html must actually resume polling the adopted job');
  } finally {
    await page.close();
  }
});

// WhatsApp toggle/field PARKED (founder decision 2026-07-28, tracker item
// for-product-hide-the-whatsapp-field-in-w-clu9ju) — the parked element
// must never render on the wall, and the payload must always send
// whatsapp: null.
test('wizard.html signup wall: never renders the parked WhatsApp toggle/field, and the pending-generation payload always sends whatsapp: null', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var startPendingCalls = [];
    await page.route('**/.netlify/functions/check-email', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, available: true, deliverable: true }) });
    });
    await page.route('**/.netlify/functions/start-pending-generation', function (route) {
      startPendingCalls.push(JSON.parse(route.request().postData()));
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pendingId: 'pd-nowhatsapp-1', operationName: 'fal:fake-model:req-nowhatsapp-1' }) });
    });

    await reachWall(page);
    assert.ok((await page.$('#contact-whatsapp-toggle')) === null, 'the parked WhatsApp toggle must never render');
    assert.ok((await page.$('#contact-whatsapp-reveal')) === null, 'the parked WhatsApp reveal container must never render');
    assert.ok((await page.$('#contact-whatsapp')) === null, 'the parked WhatsApp input must never render');

    await page.fill('#contact-email', 'no-whatsapp-test@example.com');
    await page.click('#fn-contact-continue');

    await settle(function () { return startPendingCalls.length >= 1; });
    assert.equal(startPendingCalls.length, 1);
    assert.equal(startPendingCalls[0].email, 'no-whatsapp-test@example.com');
    assert.equal(startPendingCalls[0].whatsapp, null, 'with no WhatsApp field to capture from, the payload must always send whatsapp: null');
  } finally {
    await page.close();
  }
});

// ===========================================================================
// Deliverability check (tracker item for-product-signup-email-micro-step-
// foun-ns8uve): check-email.js's lightweight MX/A/AAAA existence check is
// the one thing that still gates the wall — `available` deliberately no
// longer does (an already-registered email resolves via the code step,
// matching screen 13's live passwordless wall).
// ===========================================================================

test('wizard.html signup wall: an email whose domain has no MX/A/AAAA records never fires start-pending-generation or a signup, shows an inline typo-check message, and re-enables the controls', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var startPendingCalls = [];
    var signupCalls = [];
    await page.route('**/.netlify/functions/check-email', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, available: true, deliverable: false }) });
    });
    await page.route('**/.netlify/functions/start-pending-generation', function (route) {
      startPendingCalls.push(1);
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pendingId: 'pd-undeliverable-1', operationName: 'fal:fake-model:req-undeliverable-1' }) });
    });
    await page.route('**/.netlify/functions/register-account-passwordless', function (route) {
      signupCalls.push(1);
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, username: 'x', created: true }) });
    });

    await reachWall(page);
    await page.fill('#contact-email', 'typo@gmial-typo-domain-xyz.invalid');
    await page.click('#fn-contact-continue');

    await page.waitForFunction(function () {
      var errEl = document.getElementById('contact-error');
      return errEl && errEl.textContent.indexOf('check for a typo') !== -1;
    }, null, { timeout: 5000 });

    assert.equal(startPendingCalls.length, 0, 'an undeliverable email must never trigger a real, billed start-pending-generation call');
    assert.equal(signupCalls.length, 0, 'an undeliverable email must never create an account around itself either');
    assert.ok(/wizard\.html/.test(page.url()), 'must still be on the wall');
    assert.equal(await page.locator('#fn-contact-continue').isDisabled(), false, 'the CTA must be re-enabled after the undeliverable-email response');
    var backDisabled = await page.evaluate(function () { return document.getElementById('fnBack').disabled; });
    assert.equal(backDisabled, false, 'Back must be re-enabled after the undeliverable-email response');
  } finally {
    await page.close();
  }
});

test('wizard.html signup wall: check-email.js failing outright (5xx/rate-limited) fails OPEN — a legitimate new-email visitor still gets their generation started and their signup completed', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var startPendingCalls = [];
    await page.route('**/.netlify/functions/check-email', function (route) {
      route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'E4: rate_limited' }) });
    });
    await page.route('**/.netlify/functions/start-pending-generation', function (route) {
      startPendingCalls.push(JSON.parse(route.request().postData()));
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pendingId: 'pd-failopen-1', operationName: 'fal:fake-model:req-failopen-1' }) });
    });
    await page.route('**/.netlify/functions/claim-pending-generation', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, found: true, claimed: true }) });
    });
    await page.route('**/.netlify/functions/video-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: false }) });
    });

    await reachWall(page);
    await page.fill('#contact-email', 'legit-new-user@example.com');
    await page.click('#fn-contact-continue');

    // Generation still fires, and the (static-server-degraded, local-only)
    // passwordless signup still completes through to home.html.
    await settle(function () { return startPendingCalls.length >= 1; });
    assert.equal(startPendingCalls.length, 1, 'a legitimate new-email visitor must still get their real generation started even when check-email itself errors out');
    assert.equal(startPendingCalls[0].email, 'legit-new-user@example.com');
    await dismissMomentIfPresent(page); // fresh signup -> dismiss the monetization moment to reach the home handoff
    await page.waitForURL(/home\.html/, { timeout: 15000 });
  } finally {
    await page.close();
  }
});

// ===========================================================================
// Already-registered email → the code step (screen-13 parity). NOTE the
// deliberate behavior change from the old two-step tail (tracker item
// for-product-money-leak-blocked-signups-e-v2g1vi's already-taken branch):
// the generation now fires REGARDLESS of registration state — it's keyed
// on the email, not on who ends up owning the session, and an abandoned
// code step still delivers the dream via dream-webhook.js's re-engagement
// email — the same accepted tradeoff start.html's live passwordless wall
// already made (see renderScreen13Passwordless's own comment there).
// ===========================================================================

test('wizard.html signup wall: an already-registered email swaps to the enter-the-code step (no session granted), with the generation already started and NOT yet claimed', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var startPendingCalls = [];
    var claimCalls = [];
    await page.route('**/.netlify/functions/check-email', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, available: false, deliverable: true }) });
    });
    await page.route('**/.netlify/functions/start-pending-generation', function (route) {
      startPendingCalls.push(JSON.parse(route.request().postData()));
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pendingId: 'pd-code-1', operationName: 'fal:fake-model:req-code-1' }) });
    });
    await page.route('**/.netlify/functions/register-account-passwordless', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, pendingVerification: true }) });
    });
    await page.route('**/.netlify/functions/claim-pending-generation', function (route) {
      claimCalls.push(1);
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, found: true, claimed: true }) });
    });

    await reachWall(page);
    await page.fill('#contact-email', 'already-registered@example.com');
    await page.click('#fn-contact-continue');

    await page.waitForSelector('#fn-login-code', { timeout: 5000 });
    assert.match(await page.locator('.fn-headline').first().textContent(), /Check your email/);
    assert.match(await page.locator('.fn-microcopy').first().textContent(), /already-registered@example\.com/, 'the code step must name the email the code went to');
    var user = await page.evaluate(function () { return window.DreamStore.getCurrentUser(); });
    assert.equal(user, null, 'NO session may be granted for an already-registered email before the code is proven');

    await settle(function () { return startPendingCalls.length >= 1; });
    assert.equal(startPendingCalls.length, 1, 'the generation fires regardless of registration state — screen-13 parity, see this section\'s own header comment');
    assert.equal(claimCalls.length, 0, 'the pending job must NOT be claimed before the code proves account ownership');
  } finally {
    await page.close();
  }
});

test('wizard.html code step: a correct code logs the visitor in, claims the ALREADY-started pending generation for their account, and lands on home.html', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var claimCalls = [];
    var codeCalls = [];
    await page.route('**/.netlify/functions/check-email', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, available: false, deliverable: true }) });
    });
    await page.route('**/.netlify/functions/start-pending-generation', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pendingId: 'pd-code-claim-1', operationName: 'fal:fake-model:req-code-claim-1' }) });
    });
    await page.route('**/.netlify/functions/register-account-passwordless', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, pendingVerification: true }) });
    });
    await page.route('**/.netlify/functions/login-with-email-code', function (route) {
      codeCalls.push(JSON.parse(route.request().postData()));
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, username: 'wreturninguser', email: 'w-code-user@example.com', authToken: 'tok-code-1' }) });
    });
    await page.route('**/.netlify/functions/claim-pending-generation', function (route) {
      claimCalls.push(JSON.parse(route.request().postData()));
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, found: true, claimed: true }) });
    });
    await page.route('**/.netlify/functions/video-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: false }) });
    });

    await reachWall(page);
    await page.fill('#contact-email', 'w-code-user@example.com');
    await page.click('#fn-contact-continue');
    await page.waitForSelector('#fn-login-code', { timeout: 5000 });

    await page.fill('#fn-login-code', '123456');
    await page.click('#fn-code-continue');

    await page.waitForURL(/home\.html/, { timeout: 10000 });
    assert.equal(codeCalls.length, 1, 'loginWithEmailCode must have been called exactly once');
    assert.equal(codeCalls[0].email, 'w-code-user@example.com');
    assert.equal(codeCalls[0].code, '123456');
    await settle(function () { return claimCalls.length >= 1; });
    assert.equal(claimCalls.length, 1, 'the pre-login pending job must be claimed once the code proves the account');
    assert.equal(claimCalls[0].pendingId, 'pd-code-claim-1', 'must claim the SAME job the wall submit already started — never a second one');
    assert.equal(claimCalls[0].email, 'w-code-user@example.com');
  } finally {
    await page.close();
  }
});

test('wizard.html code step: a wrong code shows an inline error, never advances, never claims, and re-enables the controls', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var claimCalls = [];
    await page.route('**/.netlify/functions/check-email', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, available: false, deliverable: true }) });
    });
    await page.route('**/.netlify/functions/start-pending-generation', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pendingId: 'pd-wrongcode-1', operationName: 'fal:fake-model:req-wrongcode-1' }) });
    });
    await page.route('**/.netlify/functions/register-account-passwordless', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, pendingVerification: true }) });
    });
    await page.route('**/.netlify/functions/login-with-email-code', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'E5: code_mismatch' }) });
    });
    await page.route('**/.netlify/functions/claim-pending-generation', function (route) {
      claimCalls.push(1);
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, found: true, claimed: true }) });
    });

    await reachWall(page);
    await page.fill('#contact-email', 'w-wrong-code@example.com');
    await page.click('#fn-contact-continue');
    await page.waitForSelector('#fn-login-code', { timeout: 5000 });

    await page.fill('#fn-login-code', '000000');
    await page.click('#fn-code-continue');

    await page.waitForFunction(function () {
      var errEl = document.getElementById('contact-error');
      return errEl && errEl.textContent.length > 0;
    }, null, { timeout: 5000 });

    assert.ok(/wizard\.html/.test(page.url()), 'a wrong code must never advance past this screen');
    assert.equal(claimCalls.length, 0, 'a wrong code must never claim the pending job');
    assert.equal(await page.locator('#fn-code-continue').isDisabled(), false, 'Continue must be re-enabled after a rejected code, not left stuck disabled');
    var backDisabled = await page.evaluate(function () { return document.getElementById('fnBack').disabled; });
    assert.equal(backDisabled, false, 'Back must be re-enabled after a rejected code');
  } finally {
    await page.close();
  }
});

test('wizard.html signup wall: the code step\'s "Use a different email" round trip must NOT re-POST start-pending-generation for the same unchanged content (no double fal.ai charge — tracker item wizard-html-no-guard-against-resubmittin-n5b5k2, preserved under the merged wall), including a same-email-different-casing retype — while a genuinely changed email still resubmits', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var startPendingCalls = [];
    var REGISTERED_EMAIL = 'dup-registered@example.com';
    await page.route('**/.netlify/functions/check-email', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, available: false, deliverable: true }) });
    });
    await page.route('**/.netlify/functions/start-pending-generation', function (route) {
      var body = JSON.parse(route.request().postData());
      startPendingCalls.push(body);
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pendingId: 'pd-dup-' + startPendingCalls.length, operationName: 'fal:fake-model:req-dup-' + startPendingCalls.length }) });
    });
    await page.route('**/.netlify/functions/register-account-passwordless', function (route) {
      var body = JSON.parse(route.request().postData());
      if (body.email.toLowerCase() === REGISTERED_EMAIL) {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, pendingVerification: true }) });
        return;
      }
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, username: 'dupfresh', email: body.email, authToken: 'tok-dup-1', emailVerified: false, created: true }) });
    });
    await page.route('**/.netlify/functions/claim-pending-generation', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, found: true, claimed: true }) });
    });
    await page.route('**/.netlify/functions/video-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: false }) });
    });

    // Pass 1 — the registered email: generation fires, code step shows.
    await reachWall(page);
    await page.fill('#contact-email', REGISTERED_EMAIL);
    await page.click('#fn-contact-continue');
    await page.waitForSelector('#fn-login-code', { timeout: 5000 });
    await settle(function () { return startPendingCalls.length >= 1; });
    assert.equal(startPendingCalls.length, 1, 'first wall submit must start exactly one pending generation');

    // Pass 2 — "Use a different email", then retype the SAME address with
    // different casing (autofill/manual retyping rarely preserves case) —
    // must be recognized as unchanged and skip re-POSTing.
    await page.click('#fn-change-email');
    await page.waitForSelector('#contact-email');
    assert.equal(await page.locator('#contact-email').inputValue(), REGISTERED_EMAIL, 'the email should stay prefilled from the first pass');
    await page.fill('#contact-email', 'Dup-Registered@Example.com');
    await page.click('#fn-contact-continue');
    await page.waitForSelector('#fn-login-code', { timeout: 5000 });
    await settle(function () { return startPendingCalls.length >= 1; });
    assert.equal(startPendingCalls.length, 1, 'resubmitting the same content (same email, any casing) must not re-POST — that would double-charge fal.ai and double-spend tokens');

    // Pass 3 — a genuinely different email: a real change, so it must
    // resubmit, and (being unregistered) completes straight through.
    await page.click('#fn-change-email');
    await page.waitForSelector('#contact-email');
    await page.fill('#contact-email', 'dup-changed@example.com');
    await page.click('#fn-contact-continue');
    await settle(function () { return startPendingCalls.length >= 2; });
    assert.equal(startPendingCalls.length, 2, 'a genuinely changed email must still be allowed to start a new pending generation');
    assert.equal(startPendingCalls[1].email, 'dup-changed@example.com');
    await dismissMomentIfPresent(page); // the genuinely-changed email is a fresh signup -> dismiss the monetization moment
    await page.waitForURL(/home\.html/, { timeout: 15000 });
  } finally {
    await page.close();
  }
});

// ===========================================================================
// Stale-attempt token guards (signupAttemptToken) — the same "an async
// callback's side effects aren't scoped to the attempt that started them"
// discipline the old two-step tail carried (tracker items
// wizard-html-start-html-signup-step-force-8wtk8h and
// for-product-money-leak-blocked-signups-e-v2g1vi), re-verified against
// the merged wall's own submit paths. Back is disabled for the duration
// of an in-flight submit (defense-in-depth); each test force-enables it
// to isolate the deeper token guard itself.
// ===========================================================================

// Stale-attempt token guard — check-email stage. The retired chip-flow forced
// Back-to-recap to abandon an in-flight attempt; the funnel-arrival wall's Back
// leaves the page entirely, so the live, page-staying way to supersede a
// still-settling attempt is a fresh submit (supersedeInFlightAttempt), which
// bumps signupAttemptToken exactly as Back did. The guarded property is
// unchanged: a superseded attempt's belated response must fire no generation,
// create no account, and never navigate on its own.
test('wizard.html signup wall: a wall attempt superseded (by a fresh submit) before its check-email resolves must not, on its belated settlement, fire a generation, create an account, or navigate — stale-attempt token guard', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var EMAIL_A = 'wall-stale-a@example.com';
    var EMAIL_B = 'wall-stale-b@example.com';
    var startPendingEmails = [];
    var signupEmails = [];
    var checkEmailFor = [];
    var slowCheckA = gate();
    await page.route('**/.netlify/functions/check-dream-content', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ allowed: true, tier: 'clean' }) });
    });
    await page.route('**/.netlify/functions/check-email', async function (route) {
      var email = JSON.parse(route.request().postData()).email;
      checkEmailFor.push(email);
      if (email === EMAIL_A) { await slowCheckA.wait(); } // A's check-email held so the attempt is still settling when superseded
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, available: true, deliverable: true }) });
    });
    await page.route('**/.netlify/functions/start-pending-generation', function (route) {
      startPendingEmails.push(JSON.parse(route.request().postData()).email);
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pendingId: 'pd-stale', operationName: 'fal:fake-model:req-stale' }) });
    });
    await page.route('**/.netlify/functions/register-account-passwordless', function (route) {
      var email = JSON.parse(route.request().postData()).email;
      signupEmails.push(email);
      // B is treated as already-registered so it parks on the code step (page
      // stays put); A never reaches signup at all (its check-email is held).
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, pendingVerification: true }) });
    });

    await reachWall(page);
    await page.fill('#contact-email', EMAIL_A);
    await page.click('#fn-contact-continue');
    // Wait until A's check-email is genuinely in flight (held), past the gate.
    await settle(function () { return checkEmailFor.indexOf(EMAIL_A) !== -1; });

    // Supersede with a fresh submit (B) — bumps signupAttemptToken (exactly as
    // the retired Back-to-recap did) and parks on B's own code step.
    await supersedeInFlightAttempt(page, EMAIL_B);
    await page.waitForSelector('#fn-login-code', { timeout: 5000 });

    // ONLY NOW release A's held check-email — it settles into a superseded attempt.
    slowCheckA.open();
    await settle(function () { return slowCheckA.released; });
    await page.waitForTimeout(300);

    assert.equal(startPendingEmails.indexOf(EMAIL_A), -1, 'the superseded attempt (A) must never go on to fire a real, billed generation');
    assert.equal(signupEmails.indexOf(EMAIL_A), -1, 'the superseded attempt (A) must never go on to create an account');
    assert.ok(/wizard\.html/.test(page.url()), 'A\'s belated response must never navigate on its own — the user is still on B\'s code step');
    assert.equal(await page.locator('#fn-login-code').count(), 1, 'still sitting on B\'s code step');
  } finally {
    await page.close();
  }
});

test('wizard.html signup wall: a superseded submit\'s late passwordless-signup settlement must not navigate or claim once a newer attempt is current — outer token guard', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var claimCalls = [];
    var signupFor = [];
    var EMAIL_A = 'wall-race-a@example.com';
    var EMAIL_B = 'wall-race-b@example.com';
    var staleA = gate();
    await page.route('**/.netlify/functions/check-dream-content', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ allowed: true, tier: 'clean' }) });
    });
    await page.route('**/.netlify/functions/check-email', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, available: true, deliverable: true }) });
    });
    await page.route('**/.netlify/functions/start-pending-generation', function (route) {
      var body = JSON.parse(route.request().postData());
      var pendingId = body.email === EMAIL_A ? 'pd-race-A' : 'pd-race-B';
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pendingId: pendingId, operationName: 'fal:fake-model:req-' + pendingId }) });
    });
    await page.route('**/.netlify/functions/register-account-passwordless', async function (route) {
      var email = JSON.parse(route.request().postData()).email;
      signupFor.push(email);
      if (email === EMAIL_A) {
        // The superseded attempt — its signup is held until the user has
        // genuinely moved on to a fresh attempt for different content.
        await staleA.wait();
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, username: 'wallracea', email: EMAIL_A, authToken: 'tok-race-a', created: true }) });
        return;
      }
      // B resolves into the code step, so the page predictably STAYS put
      // — giving A's stale settlement a stable screen to (not) act on.
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, pendingVerification: true }) });
    });
    await page.route('**/.netlify/functions/claim-pending-generation', function (route) {
      claimCalls.push(JSON.parse(route.request().postData()));
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, found: true, claimed: true }) });
    });

    await reachWall(page);
    await page.fill('#contact-email', EMAIL_A);
    await page.click('#fn-contact-continue');
    // Wait until A's signup call is genuinely in flight (held).
    await settle(function () { return signupFor.indexOf(EMAIL_A) !== -1; });

    // Supersede with a fresh submit (B) — bumps signupAttemptToken; B parks on
    // its own code step, giving A's later settlement a stable screen to (not)
    // act on.
    await supersedeInFlightAttempt(page, EMAIL_B);
    await page.waitForSelector('#fn-login-code', { timeout: 5000 });

    // Sit on B's code step and ONLY NOW let A's held-back settlement land.
    assert.equal(staleA.released, false, 'sanity: A must still have been in flight while attempt B ran — that is the race being tested');
    staleA.open();
    await settle(function () { return staleA.released; });
    await page.waitForTimeout(400);

    assert.ok(/wizard\.html/.test(page.url()), 'A\'s stale settlement must never force-navigate away from the screen the user is actually on');
    assert.equal(await page.locator('#fn-login-code').count(), 1, 'must still be sitting on B\'s code step');
    assert.equal(claimCalls.length, 0, 'A\'s stale settlement must not have claimed any pending job');
  } finally {
    await page.close();
  }
});

test('wizard.html signup wall: the token guard also protects the NESTED pendingPromise continuation inside completeSignupAndAdvance — a signup that already resolved ok must still discard its late generation settlement if the attempt was superseded in the gap', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    var claimCalls = [];
    var signupFor = [];
    var startPendingFor = [];
    var EMAIL_A = 'wall-inner-race@example.com';
    var EMAIL_B = 'wall-inner-race-b@example.com';
    var slowGeneration = gate();
    await page.route('**/.netlify/functions/check-dream-content', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ allowed: true, tier: 'clean' }) });
    });
    await page.route('**/.netlify/functions/check-email', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, available: true, deliverable: true }) });
    });
    // The INNER wait: A's signup resolves fast, so completeSignupAndAdvance's
    // outer entry runs immediately and is left waiting on this held-back
    // generation call — the exact window the nested isStale re-check covers.
    await page.route('**/.netlify/functions/start-pending-generation', async function (route) {
      var email = JSON.parse(route.request().postData()).email;
      startPendingFor.push(email);
      await slowGeneration.wait();
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pendingId: 'pd-inner-' + (email === EMAIL_A ? 'A' : 'B'), operationName: 'fal:fake-model:req-inner-' + (email === EMAIL_A ? 'A' : 'B') }) });
    });
    await page.route('**/.netlify/functions/register-account-passwordless', function (route) {
      var email = JSON.parse(route.request().postData()).email;
      signupFor.push(email);
      // A: a real fresh signup (so completeSignupAndAdvance enters and awaits
      // the held generation). B: already-registered, so it parks on its code
      // step (page stays put) once released.
      if (email === EMAIL_A) {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, username: 'innerracer', email: EMAIL_A, authToken: 'tok-inner-1', created: true }) });
      } else {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, pendingVerification: true }) });
      }
    });
    await page.route('**/.netlify/functions/claim-pending-generation', function (route) {
      claimCalls.push(1);
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, found: true, claimed: true }) });
    });

    await reachWall(page);
    await page.fill('#contact-email', EMAIL_A);
    await page.click('#fn-contact-continue');
    // A's signup has resolved (fast) and completeSignupAndAdvance is now
    // awaiting the held generation — the exact window the nested re-check covers.
    await settle(function () { return signupFor.indexOf(EMAIL_A) !== -1; });

    // Supersede AFTER the outer check passed — only the NESTED re-check can
    // catch this. A fresh submit (B) bumps signupAttemptToken.
    await supersedeInFlightAttempt(page, EMAIL_B);
    await settle(function () { return startPendingFor.indexOf(EMAIL_B) !== -1; });

    // Release the held generation: A's nested continuation settles (now stale
    // — must self-discard), and B parks on its own code step.
    slowGeneration.open();
    await settle(function () { return slowGeneration.released; });
    await page.waitForSelector('#fn-login-code', { timeout: 5000 });
    await page.waitForTimeout(300);

    assert.ok(/wizard\.html/.test(page.url()), 'the stale inner continuation must never force-navigate to home.html');
    assert.equal(claimCalls.length, 0, 'the stale inner continuation must not claim the pending job (it must discard itself via the nested isStale re-check, not just rely on the outer one)');
  } finally {
    await page.close();
  }
});

test('wizard.html signup wall: if the pre-account generation call fails, signup still completes and falls back to a fresh generation at home.html (resilient, not a dead end)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await page.route('**/.netlify/functions/check-email', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, available: true, deliverable: true }) });
    });
    await page.route('**/.netlify/functions/start-pending-generation', function (route) {
      route.fulfill({ status: 402, contentType: 'application/json', body: JSON.stringify({ error: 'E7: insufficient_tokens' }) });
    });
    // home.html's own fresh-submission fallback (?generate=1) genuinely
    // calls DreamStore.generateVideo() — mocked so this test can observe
    // the fallback actually firing. video-status deliberately never
    // resolves done:true — this test only needs to see a pendingJob get
    // created, not the full generation through to completion.
    await page.route('**/.netlify/functions/generate-video', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'fal:fake-model:req-fallback' }) });
    });
    await page.route('**/.netlify/functions/video-status*', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: false }) });
    });

    await reachWall(page);
    await page.fill('#contact-email', 'fallback-test@example.com');
    await page.click('#fn-contact-continue');

    // Signup (static-server-degraded local passwordless) still completes
    // despite the failed generation call. Wait for DreamStore to actually
    // be defined on the NEW document, not merely for the URL to change —
    // see this codebase's documented navigation-commit race.
    await dismissMomentIfPresent(page); // fresh signup (pendingStartFailed path still creates the account) -> dismiss the moment; navUrl is home.html?generate=1, so the fresh fallback generation still runs
    await page.waitForFunction(function () {
      return window.location.pathname.indexOf('home.html') !== -1 && !!window.DreamStore;
    }, null, { timeout: 15000 });
    var draft = await page.evaluate(function () { return window.DreamStore.getDraft(); });
    assert.ok(draft.caption, 'draft caption must still be set for the fallback fresh-generation path');
    // A real generation is genuinely submitted fresh here by home.html's
    // own ?generate=1 handling — the observable proof the fallback worked.
    await page.waitForFunction(function () {
      return !!(window.DreamStore && window.DreamStore.getPendingJob());
    }, null, { timeout: 10000 });
  } finally {
    await page.close();
  }
});

test('claim-dream.html: a ready pending dream shows the video immediately (no login required) and lets a new visitor sign up to save it', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await page.route('**/.netlify/functions/verify-pending-claim', function (route) {
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          ok: true, pendingId: 'pd-claim-1', email: 'claimed@example.com',
          caption: 'a finished dream about flying', style: 'Cinematic',
          videoUrl: 'https://example.com/fake-video.mp4', status: 'notified'
        })
      });
    });
    await page.route('**/.netlify/functions/claim-pending-generation', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, found: true }) });
    });
    await page.route('https://example.com/fake-video.mp4', function (route) {
      route.fulfill({ status: 200, contentType: 'video/mp4', body: Buffer.from('x') });
    });

    await safeGoto(page, baseUrl + '/claim-dream.html?pending=pd-claim-1&token=fake-token-xyz');

    // Video shows immediately -- no login/signup required just to watch.
    await page.waitForSelector('#ready-view', { state: 'visible', timeout: 5000 });
    var videoSrc = await page.locator('#ready-video').getAttribute('src');
    assert.equal(videoSrc, 'https://example.com/fake-video.mp4');
    assert.equal(await page.locator('#signup-view').isVisible(), true);

    await page.fill('#claim-username', 'claimtester');
    await page.fill('#claim-password', 'longenoughpassword1');
    await page.click('#claim-signup-btn');

    await page.waitForURL(/result\.html\?id=/, { timeout: 10000 });
    var dreams = await page.evaluate(function () {
      var state = JSON.parse(localStorage.getItem('dreamtube_state_v1'));
      return state.dreams;
    });
    assert.equal(dreams.length, 1);
    assert.equal(dreams[0].caption, 'a finished dream about flying');
    assert.equal(dreams[0].videoUrl, 'https://example.com/fake-video.mp4');
  } finally {
    await page.close();
  }
});

test('claim-dream.html: an invalid/expired token shows a clear error, not a broken page', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await page.route('**/.netlify/functions/verify-pending-claim', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'E4: invalid_or_expired' }) });
    });
    await safeGoto(page, baseUrl + '/claim-dream.html?pending=pd-x&token=bad-token');
    await page.waitForSelector('#error-view', { state: 'visible', timeout: 5000 });
    assert.match(await page.locator('#error-title').textContent(), /expired/i);
  } finally {
    await page.close();
  }
});

test('create.html "Build it": logged-in retrofit reaches style.html with a chip-assembled caption, no free-text style clause baked in', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await safeGoto(page, baseUrl + '/login.html');
    await page.evaluate(function () {
      var state = { user: { handle: '@buildtester', username: 'buildtester' }, accounts: { buildtester: { password: 'testpass1', email: 'buildtester@example.com' } }, dreams: [], draft: { caption: '', style: null, characterIds: [], sceneryTime: null, sceneryPlace: null, restore: false }, charactersByUser: {}, likedIds: {} };
      localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    });

    await safeGoto(page, baseUrl + '/create.html');
    await page.click('#choice-build');

    await page.waitForSelector('#build-subject-chip-row');
    await page.click('[data-build-subj-other="none"]');
    await page.click('#build-subject-continue');

    // 3-question trim (founder 08-13): Subject -> Action directly (Setting
    // inferred), Action -> Free text directly (Mood defaults to 'dreamy').
    await page.waitForSelector('#build-action-row');
    assert.equal(await page.locator('#build-action-continue').count(), 1);
    // "exploring" is curated behind the "+N more" expander by default now
    // (tracker item for-product-wizard-step-3-has-too-many-c-lrg1ct) --
    // expand before selecting it, same as a real visitor would have to.
    await page.click('#build-action-more-toggle');
    await page.click('[data-build-action="exploring"]');
    await page.click('#build-action-continue');

    await page.waitForSelector('#build-freetext-input');
    await page.click('#build-freetext-skip');

    await page.waitForURL(/style\.html/, { timeout: 5000 });
    // waitForURL only guarantees the navigation committed -- style.html's
    // own js/store.js may not have executed yet, so wait for DreamStore
    // itself before reading it (see wizard-ui-behavioral.test.js's own
    // note on this hazard).
    await page.waitForFunction(function () { return !!window.DreamStore; }, null, { timeout: 5000 });
    var draft = await page.evaluate(function () { return window.DreamStore.getDraft(); });
    assert.ok(draft.caption.length > 0);
    assert.doesNotMatch(draft.caption, /Cinematic style/, 'the real style choice belongs to style.html, not baked in early');
    assert.match(draft.caption, /dreamlike\.$/);
  } finally {
    await page.close();
  }
});

// ===========================================================================
// create.html Layout-B parity (tracker item
// for-product-founder-picked-layout-b-flo--lks7mj): the logged-in "Build it"
// flow now wears the same Flo pill-row skin as wizard.html + the funnel, with
// two founder-ruled interaction specifics that DIFFER from a naive port:
//   - Action (chip + POV) must NOT auto-advance on the primary tap — it
//     carries a secondary POV choice, so it requires Continue. (Founder:
//     action tap was skipping POV.)
// The Setting (place + Day/Night) and Mood auto-advance behaviors this block
// once also covered were REMOVED by the 3-question wizard trim (founder
// directive 08-13: unify to the shorter version; those two steps are parked
// and no longer in the active flow — see create.html BUILD_RENDERERS).
// The pre-existing test above already pins the caption/draft contract; this
// pins the remaining behavior delta. Skin is byte-stable logic — no
// analytics/payload assertions change.
// ===========================================================================

test('create.html Layout-B: the Action step does NOT auto-advance on a chip tap — its POV secondary toggle stays reachable — then Continue advances straight to Free text (3-question trim: Subject -> Action -> Free text)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await gotoCreateBuild(page);

    // Subject: skip straight past. Setting is inferred (no step), so this
    // lands directly on Action.
    await page.click('#build-subject-skip');

    // Action: tap a chip, then confirm we're STILL on Action and POV is
    // still toggleable afterwards (it carries the POV secondary field).
    await page.waitForSelector('#build-action-row [data-build-action="flying"]');
    await page.click('#build-action-row [data-build-action="flying"]');
    await page.waitForTimeout(400); // longer than the 260ms auto-advance window
    assert.equal(await page.locator('#build-action-row').count(), 1, 'Action must NOT auto-advance on a chip tap — it carries the POV toggle');
    await page.click('.fn-toggle-row .fn-switch-track'); // the POV switch (the hidden checkbox is toggled via its label)
    assert.equal(await page.isChecked('#build-pov-toggle'), true, 'POV toggle is still reachable after the action tap');
    await page.click('#build-action-continue');

    // Action -> Free text directly (Mood is parked / defaults to 'dreamy').
    await page.waitForSelector('#build-freetext-input', { timeout: 3000 });
    assert.equal(await page.locator('#build-freetext-input').count(), 1, 'Action Continue advances straight to Free text');
  } finally {
    await page.close();
  }
});

test('create.html Layout-B: tapping Me opens the character sheet, and an uploaded photo flows straight into the generation draft characterIds (logged-in — no cross-origin stash), with POV riding into the caption', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await gotoCreateBuild(page);

    // Subject: open the Me sheet, switch to Upload photo, attach a photo, Save.
    await page.click('#build-subj-add-self');
    await page.waitForSelector('#build-sheet-character-overlay.open');
    await page.click('#build-char-mode-row .char-mode-btn[data-char-mode="photo"]');
    await page.setInputFiles('#build-char-photo-input', { name: 'me.png', mimeType: 'image/png', buffer: TINY_PNG_BUFFER });
    await page.waitForSelector('#build-char-photo-preview img');
    await page.click('#build-char-save-btn');
    await page.waitForSelector('#build-sheet-character-overlay:not(.open)');
    // The Me chip is now selected (pink), as a Layout-B pill row.
    assert.equal(await page.locator('#build-subject-chip-row .char-chip.selected').count(), 1, 'saving the Me photo selects the Me character row');
    // The real store character carries the photo (logged-in, straight to generation).
    var meHasPhoto = await page.evaluate(function () {
      return window.DreamStore.getCharacters().some(function (c) { return c.isSelf && !!c.photoDataUrl; });
    });
    assert.equal(meHasPhoto, true, 'the uploaded photo is persisted on the real Me character');
    await page.click('#build-subject-continue');

    // 3-question trim (founder 08-13): Subject -> Action directly (Setting
    // inferred). Turn POV ON on the Action step, then Continue -> Free text
    // directly (Mood parked / defaults to 'dreamy').
    await page.waitForSelector('#build-action-row [data-build-action="flying"]');
    await page.click('#build-action-row [data-build-action="flying"]');
    await page.click('.fn-toggle-row .fn-switch-track');
    await page.click('#build-action-continue');

    await page.waitForSelector('#build-freetext-input');
    await page.click('#build-freetext-continue');

    await page.waitForURL(/style\.html/, { timeout: 5000 });
    await page.waitForFunction(function () { return !!window.DreamStore; }, null, { timeout: 5000 });
    var draft = await page.evaluate(function () { return window.DreamStore.getDraft(); });
    assert.equal(draft.characterIds.length, 1, 'the Me character rides into the generation draft as characterIds (no cross-origin stash needed logged-in)');
    assert.match(draft.caption, /POV/, 'POV rides into the assembled caption');
  } finally {
    await page.close();
  }
});

// ===========================================================================
// Layout-B redesign coverage (tracker item
// for-product-founder-picked-layout-b-flo--lks7mj — the founder-approved
// pill-row wizard skin, seven mock rounds on the since-deleted
// mock-wizard-b-x7q4.html). The redesign is skin + two founder-directed
// interaction changes; these tests pin exactly those:
//   - single-select steps AUTO-advance ~260ms after a tap (no Continue
//     needed), and a Continue tap inside that window advances exactly ONCE
//   - the Subject step's Me row stages+selects inline and reveals its
//     OPTIONAL detail input DIRECTLY below its own row (founder 08-04
//     ruling: the details ask lives at the chip pick or nowhere), typed
//     details reach both the caption and the flushed real character
//   - a detail-less Me never blocks Continue and never produces a
//     half-empty store character
//   - the wall's recap is EDITABLE and the edited text (storyText) rides
//     the real submission, un-clobbered by the late LLM rewrite
// NOTE (repo landmine): never assert.equal an ElementHandle against null —
// boolean asserts only (assert.ok((await page.$(...)) === null, ...)).
// ===========================================================================

// ===========================================================================
// Entry-chooser mode analytics (founder ask 2026-08-07, routed onto the
// Layout-B branch): 'wizard_entry_mode_chosen' { mode, surface:'create' }
// fires ONCE per committed chooser tap on create.html's Build/Write/Record
// pills — the single sanctioned event addition on this otherwise
// analytics-frozen branch. Same PostHog-stub-queue read as
// test/phase1-product-events-behavioral.test.js (blockThirdParty aborts
// the real PostHog script, so captures stay queued on the pre-init stub).
// ===========================================================================

/** Same posthog stub-queue read as test/phase1-product-events-behavioral.test.js's readPostHogCaptureCalls — see that file's header for why this beats a monkeypatch. */
function readEntryModeEvents(page) {
  return page.evaluate(function () {
    var queue = (window.posthog && typeof window.posthog.slice === 'function') ? window.posthog.slice() : [];
    return queue.filter(function (entry) { return entry[0] === 'capture' && entry[1] === 'wizard_entry_mode_chosen'; })
      .map(function (entry) { return entry[2]; });
  });
}

test('create.html entry chooser: each pill tap fires wizard_entry_mode_chosen exactly once with its own mode and surface:"create" — Build, Write, and Record each', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await safeGoto(page, baseUrl + '/login.html');
    await page.evaluate(function () {
      var state = { user: { handle: '@modeevent', username: 'modeevent' }, accounts: { modeevent: { password: 'testpass1', email: 'modeevent@example.com' } }, dreams: [], draft: {}, charactersByUser: {}, likedIds: {} };
      localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    });

    // Build — a real tap; the event must fire once, immediately (before
    // the Layout-B flash delay resolves, since the tap IS the choice).
    await safeGoto(page, baseUrl + '/create.html');
    await page.click('#choice-build');
    var buildEvents = await readEntryModeEvents(page);
    assert.equal(buildEvents.length, 1, 'exactly ONE wizard_entry_mode_chosen per Build tap');
    assert.deepEqual(buildEvents[0], { mode: 'build', surface: 'create' });

    // Write — fresh page load (fresh stub queue), same shape.
    await safeGoto(page, baseUrl + '/create.html');
    await page.click('#choice-write');
    var writeEvents = await readEntryModeEvents(page);
    assert.equal(writeEvents.length, 1, 'exactly ONE wizard_entry_mode_chosen per Write tap');
    assert.deepEqual(writeEvents[0], { mode: 'write', surface: 'create' });

    // Record — the event fires synchronously in the tap handler, BEFORE
    // startRecordingUI's getUserMedia (which may fail in headless — the
    // choice was still made and must still count).
    await safeGoto(page, baseUrl + '/create.html');
    await page.click('#choice-record');
    var recordEvents = await readEntryModeEvents(page);
    assert.equal(recordEvents.length, 1, 'exactly ONE wizard_entry_mode_chosen per Record tap');
    assert.deepEqual(recordEvents[0], { mode: 'record', surface: 'create' });
  } finally {
    await page.close();
  }
});

// ===========================================================================
// Round-8 entry chooser on wizard.html itself (founder: "Clicking get
// started skips the choosing between the 3 options"): fresh entries meet
// the mock's screen-1 chooser (build/write/speak) BEFORE the step flow.
// A pre-step outside SCREEN_RENDERERS — fires wizard_entry_mode_chosen
// { mode, surface:'wizard' } only, never a wizard_step_viewed, so every
// existing step number stays byte-stable.
// ===========================================================================

// ===========================================================================
// Round 9 (08-07 live-main bug hunt, founder "find and fix"): the story
// pin is SIGNATURE-based now — a settled story (LLM-upgraded or
// hand-edited) sticks for as long as the dream's content signature is
// unchanged, and releases only on a real content change. Kills bug #1
// (wall→Back degraded the recap to the raw template and re-billed a
// duplicate rewrite per revisit) and #2 (an accidental Back→Forward wiped
// a hand-edit). Bug #3's sentence-cased join is covered here behaviorally
// and unit-level in test/wizard-chips.test.js.
// ===========================================================================
