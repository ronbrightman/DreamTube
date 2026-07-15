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
  var FAIL_RATE = 0.12;

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
      dreams: [
        { id: 'd0', ownerHandle: '@dreamer_92', caption: 'Falling through clouds of paint', style: 'Anime', likes: 2300, likedByMe: false, dur: '0:14', mine: false, isPublished: true },
        { id: 'd1', ownerHandle: '@nightowl', caption: 'A staircase made of static', style: 'Cinematic', likes: 980, likedByMe: false, dur: '0:22', mine: false, isPublished: true },
        { id: 'd2', ownerHandle: '@you', caption: 'Flying over a city made of glass', style: 'Cinematic', likes: 112, likedByMe: false, dur: '0:18', mine: true, isPublished: true },
        { id: 'd3', ownerHandle: '@luma', caption: 'A talking cat in the school hallway', style: 'Cartoon', likes: 5100, likedByMe: false, dur: '0:11', mine: false, isPublished: true },
        { id: 'd4', ownerHandle: '@you', caption: 'Swimming through a library at night', style: 'Realistic', likes: 64, likedByMe: false, dur: '0:20', mine: true, isPublished: false },
        { id: 'd5', ownerHandle: '@mirage', caption: 'The train that never arrives', style: 'Anime', likes: 1700, likedByMe: false, dur: '0:16', mine: false, isPublished: true }
      ]
    };
  }

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) { var s = seed(); localStorage.setItem(KEY, JSON.stringify(s)); return s; }
      var parsed = JSON.parse(raw);
      if (!parsed.dreams) throw new Error('bad state');
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

    /** Creates a brand new dream. Returns a Promise; ~12% simulated failure rate, same as a real pipeline. */
    generateVideo: function (caption, style) {
      return new Promise(function (resolve, reject) {
        var delay = 2200 + Math.random() * 1200;
        setTimeout(function () {
          if (Math.random() < FAIL_RATE) { reject(new Error('generation_failed')); return; }
          var dream = {
            id: newId(),
            ownerHandle: state.user ? state.user.handle : '@you',
            caption: caption, style: style,
            likes: 0, likedByMe: false, dur: '0:15', mine: true, isPublished: false
          };
          state.dreams.unshift(dream);
          persist();
          resolve(dream);
        }, delay);
      });
    },

    /** Re-runs generation on an existing dream (Edit Dream / Change Style / Try Again). */
    regenerateDream: function (id, patch) {
      return new Promise(function (resolve, reject) {
        var delay = 2000 + Math.random() * 1200;
        setTimeout(function () {
          if (Math.random() < FAIL_RATE) { reject(new Error('generation_failed')); return; }
          var d = findDream(id);
          if (!d) { reject(new Error('not_found')); return; }
          Object.assign(d, patch);
          persist();
          resolve(d);
        }, delay);
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
