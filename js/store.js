// js/store.js
//
// Plain script (no ES modules — works with file:// and every static host, no MIME issues).
// Acts as a fake backend using localStorage so state survives real page navigations.
// Every method is written to mirror a real REST call; swap the body for a fetch()
// when a real backend exists and nothing on any page needs to change.
//
//   signup(username,password,email) -> Promise, POST /.netlify/functions/register-account
//       (the real, server-side, authoritative account check), then mirrors the
//       new account into local `accounts` on success — same as before this
//       existed, so nothing about the *original* device's dream/character
//       logic changes. Falls back to a local-only account (today's exact
//       behavior) if the server call itself can't be reached at all — see
//       that function's own comment for why, and its distinction from an
//       explicit server-side rejection (username/email already taken),
//       which is never silently downgraded to a local write.
//   login(usernameOrEmail,password)  -> Promise, POST /.netlify/functions/account-login
//       first (this is what makes login work from any device the account
//       was ever registered from) — falls back to the pre-existing local-
//       only check only when the server explicitly has no matching account
//       at all (never on a wrong password against a real registered
//       account), so a legacy account created before this server-side store
//       existed keeps logging in on the device it already worked on. See
//       that function's own comment for the full fallback reasoning.
//   resetPasswordLocally(token,newPassword) -> Promise, POST
//       /.netlify/functions/verify-password-reset {consume:true, newPassword}
//       — applies the new password to the real server-side account store in
//       the same call that consumes the reset token, then mirrors it into
//       this browser's local `accounts` entry too (creating one if this
//       device never had this account locally at all — same placeholder
//       shape login() creates, dreams/characters left empty by design).
//   getAccountEmail() / updateEmail(email) -> local-only, lets an existing account gain/change its email
//   getSharedFeed()             -> GET  /.netlify/functions/get-feed (real, cross-browser)
//   toggleSharedLike(id,liked)   -> POST /.netlify/functions/like-dream
//   getMyDreams()               -> GET  /api/users/me/dreams
//   getDreamInsight()           -> local read, recurring dream-theme detection for Profile (idea #4)
//   getDreamMilestone()         -> local read, dream-count milestone for Profile (idea #5)
//   getAccountBackup()          -> local read, exports account+dreams+characters as a downloadable JSON backup
//   importAccountBackup(backup) -> local write, restores a backup exported above into this browser
//   getDream(id)                -> GET  /api/dreams/:id
//   toggleLike(id)               -> POST /api/dreams/:id/like
//   generateVideo(caption,style,opts) -> POST /api/dreams/generate
//   regenerateDream(id, patch)   -> POST /api/dreams/:id/regenerate
//   publishDream(id)              -> POST /api/dreams/:id/publish
//   unpublishDream(id)              -> POST /api/dreams/:id/unpublish
//   deleteDream(id)                 -> DELETE /api/dreams/:id
//   getCharacters()                   -> GET  /api/users/me/characters
//   saveCharacter(patch)                -> POST /api/users/me/characters[/:id]
//   deleteCharacter(id)                   -> DELETE /api/users/me/characters/:id
//   getInterpretation(id)                -> local read of a dream's saved "what this might mean" reflection
//   generateInterpretation(id)            -> POST /.netlify/functions/interpret-dream (see that file)
//   getTokenStatus()                      -> GET  /.netlify/functions/get-token-status

// Error codes E3xx = client-side generation failures (as opposed to E1xx/E2xx,
// which come from generate-video.js/video-status.js and already carry their
// own codes by the time they reach here — those are passed through as-is).
//   E301 generation_timeout       — gave up polling after MAX_POLL_MS
//   E302 network error while polling video-status (e.g. connection dropped)
//   E303 network error submitting the initial generate-video request
//   E399 server returned an error response with no error text at all (should be unreachable — every
//        E1xx/E2xx path always sets one — but a code exists in case something upstream changes)
//
// generateInterpretation() below passes through whatever "E4NN: reason"
// string interpret-dream.js's response carries as-is (same pattern as
// E1xx/E2xx above) — see that file's own header comment for the E4xx list.
// A plain network failure reaching the function at all (no response to read
// a code from) surfaces as an uncoded "network_error_requesting_interpretation"
// message instead — result.html's error state doesn't display the raw
// message either way (see its Direction B error copy), so no dedicated code
// was reserved for that case the way E303 exists for generate-video's
// equivalent client-side network failure.

(function () {
  var KEY = 'dreamtube_state_v1';
  var POLL_INTERVAL_MS = 10000;
  // fal.ai Veo generation is documented (see processing.html's copy) as
  // "1-6 minutes" — the previous 6-minute ceiling gave that zero margin, so
  // any generation running even slightly past the high end of its own normal
  // range surfaced as a false timeout failure to the user despite likely
  // still completing successfully on fal's side moments later. 10 minutes
  // gives real headroom while still not leaving a truly stuck job hanging.
  var MAX_POLL_MS = 10 * 60 * 1000;

  var STYLE_GRADIENTS = {
    Cartoon:   'linear-gradient(165deg,#FFD68A,#FFB199)',
    Cinematic: 'linear-gradient(165deg,#3E6E8E,#182A44 55%,#0B0A1F)',
    Anime:     'linear-gradient(165deg,#FF8FCB,#9F8FFF)',
    Realistic: 'linear-gradient(165deg,#7C8AAE,#2A2F4A)'
  };

  function seed() {
    return {
      user: null,
      accounts: {}, // lowercased username -> password. Plaintext/local-only: there's no
                     // real backend yet, so this is a placeholder auth model, not
                     // meant to reflect how credentials would be handled for real.
      draft: { caption: '', style: null, sourceDreamId: null, restore: false, characterIds: [], cameraView: null, sceneryTime: null, sceneryPlace: null },
      dreams: [],
      pendingJob: null,
      charactersByUser: {}, // lowercased username -> array of character objects. Private
                             // per-user and reusable across dreams, same key scheme as accounts.
      likedIds: {} // dream id -> true. Purely local "have I liked this" state for the shared
                    // feed's heart icon — the real aggregate like count lives server-side in
                    // Blobs (see getSharedFeed/toggleSharedLike), this just decides +1 vs -1
                    // and which browsers see a filled heart. Not deduped across devices/users;
                    // there's no real account system to dedupe against, same as everywhere else.
    };
  }

  // One-time migration: browsers that used the app before the fal.ai switch
  // (and before mock dreams were removed) still have stale data saved
  // locally that the current backend no longer understands:
  //  - mock seed dreams (ids "d0".."d5")
  //  - finished dreams whose videoUrl is the old pre-Blobs Veo download
  //    proxy path (video-status.js no longer serves that route at all)
  //  - a pendingJob left over from a Veo-era operation (not "fal:"- or
  //    "mock:"-prefixed — see netlify/functions/generate-video.js's
  //    GENERATION_MOCK_MODE for the latter) — resuming it would route into
  //    the dead/zero-quota Veo fallback and hijack a fresh generation
  //    attempt instead of starting one
  var LEGACY_MOCK_ID = /^d[0-5]$/;
  var LEGACY_VEO_DOWNLOAD_PREFIX = '/.netlify/functions/video-status?download=';
  function migrateLegacyState(s) {
    var changed = false;

    var beforeCount = s.dreams.length;
    s.dreams = s.dreams.filter(function (d) { return !LEGACY_MOCK_ID.test(d.id); });
    if (s.dreams.length !== beforeCount) changed = true;

    s.dreams.forEach(function (d) {
      if (d.videoUrl && d.videoUrl.indexOf(LEGACY_VEO_DOWNLOAD_PREFIX) === 0) {
        delete d.videoUrl;
        changed = true;
      }
    });

    if (s.pendingJob && (!s.pendingJob.operationName || (s.pendingJob.operationName.indexOf('fal:') !== 0 && s.pendingJob.operationName.indexOf('mock:') !== 0))) {
      s.pendingJob = null;
      changed = true;
    }

    // Accounts used to be `{ key: password }`. Password reset needs an
    // email on file, so accounts are now `{ key: { password, email } }` —
    // upgrade any old plain-string entries in place (email starts unset;
    // there's no way to recover it, the account just can't use reset until
    // the user knows to... there's no re-entry path for that today, but it
    // doesn't break login/signup for existing accounts either way).
    Object.keys(s.accounts || {}).forEach(function (key) {
      if (typeof s.accounts[key] === 'string') {
        s.accounts[key] = { password: s.accounts[key], email: null };
        changed = true;
      }
    });

    return changed;
  }

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) { var s = seed(); localStorage.setItem(KEY, JSON.stringify(s)); return s; }
      var parsed = JSON.parse(raw);
      if (!parsed.dreams) throw new Error('bad state');
      if (parsed.pendingJob === undefined) parsed.pendingJob = null;
      if (!parsed.accounts) parsed.accounts = {};
      if (!parsed.charactersByUser) parsed.charactersByUser = {};
      if (!parsed.draft.characterIds) parsed.draft.characterIds = [];
      if (parsed.draft.cameraView === undefined) parsed.draft.cameraView = null;
      if (parsed.draft.sceneryTime === undefined) parsed.draft.sceneryTime = null;
      if (parsed.draft.sceneryPlace === undefined) parsed.draft.sceneryPlace = null;
      if (!parsed.likedIds) parsed.likedIds = {};
      if (migrateLegacyState(parsed)) {
        try { localStorage.setItem(KEY, JSON.stringify(parsed)); } catch (e2) { /* storage unavailable — cleaned state still used for this page load */ }
      }
      return parsed;
    } catch (e) {
      var fresh = seed();
      try { localStorage.setItem(KEY, JSON.stringify(fresh)); } catch (e2) { /* storage unavailable — falls back to in-memory only */ }
      return fresh;
    }
  }

  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* storage unavailable, e.g. private mode — state still works for this page load */ }
  }

  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  /** The current user's email on file, or null — shared by getAccountEmail() and startGeneration's opportunistic email on the generate-video request (see that function for why). */
  function currentAccountEmail() {
    if (!state.user) return null;
    var key = state.user.username.toLowerCase();
    return state.accounts[key] ? state.accounts[key].email : null;
  }

  function findAccountKeyByEmail(email) {
    var target = (email || '').trim().toLowerCase();
    if (!target) return null;
    var keys = Object.keys(state.accounts);
    for (var i = 0; i < keys.length; i++) {
      var acct = state.accounts[keys[i]];
      if (acct && acct.email && acct.email.toLowerCase() === target) return keys[i];
    }
    return null;
  }

  function newId() { return 'd' + Math.random().toString(36).slice(2, 9); }
  function findDream(id) {
    for (var i = 0; i < state.dreams.length; i++) if (state.dreams[i].id === id) return state.dreams[i];
    return null;
  }
  function gradientFor(d) { return STYLE_GRADIENTS[d.style] || STYLE_GRADIENTS.Cinematic; }

  /**
   * Keyword-based recurring-theme detector for the Profile "pattern
   * insight" card (idea #4). Deliberately simple client-side substring
   * matching against captions already saved on each dream — no new AI
   * call, per the approved design. A theme counts at most once per dream
   * even if several of its keywords appear in the same caption.
   */
  var DREAM_THEMES = {
    flying: ['fly', 'flying', 'flew', 'soar', 'soaring', 'float', 'floating'],
    falling: ['fall', 'falling', 'fell', 'plummet'],
    water: ['ocean', 'sea', 'water', 'swim', 'swimming', 'wave', 'waves', 'river', 'flood', 'drown', 'drowning', 'rain'],
    chasing: ['chase', 'chasing', 'chased', 'pursued', 'pursuit'],
    teeth: ['teeth', 'tooth'],
    lost: ['lost', 'maze', 'labyrinth', 'wander', 'wandering'],
    animals: ['dog', 'cat', 'wolf', 'wolves', 'bird', 'birds', 'snake', 'snakes', 'lion', 'tiger', 'horse'],
    fire: ['fire', 'burning', 'flame', 'flames'],
    home: ['house', 'home'],
    school: ['school', 'exam', 'classroom'],
    death: ['death', 'dying', 'funeral'],
    city: ['city', 'skyline', 'building', 'buildings']
  };
  var THEME_MIN_COUNT = 3;  // a theme must recur at least this many times...
  var THEME_MIN_TOTAL = 4;  // ...across at least this many recent dreams...
  var THEME_WINDOW = 9;     // ...looking only at the most recent N (mine is already newest-first)
  function detectDreamTheme(dreams) {
    var recent = dreams.slice(0, THEME_WINDOW);
    if (recent.length < THEME_MIN_TOTAL) return null;
    var counts = {};
    recent.forEach(function (d) {
      var text = (d.caption || '').toLowerCase();
      Object.keys(DREAM_THEMES).forEach(function (theme) {
        var hit = DREAM_THEMES[theme].some(function (kw) { return text.indexOf(kw) !== -1; });
        if (hit) counts[theme] = (counts[theme] || 0) + 1;
      });
    });
    var best = null;
    Object.keys(counts).forEach(function (theme) {
      if (!best || counts[theme] > counts[best]) best = theme;
    });
    if (!best || counts[best] < THEME_MIN_COUNT) return null;
    return { theme: best, count: counts[best], total: recent.length };
  }

  /** Milestone thresholds for idea #5 — a count that only ever goes up, no streak to break. */
  var DREAM_MILESTONES = [1, 5, 10, 25, 50, 100, 250, 500, 1000];
  function ordinal(n) {
    var suffixes = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (suffixes[(v - 20) % 10] || suffixes[v] || suffixes[0]);
  }

  function newCharId() { return 'c' + Math.random().toString(36).slice(2, 9); }
  /** Characters are private per-user — every accessor is scoped to the logged-in account, never global. */
  function myCharacterList() {
    if (!state.user) return [];
    var key = state.user.username.toLowerCase();
    if (!state.charactersByUser[key]) state.charactersByUser[key] = [];
    return state.charactersByUser[key];
  }
  function findCharacter(id) {
    var list = myCharacterList();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  /**
   * Maps selected character ids to the plain {name, description, isSelf,
   * photoDataUrl?} shape the generation API needs — ids are meaningless
   * outside this browser's localStorage, so only the resolved fields cross
   * the network. photoDataUrl is only ever forwarded for isSelf, mirroring
   * the same restriction saveCharacter enforces at write time — no one but
   * "Me" can have a photo, so no one else's resolved record carries one.
   */
  function resolveCharacters(ids) {
    if (!ids || !ids.length) return [];
    return ids.map(findCharacter).filter(Boolean).map(function (c) {
      var resolved = { name: c.name, description: c.description, isSelf: !!c.isSelf };
      if (c.isSelf && c.photoDataUrl) resolved.photoDataUrl = c.photoDataUrl;
      return resolved;
    });
  }

  function savePendingJob(job) { state.pendingJob = job; persist(); }
  function clearPendingJob() { state.pendingJob = null; persist(); }

  /**
   * Fire-and-forget upsert into the shared feed-index blob. Local state is
   * always the source of truth for the owner's own view (Profile) — if this
   * fails, the dream still shows as published locally, it just might not
   * (yet) appear in others' Explore until the next successful sync.
   */
  function syncPublishedDreamToFeed(dream) {
    fetch('/.netlify/functions/publish-dream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: dream.id, ownerHandle: dream.ownerHandle, caption: dream.caption,
        style: dream.style, dur: dream.dur, videoUrl: dream.videoUrl
      })
    }).catch(function () { /* best-effort — see comment above */ });
  }

  /** Fire-and-forget removal from the shared feed-index blob — same best-effort contract as above. */
  function removePublishedDreamFromFeed(id) {
    fetch('/.netlify/functions/unpublish-dream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id })
    }).catch(function () { /* best-effort — see comment above */ });
  }

  // One-time catch-up for browsers that published dreams before the shared
  // feed existed — those dreams were marked isPublished locally but never
  // pushed to the Blobs-backed feed-index, since that sync didn't exist
  // yet. Runs once per browser (localStorage flag below); safe to run
  // again since publish-dream.js upserts by id.
  var FEED_BACKFILL_KEY = 'dreamtube_feed_backfill_v1_done';
  function backfillSharedFeed() {
    var already;
    try { already = localStorage.getItem(FEED_BACKFILL_KEY); } catch (e) { return; }
    if (already) return;
    state.dreams.forEach(function (d) {
      if (d.isPublished && d.videoUrl) syncPublishedDreamToFeed(d);
    });
    try { localStorage.setItem(FEED_BACKFILL_KEY, '1'); } catch (e) { /* storage unavailable — will just retry next load */ }
  }

  function pollUntilDone(operationName, startedAt) {
    return new Promise(function (resolve, reject) {
      function poll() {
        if (Date.now() - startedAt > MAX_POLL_MS) { reject(new Error('E301: generation_timeout')); return; }
        fetch('/.netlify/functions/video-status?name=' + encodeURIComponent(operationName))
          .then(function (res) { return res.json(); })
          .then(function (data) {
            if (data.error) { reject(new Error(data.error)); return; }
            if (data.done) { resolve(data.videoUrl); return; }
            setTimeout(poll, POLL_INTERVAL_MS);
          })
          .catch(function (err) { reject(new Error('E302: network_error_during_status_check' + (err && err.message ? ': ' + err.message : ''))); });
      }
      poll();
    });
  }

  function formatDuration(totalSeconds) {
    var s = Math.max(0, Math.round(totalSeconds));
    var m = Math.floor(s / 60);
    var sec = s % 60;
    return m + ':' + (sec < 10 ? '0' : '') + sec;
  }

  /**
   * Reads the real duration off the finished video itself — there's no
   * server-side metadata endpoint, so this loads it into an off-DOM <video>
   * just far enough to fire loadedmetadata. Falls back to null (caller
   * keeps whatever duration it already had) rather than blocking dream
   * creation if the probe is slow or the browser can't read it.
   */
  function probeVideoDuration(url) {
    return new Promise(function (resolve) {
      var video = document.createElement('video');
      var settled = false;
      var timeoutId = setTimeout(function () { finish(null); }, 8000);
      function finish(dur) {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        video.removeAttribute('src');
        video.load();
        resolve(dur);
      }
      video.preload = 'metadata';
      video.muted = true;
      video.onloadedmetadata = function () {
        finish(isFinite(video.duration) && video.duration > 0 ? formatDuration(video.duration) : null);
      };
      video.onerror = function () { finish(null); };
      video.src = url;
    });
  }

  function finalizeDream(videoUrl, caption, style, sourceDreamId) {
    var dream;
    if (sourceDreamId) {
      dream = findDream(sourceDreamId);
      if (!dream) throw new Error('not_found');
      // Regenerating (Edit Dream -> Generate Again, or Try Again after a
      // failure) changes the dream's actual content, so any previously
      // generated interpretation was reflecting on content that no longer
      // exists — clear it here rather than silently leaving a stale
      // reflection attached to the new caption/style. This puts the dream
      // back in the "never generated" state, so result.html shows the
      // plain CTA again and a fresh opt-in tap is required, per the design
      // spec's privacy/data-model section.
      Object.assign(dream, { caption: caption, style: style, videoUrl: videoUrl, interpretationText: null, interpretationAt: null });
    } else {
      dream = {
        id: newId(),
        ownerHandle: state.user ? state.user.handle : '@you',
        caption: caption, style: style,
        likes: 0, likedByMe: false, dur: '0:08', isPublished: false,
        videoUrl: videoUrl
      };
      state.dreams.unshift(dream);
    }
    clearPendingJob();
    persist();
    // Edit Dream / Change Style can regenerate a dream that's already
    // published — keep the shared feed's copy from going stale.
    if (dream.isPublished) syncPublishedDreamToFeed(dream);
    return dream;
  }

  /**
   * Starts (or resumes) a generation job and polls until the video is ready.
   * The job is persisted as state.pendingJob the moment an operation name
   * exists, so a navigation or closed tab mid-flight is recoverable — Home
   * checks for a pending job on load and resumes polling it. opts.resume
   * carries over the original operationName/startedAt so the MAX_POLL_MS
   * budget isn't reset by resuming.
   */
  function startGeneration(caption, style, opts) {
    opts = opts || {};
    var sourceDreamId = opts.sourceDreamId || null;
    var resume = opts.resume;
    var characters = resolveCharacters(opts.characterIds);

    var operationPromise = resume
      ? Promise.resolve(resume.operationName)
      : fetch('/.netlify/functions/generate-video', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            caption: caption, style: style, characters: characters,
            cameraView: opts.cameraView || null,
            sceneryTime: opts.sceneryTime || null,
            sceneryPlace: opts.sceneryPlace || null,
            // Sent whenever the browser knows it (logged-in account with an
            // email on file) — this is load-bearing, not opportunistic: the
            // server-side E112 token gate (see lib/entitlements.js and the
            // doc block above generate-video.js's guardrails) is
            // unconditional and always on, and identifies the caller's token
            // balance by this email. No email means no way to look up a
            // balance, so an anonymous/logged-out call here fails E112.
            email: currentAccountEmail(),
            // Best-effort Cloudflare Turnstile token, resolved client-side by
            // processing.html before calling generateVideo/regenerateDream
            // (see js/turnstile-config.js's getTurnstileToken()) — null
            // until a real TURNSTILE_SITE_KEY is configured there. Only
            // actually checked server-side (E113) once TURNSTILE_SECRET_KEY
            // is likewise configured — see generate-video.js's doc block.
            turnstileToken: opts.turnstileToken || null
          })
        }).then(function (res) {
          return res.json().then(function (data) {
            if (!res.ok) throw new Error(data.error || 'E399: generation_failed');
            return data.operationName;
          });
        }, function (err) {
          throw new Error('E303: network_error_starting_generation' + (err && err.message ? ': ' + err.message : ''));
        });

    return operationPromise.then(function (operationName) {
      var startedAt = resume ? resume.startedAt : Date.now();
      savePendingJob({
        operationName: operationName, startedAt: startedAt,
        caption: caption, style: style, sourceDreamId: sourceDreamId,
        notify: (resume && state.pendingJob && state.pendingJob.notify) || false
      });
      return pollUntilDone(operationName, startedAt);
    }).then(function (videoUrl) {
      var dream = finalizeDream(videoUrl, caption, style, sourceDreamId);
      // Don't make the user wait on this — probing needs a real network
      // round trip to the video itself and can be slow (or time out) for
      // reasons that have nothing to do with generation being done. Patch
      // the duration in once it's known instead of blocking completion.
      probeVideoDuration(videoUrl).then(function (dur) {
        if (dur) { dream.dur = dur; persist(); }
      });
      return dream;
    }).catch(function (err) {
      clearPendingJob();
      throw err;
    });
  }

  var state = load();
  backfillSharedFeed();

  // Set by getSharedFeed on every fetch, read by explore.html right after
  // via getLastDreamOfDayId — a side-channel rather than changing
  // getSharedFeed's own resolved value (still just the dreams array),
  // since home.html/processing.html also call it and only care about that.
  var lastDreamOfDayId = null;

  /**
   * Best-effort request for persistent (eviction-resistant) storage — part
   * of the client-only mitigation for accounts/dreams living only in
   * localStorage (see AGENT_POLICY.md's server-options section; this is
   * "Option 4" from that evaluation). navigator.storage.persist() is a
   * heuristic, not a guarantee — it does not fully prevent a browser like
   * mobile Safari from evicting storage under pressure or long inactivity
   * — but it's real, it costs nothing, and it lowers the odds. Asked once
   * per browser (guarded by a flag, itself in the same storage this is
   * trying to protect — if that gets evicted too, the flag resets and
   * this simply asks again next time, which is harmless), and only when
   * there's an actual account worth protecting.
   */
  var PERSIST_ASKED_KEY = 'dreamtube_persist_asked_v1';
  function maybeRequestPersistentStorage() {
    if (!state.user) return;
    try {
      if (localStorage.getItem(PERSIST_ASKED_KEY)) return;
      localStorage.setItem(PERSIST_ASKED_KEY, '1');
    } catch (e) { return; }
    try {
      if (navigator.storage && navigator.storage.persist) {
        navigator.storage.persist().catch(function () { /* denied or unsupported — silently fine, this is best-effort */ });
      }
    } catch (e) { /* not supported in this browser — silently skip */ }
  }
  maybeRequestPersistentStorage();

  /**
   * Tells PostHog "this browser is now this account" right after a real
   * signup/login succeeds, so behavior before/after auth stitches into one
   * person and cross-session identity works for whatever real accounts
   * exist today — and keeps working unchanged once a real backend/session
   * system replaces this localStorage one, since this is called from the
   * same signup()/login() seam a real implementation would use too.
   *
   * No-ops safely if PostHog was never initialized (POSTHOG_KEY is still
   * the placeholder in js/analytics-config.js — see that file), since
   * window.posthog simply won't exist in that case. Never lets an
   * analytics failure break auth.
   */
  function identifyForAnalytics(usernameOrEmail) {
    if (typeof window !== 'undefined' && window.posthog && typeof window.posthog.identify === 'function') {
      try { window.posthog.identify(usernameOrEmail); } catch (e) { /* analytics must never break auth */ }
    }
  }

  // ==========================================================================
  // Server-side account check (login + forgot-password from any device)
  // --------------------------------------------------------------------------
  // Everything below backs signup()/login()/resetPasswordLocally() below —
  // see register-account.js/account-login.js/verify-password-reset.js and
  // lib/account-store.js for the real, server-side half of this. This
  // deliberately does NOT sync dreams/characters — see
  // tracker.html's sync-private-dreams-videos-later item for that, explicitly
  // deferred and out of scope here.

  /** Writes a brand-new local account entry + signs in, exactly as signup() always has — used both when the server confirms the account was created, and as the offline/unreachable-server fallback below. */
  function commitLocalSignup(username, password, email) {
    var key = username.toLowerCase();
    state.accounts[key] = { password: password, email: email.toLowerCase() };
    state.user = { handle: '@' + username, username: username };
    persist();
    identifyForAnalytics(username);
    return { ok: true, user: state.user };
  }

  /** Maps register-account.js's error codes to the exact same human-readable strings signup() has always returned locally, so callers (e.g. start.html's attemptSignup, which string-matches 'That username is already taken.' to retry with a new suffix) don't need to know or care whether the rejection came from the server or a local check. */
  function mapRegisterError(code) {
    code = code || '';
    if (code.indexOf('email_taken') !== -1) return 'An account with that email already exists.';
    if (code.indexOf('invalid_username') !== -1) return 'Username must be at least 3 characters.';
    if (code.indexOf('invalid_password') !== -1) return 'Password must be at least 8 characters.';
    if (code.indexOf('invalid_email') !== -1) return 'Enter a valid email address.';
    if (code.indexOf('rate_limited') !== -1) return "Too many signups from this network today — try again tomorrow.";
    // E10 conflict — lib/account-store.js detected a concurrent write race
    // on this exact username/email and safely declined rather than risk a
    // corrupted account (see that file's own comment). Nothing was created
    // — the same submission is safe to retry as-is, no suffix/rename
    // needed like the username_taken case below.
    if (code.indexOf('conflict') !== -1) return 'Something went wrong creating your account — please try again.';
    // Default covers username_taken and anything else unexpected — matches
    // the original local-only error text for the single most common case.
    return 'That username is already taken.';
  }

  /**
   * The pre-fix, fully-local login check — kept as the fallback for an
   * account that was created before the server-side store existed and was
   * never registered there (see backfillAccountServerSide below, which
   * opportunistically closes that gap the next time this succeeds), and
   * for when the server call itself can't be reached at all. Never used
   * when the server affirmatively found the account but rejected the
   * password — see login() below for that distinction.
   */
  function attemptLocalLogin(usernameOrEmail, password) {
    var key = usernameOrEmail.toLowerCase();
    var loggedInViaEmail = false;
    if (!state.accounts[key]) {
      var emailKey = findAccountKeyByEmail(usernameOrEmail);
      if (emailKey) { key = emailKey; loggedInViaEmail = true; }
    }
    var account = state.accounts[key];
    if (!account) return { ok: false, error: 'No account found with that username or email.' };
    if (account.password !== password) return { ok: false, error: 'Incorrect password.' };
    var username = loggedInViaEmail ? key : usernameOrEmail;
    state.user = { handle: '@' + username, username: username };
    persist();
    identifyForAnalytics(username);
    backfillAccountServerSide(key, account);
    return { ok: true, user: state.user };
  }

  /**
   * Best-effort: the moment a legacy, local-only account (one that
   * predates the server-side account store) successfully logs in on the
   * device it already worked on, this registers it server-side too, using
   * whatever password/email are already on file locally — so login and
   * forgot-password start working from OTHER devices from this point
   * forward, without requiring the account to be recreated from scratch.
   * Fire-and-forget: never blocks the login that triggered it, and any
   * failure (e.g. the username/email got claimed by a different account
   * server-side in the meantime) is silently ignored — this account keeps
   * working locally on this device exactly as it does today either way.
   * Skipped entirely for an account with no email on file (predates email
   * being required) — there's nothing to register it with.
   *
   * Known, inherent edge case (not a bug to fix — see lib/account-store.js
   * for the full "no retroactive lockout" writeup this narrows): if the
   * SAME username was independently created as two different local-only
   * accounts on two different devices before this fix ever existed,
   * whichever one backfills here first permanently wins that username
   * server-side. The other device's own account keeps working locally on
   * IT (this function's own guarantee, above, is unaffected) — but that
   * device's login will start getting a genuine, server-confirmed
   * incorrect_password rejection with no local fallback the moment it
   * ever reaches a device/browser where its local cache is gone (a fresh
   * device, cleared storage, etc.), since account-login.js has no way to
   * know two different browsers ever shared this username. Unavoidable
   * consequence of retrofitting real uniqueness onto a system that
   * previously had none — there's no way to guess which of two
   * independently-created local accounts "should" own the name.
   */
  function backfillAccountServerSide(username, account) {
    if (!account || !account.email) return;
    try {
      fetch('/.netlify/functions/register-account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, password: account.password, email: account.email })
      }).catch(function () { /* best-effort — see doc comment above */ });
    } catch (e) { /* fetch unavailable/blocked — best-effort, ignore */ }
  }

  window.DreamStore = {
    STYLE_GRADIENTS: STYLE_GRADIENTS,

    getCurrentUser: function () { return state.user; },

    /**
     * Creates an account. Returns a Promise of { ok:true, user } or
     * { ok:false, error }. Checks the real server-side account store
     * first (register-account.js) — the authoritative uniqueness check
     * now, across every device, not just this browser's localStorage —
     * and mirrors the new account into local `accounts` on success so
     * nothing about this device's own dream/character logic changes. If
     * the server call itself can't be completed at all (offline, functions
     * runtime unreachable), degrades to a local-only account exactly like
     * this function always worked before — an explicit server-side
     * rejection (username/email already taken elsewhere) is never
     * downgraded to a local write, only a genuine failure-to-ask is.
     */
    signup: function (username, password, email) {
      username = (username || '').trim();
      var key = username.toLowerCase();
      email = (email || '').trim();
      if (username.length < 3) return Promise.resolve({ ok: false, error: 'Username must be at least 3 characters.' });
      if (!password) return Promise.resolve({ ok: false, error: 'Enter a password.' });
      if (password.length < 8) return Promise.resolve({ ok: false, error: 'Password must be at least 8 characters.' });
      if (!EMAIL_RE.test(email)) return Promise.resolve({ ok: false, error: 'Enter a valid email address.' });
      if (state.accounts[key]) return Promise.resolve({ ok: false, error: 'That username is already taken.' });
      if (findAccountKeyByEmail(email)) return Promise.resolve({ ok: false, error: 'An account with that email already exists.' });

      return fetch('/.netlify/functions/register-account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, password: password, email: email })
      }).then(function (res) {
        return res.json();
      }).then(function (data) {
        if (data && data.ok) return commitLocalSignup(username, password, email);
        if (data && data.ok === false && data.error) return { ok: false, error: mapRegisterError(data.error) };
        // Unexpected/malformed response shape — treat the same as
        // unreachable below rather than surface a confusing error.
        return commitLocalSignup(username, password, email);
      }).catch(function () {
        // Network failure, or the functions runtime isn't available at all
        // (e.g. this repo's own static-file-server-only browser tests) —
        // degrade to local-only signup rather than hard-block account
        // creation. See this method's own doc comment above.
        return commitLocalSignup(username, password, email);
      });
    },

    /**
     * Logs in with an existing account, identified by username OR email.
     * Returns a Promise of { ok:true, user } or { ok:false, error }.
     * Checks the real server-side account store first (account-login.js)
     * — this is what makes login work from any device the account was
     * ever registered from, not just the one it was created on. Falls
     * back to the pre-fix, fully-local check only when the server
     * explicitly has no matching account at all, or can't be reached —
     * never when it found the account but rejected the password, since a
     * registered server-side account is authoritative for its own
     * password once it exists there. The local fallback also
     * opportunistically registers a successful legacy login server-side
     * (see backfillAccountServerSide above), so it only ever needs to
     * fall back once per account before other devices work too.
     */
    login: function (usernameOrEmail, password) {
      usernameOrEmail = (usernameOrEmail || '').trim();

      return fetch('/.netlify/functions/account-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usernameOrEmail: usernameOrEmail, password: password })
      }).then(function (res) {
        return res.json();
      }).then(function (data) {
        if (data && data.ok) {
          var serverUsername = (data.username || '').toLowerCase();
          // No original casing to recover from a server-normalized
          // username — but if what was typed IS that username (not an
          // email), keep displaying it exactly as typed, same as the
          // pre-fix local-only login always did.
          var typedIsUsername = usernameOrEmail.toLowerCase() === serverUsername;
          var displayUsername = typedIsUsername ? usernameOrEmail : serverUsername;
          if (!state.accounts[serverUsername]) {
            // Brand-new-to-this-device account — materialize a local
            // placeholder so the rest of this app's local-storage-
            // dependent logic (character/dream filtering by username,
            // etc.) doesn't break from a missing accounts entry. Dreams/
            // characters for this username are deliberately left empty —
            // syncing those is out of scope, see
            // tracker.html's sync-private-dreams-videos-later item.
            state.accounts[serverUsername] = { password: password, email: (data.email || '').toLowerCase() };
          } else {
            // Already known locally (e.g. this is the account's original
            // device) — keep the local mirror in sync with whatever the
            // server just accepted, in case they'd drifted (e.g. a
            // password reset applied server-side from a different device
            // since).
            state.accounts[serverUsername].password = password;
            if (data.email) state.accounts[serverUsername].email = data.email.toLowerCase();
          }
          state.user = { handle: '@' + displayUsername, username: displayUsername };
          persist();
          identifyForAnalytics(displayUsername);
          return { ok: true, user: state.user };
        }
        if (data && data.ok === false && data.error && data.error.indexOf('incorrect_password') !== -1) {
          // The server found a REAL registered account but the password
          // didn't match it — trust that outright, no local fallback.
          return { ok: false, error: 'Incorrect password.' };
        }
        if (data && data.ok === false && data.error && data.error.indexOf('rate_limited') !== -1) {
          // account-login.js's own per-IP/per-identifier throttle tripped —
          // a deliberate rejection, not "no account found" or "server
          // unreachable". Falling back to attemptLocalLogin here would
          // silently defeat the whole point of that rate limit (this
          // browser's own local account cache would still let a match
          // through), so this is the one other explicit branch that never
          // falls back, same reasoning as incorrect_password above.
          return { ok: false, error: 'Too many login attempts — please wait and try again.' };
        }
        // Explicit "no account found" server-side, or an unexpected/
        // malformed response shape — fall back to the pre-fix local
        // check, so a legacy account never loses the ability to log in on
        // the device it already worked on. See attemptLocalLogin's own
        // comment.
        return attemptLocalLogin(usernameOrEmail, password);
      }).catch(function () {
        // Network failure / functions runtime unreachable — same
        // fallback as above.
        return attemptLocalLogin(usernameOrEmail, password);
      });
    },

    /**
     * Applies a new password after its reset token has been verified —
     * now a real, server-side password change (see
     * verify-password-reset.js's newPassword parameter and
     * lib/account-store.js's applyPasswordReset), not just a local-only
     * write. `token` is the same reset token login.html already has on
     * hand from the emailed link; this call both consumes it and applies
     * the password in one round trip. Also mirrors the new password into
     * this browser's local `accounts` entry (creating a placeholder if
     * this device never had the account locally at all — same shape
     * login() creates one, dreams/characters left empty by design) so an
     * immediate DreamStore.login() right after this succeeds without a
     * second round trip either way. Returns a Promise of
     * { ok:true, username, email } or { ok:false, error }.
     */
    resetPasswordLocally: function (token, newPassword) {
      if (!newPassword) return Promise.resolve({ ok: false, error: 'Enter a new password.' });
      if (newPassword.length < 8) return Promise.resolve({ ok: false, error: 'Password must be at least 8 characters.' });

      return fetch('/.netlify/functions/verify-password-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token, consume: true, newPassword: newPassword })
      }).then(function (res) {
        return res.json();
      }).then(function (data) {
        if (!data || !data.ok) {
          // E6 conflict (see verify-password-reset.js) means the token is
          // still valid and untouched — a concurrent write raced this one
          // server-side, nothing was actually saved, and the exact same
          // request is safe to retry. Everything else (missing/expired/
          // already-consumed token, or an unexpected response shape) keeps
          // the original message.
          var code = (data && data.error) || '';
          if (code.indexOf('conflict') !== -1) {
            return { ok: false, error: 'Something went wrong saving your new password — please try again.' };
          }
          return { ok: false, error: 'link_invalid_or_expired' };
        }
        var key = (data.username || '').toLowerCase();
        if (state.accounts[key]) {
          state.accounts[key].password = newPassword;
          if (data.email) state.accounts[key].email = data.email.toLowerCase();
        } else {
          state.accounts[key] = { password: newPassword, email: (data.email || '').toLowerCase() };
        }
        persist();
        return { ok: true, username: data.username, email: data.email };
      }).catch(function () {
        return { ok: false, error: 'network_error' };
      });
    },

    /** The current user's email on file, or null — accounts created before email was required migrated with no email at all. */
    getAccountEmail: function () {
      return currentAccountEmail();
    },

    /**
     * Sets/changes the email on the current user's account — the only way
     * an account that predates email can start using forgot-password.
     * Still local-only (unlike signup()/login()/resetPasswordLocally()
     * above) — a changed email here is NOT mirrored to the server-side
     * account store, so forgot-password/cross-device login continue to
     * resolve by whatever email the server has on file (from signup, or
     * from a prior successful login/reset — see backfillAccountServerSide)
     * until this account goes through one of those paths again. Out of
     * scope for the cross-device account-check fix; flagged as a follow-on
     * gap, not fixed here. Returns { ok:true } or { ok:false, error }.
     */
    updateEmail: function (email) {
      if (!state.user) return { ok: false, error: 'not_logged_in' };
      email = (email || '').trim();
      if (!EMAIL_RE.test(email)) return { ok: false, error: 'Enter a valid email address.' };
      var key = state.user.username.toLowerCase();
      var existingKey = findAccountKeyByEmail(email);
      if (existingKey && existingKey !== key) return { ok: false, error: 'Another account already uses that email.' };
      state.accounts[key].email = email.toLowerCase();
      persist();
      return { ok: true };
    },

    logout: function () { state.user = null; persist(); },

    // state.dreams isn't cleared on logout/login — it's the same array for
    // every account that's ever used this browser — so "mine" has to be
    // recomputed against whoever is signed in *now*, not trusted from a
    // flag written back when the dream was created under a possibly
    // different account.
    getMyDreams: function () {
      var myHandle = state.user ? state.user.handle : null;
      return state.dreams.filter(function (d) { return !!myHandle && d.ownerHandle === myHandle; });
    },

    /**
     * Recurring dream-theme pattern for the Profile insight card (idea #4).
     * Returns { theme, count, total } or null if no real pattern exists
     * yet — callers must hide the card entirely on null, never show an
     * empty/placeholder state.
     */
    getDreamInsight: function () {
      var myHandle = state.user ? state.user.handle : null;
      var mine = state.dreams.filter(function (d) { return !!myHandle && d.ownerHandle === myHandle; });
      return detectDreamTheme(mine);
    },

    /**
     * Dream-count milestone for the Profile milestone chip (idea #5).
     * Returns { count, latestMilestone, label } or null if the user has
     * no dreams yet. A plain count that only ever goes up — no streak
     * that can break if a day is skipped.
     */
    getDreamMilestone: function () {
      var myHandle = state.user ? state.user.handle : null;
      var count = state.dreams.filter(function (d) { return !!myHandle && d.ownerHandle === myHandle; }).length;
      if (!count) return null;
      var latest = DREAM_MILESTONES[0];
      DREAM_MILESTONES.forEach(function (m) { if (count >= m) latest = m; });
      return { count: count, latestMilestone: latest, label: ordinal(latest) + ' dream' };
    },

    /**
     * Exports the signed-in user's account + dreams + characters as a
     * plain JSON-serializable object — the other half of the client-only
     * mitigation alongside maybeRequestPersistentStorage above. This
     * browser's storage is the only copy of this data today, so this is
     * the only way to survive it being cleared/evicted: download it, keep
     * the file somewhere safe, restore via importAccountBackup below.
     * Returns null if not logged in. Includes the account password in
     * plain text — same as how it's already stored locally (see the
     * signup/login comments on that being a known, documented limitation
     * of this pre-real-backend app) — so the exported file itself is
     * sensitive and the UI prompting a download should say so.
     */
    getAccountBackup: function () {
      if (!state.user) return null;
      var key = state.user.username.toLowerCase();
      var account = state.accounts[key];
      if (!account) return null;
      var myHandle = state.user.handle;
      return {
        dreamtubeBackupVersion: 1,
        exportedAt: new Date().toISOString(),
        username: state.user.username,
        account: { password: account.password, email: account.email || null },
        dreams: state.dreams.filter(function (d) { return d.ownerHandle === myHandle; }),
        characters: state.charactersByUser[key] || []
      };
    },

    /**
     * Restores a backup produced by getAccountBackup() into this browser
     * and logs in as that account. Refuses to overwrite an existing local
     * account under the same username — that's either the same account
     * (nothing to import) or a genuine collision, and silently picking a
     * winner in either case would be the wrong call; the user is told to
     * log in normally or resolve it themselves instead. Dreams are merged
     * by id (skips any already present locally) rather than replacing the
     * whole array, so this is safe to run even if some of the backed-up
     * dreams somehow already exist on this device. Returns { ok:true,
     * user } or { ok:false, error }.
     */
    importAccountBackup: function (backup) {
      if (!backup || typeof backup !== 'object' || backup.dreamtubeBackupVersion !== 1 || !backup.username || !backup.account) {
        return { ok: false, error: "That file doesn't look like a DreamTube backup." };
      }
      var key = backup.username.toLowerCase();
      if (state.accounts[key]) {
        return { ok: false, error: 'An account with that username already exists on this device — log in normally instead.' };
      }
      state.accounts[key] = { password: backup.account.password, email: backup.account.email || null };
      var existingIds = {};
      state.dreams.forEach(function (d) { existingIds[d.id] = true; });
      (backup.dreams || []).forEach(function (d) {
        if (!existingIds[d.id]) state.dreams.push(d);
      });
      state.charactersByUser[key] = backup.characters || [];
      state.user = { handle: '@' + backup.username, username: backup.username };
      persist();
      identifyForAnalytics(backup.username);
      return { ok: true, user: state.user };
    },

    getDream: function (id) { return findDream(id); },
    gradientFor: gradientFor,

    toggleLike: function (id) {
      var d = findDream(id);
      if (!d) return null;
      d.likedByMe = !d.likedByMe;
      d.likes += d.likedByMe ? 1 : -1;
      persist();
      return d;
    },

    getDraft: function () { return state.draft; },
    setDraft: function (patch) { Object.assign(state.draft, patch); persist(); },
    clearDraft: function () { state.draft = { caption: '', style: null, sourceDreamId: null, restore: false, characterIds: [], cameraView: null, sceneryTime: null, sceneryPlace: null }; persist(); },

    /** Creates a brand new dream via fal.ai. Returns a Promise that resolves once the video is ready. opts: { characterIds, cameraView, sceneryTime, sceneryPlace, turnstileToken }. */
    generateVideo: function (caption, style, opts) {
      opts = opts || {};
      return startGeneration(caption, style, {
        characterIds: opts.characterIds, cameraView: opts.cameraView,
        sceneryTime: opts.sceneryTime, sceneryPlace: opts.sceneryPlace,
        turnstileToken: opts.turnstileToken
      });
    },

    /** Re-runs generation on an existing dream (Edit Dream / Try Again), including any selected Advanced fields. */
    regenerateDream: function (id, patch) {
      return startGeneration(patch.caption, patch.style, {
        sourceDreamId: id, characterIds: patch.characterIds,
        cameraView: patch.cameraView, sceneryTime: patch.sceneryTime, sceneryPlace: patch.sceneryPlace,
        turnstileToken: patch.turnstileToken
      });
    },

    /** The in-flight generation job, if any — survives navigation/refresh so Home can resume polling it. */
    getPendingJob: function () { return state.pendingJob; },

    /** Marks the pending job so its completion fires a real Notification wherever it resolves. */
    requestNotifyOnReady: function () {
      if (state.pendingJob) { state.pendingJob.notify = true; persist(); }
    },

    /** Resumes polling a pending job left over from a previous page (e.g. the user left Processing). */
    resumePendingJob: function () {
      var job = state.pendingJob;
      if (!job) return Promise.reject(new Error('no_pending_job'));
      return startGeneration(job.caption, job.style, {
        sourceDreamId: job.sourceDreamId,
        resume: { operationName: job.operationName, startedAt: job.startedAt }
      });
    },

    publishDream: function (id) {
      var d = findDream(id);
      if (d) {
        d.isPublished = true;
        persist();
        syncPublishedDreamToFeed(d);
      }
      return d;
    },

    /** Takes one of the current user's own dreams back out of Explore. */
    unpublishDream: function (id) {
      var d = findDream(id);
      if (d) {
        d.isPublished = false;
        persist();
        removePublishedDreamFromFeed(id);
      }
      return d;
    },

    /** Deletes one of the current user's own dreams. Returns true if a dream was removed. */
    deleteDream: function (id) {
      var d = findDream(id);
      var myHandle = state.user ? state.user.handle : null;
      if (!d || !myHandle || d.ownerHandle !== myHandle) return false;
      var wasPublished = d.isPublished;
      state.dreams = state.dreams.filter(function (dream) { return dream.id !== id; });
      persist();
      if (wasPublished) removePublishedDreamFromFeed(id);
      return true;
    },

    /**
     * Reads a dream's saved "what this might mean" reflection, if any —
     * purely local, no network call. Returns null if the dream doesn't
     * exist; otherwise { interpretationText, interpretationAt }, both null
     * if one has never been generated (or was cleared by a regenerate, see
     * finalizeDream above).
     */
    getInterpretation: function (id) {
      var d = findDream(id);
      if (!d) return null;
      return { interpretationText: d.interpretationText || null, interpretationAt: d.interpretationAt || null };
    },

    /**
     * Generates (or regenerates) the dream's "what this might mean"
     * reflection via interpret-dream.js, POSTing { caption, style } from
     * the current dream record. Always opt-in — result.html only ever
     * calls this from a direct user tap (the initial CTA, or the sheet's
     * Regenerate affordance), never automatically. On success, writes
     * interpretationText/interpretationAt onto the dream and persists,
     * then resolves with the saved { interpretationText, interpretationAt }.
     * On failure, rejects with an Error whose message is the function's own
     * "E4NN: reason" string (see interpret-dream.js's header comment for
     * the code list) — result.html treats every rejection here uniformly
     * as its Direction B error state, isolated from the rest of the Result
     * screen (video playback, Edit, Publish, Delete are all unaffected).
     *
     * This is a private, local-only write: nothing here calls
     * syncPublishedDreamToFeed, and interpretationText/interpretationAt are
     * never part of that function's payload (see it above) — so this stays
     * off the shared feed even for a dream that's already published.
     */
    generateInterpretation: function (id) {
      var d = findDream(id);
      if (!d) return Promise.reject(new Error('not_found'));
      return fetch('/.netlify/functions/interpret-dream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caption: d.caption, style: d.style })
      }).then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) throw new Error(data.error || 'E407: empty_or_invalid_response');
          var dream = findDream(id);
          if (dream) {
            dream.interpretationText = data.interpretation;
            dream.interpretationAt = Date.now();
            persist();
          }
          return { interpretationText: data.interpretation, interpretationAt: dream ? dream.interpretationAt : null };
        });
      }, function (err) {
        throw new Error('network_error_requesting_interpretation' + (err && err.message ? ': ' + err.message : ''));
      });
    },

    /**
     * The real, cross-browser shared feed — every published dream from
     * every user, fetched from Blobs via get-feed.js. Adds mine/likedByMe
     * per-viewer, computed locally since the shared record itself carries
     * neither (no real accounts to know who's asking).
     */
    getSharedFeed: function () {
      return fetch('/.netlify/functions/get-feed').then(function (res) {
        return res.json();
      }).then(function (data) {
        if (data.error) throw new Error(data.error);
        lastDreamOfDayId = data.dreamOfDayId || null;
        var likedIds = state.likedIds || {};
        var myHandle = state.user ? state.user.handle : null;
        return (data.feed || []).map(function (d) {
          return Object.assign({}, d, {
            likedByMe: !!likedIds[d.id],
            mine: !!myHandle && d.ownerHandle === myHandle
          });
        });
      });
    },

    /**
     * The shared Dream of the Day pick's id, as of the most recent
     * getSharedFeed() call — server-computed (see get-feed.js's
     * resolveDreamOfDay), same for every visitor on a given calendar day,
     * and excludes dreams that have already had a previous day's turn.
     * null if getSharedFeed hasn't resolved yet, or there's nothing to pick.
     */
    getLastDreamOfDayId: function () {
      return lastDreamOfDayId;
    },

    /** Toggles a like against the real shared count. Returns a Promise of { likes, likedByMe }. */
    toggleSharedLike: function (id, currentlyLiked) {
      return fetch('/.netlify/functions/like-dream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: id, delta: currentlyLiked ? -1 : 1 })
      }).then(function (res) {
        return res.json();
      }).then(function (data) {
        if (data.error) throw new Error(data.error);
        if (!state.likedIds) state.likedIds = {};
        if (currentlyLiked) delete state.likedIds[id]; else state.likedIds[id] = true;
        persist();
        return { likes: data.likes, likedByMe: !currentlyLiked };
      });
    },

    reset: function () { state = seed(); persist(); },

    /** This user's saved characters, self first. */
    getCharacters: function () {
      var list = myCharacterList().slice();
      list.sort(function (a, b) { return (b.isSelf ? 1 : 0) - (a.isSelf ? 1 : 0); });
      return list;
    },

    /**
     * Creates or updates a character. patch: { id?, name, isSelf, description, photoDataUrl }.
     * Only one isSelf character is allowed per user — saving a second one
     * edits the existing "Me" instead of creating a duplicate, since a
     * person only needs to define themselves once.
     *
     * Safety boundary, not just a UI gap: photoDataUrl is only ever stored
     * when isSelf is true — for every other character it's silently
     * dropped here, regardless of what the caller passes, so there's no
     * path (UI bug or otherwise) that ends with a photo attached to
     * someone other than the user themselves. Non-self characters always
     * require a text description; a self character needs a description OR
     * a photo (at least one), matching the "either/or" picker in the UI.
     * Returns { ok:true, character } or { ok:false, error }.
     */
    saveCharacter: function (patch) {
      if (!state.user) return { ok: false, error: 'not_logged_in' };
      var name = (patch.name || '').trim();
      var description = (patch.description || '').trim();
      var isSelf = !!patch.isSelf;
      var photoDataUrl = (isSelf && patch.photoDataUrl) ? patch.photoDataUrl : null;

      if (!isSelf && !name) return { ok: false, error: 'Give this character a name.' };
      if (!description && !photoDataUrl) return { ok: false, error: isSelf ? 'Add a description or a photo.' : 'Add a short description.' };

      var list = myCharacterList();
      var existing = patch.id ? findCharacter(patch.id) : null;
      if (!existing && isSelf) existing = list.filter(function (c) { return c.isSelf; })[0] || null;

      if (existing) {
        existing.name = isSelf ? (name || 'Me') : name;
        existing.description = description;
        if (isSelf) existing.photoDataUrl = photoDataUrl; else delete existing.photoDataUrl;
        persist();
        return { ok: true, character: existing };
      }

      var character = { id: newCharId(), name: isSelf ? (name || 'Me') : name, isSelf: isSelf, description: description };
      if (isSelf && photoDataUrl) character.photoDataUrl = photoDataUrl;
      list.push(character);
      persist();
      return { ok: true, character: character };
    },

    /** Deletes one of the current user's own characters. Returns true if a character was removed. */
    deleteCharacter: function (id) {
      var list = myCharacterList();
      var before = list.length;
      var filtered = list.filter(function (c) { return c.id !== id; });
      if (filtered.length === before) return false;
      state.charactersByUser[state.user.username.toLowerCase()] = filtered;
      persist();
      return true;
    },

    /**
     * Device-level video sound preference (not account-scoped — like a
     * volume setting, it should stick regardless of who's signed in).
     * Every <video> in the app starts muted (required for autoplay to
     * work at all), but once a user explicitly unmutes one, later videos
     * they open should stay unmuted too rather than silently re-muting.
     */
    getSoundPref: function () {
      try { return localStorage.getItem('dreamtube_sound_on') === '1'; }
      catch (e) { return false; }
    },
    setSoundPref: function (on) {
      try { localStorage.setItem('dreamtube_sound_on', on ? '1' : '0'); }
      catch (e) { /* ignore (private browsing / storage disabled) */ }
    },

    /**
     * Device-level "have I already been shown today's Dream of the Day
     * pinned to the top of Explore" marker (see explore.html's render/
     * loadFeed). Without this, the same card got forced back to position 0
     * of the feed on every single visit within the same day, not just the
     * first. Since the id itself now changes daily (see get-feed.js's
     * resolveDreamOfDay), comparing against this naturally re-triggers the
     * pin+badge exactly once per new day's pick, with no extra date
     * bookkeeping needed here. Device-level (not account-scoped) for the
     * same reason as getSoundPref: Explore is browsable while logged out
     * too.
     */
    getSeenDreamOfDayId: function () {
      try { return localStorage.getItem('dreamtube_dod_seen_id'); }
      catch (e) { return null; }
    },
    markDreamOfDaySeen: function (id) {
      try { localStorage.setItem('dreamtube_dod_seen_id', id); }
      catch (e) { /* ignore (private browsing / storage disabled) */ }
    },

    /**
     * Reads the signed-in account's current token balance — see
     * netlify/functions/lib/entitlements.js's getTokenStatus for the full
     * grant mechanism (200 on first-ever read, +100/24h lazily thereafter,
     * capped once balance is already ≥500). Resolves to
     * { balance:0, nextGrantAt:null, dailyGrantAmount:100 } with no network
     * call at all when there's no logged-in account or no email on file
     * (a legacy account that never added one — signup requires an email
     * today, see signup() above) since the server side has nothing to key
     * a balance on without one either way. Used by profile.html's/
     * style.html's/result.html's/processing.html's/shop.html's token UI —
     * the real enforcement is generate-video.js's server-side E112 check,
     * this is never the security boundary.
     */
    getTokenStatus: function () {
      var email = currentAccountEmail();
      if (!email) return Promise.resolve({ balance: 0, nextGrantAt: null, dailyGrantAmount: 100 });
      return fetch('/.netlify/functions/get-token-status?email=' + encodeURIComponent(email))
        .then(function (res) { return res.json(); })
        .then(function (data) {
          if (data.error) throw new Error(data.error);
          return data;
        });
    }
  };
})();
