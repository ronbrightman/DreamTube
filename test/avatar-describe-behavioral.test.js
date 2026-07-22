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
