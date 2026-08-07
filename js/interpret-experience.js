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
// with the two calls the spec's §8 self-contained-mounting section
// specifies: `InterpretExperience.open(dreamId)` / `.close()` — plus one
// added later, `.notifyDreamResolved(pendingDreamId, realDreamId)` (see its
// own section below), the host page's way of telling an OPEN session that
// the still-generating dream it was opened for has finished rendering.
// Matches js/purchase-sheet.js's own established precedent for a complex
// shared sheet/overlay component — same singleton-DOM-mounted-once,
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

  /**
   * True when `capturedDreamId` (grabbed by an async call before its own
   * await/then) still names the dream the CURRENT session is about.
   *
   * Exists because of the one legitimate way a live session's `dreamId`
   * can change without the session itself being replaced: a reading opened
   * against a still-generating dream's synthetic `pending:<operationName>`
   * id (js/store.js's findPendingDream) whose video then finishes
   * rendering mid-session — notifyDreamResolved below re-points the
   * session at the real dream id and records the old one as
   * `session.resolvedFrom`. Without this tolerance, the very responses
   * that make the founder's "start the reading while the video renders"
   * flow work (the in-flight TTS request, most of all) would be discarded
   * as stale exactly when the video lands, silently killing the voice.
   *
   * Everything this DOESN'T tolerate is unchanged: a different session
   * (`gen`), a torn-down/replaced voice state (`voiceState !== vs`), a
   * genuinely different dream (switchDream re-runs open(), which builds a
   * brand-new session with no resolvedFrom), or a closed overlay.
   */
  function stillTargetsDream(capturedDreamId) {
    if (!session) return false;
    if (session.dreamId === capturedDreamId) return true;
    return !!session.resolvedFrom && session.resolvedFrom === capturedDreamId;
  }

  // ==========================================================================
  // Speaking Sage — Option D (docs/SPEAKING_SAGE_SPEC.md, tracker item
  // for-product-build-speaking-sage-wave-fou-8uobuh, founder GO on "Option
  // D" 2026-08-02/08-03). One-time lip-synced intro per persona, then a
  // per-reading voice track played over the user's OWN dream video
  // (bounce-looped) with timed captions overlaid — no per-reading lip-sync
  // (explicitly ruled out as too expensive). Voice vendor (2026-08-04,
  // tracker for-product-founder-decision-08-04-switc-cqveik): ElevenLabs
  // Turbo v2.5 (voice `Brian`) primary, with the original Kokoro voice
  // (`am_onyx`, speed 0.9) as a same-behavior fallback tier — see
  // generate-interp-audio.js's header comment for the full chain. This
  // client-side file is unaffected by WHICH vendor produced the audio; it
  // only ever gates on `persona.voiceId` being truthy and consumes the
  // same `{ audioUrl, captions, captionsLevel }` contract either way.
  //
  // ── Speaking Sage is LIVE for everyone (founder "go wide", 2026-08-04) ──
  // The ?sagevoice=1 founder-preview gate that shipped with the feature is
  // deliberately GONE, not just defaulted-on: after a day of the founder's
  // previews dying to per-browser/private-tab flag state, his call was that
  // voice eligibility is purely "does this persona have a voice" — no
  // switch to lose. (The once-per-dream intro memory, hasIntroShown, is
  // unrelated and stays.) Rollback, if ever needed, is a revert of this
  // commit, not a flag.

  /** Whether persona's one-time intro should play right now — has BOTH the visual clip AND its paired voice track (see js/interpreter-personas.js's own header note on why these are two separate files, not one muxed clip) AND hasn't been shown yet for this dream. Pure/no-DOM — unit tested directly (test/interp-voice-captions.test.js). */
  function shouldShowIntro(persona, introAlreadyShown) {
    return !!(persona && persona.introClipUrl && persona.introVoiceUrl) && !introAlreadyShown;
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

  /**
   * Groups word-level caption cues into readable PHRASE cues (founder,
   * 2026-08-07: single-word captions "make it difficult to read — group
   * them into batches of 2-3 or 4-5 words, or sentences up to ~10").
   * Pure/no-DOM. Break rules, in priority order, applied while
   * accumulating consecutive words:
   *   - after a word ending a sentence (. ! ? — with or without a
   *     trailing quote/paren), always;
   *   - after a word ending with , ; : — but only once the phrase
   *     already has >= 3 words (a comma after word one reads worse than
   *     riding on);
   *   - at 6 words, always (hard cap keeps the strip one line on
   *     mobile).
   * Each phrase cue spans first word's startMs -> last word's endMs, so
   * timing stays true to the voice. Sentence-level cues (or anything
   * already phrase-shaped) pass through unchanged by construction —
   * grouping only ever merges, never splits.
   */
  function groupWordCaptions(words) {
    if (!Array.isArray(words) || words.length < 2) return words || [];
    // Already phrase-grouped (any cue with a space) — e.g. a reading
    // saved AFTER this change, or a sentence-level set passed by mistake:
    // pass through untouched instead of merging phrases into paragraphs.
    for (var i = 0; i < words.length; i++) {
      if ((words[i].word || '').indexOf(' ') !== -1) return words;
    }
    var phrases = [];
    var buf = [];
    function flush() {
      if (!buf.length) return;
      phrases.push({
        word: buf.map(function (w) { return w.word; }).join(' '),
        startMs: buf[0].startMs,
        endMs: buf[buf.length - 1].endMs
      });
      buf = [];
    }
    words.forEach(function (w) {
      buf.push(w);
      var t = (w.word || '').replace(/["')\]]+$/, '');
      var sentenceEnd = /[.!?]$/.test(t);
      var clauseEnd = /[,;:]$/.test(t) && buf.length >= 3;
      if (sentenceEnd || clauseEnd || buf.length >= 6) flush();
    });
    flush();
    return phrases;
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
      if (voiceState.introAudioEl) { try { voiceState.introAudioEl.pause(); } catch (e) { /* element may already be detached */ } }
      // Only pause separately if it was never adopted as the real audioEl
      // above (beginAudioPlayback's own primed-element reuse) — pausing an
      // already-paused element twice is harmless either way, this just
      // avoids a pointless extra try/catch in the common case.
      if (voiceState.primedAudioEl && voiceState.primedAudioEl !== voiceState.audioEl) {
        try { voiceState.primedAudioEl.pause(); } catch (e) { /* best-effort */ }
      }
      // Same round-2 teardown beginAudioPlayback uses when it re-enters for
      // a regenerated track — applied on unmount too so a gesture-primed
      // `<audio>` element (the one thing here that can genuinely outlive the
      // mount, since the stage's own DOM is re-rendered from scratch each
      // time) never carries a superseded stage's handlers forward.
      detachPlaybackListeners(voiceState);
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

  /**
   * Tracker item for-product-p1-bug-founder-repro-sage-re-cbdj3d (founder
   * walk 2026-08-03 23:31): a bare, unlabeled play-triangle read as
   * nothing to most users — the tap overlay above is reused for THREE
   * distinct moments (intro autoplay-blocked, first reading play blocked,
   * resume/replay after the reading has already started once), and each
   * needs its own explicit, persona-named copy rather than one generic
   * label (or none at all). Pure string logic — no DOM — so it's directly
   * unit-testable (test/interp-voice-captions.test.js) independent of the
   * real tap-overlay markup. `personaName` is always read from the live
   * persona object (never hardcoded "Sage") so this reads correctly for
   * every future voice-eligible persona, not just talmudic.
   */
  function tapOverlayLabel(personaName, kind) {
    var name = personaName || 'this reader';
    if (kind === 'replay') return 'Hear it again';
    if (kind === 'resume') return 'Resume';
    if (kind === 'intro') return 'Tap to hear ' + name;
    return 'Hear ' + name + ' read your dream';
  }

  function setTapOverlayLabel(vs, text) { if (vs.tapLabelEl) vs.tapLabelEl.textContent = text; }

  /**
   * Same tracker item, same founder walk — the silent loop before audio
   * lands had ZERO indication a voice reading was even coming. Persona-
   * named "preparing" copy shown in the caption strip (`.itp-voice-caption`
   * — already the natural home for spoken-line text, gets the same visual
   * treatment for free) for the entire `phase === 'loading'` window, and
   * cleared the instant real playback is attempted (beginAudioPlayback),
   * win or lose — a blocked attempt still means "audio exists, tap to
   * hear it" which is a strictly better signal than "still preparing".
   * Pure string logic, unit tested directly.
   */
  function preparingCaptionText(personaName) {
    return (personaName || 'Your reader') + ' is preparing to read your dream…';
  }

  function showPreparingCaption(vs, persona) {
    if (!vs.capEl) return;
    vs.capEl.textContent = preparingCaptionText(persona && persona.name);
  }

  // ── Gesture-priming (tracker item for-product-p1-bug-founder-repro-sage-
  //    re-cbdj3d, fix-set item 3) ──
  // Best-effort attempt to carry a real, already-in-flow user gesture
  // (the persona-pick tap, `onPersonaPicked` below) forward to the
  // reading's eventual `<audio>` element, which is otherwise always
  // created and played later, asynchronously, well outside any click
  // handler's call stack — exactly the shape that trips a strict
  // "play() must be a direct result of a user gesture" autoplay policy
  // (notably Safari/iOS, the founder's own repro environment). The
  // established trick for this (not previously present in this codebase
  // — grepped attemptPlay/unlock/silent across interpret-experience.js,
  // store.js, music-bed.js first per the tracker's own instruction, found
  // no prior art to reuse) is: create the REAL element that will later
  // host the real audio during the real gesture, call `.play()` on it
  // immediately (a tiny embedded silent WAV data URI, so there's always
  // something playable — some browsers reject/throw on `.play()` with no
  // `src` at all, which would make priming itself throw instead of the
  // graceful no-op it must be), then immediately pause/rewind it. Safari's
  // "has this exact element been activated by a gesture" bookkeeping (as
  // opposed to Chrome's page-wide autoplay unlock, which doesn't need
  // this at all) is generally per-element, so swapping this SAME element's
  // `src` to the real reading audio later (beginAudioPlayback) and calling
  // `.play()` again stands a real chance of being honored where a brand
  // new `new Audio(...)` would not be.
  //
  // Deliberately best-effort in every sense: wrapped in try/catch (a
  // synchronous throw from `.play()` on an exotic/old browser must never
  // break the persona-pick tap that triggered it), the returned element is
  // just discarded on any failure, and beginAudioPlayback below always has
  // a `new Audio(vs.audioUrl)` fallback ready if this primed element is
  // missing OR turns out to be unusable when the real reading is ready —
  // this must degrade to fix #2's explicit tap button, never regress
  // anything if priming isn't supported or doesn't help.
  var SILENT_AUDIO_DATA_URI = 'data:audio/wav;base64,UklGRiYAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQIAAAAAAA==';

  function createPrimedAudioElement() {
    try {
      var el = new Audio(SILENT_AUDIO_DATA_URI);
      el.volume = 0;
      var result = el.play();
      if (result && typeof result.then === 'function') {
        result.then(function () {
          try { el.pause(); el.currentTime = 0; } catch (e) { /* best-effort */ }
        }, function () { /* blocked/rejected -- fine, nothing lost, fix #2's tap button still covers this */ });
      } else {
        try { el.pause(); el.currentTime = 0; } catch (e) { /* best-effort */ }
      }
      return el;
    } catch (e) {
      return null; // never let priming break the real (persona-pick) gesture handler it rides along with
    }
  }

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

  /**
   * Kicks off this reading's TTS+captions generation in the background —
   * called immediately when the voice stage mounts for a reading with NO
   * usable persisted audio yet (a brand-new reading, or a saved reading
   * whose audio has just been found dead — see beginAudioPlayback's own
   * 'error' listener, tracker item
   * for-product-defensive-revisited-readings-dta2ae), in parallel with the
   * intro clip when there is one, so audio is ready (or close to it) by
   * the time a real ~7s intro finishes playing (spec's own reasoning).
   * Soft-fails (spec: "reading falls back to text-only, no audio control
   * shown at all") — a failure here tears down the whole voice stage
   * rather than leaving it half-built with nothing to play. Writes the
   * result onto the SAME `dream.interpretations[personaKey]` record
   * (via DreamStore.generateInterpAudio) whether this is the reading's
   * first-ever audio or a regeneration replacing a dead saved URL — a
   * later revisit picks up whatever landed here most recently.
   */
  function requestVoiceAudio(vs, persona) {
    var myGen = gen, myDreamId = vs.dreamId, myPersonaKey = vs.personaKey;
    window.DreamStore.generateInterpAudio(vs.dreamId, vs.personaKey, vs.readingText).then(function (result) {
      if (myGen !== gen || voiceState !== vs || !stillTargetsDream(myDreamId) || session.personaKey !== myPersonaKey) return; // stale
      vs.audioUrl = result.audioUrl;
      vs.audioDurationMs = result.audioDurationMs;
      vs.captions = result.captionsLevel === 'word'
        ? groupWordCaptions(result.captions || [])
        : (result.captions || []);
      vs.captionsLevel = result.captionsLevel;
      vs.audioReady = true;
      if (vs.captionsLevel === 'sentence') trackLocal('interp_voice_caption_fallback', { persona: persona.key });
      if (vs.phase === 'loading') beginAudioPlayback(vs, persona);
    }).catch(function (err) {
      if (myGen !== gen || voiceState !== vs || !stillTargetsDream(myDreamId) || session.personaKey !== myPersonaKey) return; // stale
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

  /**
   * Intro phase (spec §5) — plays the persona's one-time greeting, tap-to-
   * play fallback on a detected autoplay block (spec §6), advances to the
   * reading phase on natural end OR an explicit Skip tap.
   *
   * Real founder-approved Option D assets (js/interpreter-personas.js's own
   * header comment) are TWO separate files, not one muxed clip: `introEl`
   * (`introClipUrl`) is a silent, looping visual backdrop — played MUTED,
   * best-effort, fire-and-forget, never capability-detected (a muted
   * video has nothing for a browser's autoplay policy to block). `introAudioEl`
   * (`introVoiceUrl`) is the actual spoken greeting — THIS is what's
   * capability-detected/tap-gated, and its 'ended' event (not the video's)
   * is the real "intro complete" signal, since the two files' durations
   * don't match exactly (separately-delivered takes, not a frame-locked
   * mux).
   */
  function startIntroPhase(vs, persona) {
    vs.phase = 'intro';
    if (vs.skipEl) vs.skipEl.style.display = '';
    if (vs.introEl) { vs.introEl.muted = true; vs.introEl.loop = true; attemptPlay(vs.introEl); } // ambient visual only — never gated, never tracked
    var introAudio = vs.introAudioEl;
    if (!introAudio) { completeIntro(vs, persona, 'ended'); return; } // defensive — shouldn't happen, renderReading only renders the intro markup when introClipUrl+introVoiceUrl are both set
    attemptPlay(introAudio).then(function (ok) {
      if (voiceState !== vs) return;
      if (ok) {
        trackLocal('interp_voice_intro_shown', { persona: persona.key });
      } else {
        trackLocal('interp_voice_autoplay_blocked', { persona: persona.key, surface: 'intro' });
        setTapOverlayLabel(vs, tapOverlayLabel(persona.name, 'intro'));
        showTapOverlay(vs);
      }
    });
    introAudio.addEventListener('ended', function () {
      if (voiceState !== vs) return;
      completeIntro(vs, persona, 'ended');
    });
    if (vs.tapOverlay) {
      vs.tapOverlay.addEventListener('click', function onIntroTap() {
        if (voiceState !== vs || vs.phase !== 'intro') return;
        // A tap that still can't play must never be a silent no-op (founder
        // repro, 2026-08-04: "tapping doesn't do anything"). iOS can wedge a
        // media element whose first (blocked) play attempt aborted its load —
        // a load() reset before the gesture's play() is the standard unwedge.
        // On failure, surface the error name in the tap label (preview-gated
        // surface, so this diagnostic is founder/dev-only today) and track it.
        try { if (introAudio.error || introAudio.readyState === 0) introAudio.load(); } catch (e) { /* best-effort */ }
        var result;
        try { result = introAudio.play(); } catch (e) { result = Promise.reject(e); }
        if (!result || typeof result.then !== 'function') result = Promise.resolve();
        result.then(function () {
          if (voiceState !== vs || vs.phase !== 'intro') return;
          hideTapOverlay(vs);
          trackLocal('interp_voice_intro_shown', { persona: persona.key });
        }, function (err) {
          if (voiceState !== vs || vs.phase !== 'intro') return;
          var name = (err && err.name) || 'unknown';
          setTapOverlayLabel(vs, 'Tap again — audio was blocked (' + name + ')');
          trackLocal('interp_voice_intro_tap_failed', { persona: persona.key, error: name });
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
    if (vs.introAudioEl) { try { vs.introAudioEl.pause(); } catch (e) { /* best-effort */ } }
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
    else showPreparingCaption(vs, persona); // silent bounce-loop window — see showPreparingCaption's own doc comment
    // else: requestVoiceAudio's own .then/.catch (already in flight) picks
    // this up the moment it resolves — see their own `phase === 'loading'` checks.
  }

  /**
   * Removes whatever listener set a PREVIOUS beginAudioPlayback call
   * attached for this same `vs` (round-2 review finding on tracker item
   * for-product-defensive-revisited-readings-dta2ae).
   *
   * beginAudioPlayback is NOT once-per-mount: the dead-saved-audio
   * regenerate path below deliberately re-enters it for the same `vs` to
   * start the regenerated track. Its listeners, though, land on things that
   * outlive a single call — `vs.tapOverlay` is one mount-lived DOM element
   * reused across every call, and the gesture-primed `<audio>` element is
   * reused too when priming succeeded. Without this teardown, a second call
   * left the first call's handlers live alongside the new ones, so one real
   * user tap after a regenerate fired attemptPlay twice — once on the
   * regenerated element, once on the stale DEAD one the old closure still
   * held — double-counting interp_voice_play in analytics and attempting
   * playback of a URL already known to be gone.
   *
   * Handler references are kept on `vs` (rather than a WeakMap or a
   * dataset flag) because they must be removable from a specific element
   * pair, and `vs` is already this stage's single owned state bag —
   * resetVoiceState's own teardown gets to reuse this for free.
   */
  function detachPlaybackListeners(vs) {
    var prev = vs && vs.playbackListeners;
    if (!prev) return;
    if (prev.audioEl) {
      prev.audioEl.removeEventListener('loadedmetadata', prev.onLoadedMetadata);
      prev.audioEl.removeEventListener('timeupdate', prev.onTimeUpdate);
      prev.audioEl.removeEventListener('ended', prev.onEnded);
      prev.audioEl.removeEventListener('error', prev.onError);
    }
    if (prev.tapOverlay) prev.tapOverlay.removeEventListener('click', prev.onReadingTap);
    vs.playbackListeners = null;
  }

  function beginAudioPlayback(vs, persona) {
    vs.phase = 'reading';
    detachPlaybackListeners(vs); // see its own doc comment — this function can legitimately run more than once per `vs` (the regenerate path re-enters it)
    if (vs.capEl) vs.capEl.textContent = ''; // clears showPreparingCaption's copy the instant real playback is attempted, win or lose (spec: "clear it the moment real captions/audio take over")
    // Reuse the gesture-primed element (createPrimedAudioElement, set up
    // back at the persona-pick tap) when one exists and is still usable —
    // see that function's own doc comment for why swapping THIS element's
    // src (rather than constructing a brand new Audio here) is the whole
    // point of priming. Falls back to a fresh element on any failure or
    // when there was nothing to reuse (priming unsupported/blocked, or
    // this reading was reached some other way).
    var audio = null;
    if (vs.primedAudioEl) {
      try {
        vs.primedAudioEl.src = vs.audioUrl;
        vs.primedAudioEl.volume = 1;
        vs.primedAudioEl.currentTime = 0;
        audio = vs.primedAudioEl;
      } catch (e) { audio = null; }
    }
    if (!audio) audio = new Audio(vs.audioUrl);
    vs.audioEl = audio;
    // Every listener below is a NAMED reference, collected into
    // vs.playbackListeners so detachPlaybackListeners above can remove this
    // exact set if beginAudioPlayback runs again for this same `vs`.
    function onLoadedMetadata() {
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
    }
    function onTimeUpdate() {
      if (voiceState !== vs) return;
      renderVoiceCaption(vs, audio.currentTime * 1000);
    }
    function onEnded() {
      if (voiceState !== vs) return;
      if (vs.listenStartedAt) { vs.totalListenedMs += Date.now() - vs.listenStartedAt; vs.listenStartedAt = null; }
      vs.hasCompletedOnce = true;
      renderVoiceCaption(vs, 0);
      trackLocal('interp_voice_complete', { persona: persona.key, duration_ms: vs.audioDurationMs || Math.round(audio.duration * 1000) || null });
      setTapOverlayLabel(vs, tapOverlayLabel(persona.name, 'replay'));
      showTapOverlay(vs); // reused as the "replay" affordance post-completion
    }
    // Tracker item for-product-defensive-revisited-readings-dta2ae —
    // the real `error` event (fires on a genuinely dead/expired/
    // unreachable src, same signal class result.html's own
    // `video.addEventListener('error', ...)` retry-once convention
    // already reacts to for the dream video itself) ONLY triggers a
    // regenerate-and-swap-in fallback on the REVISIT-WITH-SAVED-AUDIO
    // path (`vs.audioSource === 'saved'` — a persisted reading's
    // audioUrl, fal-hosted with no guaranteed lifetime, going stale
    // between visits). A brand-new reading's own freshly-minted URL
    // erroring is a much rarer, out-of-scope case for this fix (it was
    // just returned seconds ago) and is left exactly as before —
    // silently not playing, no regression either way.
    //
    // Bounded to exactly one regenerate attempt per reading-open
    // (`vs.regenerateAttempted`, same one-shot spirit as result.html's
    // own `video.dataset.retried`): if the REGENERATED audio somehow
    // errors too, this degrades to the existing hard-TTS-failure path
    // (teardownVoiceStageOnFailure — voice stage hides, Wave 1's plain
    // text card underneath is unaffected) rather than looping forever.
    function onError() {
      if (voiceState !== vs) return;
      if (vs.audioSource !== 'saved') return;
      if (vs.regenerateAttempted) {
        trackLocal('interp_voice_tts_failed', { persona: persona.key, error_code: 'regenerated_audio_error' });
        teardownVoiceStageOnFailure(vs);
        return;
      }
      vs.regenerateAttempted = true;
      trackLocal('interp_voice_saved_audio_expired', { persona: persona.key });
      try { audio.pause(); } catch (e) { /* best-effort — it's already erroring */ }
      // This element is abandoned as of right now — drop its listeners here
      // rather than waiting for the regenerated track to re-enter
      // beginAudioPlayback. Found by the REAL-MODE verification pass and
      // invisible to every mocked test: a real browser emits a `timeupdate`
      // on the failing element around its play attempt, and that stale
      // handler repainted the caption strip from `vs.captions` — which still
      // described the DEAD track — instantly overwriting the persona-named
      // "preparing" copy this whole path exists to show (the founder would
      // have seen a leftover word, not "The Sage is preparing…"). Same bug
      // class as the duplicate-listener fix above (a listener outliving its
      // element's relevance), so it reuses the same teardown. A stale `ended`
      // would likewise have fabricated a bogus interp_voice_complete for
      // audio that never actually played.
      detachPlaybackListeners(vs);
      hideTapOverlay(vs); // no stale "Hear him read"/"Resume" affordance while a fresh track is being fetched
      vs.audioReady = false;
      vs.audioUrl = null;
      vs.captions = []; // they describe the dead track; the regenerated one brings its own
      vs.phase = 'loading'; // reuses enterReadingPhase's own loading sub-state UI language
      showPreparingCaption(vs, persona); // same "preparing" copy a brand-new reading shows — this must look like the reading is getting itself ready again, not like anything broke
      requestVoiceAudio(vs, persona); // the SAME regeneration flow a fresh reading already uses; its own .then re-enters beginAudioPlayback (vs.phase === 'loading' — and detachPlaybackListeners there clears THIS listener set first), its own .catch falls to teardownVoiceStageOnFailure if the regenerate call itself fails outright
    }
    function onReadingTap() {
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
        setTapOverlayLabel(vs, tapOverlayLabel(persona.name, 'resume'));
        showTapOverlay(vs);
      }
    }

    audio.addEventListener('loadedmetadata', onLoadedMetadata);
    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onError);
    if (vs.tapOverlay) vs.tapOverlay.addEventListener('click', onReadingTap);
    // Recorded against the EXACT elements they were attached to (not just
    // re-read off `vs` at teardown time), so a later detach can't miss a
    // handler because `vs.audioEl` has since been swapped for a regenerated
    // element.
    vs.playbackListeners = {
      audioEl: audio,
      tapOverlay: vs.tapOverlay || null,
      onLoadedMetadata: onLoadedMetadata,
      onTimeUpdate: onTimeUpdate,
      onEnded: onEnded,
      onError: onError,
      onReadingTap: onReadingTap
    };

    // Deliberately AFTER the listener registration above (the order the
    // pre-fix code had too): play() itself never dispatches synchronously,
    // but keeping the element fully wired before it is ever asked to play
    // means no media event can outrun its handler.
    attemptPlay(audio).then(function (ok) {
      // `vs.audioEl !== audio` is the staleness guard this callback was
      // missing — same spirit as requestVoiceAudio's own `myGen !== gen`
      // checks, and the third finding of the REAL-MODE pass. The DEAD track's
      // play() rejection can land AFTER onError has already abandoned that
      // element and kicked off a regenerate; the old closure would then raise
      // the "Hear The Sage read your dream" overlay for a track that no longer
      // exists. That overlay then sat on top of the regenerated audio once it
      // started playing, so the user's next real tap PAUSED the reading they
      // had just asked to hear. A superseded attempt must never paint the stage.
      //
      // `vs.phase !== 'reading'` is the load-bearing half: while a regenerate
      // is in flight the stage has gone back to 'loading' but `vs.audioEl`
      // still points at the dead element, so an element-identity check alone
      // would miss it. Same phase guard onReadingTap already uses.
      if (voiceState !== vs || vs.audioEl !== audio || vs.phase !== 'reading') return;
      if (ok) {
        vs.listenStartedAt = Date.now();
        // Defence in depth for the same symptom: if playback actually began,
        // the tap-to-play affordance has no business still being up, whatever
        // put it there.
        hideTapOverlay(vs);
        trackLocal('interp_voice_play', { persona: persona.key, source: 'auto' });
      } else {
        trackLocal('interp_voice_autoplay_blocked', { persona: persona.key, surface: 'reading' });
        setTapOverlayLabel(vs, tapOverlayLabel(persona.name, 'first'));
        showTapOverlay(vs);
      }
    });
  }

  /**
   * Mounts the voice stage for the CURRENT reading (called from
   * renderReading below only when the active persona has a `voiceId` and
   * the founder-preview gate is on). Starts whichever phase applies —
   * intro-first (persona has an unshown introClipUrl) or straight to the
   * reading phase.
   *
   * Audio sourcing (tracker item
   * for-product-defensive-revisited-readings-dta2ae): a REVISIT of a
   * dream+persona that already has a persisted `audioUrl`
   * (js/store.js's getInterpretations — written once by a prior
   * generateInterpAudio call and never expiring locally) reuses it
   * directly, `audioReady:true` from the moment `vs` is built — no new
   * generation call at all. This used to unconditionally call
   * requestVoiceAudio on every single mount regardless of whether audio
   * already existed for this reading, silently regenerating (and
   * re-spending) a fresh TTS track on every revisit, and meant any
   * transient failure on THAT regeneration (rate limit, network blip)
   * tore down the whole voice stage even though a perfectly good saved
   * reading already existed — a very plausible account of exactly the
   * "text-only, no voice" symptom this tracker item was opened over. Only
   * a genuinely NEW reading (no persisted audioUrl yet) still calls
   * requestVoiceAudio here, in parallel with the intro clip when there is
   * one, same as before. `vs.audioSource` records which path seeded this
   * `vs` — beginAudioPlayback's own 'error' listener reads it to decide
   * whether a saved URL going stale should trigger a real regenerate.
   */
  function setupVoiceStage(persona) {
    resetVoiceState();
    var savedEntry = null;
    var existingReadings = window.DreamStore.getInterpretations(session.dreamId);
    if (existingReadings && existingReadings[session.personaKey] && existingReadings[session.personaKey].audioUrl) {
      savedEntry = existingReadings[session.personaKey];
    }
    var vs = {
      dreamId: session.dreamId, personaKey: session.personaKey, readingText: session.readingText,
      stageEl: document.getElementById('itp-voice-stage'),
      introEl: document.getElementById('itp-voice-intro'),
      introAudioEl: document.getElementById('itp-voice-intro-audio'),
      dreamEl: document.getElementById('itp-voice-dream-video'),
      capEl: document.getElementById('itp-voice-caption'),
      tapOverlay: document.getElementById('itp-voice-tap-overlay'),
      tapLabelEl: document.getElementById('itp-voice-tap-label'),
      skipEl: document.getElementById('itp-voice-skip'),
      phase: 'intro', bounceDirection: 1, rafId: null,
      audioEl: null,
      audioUrl: savedEntry ? savedEntry.audioUrl : null,
      audioReady: !!savedEntry,
      audioFailed: false,
      audioSource: savedEntry ? 'saved' : 'fresh',
      regenerateAttempted: false, // bounds beginAudioPlayback's own error-driven regenerate to one attempt per reading-open
      // Saved readings persisted their captions word-level before the
      // 2026-08-07 phrase-grouping change — group on read so old saved
      // readings display exactly like fresh ones (grouping merges only,
      // so re-grouping an already-grouped save is a no-op).
      captions: savedEntry ? groupWordCaptions(savedEntry.captions || []) : [],
      captionsLevel: savedEntry ? (savedEntry.captionsLevel || 'word') : 'word',
      audioDurationMs: savedEntry ? (savedEntry.audioDurationMs || null) : null,
      listenStartedAt: null, totalListenedMs: 0, hasCompletedOnce: false,
      // Consumed from `session` (set by onPersonaPicked's real gesture,
      // see createPrimedAudioElement's own doc comment) — grabbed here
      // once and cleared off `session` immediately so a LATER setupVoiceStage
      // call for a different persona/reading (Another take, Regenerate)
      // never accidentally reuses an element primed for a different one.
      primedAudioEl: session.primedAudioEl || null
    };
    session.primedAudioEl = null;
    voiceState = vs;

    if (!savedEntry) requestVoiceAudio(vs, persona);

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
      '<div class="itp-body" id="itp-body"></div>' +
      // Bottom nav (founder ask 2026-08-07: the persona-picker screen had
      // no way to navigate away except the topbar close). Shown ONLY in
      // the picker phase (see render()) — the intro/reading phases stay
      // immersive, same as the fullscreen player. .night-dock is
      // position:absolute bottom-anchored, so inside this fixed overlay
      // it pins to the overlay's own bottom edge.
      '<nav class="night-dock" id="itp-dock" aria-label="Main" style="display:none;"></nav>';
    host.appendChild(root);
    if (window.BottomNav) {
      // No active tab: the Chamber isn't one of the dock's four tabs —
      // same active-less mount result.html already uses.
      window.BottomNav.mount(root.querySelector('#itp-dock'), {});
    }
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
      // Match on the RESOLVED dream's own id, not on `selectedId`: a
      // `pending:<operationName>` id whose generation has already finished
      // now resolves through to the real dream it produced (js/store.js's
      // findPendingDream fall-through), which getMyDreams above is already
      // listing under its real id — prepending on the id alone would show
      // that one dream twice.
      var alreadyListed = selectedDream && dreams.some(function (d) { return d.id === selectedDream.id; });
      if (selectedDream && !alreadyListed) dreams = [selectedDream].concat(dreams);
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
  // Picker phase (spec §3.1) — ALL-VISIBLE TILE GRID (tracker item
  // for-product-founder-spec-08-04-chamber-m-zf5ufo, part 2, replacing the
  // original horizontal swipeable carousel). Founder's own ask: every
  // persona visible at once, no swipe/scroll needed to discover the rest
  // of the roster — styled like this app's own existing video-style
  // picker (style.html's `#style-grid`/`.style-card`: a 2-column CSS
  // grid of portrait-filled cards with a bottom-gradient name label, see
  // css/styles.css's `.itp-persona-grid`/`.itp-persona-card` for the full
  // "why these exact rules" reasoning). A single tap still advances
  // immediately — an already-read persona jumps straight to its saved
  // reading, no network; a fresh persona starts the questions flow — same
  // behavior as the old carousel, only the container/layout changed.
  //
  // Reuses the EXACT SAME `.itp-persona-card` element/content structure
  // (name/inspiredBy/tagline, the accent-gradient fallback, the
  // "already read" checkmark badge) the carousel used — every existing
  // test targeting `.itp-persona-card[data-key="..."]` keeps working
  // unchanged; only the outer container class and the now-removed
  // carousel-dots tracker are new/gone. The one deliberate content trim:
  // the old carousel's second "Asks about: ..." line (rendered from each
  // persona's `asksAbout` field) is dropped from the tile — the smaller
  // grid tile has room for tagline OR asksAbout, not both, and tagline is
  // the stronger single line for a quick-glance grid (asksAbout still
  // exists as real, tested data on every persona — js/interpreter-
  // personas.js, spec §5 — just not rendered in this tighter layout).
  function renderPicker() {
    var body = document.getElementById('itp-body');
    var existing = window.DreamStore.getInterpretations(session.dreamId) || {};
    var personas = window.InterpreterPersonas.ALL;

    var cardsHtml = personas.map(function (p, i) {
      var isRead = !!(existing[p.key] && existing[p.key].text);
      var initial = (p.key || '?').charAt(0).toUpperCase();
      // An ODD persona count (5 today) leaves one tile alone on the last
      // row of a 2-column grid — span it across both columns rather than
      // leaving it stranded off-center. Generic on `personas.length`, not
      // hardcoded to 5, so adding/removing a persona (this file's header
      // comment's own "persona-agnostic architecture" promise) never
      // needs a matching CSS/layout fix here.
      var isLastOdd = (personas.length % 2 === 1) && (i === personas.length - 1);
      var tileClass = 'itp-persona-card' + (isRead ? ' read' : '') + (isLastOdd ? ' itp-persona-card--wide' : '');
      return '<div class="' + tileClass + '" data-key="' + esc(p.key) + '" style="background:linear-gradient(155deg,' + esc(p.accent) + ',rgba(10,10,10,.9));">' +
        '<div class="itp-persona-card-badge"><span class="icon">' + Icons.check + '</span></div>' +
        '<div class="itp-persona-card-fallback">' + esc(initial) + '</div>' +
        '<div class="itp-persona-card-bg" style="background-image:url(\'' + esc(p.portrait) + '\');"></div>' +
        '<div class="itp-persona-card-scrim"></div>' +
        '<div class="itp-persona-card-content">' +
        '<div class="itp-persona-card-name">' + esc(p.name) + '</div>' +
        '<div class="itp-persona-card-inspired">' + esc(p.inspiredBy) + '</div>' +
        '<div class="itp-persona-card-tagline">' + esc(p.tagline) + '</div>' +
        '</div></div>';
    }).join('');

    body.innerHTML =
      '<div class="itp-picker-title">Who should read this dream?</div>' +
      '<div class="itp-picker-sub">Pick a method — you can always come back for another take.</div>' +
      '<div class="itp-persona-grid" id="itp-persona-grid">' + cardsHtml + '</div>' +
      '<div class="itp-picker-footer">AI characters inspired by real methods — for reflection, not advice.</div>';

    var grid = document.getElementById('itp-persona-grid');
    var cards = grid.querySelectorAll('.itp-persona-card');
    cards.forEach(function (card) {
      card.addEventListener('click', function () {
        var key = card.getAttribute('data-key');
        onPersonaPicked(key, existing);
      });
    });
  }

  function onPersonaPicked(personaKey, existingMap) {
    var existing = existingMap || window.DreamStore.getInterpretations(session.dreamId) || {};
    trackLocal('interp_persona_selected', { persona: personaKey });
    session.personaKey = personaKey;
    // Gesture-priming (fix-set item 3, see createPrimedAudioElement's own
    // doc comment) — this click IS the real user gesture, so it's the
    // earliest legal moment to prime an element for the reading's eventual
    // audio, win or lose (revisit or fresh questions flow either way,
    // setupVoiceStage consumes this off `session` whenever the reading
    // phase is actually reached). Skipped entirely for a non-voice-eligible
    // persona/gate-off browser — nothing to prime, no reason to spend it.
    var pickedPersona = getPersonaOrFallback(personaKey);
    if (pickedPersona && pickedPersona.voiceId) {
      session.primedAudioEl = createPrimedAudioElement();
    }
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
      if (myGen !== gen || !stillTargetsDream(myDreamId)) return; // stale — a different session is open now
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
      if (myGen !== gen || !stillTargetsDream(myDreamId)) return;
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
      if (myGen !== gen || !stillTargetsDream(myDreamId)) return;
      goToReading(data.text, data.at, session.regenerated);
    }).catch(function (err) {
      if (myGen !== gen || !stillTargetsDream(myDreamId)) return;
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
        // Two separate elements (js/interpreter-personas.js's own header
        // note): the video is a silent, looping visual only (muted here
        // in markup too, not just in JS, so there's never a flash of
        // real audio before startIntroPhase's own vs.introEl.muted=true
        // runs) — the actual greeting audio is the sibling <audio>,
        // hidden (no visual chrome of its own, the tap overlay above it
        // in the stage is what a blocked-autoplay tap lands on).
        ? '<video class="itp-voice-media itp-voice-intro" id="itp-voice-intro" playsinline preload="auto" muted src="' + esc(persona.introClipUrl) + '"></video>' +
          '<audio id="itp-voice-intro-audio" preload="auto" src="' + esc(persona.introVoiceUrl) + '" style="display:none"></audio>'
        : '') +
      '<div class="itp-voice-caption" id="itp-voice-caption"></div>' +
      '<div class="itp-voice-tap-overlay off" id="itp-voice-tap-overlay">' +
      '<div class="itp-voice-tap-btn"><span class="icon">' + Icons.play + '</span></div>' +
      '<div class="itp-voice-tap-label" id="itp-voice-tap-label"></div>' +
      '</div>' +
      '<div class="itp-voice-skip link-text" id="itp-voice-skip" style="display:none">Skip</div>' +
      '</div>';
  }

  function renderReading() {
    var persona = getPersonaOrFallback(session.personaKey);
    var body = document.getElementById('itp-body');
    var voiceEligible = !!persona.voiceId;
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

  /** Discards a primed-but-never-consumed audio element (createPrimedAudioElement) — reachable whenever a persona pick's priming attempt never made it to setupVoiceStage's own consume-and-clear (Back mid-questions, switching dreams). Best-effort pause, same tolerance as every other media-element teardown in this file. */
  function discardPrimedAudioEl() {
    if (session && session.primedAudioEl) {
      try { session.primedAudioEl.pause(); } catch (e) { /* best-effort */ }
      session.primedAudioEl = null;
    }
  }

  function goToPicker() {
    resetVoiceState();
    discardPrimedAudioEl();
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
    var dock = document.getElementById('itp-dock');
    if (dock) dock.style.display = session.phase === 'picker' ? '' : 'none';
    var rootEl = document.getElementById(ROOT_ID);
    if (rootEl) rootEl.classList.toggle('itp-dock-on', session.phase === 'picker');
    if (session.phase === 'picker') renderPicker();
    else if (session.phase === 'q_loading' || session.phase === 'r_loading') renderLoading();
    else if (session.phase === 'questions') renderQuestions();
    else if (session.phase === 'reading') renderReading();
    else if (session.phase === 'error') renderError();
  }

  // ==========================================================================
  // Pending dream -> real dream, mid-session (founder ask 2026-08-04,
  // tracker item for-product-founder-ask-08-04-offer-the--rlcai3: "the
  // reading can begin while the video is still rendering... swap the real
  // video in when it lands").
  //
  // A reading opened from home.html's forming card targets the synthetic
  // `pending:<operationName>` id (js/store.js's findPendingDream) — a real,
  // fully-functional interpretation target (it carries the dream's TEXT,
  // which is all the reading and its voice ever need) that simply has no
  // media yet, so the voice stage mounts on its already-existing no-video
  // path: `#itp-voice-dream-video` renders with no `src`, and
  // startDreamVideoBounceLoop no-ops on it rather than blocking anything.
  //
  // When that generation finishes, home.html's onGenerationSettled calls
  // notifyDreamResolved with the id the dream USED to be addressed by and
  // the real one it now has. Deliberately a push from the host page rather
  // than a poll from in here: the host already owns the completion promise
  // and knows the exact moment, and this file has no business running a
  // timer of its own for something another module already observes
  // precisely.
  // ==========================================================================

  /** Fills in the reading stage's dream video the moment the real media exists, and starts the bounce loop that was skipped when there was nothing to loop. No-op if the stage already has media, the dream still has none, or the intro is still playing (enterReadingPhase starts the loop itself when the intro ends). */
  function swapInResolvedDreamMedia(vs) {
    var el = vs.dreamEl;
    if (!el || el.getAttribute('src')) return;
    var dream = window.DreamStore.getDream(vs.dreamId);
    // Same `videoUrl || imageUrl` media priority renderReading itself
    // computes for the initial mount — one definition of "this dream's
    // media", not a second one that could drift from it.
    var url = dream && (dream.videoUrl || dream.imageUrl);
    if (!url) return;
    el.setAttribute('src', url);
    trackLocal('interp_pending_video_swapped_in', { persona: vs.personaKey });
    if (vs.phase !== 'intro' && !vs.rafId) startDreamVideoBounceLoop(vs);
  }

  /**
   * Re-points an OPEN session from a still-generating dream's synthetic
   * `pending:<operationName>` id at the real dream id that generation just
   * produced, and swaps the finished video into the voice stage in place.
   *
   * Everything that survives the swap does so because it never depended on
   * the media in the first place: the reading text is already rendered, and
   * the voice `<audio>` element is a separate element with its own url — so
   * Regenerate / Another take / a later revisit all resolve correctly
   * against the new id immediately.
   *
   * Persistence, precisely (this used to overstate the guarantee): whatever
   * had ALREADY been written under the pending id by the time this fires is
   * carried over by js/store.js — finalizeDream migrates
   * state.pendingInterpretations onto the real dream in the very same call
   * that triggers this. But a reading or TTS request still IN FLIGHT at this
   * moment has written nothing yet, and will come back to a pending id whose
   * pendingJob is already gone. That case is handled on the store side, not
   * here: findPendingDream falls through to the real dream via its
   * `sourceOperationName` once the job has finished, so a late response
   * persists onto the real dream instead of being silently dropped. This
   * function's own job is the OPEN SESSION only — re-pointing
   * `session.dreamId` and letting `stillTargetsDream` keep those in-flight
   * responses from being discarded as stale. Neither half is sufficient
   * alone: with only this half, a late reading renders here and then vanishes
   * on the next visit.
   *
   * Safe to call unconditionally: a closed overlay, or one showing a
   * DIFFERENT dream than the one that just resolved (the user switched via
   * the dream strip while the video rendered), is left completely alone.
   */
  function notifyDreamResolved(pendingDreamId, realDreamId) {
    if (!session || !pendingDreamId || !realDreamId) return;
    if (session.dreamId !== pendingDreamId) return;
    session.dreamId = realDreamId;
    // Read by stillTargetsDream (see its own doc comment) so requests
    // already in flight against the pending id — above all the TTS call
    // this whole feature depends on — are NOT thrown away as stale.
    session.resolvedFrom = pendingDreamId;
    trackLocal('interp_pending_dream_resolved', { phase: session.phase });
    if (voiceState && voiceState.dreamId === pendingDreamId) {
      voiceState.dreamId = realDreamId;
      swapInResolvedDreamMedia(voiceState);
    }
    // The strip was showing this dream as the synthetic, media-less tile
    // findDream stitched to the front (see renderDreamStrip's own edge-case
    // comment); it's a real, thumbnailed dream in getMyDreams() now.
    renderDreamStrip();
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
    discardPrimedAudioEl(); // a still-open session's primed element (see onPersonaPicked) has no home in the brand-new `session` object about to replace it below (switchDream's own re-open-for-a-different-dream path)
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
      // Set only by notifyDreamResolved (see its own doc comment) — always
      // null on a fresh open, including the re-open switchDream performs,
      // so an id alias can never leak from one session into the next.
      resolvedFrom: null,
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
    discardPrimedAudioEl();
    session = null;
    gen += 1;
  }

  var InterpretExperience = { open: open, close: close, notifyDreamResolved: notifyDreamResolved };

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
  // Tracker item for-product-p1-bug-founder-repro-sage-re-cbdj3d's fix set —
  // both pure/no-DOM, same "export an internal for testability" precedent.
  InterpretExperience._tapOverlayLabel = tapOverlayLabel;
  InterpretExperience._preparingCaptionText = preparingCaptionText;

  if (typeof window !== 'undefined') window.InterpretExperience = InterpretExperience;
  if (typeof module !== 'undefined' && module.exports) module.exports = InterpretExperience;
})();
