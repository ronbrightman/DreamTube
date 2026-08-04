// js/music-bed.js
//
// MusicBed — style-matched, reusable AMBIENT MUSIC BED resolution + a
// small shared play/pause-sync helper. Plain script (matches store.js's
// convention — no ES modules, no bundler — see CLAUDE.md), loaded after
// js/store.js and before any page-specific <script> block that plays a
// dream's video.
//
// ===== Background (tracker item for-product-build-founder-approved-08-03-
// jlkjy9) =====
// Founder directive 2026-08-02 (tracker item for-product-turn-off-audio-
// dialogue-gene-ooeyoj) made every generated video permanently, structurally
// silent — generate-video.js/start-pending-generation.js force
// generate_audio:false unconditionally, for every path, forever. That fix is
// NOT touched by this file or anything that uses it. This feature is a
// SEPARATE, purely client-side layer on top of that already-silent video: a
// short (~45s), one-time-generated, seamless-loop-intent ambient music track
// per STYLE (Cartoon/Cinematic/Anime/Realistic — style.html's own four
// #style-grid values, see that file's data-style attributes), committed as
// real static assets at assets/music-beds/<key>.wav and served exactly like
// any other static asset in this build-step-free repo (assets/logo-v4.png,
// etc. — see netlify.toml's `publish = "."`). No per-video generation cost,
// no model-generated audio anywhere, so the founder's "never invent
// dialogue" constraint holds structurally, not just by luck.
//
// NOT the same thing as the retired `musicStyle` request field (dreamy/
// cinematic/upbeat/none-ambient — a content modifier that used to steer
// Veo's now-force-disabled native audio, see generate-video.js's
// MUSIC_STYLE_MODIFIERS). That field is left alone, still sent, still
// permanently inert — see js/store.js's startGeneration doc comment. This
// bed is chosen entirely by the dream's own VISUAL style, no separate
// picker.
//
// ===== FOUNDER SIMPLIFICATION (2026-08-03, current state — supersedes the
// "Option B toggle" this feature originally shipped as) =====
// The feature above first shipped as a real ON/OFF toggle on style.html,
// per-dream, persisted as a `musicBedOn` boolean (default ON). The founder
// walked it and immediately simplified: "NO TOGGLE. Since the music beds
// are free, music is simply ALWAYS ON — every dream video plays with its
// style-matched bed, no user choice." style.html's toggle (and the
// `musicBedOn` field it used to write onto a draft/dream) is gone entirely
// — see that file's own removal comment for what replaced the screen real
// estate (nothing — matches the precedent this same tracker item already
// set when it removed the old #music-style-row chip picker outright rather
// than leaving a disabled placeholder). `eligible()` below deliberately
// no longer reads `musicBedOn` in ANY form, which is exactly what makes a
// dream generated/published BEFORE this simplification — carrying a stale
// `musicBedOn: false` from the toggle era, or no field at all from before
// the feature existed at all — get a bed now too, same as a brand new one:
// there is no lingering opt-out sitting in old data. Mute stays available
// in the player exactly as before; the client-side-vs-muxing tradeoff
// below is unaffected by this simplification.
//
// ===== Implementation choice: client-side playback, not server-side muxing
// (stated here, at the point of use, per that tracker item's own
// instruction to state the tradeoff explicitly) =====
// The video FILE itself never gets an audio track from this feature — the
// bed is a second, separate <audio> element kept in sync with the <video>'s
// own play/pause state by each page's own script (see the per-page wiring
// in explore.html/result.html for exactly how, since each page's existing
// video lifecycle — IntersectionObserver-driven feed autoplay vs. a single
// ambient preview loop — is different enough that a one-size-fits-all DOM
// wiring function doesn't fit both well; this file only owns the shared,
// page-agnostic "which URL, is this dream even eligible" logic).
// Consequence, accepted deliberately: a downloaded video file, or a video
// shared outside this app (a raw video URL/file), carries NO audio — the
// bed only ever plays back inside DreamTube's own player UI. Muxing the bed
// into the video file at generation time (ffmpeg-in-a-Netlify-function, or
// a new vendor API) would fix that, but is a genuinely new dependency/
// vendor decision this feature deliberately does not make unilaterally —
// see lib/media-rehost.js's own header comment for the same reasoning
// applied to a smaller, analogous case. This ships today or it doesn't ship
// at all; the founder's own "walk before wide flip" instruction (see this
// item's own tracker text) favors that.
//
// ===== MOOD-KEYED BEDS (2026-08-04, tracker item for-product-founder-
// 08-04-evening-music--jfjco0, FINAL-FINAL scope — supersedes nothing
// above, ADDS a layer on top of it) =====
// The founder's own insight: a dream's VISUAL style ("Cartoon") is a weak
// signal for what it should sound like, but the dream-builder wizard's
// MOOD step (step 4 of 5 — peaceful / joyful / dreamy-surreal /
// mysterious / tense-scary / epic, see js/wizard-chips.js's MOOD_CHIPS)
// is exactly the right one. So bed selection is now two-tier:
//
//   1. If the dream carries a real chosen `mood` AND a bed file exists for
//      that mood -> use the mood-keyed bed.
//   2. Otherwise (mood skipped, mood was "+ Something else" free text,
//      the dream predates mood persistence, or no mood bed file exists
//      yet) -> fall back to the visual-style bed above, exactly as before.
//
// The four style beds are therefore PERMANENT, not a migration step —
// they are the fallback tier, and deleting them would break case 2.
//
// TODAY, TIER 1 IS INERT BY DESIGN: MOOD_FILES below is empty, because the
// 12 real candidate tracks (2 per mood, for the founder to audition on
// bed-audition-x7q4.html and pick a winner from) need the one-time fal.ai
// ~45s seamless-loop pipeline run by someone who actually holds a FAL_KEY,
// which the agent sandbox this layer was built in does not have. Every
// mood therefore currently resolves to null in tier 1 and falls through to
// tier 2 — i.e. this layer changes nothing any user actually hears right
// now, which is deliberate and is covered by test/mood-music-bed-
// behavioral.test.js. Switching it on later is one line per mood (an entry
// in MOOD_FILES + the committed file); no other code has to change.
var MusicBed = (function () {
  // One committed WAV per style — see this file's header comment for
  // provenance. Keys are lowercased style values; style.html's own
  // #style-grid data-style attributes are the single source of truth for
  // what a dream's `style` field can actually be (Cartoon/Cinematic/Anime/
  // Realistic) — this map is deliberately just those four, lowercased.
  var FILES = {
    cartoon: 'cartoon.wav',
    cinematic: 'cinematic.wav',
    anime: 'anime.wav',
    realistic: 'realistic.wav'
  };

  // The mood values a dream's `mood` field can actually carry — the six
  // real MOOD_CHIPS keys from js/wizard-chips.js, and nothing else.
  // Deliberately excludes 'other': that chip is free text, which has no
  // fixed bed and (per the tracker item's own explicit scope cut) is NOT
  // keyword-mapped in this pass — it falls through to the style bed like
  // any other unknown value. Duplicated here rather than imported because
  // this file has to stand alone: explore.html loads js/music-bed.js
  // without js/wizard-chips.js. test/mood-music-bed-behavioral.test.js
  // asserts this list still matches MOOD_CHIPS exactly, so the two copies
  // cannot silently drift apart.
  var MOOD_KEYS = ['peaceful', 'joyful', 'dreamy', 'mysterious', 'tense', 'epic'];

  // mood key -> committed filename under assets/music-beds/moods/.
  // INTENTIONALLY EMPTY until the founder's audition picks land — see this
  // file's header comment. An empty entry means "no mood bed for this mood
  // yet," which urlForMood turns into null and urlForDream turns into the
  // style-bed fallback. Never add a placeholder/fake file here to make the
  // map look populated — a missing asset is tolerated, never faked (same
  // convention as a missing character portrait elsewhere in this app).
  var MOOD_FILES = {};

  /**
   * The bed asset URL for a given dream `style` string, or null if that
   * style has no matching bed (an unrecognized/future style value — fails
   * closed to "no bed" rather than guessing).
   */
  function urlForStyle(style) {
    var key = typeof style === 'string' ? style.toLowerCase() : '';
    var file = FILES[key];
    return file ? 'assets/music-beds/' + file : null;
  }

  /**
   * The mood-keyed bed asset URL for a dream's `mood` value, or null when
   * there isn't one — which today is ALWAYS, since MOOD_FILES is still
   * empty (see this file's header comment). Three distinct null cases, all
   * deliberately collapsed into the same "no mood bed, fall back" answer:
   *   - `mood` is absent/null: the mood step was SKIPPED, or this dream
   *     predates mood persistence entirely.
   *   - `mood` is some other string: a "+ Something else" free-text mood,
   *     or a future mood key this build doesn't know. Fails closed rather
   *     than guessing, same discipline as urlForStyle above.
   *   - `mood` is a real known key but has no committed file yet: today's
   *     state for all six.
   */
  function urlForMood(mood) {
    var key = typeof mood === 'string' ? mood.toLowerCase() : '';
    if (MOOD_KEYS.indexOf(key) === -1) return null;
    var file = MOOD_FILES[key];
    return file ? 'assets/music-beds/moods/' + file : null;
  }

  /**
   * THE bed URL for a whole dream — the two-tier resolution described in
   * this file's header comment: the dream's own chosen mood first, the
   * visual-style bed as the permanent fallback. Every playback surface
   * (result.html, explore.html) calls this rather than urlForStyle
   * directly, so switching tier 1 on later needs no change at any call
   * site. Returns null only when NEITHER tier resolves (an unrecognized
   * style with no usable mood).
   */
  function urlForDream(dream) {
    if (!dream) return null;
    return urlForMood(dream.mood) || urlForStyle(dream.style);
  }

  /**
   * Whether `dream` should ever get a music-bed <audio> element at all.
   * Per the 2026-08-03 founder simplification (see this file's header
   * comment), there is no user choice left to check — music is always on
   * for every dream that has both a real video and a bed that actually
   * resolves. As of the mood-keyed layer that means EITHER tier resolving
   * (urlForDream): a dream whose visual style has no bed is now eligible
   * after all if its mood has a track — which today can never happen,
   * since MOOD_FILES is empty, so this is byte-for-byte the same answer
   * it has always given. Deliberately does NOT read `dream.musicBedOn` at all (that
   * field no longer means anything, and may still be `false`/`true`/absent
   * on dreams generated across this feature's three history phases) — this
   * is what makes a dream generated before this simplification also always
   * play its bed now, with no stale opt-out surviving from the toggle era.
   */
  function eligible(dream) {
    return !!(dream && dream.videoUrl && urlForDream(dream));
  }

  // MOOD_KEYS/MOOD_FILES are exposed as the SAME object/array references
  // the functions above close over — not copies. That's what lets
  // test/mood-music-bed-behavioral.test.js prove tier 1 really works by
  // populating MOOD_FILES at runtime (standing in for the real committed
  // tracks that don't exist yet) and watching urlForDream switch over,
  // without this file needing a test-only backdoor function.
  return {
    urlForStyle: urlForStyle,
    urlForMood: urlForMood,
    urlForDream: urlForDream,
    eligible: eligible,
    MOOD_KEYS: MOOD_KEYS,
    MOOD_FILES: MOOD_FILES
  };
})();
