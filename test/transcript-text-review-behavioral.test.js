// test/transcript-text-review-behavioral.test.js
//
// Real browser-driven coverage for the text-review step inserted between
// transcription completing and moving on to style.html (tracker item
// transcription-t8pd3o, founder feedback: "after transcription we need
// another stage where user can see the text and edit it, like we have at
// the end of the wizard"). Before this, create.html's #review-continue
// handler used a raw Whisper transcript as the dream's caption with zero
// chance to see or fix it — transcription errors (mishearing, filler
// words, wrong names) went straight through to generation. Now, on a
// successful transcription, a new #create-transcript-review screen shows
// the transcript in an editable textarea; only clicking its own Continue
// button (#transcript-continue) commits a caption and navigates on, using
// whatever text is in the textarea at that moment.
//
// Follows test/record-mode-behavioral.test.js's conventions (same file,
// same repo): real Chromium via Playwright against this repo's static file
// server (test/helpers/static-server.js), a fake MediaRecorder/getUserMedia
// so no real microphone is touched, page.route() in place of a real
// Netlify Functions runtime for transcribe-audio.js/transcribe-status.js,
// node:test/assert. No real fal.ai transcription cost anywhere here.

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

/** Aborts requests to third-party hosts every page here loads (fonts, PostHog, Meta Pixel's real CDN script) -- see CLAUDE.md on this sandbox's outbound network. */
function blockThirdParty(page) {
  return page.route(/fonts\.(googleapis|gstatic)\.com|connect\.facebook\.net|i\.posthog\.com/, function (route) {
    route.abort();
  });
}

/**
 * Installs a fake navigator.mediaDevices.getUserMedia + window.MediaRecorder
 * before any page script runs, so create.html's real record -> stop flow can
 * run end to end without touching a real microphone. Fires one real
 * 'dataavailable' event with a non-empty Blob on start() so the resulting
 * recordedBlob isn't degenerate, matching what a real recording produces.
 */
async function installMediaRecorderMock(context) {
  await context.addInitScript(function () {
    var fakeStream = { getTracks: function () { return []; } };
    if (!navigator.mediaDevices) navigator.mediaDevices = {};
    navigator.mediaDevices.getUserMedia = function () {
      return Promise.resolve(fakeStream);
    };
    function FakeMediaRecorder(stream, opts) {
      this.stream = stream;
      this.state = 'inactive';
      this.mimeType = (opts && opts.mimeType) || 'audio/webm';
      this._listeners = {};
    }
    FakeMediaRecorder.prototype.addEventListener = function (evt, cb) {
      this._listeners[evt] = this._listeners[evt] || [];
      this._listeners[evt].push(cb);
    };
    FakeMediaRecorder.prototype.start = function () {
      this.state = 'recording';
      var self = this;
      (this._listeners.dataavailable || []).forEach(function (cb) {
        cb({ data: new Blob(['fake-audio-bytes'], { type: self.mimeType }) });
      });
    };
    FakeMediaRecorder.prototype.stop = function () {
      this.state = 'inactive';
      (this._listeners.stop || []).forEach(function (cb) { cb(); });
    };
    FakeMediaRecorder.isTypeSupported = function () { return true; };
    window.MediaRecorder = FakeMediaRecorder;
  });
}

/** Seeds a logged-in user (optionally with a saved self character) directly into localStorage, then navigates to path. */
async function seedLoggedInUserAt(page, username, path, selfCharacter) {
  await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function (args) {
    var u = args.username;
    var self = args.selfCharacter;
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@' + u, username: u };
    if (!state.accounts) state.accounts = {};
    state.accounts[u] = { password: 'testpass1', email: u + '@example.com' };
    if (self) {
      if (!state.charactersByUser) state.charactersByUser = {};
      state.charactersByUser[u.toLowerCase()] = [{
        id: 'self-char-1', name: self.name, isSelf: true, description: '', photoDataUrl: null
      }];
    }
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, { username: username, selfCharacter: selfCharacter || null });
  await page.goto(baseUrl + path, { waitUntil: 'domcontentloaded' });
}

/**
 * Routes transcribe-audio.js/transcribe-status.js to resolve as a
 * successful transcription of `transcript` after one status poll -- no real
 * fal.ai call anywhere. `delayMs` (default 0) optionally delays the
 * transcribe-status response, giving a test a reliable window to assert the
 * "Transcribing…" in-flight state before it resolves.
 */
function mockSuccessfulTranscription(page, transcript, delayMs) {
  return page.route('**/.netlify/functions/transcribe-audio', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'fake-op-1' }) });
  }).then(function () {
    return page.route('**/.netlify/functions/transcribe-status*', function (route) {
      var respond = function () {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, transcript: transcript }) });
      };
      if (delayMs) { setTimeout(respond, delayMs); } else { respond(); }
    });
  });
}

/** Routes transcribe-audio.js to fail outright -- transcribe-status.js is never reached. */
function mockFailedTranscription(page) {
  return page.route('**/.netlify/functions/transcribe-audio', function (route) {
    route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'transcription_failed' }) });
  });
}

/** Drives create.html from the choice screen through record -> stop -> review-continue, leaving the caller at whatever screen that produces. */
async function recordAndSubmitForTranscription(page) {
  await page.waitForSelector('#choice-record', { timeout: 5000 });
  await page.click('#choice-record');
  await page.waitForSelector('#create-record[style*="display: flex"]', { timeout: 5000 });
  await page.click('#stop-record');
  await page.waitForSelector('#create-review[style*="display: flex"]', { timeout: 5000 });
  await page.click('#review-continue');
}

test('create.html: a successful transcription shows "Transcribing…" while in flight, then the new text-review screen pre-filled with the transcript (not an immediate navigation)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await installMediaRecorderMock(context);
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockSuccessfulTranscription(page, 'I was flying over a city made of glass', 300);

    await seedLoggedInUserAt(page, 'transcriptreviewtester1', '/create.html');
    await recordAndSubmitForTranscription(page);

    // Still mid-flight: button shows the disabled "Transcribing…" state and
    // the new text-review screen must not be visible yet (empty or not).
    assert.equal(await page.locator('#review-continue').isDisabled(), true, 'Continue must be disabled while transcription is in flight');
    assert.equal(await page.textContent('#review-continue'), 'Transcribing…', 'button must read "Transcribing…" while in flight');
    var transcriptReviewDisplay = await page.locator('#create-transcript-review').evaluate(function (el) { return getComputedStyle(el).display; });
    assert.equal(transcriptReviewDisplay, 'none', 'the text-review screen must not appear before the transcript actually arrives');

    await page.waitForSelector('#create-transcript-review[style*="display: flex"]', { timeout: 5000 });
    var reviewDisplay = await page.locator('#create-review').evaluate(function (el) { return getComputedStyle(el).display; });
    assert.equal(reviewDisplay, 'none', 'the audio-review screen must be hidden once the text-review screen takes over');

    var textareaValue = await page.inputValue('#transcript-text');
    assert.equal(textareaValue, 'I was flying over a city made of glass', 'the transcript must be pre-filled into the editable textarea, verbatim');

    assert.equal(page.url(), baseUrl + '/create.html', 'must NOT have navigated to style.html yet -- the user has not confirmed the text');
  } finally {
    await context.close();
  }
});

test('create.html: editing the transcribed text before clicking Continue sets the EDITED text as the draft caption (not the original transcript), and auto-selects the Me character against the edited text', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await installMediaRecorderMock(context);
    var page = await context.newPage();
    await blockThirdParty(page);
    // Deliberately no first-person language and no self-character name in
    // the ORIGINAL transcript -- proves autoSelectSelfIfMentioned only fires
    // because of the edit, not the discarded raw transcript.
    await mockSuccessfulTranscription(page, 'A dog ran across the yard');

    await seedLoggedInUserAt(page, 'transcriptreviewtester2', '/create.html', { name: 'Jordan' });
    await recordAndSubmitForTranscription(page);

    await page.waitForSelector('#create-transcript-review[style*="display: flex"]', { timeout: 5000 });

    var editedText = 'I was flying over a city made of glass with Jordan';
    await page.fill('#transcript-text', editedText);
    await page.click('#transcript-continue');

    await page.waitForURL('**/style.html', { timeout: 8000, waitUntil: 'domcontentloaded' });

    var draft = await page.evaluate(function () {
      return JSON.parse(localStorage.getItem('dreamtube_state_v1')).draft;
    });
    assert.equal(draft.caption, editedText, 'the draft caption must be the EDITED text, not the original transcript');
    assert.notEqual(draft.caption, 'A dog ran across the yard', 'the original transcript must not be what got saved');
    assert.deepEqual(draft.characterIds, ['self-char-1'], 'the Me character must be auto-selected because the EDITED text mentions "I" and the self character\'s name -- proves the check ran against the edit, not the discarded original');
  } finally {
    await context.close();
  }
});

test('create.html: clearing the transcript to empty/whitespace-only text blocks Continue -- no navigation, no draft write', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await installMediaRecorderMock(context);
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockSuccessfulTranscription(page, 'Some real transcript text');

    await seedLoggedInUserAt(page, 'transcriptreviewtester3', '/create.html');
    await recordAndSubmitForTranscription(page);

    await page.waitForSelector('#create-transcript-review[style*="display: flex"]', { timeout: 5000 });

    await page.fill('#transcript-text', '   ');
    await page.click('#transcript-continue');

    // Give any (incorrect) navigation a moment to happen before asserting it didn't.
    await page.waitForTimeout(300);
    assert.equal(page.url(), baseUrl + '/create.html', 'must not navigate away on an empty/whitespace-only edit');
    var errorVisible = await page.locator('#transcript-error').evaluate(function (el) { return getComputedStyle(el).display; });
    assert.notEqual(errorVisible, 'none', 'an inline error must be shown for an empty/whitespace-only edit');

    var draft = await page.evaluate(function () {
      return JSON.parse(localStorage.getItem('dreamtube_state_v1')).draft;
    });
    assert.notEqual(draft.caption, '   ', 'whitespace-only text must never be written to the draft caption');
  } finally {
    await context.close();
  }
});

test('create.html: a transcription failure still shows the existing audio-review error path, never the new text-review screen', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await installMediaRecorderMock(context);
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockFailedTranscription(page);

    await seedLoggedInUserAt(page, 'transcriptreviewtester4', '/create.html');
    await recordAndSubmitForTranscription(page);

    await page.waitForSelector('#rec-error[style*="display: block"]', { timeout: 5000 });
    assert.match(await page.textContent('#rec-error'), /Couldn.?t transcribe that recording/, 'the existing transcription-failure copy must still show on the audio-review screen');

    var transcriptReviewDisplay = await page.locator('#create-transcript-review').evaluate(function (el) { return getComputedStyle(el).display; });
    assert.equal(transcriptReviewDisplay, 'none', 'the new text-review screen must never appear on a transcription failure');

    assert.equal(await page.locator('#review-continue').isDisabled(), false, 'Continue must be re-enabled so the user can retry');
    assert.equal(await page.textContent('#review-continue'), 'Continue', 'button text must revert to "Continue" after a failure');
  } finally {
    await context.close();
  }
});

test('create.html: the text-review screen\'s own Re-record button abandons the current attempt and returns to the mic-recording UI', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await installMediaRecorderMock(context);
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockSuccessfulTranscription(page, 'Some transcript to discard');

    await seedLoggedInUserAt(page, 'transcriptreviewtester5', '/create.html');
    await recordAndSubmitForTranscription(page);

    await page.waitForSelector('#create-transcript-review[style*="display: flex"]', { timeout: 5000 });
    await page.click('#transcript-re-record');

    await page.waitForSelector('#create-record[style*="display: flex"]', { timeout: 5000 });
    var transcriptReviewDisplay = await page.locator('#create-transcript-review').evaluate(function (el) { return getComputedStyle(el).display; });
    assert.equal(transcriptReviewDisplay, 'none', 'the text-review screen must be hidden once Re-record starts a new recording');
    assert.equal(await page.textContent('#create-heading'), 'Record your dream');
  } finally {
    await context.close();
  }
});

test('create.html: tapping topbar Back while a transcription is in flight abandons that attempt too -- not just the Re-record buttons', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await installMediaRecorderMock(context);
    var page = await context.newPage();
    await blockThirdParty(page);
    // Review finding: the transcribeAttemptToken guard originally only
    // covered #re-record and #transcript-re-record, incorrectly claiming
    // (in its own code comment) those were "the only place on this page
    // it's reachable" -- topbar Back is a second, equally reachable way to
    // abandon the same in-flight "Transcribing…" state, and previously
    // wasn't guarded at all. Uses a delayed transcription so there's a
    // reliable window to tap Back before it resolves.
    await mockSuccessfulTranscription(page, 'A transcript that should never surface', 300);

    await seedLoggedInUserAt(page, 'transcriptreviewtester6', '/create.html');
    await recordAndSubmitForTranscription(page);
    await page.waitForSelector('#review-continue:disabled', { timeout: 5000 });
    assert.equal(await page.textContent('#review-continue'), 'Transcribing…');

    await page.click('#create-back');
    await page.waitForSelector('#create-select[style*="display: block"]', { timeout: 5000 });
    await page.click('#choice-write');
    await page.waitForSelector('#create-write[style*="display: flex"]', { timeout: 5000 });

    // Give the delayed transcription's response time to actually resolve.
    await page.waitForTimeout(600);

    var writeStillOpen = await page.locator('#create-write').evaluate(function (el) { return getComputedStyle(el).display; });
    var transcriptReviewOpen = await page.locator('#create-transcript-review').evaluate(function (el) { return getComputedStyle(el).display; });
    assert.equal(writeStillOpen, 'flex', 'the Write panel the user navigated to must still be showing');
    assert.equal(transcriptReviewOpen, 'none', 'the stale transcription must not hijack the screen into the text-review panel after Back was tapped');
    assert.equal(await page.textContent('#create-heading'), 'Write your dream', 'heading must not have been overwritten by the stale attempt settling late');
  } finally {
    await context.close();
  }
});
