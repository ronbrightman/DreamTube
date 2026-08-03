// js/music-bed.js
//
// MusicBed — style-matched, reusable AMBIENT MUSIC BED resolution + a
// small shared play/pause-sync helper. Plain script (matches store.js's
// convention — no ES modules, no bundler — see CLAUDE.md), loaded after
// js/store.js and before any page-specific <script> block that plays a
// dream's video.
//
// ===== Background (tracker item for-product-build-founder-approved-08-03-
// jlkjy9, Option B) =====
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
   * Whether `dream` should ever get a music-bed <audio> element at all.
   * Forward-only migration, same convention as modelUsed/createdAt (see
   * js/store.js's finalizeDream doc comment): `dream.musicBedOn` must be
   * the LITERAL boolean `true` — anything else (explicit `false`, or simply
   * absent because this dream predates the feature entirely) is treated as
   * silent, never guessed or backfilled. Also requires a real video
   * (mediaType video, imageUrl-only dreams have nothing to loop a bed
   * against) and a style with a known bed file.
   */
  function eligible(dream) {
    return !!(dream && dream.musicBedOn === true && dream.videoUrl && urlForStyle(dream.style));
  }

  return { urlForStyle: urlForStyle, eligible: eligible };
})();
