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

  function renderReading() {
    var persona = getPersonaOrFallback(session.personaKey);
    var body = document.getElementById('itp-body');
    body.innerHTML =
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
  }

  function goToPicker() {
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
    trackLocal('interp_closed', { phase: session.phase });
    var root = document.getElementById(ROOT_ID);
    if (root) root.classList.remove('open');
    document.body.style.overflow = '';
    session = null;
    gen += 1;
  }

  var InterpretExperience = { open: open, close: close };

  if (typeof window !== 'undefined') window.InterpretExperience = InterpretExperience;
  if (typeof module !== 'undefined' && module.exports) module.exports = InterpretExperience;
})();
