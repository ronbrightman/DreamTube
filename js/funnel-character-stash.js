// js/funnel-character-stash.js
//
// The app-side CONSUMING half of the growth funnel's character stash
// (tracker context: growth flo-arm character sheet, 2026-08-08). The
// funnel's flo arm runs this app's own character-sheet mechanism on its
// "Who's the dream about?" step — Me can carry a description OR a photo,
// Someone-I-know a name + description. A photo cannot ride the URL-param
// handoff, but on the same-origin /go/ deployments (dreamtube.life/go/,
// dreamtube1.netlify.app/go/ — see netlify.toml's /go/* proxy) funnel and
// app share localStorage: the funnel's redirectToApp() writes the records
// under KEY below ({ v:1, savedAt, characters:[{ isSelf, name,
// description, photoDataUrl? }] }) just before navigating, and the
// funnel-arrival page consumes them here into its own pre-signup
// character staging, so generation sees the photo/description exactly as
// if they had been entered in the app itself.
//
// Shared by BOTH funnel-arrival pages — wizard.html's funnel-arrival wall
// leg (the Layout-B wall flo arrivals route to) and start.html's resume
// leg (the old arm's unchanged target) — as a plain script, the same way
// those pages already share js/store.js / js/sheet-dismiss.js (this
// static site has no modules/bundler; see CLAUDE.md).
//
// consume() semantics (deliberately strict — every rule mirrors the
// sheets' own Save validation and the FB_STAGED_KEY discipline):
//   - ONE-SHOT: the key is removed immediately, win or lose, so a stale
//     snapshot can never be adopted by a later, unrelated run.
//   - AGE-BOUND: records older than MAX_AGE_MS (30 min, same bound as
//     start.html's FB_STAGED_MAX_AGE_MS) are discarded.
//   - VALIDATION FLOOR: desc-or-photo required; a non-self character
//     needs a name; photos are SELF-ONLY and must be a real
//     data:image/* URL — anything else is dropped, never forwarded to
//     generation. Nothing DreamStore.saveCharacter would reject at
//     flush time is ever adopted.
// Returns ready-to-stage character records ({ id, name, isSelf,
// description[, photoDataUrl] }) with fresh local ids — the caller
// pushes them into its own `staged` arrays and selects them.
(function(){
  'use strict';

  var KEY = 'dreamtube_funnel_character_stash';
  var MAX_AGE_MS = 30 * 60 * 1000;

  function consume(){
    var raw = null;
    try{ raw = localStorage.getItem(KEY); }catch(e){ raw = null; }
    try{ localStorage.removeItem(KEY); }catch(e){ /* private mode — nothing persisted anyway */ }
    if(!raw) return [];
    var out = [];
    try{
      var parsed = JSON.parse(raw);
      if(!parsed || parsed.v !== 1 || !Array.isArray(parsed.characters)) return [];
      if(!parsed.savedAt || (Date.now() - parsed.savedAt) > MAX_AGE_MS) return [];
      parsed.characters.forEach(function(c){
        if(!c) return;
        var isSelf = !!c.isSelf;
        var name = typeof c.name === 'string' ? c.name.trim() : '';
        var description = typeof c.description === 'string' ? c.description.trim() : '';
        var photoDataUrl = (isSelf && typeof c.photoDataUrl === 'string' && c.photoDataUrl.indexOf('data:image/') === 0) ? c.photoDataUrl : null;
        if(!description && !photoDataUrl) return;
        if(!isSelf && !name) return;
        var character = { id: 'local' + Math.random().toString(36).slice(2, 9), name: name, isSelf: isSelf, description: description };
        if(photoDataUrl) character.photoDataUrl = photoDataUrl;
        out.push(character);
      });
    }catch(e){ return []; /* malformed stash — already consumed above */ }
    return out;
  }

  if(typeof window !== 'undefined') window.FunnelCharacterStash = { KEY: KEY, MAX_AGE_MS: MAX_AGE_MS, consume: consume };
})();
