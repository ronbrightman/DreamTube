// js/interpret-experience.js
//
// Interpretation Wave 1 — "The Interpreter's Chamber" (Direction B, founder-
// confirmed "B confirmed" 2026-07-29 — docs/INTERPRETATION_WAVE1_SPEC.md,
// tracker item for-product-build-interpretation-wave-1--xuftyn). The
// full-screen, self-contained interpretation surface: a method-first
// picker of five "inspired by" personas (js/interpreter-personas.js), 1-3
// persona-voiced clarifying questions per pick, then an in-persona
// reading — replacing the old single blended "What this dream might mean"
// reflection entirely.
//
// Plain script (no ES modules — matches every other file in this
// codebase, see CLAUDE.md), attaches ONE global, `window.InterpretExperience`,
// with exactly the two calls the spec's §8 self-contained-mounting section
// specifies: `InterpretExperience.open(dreamId)` / `.close()`. Matches
// js/purchase-sheet.js's own established precedent for a complex shared
// sheet/overlay component — same singleton-DOM-mounted-once,
// `currentGen`-style async-staleness-guard, `trackLocal` posthog-direct
// analytics pattern (see that file's own header comment for the full
// reasoning on each).
//
// Depends on (must be loaded first by the host page): js/icons.js,
// js/store.js, js/interpreter-personas.js, and (since the dream-picker
// strip below, tracker item for-product-chamber-dream-linkage-is-unc-
// 00s2dr) js/dream-cards.js. Mountable from ANY page that loads those
// four scripts plus this one and css/styles.css's `.itp-*` block — wave 1
// wires it from home.html's Chamber card and result.html's interpretation
// pill (see those files' own comments), but nothing here assumes either
// host. home.html already loaded js/dream-cards.js for its own My Dreams
// row before this strip existed; result.html gained the script tag
// specifically for this.
//
// ── State machine (spec §3) ──
// picker -> q_loading -> questions -> r_loading -> reading, plus:
//   - q_loading failure (non-429) silently skips straight to r_loading
//     with qa:[] — questions are NEVER a gate (spec §3.2's hard rule).
//   - q_loading/r_loading failure on a 429 (rate-limited) shows the
//     friendly limit message instead (Close only, no Retry) — the one
//     exception to "never a gate," since a rate-limited account can't
//     produce a reading either.
//   - r_loading failure (non-429) shows a persona-neutral error + Retry +
//     Close.
//   - A dream that already has >=1 saved reading opens straight on
//     `reading` (most recent), skipping the picker (spec §3.0).
//
// ── qa is kept in-session AND (deliberately, beyond the spec's own
//    getInterpretations() read-shape note) persisted per-reading ──
// docs/INTERPRETATION_WAVE1_SPEC.md §5 documents DreamStore.getInterpretations()
// as returning `{ text, at }` per persona, explicitly omitting `qa`
// ("result.html doesn't need it") — written when result.html was still
// expected to be the direct consumer of interpretation state. Under the
// actual Direction-B build, result.html never touches interpretation
// internals at all (it only calls InterpretExperience.open()); THIS file
// is the real consumer, and it needs the original `qa` to honor spec
// §3.5's "Regenerate... re-runs mode:'reading' with the same persona +
// same qa" even on a REVISIT (opened straight to a saved reading, no
// in-session qa in memory yet). js/store.js's getInterpretations()
// therefore returns `qa` too (a strict superset of the documented shape,
// not a narrowing) — same ownership-gated, private-only read either way,
// no privacy change. Flagged here plainly as a deliberate, documented
// deviation from the letter of §5's read-shape note, not an oversight.

(function () {
  'use strict';

  var ROOT_ID = 'itp-root';
  var FREE_TEXT_MAXLENGTH = 280;

  // Current open() session, or null when closed. `gen` is bumped on every
  // open()/close() — the same async-staleness-guard pattern
  // js/purchase-sheet.js's `currentGen` already established in this
  // codebase (captured by an async call before its own await/then, and
  // re-checked before that call's response is allowed to mutate shared
  // singleton DOM) — a network response arriving after the user has
  // already closed the overlay (or reopened it for a DIFFERENT dream)
  // must never mutate a session it no longer belongs to.
  var session = null;
  var gen = 0;

  // ==========================================================================
  // Speaking Sage — Option D (docs/SPEAKING_SAGE_SPEC.md, tracker item
  // for-product-build-speaking-sage-wave-fou-8uobuh, founder GO on "Option
  // D" 2026-08-02/08-03). One-time lip-synced intro per persona, then a
  // per-reading Kokoro voice track (am_onyx, speed 0.8) played over the
  // user's OWN dream video (bounce-looped) with timed captions overlaid —
  // no per-reading lip-sync (explicitly ruled out as too expensive).
  //
  // ── Founder-preview gate ──
  // Ships behind a query-param + localStorage-sticky gate (same
  // "?param=1, remembered in localStorage from then on" convention this
  // codebase already uses elsewhere — e.g. start.html's `signup` override,
  // wizard.html's `entry=index`) rather than a broad on/off flip — build
  // task scope item 4: "Manager needs a way to preview it and give the
  // founder a link first," before this goes live for everyone. A link like
  // `home.html?sagevoice=1` (or any page hosting the Chamber) permanently
  // enables this browser; there is no broad-rollout switch yet — that's a
  // deliberate separate step once the real founder-approved intro asset
  // replaces this branch's placeholder (see js/interpreter-personas.js's
  // own header note).
  var VOICE_PREVIEW_PARAM = 'sagevoice';
  var VOICE_PREVIEW_STORAGE_KEY = 'dreamtube_interp_voice_preview';

  /** True once this browser has been granted the Speaking Sage preview (via the `?sagevoice=1` link, sticky in localStorage from then on) — never assumed on, always explicit. Best-effort: any localStorage failure (private mode, etc.) reads as "not previewing" rather than throwing, same convention as every other localStorage read in this codebase. */
  function isVoicePreviewEnabled() {
    try {
      if (typeof location !== 'undefined' && new RegExp('[?&]' + VOICE_PREVIEW_PARAM + '=1(?:&|$)').test(location.search)) {
        localStorage.setItem(VOICE_PREVIEW_STORAGE_KEY, '1');
        return true;
      }
      return typeof localStorage !== 'undefined' && localStorage.getItem(VOICE_PREVIEW_STORAGE_KEY) === '1';
    } catch (e) {
      return false;
    }
  }

  /** Whether persona's one-time intro clip should play right now — has an asset AND hasn't been shown yet for this dream. Pure/no-DOM — unit tested directly (test/interp-voice-captions.test.js). */
  function shouldShowIntro(persona, introAlreadyShown) {
    return !!(persona && persona.introClipUrl) && !introAlreadyShown;
  }

  /**
   * Splits a reading into sentence-ish chunks and distributes `durationMs`
   * across them proportional to character length — the sentence-level
   * caption fallback (docs/SPEAKING_SAGE_SPEC.md §4) engaged only when
   * interp-audio-status.js's word-level Whisper alignment pass fails or
   * returns nothing usable (`captionsLevel:'sentence'`, empty `captions`).
   * Computed CLIENT-SIDE, once the real audio duration is known (the
   * `<audio>` element's own `loadedmetadata`, not a guessed server-side
   * field — see interp-audio-status.js's own header comment on why Kokoro's
   * response has no confirmed duration field to trust), rather than
   * attempting this server-side. Returns the same `{ word, startMs, endMs }`
   * shape the word-level path already uses (one entry per SENTENCE here,
   * not per word — `word` just holds the sentence text) so the caller's
   * rendering/lookup code (currentCaptionIndex below) is identical either
   * way. Pure/no-DOM — unit tested directly.
   */
  function computeSentenceFallbackCaptions(text, durationMs) {
    var trimmed = (text || '').trim();
    if (!trimmed || !durationMs || durationMs <= 0) return [];
    var sentences = trimmed.match(/[^.!?]+[.!?]*/g) || [trimmed];
    sentences = sentences.map(function (s) { return s.trim(); }).filter(Boolean);
    if (!sentences.length) return [];
    var totalChars = sentences.reduce(function (sum, s) { return sum + s.length; }, 0) || 1;
    var captions = [];
    var elapsedMs = 0;
    sentences.forEach(function (sentence) {
      var shareMs = Math.round((sentence.length / totalChars) * durationMs);
      var startMs = elapsedMs;
      var endMs = Math.min(durationMs, elapsedMs + shareMs);
      captions.push({ word: sentence, startMs: startMs, endMs: endMs });
      elapsedMs = endMs;
    });
    // Last cue always reaches the real end, regardless of any rounding
    // drift accumulated above.
    captions[captions.length - 1].endMs = durationMs;
    return captions;
  }

  /** Index of the caption cue active at `currentMs` (word- or sentence-level — same shape either way), or -1 before the first cue starts. Assumes `captions` is sorted ascending by startMs (true by construction of both producers). Pure/no-DOM — unit tested directly. */
  function currentCaptionIndex(captions, currentMs) {
    if (!captions || !captions.length) return -1;
    var idx = -1;
    for (var i = 0; i < captions.length; i++) {
      if (currentMs >= captions[i].startMs) idx = i; else break;
    }
    return idx;
  }

  /**
   * One rAF tick of the reading-phase dream-video bounce loop ("play
   * forward to the end, then backward to the start, repeat" — Option D's
   * own spec wording — implemented as manual `currentTime` scrubbing in
   * BOTH directions rather than fighting the browser's one-directional
   * native playback clock with a negative `playbackRate`, which isn't
   * reliably supported). Pure math, `deltaSec` supplied by the caller (a
   * real rAF timestamp delta) so this is independently unit-testable
   * without a real `<video>` element or a real animation frame.
   */
  function nextBounceFrame(currentTime, duration, direction, deltaSec) {
    var safeCurrentTime = typeof currentTime === 'number' && !isNaN(currentTime) ? currentTime : 0;
    var safeDirection = direction === -1 ? -1 : 1;
    if (!duration || duration <= 0 || !deltaSec || deltaSec <= 0) return { currentTime: safeCurrentTime, direction: safeDirection };
    var next = safeCurrentTime + safeDirection * deltaSec;
    if (next >= duration) return { currentTime: duration, direction: -1 };
    if (next <= 0) return { currentTime: 0, direction: 1 };
    return { currentTime: next, direction: safeDirection };
  }

  function trackLocal(name, props) {
    if (typeof window !== 'undefined' && window.posthog && typeof window.posthog.capture === 'function') {
      try { posthog.capture(name, props || {}); } catch (e) { /* analytics must never break the app */ }
    }
  }

  function esc(str) {
    var d = document.createElement('div');
    d.textContent = str == null ? '' : String(str);
    return d.innerHTML;
  }

  // The lazy-migration synthetic `classic` key (see js/store.js's
  // ensureInterpretationsMigrated) has NO matching real persona in
  // js/interpreter-personas.js by design (it never appears in the picker
  // — spec §3.0's revisit-without-network path is the only way to reach
  // it). A generic, neutral display fallback so the topbar/reading views
  // still have SOMETHING coherent to render for it, rather than crashing
  // on a null persona lookup.
  var CLASSIC_FALLBACK_PERSONA = {
    key: 'classic', name: 'Your Reflection', inspiredBy: 'an earlier reading',
    tagline: '', asksAbout: '', accent: '#8a8a8a', portrait: '',
    loadingQuestions: 'Reflecting on your dream…', loadingReading: 'Reflecting on your dream…'
  };

  /** Resolves `key` to its real persona data, or the neutral classic-migration fallback above if `key` isn't (or is no longer) a recognized persona. Every render function below reads a persona through this rather than InterpreterPersonas.get() directly. */
  function getPersonaOrFallback(key) {
    return (window.InterpreterPersonas && window.InterpreterPersonas.get(key)) || CLASSIC_FALLBACK_PERSONA;
  }

  // ==========================================================================
  // Voice runtime state — a SEPARATE object from `session` (same spirit:
  // reset on every teardown, referenced by closures that must go stale the
  // moment it's replaced). Only ever non-null while the reading phase's
  // voice stage is actually mounted for a voice-eligible persona (has
  // `voiceId`, see js/interpreter-personas.js). `myGen`/`myDreamId`/
  // `myPersonaKey` are captured at setup time so a late-arriving
  // generateInterpAudio response can detect it's stale (the user closed,
  // switched dreams, or picked a different persona) — same async-
  // staleness-guard convention as `session`'s own `gen` above.
  // ==========================================================================
  var voiceState = null;

  function resetVoiceState() {
    if (voiceState) {
      if (voiceState.rafId) cancelAnimationFrame(voiceState.rafId);
      if (voiceState.audioEl) { try { voiceState.audioEl.pause(); } catch (e) { /* element may already be detached */ } }
      if (voiceState.introEl) { try { voiceState.introEl.pause(); } catch (e) { /* element may already be detached */ } }
    }
    voiceState = null;
  }

  /** Real, tap-satisfying attempt to play a media element with capability detection (spec §6: "attempt playback; if the returned Promise from .play() rejects... fall back to tap-to-play" — never user-agent sniffing). Resolves true on success, false on a detected autoplay block (never rejects — a play() rejection is an expected, handled outcome here, not a bug). */
  function attemptPlay(el) {
    if (!el || typeof el.play !== 'function') return Promise.resolve(false);
    var result = el.play();
    if (!result || typeof result.then !== 'function') return Promise.resolve(true); // older browsers: play() returns undefined, assume success
    return result.then(function () { return true; }, function () { return false; });
  }

  function showTapOverlay(vs) { if (vs.tapOverlay) vs.tapOverlay.classList.remove('off'); }
  function hideTapOverlay(vs) { if (vs.tapOverlay) vs.tapOverlay.classList.add('off'); }

  /** Manual currentTime-scrubbing bounce loop for the reading phase's dream-video backdrop (see nextBounceFrame's own doc comment for why this doesn't use native playback). No-op if the dream has no playable video (image-only dream, or the dream record is missing a videoUrl) — the stage still renders (captions over a plain dark backdrop) rather than blocking the whole voice feature on having a video specifically. */
  function startDreamVideoBounceLoop(vs) {
    var el = vs.dreamEl;
    if (!el || !el.getAttribute('src')) return;
    el.muted = true; // purely a visual loop — the actual reading audio is the separate <audio> element
    var lastTs = null;
    function step(ts) {
      if (voiceState !== vs) return; // torn down / superseded — stop scheduling more frames
      if (lastTs != null && el.duration && !isNaN(el.duration)) {
        var deltaSec = (ts - lastTs) / 1000;
        var next = nextBounceFrame(el.currentTime, el.duration, vs.bounceDirection, deltaSec);
        try { el.currentTime = next.currentTime; } catch (e) { /* seeking before metadata is ready — next frame retries */ }
        vs.bounceDirection = next.direction;
      }
      lastTs = ts;
      vs.rafId = requestAnimationFrame(step);
    }
    vs.rafId = requestAnimationFrame(step);
  }

  /** Renders whichever caption cue is active at `ms` into the stage's caption strip — same "one current line, replacing the previous" overlay treatment already prototyped and founder-reviewed on the Option-D demo pages (sage-demo-x7q4.html), reused here rather than inventing a new multi-word karaoke layout under this build's time budget. Blank between cues (before the first word, or past the last one). */
  function renderVoiceCaption(vs, ms) {
    if (!vs.capEl) return;
    var idx = currentCaptionIndex(vs.captions, ms);
    var text = idx >= 0 ? vs.captions[idx].word : '';
    if (vs.capEl.textContent !== text) vs.capEl.textContent = text;
  }

  /** Kicks off this reading's TTS+captions generation in the background — called immediately when the voice stage mounts, in parallel with the intro clip, so audio is ready (or close to it) by the time a real ~7s intro finishes playing (spec's own reasoning). Soft-fails (spec: "reading falls back to text-only, no audio control shown at all") — a failure here tears down the whole voice stage rather than leaving it half-built with nothing to play. */
  function requestVoiceAudio(vs, persona) {
    var myGen = gen, myDreamId = vs.dreamId, myPersonaKey = vs.personaKey;
    window.DreamStore.generateInterpAudio(vs.dreamId, vs.personaKey, vs.readingText).then(function (result) {
      if (myGen !== gen || voiceState !== vs || session.dreamId !== myDreamId || session.personaKey !== myPersonaKey) return; // stale
      vs.audioUrl = result.audioUrl;
      vs.audioDurationMs = result.audioDurationMs;
      vs.captions = result.captions || [];
      vs.captionsLevel = result.captionsLevel;
      vs.audioReady = true;
      if (vs.captionsLevel === 'sentence') trackLocal('interp_voice_caption_fallback', { persona: persona.key });
      if (vs.phase === 'loading') beginAudioPlayback(vs, persona);
    }).catch(function (err) {
      if (myGen !== gen || voiceState !== vs || session.dreamId !== myDreamId || session.personaKey !== myPersonaKey) return; // stale
      trackLocal('interp_voice_tts_failed', { persona: persona.key, error_code: (err && err.message) || 'unknown' });
      vs.audioFailed = true;
      if (vs.phase === 'loading') teardownVoiceStageOnFailure(vs);
    });
  }

  /** A hard TTS failure after the intro already finished — nothing to play, so the whole voice stage is hidden and this reading falls back to exactly Wave 1's plain text-only card (already rendered underneath it — see renderReading). */
  function teardownVoiceStageOnFailure(vs) {
    vs.phase = 'failed';
    if (vs.stageEl) vs.stageEl.style.display = 'none';
  }

  /** Intro phase (spec §5) — plays the persona's one-time lip-synced greeting, tap-to-play fallback on a detected autoplay block (spec §6), advances to the reading phase on natural end OR an explicit Skip tap. */
  function startIntroPhase(vs, persona) {
    vs.phase = 'intro';
    if (vs.skipEl) vs.skipEl.style.display = '';
    var introEl = vs.introEl;
    if (!introEl) { completeIntro(vs, persona, 'ended'); return; } // defensive — shouldn't happen, renderReading only renders the skip/intro markup when introClipUrl is set
    attemptPlay(introEl).then(function (ok) {
      if (voiceState !== vs) return;
      if (ok) {
        trackLocal('interp_voice_intro_shown', { persona: persona.key });
      } else {
        trackLocal('interp_voice_autoplay_blocked', { persona: persona.key, surface: 'intro' });
        showTapOverlay(vs);
      }
    });
    introEl.addEventListener('ended', function () {
      if (voiceState !== vs) return;
      completeIntro(vs, persona, 'ended');
    });
    if (vs.tapOverlay) {
      vs.tapOverlay.addEventListener('click', function onIntroTap() {
        if (voiceState !== vs || vs.phase !== 'intro') return;
        attemptPlay(introEl).then(function (ok) {
          if (voiceState !== vs || vs.phase !== 'intro') return;
          if (ok) { hideTapOverlay(vs); trackLocal('interp_voice_intro_shown', { persona: persona.key }); }
        });
      });
    }
    if (vs.skipEl) {
      vs.skipEl.addEventListener('click', function () {
        if (voiceState !== vs || vs.phase !== 'intro') return;
        completeIntro(vs, persona, 'skip_link');
      });
    }
  }

  function completeIntro(vs, persona, via) {
    if (via === 'ended') trackLocal('interp_voice_intro_completed', { persona: persona.key });
    else trackLocal('interp_voice_intro_skipped', { persona: persona.key, via: via });
    window.DreamStore.markIntroShown(vs.dreamId, vs.personaKey);
    hideTapOverlay(vs);
    if (vs.skipEl) vs.skipEl.style.display = 'none';
    if (vs.introEl) vs.introEl.classList.add('itp-voice-fade-out');
    if (vs.dreamEl) vs.dreamEl.classList.remove('itp-voice-hidden'); // crossfades IN as the intro crossfades out (spec §5: "genuinely lip-synced video... then crossfades back", adapted to Option D's "into the user's own dream video" target)
    enterReadingPhase(vs, persona);
  }

  /** Reading phase (Option D §2) — starts the dream-video bounce loop immediately (so its crossfade-in lines up with the intro's crossfade-out, or fires immediately for a persona with no intro), and begins real audio playback the moment TTS/captions are ready (immediately, if they already finished generating during the intro). */
  function enterReadingPhase(vs, persona) {
    vs.phase = 'loading';
    startDreamVideoBounceLoop(vs);
    if (vs.audioReady) beginAudioPlayback(vs, persona);
    else if (vs.audioFailed) teardownVoiceStageOnFailure(vs);
    // else: requestVoiceAudio's own .then/.catch (already in flight) picks
    // this up the moment it resolves — see their own `phase === 'loading'` checks.
  }

  function beginAudioPlayback(vs, persona) {
    vs.phase = 'reading';
    var audio = new Audio(vs.audioUrl);
    vs.audioEl = audio;
    audio.addEventListener('loadedmetadata', function () {
      if (voiceState !== vs) return;
      // Authoritative duration (spec's own "probe the real asset" rule) —
      // fills in the sentence-fallback schedule now that it's knowable,
      // and supersedes the server's best-effort estimate for analytics.
      if (audio.duration && !isNaN(audio.duration) && isFinite(audio.duration)) {
        vs.audioDurationMs = Math.round(audio.duration * 1000);
        if (vs.captionsLevel === 'sentence' && !vs.captions.length) {
          vs.captions = computeSentenceFallbackCaptions(vs.readingText, vs.audioDurationMs);
        }
      }
    });
    audio.addEventListener('timeupdate', function () {
      if (voiceState !== vs) return;
      renderVoiceCaption(vs, audio.currentTime * 1000);
    });
    audio.addEventListener('ended', function () {
      if (voiceState !== vs) return;
      if (vs.listenStartedAt) { vs.totalListenedMs += Date.now() - vs.listenStartedAt; vs.listenStartedAt = null; }
      vs.hasCompletedOnce = true;
      renderVoiceCaption(vs, 0);
      trackLocal('interp_voice_complete', { persona: persona.key, duration_ms: vs.audioDurationMs || Math.round(audio.duration * 1000) || null });
      showTapOverlay(vs); // reused as the "replay" affordance post-completion
    });
    attemptPlay(audio).then(function (ok) {
      if (voiceState !== vs) return;
      if (ok) {
        vs.listenStartedAt = Date.now();
        trackLocal('interp_voice_play', { persona: persona.key, source: 'auto' });
      } else {
        trackLocal('interp_voice_autoplay_blocked', { persona: persona.key, surface: 'reading' });
        showTapOverlay(vs);
      }
    });
    if (vs.tapOverlay) {
      vs.tapOverlay.addEventListener('click', function onReadingTap() {
        if (voiceState !== vs || vs.phase !== 'reading') return;
        if (vs.hasCompletedOnce) {
          audio.currentTime = 0;
          vs.hasCompletedOnce = false;
          attemptPlay(audio).then(function (ok) {
            if (voiceState !== vs) return;
            if (ok) { vs.listenStartedAt = Date.now(); hideTapOverlay(vs); trackLocal('interp_voice_replay', { persona: persona.key }); }
          });
          return;
        }
        if (audio.paused) {
          attemptPlay(audio).then(function (ok) {
            if (voiceState !== vs) return;
            if (ok) {
              vs.listenStartedAt = Date.now();
              hideTapOverlay(vs);
              trackLocal('interp_voice_play', { persona: persona.key, source: 'tap_unlock' });
            }
          });
        } else {
          audio.pause();
          if (vs.listenStartedAt) { vs.totalListenedMs += Date.now() - vs.listenStartedAt; vs.listenStartedAt = null; }
          trackLocal('interp_voice_paused', { persona: persona.key, position_ms: Math.round(audio.currentTime * 1000) });
          showTapOverlay(vs);
        }
      });
    }
  }

  /**
   * Mounts the voice stage for the CURRENT reading (called from
   * renderReading below only when the active persona has a `voiceId` and
   * the founder-preview gate is on). Kicks off audio generation
   * immediately (in parallel with the intro, if there is one) and starts
   * whichever phase applies — intro-first (persona has an unshown
   * introClipUrl) or straight to the reading phase.
   */
  function setupVoiceStage(persona) {
    resetVoiceState();
    var vs = {
      dreamId: session.dreamId, personaKey: session.personaKey, readingText: session.readingText,
      stageEl: document.getElementById('itp-voice-stage'),
      introEl: document.getElementById('itp-voice-intro'),
      dreamEl: document.getElementById('itp-voice-dream-video'),
      capEl: document.getElementById('itp-voice-caption'),
      tapOverlay: document.getElementById('itp-voice-tap-overlay'),
      skipEl: document.getElementById('itp-voice-skip'),
      phase: 'intro', bounceDirection: 1, rafId: null,
      audioEl: null, audioUrl: null, audioReady: false, audioFailed: false,
      captions: [], captionsLevel: 'word', audioDurationMs: null,
      listenStartedAt: null, totalListenedMs: 0, hasCompletedOnce: false
    };
    voiceState = vs;

    requestVoiceAudio(vs, persona);

    var introAlreadyShown = window.DreamStore.hasIntroShown(vs.dreamId, vs.personaKey);
    if (shouldShowIntro(persona, introAlreadyShown)) {
      startIntroPhase(vs, persona);
    } else {
      enterReadingPhase(vs, persona);
    }
  }

  function ensureMounted() {
    if (document.getElementById(ROOT_ID)) return;
    var host = document.getElementById('app') || document.body;
    var root = document.createElement('div');
    root.id = ROOT_ID;
    root.className = 'itp-overlay';
    root.innerHTML =
      '<div class="itp-topbar" id="itp-topbar"></div>' +
      '<div class="itp-dream-strip" id="itp-dream-strip"></div>' +
      '<div class="itp-body" id="itp-body"></div>';
    host.appendChild(root);
  }

  // ==========================================================================
  // Dream-picker strip (tracker item for-product-chamber-dream-linkage-is-
  // unc-00s2dr, founder verdict 2026-07-31 evening, overriding both
  // directions docs/CHAMBER_DREAM_LINKAGE_SPEC.md had proposed): "the
  // Chamber's dream picker is the EXACT same videos-preview area as the
  // homepage's My-dreams row - the horizontal thumbnail swipe strip -
  // shown at the top of the Chamber; user slides and taps a dream, the
  // reading targets it." Reuses js/dream-cards.js's shared
  // dreamRowTileHTML verbatim (same tile look/markup as home.html's own
  // My Dreams row), present above .itp-body in every phase.
  //
  // "Completed" uses the exact same `d.videoUrl || d.imageUrl` definition
  // home.html's own renderChamberHero() computes its `completedDream`
  // with — not a new definition. DreamStore.getMyDreams() is already
  // most-recent-first (dreams are unshifted on create), so "current/last
  // dream preselected" falls out of that ordering for the common path
  // (home.html's Chamber card always opens the latest completed dream)
  // with no extra sort needed here.
  //
  // Edge case beyond the founder's literal instruction: open()'s own
  // contract (see its doc comment below) only requires story/caption
  // text, not a finished video/image — result.html's own hero button
  // isn't gated on completion either. So the dream the Chamber was
  // opened for is not strictly guaranteed to be in the "completed" list.
  // Rather than silently failing to preselect/ring a tile for it (a
  // worse regression than the ambiguity this whole feature exists to
  // fix), that dream is stitched to the front of the list even when not
  // yet "completed" — defensive fallback only; neither of this app's two
  // real entry points (home.html's Chamber card, result.html's hero)
  // ever reach the Chamber for an incomplete dream today.
  //
  // Rendered once per open()/switch (called from open() itself) —
  // deliberately NOT wired into the phase-dispatch render() below, which
  // reruns on every question/answer step; rebuilding this strip's markup
  // that often would restart every thumbnail's video decode and reset
  // scroll position for no reason.
  function renderDreamStrip() {
    var strip = document.getElementById('itp-dream-strip');
    if (!session || !window.DreamStore || !window.DreamCards) { strip.innerHTML = ''; strip.style.display = 'none'; return; }
    var selectedId = session.dreamId;
    var dreams = window.DreamStore.getMyDreams().filter(function (d) { return d.videoUrl || d.imageUrl; });
    var hasSelected = dreams.some(function (d) { return d.id === selectedId; });
    if (!hasSelected) {
      var selectedDream = window.DreamStore.getDream(selectedId);
      if (selectedDream) dreams = [selectedDream].concat(dreams);
    }
    if (!dreams.length) { strip.innerHTML = ''; strip.style.display = 'none'; return; }
    strip.style.display = 'flex';
    strip.innerHTML = dreams.map(function (d) {
      return window.DreamCards.dreamRowTileHTML(d, {
        gradient: window.DreamStore.gradientFor(d),
        selected: d.id === selectedId,
        asButton: true
      });
    }).join('');
    Array.prototype.forEach.call(strip.querySelectorAll('.dream-row-tile'), function (tile) {
      tile.addEventListener('click', function () { switchDream(tile.getAttribute('data-dream-id')); });
    });
    window.DreamCards.observeVideos();
    var selectedTile = strip.querySelector('.dream-row-tile.is-selected');
    if (selectedTile && typeof selectedTile.scrollIntoView === 'function') {
      selectedTile.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  /**
   * Tapping a different tile in the strip switches the Chamber's active
   * dream. Per the founder's own instruction ("the reading targets it")
   * and this codebase's "no second, parallel code path" discipline: this
   * re-runs open() for the new dream — the exact same function every
   * other entry point uses — rather than mutating `session` in place, so
   * switching gets open()'s full, already-correct behavior for free
   * (existing-reading revisit vs. fresh picker, dream validation, gen
   * bump for async staleness, analytics) instead of a second
   * reimplementation of that logic. A tap on the already-selected tile is
   * a no-op — it must never discard in-progress questions/answers for
   * the dream that's already open.
   */
  function switchDream(newDreamId) {
    if (!session || !newDreamId || newDreamId === session.dreamId) return;
    trackLocal('interp_dream_switched', { from_dream_id: session.dreamId, to_dream_id: newDreamId });
    open(newDreamId);
  }

  /**
   * Real portrait <img> (spec §12: not shipped this branch — see
   * js/interpreter-personas.js's own header) with the documented accent-
   * gradient + initial fallback underneath.
   *
   * Review finding (round 2): css/styles.css's `.itp-portrait img` has no
   * `position` set (defaults to static) while `.itp-portrait-fallback` is
   * `position:absolute`. Per CSS painting order, a positioned element
   * always paints ABOVE an in-flow static sibling regardless of DOM order
   * — so the fallback (an opaque accent-gradient) would permanently cover
   * the <img> even once real portrait assets ship and load successfully.
   * This was invisible on this branch only because the img always 404s
   * (no portrait files exist yet), so "always show the fallback" looked
   * correct by accident. Fixed with an explicit `onload` that hides the
   * fallback sibling the moment the image genuinely loads — same
   * "onerror hides itself" idea already used for the failure case, just
   * the success-case mirror of it — rather than a CSS stacking fix, so
   * this function's own "real image wins once it loads" contract doesn't
   * depend on css/styles.css's positioning rules staying exactly as they
   * are today. The initial is the persona's KEY's first letter (stable
   * across a display-name rename — see interpreter-personas.js's own
   * header on why display names are still proposals).
   */
  function portraitHtml(persona) {
    var initial = (persona.key || '?').charAt(0).toUpperCase();
    return '<div class="itp-portrait">' +
      '<img src="' + esc(persona.portrait) + '" alt="" onerror="this.style.display=\'none\';" onload="this.nextElementSibling.style.display=\'none\';">' +
      '<div class="itp-portrait-fallback" style="background:linear-gradient(155deg,' + esc(persona.accent) + ',rgba(10,10,10,.85))">' + esc(initial) + '</div>' +
      '</div>';
  }

  // ==========================================================================
  // Topbar — back (all phases but picker) + persistent persona header (the
  // future avatar/voice slot, spec §9) + close, always present.
  // ==========================================================================
  function renderTopbar() {
    var topbar = document.getElementById('itp-topbar');
    if (!session) { topbar.innerHTML = ''; return; }
    var persona = session.personaKey ? getPersonaOrFallback(session.personaKey) : null;
    var html = '';
    if (session.phase !== 'picker') {
      html += '<div class="itp-topbar-btn" id="itp-back-btn"><span class="icon">' + Icons.back + '</span></div>';
    }
    if (persona) {
      html += '<div class="itp-topbar-persona">' + portraitHtml(persona) +
        '<div style="min-width:0;">' +
        '<div class="itp-topbar-persona-name">' + esc(persona.name) + '</div>' +
        '<div class="itp-topbar-persona-sub">' + esc(persona.inspiredBy) + '</div>' +
        '</div></div>';
    } else {
      html += '<div style="flex:1;"></div>';
    }
    html += '<div class="itp-topbar-btn" id="itp-close-btn"><span class="icon">' + Icons.close + '</span></div>';
    topbar.innerHTML = html;
    var backBtn = document.getElementById('itp-back-btn');
    if (backBtn) backBtn.addEventListener('click', onBackTap);
    document.getElementById('itp-close-btn').addEventListener('click', function () { close(); });
  }

  function onBackTap() {
    if (!session) return;
    // Back always returns to the picker, discarding whatever in-progress
    // answers/questions the current persona's flow had (spec §3.3's own
    // "answers for that persona discarded" contract) — same target
    // regardless of which non-picker phase back was tapped from.
    goToPicker();
  }

  // ==========================================================================
  // Picker phase (spec §3.1) — swipeable persona carousel, single tap
  // advances (an already-read persona jumps straight to its saved reading,
  // no network; a fresh persona starts the questions flow).
  // ==========================================================================
  function renderPicker() {
    var body = document.getElementById('itp-body');
    var existing = window.DreamStore.getInterpretations(session.dreamId) || {};
    var personas = window.InterpreterPersonas.ALL;

    var cardsHtml = personas.map(function (p) {
      var isRead = !!(existing[p.key] && existing[p.key].text);
      var initial = (p.key || '?').charAt(0).toUpperCase();
      return '<div class="itp-persona-card' + (isRead ? ' read' : '') + '" data-key="' + esc(p.key) + '" style="background:linear-gradient(155deg,' + esc(p.accent) + ',rgba(10,10,10,.9));">' +
        '<div class="itp-persona-card-badge"><span class="icon">' + Icons.check + '</span></div>' +
        '<div class="itp-persona-card-fallback">' + esc(initial) + '</div>' +
        '<div class="itp-persona-card-bg" style="background-image:url(\'' + esc(p.portrait) + '\');"></div>' +
        '<div class="itp-persona-card-scrim"></div>' +
        '<div class="itp-persona-card-content">' +
        '<div class="itp-persona-card-name">' + esc(p.name) + '</div>' +
        '<div class="itp-persona-card-inspired">' + esc(p.inspiredBy) + '</div>' +
        '<div class="itp-persona-card-tagline">' + esc(p.tagline) + '<br>Asks about: ' + esc(p.asksAbout) + '</div>' +
        '</div></div>';
    }).join('');

    var dotsHtml = personas.map(function (p, i) {
      return '<div class="itp-carousel-dot' + (i === 0 ? ' active' : '') + '" data-index="' + i + '"></div>';
    }).join('');

    body.innerHTML =
      '<div class="itp-picker-title">Who should read this dream?</div>' +
      '<div class="itp-picker-sub">Pick a method — you can always come back for another take.</div>' +
      '<div class="itp-carousel" id="itp-carousel">' + cardsHtml + '</div>' +
      '<div class="itp-carousel-dots">' + dotsHtml + '</div>' +
      '<div class="itp-picker-footer">AI characters inspired by real methods — for reflection, not advice.</div>';

    var carousel = document.getElementById('itp-carousel');
    var cards = carousel.querySelectorAll('.itp-persona-card');
    cards.forEach(function (card) {
      card.addEventListener('click', function () {
        var key = card.getAttribute('data-key');
        onPersonaPicked(key, existing);
      });
    });

    // Lightweight "which card is centered" tracker for the dot row —
    // presentation only, never gates the tap-to-select behavior above.
    var dots = carousel.parentNode.querySelectorAll('.itp-carousel-dot');
    carousel.addEventListener('scroll', function () {
      var center = carousel.scrollLeft + carousel.clientWidth / 2;
      var closestIdx = 0, closestDist = Infinity;
      cards.forEach(function (card, i) {
        var mid = card.offsetLeft + card.offsetWidth / 2;
        var dist = Math.abs(mid - center);
        if (dist < closestDist) { closestDist = dist; closestIdx = i; }
      });
      dots.forEach(function (dot, i) { dot.classList.toggle('active', i === closestIdx); });
    });
  }

  function onPersonaPicked(personaKey, existingMap) {
    var existing = existingMap || window.DreamStore.getInterpretations(session.dreamId) || {};
    trackLocal('interp_persona_selected', { persona: personaKey });
    session.personaKey = personaKey;
    var entry = existing[personaKey];
    if (entry && entry.text) {
      // Already read this persona on this dream — revisit, no network
      // (spec §3.1: "tapping one reopens its saved reading").
      session.qa = entry.qa || [];
      goToReading(entry.text, entry.at, false);
      return;
    }
    session.qa = [];
    goToQuestionsLoading();
  }

  // ==========================================================================
  // q_loading phase (spec §3.2)
  // ==========================================================================
  function goToQuestionsLoading() {
    session.phase = 'q_loading';
    render();
    var persona = getPersonaOrFallback(session.personaKey);
    var myGen = gen;
    var myDreamId = session.dreamId;
    window.DreamStore.requestInterpretationQuestions(session.dreamId, session.personaKey).then(function (data) {
      if (myGen !== gen || !session || session.dreamId !== myDreamId) return; // stale — a different session is open now
      var questions = data && Array.isArray(data.questions) ? data.questions : [];
      if (!questions.length) {
        // Treated the same as any other q_loading failure — never a gate
        // (spec §3.2's hard rule).
        trackLocal('interp_questions_failed', { persona: session.personaKey });
        goToReadingLoading();
        return;
      }
      trackLocal('interp_questions_shown', { persona: session.personaKey, count: questions.length });
      session.questions = questions;
      session.questionIndex = 0;
      session.transcript = [];
      session.phase = 'questions';
      render();
    }).catch(function (err) {
      if (myGen !== gen || !session || session.dreamId !== myDreamId) return;
      var isRateLimited = !!(err && /E406/.test(err.message || ''));
      if (isRateLimited) {
        showErrorState({ rateLimited: true });
        return;
      }
      // Every other failure (network, 5xx, invalid/unparseable JSON) skips
      // silently straight to a direct reading — questions are never a
      // gate (spec §3.2).
      trackLocal('interp_questions_failed', { persona: persona ? persona.key : session.personaKey });
      goToReadingLoading();
    });
  }

  // ==========================================================================
  // questions phase (spec §3.3) — one-at-a-time chat transcript stepper.
  // ==========================================================================
  function currentQuestion() {
    if (!session || !session.questions) return null;
    return session.questions[session.questionIndex] || null;
  }

  function renderQuestions() {
    var persona = getPersonaOrFallback(session.personaKey);
    var body = document.getElementById('itp-body');
    var q = currentQuestion();
    var total = session.questions.length;

    var dotsHtml = session.questions.map(function (_, i) {
      var cls = i < session.questionIndex ? 'done' : (i === session.questionIndex ? 'current' : '');
      return '<div class="itp-progress-dot ' + cls + '"></div>';
    }).join('');

    var transcriptHtml = session.transcript.map(function (turn) {
      if (turn.role === 'persona') {
        return '<div class="itp-bubble-row"><div class="itp-bubble persona">' + esc(turn.text) + '</div></div>';
      }
      return '<div class="itp-bubble-row mine"><div class="itp-bubble mine">' + esc(turn.text) + '</div></div>';
    }).join('');

    // Founder walkthrough punch list (2026-08-01, tracker item
    // for-product-founder-walkthrough-punch-li-t33k3y, item 7): the
    // free-text field (rendered by renderComposer into
    // #itp-inline-composer just below) now sits INLINE, right after the
    // question/chips and BEFORE "Skip this question" -- it used to be a
    // separate docked bar UNDER all of this content (so it always ended
    // up visually below Skip, never above it, regardless of DOM order
    // inside .itp-body). See css/styles.css's own .itp-inline-composer
    // comment for the visual-weight side of this same fix.
    var currentQuestionHtml = q
      ? '<div class="itp-bubble-row"><div class="itp-bubble persona">' + esc(q.text) + '</div></div>' +
        (q.chips && q.chips.length
          ? '<div class="itp-chip-row" id="itp-chip-row">' + q.chips.map(function (c) {
              return '<div class="itp-chip" data-chip="' + esc(c) + '">' + esc(c) + '</div>';
            }).join('') + '</div>'
          : '') +
        '<div class="itp-inline-composer" id="itp-inline-composer"></div>' +
        '<div class="itp-skip-row"><span class="link-text" id="itp-skip-link">Skip this question</span></div>'
      : '';

    body.innerHTML =
      '<div class="itp-progress-dots">' + dotsHtml + '</div>' +
      '<div class="itp-transcript" id="itp-transcript">' + transcriptHtml + currentQuestionHtml + '</div>' +
      '<div class="itp-skip-row"><span class="itp-escape-link" id="itp-just-interpret-link" style="color:' + esc(persona.accent) + '">Just interpret it →</span></div>';

    var transcriptEl = document.getElementById('itp-transcript');
    transcriptEl.scrollTop = transcriptEl.scrollHeight;

    if (q && q.chips && q.chips.length) {
      body.querySelectorAll('#itp-chip-row .itp-chip').forEach(function (chip) {
        chip.addEventListener('click', function () {
          answerCurrentQuestion(chip.getAttribute('data-chip'), 'chip');
        });
      });
    }
    var skipLink = document.getElementById('itp-skip-link');
    if (skipLink) skipLink.addEventListener('click', function () { answerCurrentQuestion(null, 'skip'); });
    document.getElementById('itp-just-interpret-link').addEventListener('click', function () {
      trackLocal('interp_skipped_to_reading', { persona: session.personaKey, answered: session.qa.length });
      goToReadingLoading();
    });

    renderComposer();
  }

  /** Renders the free-text field/send button into #itp-inline-composer (part of .itp-body's own content now, see renderQuestions' own doc comment above) -- a no-op if that slot doesn't exist (q was falsy, defensive only, shouldn't happen while phase is 'questions'). IDs (#itp-composer-field/#itp-composer-send) are unchanged from before this relocation -- existing tests target them directly. */
  function renderComposer() {
    var composer = document.getElementById('itp-inline-composer');
    if (!composer) return;
    composer.innerHTML =
      '<input class="itp-composer-field" id="itp-composer-field" type="text" maxlength="' + FREE_TEXT_MAXLENGTH + '" dir="auto" placeholder="Type your answer…">' +
      '<button type="button" class="itp-composer-send" id="itp-composer-send" disabled><span class="icon">' + Icons.chevronDown + '</span></button>';
    var field = document.getElementById('itp-composer-field');
    var send = document.getElementById('itp-composer-send');
    function syncSendState() { send.disabled = !field.value.trim(); }
    field.addEventListener('input', syncSendState);
    field.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && field.value.trim()) { e.preventDefault(); submitFreeText(); }
    });
    send.addEventListener('click', submitFreeText);
    function submitFreeText() {
      var text = field.value.trim();
      if (!text) return;
      answerCurrentQuestion(text, 'text');
    }
  }

  function answerCurrentQuestion(answerText, via) {
    var q = currentQuestion();
    if (!q || !session) return;
    trackLocal('interp_question_answered', { persona: session.personaKey, index: session.questionIndex, via: via });
    session.transcript.push({ role: 'persona', text: q.text });
    if (via === 'skip') {
      session.transcript.push({ role: 'mine', text: 'Skipped' });
      // Skipped answers are omitted from qa entirely (spec §5: "answers
      // given (skipped ones omitted)").
    } else {
      session.transcript.push({ role: 'mine', text: answerText });
      session.qa.push({ q: q.text, a: answerText });
    }
    session.questionIndex += 1;
    if (session.questionIndex >= session.questions.length) {
      goToReadingLoading();
      return;
    }
    renderQuestions();
  }

  // ==========================================================================
  // r_loading phase (spec §3.4)
  // ==========================================================================
  function goToReadingLoading(opts) {
    opts = opts || {};
    session.phase = 'r_loading';
    session.regenerated = !!opts.regenerated;
    render();
    var myGen = gen;
    var myDreamId = session.dreamId;
    var personaKey = session.personaKey;
    var qa = session.qa || [];
    window.DreamStore.generateInterpretationReading(session.dreamId, personaKey, qa).then(function (data) {
      if (myGen !== gen || !session || session.dreamId !== myDreamId) return;
      goToReading(data.text, data.at, session.regenerated);
    }).catch(function (err) {
      if (myGen !== gen || !session || session.dreamId !== myDreamId) return;
      var isRateLimited = !!(err && /E406/.test(err.message || ''));
      trackLocal('interp_reading_failed', { persona: personaKey, rate_limited: isRateLimited });
      showErrorState({ rateLimited: isRateLimited, retry: !isRateLimited ? function () { goToReadingLoading(opts); } : null });
    });
  }

  // ==========================================================================
  // reading phase (spec §3.5)
  // ==========================================================================
  function goToReading(text, at, regenerated) {
    session.phase = 'reading';
    session.readingText = text;
    session.readingAt = at;
    trackLocal('interp_reading_shown', { persona: session.personaKey, answered: (session.qa || []).length, regenerated: !!regenerated });
    render();
  }

  /**
   * Speaking Sage Option D voice stage markup — mounted ABOVE the plain
   * text `.itp-reading-card` (unchanged from Wave 1, still rendered
   * underneath, still the only thing a non-voice persona or a preview-gate-
   * off browser ever sees — same "tolerate a missing capability, never
   * block" convention as the portrait fallback). Only rendered when the
   * founder-preview gate is on AND the active persona has a `voiceId`
   * (currently: talmudic/The Sage only — js/interpreter-personas.js).
   *
   * The intro `<video>` (`#itp-voice-intro`) is only present in the markup
   * at all when `showIntro` is true — i.e. the persona actually has an
   * `introClipUrl` AND it hasn't already played for this dream
   * (shouldShowIntro) — NOT merely whenever the persona has an intro asset
   * at all. This matters for the "reopen an already-read persona" case
   * (spec §5): if the element were unconditionally present whenever
   * `introClipUrl` is set, the intro's `<video>` would sit in the DOM
   * (unused, never played) even on a revisit that should show nothing but
   * the reading — the markup itself has to reflect the same "already
   * shown" decision setupVoiceStage's own runtime logic makes, not just
   * skip PLAYING it while still rendering it.
   */
  function voiceStageHtml(persona, dreamMediaUrl, showIntro) {
    return '<div class="itp-voice-stage" id="itp-voice-stage">' +
      '<video class="itp-voice-media' + (showIntro ? ' itp-voice-hidden' : '') + '" id="itp-voice-dream-video" playsinline preload="auto"' +
      (dreamMediaUrl ? ' src="' + esc(dreamMediaUrl) + '"' : '') + '></video>' +
      (showIntro
        ? '<video class="itp-voice-media itp-voice-intro" id="itp-voice-intro" playsinline preload="auto" src="' + esc(persona.introClipUrl) + '"></video>'
        : '') +
      '<div class="itp-voice-caption" id="itp-voice-caption"></div>' +
      '<div class="itp-voice-tap-overlay off" id="itp-voice-tap-overlay"><div class="itp-voice-tap-btn"><span class="icon">' + Icons.play + '</span></div></div>' +
      '<div class="itp-voice-skip link-text" id="itp-voice-skip" style="display:none">Skip</div>' +
      '</div>';
  }

  function renderReading() {
    var persona = getPersonaOrFallback(session.personaKey);
    var body = document.getElementById('itp-body');
    var voiceEligible = isVoicePreviewEnabled() && !!persona.voiceId;
    var dream = voiceEligible ? window.DreamStore.getDream(session.dreamId) : null;
    var dreamMediaUrl = dream ? (dream.videoUrl || dream.imageUrl || null) : null;
    var showIntro = voiceEligible && shouldShowIntro(persona, window.DreamStore.hasIntroShown(session.dreamId, session.personaKey));

    body.innerHTML =
      (voiceEligible ? voiceStageHtml(persona, dreamMediaUrl, showIntro) : '') +
      '<div class="itp-reading-card" id="itp-reading-card" style="border-left-color:' + esc(persona.accent) + '">' +
      '<div class="itp-reading-persona-line">' + portraitHtml(persona) +
      '<div class="itp-reading-persona-name">' + esc(persona.name) + ' — ' + esc(persona.inspiredBy) + '</div></div>' +
      '<div class="interp-text" id="itp-reading-text" dir="auto">' + esc(session.readingText) + '</div>' +
      '<div class="auth-trust"><span class="icon">' + Icons.lock + '</span>' +
      '<span>Private to you. Never shown on Explore or shared — even when this dream is public.</span></div>' +
      '<div class="interp-disclosure">For reflection and entertainment — not medical or mental-health advice.</div>' +
      '</div>' +
      '<div class="itp-reading-actions">' +
      '<span class="link-text" id="itp-another-take-link"><b>Another take</b></span>' +
      '<span class="link-text" id="itp-regenerate-link">Regenerate</span>' +
      '<span class="link-text" id="itp-close-link">Close</span>' +
      '</div>';
    document.getElementById('itp-another-take-link').addEventListener('click', function () {
      trackLocal('interp_another_take', { from_persona: session.personaKey });
      goToPicker();
    });
    document.getElementById('itp-regenerate-link').addEventListener('click', function () {
      goToReadingLoading({ regenerated: true });
    });
    document.getElementById('itp-close-link').addEventListener('click', function () { close(); });

    if (voiceEligible) setupVoiceStage(persona); else resetVoiceState();
  }

  function goToPicker() {
    resetVoiceState();
    session.phase = 'picker';
    session.personaKey = null;
    session.questions = null;
    session.questionIndex = 0;
    session.transcript = [];
    session.qa = [];
    render();
  }

  // ==========================================================================
  // Error / fallback states (spec §3.5) — persona-neutral copy either way.
  // opts.rateLimited: true -> the 429 friendly-limit copy, Close only.
  // opts.retry: function|null -> a normal failure shows Retry + Close.
  // ==========================================================================
  function showErrorState(opts) {
    opts = opts || {};
    session.phase = 'error';
    session.errorOpts = opts;
    render();
  }

  function renderError() {
    var body = document.getElementById('itp-body');
    var opts = session.errorOpts || {};
    var copy = opts.rateLimited
      ? 'You\'ve reached today\'s reflection limit on this network — try again tomorrow.'
      : 'Couldn\'t put this into words right now.';
    var html = '<div class="itp-error-copy">' + esc(copy) + '</div>';
    if (opts.retry) html += '<button type="button" class="btn btn-primary btn-block" id="itp-retry-btn">Retry</button>';
    html += '<div style="height:10px;"></div><div class="itp-reading-actions"><span class="link-text" id="itp-error-close-link">Close</span></div>';
    body.innerHTML = html;
    var retryBtn = document.getElementById('itp-retry-btn');
    if (retryBtn) retryBtn.addEventListener('click', opts.retry);
    document.getElementById('itp-error-close-link').addEventListener('click', function () { close(); });
  }

  // ==========================================================================
  // Loading views (q_loading / r_loading) — persona-flavored line + spinner,
  // reusing the app-wide .spinner-inline pattern.
  // ==========================================================================
  function renderLoading() {
    var persona = getPersonaOrFallback(session.personaKey);
    var body = document.getElementById('itp-body');
    var line = session.phase === 'q_loading' ? persona.loadingQuestions : persona.loadingReading;
    body.innerHTML =
      '<div class="itp-loading-wrap">' + portraitHtml(persona) +
      '<div class="itp-loading-line"><span class="spinner-inline"></span><span>' + esc(line) + '</span></div>' +
      '</div>';
  }

  // ==========================================================================
  // Top-level render dispatch
  // ==========================================================================
  function render() {
    if (!session) return;
    renderTopbar();
    if (session.phase === 'picker') renderPicker();
    else if (session.phase === 'q_loading' || session.phase === 'r_loading') renderLoading();
    else if (session.phase === 'questions') renderQuestions();
    else if (session.phase === 'reading') renderReading();
    else if (session.phase === 'error') renderError();
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Opens the interpretation experience for `dreamId`. Reads the dream via
   * DreamStore.getDream (ownership/ existence is enforced by every
   * DreamStore method this file calls, same as every other private,
   * per-account surface in this app). Defensive per spec §3.5: a dream
   * with no usable text (storyText/caption both empty — shouldn't occur)
   * never opens the overlay at all, just shows a toast if the host page
   * exposes one (every host page's own `showToast`, read off `window`
   * since a classic-script top-level function declaration is a `window`
   * property — see js/purchase-sheet.js's header for the equivalent
   * per-host-page convention this file follows elsewhere).
   */
  function open(dreamId) {
    var dream = window.DreamStore.getDream(dreamId);
    var captionText = dream && (dream.storyText || dream.caption);
    if (!dream || !captionText) {
      if (typeof window.showToast === 'function') window.showToast('Couldn\'t open this dream\'s reflection right now.');
      return;
    }

    ensureMounted();
    gen += 1;
    var existing = window.DreamStore.getInterpretations(dreamId) || {};
    var existingKeys = Object.keys(existing).filter(function (k) { return existing[k] && existing[k].text; });
    // Most-recent-first among saved readings — the revisit case opens
    // straight on whichever persona's reading is newest (spec §3.0).
    existingKeys.sort(function (a, b) { return (existing[b].at || 0) - (existing[a].at || 0); });
    var hasExisting = existingKeys.length > 0;

    session = {
      dreamId: dreamId,
      phase: hasExisting ? 'reading' : 'picker',
      personaKey: hasExisting ? existingKeys[0] : null,
      questions: null,
      questionIndex: 0,
      transcript: [],
      qa: hasExisting ? (existing[existingKeys[0]].qa || []) : [],
      readingText: hasExisting ? existing[existingKeys[0]].text : null,
      readingAt: hasExisting ? existing[existingKeys[0]].at : null,
      openedAt: Date.now()
    };

    trackLocal('interp_surface_opened', { has_existing: hasExisting });

    document.getElementById(ROOT_ID).classList.add('open');
    document.body.style.overflow = 'hidden'; // matches this app's other full-screen overlays' scroll-lock intent
    renderDreamStrip();
    render();
  }

  function close() {
    if (!session) return;
    // Speaking Sage Option D voice-lifecycle events that only make sense at
    // a real close choke point (same reasoning `interp_closed` itself
    // already established) — fired BEFORE resetVoiceState() below clears
    // the state they read from.
    if (voiceState) {
      if (voiceState.phase === 'intro') {
        trackLocal('interp_voice_intro_skipped', { persona: voiceState.personaKey, via: 'closed' });
      }
      if (voiceState.listenStartedAt) {
        voiceState.totalListenedMs += Date.now() - voiceState.listenStartedAt;
        voiceState.listenStartedAt = null;
      }
      if (voiceState.audioEl) {
        trackLocal('interp_voice_listen_time', {
          persona: voiceState.personaKey,
          listened_ms: voiceState.totalListenedMs,
          audio_duration_ms: voiceState.audioDurationMs || null,
          completed: !!voiceState.hasCompletedOnce
        });
      }
    }
    trackLocal('interp_closed', { phase: session.phase });
    var root = document.getElementById(ROOT_ID);
    if (root) root.classList.remove('open');
    document.body.style.overflow = '';
    resetVoiceState();
    session = null;
    gen += 1;
  }

  var InterpretExperience = { open: open, close: close };

  // Speaking Sage Option D's pure (no-DOM) logic, exported purely for
  // test/interp-voice-captions.test.js's direct require()'d unit coverage —
  // same "export an internal for testability" precedent
  // js/purchase-sheet.js / js/wizard-chips.js already established in this
  // codebase (see either file's own header comment). Purely additive:
  // nothing above reads these off the exported object, every real call
  // site uses the closures directly.
  InterpretExperience._shouldShowIntro = shouldShowIntro;
  InterpretExperience._computeSentenceFallbackCaptions = computeSentenceFallbackCaptions;
  InterpretExperience._currentCaptionIndex = currentCaptionIndex;
  InterpretExperience._nextBounceFrame = nextBounceFrame;

  if (typeof window !== 'undefined') window.InterpretExperience = InterpretExperience;
  if (typeof module !== 'undefined' && module.exports) module.exports = InterpretExperience;
})();
