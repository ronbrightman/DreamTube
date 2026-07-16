// js/store.js
//
// Plain script (no ES modules — works with file:// and every static host, no MIME issues).
// Acts as a fake backend using localStorage so state survives real page navigations.
// Every method is written to mirror a real REST call; swap the body for a fetch()
// when a real backend exists and nothing on any page needs to change.
//
//   login(email)              -> POST /api/auth/login
//   getFeed()                 -> GET  /api/dreams?published=true
//   getMyDreams()               -> GET  /api/users/me/dreams
//   getDream(id)                -> GET  /api/dreams/:id
//   toggleLike(id)               -> POST /api/dreams/:id/like
//   generateVideo(caption,style) -> POST /api/dreams/generate
//   regenerateDream(id, patch)   -> POST /api/dreams/:id/regenerate
//   publishDream(id)              -> POST /api/dreams/:id/publish

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
      draft: { caption: '', style: null, sourceDreamId: null, restore: false },
      dreams: [],
      pendingJob: null
    };
  }

  // One-time migration: browsers that loaded the app before mock dreams were
  // removed still have the old seed data (ids "d0".."d5") saved locally.
  var LEGACY_MOCK_ID = /^d[0-5]$/;
  function stripLegacyMockDreams(s) {
    var before = s.dreams.length;
    s.dreams = s.dreams.filter(function (d) { return !LEGACY_MOCK_ID.test(d.id); });
    return s.dreams.length !== before;
  }

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) { var s = seed(); localStorage.setItem(KEY, JSON.stringify(s)); return s; }
      var parsed = JSON.parse(raw);
      if (!parsed.dreams) throw new Error('bad state');
      if (stripLegacyMockDreams(parsed)) {
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

  function savePendingJob(job) { state.pendingJob = job; persist(); }
  function clearPendingJob() { state.pendingJob = null; persist(); }

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

    var operationPromise = resume
      ? Promise.resolve(resume.operationName)
      : fetch('/.netlify/functions/generate-video', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ caption: caption, style: style })
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

  window.DreamStore = {
    STYLE_GRADIENTS: STYLE_GRADIENTS,

    getCurrentUser: function () { return state.user; },
    login: function (email) {
      state.user = { handle: '@you', email: email || 'you@example.com' };
      persist();
      return state.user;
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
    clearDraft: function () { state.draft = { caption: '', style: null, sourceDreamId: null, restore: false }; persist(); },

    /** Creates a brand new dream via fal.ai. Returns a Promise that resolves once the video is ready. */
    generateVideo: function (caption, style) {
      return startGeneration(caption, style);
    },

    /** Re-runs generation on an existing dream (Edit Dream / Change Style / Try Again). */
    regenerateDream: function (id, patch) {
      return startGeneration(patch.caption, patch.style, { sourceDreamId: id });
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
      if (d) { d.isPublished = true; persist(); }
      return d;
    },

    reset: function () { state = seed(); persist(); }
  };
})();
