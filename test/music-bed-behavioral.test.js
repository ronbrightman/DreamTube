// test/music-bed-behavioral.test.js
//
// Real browser-driven coverage for tracker item for-product-build-founder-
// approved-08-03-jlkjy9. style.html originally shipped a real Audio & music
// toggle (Option B) controlling a reusable, style-matched AMBIENT MUSIC BED
// (js/music-bed.js), played back 100% client-side alongside a dream's own
// permanently-silent video. The founder then simplified it the same day:
// "NO TOGGLE. Since the music beds are free, music is simply ALWAYS ON —
// every dream video plays with its style-matched bed, no user choice." The
// toggle and its `musicBedOn` field are gone entirely (see style.html's own
// removal comment) — this file now covers the current, choice-free reality.
// See js/music-bed.js's own header comment for the full implementation-
// choice writeup (client-side playback vs. muxing at generation —
// client-side was picked; the real, accepted cost is that downloads/shares
// of the raw video file itself carry no audio, since the bed is never
// baked into it).
//
// This file does NOT touch, and does not re-test, generate_audio/audioOn/
// musicStyle — those stay exactly as the earlier ooeyoj directive left them
// (see test/audio-toggle-behavioral.test.js and test/generate-video-audio-
// toggle.test.js for that coverage). This file covers only:
//   1. The static bed assets resolve for all 4 styles at the real path a
//      production deploy would serve them from (assets/music-beds/*.wav —
//      no build step, no new endpoint, same as any other static asset in
//      this repo — see netlify.toml's `publish = "."`).
//   2. js/music-bed.js's own resolution logic (urlForStyle/eligible) — the
//      current contract: eligible() no longer reads musicBedOn in any
//      form, so a dream carrying a stale musicBedOn:false (or true) from
//      the toggle era, or no musicBedOn field at all (predating the
//      feature entirely), all become eligible identically, so long as they
//      have a real video + a known style.
//   3. result.html: EVERY video dream with a known style gets a real,
//      synced bed (src assigned, plays/pauses with the video, mutes/
//      unmutes with the same device-level sound preference as the video's
//      own mute button) — regardless of any historical musicBedOn value.
//      Only a missing video, or an unrecognized style, is ever silent.
//   4. explore.html: the shared feed's own cardHTML renders a bed for
//      every eligible card (server-side, via publish-dream.js/get-feed.js
//      — see js/store.js's syncPublishedDreamToFeed), again regardless of
//      any historical musicBedOn value on the stored record; the feed's
//      own mute button controls the bed's mute state together with the
//      video's.

var test = require('node:test');
var assert = require('node:assert/strict');
var http = require('node:http');
var staticServer = require('./helpers/static-server');

var CHROMIUM_PATH = '/opt/pw-browsers/chromium';
var MOBILE_VIEWPORT = { width: 390, height: 844 };

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

/** Plain node:http GET — no browser needed for a static-asset-resolves check. */
function httpGet(url) {
  return new Promise(function (resolve, reject) {
    http.get(url, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () { resolve({ statusCode: res.statusCode, headers: res.headers, length: Buffer.concat(chunks).length }); });
    }).on('error', reject);
  });
}

async function seedLoggedInUserWithDreams(page, username, dreams) {
  await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function (args) {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@' + args.u, username: args.u };
    if (!state.accounts) state.accounts = {};
    state.accounts[args.u] = { password: 'testpass1', email: args.u + '@example.com' };
    if (!state.dreams) state.dreams = [];
    args.dreams.forEach(function (d) { state.dreams.push(d); });
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, { u: username, dreams: dreams });
}

test('the four style-matched music-bed WAV files resolve as real static assets at the path production serves them from', async function () {
  var styles = ['cartoon', 'cinematic', 'anime', 'realistic'];
  for (var i = 0; i < styles.length; i++) {
    var res = await httpGet(baseUrl + '/assets/music-beds/' + styles[i] + '.wav');
    assert.equal(res.statusCode, 200, styles[i] + '.wav must resolve with 200');
    assert.ok(res.length > 100000, styles[i] + '.wav must be a real, non-empty audio file (got ' + res.length + ' bytes)');
  }
});

test('js/music-bed.js: urlForStyle resolves all 4 real styles and fails closed on anything else; eligible() requires only a real videoUrl and a known style -- no musicBedOn check at all, so any historical value (or its total absence) never opts a dream out', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.goto(baseUrl + '/explore.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(function () { return !!window.MusicBed; }, { timeout: 5000 });

    var urls = await page.evaluate(function () {
      return {
        Cartoon: MusicBed.urlForStyle('Cartoon'),
        cinematic: MusicBed.urlForStyle('cinematic'), // case-insensitive
        Anime: MusicBed.urlForStyle('Anime'),
        Realistic: MusicBed.urlForStyle('Realistic'),
        unknown: MusicBed.urlForStyle('Surrealist'),
        empty: MusicBed.urlForStyle(''),
        nullish: MusicBed.urlForStyle(null)
      };
    });
    assert.equal(urls.Cartoon, 'assets/music-beds/cartoon.wav');
    assert.equal(urls.cinematic, 'assets/music-beds/cinematic.wav');
    assert.equal(urls.Anime, 'assets/music-beds/anime.wav');
    assert.equal(urls.Realistic, 'assets/music-beds/realistic.wav');
    assert.equal(urls.unknown, null, 'an unrecognized style must fail closed to no bed, never guess');
    assert.equal(urls.empty, null);
    assert.equal(urls.nullish, null);

    var eligibility = await page.evaluate(function () {
      return {
        // The three historical shapes musicBedOn can carry on a real stored
        // dream/draft (toggle-era true, toggle-era false, or entirely
        // absent for a dream older than the feature) must ALL be equally
        // eligible now -- the founder's "no user choice" simplification
        // means this field is never consulted at all.
        staleTrue: MusicBed.eligible({ musicBedOn: true, videoUrl: 'x.mp4', style: 'Cartoon' }),
        staleFalse: MusicBed.eligible({ musicBedOn: false, videoUrl: 'x.mp4', style: 'Cartoon' }),
        missingField: MusicBed.eligible({ videoUrl: 'x.mp4', style: 'Cartoon' }), // pre-feature dream
        noVideo: MusicBed.eligible({ musicBedOn: false, videoUrl: null, style: 'Cartoon', imageUrl: 'x.jpg' }),
        unknownStyle: MusicBed.eligible({ videoUrl: 'x.mp4', style: 'Surrealist' }),
        nullDream: MusicBed.eligible(null)
      };
    });
    assert.equal(eligibility.staleTrue, true);
    assert.equal(eligibility.staleFalse, true, 'a stale musicBedOn:false left over from the retired toggle must NOT silently opt this dream out -- music is always on now');
    assert.equal(eligibility.missingField, true, 'a dream that predates this feature entirely (no musicBedOn at all) must ALSO get a bed now -- no lingering opt-out from before the feature existed');
    assert.equal(eligibility.noVideo, false, 'an image-only dream has nothing to loop a bed against, regardless of any musicBedOn value');
    assert.equal(eligibility.unknownStyle, false);
    assert.equal(eligibility.nullDream, false);
  } finally {
    await context.close();
  }
});

test('result.html: an eligible dream gets a real, style-matched bed that plays/pauses with the video and shares its mute state -- even with a stale musicBedOn:false left over from the retired toggle', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedLoggedInUserWithDreams(page, 'bedeligibletester', [{
      id: 'dream-bed-eligible', ownerHandle: '@bedeligibletester', caption: 'A dream about the sea',
      style: 'Cartoon', mediaType: 'video',
      // A real, locally-served playable file standing in for a video URL —
      // this repo's own committed WAV assets are the only real media file
      // this test server can serve, and <video> will happily play it well
      // enough to fire real play/pause events, which is all this test needs.
      videoUrl: '/assets/music-beds/anime.wav',
      // Deliberately a stale musicBedOn:false, as if this dream survived
      // from the earlier toggle era with the toggle switched off -- the
      // founder's "no user choice" simplification means this must NOT
      // suppress the bed anymore (see js/music-bed.js's eligible()).
      musicBedOn: false, dur: '0:08', isPublished: false, likes: 0, likedByMe: false
    }]);
    await page.goto(baseUrl + '/result.html?id=dream-bed-eligible', { waitUntil: 'domcontentloaded' });

    var bedSrc = await page.locator('#result-music-bed').evaluate(function (a) { return a.getAttribute('src'); });
    assert.equal(bedSrc, 'assets/music-beds/cartoon.wav', 'the bed must be style-matched to this dream\'s own Cartoon style');

    // Drive real play()/pause() on the video and confirm the bed follows —
    // exercises the actual sync wiring (video 'play'/'pause' listeners),
    // not just the initial src assignment.
    var syncResult = await page.evaluate(async function () {
      var v = document.getElementById('result-video');
      var a = document.getElementById('result-music-bed');
      var log = {};
      try { await v.play(); } catch (e) { /* ignore */ }
      await new Promise(function (r) { setTimeout(r, 400); });
      log.afterPlay = { videoPaused: v.paused, bedPaused: a.paused };
      v.pause();
      await new Promise(function (r) { setTimeout(r, 150); });
      log.afterPause = { videoPaused: v.paused, bedPaused: a.paused };
      return log;
    });
    assert.equal(syncResult.afterPlay.videoPaused, false);
    assert.equal(syncResult.afterPlay.bedPaused, false, 'the bed must start playing alongside the video');
    assert.equal(syncResult.afterPause.videoPaused, true);
    assert.equal(syncResult.afterPause.bedPaused, true, 'the bed must pause alongside the video');

    // Mute button controls both the video and the bed together (one shared
    // device-level sound preference, DreamStore.getSoundPref/setSoundPref).
    await page.click('#mute-btn');
    var muteState = await page.evaluate(function () {
      return { videoMuted: document.getElementById('result-video').muted, bedMuted: document.getElementById('result-music-bed').muted };
    });
    assert.equal(muteState.videoMuted, false);
    assert.equal(muteState.bedMuted, false, 'unmuting must unmute the bed too, not just the (already audio-less) video');
  } finally {
    await context.close();
  }
});

test('result.html: a pre-feature dream (no musicBedOn field at all) gets a bed just like a brand-new one -- no lingering opt-out from before the feature existed; only a real ineligibility reason (unknown style) still yields silence', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedLoggedInUserWithDreams(page, 'bedofftester', [
      {
        id: 'dream-bed-missing', ownerHandle: '@bedofftester', caption: 'A pre-feature dream',
        style: 'Realistic', mediaType: 'video', videoUrl: '/assets/music-beds/anime.wav',
        dur: '0:08', isPublished: false, likes: 0, likedByMe: false
        // no musicBedOn key at all -- simulates a dream saved before this feature shipped
      },
      {
        id: 'dream-bed-unknown-style', ownerHandle: '@bedofftester', caption: 'An unrecognized style',
        style: 'Surrealist', mediaType: 'video', videoUrl: '/assets/music-beds/anime.wav',
        dur: '0:08', isPublished: false, likes: 0, likedByMe: false
      }
    ]);

    await page.goto(baseUrl + '/result.html?id=dream-bed-missing', { waitUntil: 'domcontentloaded' });
    var missingSrc = await page.locator('#result-music-bed').evaluate(function (a) { return a.getAttribute('src'); });
    assert.equal(missingSrc, 'assets/music-beds/realistic.wav', 'a pre-feature dream with no musicBedOn field at all must get a bed now -- no lingering opt-out');

    await page.goto(baseUrl + '/result.html?id=dream-bed-unknown-style', { waitUntil: 'domcontentloaded' });
    var unknownStyleSrc = await page.locator('#result-music-bed').evaluate(function (a) { return a.getAttribute('src'); });
    assert.equal(unknownStyleSrc, null, 'an unrecognized style must still fail closed to no bed -- that check is untouched by the always-on simplification');
  } finally {
    await context.close();
  }
});

test('explore.html: the shared feed renders a bed for every video card with a known style regardless of any historical musicBedOn value, and the feed\'s global mute button controls it alongside the video', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await newMobileContext();
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await page.route('**/.netlify/functions/get-feed*', function (route) {
      route.fulfill({
        status: 200, contentType: 'application/json', body: JSON.stringify({
          feed: [
            { id: 'feed-eligible', ownerHandle: '@someone', caption: 'A dream', style: 'Cartoon', videoUrl: '/assets/music-beds/anime.wav', mediaType: 'video', musicBedOn: true, likes: 3, dur: '0:08' },
            // Stale musicBedOn:false from the retired toggle era -- must
            // still get a bed now (the founder's "no user choice"
            // simplification means this field is never consulted).
            { id: 'feed-stale-off', ownerHandle: '@someone', caption: 'Another dream', style: 'Anime', videoUrl: '/assets/music-beds/realistic.wav', mediaType: 'video', musicBedOn: false, likes: 1, dur: '0:08' }
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
        return { id: c.dataset.id, hasBed: !!bed, bedSrc: bed ? bed.getAttribute('src') : null };
      });
    });
    var eligibleCard = cards.filter(function (c) { return c.id === 'feed-eligible'; })[0];
    var staleOffCard = cards.filter(function (c) { return c.id === 'feed-stale-off'; })[0];
    assert.ok(eligibleCard, 'the eligible card must be present');
    assert.equal(eligibleCard.hasBed, true);
    assert.equal(eligibleCard.bedSrc, 'assets/music-beds/cartoon.wav', 'style-matched to the eligible dream\'s own Cartoon style');
    // feed-stale-off is the second dream -- may still be a virtualized
    // placeholder depending on viewport, so only assert on it if hydrated.
    if (staleOffCard) assert.equal(staleOffCard.hasBed, true, 'a stale musicBedOn:false from the retired toggle era must NOT suppress the bed -- music is always on now');

    // The first (eligible) card is the scroll-snap winner and should be
    // autoplaying via videoObserver -- confirm the bed actually plays
    // alongside it (exercises the real IntersectionObserver-driven wiring,
    // not just src assignment), tolerating this feature's own documented
    // bounded retry for a real, root-caused intermittent Chromium
    // audio-autoplay race (see explore.html's wireVideoRecovery comment).
    await page.waitForFunction(function () {
      var v = document.querySelector('.feed-video');
      return v && !v.paused;
    }, { timeout: 8000 });
    await page.waitForFunction(function () {
      var a = document.querySelector('.feed-music-bed');
      return a && !a.paused;
    }, { timeout: 8000 });

    // Global mute button controls the bed too, not just the video.
    await page.click('.feed-mute-btn');
    var muteState = await page.evaluate(function () {
      var v = document.querySelector('.feed-video');
      var a = document.querySelector('.feed-music-bed');
      return { videoMuted: v.muted, bedMuted: a.muted };
    });
    assert.equal(muteState.videoMuted, false);
    assert.equal(muteState.bedMuted, false, 'unmuting the feed must unmute the bed too');
  } finally {
    await context.close();
  }
});
