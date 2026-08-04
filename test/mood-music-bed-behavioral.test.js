// test/mood-music-bed-behavioral.test.js
//
// Coverage for tracker item for-product-founder-08-04-evening-music--jfjco0
// (FINAL-FINAL scope): music beds keyed by the dream-builder wizard's MOOD
// step instead of the dream's visual style, with the four existing
// visual-style beds kept permanently as the fallback tier.
//
// THREE THINGS ARE UNDER TEST HERE, and one deliberate non-thing:
//
//   1. MOOD PERSISTENCE (the actual bug fixed). The wizard's Mood step
//      answer used to reach js/wizard-chips.js's assembleCaption /
//      buildDeterministicStory — i.e. the generated prompt text — and then
//      be dropped on the floor, never surviving onto the finished dream
//      record. Nothing downstream could key off it because it wasn't there.
//      It now travels: wizard -> draft -> pending job -> `dream.mood`.
//
//   2. THE SELECTION LAYER (js/music-bed.js's urlForMood/urlForDream). Two
//      tiers: the dream's own mood first, the visual-style bed as fallback.
//
//   3. THE AUDITION PAGE's reviewing/picking flow (bed-audition-x7q4.html).
//
// The non-thing: THERE ARE NO REAL MOOD-KEYED TRACKS YET. The 12 candidates
// (2 per mood) need the one-time fal.ai ~45s seamless-loop pipeline run by
// someone holding a FAL_KEY, which the sandbox this was built in does not
// have. So js/music-bed.js's MOOD_FILES map is empty, and the single most
// important assertion in this file is the ZERO-REGRESSION one: with that map
// empty, urlForDream returns byte-identically what urlForStyle always did,
// for every mood x style combination — today's users hear exactly what they
// heard before this layer existed. The tests that prove tier 1 actually
// works do so by POPULATING MOOD_FILES at runtime, standing in for the real
// tracks. That is a mock of a missing asset in a test, never a fake asset
// committed to the repo (this codebase tolerates a missing asset and never
// fakes one — same convention as a missing character portrait).

var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('node:fs');
var path = require('node:path');
var staticServer = require('./helpers/static-server');

var WizardChips = require('../js/wizard-chips');

var CHROMIUM_PATH = '/opt/pw-browsers/chromium';
var MOBILE_VIEWPORT = { width: 390, height: 844 };
var REPO_ROOT = path.join(__dirname, '..');

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

function newMobileContext() {
  return browser.newContext({ viewport: MOBILE_VIEWPORT });
}

/**
 * Installs a MOOD_FILES override that takes effect the INSTANT
 * js/music-bed.js defines its global — before any page script can read it.
 *
 * js/music-bed.js is a plain script doing `var MusicBed = (function(){...})()`
 * at top level, so the assignment goes through window. Pre-defining an
 * accessor property for that name (configurable, so the later `var`
 * declaration finds it already present and leaves it alone) lets the setter
 * seed MOOD_FILES the moment the real module lands — which is what makes
 * this work for pages like result.html that resolve the bed URL during their
 * own initial render, long before a test could otherwise reach in.
 *
 * `files` is a { moodKey: filename } map standing in for the real committed
 * tracks that don't exist yet.
 */
function overrideMoodFiles(page, files) {
  return page.addInitScript(function (seedFiles) {
    var real;
    Object.defineProperty(window, 'MusicBed', {
      configurable: true,
      get: function () { return real; },
      set: function (v) {
        real = v;
        if (v && v.MOOD_FILES) {
          Object.keys(seedFiles).forEach(function (k) { v.MOOD_FILES[k] = seedFiles[k]; });
        }
      }
    });
  }, files);
}

/**
 * Serves the mood-bed directory (which contains no real files) from one of
 * the four REAL committed style beds, so an overridden MOOD_FILES entry
 * resolves to genuinely playable audio rather than a 404. Test-only stand-in
 * for the tracks the fal.ai pipeline still has to produce.
 */
function serveStandInMoodBeds(page) {
  var realWav = path.join(REPO_ROOT, 'assets', 'music-beds', 'anime.wav');
  return page.route('**/assets/music-beds/moods/**', function (route) {
    route.fulfill({ status: 200, contentType: 'audio/wav', body: fs.readFileSync(realWav) });
  });
}

/** Mocks a whole generation round trip (submit -> status poll -> done) at zero cost — never touches fal.ai. */
async function mockGeneration(page, videoUrl) {
  await page.route('**/.netlify/functions/generate-video', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'op-mood-test', modelUsed: 'veo3.1-lite' }) });
  });
  await page.route('**/.netlify/functions/video-status*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, videoUrl: videoUrl }) });
  });
}

async function seedLoggedInUser(page, username) {
  await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function (u) {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@' + u, username: u, authToken: 'tok-' + u };
    if (!state.accounts) state.accounts = {};
    state.accounts[u] = { password: 'testpass1', email: u + '@example.com' };
    if (!state.dreams) state.dreams = [];
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, username);
}

// ─────────────────────────────────────────────────────────────────────────
// 0. The three mood-key lists must agree
// ─────────────────────────────────────────────────────────────────────────

test('the mood key list is identical in all three places that hold a copy (wizard-chips MOOD_CHIPS, music-bed MOOD_KEYS, publish-dream KNOWN_MOODS) -- they cannot be imported from one another, so drift is guarded by this test instead', function () {
  var expected = WizardChips.MOOD_CHIPS
    .map(function (c) { return c.key; })
    .filter(function (k) { return k !== 'other'; }); // free text has no fixed bed
  assert.deepEqual(expected, ['peaceful', 'joyful', 'dreamy', 'mysterious', 'tense', 'epic']);

  // js/music-bed.js has no module.exports (it's a browser-only plain script
  // loaded by explore.html WITHOUT js/wizard-chips.js, which is exactly why
  // it can't just import the list) -- read its literal off the source. The
  // in-browser test below independently asserts the live MOOD_KEYS value
  // matches too, so this regex can't quietly read a stale/unused constant.
  var musicBedSrc = fs.readFileSync(path.join(REPO_ROOT, 'js', 'music-bed.js'), 'utf8');
  var mbMatch = musicBedSrc.match(/var MOOD_KEYS = \[([^\]]*)\]/);
  assert.ok(mbMatch, 'js/music-bed.js must declare MOOD_KEYS');
  var mbKeys = mbMatch[1].split(',').map(function (s) { return s.trim().replace(/^'|'$/g, ''); }).filter(Boolean);
  assert.deepEqual(mbKeys, expected, 'js/music-bed.js MOOD_KEYS drifted from MOOD_CHIPS');

  var publishSrc = fs.readFileSync(path.join(REPO_ROOT, 'netlify', 'functions', 'publish-dream.js'), 'utf8');
  var pdMatch = publishSrc.match(/var KNOWN_MOODS = \[([^\]]*)\]/);
  assert.ok(pdMatch, 'publish-dream.js must declare KNOWN_MOODS');
  var pdKeys = pdMatch[1].split(',').map(function (s) { return s.trim().replace(/^'|'$/g, ''); }).filter(Boolean);
  assert.deepEqual(pdKeys, expected, 'publish-dream.js KNOWN_MOODS drifted from MOOD_CHIPS');
});

// ─────────────────────────────────────────────────────────────────────────
// 1. js/music-bed.js's selection logic
// ─────────────────────────────────────────────────────────────────────────

test('ZERO REGRESSION: with no mood tracks committed (today), urlForDream returns exactly what urlForStyle always did for every mood x style combination -- a real chosen mood changes nothing a user currently hears', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.goto(baseUrl + '/explore.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(function () { return !!window.MusicBed; }, { timeout: 5000 });

    var result = await page.evaluate(function () {
      var out = { moodKeys: MusicBed.MOOD_KEYS.slice(), moodFileCount: Object.keys(MusicBed.MOOD_FILES).length, rows: [], moodUrls: {} };
      var styles = ['Cartoon', 'Cinematic', 'Anime', 'Realistic', 'Surrealist'];
      MusicBed.MOOD_KEYS.forEach(function (mood) {
        out.moodUrls[mood] = MusicBed.urlForMood(mood);
        styles.forEach(function (style) {
          var dream = { videoUrl: 'x.mp4', style: style, mood: mood };
          out.rows.push({
            mood: mood, style: style,
            forDream: MusicBed.urlForDream(dream),
            forStyle: MusicBed.urlForStyle(style),
            eligible: MusicBed.eligible(dream)
          });
        });
      });
      return out;
    });

    assert.deepEqual(result.moodKeys, ['peaceful', 'joyful', 'dreamy', 'mysterious', 'tense', 'epic'],
      'the live MOOD_KEYS value must match MOOD_CHIPS (cross-checks the source-read assertion above)');
    assert.equal(result.moodFileCount, 0,
      'MOOD_FILES must still be empty -- the moment a real track is committed, this assertion is the reminder to update this test and the zero-regression claim with it');

    Object.keys(result.moodUrls).forEach(function (mood) {
      assert.equal(result.moodUrls[mood], null, mood + ' has no committed track yet, so tier 1 must resolve to null');
    });
    assert.equal(result.rows.length, 30);
    result.rows.forEach(function (row) {
      assert.equal(row.forDream, row.forStyle,
        'mood "' + row.mood + '" + style "' + row.style + '": urlForDream must fall through to the identical style bed today');
      assert.equal(row.eligible, row.forStyle !== null,
        'eligibility must be unchanged too -- still driven purely by a real video + a resolvable bed');
    });
  } finally {
    await context.close();
  }
});

test('js/music-bed.js: once a mood-keyed track EXISTS, the dream\'s own mood wins over its visual style -- and a mood with no track, an unknown mood, a free-text mood, or no mood at all all still fall back to the style bed', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    // Stand-ins for two of the twelve real candidates. Deliberately only TWO
    // of the six moods, so the same page also proves the partially-populated
    // state (some moods live, the rest still falling back) that will really
    // exist between the founder's first pick and his last.
    await overrideMoodFiles(page, { tense: 'tense.wav', peaceful: 'peaceful.wav' });
    await page.goto(baseUrl + '/explore.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(function () { return !!window.MusicBed && Object.keys(MusicBed.MOOD_FILES).length === 2; }, { timeout: 5000 });

    var r = await page.evaluate(function () {
      var d = function (mood, style) { return { videoUrl: 'x.mp4', style: style, mood: mood }; };
      return {
        // Tier 1 wins: the mood picks the bed, the visual style is ignored.
        tenseCartoon: MusicBed.urlForDream(d('tense', 'Cartoon')),
        tenseAnime: MusicBed.urlForDream(d('tense', 'Anime')),
        peacefulRealistic: MusicBed.urlForDream(d('peaceful', 'Realistic')),
        // Tier 2: a real mood that has no track yet still falls back.
        joyfulCartoon: MusicBed.urlForDream(d('joyful', 'Cartoon')),
        epicCinematic: MusicBed.urlForDream(d('epic', 'Cinematic')),
        // Tier 2: skipped / free text / unknown / absent -> style bed.
        nullMood: MusicBed.urlForDream(d(null, 'Cartoon')),
        otherMood: MusicBed.urlForDream(d('other', 'Cartoon')),
        freeTextMood: MusicBed.urlForDream(d('vaguely ominous but hopeful', 'Cartoon')),
        noMoodField: MusicBed.urlForDream({ videoUrl: 'x.mp4', style: 'Cartoon' }),
        // Case-insensitive, same contract urlForStyle already had.
        upperMood: MusicBed.urlForDream(d('TENSE', 'Cartoon')),
        // A mood that HAS a track rescues an otherwise-unresolvable style...
        tenseUnknownStyle: MusicBed.urlForDream(d('tense', 'Surrealist')),
        tenseUnknownStyleEligible: MusicBed.eligible(d('tense', 'Surrealist')),
        // ...but a mood WITHOUT one leaves both tiers unresolved.
        joyfulUnknownStyle: MusicBed.urlForDream(d('joyful', 'Surrealist')),
        joyfulUnknownStyleEligible: MusicBed.eligible(d('joyful', 'Surrealist')),
        // An image-only dream is never eligible however good its mood is.
        imageOnly: MusicBed.eligible({ imageUrl: 'x.jpg', videoUrl: null, style: 'Cartoon', mood: 'tense' }),
        nullDream: MusicBed.urlForDream(null)
      };
    });

    assert.equal(r.tenseCartoon, 'assets/music-beds/moods/tense.wav', 'the mood must beat the visual style once its track exists');
    assert.equal(r.tenseAnime, 'assets/music-beds/moods/tense.wav', 'same mood + a different style still resolves to the mood bed');
    assert.equal(r.peacefulRealistic, 'assets/music-beds/moods/peaceful.wav');
    assert.equal(r.joyfulCartoon, 'assets/music-beds/cartoon.wav', 'a mood with no track yet must fall back, not go silent');
    assert.equal(r.epicCinematic, 'assets/music-beds/cinematic.wav');
    assert.equal(r.nullMood, 'assets/music-beds/cartoon.wav', 'a SKIPPED mood falls back to the visual-style bed -- the tracker item\'s explicit requirement');
    assert.equal(r.otherMood, 'assets/music-beds/cartoon.wav', 'a "+ Something else" free-text mood falls back -- keyword mapping is explicitly out of scope');
    assert.equal(r.freeTextMood, 'assets/music-beds/cartoon.wav');
    assert.equal(r.noMoodField, 'assets/music-beds/cartoon.wav', 'a dream predating mood persistence entirely falls back');
    assert.equal(r.upperMood, 'assets/music-beds/moods/tense.wav');
    assert.equal(r.tenseUnknownStyle, 'assets/music-beds/moods/tense.wav');
    assert.equal(r.tenseUnknownStyleEligible, true, 'a real mood bed makes a previously-ineligible unknown-style dream eligible');
    assert.equal(r.joyfulUnknownStyle, null, 'both tiers failing must fail closed to no bed, never guess');
    assert.equal(r.joyfulUnknownStyleEligible, false);
    assert.equal(r.imageOnly, false);
    assert.equal(r.nullDream, null);
  } finally {
    await context.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 2. Mood persistence — the actual bug fixed
// ─────────────────────────────────────────────────────────────────────────

/** Walks create.html's "Build it" wizard to the Mood step (steps 1-3 skipped/defaulted). */
async function walkBuildWizardToMood(page) {
  await page.click('#choice-build');
  await page.click('#build-subject-skip');
  await page.click('#build-setting-skip');
  await page.click('#build-action-continue');
  await page.waitForSelector('#build-mood-row');
}

test('create.html "Build it": the Mood step answer now survives onto the draft as `mood` -- this is the exact hop where it used to be dropped', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedLoggedInUser(page, 'moodbuilder');
    await page.goto(baseUrl + '/create.html', { waitUntil: 'domcontentloaded' });

    await walkBuildWizardToMood(page);
    await page.click('.opt-chip[data-build-mood="tense"]');
    await page.click('#build-mood-continue');
    await page.click('#build-freetext-skip');
    await page.waitForURL(/style\.html/, { timeout: 8000 });

    var draft = await page.evaluate(function () { return DreamStore.getDraft(); });
    assert.equal(draft.mood, 'tense', 'the chosen mood must be on the draft -- before this fix it existed only inside the assembled prompt text');
    // And the prompt itself is unchanged by the new field.
    assert.match(draft.caption, /tense mood,/, 'the assembled prompt must still carry the mood language exactly as before');
  } finally {
    await context.close();
  }
});

test('create.html "Build it": tapping SKIP on the Mood step persists NO mood, even though the pre-highlighted default chip is still visibly selected -- Skip and Continue-on-the-default are different answers', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedLoggedInUser(page, 'moodskipper');
    await page.goto(baseUrl + '/create.html', { waitUntil: 'domcontentloaded' });

    await walkBuildWizardToMood(page);
    // Confirm the ambiguity this behavior turns on is real: a chip IS
    // highlighted right now, with the user having tapped nothing.
    var preselected = await page.evaluate(function () {
      var el = document.querySelector('#build-mood-row .opt-chip.selected');
      return el ? el.dataset.buildMood : null;
    });
    assert.equal(preselected, 'dreamy', 'the default mood chip is pre-highlighted, which is why a skipped flag is needed at all');

    await page.click('#build-mood-skip');
    await page.click('#build-freetext-skip');
    await page.waitForURL(/style\.html/, { timeout: 8000 });

    var draft = await page.evaluate(function () { return DreamStore.getDraft(); });
    assert.equal(draft.mood, null, 'a skipped mood step must persist no mood -> the dream falls back to its visual-style bed');
    assert.match(draft.caption, /dreamy surreal mood,/, 'the GENERATED PROMPT is deliberately untouched by the skip -- it has always used the default mood language here, and changing that would be a real regression in what gets generated');
  } finally {
    await context.close();
  }
});

test('create.html "Build it": a "+ Something else" free-text mood persists no mood (keyword mapping is out of scope) while the typed text still reaches the generated prompt, so nothing the user wrote is lost', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedLoggedInUser(page, 'moodfreetexter');
    await page.goto(baseUrl + '/create.html', { waitUntil: 'domcontentloaded' });

    await walkBuildWizardToMood(page);
    await page.click('.opt-chip[data-build-mood="other"]');
    await page.fill('#build-mood-other-input', 'bittersweet and electric');
    await page.click('#build-mood-continue');
    await page.click('#build-freetext-skip');
    await page.waitForURL(/style\.html/, { timeout: 8000 });

    var draft = await page.evaluate(function () { return DreamStore.getDraft(); });
    assert.equal(draft.mood, null, 'free text has no mood-keyed bed -- falls back');
    assert.match(draft.caption, /bittersweet and electric mood,/, 'the free text still reaches the prompt, so a future keyword mapping has something to work from');
  } finally {
    await context.close();
  }
});

test('create.html "Build it": going Back to the Mood step after skipping it, and then tapping a real chip, records the real answer -- the skipped flag must not be sticky', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedLoggedInUser(page, 'moodbacktracker');
    await page.goto(baseUrl + '/create.html', { waitUntil: 'domcontentloaded' });

    await walkBuildWizardToMood(page);
    await page.click('#build-mood-skip');
    await page.waitForSelector('#build-freetext-input');
    // Re-enter the Mood step through the page's own back affordance and
    // answer it for real this time. The build wizard's steps are in-page
    // state, NOT history entries -- #create-back is the real control (it
    // calls buildPrev(), falling through to leaving the wizard only once
    // there's no earlier step left).
    await page.click('#create-back');
    await page.waitForSelector('#build-mood-row', { timeout: 8000 });
    await page.click('.opt-chip[data-build-mood="epic"]');
    await page.click('#build-mood-continue');
    await page.click('#build-freetext-skip');
    await page.waitForURL(/style\.html/, { timeout: 8000 });

    var draft = await page.evaluate(function () { return DreamStore.getDraft(); });
    assert.equal(draft.mood, 'epic', 'answering after a previous skip must overwrite the skip, not be swallowed by it');
  } finally {
    await context.close();
  }
});

test('js/store.js: a mood on the draft reaches the FINISHED dream record through a real (mocked-transport) generation, and drives that dream\'s music bed on result.html', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await overrideMoodFiles(page, { mysterious: 'mysterious.wav' });
    await serveStandInMoodBeds(page);
    await seedLoggedInUser(page, 'moodgenerator');
    await mockGeneration(page, '/assets/music-beds/anime.wav');
    await page.goto(baseUrl + '/explore.html', { waitUntil: 'domcontentloaded' });

    var dream = await page.evaluate(async function () {
      return await DreamStore.generateVideo('a prompt, mysterious mood, Cartoon style, dreamlike.', 'Cartoon', { mood: 'mysterious' });
    });
    assert.equal(dream.mood, 'mysterious', 'startGeneration -> savePendingJob -> finalizeDream must carry the mood onto the dream record');

    // Now the whole point: that persisted mood actually selects the bed on a
    // real page render, beating the dream's own Cartoon visual style.
    await page.goto(baseUrl + '/result.html?id=' + dream.id, { waitUntil: 'domcontentloaded' });
    var bedSrc = await page.locator('#result-music-bed').evaluate(function (a) { return a.getAttribute('src'); });
    assert.equal(bedSrc, 'assets/music-beds/moods/mysterious.wav', 'result.html must pick the bed from the dream\'s mood, not its Cartoon style');
  } finally {
    await context.close();
  }
});

test('js/store.js: a generation with NO mood still produces exactly today\'s dream record and today\'s style-matched bed -- the no-mood path is unchanged, not merely tolerated', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedLoggedInUser(page, 'moodlessgenerator');
    await mockGeneration(page, '/assets/music-beds/anime.wav');
    await page.goto(baseUrl + '/explore.html', { waitUntil: 'domcontentloaded' });

    var dream = await page.evaluate(async function () {
      // No `mood` opt at all -- exactly what Write-it / Record-it produce.
      return await DreamStore.generateVideo('a prompt, Cartoon style, dreamlike.', 'Cartoon', {});
    });
    assert.equal(dream.mood, null, 'no mood chosen must store null, never a guessed default');

    await page.goto(baseUrl + '/result.html?id=' + dream.id, { waitUntil: 'domcontentloaded' });
    var bedSrc = await page.locator('#result-music-bed').evaluate(function (a) { return a.getAttribute('src'); });
    assert.equal(bedSrc, 'assets/music-beds/cartoon.wav', 'unchanged from before this feature existed');
  } finally {
    await context.close();
  }
});

test('js/store.js: a RESUMED pending job keeps its mood -- this is the path wizard.html\'s pre-signup funnel actually takes (adoptPendingGeneration -> home.html resumes), where the mood can only ride on the job, never on a live generateVideo call', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedLoggedInUser(page, 'moodresumer');
    await mockGeneration(page, '/assets/music-beds/anime.wav');
    await page.goto(baseUrl + '/explore.html', { waitUntil: 'domcontentloaded' });

    var dream = await page.evaluate(async function () {
      // Exactly what wizard.html does after signup: adopt the already-
      // submitted server-side job, carrying the wizard's own mood answer.
      DreamStore.adoptPendingGeneration('op-adopted', Date.now(), 'a prompt, epic awe-inspiring mood, Anime style, dreamlike.', 'Anime', undefined, 'I was flying.', 'epic');
      return await DreamStore.resumePendingJob();
    });
    assert.equal(dream.mood, 'epic', 'the adopted job\'s mood must survive the resume onto the finished dream -- without this the entire pre-signup funnel would silently lose it');
    assert.equal(dream.storyText, 'I was flying.', 'the pre-existing storyText carry-through is unaffected');
  } finally {
    await context.close();
  }
});

test('js/store.js: regenerating / editing an existing dream PRESERVES its mood -- those flows have no mood picker of their own, so silently dropping to the style bed mid-edit would be an unrequested behavior change', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedLoggedInUser(page, 'moodregenerator');
    await mockGeneration(page, '/assets/music-beds/anime.wav');
    await page.goto(baseUrl + '/explore.html', { waitUntil: 'domcontentloaded' });

    var moods = await page.evaluate(async function () {
      var created = await DreamStore.generateVideo('original prompt', 'Cartoon', { mood: 'joyful' });
      var regenerated = await DreamStore.regenerateDream(created.id, {
        caption: 'edited prompt', style: 'Cinematic', storyText: 'edited story', characterIds: []
      });
      return { created: created.mood, regenerated: regenerated ? regenerated.mood : 'REGENERATE_RETURNED_NULL' };
    });
    assert.equal(moods.created, 'joyful');
    assert.equal(moods.regenerated, 'joyful', 'a regenerate must leave the dream\'s mood (and therefore its bed) exactly as the user already knows it');
  } finally {
    await context.close();
  }
});

test('explore.html: a shared-feed card picks its bed from the record\'s own mood when a track exists, and from its visual style otherwise -- including for records published before mood was ever carried into the feed', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await overrideMoodFiles(page, { tense: 'tense.wav' });
    await serveStandInMoodBeds(page);
    await page.route('**/.netlify/functions/get-feed*', function (route) {
      route.fulfill({
        status: 200, contentType: 'application/json', body: JSON.stringify({
          feed: [
            // Mood present and its track exists -> mood bed, despite Cartoon.
            { id: 'feed-mood', ownerHandle: '@someone', caption: 'A tense dream', style: 'Cartoon', mood: 'tense', videoUrl: '/assets/music-beds/anime.wav', mediaType: 'video', likes: 2, dur: '0:08' },
            // Legacy record from before publish-dream.js carried mood at all.
            { id: 'feed-legacy', ownerHandle: '@someone', caption: 'An older dream', style: 'Anime', videoUrl: '/assets/music-beds/realistic.wav', mediaType: 'video', likes: 1, dur: '0:08' }
          ],
          dreamOfDayId: null
        })
      });
    });

    await page.goto(baseUrl + '/explore.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.feed-card', { timeout: 8000 });

    var cards = await page.evaluate(function () {
      return Array.prototype.map.call(document.querySelectorAll('.feed-card'), function (c) {
        var bed = c.querySelector('.feed-music-bed');
        return { id: c.dataset.id, bedSrc: bed ? bed.getAttribute('src') : null };
      });
    });
    var moodCard = cards.filter(function (c) { return c.id === 'feed-mood'; })[0];
    assert.ok(moodCard, 'the mood-carrying card must be present');
    assert.equal(moodCard.bedSrc, 'assets/music-beds/moods/tense.wav', 'the feed card must key off the record\'s mood, not its Cartoon style');

    // The second card may still be a virtualized placeholder at this
    // viewport -- only assert on it once hydrated (same tolerance the
    // existing music-bed feed test already applies).
    var legacyCard = cards.filter(function (c) { return c.id === 'feed-legacy'; })[0];
    if (legacyCard) assert.equal(legacyCard.bedSrc, 'assets/music-beds/anime.wav', 'a record with no mood must still get its style bed, exactly as today');
  } finally {
    await context.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 3. The audition page's reviewing/picking flow
// ─────────────────────────────────────────────────────────────────────────

test('bed-audition-x7q4.html: with no candidate tracks generated (today\'s real state), all 12 slots show an honest pending state with playback and picking disabled -- no fake audio, no fake waveform', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.goto(baseUrl + '/bed-audition-x7q4.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.mood');

    var state = await page.evaluate(function () {
      var slots = Array.prototype.map.call(document.querySelectorAll('.slot:not(.ref)'), function (s) {
        return {
          exists: s.dataset.exists,
          playDisabled: s.querySelector('.play').disabled,
          pickDisabled: s.querySelector('.pick').disabled,
          pending: !!s.querySelector('.pending')
        };
      });
      return {
        moodRows: document.querySelectorAll('.mood').length,
        moodLabels: Array.prototype.map.call(document.querySelectorAll('.mood h2'), function (h) { return h.textContent; }),
        slots: slots,
        status: document.getElementById('status').textContent,
        statusClass: document.getElementById('status').className,
        picks: document.getElementById('picks-text').textContent,
        referencePlayers: document.querySelectorAll('.slot.ref .play').length
      };
    });

    assert.equal(state.moodRows, 6, 'one row per mood');
    assert.deepEqual(state.moodLabels, ['Peaceful', 'Joyful', 'Dreamy / surreal', 'Mysterious', 'Tense / scary', 'Epic / awe-inspiring']);
    assert.equal(state.slots.length, 12, 'two candidate slots per mood');
    state.slots.forEach(function (s, i) {
      assert.equal(s.exists, 'no', 'slot ' + i + ' must report no file');
      assert.equal(s.playDisabled, true, 'slot ' + i + ' must not offer playback of a track that does not exist');
      assert.equal(s.pickDisabled, true, 'slot ' + i + ' must not be pickable');
      assert.equal(s.pending, true, 'slot ' + i + ' must say plainly that it has not been generated yet');
    });
    assert.match(state.status, /0 of 12 candidate tracks available/);
    assert.match(state.statusClass, /none/);
    assert.match(state.picks, /No picks yet/);
    assert.equal(state.referencePlayers, 6, 'every row still offers a reference bed to compare against');
  } finally {
    await context.close();
  }
});

test('bed-audition-x7q4.html: the reference player really plays one of the four committed style beds -- the only real audio this page has today', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.goto(baseUrl + '/bed-audition-x7q4.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.mood');

    await page.click('.mood[data-mood="tense"] .slot.ref .play');
    await page.waitForFunction(function () {
      var p = document.getElementById('player');
      return p && !p.paused && p.currentTime > 0;
    }, { timeout: 6000 });

    var playing = await page.evaluate(function () {
      return { src: document.getElementById('player').getAttribute('src'), buttonState: document.querySelector('.mood[data-mood="tense"] .slot.ref .play').className };
    });
    assert.match(playing.src, /assets\/music-beds\/anime\.wav$/, 'defaults to the first reference bed in the dropdown');
    assert.match(playing.buttonState, /playing/);

    // Switching the reference dropdown to another real bed plays that one.
    await page.selectOption('.mood[data-mood="tense"] .slot.ref .ref-select', 'cinematic');
    await page.click('.mood[data-mood="tense"] .slot.ref .play');
    await page.waitForFunction(function () {
      var p = document.getElementById('player');
      return p && !p.paused && /cinematic\.wav$/.test(p.getAttribute('src') || '');
    }, { timeout: 6000 });
  } finally {
    await context.close();
  }
});

test('bed-audition-x7q4.html: the moment real candidate files exist at the expected paths, the page lights up on its own -- slots become playable, picking works, one winner per mood is recorded and survives a reload. THIS is the flow that has to work before the 12 real tracks are handed over.', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    // Stand in for the real tracks at exactly the paths the page probes for,
    // proving no code change is needed to switch this page on -- only files.
    // Two moods' worth (4 files), so the partially-delivered state is
    // covered too rather than only the all-or-nothing one.
    var realWav = fs.readFileSync(path.join(REPO_ROOT, 'assets', 'music-beds', 'anime.wav'));
    await page.route('**/assets/music-beds/moods/candidates/**', function (route) {
      var url = route.request().url();
      if (/(tense|peaceful)-(a|b)\.wav$/.test(url)) {
        route.fulfill({ status: 200, contentType: 'audio/wav', body: realWav });
      } else {
        route.fulfill({ status: 404, body: '' });
      }
    });

    await page.goto(baseUrl + '/bed-audition-x7q4.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(function () {
      return document.querySelectorAll('.slot[data-exists="yes"]').length === 4;
    }, { timeout: 8000 });

    var status = await page.textContent('#status');
    assert.match(status, /4 of 12 candidate tracks available/, 'the page must report partial delivery honestly rather than all-or-nothing');

    // A delivered slot is playable for real.
    await page.click('.mood[data-mood="tense"] .slot[data-slot="b"] .play');
    await page.waitForFunction(function () {
      var p = document.getElementById('player');
      return p && !p.paused && /tense-b\.wav$/.test(p.getAttribute('src') || '');
    }, { timeout: 6000 });

    // Picking a winner.
    await page.click('.mood[data-mood="tense"] .slot[data-slot="b"] .pick');
    await page.click('.mood[data-mood="peaceful"] .slot[data-slot="a"] .pick');

    var afterPicks = await page.evaluate(function () {
      return {
        picksText: document.getElementById('picks-text').textContent,
        tenseB: document.querySelector('.mood[data-mood="tense"] .slot[data-slot="b"] .pick').textContent,
        tenseA: document.querySelector('.mood[data-mood="tense"] .slot[data-slot="a"] .pick').textContent
      };
    });
    assert.match(afterPicks.picksText, /Tense \/ scary: candidate B/);
    assert.match(afterPicks.picksText, /Peaceful: candidate A/);
    assert.match(afterPicks.picksText, /2 of 6 moods picked/);
    assert.match(afterPicks.tenseB, /Winner/);
    assert.equal(afterPicks.tenseA, 'Pick', 'exactly ONE winner per mood -- picking B must not also mark A');

    // Re-picking the OTHER candidate in the same mood moves the win.
    await page.click('.mood[data-mood="tense"] .slot[data-slot="a"] .pick');
    var moved = await page.evaluate(function () {
      return {
        a: document.querySelector('.mood[data-mood="tense"] .slot[data-slot="a"] .pick').textContent,
        b: document.querySelector('.mood[data-mood="tense"] .slot[data-slot="b"] .pick').textContent,
        picksText: document.getElementById('picks-text').textContent
      };
    });
    assert.match(moved.a, /Winner/);
    assert.equal(moved.b, 'Pick', 'changing his mind must move the win, never leave two winners in one mood');
    assert.match(moved.picksText, /Tense \/ scary: candidate A/);

    // Picks survive a reload -- an audition of 12 tracks is not a
    // single-sitting job, and losing his picks would be the worst possible
    // failure of this page.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(function () {
      return document.querySelectorAll('.slot[data-exists="yes"]').length === 4;
    }, { timeout: 8000 });
    var afterReload = await page.textContent('#picks-text');
    assert.match(afterReload, /Tense \/ scary: candidate A/, 'picks must persist across a reload');
    assert.match(afterReload, /Peaceful: candidate A/);
  } finally {
    await context.close();
  }
});
