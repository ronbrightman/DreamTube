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
//   3. THE SIX LIVE MOOD BEDS (assets/music-beds/moods/<mood>.wav) — the
//      founder's audition winners, committed as real production assets.
//
// HISTORY, for anyone reading old diffs: this suite originally covered
// bed-audition-x7q4.html's picking flow and a ZERO-REGRESSION guarantee
// that an empty MOOD_FILES map changed nothing users heard. Both are
// finished business as of 2026-08-07: the 12 fal.ai candidates were
// generated, the founder picked one winner per mood (peaceful-A, joyful-B,
// dreamy-A, mysterious-B, tense-B, epic-B), the winners were promoted to
// assets/music-beds/moods/<mood>.wav, MOOD_FILES went live with all six,
// and the losing candidates AND the audition page were deleted (the
// tracker item's own no-dead-assets instruction). What this suite protects
// NOW: tier 1 actually serving every real mood, and the fallback tier
// still serving skipped/free-text/legacy moods byte-identically to the
// pre-mood era.

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

/** Mocks a whole generation round trip (submit -> status poll -> done) at zero cost — never touches fal.ai. */
async function mockGeneration(page, videoUrl) {
  await page.route('**/.netlify/functions/generate-video', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operationName: 'op-mood-test', modelUsed: 'veo3.1-lite' }) });
  });
  await page.route('**/.netlify/functions/video-status*', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ done: true, videoUrl: videoUrl }) });
  });
}

/**
 * Records every dream-sync.js call this page makes, answering each with a
 * plain success so js/store.js's own retry ladder never kicks in.
 *
 * Deliberately captures the RAW outgoing request body rather than asserting
 * on local state: the bug this exists to catch (review finding on branch
 * mood-music-audition-infra-jfjco0) was precisely a field that was correct
 * everywhere in local state and correct in dream-sync.js's server-side
 * DREAM_FIELDS allowlist, but was silently missing from the one place that
 * matters for cross-device restore — the wire. js/store.js's
 * attemptPrivateDreamSync builds its POST body from an explicit,
 * hand-maintained field list (see its own doc comment's "fixed field
 * whitelist" note), so a new dream field is NOT carried automatically and
 * nothing fails loudly when one is forgotten.
 */
function mockDreamSync(page) {
  var calls = [];
  page.route('**/.netlify/functions/dream-sync*', function (route) {
    var req = route.request();
    if (req.method() === 'GET') {
      calls.push({ method: 'GET' });
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, dreams: [] }) });
      return;
    }
    calls.push({ method: 'POST', body: JSON.parse(req.postData()) });
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  return calls;
}

/** Polls until `fn()` is truthy (js/store.js's private-dream sync is deliberately fire-and-forget, so there is nothing to await on). */
async function waitFor(fn, timeoutMs) {
  var start = Date.now();
  while (Date.now() - start < (timeoutMs || 3000)) {
    if (fn()) return true;
    await new Promise(function (r) { setTimeout(r, 25); });
  }
  return false;
}

function firstUpsert(calls) {
  return calls.filter(function (c) { return c.method === 'POST' && c.body.action === 'upsert'; })[0];
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

test('LIVE TIER 1: every real mood resolves to its own committed winner bed for every style -- and the NO-mood path still returns exactly what urlForStyle always did (the zero-regression guarantee, now scoped to the dreams it still applies to)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.goto(baseUrl + '/explore.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(function () { return !!window.MusicBed; }, { timeout: 5000 });

    var result = await page.evaluate(function () {
      var out = { moodKeys: MusicBed.MOOD_KEYS.slice(), moodFiles: JSON.parse(JSON.stringify(MusicBed.MOOD_FILES)), rows: [], legacyRows: [], moodUrls: {} };
      var styles = ['Cartoon', 'Cinematic', 'Anime', 'Realistic', 'Surrealist'];
      MusicBed.MOOD_KEYS.forEach(function (mood) {
        out.moodUrls[mood] = MusicBed.urlForMood(mood);
        styles.forEach(function (style) {
          var dream = { videoUrl: 'x.mp4', style: style, mood: mood };
          out.rows.push({
            mood: mood, style: style,
            forDream: MusicBed.urlForDream(dream),
            eligible: MusicBed.eligible(dream)
          });
        });
      });
      // The dreams tier 1 does NOT apply to: no mood at all, and free text.
      styles.forEach(function (style) {
        [null, undefined, 'other', 'vaguely ominous but hopeful'].forEach(function (mood) {
          var dream = { videoUrl: 'x.mp4', style: style, mood: mood };
          out.legacyRows.push({
            mood: String(mood), style: style,
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
    assert.deepEqual(result.moodFiles, {
      peaceful: 'peaceful.wav', joyful: 'joyful.wav', dreamy: 'dreamy.wav',
      mysterious: 'mysterious.wav', tense: 'tense.wav', epic: 'epic.wav'
    }, 'MOOD_FILES must carry exactly the six audition winners -- one committed bed per real mood, nothing extra');

    Object.keys(result.moodUrls).forEach(function (mood) {
      assert.equal(result.moodUrls[mood], 'assets/music-beds/moods/' + mood + '.wav',
        mood + ' must resolve to its own committed winner track');
    });
    assert.equal(result.rows.length, 30);
    result.rows.forEach(function (row) {
      assert.equal(row.forDream, 'assets/music-beds/moods/' + row.mood + '.wav',
        'mood "' + row.mood + '" + style "' + row.style + '": the dream\'s own mood must pick the bed, the visual style is ignored');
      assert.equal(row.eligible, true,
        'a real mood bed makes every real-video dream eligible, even one whose style has no bed');
    });
    result.legacyRows.forEach(function (row) {
      if (row.forStyle !== null) {
        // Known style: the skipped/free-text/legacy mood falls through to the
        // identical style bed, exactly as before this layer existed.
        assert.equal(row.forDream, row.forStyle,
          'mood "' + row.mood + '" + style "' + row.style + '": a skipped/free-text/legacy mood must fall through to the identical style bed');
      } else {
        // Unknown style AND no usable mood: tier 3 (2026-08-08) resolves the
        // neutral default bed instead of going silent.
        assert.equal(row.forDream, 'assets/music-beds/moods/dreamy.wav',
          'mood "' + row.mood + '" + unknown style "' + row.style + '": both tiers unresolved falls through to the tier-3 default bed, never silence');
      }
      // Either way a real video dream is now always eligible — a bed always
      // resolves (style bed for a known style, default bed otherwise).
      assert.equal(row.eligible, true,
        'a real video dream is always eligible now -- tier 3 guarantees a bed');
    });
  } finally {
    await context.close();
  }
});

test('js/music-bed.js: the dream\'s own mood wins over its visual style with the REAL live map -- an unknown mood, a free-text mood, or no mood at all falls back to the style bed, and when NEITHER tier resolves it falls through to the tier-3 neutral default bed (never silence)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.goto(baseUrl + '/explore.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(function () { return !!window.MusicBed; }, { timeout: 5000 });

    var r = await page.evaluate(function () {
      var d = function (mood, style) { return { videoUrl: 'x.mp4', style: style, mood: mood }; };
      // A hypothetical FUTURE mood key added to MOOD_KEYS before its track
      // exists must fall back, not go silent -- the guard urlForMood keeps
      // for exactly that window. Simulated by extending the live arrays the
      // module exports (same object references the closures read).
      MusicBed.MOOD_KEYS.push('melancholy');
      var futureMoodNoTrack = MusicBed.urlForDream(d('melancholy', 'Cartoon'));
      var futureMoodNoTrackUnknownStyle = MusicBed.urlForDream(d('melancholy', 'Surrealist'));
      var futureMoodNoTrackEligible = MusicBed.eligible(d('melancholy', 'Surrealist'));
      MusicBed.MOOD_KEYS.pop();
      return {
        // Tier 1 wins: the mood picks the bed, the visual style is ignored.
        tenseCartoon: MusicBed.urlForDream(d('tense', 'Cartoon')),
        tenseAnime: MusicBed.urlForDream(d('tense', 'Anime')),
        peacefulRealistic: MusicBed.urlForDream(d('peaceful', 'Realistic')),
        joyfulCartoon: MusicBed.urlForDream(d('joyful', 'Cartoon')),
        epicCinematic: MusicBed.urlForDream(d('epic', 'Cinematic')),
        // Tier 2: skipped / free text / unknown / absent -> style bed.
        nullMood: MusicBed.urlForDream(d(null, 'Cartoon')),
        otherMood: MusicBed.urlForDream(d('other', 'Cartoon')),
        freeTextMood: MusicBed.urlForDream(d('vaguely ominous but hopeful', 'Cartoon')),
        noMoodField: MusicBed.urlForDream({ videoUrl: 'x.mp4', style: 'Cartoon' }),
        // Case-insensitive, same contract urlForStyle already had.
        upperMood: MusicBed.urlForDream(d('TENSE', 'Cartoon')),
        // A mood bed rescues an otherwise-unresolvable style...
        tenseUnknownStyle: MusicBed.urlForDream(d('tense', 'Surrealist')),
        tenseUnknownStyleEligible: MusicBed.eligible(d('tense', 'Surrealist')),
        // ...and no mood + unknown style now resolves to the tier-3 neutral
        // default bed (2026-08-08 founder repro: a Write-path dream came back
        // SILENT). urlForDream never returns null for a real dream anymore.
        noMoodUnknownStyle: MusicBed.urlForDream(d(null, 'Surrealist')),
        noMoodUnknownStyleEligible: MusicBed.eligible(d(null, 'Surrealist')),
        defaultMood: MusicBed.DEFAULT_MOOD,
        futureMoodNoTrack: futureMoodNoTrack,
        futureMoodNoTrackUnknownStyle: futureMoodNoTrackUnknownStyle,
        futureMoodNoTrackEligible: futureMoodNoTrackEligible,
        // An image-only dream is never eligible however good its mood is.
        imageOnly: MusicBed.eligible({ imageUrl: 'x.jpg', videoUrl: null, style: 'Cartoon', mood: 'tense' }),
        nullDream: MusicBed.urlForDream(null)
      };
    });

    assert.equal(r.tenseCartoon, 'assets/music-beds/moods/tense.wav', 'the mood must beat the visual style');
    assert.equal(r.tenseAnime, 'assets/music-beds/moods/tense.wav', 'same mood + a different style still resolves to the mood bed');
    assert.equal(r.peacefulRealistic, 'assets/music-beds/moods/peaceful.wav');
    assert.equal(r.joyfulCartoon, 'assets/music-beds/moods/joyful.wav');
    assert.equal(r.epicCinematic, 'assets/music-beds/moods/epic.wav');
    assert.equal(r.nullMood, 'assets/music-beds/cartoon.wav', 'a SKIPPED mood falls back to the visual-style bed -- the tracker item\'s explicit requirement');
    assert.equal(r.otherMood, 'assets/music-beds/cartoon.wav', 'a "+ Something else" free-text mood falls back -- keyword mapping is explicitly out of scope');
    assert.equal(r.freeTextMood, 'assets/music-beds/cartoon.wav');
    assert.equal(r.noMoodField, 'assets/music-beds/cartoon.wav', 'a dream predating mood persistence entirely falls back');
    assert.equal(r.upperMood, 'assets/music-beds/moods/tense.wav');
    assert.equal(r.tenseUnknownStyle, 'assets/music-beds/moods/tense.wav');
    assert.equal(r.tenseUnknownStyleEligible, true, 'a real mood bed makes a previously-ineligible unknown-style dream eligible');
    // Tier 3 (2026-08-08): when neither mood nor style resolves, urlForDream
    // returns the neutral default mood bed instead of null, so a real video
    // dream is NEVER silent (founder repro). DEFAULT_MOOD is 'dreamy'.
    assert.equal(r.defaultMood, 'dreamy');
    assert.equal(r.noMoodUnknownStyle, 'assets/music-beds/moods/dreamy.wav', 'no mood + unknown style now resolves to the tier-3 default bed, never silence');
    assert.equal(r.noMoodUnknownStyleEligible, true, 'a real video dream is always eligible now — the default bed guarantees sound');
    assert.equal(r.futureMoodNoTrack, 'assets/music-beds/cartoon.wav', 'a future mood key with no MOOD_FILES entry still falls back to the style bed (tier 2 wins before tier 3)');
    assert.equal(r.futureMoodNoTrackUnknownStyle, 'assets/music-beds/moods/dreamy.wav', 'future mood with no track AND unknown style falls all the way through to the tier-3 default');
    assert.equal(r.futureMoodNoTrackEligible, true);
    assert.equal(r.imageOnly, false);
    assert.equal(r.nullDream, null);
  } finally {
    await context.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 2. Mood persistence — the actual bug fixed
// ─────────────────────────────────────────────────────────────────────────

// The four create.html "Build it" Mood-STEP UI tests that lived here (mood
// survives onto the draft; SKIP persists no mood; a "+ Something else" free-
// text mood persists no mood; going Back after a skip clears the sticky flag),
// plus their walkBuildWizardToMood helper, were REMOVED by the 3-question
// wizard trim (founder 08-13): create.html no longer renders a Mood step, so
// its BUILD_RENDERERS is [Subject, Action, FreeText] and mood defaults to
// WizardChips.DEFAULT_MOOD ('dreamy'). The mood->music mapping/persistence
// coverage below is unaffected and stays -- it drives mood programmatically
// (via DreamStore.generateVideo/adoptPendingGeneration opts and seeded
// dreams), never through the removed UI step.

test('js/store.js: a mood on the draft reaches the FINISHED dream record through a real (mocked-transport) generation, and drives that dream\'s music bed on result.html', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
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

test('js/store.js: with NO explicit mood, the mood is INFERRED from the dream text and that inferred mood reaches the FINISHED dream record and drives its bed on result.html -- the 3-question-trim mood-variety restore (founder 08-13), mirroring the explicit-mood test above', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedLoggedInUser(page, 'moodinferer');
    await mockGeneration(page, '/assets/music-beds/anime.wav');
    await page.goto(baseUrl + '/explore.html', { waitUntil: 'domcontentloaded' });
    // explore.html now loads js/wizard-chips.js, so startGeneration can reach
    // WizardChips.inferMoodFromText -- exactly as every real generation-start
    // page (home/create/wizard/result/style.html) can.
    await page.waitForFunction(function () { return !!(window.WizardChips && window.WizardChips.inferMoodFromText); }, { timeout: 5000 });

    var dream = await page.evaluate(async function () {
      // No mood opt at all. The caption carries the DEFAULT 'dreamy' language
      // (as create.html's Build flow assembles), but the storyText clearly
      // implies 'tense' (monster / chasing / dark / terrified) -- proving
      // storyText is the preferred inference source and beats both the
      // caption's default dreamy words and the Cartoon visual style.
      return await DreamStore.generateVideo(
        'a prompt, dreamy surreal mood, Cartoon style, dreamlike.',
        'Cartoon',
        { storyText: 'A monster was chasing me through the dark and I was terrified.' }
      );
    });
    assert.equal(dream.mood, 'tense', 'the mood inferred from the dream text must be stamped onto the finished dream record');

    await page.goto(baseUrl + '/result.html?id=' + dream.id, { waitUntil: 'domcontentloaded' });
    var bedSrc = await page.locator('#result-music-bed').evaluate(function (a) { return a.getAttribute('src'); });
    assert.equal(bedSrc, 'assets/music-beds/moods/tense.wav', 'result.html must play the bed for the INFERRED mood, not the Cartoon style bed');
  } finally {
    await context.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 1b. mood has to reach the WIRE, not just local state
//
// Regression coverage for a review finding on this branch. dream-sync.js's
// server-side DREAM_FIELDS allowlist was correctly given 'mood', and
// test/dream-sync.test.js proves the server round-trips it — but that test
// hand-builds its payload via its own dreamPayload() helper and calls the
// handler directly, so it can (and did) pass while the REAL client never put
// `mood` on the wire at all. js/store.js's attemptPrivateDreamSync builds its
// upsert body from an explicit hand-maintained field list, and `mood` was
// missing from it: a private dream's mood was correct in local state, correct
// in the server's allowlist, and still silently dropped in transit.
//
// Consequence pre-fix (zero user-visible impact TODAY only because no real
// mood-keyed tracks exist yet — this is dead-until-lit infrastructure that
// has to be correct the moment those 12 tracks land): a private dream
// RESTORED onto a new device or after a webview storage wipe — the entire
// reason dream-sync.js exists — came back permanently moodless and quietly
// fell back to its visual-style bed. The same dream would sound different on
// two devices, with nothing to recover the lost answer from.
//
// These two tests assert on the OUTGOING REQUEST BODY specifically. Asserting
// on local state, or on the server handler with a hand-built payload, is
// exactly what missed this.
// ─────────────────────────────────────────────────────────────────────────

test('js/store.js (regression): a real generation\'s mood actually reaches the WIRE in the private-dream sync upsert -- local state and the server allowlist both being right is not enough, the client\'s own explicit field list has to carry it too', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedLoggedInUser(page, 'moodwiresyncer');
    var syncCalls = mockDreamSync(page);
    await mockGeneration(page, '/assets/music-beds/anime.wav');
    await page.goto(baseUrl + '/explore.html', { waitUntil: 'domcontentloaded' });

    // The real public creation path, all the way through the real
    // finalizeDream -> syncPrivateDreamBestEffort -> attemptPrivateDreamSync
    // chain. Nothing here hand-builds a payload.
    var dream = await page.evaluate(async function () {
      return await DreamStore.generateVideo('a prompt, mysterious mood, Cartoon style, dreamlike.', 'Cartoon', { mood: 'mysterious' });
    });
    assert.equal(dream.mood, 'mysterious', 'sanity: local state must have the mood (this part was already correct pre-fix)');

    var sawUpsert = await waitFor(function () { return !!firstUpsert(syncCalls); });
    assert.ok(sawUpsert, 'sanity: a freshly generated private dream must fire an upsert against dream-sync at all');

    var upsert = firstUpsert(syncCalls);
    assert.equal(upsert.body.dream.id, dream.id, 'sanity: the upsert must be for the dream just created');
    assert.equal(
      upsert.body.dream.mood,
      'mysterious',
      'THE REGRESSION: mood must be present in the outgoing dream-sync upsert body. Without it the server stores a moodless copy, and a restore onto a new device / after a webview wipe permanently loses the user\'s mood answer and silently falls back to the visual-style bed.'
    );
  } finally {
    await context.close();
  }
});

// BEHAVIOR CHANGE (3-question-trim mood-variety restore, founder 08-13): a
// generation with no EXPLICITLY-chosen mood no longer stores/sends a bare
// null — js/store.js's startGeneration now infers the mood from the dream's
// own text (WizardChips.inferMoodFromText), so a chase dream sounds tense, a
// calm dream peaceful, etc., without re-adding a Mood question. explore.html
// now loads js/wizard-chips.js (as every real generation-start page does), so
// the inference is live here. The two tests below used to assert the OLD
// "no mood -> null -> style bed" contract; they now assert the inferred mood
// instead. The inference reassigns only the client-side `mood`/bed hint — it
// never alters the generation caption/promptText (test/split-prompttext-
// storytext-behavioral.test.js still guards the caption for the default case).
test('js/store.js: with NO explicit mood, the mood INFERRED from the dream text rides the SAME hand-maintained dream-sync wire field an explicit mood does -- so cross-device restore keeps the inferred mood, never a bare null', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedLoggedInUser(page, 'moodinferwiresyncer');
    var syncCalls = mockDreamSync(page);
    await mockGeneration(page, '/assets/music-beds/anime.wav');
    await page.goto(baseUrl + '/explore.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(function () { return !!(window.WizardChips && window.WizardChips.inferMoodFromText); }, { timeout: 5000 });

    await page.evaluate(async function () {
      // No mood opt, but a storyText whose words clearly imply 'peaceful'
      // (floating / calm / quiet / garden / serene / safe). This is the
      // common case now that the Mood step is gone.
      return await DreamStore.generateVideo('a prompt, Cartoon style, dreamlike.', 'Cartoon', { storyText: 'I was floating in a calm, quiet garden feeling serene and safe.' });
    });

    var sawUpsert = await waitFor(function () { return !!firstUpsert(syncCalls); });
    assert.ok(sawUpsert, 'sanity: a freshly generated private dream must fire an upsert against dream-sync at all');

    var upsert = firstUpsert(syncCalls);
    assert.equal(
      upsert.body.dream.mood,
      'peaceful',
      'the INFERRED mood must ride the outgoing dream-sync upsert body -- the same hand-maintained wire field list the explicit-mood regression above exercises. Without it, a restore onto a new device / after a webview wipe would lose the inferred mood and silently fall back to the visual-style bed.'
    );
  } finally {
    await context.close();
  }
});

test('js/store.js: a generation whose text carries NO mood keyword infers the neutral fallback (DEFAULT_MOOD \'dreamy\') and that drives the bed -- inference never leaves a real video dream moodless', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedLoggedInUser(page, 'moodfallbackgenerator');
    await mockGeneration(page, '/assets/music-beds/anime.wav');
    await page.goto(baseUrl + '/explore.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(function () { return !!(window.WizardChips && window.WizardChips.inferMoodFromText); }, { timeout: 5000 });

    var dream = await page.evaluate(async function () {
      // No mood opt and a keyword-light caption (only 'dreamlike' -> the
      // dreamy stem), so inference lands on the neutral fallback 'dreamy'.
      return await DreamStore.generateVideo('a prompt, Cartoon style, dreamlike.', 'Cartoon', {});
    });
    assert.equal(dream.mood, 'dreamy', 'keyword-light text infers the neutral DEFAULT_MOOD fallback, not null');

    await page.goto(baseUrl + '/result.html?id=' + dream.id, { waitUntil: 'domcontentloaded' });
    var bedSrc = await page.locator('#result-music-bed').evaluate(function (a) { return a.getAttribute('src'); });
    assert.equal(bedSrc, 'assets/music-beds/moods/dreamy.wav', 'the inferred fallback mood drives the mood bed, beating the Cartoon style bed');
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
// 3. The six live mood beds are real production assets
//
// (This section replaced the audition-page tests when the audition
// concluded and bed-audition-x7q4.html was deleted — see the header
// comment. The picking flow it covered no longer exists to test.)
// ─────────────────────────────────────────────────────────────────────────

test('assets/music-beds/moods/: all six winner beds exist on disk as valid, full-length WAVs, are served at their production URLs, and genuinely decode and play in a real browser', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var moods = ['peaceful', 'joyful', 'dreamy', 'mysterious', 'tense', 'epic'];

  // On disk: a truncated download or wrong-format encode must not be able
  // to pass this suite. Same spec family as the four style beds.
  moods.forEach(function (mood) {
    var p = path.join(REPO_ROOT, 'assets', 'music-beds', 'moods', mood + '.wav');
    var buf = fs.readFileSync(p);
    assert.equal(buf.slice(0, 4).toString('ascii'), 'RIFF', p + ' must be a RIFF container');
    assert.equal(buf.slice(8, 12).toString('ascii'), 'WAVE', p + ' must be a WAVE file');
    assert.ok(buf.length > 1000000, p + ' must not be a stub/truncated file');
  });

  // And no candidate leftovers: the audition's losers (and the whole
  // candidates directory) were deleted, per the no-dead-assets instruction.
  assert.equal(fs.existsSync(path.join(REPO_ROOT, 'assets', 'music-beds', 'moods', 'candidates')), false,
    'the candidates directory must be gone once the audition is over');
  assert.equal(fs.existsSync(path.join(REPO_ROOT, 'bed-audition-x7q4.html')), false,
    'the audition page must be gone once the audition is over');

  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.goto(baseUrl + '/explore.html', { waitUntil: 'domcontentloaded' });

    // Served: every production URL answers 200 (the exact URLs urlForMood
    // hands to the players).
    for (var i = 0; i < moods.length; i++) {
      var res = await page.request.head(baseUrl + '/assets/music-beds/moods/' + moods[i] + '.wav');
      assert.equal(res.status(), 200, moods[i] + '.wav must be served at its production path');
    }

    // Playable: one bed genuinely decodes and progresses in real Chromium —
    // proving real audio, not just paths that 200.
    var played = await page.evaluate(function () {
      return new Promise(function (resolve) {
        var a = new Audio('assets/music-beds/moods/peaceful.wav');
        a.muted = true;
        a.play().then(function () {
          var check = setInterval(function () {
            if (a.currentTime > 0) { clearInterval(check); a.pause(); resolve(true); }
          }, 50);
          setTimeout(function () { clearInterval(check); resolve(a.currentTime > 0); }, 5000);
        }).catch(function () { resolve(false); });
      });
    });
    assert.equal(played, true, 'a committed mood bed must actually decode and play');
  } finally {
    await context.close();
  }
});
