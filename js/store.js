// js/store.js
//
// Plain script (no ES modules — works with file:// and every static host, no MIME issues).
// Acts as a fake backend using localStorage so state survives real page navigations.
// Every method is written to mirror a real REST call; swap the body for a fetch()
// when a real backend exists and nothing on any page needs to change.
//
//   signup(username,password) -> POST /api/auth/signup
//   login(username,password)  -> POST /api/auth/login
//   getFeed()                 -> GET  /api/dreams?published=true (local-only; see getSharedFeed)
//   getSharedFeed()             -> GET  /.netlify/functions/get-feed (real, cross-browser)
//   toggleSharedLike(id,liked)   -> POST /.netlify/functions/like-dream
//   getMyDreams()               -> GET  /api/users/me/dreams
//   getDream(id)                -> GET  /api/dreams/:id
//   toggleLike(id)               -> POST /api/dreams/:id/like
//   generateVideo(caption,style,characterIds) -> POST /api/dreams/generate
//   regenerateDream(id, patch)   -> POST /api/dreams/:id/regenerate
//   publishDream(id)              -> POST /api/dreams/:id/publish
//   deleteDream(id)                 -> DELETE /api/dreams/:id
//   getCharacters()                   -> GET  /api/users/me/characters
//   saveCharacter(patch)                -> POST /api/users/me/characters[/:id]
//   deleteCharacter(id)                   -> DELETE /api/users/me/characters/:id

(function () {
  var KEY = 'dreamtube_state_v1';
  var POLL_INTERVAL_MS = 10000;
  var MAX_POLL_MS = 6 * 60 * 1000;

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
      draft: { caption: '', style: null, sourceDreamId: null, restore: false, characterIds: [] },
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
  //  - a pendingJob left over from a Veo-era operation (not "fal:"-prefixed)
  //    — resuming it would route into the dead/zero-quota Veo fallback and
  //    hijack a fresh generation attempt instead of starting one
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

    if (s.pendingJob && (!s.pendingJob.operationName || s.pendingJob.operationName.indexOf('fal:') !== 0)) {
      s.pendingJob = null;
      changed = true;
    }

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

  function newId() { return 'd' + Math.random().toString(36).slice(2, 9); }
  function findDream(id) {
    for (var i = 0; i < state.dreams.length; i++) if (state.dreams[i].id === id) return state.dreams[i];
    return null;
  }
  function gradientFor(d) { return STYLE_GRADIENTS[d.style] || STYLE_GRADIENTS.Cinematic; }

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
   * Maps selected character ids to the plain {name, description, isSelf}
   * shape the generation API needs — ids are meaningless outside this
   * browser's localStorage, so only the resolved fields cross the network.
   */
  function resolveCharacters(ids) {
    if (!ids || !ids.length) return [];
    return ids.map(findCharacter).filter(Boolean).map(function (c) {
      return { name: c.name, description: c.description, isSelf: !!c.isSelf };
    });
  }

  function savePendingJob(job) { state.pendingJob = job; persist(); }
  function clearPendingJob() { state.pendingJob = null; persist(); }

  /**
   * Fire-and-forget upsert into the shared feed-index blob. Local state is
   * always the source of truth for the owner's own view (Profile) — if this
   * fails, the dream still shows as published locally, it just might not
   * (yet) appear in others' Explore/Home until the next successful sync.
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
        if (Date.now() - startedAt > MAX_POLL_MS) { reject(new Error('generation_timeout')); return; }
        fetch('/.netlify/functions/video-status?name=' + encodeURIComponent(operationName))
          .then(function (res) { return res.json(); })
          .then(function (data) {
            if (data.error) { reject(new Error(data.error)); return; }
            if (data.done) { resolve(data.videoUrl); return; }
            setTimeout(poll, POLL_INTERVAL_MS);
          })
          .catch(reject);
      }
      poll();
    });
  }

  function finalizeDream(videoUrl, caption, style, sourceDreamId) {
    var dream;
    if (sourceDreamId) {
      dream = findDream(sourceDreamId);
      if (!dream) throw new Error('not_found');
      Object.assign(dream, { caption: caption, style: style, videoUrl: videoUrl });
    } else {
      dream = {
        id: newId(),
        ownerHandle: state.user ? state.user.handle : '@you',
        caption: caption, style: style,
        likes: 0, likedByMe: false, dur: '0:08', mine: true, isPublished: false,
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
          body: JSON.stringify({ caption: caption, style: style, characters: characters })
        }).then(function (res) {
          return res.json().then(function (data) {
            if (!res.ok) throw new Error(data.error || 'generation_failed');
            return data.operationName;
          });
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
      return finalizeDream(videoUrl, caption, style, sourceDreamId);
    }).catch(function (err) {
      clearPendingJob();
      throw err;
    });
  }

  var state = load();
  backfillSharedFeed();

  window.DreamStore = {
    STYLE_GRADIENTS: STYLE_GRADIENTS,

    getCurrentUser: function () { return state.user; },

    /** Creates an account. Returns { ok:true, user } or { ok:false, error }. */
    signup: function (username, password) {
      username = (username || '').trim();
      var key = username.toLowerCase();
      if (username.length < 3) return { ok: false, error: 'Username must be at least 3 characters.' };
      if (!password) return { ok: false, error: 'Enter a password.' };
      if (state.accounts[key]) return { ok: false, error: 'That username is already taken.' };
      state.accounts[key] = password;
      state.user = { handle: '@' + username, username: username };
      persist();
      return { ok: true, user: state.user };
    },

    /** Logs in with an existing account. Returns { ok:true, user } or { ok:false, error }. */
    login: function (username, password) {
      username = (username || '').trim();
      var key = username.toLowerCase();
      if (!state.accounts[key]) return { ok: false, error: 'No account found with that username.' };
      if (state.accounts[key] !== password) return { ok: false, error: 'Incorrect password.' };
      state.user = { handle: '@' + username, username: username };
      persist();
      return { ok: true, user: state.user };
    },

    logout: function () { state.user = null; persist(); },

    getFeed: function () {
      return state.dreams.filter(function (d) { return d.isPublished; });
    },
    getMyDreams: function () {
      return state.dreams.filter(function (d) { return d.mine; });
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
    clearDraft: function () { state.draft = { caption: '', style: null, sourceDreamId: null, restore: false, characterIds: [] }; persist(); },

    /** Creates a brand new dream via fal.ai. Returns a Promise that resolves once the video is ready. */
    generateVideo: function (caption, style, characterIds) {
      return startGeneration(caption, style, { characterIds: characterIds });
    },

    /** Re-runs generation on an existing dream (Edit Dream / Try Again), including any selected Advanced characters. */
    regenerateDream: function (id, patch) {
      return startGeneration(patch.caption, patch.style, { sourceDreamId: id, characterIds: patch.characterIds });
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

    /** Deletes one of the current user's own dreams. Returns true if a dream was removed. */
    deleteDream: function (id) {
      var d = findDream(id);
      if (!d || !d.mine) return false;
      var wasPublished = d.isPublished;
      state.dreams = state.dreams.filter(function (dream) { return dream.id !== id; });
      persist();
      if (wasPublished) {
        fetch('/.netlify/functions/unpublish-dream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: id })
        }).catch(function () { /* best-effort, matches syncPublishedDreamToFeed */ });
      }
      return true;
    },

    /**
     * The real, cross-browser shared feed — every published dream from
     * every user, fetched from Blobs via get-feed.js. Unlike getFeed()
     * (this browser's own local copy of dreams it happens to know about),
     * this is genuinely shared. Adds mine/likedByMe per-viewer, computed
     * locally since the shared record itself carries neither (no real
     * accounts to know who's asking).
     */
    getSharedFeed: function () {
      return fetch('/.netlify/functions/get-feed').then(function (res) {
        return res.json();
      }).then(function (data) {
        if (data.error) throw new Error(data.error);
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
     * Creates or updates a character. patch: { id?, name, isSelf, description }.
     * Only one isSelf character is allowed per user — saving a second one
     * edits the existing "Me" instead of creating a duplicate, since a
     * person only needs to define themselves once. Text-only by design:
     * a photo option only ever appears in the UI for isSelf, and this
     * method doesn't accept photo data for anyone else either.
     * Returns { ok:true, character } or { ok:false, error }.
     */
    saveCharacter: function (patch) {
      if (!state.user) return { ok: false, error: 'not_logged_in' };
      var name = (patch.name || '').trim();
      var description = (patch.description || '').trim();
      var isSelf = !!patch.isSelf;
      if (!isSelf && !name) return { ok: false, error: 'Give this character a name.' };
      if (!description) return { ok: false, error: 'Add a short description.' };

      var list = myCharacterList();
      var existing = patch.id ? findCharacter(patch.id) : null;
      if (!existing && isSelf) existing = list.filter(function (c) { return c.isSelf; })[0] || null;

      if (existing) {
        existing.name = isSelf ? (name || 'Me') : name;
        existing.description = description;
        persist();
        return { ok: true, character: existing };
      }

      var character = { id: newCharId(), name: isSelf ? (name || 'Me') : name, isSelf: isSelf, description: description };
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
    }
  };
})();
