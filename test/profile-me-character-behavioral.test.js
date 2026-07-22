// test/profile-me-character-behavioral.test.js
//
// Real browser-driven coverage for two related pieces of work:
//
// 1. profile.html's new editable identity (name + photo), unified with the
//    "Me" character create.html's Advanced > Characters already reads and
//    writes (js/store.js's getCharacters/saveCharacter, isSelf:true) — not
//    a second, parallel identity store. Both pages call the exact same
//    DreamStore functions against the exact same state.charactersByUser
//    entry, so a change made from either page must be visible from the
//    other on its next render.
//
// 2. create.html's self-reference auto-detection (#dream-text), extended
//    beyond the existing "I"/"me" whole-word match to also match the Me
//    character's own name (full name or any individual word in it),
//    still silent/automatic like the existing behavior — no confirmation
//    step.
//
// Follows test/ui-behavioral.test.js's conventions: node:test + real
// Chromium via Playwright (not a project dependency — resolved from this
// sandbox's global install, see CLAUDE.md), state seeded directly into
// localStorage (same shortcut test/ui-behavioral.test.js's seedResultPage
// and test/first-video-created-behavioral.test.js use) rather than
// driving signup/login or a real generation, and every test/page.goto
// wrapped against this sandbox's known intermittent outbound-network
// stalls on third-party hosts (fonts/PostHog/Meta Pixel).

var test = require('node:test');
var assert = require('node:assert/strict');
var path = require('node:path');
var staticServer = require('./helpers/static-server');

var CHROMIUM_PATH = '/opt/pw-browsers/chromium';
var PHOTO_FIXTURE = path.join(__dirname, '..', 'assets', 'logo-v2.png');

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

/** Aborts requests to third-party hosts every page here loads (fonts, PostHog, Meta Pixel) -- none are needed for what these tests check, and this sandbox's outbound network can intermittently stall on them (see CLAUDE.md). */
function blockThirdParty(page) {
  return page.route(/fonts\.(googleapis|gstatic)\.com|connect\.facebook\.net|i\.posthog\.com/, function (route) {
    route.abort();
  });
}

/** Wraps page.goto so a transient network stall on a blocked-in-vain third-party request doesn't crash the whole run -- see CLAUDE.md's environment-quirk note. */
async function safeGoto(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  } catch (e) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  }
}

/**
 * Seeds js/store.js's localStorage state with a logged-in "tester" account
 * and (optionally) an existing self character, then leaves the page on
 * login.html having just done so -- the shortest path to a real,
 * authenticated render of profile.html/create.html without driving the
 * whole signup flow. Mirrors test/ui-behavioral.test.js's seedResultPage.
 */
async function seedUser(page, selfCharacter) {
  await safeGoto(page, baseUrl + '/login.html');
  await page.evaluate(function (selfCharacter) {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@tester', username: 'tester' };
    if (!state.accounts) state.accounts = {};
    state.accounts.tester = { password: 'testpass1', email: 'tester@example.com' };
    if (!state.charactersByUser) state.charactersByUser = {};
    state.charactersByUser.tester = selfCharacter ? [selfCharacter] : [];
    if (!state.dreams) state.dreams = [];
    if (!state.draft) {
      state.draft = { caption: '', style: null, sourceDreamId: null, restore: false, characterIds: [], cameraView: null, sceneryTime: null, sceneryPlace: null };
    } else {
      state.draft.characterIds = [];
      state.draft.caption = '';
    }
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, selfCharacter || null);
}

/** Reads the raw DreamStore state back out of localStorage for direct assertions. */
function readState(page) {
  return page.evaluate(function () {
    return JSON.parse(localStorage.getItem('dreamtube_state_v1'));
  });
}

test('profile.html: editing name + photo creates/updates the Me character, visible in create.html Advanced > Characters', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await seedUser(page, null); // no existing self character
    await safeGoto(page, baseUrl + '/profile.html');

    // Before any edit: falls back to the handle + placeholder emoji, no Me character yet.
    assert.equal(await page.locator('#profile-handle').textContent(), '@tester');
    assert.equal(await page.locator('#profile-avatar').textContent(), '🌙');

    await page.click('#profile-avatar-edit');
    await page.waitForSelector('#sheet-identity-overlay.open');
    await page.fill('#identity-name-input', 'Sarah Chen');
    await page.click('#identity-mode-row [data-identity-mode="photo"]');
    await page.setInputFiles('#identity-photo-input', PHOTO_FIXTURE);
    await page.waitForSelector('#identity-photo-preview img');
    await page.click('#identity-save-btn');

    // Sheet closes, toast confirms, and the page's own display updates immediately.
    await page.waitForSelector('#sheet-identity-overlay:not(.open)');
    assert.equal(await page.locator('#profile-handle').textContent(), 'Sarah Chen');
    assert.equal(await page.locator('#profile-avatar img').count(), 1);

    // The write went through the real saveCharacter API -- one isSelf character, name+photo set.
    var state = await readState(page);
    var chars = state.charactersByUser.tester;
    assert.equal(chars.length, 1);
    assert.equal(chars[0].isSelf, true);
    assert.equal(chars[0].name, 'Sarah Chen');
    assert.ok(chars[0].photoDataUrl && chars[0].photoDataUrl.indexOf('data:image') === 0);

    // Same account, create.html's own Advanced > Characters chip row -- no separate identity table.
    await safeGoto(page, baseUrl + '/create.html');
    await page.click('#choice-write');
    await page.click('#adv-toggle');
    var chipTexts = await page.locator('#char-chip-row .char-chip span').allTextContents();
    assert.ok(chipTexts.indexOf('Sarah Chen') !== -1, 'expected a "Sarah Chen" character chip, got: ' + JSON.stringify(chipTexts));
    // No "Add yourself" prompt once a self character already exists.
    assert.equal(await page.locator('#char-add-self').count(), 0);
  } finally {
    await page.close();
  }
});

test('create.html: editing the Me character\'s photo is reflected on profile.html, and the existing name survives the round-trip', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await seedUser(page, { id: 'cself1', name: 'Jordan', isSelf: true, description: 'tall with short dark hair' });
    await safeGoto(page, baseUrl + '/create.html');
    await page.click('#choice-write');
    await page.click('#adv-toggle');

    // Open the existing self character's edit sheet via its chip's edit icon.
    await page.click('[data-char-edit="cself1"]');
    await page.waitForSelector('#sheet-character-overlay.open');
    assert.equal(await page.locator('#char-sheet-title').textContent(), 'Edit yourself');
    // The name input is intentionally hidden for self characters in this
    // sheet (create.html has no self-mode name UI) -- but it must still
    // carry the existing name through so Save doesn't wipe it out.
    assert.equal(await page.locator('#char-name-input').inputValue(), 'Jordan');

    await page.click('#char-mode-row [data-char-mode="photo"]');
    await page.setInputFiles('#char-photo-input', PHOTO_FIXTURE);
    await page.waitForSelector('#char-photo-preview img');
    await page.click('#char-save-btn');
    await page.waitForSelector('#sheet-character-overlay:not(.open)');

    var state = await readState(page);
    var me = state.charactersByUser.tester.filter(function (c) { return c.isSelf; })[0];
    assert.equal(me.name, 'Jordan', 'name must survive an edit made from create.html\'s self sheet');
    assert.ok(me.photoDataUrl && me.photoDataUrl.indexOf('data:image') === 0);

    // Same account's profile.html picks up both without any separate sync step.
    await safeGoto(page, baseUrl + '/profile.html');
    assert.equal(await page.locator('#profile-handle').textContent(), 'Jordan');
    assert.equal(await page.locator('#profile-avatar img').count(), 1);
  } finally {
    await page.close();
  }
});

test('profile.html: can create the Me character for the first time (name + description, no prior create.html visit)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await seedUser(page, null);
    await safeGoto(page, baseUrl + '/profile.html');

    await page.click('#profile-handle');
    await page.waitForSelector('#sheet-identity-overlay.open');
    await page.fill('#identity-name-input', 'Alex');
    // Left in "Describe" mode (the default) -- exercises the no-photo, description-only path.
    await page.fill('#identity-desc-input', 'A friendly dreamer with curly hair');
    await page.click('#identity-save-btn');
    await page.waitForSelector('#sheet-identity-overlay:not(.open)');

    assert.equal(await page.locator('#profile-handle').textContent(), 'Alex');
    var state = await readState(page);
    var chars = state.charactersByUser.tester;
    assert.equal(chars.length, 1);
    assert.equal(chars[0].isSelf, true);
    assert.equal(chars[0].name, 'Alex');
    assert.equal(chars[0].description, 'A friendly dreamer with curly hair');
    assert.equal(chars[0].photoDataUrl, undefined);
  } finally {
    await page.close();
  }
});

test('create.html: typing the Me character\'s own name (not "I"/"me") into the dream text auto-attaches it', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await seedUser(page, { id: 'cself2', name: 'Priya Kapoor', isSelf: true, description: 'wears glasses' });
    await safeGoto(page, baseUrl + '/create.html');
    await page.click('#choice-write');
    await page.click('#adv-toggle');

    // Not yet selected before typing anything.
    var draftBefore = await page.evaluate(function () { return DreamStore.getDraft().characterIds; });
    assert.equal(draftBefore.length, 0);

    // No "I"/"me" anywhere in this sentence -- only the character's first name.
    await page.fill('#dream-text', 'Priya went swimming across a warm lake at sunset.');
    await page.waitForFunction(function () {
      return (DreamStore.getDraft().characterIds || []).length > 0;
    });

    var draftAfter = await page.evaluate(function () { return DreamStore.getDraft().characterIds; });
    assert.deepEqual(draftAfter, ['cself2']);
    var chipClass = await page.locator('[data-char-select="cself2"]').getAttribute('class');
    assert.ok(chipClass.indexOf('selected') !== -1, 'expected the Priya Kapoor chip to render selected, got class="' + chipClass + '"');

    // Also matches on the last name alone.
    await page.fill('#dream-text', '');
    await page.evaluate(function () { DreamStore.setDraft({ characterIds: [] }); });
    await page.fill('#dream-text', 'Kapoor was flying through the clouds.');
    await page.waitForFunction(function () {
      return (DreamStore.getDraft().characterIds || []).length > 0;
    });
    var draftLastName = await page.evaluate(function () { return DreamStore.getDraft().characterIds; });
    assert.deepEqual(draftLastName, ['cself2']);
  } finally {
    await page.close();
  }
});

test('create.html: a common word matching part of the Me character\'s name auto-attaches once, never duplicates, and never attaches without a Me character', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    // "Amber" is both a plausible first name and an ordinary English word
    // (a color/material) -- exactly the false-positive-prone case called
    // out in the task. Matching it is the intended, accepted behavior; the
    // only things under test here are "no duplicate" and "no Me character,
    // no attach, no crash".
    await seedUser(page, { id: 'cself3', name: 'Amber', isSelf: true, description: 'red hair' });
    await safeGoto(page, baseUrl + '/create.html');
    await page.click('#choice-write');
    await page.click('#adv-toggle');

    await page.fill('#dream-text', 'I was walking through an amber-lit forest at dusk.');
    await page.waitForFunction(function () {
      return (DreamStore.getDraft().characterIds || []).length > 0;
    });
    var afterFirstMatch = await page.evaluate(function () { return DreamStore.getDraft().characterIds; });
    assert.deepEqual(afterFirstMatch, ['cself3']);

    // Keep typing more text that still contains "amber" (and now "I") repeatedly --
    // must never end up with more than the one entry already attached.
    await page.fill('#dream-text', 'I was walking through an amber-lit forest full of amber light and I felt at home, amber everywhere.');
    await page.waitForTimeout(150); // let any (incorrect) duplicate-attach input handler settle
    var afterMoreTyping = await page.evaluate(function () { return DreamStore.getDraft().characterIds; });
    assert.deepEqual(afterMoreTyping, ['cself3'], 'must not duplicate the same character id');
  } finally {
    await page.close();
  }

  // Separate page/account state: no Me character saved at all.
  var page2 = await browser.newPage();
  await blockThirdParty(page2);
  try {
    await seedUser(page2, null);
    await safeGoto(page2, baseUrl + '/create.html');
    await page2.click('#choice-write');
    await page2.click('#adv-toggle');

    await page2.fill('#dream-text', 'I walked through an amber forest and saw my friend Amber waving.');
    await page2.waitForTimeout(200);
    var draftIds = await page2.evaluate(function () { return DreamStore.getDraft().characterIds || []; });
    assert.deepEqual(draftIds, [], 'nothing to attach -- no Me character exists yet');
    // No "Add yourself" chip crash/misrender either -- the row still renders normally.
    assert.equal(await page2.locator('#char-add-self').count(), 1);
  } finally {
    await page2.close();
  }
});

test('profile.html: a Me character created via create.html\'s actual "Add yourself" flow (no name field to fill) displays @handle, not the literal "Me"', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await seedUser(page, null); // no self character yet -- must go through the real "Add yourself" sheet
    await safeGoto(page, baseUrl + '/create.html');
    await page.click('#choice-write');
    await page.click('#adv-toggle');

    // The only first-party path to a Me character before this branch existed:
    // create.html's own "Add yourself" chip. Its sheet has no name-entry UI
    // at all for isSelf characters (char-name-input is hidden), so a real
    // user here can only ever set a photo and/or description -- never a name.
    await page.click('#char-add-self');
    await page.waitForSelector('#sheet-character-overlay.open');
    assert.equal(await page.locator('#char-sheet-title').textContent(), 'Add yourself');
    assert.equal(await page.locator('#char-name-input').isVisible(), false, 'self-mode sheet must not expose a name field');

    await page.click('#char-mode-row [data-char-mode="photo"]');
    await page.setInputFiles('#char-photo-input', PHOTO_FIXTURE);
    await page.waitForSelector('#char-photo-preview img');
    await page.click('#char-save-btn');
    await page.waitForSelector('#sheet-character-overlay:not(.open)');

    // The character was created with no real name -- js/store.js must not
    // have silently defaulted it to the literal string 'Me'.
    var state = await readState(page);
    var chars = state.charactersByUser.tester;
    assert.equal(chars.length, 1);
    assert.equal(chars[0].isSelf, true);
    assert.ok(!chars[0].name, 'a name-less "Add yourself" flow must not store a "Me" placeholder name, got: ' + JSON.stringify(chars[0].name));

    // The exact regression: profile.html's identity display must fall back
    // to the account handle here, not show the literal string "Me".
    await safeGoto(page, baseUrl + '/profile.html');
    assert.equal(await page.locator('#profile-handle').textContent(), '@tester');
  } finally {
    await page.close();
  }
});
