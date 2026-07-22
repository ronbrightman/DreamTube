// test/avatar-describe-behavioral.test.js
//
// Real browser-driven coverage for the "Me" character's Describe option
// actually generating a real avatar image (netlify/functions/
// generate-avatar.js), on both profile.html's identity-edit sheet and
// create.html's self-mode character sheet -- previously Describe only
// ever stored the typed text and left the avatar blank/placeholder. No
// local Netlify Functions runtime is available to these tests (see
// test/helpers/static-server.js's own doc comment), so the call is
// intercepted via Playwright's page.route(), same pattern test/
// ui-behavioral.test.js's mockGetFeed and test/profile-me-character-
// behavioral.test.js's mockGenerateAvatar use.
//
// Follows test/profile-me-character-behavioral.test.js's own conventions
// (node:test + real Chromium via Playwright, state seeded directly into
// localStorage, every page.goto wrapped against this sandbox's known
// intermittent outbound-network stalls on third-party hosts).

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

function readState(page) {
  return page.evaluate(function () {
    return JSON.parse(localStorage.getItem('dreamtube_state_v1'));
  });
}

var GENERATED_AVATAR = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

/**
 * Intercepts the real call to netlify/functions/generate-avatar.js. Waits
 * a short, deliberate delay before fulfilling (default 300ms) -- a real
 * fal.ai call is nowhere near instant, and a mock that resolves same-tick
 * makes any assertion on the button's loading state a timing race (the UI
 * update and the mock's resolution can land in either order depending on
 * the runtime's microtask scheduling that particular run). Pass
 * `delayMs: 0` for tests that don't care about the loading state at all.
 */
function mockGenerateAvatar(page, opts) {
  opts = opts || {};
  var delayMs = opts.delayMs === undefined ? 300 : opts.delayMs;
  return page.route('**/.netlify/functions/generate-avatar', async function (route) {
    if (delayMs > 0) await new Promise(function (r) { setTimeout(r, delayMs); });
    if (opts.fail) {
      route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: 'E6: ' + (opts.failMessage || 'The description was flagged by the safety system. Try removing age or other sensitive details, or rephrase the description.') }) });
      return;
    }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ photoDataUrl: opts.photoDataUrl || GENERATED_AVATAR }) });
  });
}

/**
 * Stands in for the page's real resizeImageFile (FileReader -> Image decode
 * -> canvas draw) with a promise this test controls the resolution of.
 * There's no network call in that pipeline for page.route() to intercept
 * (unlike generate-avatar.js above), so this is the only reliable way to
 * hold a photo pick pending long enough to race a Cancel-then-reopen
 * against it. Safe to install any time after the page's own <script> has
 * already run: resizeImageFile is a plain top-level function declaration in
 * a non-module classical script, so it's a `window` property just like
 * `fetch`, and every call site looks the identifier up by name at call
 * time -- reassigning `window.resizeImageFile` redirects them exactly like
 * overriding `window.fetch` would.
 */
function armControllableResize(page) {
  return page.evaluate(function () {
    window.resizeImageFile = function () {
      return new Promise(function (resolve) { window.__resolveResize = resolve; });
    };
  });
}

test('profile.html: Describe mode calls generate-avatar.js and stores the returned image as photoDataUrl -- reflected on create.html\'s self sheet with no extra plumbing', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  var capturedRequestBody = null;
  try {
    await seedUser(page, null);
    // See mockGenerateAvatar's own doc comment for why this waits before
    // fulfilling rather than resolving same-tick.
    await page.route('**/.netlify/functions/generate-avatar', async function (route) {
      capturedRequestBody = JSON.parse(route.request().postData());
      await new Promise(function (r) { setTimeout(r, 300); });
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ photoDataUrl: GENERATED_AVATAR }) });
    });
    await safeGoto(page, baseUrl + '/profile.html');

    await page.click('#profile-handle');
    await page.waitForSelector('#sheet-identity-overlay.open');
    // Describe is the default mode -- no need to click it explicitly.
    await page.fill('#identity-desc-input', 'a tall person with curly brown hair and glasses');

    await page.click('#identity-save-btn');
    // The button must show a real loading state while the (mocked) network
    // call is in flight -- this is no longer an instant, synchronous save.
    await page.waitForSelector('#identity-save-btn:has-text("Generating avatar")');
    await page.waitForSelector('#sheet-identity-overlay:not(.open)');

    // The description text was sent to the endpoint, untouched.
    assert.equal(capturedRequestBody.description, 'a tall person with curly brown hair and glasses');

    // profile.html's own avatar renders the generated image immediately.
    assert.equal(await page.locator('#profile-avatar img').getAttribute('src'), GENERATED_AVATAR);

    var state = await readState(page);
    var me = state.charactersByUser.tester.filter(function (c) { return c.isSelf; })[0];
    assert.equal(me.photoDataUrl, GENERATED_AVATAR, 'the generated image must be stored as photoDataUrl -- the exact same field "Upload photo" uses');

    // Bidirectional sync: create.html's self-mode sheet reads the exact
    // same DreamStore.saveCharacter record, no separate storage path.
    await safeGoto(page, baseUrl + '/create.html');
    await page.click('#choice-write');
    await page.click('#adv-toggle');
    await page.click('[data-char-edit="' + me.id + '"]');
    await page.waitForSelector('#sheet-character-overlay.open');
    // Since a photoDataUrl is now present, the sheet opens in "Upload photo"
    // mode showing that image -- indistinguishable from a real upload, per
    // generate-avatar.js's own design intent.
    assert.equal(await page.locator('[data-char-mode="photo"]').evaluate(function (el) { return el.classList.contains('active'); }), true);
    assert.equal(await page.locator('#char-photo-preview img').getAttribute('src'), GENERATED_AVATAR);
  } finally {
    await page.close();
  }
});

test('create.html: self-mode sheet\'s Describe option also generates a real avatar, reflected on profile.html', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await seedUser(page, null);
    await mockGenerateAvatar(page);
    await safeGoto(page, baseUrl + '/create.html');
    await page.click('#choice-write');
    await page.click('#adv-toggle');

    await page.click('#char-add-self');
    await page.waitForSelector('#sheet-character-overlay.open');
    // Describe is the default sub-mode for a brand-new self character.
    await page.fill('#char-desc-input', 'short with a shaved head and a beard');
    await page.click('#char-save-btn');
    await page.waitForSelector('#char-save-btn:has-text("Generating avatar")');
    await page.waitForSelector('#sheet-character-overlay:not(.open)');

    var state = await readState(page);
    var me = state.charactersByUser.tester.filter(function (c) { return c.isSelf; })[0];
    assert.equal(me.photoDataUrl, GENERATED_AVATAR);
    assert.equal(me.description, 'short with a shaved head and a beard');

    await safeGoto(page, baseUrl + '/profile.html');
    assert.equal(await page.locator('#profile-avatar img').getAttribute('src'), GENERATED_AVATAR);
  } finally {
    await page.close();
  }
});

test('a non-self character\'s Describe option is unaffected -- never calls generate-avatar.js, stays plain text', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  var calls = 0;
  try {
    await seedUser(page, null);
    await page.route('**/.netlify/functions/generate-avatar', function (route) {
      calls += 1;
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ photoDataUrl: GENERATED_AVATAR }) });
    });
    await safeGoto(page, baseUrl + '/create.html');
    await page.click('#choice-write');
    await page.click('#adv-toggle');

    await page.click('#char-add-other');
    await page.waitForSelector('#sheet-character-overlay.open');
    await page.fill('#char-name-input', 'Mom');
    await page.fill('#char-desc-input', 'short grey hair, warm smile');
    await page.click('#char-save-btn');
    await page.waitForSelector('#sheet-character-overlay:not(.open)');

    assert.equal(calls, 0, 'generate-avatar.js must never be called for a non-self character');
    var state = await readState(page);
    var mom = state.charactersByUser.tester.filter(function (c) { return c.name === 'Mom'; })[0];
    assert.equal(mom.description, 'short grey hair, warm smile');
    assert.equal(mom.photoDataUrl, undefined);
  } finally {
    await page.close();
  }
});

test('a failed generation shows a clear error, re-enables Save, and never loses the typed description or leaves the sheet stuck', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await seedUser(page, null);
    await mockGenerateAvatar(page, { fail: true, failMessage: 'The description was flagged by the safety system. Try removing age or other sensitive details, or rephrase the description.' });
    await safeGoto(page, baseUrl + '/profile.html');

    await page.click('#profile-handle');
    await page.waitForSelector('#sheet-identity-overlay.open');
    await page.fill('#identity-desc-input', 'a description that gets flagged');
    await page.click('#identity-save-btn');

    // Sheet stays open, a clear (humanized, not raw "E6:"-prefixed) error appears.
    await page.waitForSelector('#identity-error:has-text("flagged by the safety system")');
    assert.equal(await page.locator('#sheet-identity-overlay').getAttribute('class'), 'sheet-overlay open');
    var errorText = await page.locator('#identity-error').textContent();
    assert.equal(errorText.indexOf('E6:'), -1, 'the raw error code prefix must never reach the user');

    // Save button is re-enabled with its normal label, not stuck on "Generating...".
    assert.equal(await page.locator('#identity-save-btn').isDisabled(), false);
    assert.equal(await page.locator('#identity-save-btn').textContent(), 'Save');

    // The typed description survives the failure -- nothing was cleared.
    assert.equal(await page.locator('#identity-desc-input').inputValue(), 'a description that gets flagged');

    // No character was ever created/saved on this failed attempt.
    var state = await readState(page);
    assert.equal((state.charactersByUser.tester || []).length, 0);
  } finally {
    await page.close();
  }
});

test('profile.html: clicking Cancel while a generate-avatar.js call is still pending discards the result -- no character saved, no toast, once it resolves, and reopening the sheet immediately shows a ready Save button', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await seedUser(page, null);
    await mockGenerateAvatar(page);
    await safeGoto(page, baseUrl + '/profile.html');

    await page.click('#profile-handle');
    await page.waitForSelector('#sheet-identity-overlay.open');
    await page.fill('#identity-desc-input', 'a description the user backs out on');
    await page.click('#identity-save-btn');
    await page.waitForSelector('#identity-save-btn:has-text("Generating avatar")');

    // Back out while the (mocked) network call is still in flight.
    await page.click('#identity-cancel');
    await page.waitForSelector('#sheet-identity-overlay:not(.open)');

    // Reopen immediately -- before the stale call (300ms delay) has had any
    // chance to resolve. The Save button must already be back to its normal
    // ready state on open, not stuck disabled/showing "Generating avatar…"
    // from the abandoned first attempt (this is the round-2/round-3 bug:
    // the .then() callback's own button reset ran unconditionally, but only
    // once that stale call actually resolved -- reopening the sheet must
    // not have to wait for that).
    await page.click('#profile-handle');
    await page.waitForSelector('#sheet-identity-overlay.open');
    assert.equal(await page.locator('#identity-save-btn').isDisabled(), false, 'Save button must not still be disabled after immediately reopening the sheet');
    assert.equal(await page.locator('#identity-save-btn').textContent(), 'Save', 'Save button must show its normal ready label after reopening, not "Generating avatar…"');

    // Give the mocked call (300ms delay) time to resolve after the sheet
    // was already dismissed once.
    await new Promise(function (r) { setTimeout(r, 500); });

    var state = await readState(page);
    assert.equal((state.charactersByUser.tester || []).length, 0, 'no character should be created after Cancel, even once the pending generation resolves');
    var toastClass = await page.locator('#toast').getAttribute('class');
    assert.equal(/\bshow\b/.test(toastClass), false, '"Profile updated" toast must never appear for a cancelled save');

    // The reopened sheet's Save button must still read ready even after the
    // stale call has now resolved in the background.
    assert.equal(await page.locator('#identity-save-btn').isDisabled(), false);
    assert.equal(await page.locator('#identity-save-btn').textContent(), 'Save');
  } finally {
    await page.close();
  }
});

test('create.html: clicking Cancel while a generate-avatar.js call is still pending discards the result -- no character saved once it resolves, and reopening the sheet immediately shows a ready Save button', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  try {
    await seedUser(page, null);
    await mockGenerateAvatar(page);
    await safeGoto(page, baseUrl + '/create.html');
    await page.click('#choice-write');
    await page.click('#adv-toggle');

    await page.click('#char-add-self');
    await page.waitForSelector('#sheet-character-overlay.open');
    await page.fill('#char-desc-input', 'a description the user backs out on');
    await page.click('#char-save-btn');
    await page.waitForSelector('#char-save-btn:has-text("Generating avatar")');

    // Back out while the (mocked) network call is still in flight.
    await page.click('#char-cancel');
    await page.waitForSelector('#sheet-character-overlay:not(.open)');

    // Reopen immediately -- before the stale call (300ms delay) has had any
    // chance to resolve. Same round-2/round-3 bug coverage as the
    // profile.html test above: the Save button must be ready on open, not
    // waiting on the abandoned first call's own (unconditional) reset.
    await page.click('#char-add-self');
    await page.waitForSelector('#sheet-character-overlay.open');
    assert.equal(await page.locator('#char-save-btn').isDisabled(), false, 'Save button must not still be disabled after immediately reopening the sheet');
    assert.equal(await page.locator('#char-save-btn').textContent(), 'Save', 'Save button must show its normal ready label after reopening, not "Generating avatar…"');

    // Give the mocked call (300ms delay) time to resolve after the sheet
    // was already dismissed once.
    await new Promise(function (r) { setTimeout(r, 500); });

    var state = await readState(page);
    assert.equal((state.charactersByUser.tester || []).length, 0, 'no character should be created after Cancel, even once the pending generation resolves');

    // The reopened sheet's Save button must still read ready even after the
    // stale call has now resolved in the background.
    assert.equal(await page.locator('#char-save-btn').isDisabled(), false);
    assert.equal(await page.locator('#char-save-btn').textContent(), 'Save');
  } finally {
    await page.close();
  }
});

test('profile.html: cancelling a pending regeneration when editing an existing self character (with pre-existing photo/description) leaves that character untouched', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  var EXISTING_PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAA=';
  var existing = { id: 'me-existing-1', isSelf: true, name: 'Ron', description: 'the original description', photoDataUrl: EXISTING_PHOTO };
  try {
    await seedUser(page, existing);
    await mockGenerateAvatar(page);
    await safeGoto(page, baseUrl + '/profile.html');

    await page.click('#profile-handle');
    await page.waitForSelector('#sheet-identity-overlay.open');
    // The existing character has a photo, so the sheet opens in photo mode
    // -- switch to Describe and type a new description to trigger a real
    // regeneration call, same as the brand-new-character path.
    await page.click('[data-identity-mode="describe"]');
    await page.fill('#identity-desc-input', 'a new description for the regeneration attempt');
    await page.click('#identity-save-btn');
    await page.waitForSelector('#identity-save-btn:has-text("Generating avatar")');

    // Back out while the (mocked) regeneration call is still in flight.
    await page.click('#identity-cancel');
    await page.waitForSelector('#sheet-identity-overlay:not(.open)');

    // Reopen immediately -- same reopen-during-pending-call coverage as the
    // brand-new-character tests above, but for the edit-existing path.
    await page.click('#profile-handle');
    await page.waitForSelector('#sheet-identity-overlay.open');
    assert.equal(await page.locator('#identity-save-btn').isDisabled(), false, 'Save button must not still be disabled after immediately reopening the sheet');
    assert.equal(await page.locator('#identity-save-btn').textContent(), 'Save', 'Save button must show its normal ready label after reopening, not "Generating avatar…"');
    await page.click('#identity-cancel');

    // Give the mocked call (300ms delay) time to resolve after the sheet
    // was already dismissed.
    await new Promise(function (r) { setTimeout(r, 500); });

    var state = await readState(page);
    var me = state.charactersByUser.tester.filter(function (c) { return c.isSelf; })[0];
    assert.equal(me.description, 'the original description', 'the existing character must be untouched by the cancelled regeneration');
    assert.equal(me.photoDataUrl, EXISTING_PHOTO, 'the existing photo must not be overwritten by the cancelled regeneration');
  } finally {
    await page.close();
  }
});

test('describe mode left blank on a brand-new Me character skips the generation call entirely and surfaces saveCharacter\'s own validation', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  var calls = 0;
  try {
    await seedUser(page, null);
    await page.route('**/.netlify/functions/generate-avatar', function (route) {
      calls += 1;
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ photoDataUrl: GENERATED_AVATAR }) });
    });
    await safeGoto(page, baseUrl + '/profile.html');

    await page.click('#profile-handle');
    await page.waitForSelector('#sheet-identity-overlay.open');
    // Describe mode, left blank -- no network call should ever fire.
    await page.click('#identity-save-btn');
    await page.waitForSelector('#identity-error:has-text("Add a description or a photo")');
    assert.equal(calls, 0, 'an empty description must never trigger a real (or mocked) generation call');
  } finally {
    await page.close();
  }
});

// ===== Round-4 regression: the photo-upload path had the identical
// unguarded-async shape as the (now token-gated) generate-avatar path. =====
//
// resizeImageFile is a real multi-step async chain (FileReader -> Image
// decode -> canvas draw), easily slow enough to race a Cancel-then-reopen
// the same way generateAvatarFromDescription's call could. Unlike that
// call, there's nothing here for page.route() to intercept, so
// armControllableResize (above) stands in for the real pipeline with a
// promise these tests resolve on their own schedule.

test('profile.html: cancelling a photo pick before resizeImageFile resolves must not clobber a later reopen of the same sheet, nor let the stale photo get saved', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  var ORIGINAL_PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAA=';
  var STALE_PHOTO = 'data:image/jpeg;base64,ZmFrZS1zdGFsZS1waG90by1kYXRh';
  var existing = { id: 'me-existing-photo', isSelf: true, name: 'Ron', description: '', photoDataUrl: ORIGINAL_PHOTO };
  try {
    await seedUser(page, existing);
    await safeGoto(page, baseUrl + '/profile.html');

    await page.click('#profile-handle');
    await page.waitForSelector('#sheet-identity-overlay.open');
    // Existing character already has a photo, so the sheet opens straight into Photo mode.
    assert.equal(await page.locator('#identity-photo-preview img').getAttribute('src'), ORIGINAL_PHOTO);

    await armControllableResize(page);
    await page.setInputFiles('#identity-photo-input', PHOTO_FIXTURE);
    // Confirm the (stubbed) resize is genuinely pending before backing out.
    await page.waitForFunction(function () { return typeof window.__resolveResize === 'function'; });

    // Back out before the pending resize ever resolves.
    await page.click('#identity-cancel');
    await page.waitForSelector('#sheet-identity-overlay:not(.open)');

    // Reopen immediately -- openIdentitySheet's own unconditional reset must
    // show the character's real existing photo, not anything left over from
    // the abandoned pick.
    await page.click('#profile-handle');
    await page.waitForSelector('#sheet-identity-overlay.open');
    assert.equal(await page.locator('#identity-photo-preview img').getAttribute('src'), ORIGINAL_PHOTO, 'reopened sheet must show the character\'s real photo, not the abandoned pick');

    // Now let the stale resize resolve, well after the reopen.
    await page.evaluate(function (staleUrl) { window.__resolveResize(staleUrl); }, STALE_PHOTO);
    await page.waitForTimeout(100); // give its .then() a moment to run, if it were going to run at all

    assert.equal(await page.locator('#identity-photo-preview img').getAttribute('src'), ORIGINAL_PHOTO, 'the stale resize must not clobber the reopened sheet\'s preview once it resolves');

    // Save without re-picking a photo -- must persist the real photo, never the stale one.
    await page.click('#identity-save-btn');
    await page.waitForSelector('#sheet-identity-overlay:not(.open)');

    var state = await readState(page);
    var me = state.charactersByUser.tester.filter(function (c) { return c.isSelf; })[0];
    assert.equal(me.photoDataUrl, ORIGINAL_PHOTO, 'the stale, abandoned photo pick must never be persisted');
  } finally {
    await page.close();
  }
});

test('create.html: cancelling a photo pick on the self sheet, then reopening for a DIFFERENT (non-self) character, must not let the stale resize leak into either character once it resolves', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var page = await browser.newPage();
  await blockThirdParty(page);
  var ORIGINAL_PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAA=';
  var STALE_PHOTO = 'data:image/jpeg;base64,ZmFrZS1zdGFsZS1waG90by1kYXRh';
  var self_ = { id: 'self-1', isSelf: true, name: 'Ron', description: '', photoDataUrl: ORIGINAL_PHOTO };
  try {
    await seedUser(page, self_);
    // Add a second, non-self character directly into state -- seedUser only
    // seeds a single (optional) self character, same shortcut every other
    // test in this file/profile-me-character-behavioral.test.js uses.
    await page.evaluate(function () {
      var raw = localStorage.getItem('dreamtube_state_v1');
      var state = JSON.parse(raw);
      state.charactersByUser.tester.push({ id: 'mom-1', isSelf: false, name: 'Mom', description: 'short grey hair, warm smile' });
      localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
    });
    await safeGoto(page, baseUrl + '/create.html');
    await page.click('#choice-write');
    await page.click('#adv-toggle');

    // Open the self character's sheet (opens straight into Photo mode) and pick a new photo.
    await page.click('[data-char-edit="self-1"]');
    await page.waitForSelector('#sheet-character-overlay.open');
    assert.equal(await page.locator('#char-photo-preview img').getAttribute('src'), ORIGINAL_PHOTO);

    await armControllableResize(page);
    await page.setInputFiles('#char-photo-input', PHOTO_FIXTURE);
    await page.waitForFunction(function () { return typeof window.__resolveResize === 'function'; });

    // Back out before the pending resize ever resolves.
    await page.click('#char-cancel');
    await page.waitForSelector('#sheet-character-overlay:not(.open)');

    // Reopen for a DIFFERENT, non-self character -- a realistic flow on
    // create.html's char-chip-row, unlike profile.html which only ever has
    // one identity sheet. The non-self sheet has no photo picker at all
    // (char-mode-row/char-photo-area stay hidden for isSelf:false), so
    // saving it must never pick up the stale self-sheet photo either.
    await page.click('[data-char-edit="mom-1"]');
    await page.waitForSelector('#sheet-character-overlay.open');
    assert.equal(await page.locator('#char-sheet-title').textContent(), 'Edit character');
    assert.equal(await page.locator('#char-mode-row').isVisible(), false);
    await page.click('#char-save-btn');
    await page.waitForSelector('#sheet-character-overlay:not(.open)');

    var state = await readState(page);
    var mom = state.charactersByUser.tester.filter(function (c) { return c.name === 'Mom'; })[0];
    assert.equal(mom.photoDataUrl, undefined, 'a non-self character must never pick up the stale self-sheet photo');

    // Reopen the self character sheet -- its own onOpen reset shows the real
    // photo immediately, exactly like the profile.html test above.
    await page.click('[data-char-edit="self-1"]');
    await page.waitForSelector('#sheet-character-overlay.open');
    assert.equal(await page.locator('#char-photo-preview img').getAttribute('src'), ORIGINAL_PHOTO, 'reopened sheet must show the character\'s real photo, not the abandoned pick');

    // Only now does the stale resize resolve -- well after both the Mom
    // reopen AND this self-character reopen. This ordering is the actual
    // regression: resolving it *before* Mom or this reopen would be masked
    // by openCharSheet's own unconditional per-open reset regardless of any
    // token gating, so it wouldn't prove anything about this fix.
    await page.evaluate(function (staleUrl) { window.__resolveResize(staleUrl); }, STALE_PHOTO);
    await page.waitForTimeout(100);

    assert.equal(await page.locator('#char-photo-preview img').getAttribute('src'), ORIGINAL_PHOTO, 'the stale resize must not clobber the reopened sheet\'s preview once it resolves, even after being reopened for a different character along the way');

    // Save without re-picking a photo -- must persist the real photo, never the stale one.
    await page.click('#char-save-btn');
    await page.waitForSelector('#sheet-character-overlay:not(.open)');
    state = await readState(page);
    var me = state.charactersByUser.tester.filter(function (c) { return c.isSelf; })[0];
    assert.equal(me.photoDataUrl, ORIGINAL_PHOTO, 'the stale, abandoned photo pick must never be persisted onto the self character either');
  } finally {
    await page.close();
  }
});
