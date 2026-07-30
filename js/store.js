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
//   getAccountCreatedAt()        -> local read, epoch-ms signup timestamp (null for pre-existing accounts, see its own comment) — feeds Settings' support/feedback form
//   getSharedFeed()             -> GET  /.netlify/functions/get-feed (real, cross-browser)
//   toggleSharedLike(id,liked)   -> POST /.netlify/functions/like-dream
//   isBlocked(handle) / getBlockedHandles() -> local reads of this device's block list
//   blockUser(handle) / unblockUser(handle) -> local write + best-effort POST
//       /.netlify/functions/block-user (public feed safety, tracker item
//       for-product-public-feed-safety-in-app-re-ppuw77)
//   syncBlockedHandlesFromServer() -> best-effort GET /.netlify/functions/block-user,
//       merges a signed-in account's durable server-side block list into this device
//   getMyDreams()               -> GET  /api/users/me/dreams
//   getDreamInsight()           -> local read, recurring dream-theme detection for Profile (idea #4)
//   getDreamMilestone()         -> local read, dream-count milestone for Profile (idea #5)
//   getDreamLogStatus()         -> local read, home.html's Today/This-Week card state (loggedToday,
//       todayEntryType, weekCount vs. weekTarget, hasEverLogged) — tracker item
//       for-product-build-homepage-wave-1-the-ri-xr8mir
//   logNoRecallToday()          -> local write, records a content-less "no recall" dream-log
//       check-in for today (idempotent per day, grants nothing) — see getDreamLogStatus above
//   getAccountBackup()          -> local read, exports account+dreams+characters as a downloadable JSON backup
//   importAccountBackup(backup) -> local write, restores a backup exported above into this browser
//   getDream(id)                -> GET  /api/dreams/:id
//   toggleLike(id)               -> POST /api/dreams/:id/like
//   generateVideo(caption,style,opts) -> POST /api/dreams/generate
//   generateImage(caption,style,opts) -> POST /.netlify/functions/generate-image (cheap
//       still-image alternative, 10 tokens flat — see docs/IMAGE_GENERATION_SPEC.md)
//       — `caption` above (both generateVideo/generateImage, and every one of
//       finalizeDream/startGeneration/regenerateDream/adoptPendingGeneration/
//       saveClaimedDream below) is, and always was, the full ENGINEERED
//       generation prompt (promptText) — never altered by this feature.
//       `opts.storyText`/`patch.storyText` (tracker item for-product-split-
//       prompttext-storytext-f-yt5kc7) is the NEW, separate human-readable,
//       first-person dream description shown everywhere a human looks
//       (result.html/explore.html/share text) and fed to
//       interpret-dream.js — see finalizeDream's own doc comment for
//       exactly how the two combine onto a saved dream record, and for the
//       forward-only fallback (a dream saved before this field existed has
//       no distinct storyText/promptText at all — its one `caption` keeps
//       serving both roles, unchanged).
//   turnImageIntoVideo(dreamId)  -> local write (sets a draft), the "Turn this into a
//       video" upsell on an image-type dream — see result.html's CTA
//   regenerateDream(id, patch)   -> POST /api/dreams/:id/regenerate
//   publishDream(id)              -> POST /api/dreams/:id/publish
//       — a fresh publish (isPublished false->true) also stamps
//       `channelLicenseGrantedAt` (epoch ms), the moment terms.html's
//       "Your content" republish license (tracker item for-product-terms-
//       republish-license-per--fhpcxk) actually attaches to THIS dream —
//       deliberately a timestamp set only going forward, never backfilled
//       onto dreams already published before this shipped, per the
//       founder's explicit no-backfill requirement. Clears any earlier
//       `channelLicenseRevokedAt` — republishing after an unpublish is a
//       fresh publish action and re-grants the license same as any other.
//   unpublishDream(id)              -> POST /api/dreams/:id/unpublish
//       — stamps `channelLicenseRevokedAt` (epoch ms), ending the license
//       for any FUTURE use as of that moment — see publishDream above.
//       This is the concrete state a later "remove existing social posts
//       on request" pass reads; this task doesn't build that removal
//       mechanism itself, just the flag it will read.
//   deleteDream(id)                 -> DELETE /api/dreams/:id
//       — a published dream is also unpublished as part of deleting it
//       (see removePublishedDreamFromFeed below), same channel-license
//       revocation as unpublishDream.
//   setOkToFeatureOnChannels(id,enabled) -> POST /api/dreams/:id (per-dream
//       opt-out toggle, default true/on when unset — tracker item
//       for-product-terms-republish-license-per--fhpcxk's zero-click
//       design: publishing itself grants the license with no extra tap,
//       and this is the one discoverable place to turn it back off for a
//       specific dream. Re-syncs the shared feed record immediately when
//       the dream is currently published, same as any other already-
//       published-dream edit.
//   getCharacters()                   -> GET  /api/users/me/characters
//   saveCharacter(patch)                -> POST /api/users/me/characters[/:id]
//   deleteCharacter(id)                   -> DELETE /api/users/me/characters/:id
//   getInterpretations(id)                       -> local read of a dream's saved per-persona
//       readings ({ [personaKey]: {text, at} }) — Interpretation Wave 1 ("The Interpreter's
//       Chamber," docs/INTERPRETATION_WAVE1_SPEC.md). Lazily migrates a legacy single-blended
//       interpretationText/interpretationAt (pre-wave-1) into interpretations.classic on first
//       access — see ensureInterpretationsMigrated below.
//   requestInterpretationQuestions(id,personaKey) -> POST /.netlify/functions/interpret-dream
//       { mode:'questions' } — no local write, purely a network passthrough (see that file).
//   generateInterpretationReading(id,personaKey,qa) -> POST /.netlify/functions/interpret-dream
//       { mode:'reading' } — on success, writes interpretations[personaKey] and persists.
//       Replaces the old, now-removed getInterpretation/generateInterpretation (single blended
//       reading, no persona/questions) — see this file's own INTERPRETATION_WAVE1_SPEC.md-linked
//       comment near ensureInterpretationsMigrated for the full migration/data-model story.
//   getTokenStatus()                      -> GET  /.netlify/functions/get-token-status
//   markFirstVideoCreatedIfEligible(dreamId) -> local read+write, fire-once-per-account guard for
//                                                the "first video created" conversion event (see
//                                                result.html's call site + js/analytics-config.js)
//   markGenerationJustCompleted(operationName) -> fire-and-forget, POST /.netlify/functions/mark-generation-completed
//       — durable (server-side, operationName-keyed and server-verified) replacement for the old
//       sessionStorage "just generated" marker; called from processing.html right before its redirect.
//   wasOperationJustCompleted(operationName) -> Promise<boolean>, POST /.netlify/functions/consume-generation-marker
//       — durable counterpart to markGenerationJustCompleted, consumed exactly once by result.html.
//   isOnlyCompletedDream(dreamId) -> local read-only query, same eligibility computation as
//       markFirstVideoCreatedIfEligible minus its one-time flag — feeds the PostHog
//       first_video_result_view sanity-check signal (see result.html's call site).
//   sendFirstDreamEmailBestEffort(dream) -> fire-and-forget, POST /.netlify/functions/send-first-dream-email
//       — the retention email ("your dream is ready") — see that function's own header comment.
//       Callers must gate this on markFirstVideoCreatedIfEligible above having already returned true.
//   verifyOwnerBypass() -> Promise, POST /.netlify/functions/verify-owner-bypass — real
//       password re-check for the currently signed-in account; on success, stores a
//       short-lived owner generation-rate-limit bypass token locally (see
//       netlify/functions/lib/owner-bypass.js and admin.html's "Owner Generation Bypass" control).
//   getOwnerBypassStatus() / clearOwnerBypass() -> local read/write of that token's UI state.
//   adoptPendingGeneration(operationName,startedAt,caption,style) -> local write, adopts an
//       already-submitted (pre-signup) generation job as this browser's pendingJob — see
//       wizard.html's "generate during signup" seam and start-pending-generation.js
//   saveClaimedDream(caption,style,videoUrl) -> local write, materializes an
//       already-finished dream (claim-dream.html, the abandoned-dream re-engagement
//       email/WhatsApp link's landing page) into the current account's local dreams
//   deleteAccount(password) -> Promise, POST /.netlify/functions/delete-account
//       {username,password} -- requires the account's real current password
//       (a client-claimed identity alone isn't enough for something this
//       destructive, same bar as every other password-gated flow here).
//       Permanently deletes the account server-side (see that file for
//       exactly what), then, only once that succeeds, wipes THIS account's
//       own slice of local state (its accounts[]/charactersByUser[]
//       entries, its own dreams) — scoped to just this account, not a
//       wholesale wipe, since state.dreams/charactersByUser/accounts are
//       shared across every account that's ever used this browser (see
//       wipeAllLocalState's own comment for the full reasoning).

// Error codes E3xx = client-side generation failures (as opposed to E1xx/E2xx,
// which come from generate-video.js/video-status.js and already carry their
// own codes by the time they reach here — those are passed through as-is).
//   E301 generation_timeout       — gave up polling after MAX_POLL_MS
//   E302 network error while polling video-status (e.g. connection dropped) —
//        only surfaces after MAX_NETWORK_RETRIES consecutive transient
//        fetch/network failures (see pollUntilDone); a single dropped poll
//        is retried, not treated as this
//   E303 network error submitting the initial generate-video request
//   E399 server returned an error response with no error text at all (should be unreachable — every
//        E1xx/E2xx path always sets one — but a code exists in case something upstream changes)
//
// requestInterpretationQuestions()/generateInterpretationReading() below
// (Interpretation Wave 1) pass through whatever "E4NN: reason" string
// interpret-dream.js's response carries as-is (same pattern as E1xx/E2xx
// above) — see that file's own header comment for the full E4xx list,
// including the two new codes this wave added (E408 unknown_persona, E409
// invalid_mode). A plain network failure reaching the function at all (no
// response to read a code from) surfaces as an uncoded
// "network_error_requesting_interpretation" message instead —
// js/interpret-experience.js's error/fallback states don't display the raw
// message either way, so no dedicated code was reserved for that case the
// way E303 exists for generate-video's equivalent client-side network
// failure.

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
      // storyText (tracker item for-product-split-prompttext-storytext-
      // f-yt5kc7): the human-readable, first-person dream description —
      // shown on result.html/explore.html/share text and fed to
      // interpret-dream.js. `caption` keeps its existing meaning
      // unchanged (the full engineered string sent to generation,
      // a.k.a. promptText) — see js/store.js's finalizeDream for how the
      // two combine onto a saved dream record. Defaults '' so every
      // existing draft-reader that predates this field (there are none
      // left after this branch, but a browser's already-persisted
      // localStorage draft from before this shipped effectively gets one
      // via this seed shape on next load) behaves exactly like an empty
      // string, never undefined.
      // needsStoryRewrite: set true only by create.html's/wizard.html's
      // "chips, no free text typed" path — tells style.html's/wizard.html's
      // own preview step there's a pending opportunistic LLM story-rewrite
      // fetch worth attempting (see js/wizard-chips.js's
      // buildDeterministicStory/netlify/functions/rewrite-dream-story.js's
      // own header comments) rather than nothing to do.
      draft: { caption: '', storyText: '', needsStoryRewrite: false, style: null, sourceDreamId: null, restore: false, characterIds: [], cameraView: null, sceneryTime: null, sceneryPlace: null, mediaType: null, sourceImageUrl: null, audioOn: false, musicStyle: null },
      dreams: [],
      pendingJob: null, // { ..., ownerHandle } once set (see savePendingJob) — like dreams'
                         // ownerHandle, reads are scoped to whoever is CURRENTLY logged in
                         // (see scopedPendingJob) rather than the job ever being cleared on
                         // logout, so a same-account mid-generation logout/relogin can still
                         // resume it, but a different account signing in on this browser never
                         // can.
      charactersByUser: {}, // lowercased username -> array of character objects. Private
                             // per-user and reusable across dreams, same key scheme as accounts.
      likedIds: {}, // dream id -> true. Purely local "have I liked this" state for the shared
                    // feed's heart icon — the real aggregate like count lives server-side in
                    // Blobs (see getSharedFeed/toggleSharedLike), this just decides +1 vs -1
                    // and which browsers see a filled heart. Not deduped across devices/users;
                    // there's no real account system to dedupe against, same as everywhere else.
      blockedByUser: {} // lowercased username -> { ownerHandle (e.g. "@alice"): true, ... }.
                    // Local "who has THIS signed-in account blocked" state for the shared
                    // feed (tracker item for-product-public-feed-safety-in-app-re-ppuw77) —
                    // keyed per account, same scheme as charactersByUser immediately above
                    // (private per-user, reusable across sessions), deliberately NOT a plain
                    // device-level map the way likedIds is (review finding: unlike a like,
                    // which is cosmetic, a block is the actual safety mechanism this feature
                    // exists to ship — a shared/family device where Account A blocks an
                    // abusive user, logs out, and Account B logs in must never show A's
                    // block as B's own, or let B tap Unblock and silently undo A's
                    // protection). Only ever read/written for whichever account is CURRENTLY
                    // signed in (see currentBlockedMap below) — blocking requires being
                    // signed in at all (see js/report-sheet.js's isLoggedIn gate), so there's
                    // no logged-out/anonymous case to reconcile here. This is what actually
                    // filters a blocked author's dreams out of getSharedFeed() below. The
                    // CURRENT account's blocks are ALSO durably synced server-side (see
                    // blockUser/unblockUser/syncBlockedHandlesFromServer and
                    // netlify/functions/lib/block-store.js) so they survive a cleared browser
                    // or a different device — this local map is the fast, always-available
                    // copy that actually drives rendering, seeded/merged from that server copy
                    // on demand, never the other way around.
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

    // Backfill ownerHandle onto a pendingJob that predates the
    // account-scoping fix (state-pendingjob-not-cleared-on-logout-s-p2ivk2,
    // review round 3) — every browser that had a real in-flight (or simply
    // not-yet-resumed) job the moment this branch deployed has one of
    // these: written by the OLD savePendingJob, which never set
    // ownerHandle at all. scopedPendingJob() treats a missing ownerHandle
    // as belonging to no one, so without this backfill every such user
    // would find getPendingJob() suddenly null on their very next load —
    // with no logout involved at all — and processing.html's
    // `location.href = 'create.html'` fallback would silently bounce them
    // off an already-paid-for generation (tokens are spent at submission,
    // see generate-video.js's E112 doc block) with zero explanation. Only
    // backfill when s.user is actually set — a pendingJob adopted via
    // adoptPendingGeneration before signup completes (the wizard.html/
    // start.html pre-signup seam) legitimately has no owner yet, and that
    // case is already handled entirely by adoptPendingGeneration's own
    // flow, not by anything here.
    //
    // Residual, irreducible risk (same shape as backfillAccountServerSide's
    // own doc comment below): this attributes the legacy job to whoever
    // s.user happens to be the FIRST time this migration runs for a given
    // browser, not necessarily who actually submitted it. If account A
    // creates the job, logs out, and account B logs into the same browser
    // before this branch's first post-deploy load ever happens there, B
    // permanently inherits A's job (and, once it resolves, the finished
    // dream itself). There's no clean fix — the true original owner is
    // unrecoverable for data that predates ownerHandle tracking at all —
    // this is just the one-time migration doing its best with what it has.
    if (s.pendingJob && !s.pendingJob.ownerHandle && s.user) {
      s.pendingJob.ownerHandle = s.user.handle;
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
      if (parsed.draft.mediaType === undefined) parsed.draft.mediaType = null;
      if (parsed.draft.sourceImageUrl === undefined) parsed.draft.sourceImageUrl = null;
      if (parsed.draft.audioOn === undefined) parsed.draft.audioOn = false;
      if (parsed.draft.musicStyle === undefined) parsed.draft.musicStyle = null;
      if (!parsed.likedIds) parsed.likedIds = {};
      if (!parsed.blockedByUser) parsed.blockedByUser = {};
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

  /**
   * The client-side half of DreamStore.deleteAccount, called only AFTER
   * delete-account.js has confirmed the real, server-side deletion
   * succeeded (never before — this must not run just because the user
   * clicked a confirm button, only once the destructive server call
   * actually completed).
   *
   * MUST be scoped to just the ONE account being deleted, not a wholesale
   * wipe of the whole KEY blob — state.dreams/charactersByUser/accounts
   * are deliberately SHARED across every account that's ever used this
   * browser (see logout's own comment, and getMyDreams's `d.ownerHandle
   * === myHandle` filtering — the same pattern getAccountBackup already
   * uses to export just one account's slice). A second local account
   * signing in/out on this same device (increasingly realistic now that
   * cross-device login exists) must survive this untouched: its private,
   * never-published dreams and characters have no copy anywhere else, and
   * its locally-cached password/email is how it logs in on this device at
   * all if it predates the server-side account store. A round-2 review
   * caught an earlier version of this function doing exactly that wrong
   * (a bare `localStorage.removeItem(KEY)`) — this is the fix.
   *
   * Removes: this account's `accounts[key]` entry, its
   * `charactersByUser[key]` array, its `blockedByUser[key]` map (per-
   * account block list, same key scheme as charactersByUser — see that
   * field's own doc comment), every dream in `state.dreams` whose
   * `ownerHandle` matches (private and previously-published alike — the
   * server call already removed the published copies from the shared
   * feed; this removes this browser's own copy), and `state.pendingJob`
   * only if it's this same account's (scopedPendingJob's own ownerHandle
   * check already hides another account's job from this one, but there's
   * no reason to let a deleted account's job data linger). Then resets
   * `state.user`/`state.draft` — the current session's own transient
   * state, not account data — the same way logout() resets `state.user`.
   * `state.likedIds` is left alone: already documented (see its own
   * comment) as not deduped per-account at all, same as logout().
   *
   * Deliberately does NOT touch the feed-backfill/persistent-storage
   * "have I already done this" flags or the genuinely device-level prefs
   * (dreamtube_sound_on, dreamtube_dod_seen_id, shop.html's own
   * dreamtube_shop_variant) — none of those are this account's data (see
   * backfillSharedFeed's own "safe to run again" comment, and
   * getSoundPref's "like a volume setting" comment), so an account
   * deletion has no more reason to touch them than logging out already
   * does.
   *
   * DOES clear the PostHog pre-account marker (clearPreAccountMarker,
   * defined further down this file — a plain function declaration, so
   * it's hoisted and callable here regardless of definition order) —
   * mirrors logout() doing the same (see that call site's own comment,
   * review round 2, tracker item
   * for-product-data-bug-posthog-identity-br-vytqwy): a deleted account
   * ends this session exactly like a sign-out does, and a dangling
   * pre-signup marker left behind could otherwise get misread and
   * aliased into a completely unrelated later visitor's PostHog identity
   * on a shared device.
   */
  function wipeAllLocalState(usernameKey, myHandle) {
    delete state.accounts[usernameKey];
    delete state.charactersByUser[usernameKey];
    delete state.blockedByUser[usernameKey];
    state.dreams = state.dreams.filter(function (d) { return d.ownerHandle !== myHandle; });
    if (state.pendingJob && state.pendingJob.ownerHandle === myHandle) state.pendingJob = null;
    state.user = null;
    state.draft = seed().draft;
    clearPreAccountMarker();
    persist();
  }

  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  /** The current user's email on file, or null — shared by getAccountEmail() and startGeneration's opportunistic email on the generate-video request (see that function for why). */
  function currentAccountEmail() {
    if (!state.user) return null;
    var key = state.user.username.toLowerCase();
    return state.accounts[key] ? state.accounts[key].email : null;
  }

  /** The CURRENTLY signed-in account's own blockedByUser map ({ handle: true, ... }), or null if logged out — see state.blockedByUser's own doc comment for why this is per-account, not device-level. Shared by isBlocked/getBlockedHandles/blockUser/unblockUser/getSharedFeed's blockedByMe below. */
  function currentBlockedMap() {
    if (!state.user) return null;
    var key = state.user.username.toLowerCase();
    return state.blockedByUser[key] || null;
  }

  // ===== Owner generation-rate-limit bypass (tracker.html's
  // for-product-founder-hit-the-per-ip-gener-7mjq2l item) =====
  //
  // Standalone localStorage keys, same "small, single-purpose key, own
  // try/catch" convention as dreamtube_sound_on/dreamtube_dod_seen_id
  // above — deliberately NOT part of the main `state` object/KEY blob,
  // since a bypass token is short-lived (see netlify/functions/lib/
  // owner-bypass.js's 12h TTL) and account-independent bookkeeping, not
  // durable app state that belongs in a backup export.
  //
  // SECURITY NOTE for anyone reading this expecting it to be the boundary:
  // it isn't. Storing a token here (or reading it back) proves nothing by
  // itself — verifyOwnerBypass() below only ever obtains one after the
  // REAL server-side check in verify-owner-bypass.js (a genuine password
  // match against the account on file for OWNER_EMAIL). Nothing client-
  // side, including this code, has any authority — a token that doesn't
  // verify server-side (lib/owner-bypass.js's verifyBypassToken, called
  // fresh on every generate-video.js/generate-image.js request) is simply
  // ignored, same as no token at all.
  var OWNER_BYPASS_TOKEN_KEY = 'dreamtube_owner_bypass_token';
  var OWNER_BYPASS_EXPIRES_KEY = 'dreamtube_owner_bypass_expires';

  /** Reads a currently-live owner bypass token from localStorage, or null if none was ever obtained, or the stored one has expired. Best-effort — any localStorage failure (private mode, etc.) reads as "no bypass", never throws, matching every other localStorage read in this file. */
  function getOwnerBypassToken() {
    try {
      var token = localStorage.getItem(OWNER_BYPASS_TOKEN_KEY);
      var expiresAt = parseInt(localStorage.getItem(OWNER_BYPASS_EXPIRES_KEY), 10);
      if (!token || !expiresAt || Date.now() >= expiresAt) return null;
      return token;
    } catch (e) {
      return null;
    }
  }

  /** The current user's account-creation timestamp (epoch ms), or null — either not logged in, or (see getAccountCreatedAt's own doc comment) a pre-existing account from before this field existed. */
  function currentAccountCreatedAt() {
    if (!state.user) return null;
    var key = state.user.username.toLowerCase();
    var account = state.accounts[key];
    return account && account.createdAt ? account.createdAt : null;
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
   * Interpretation Wave 1 (docs/INTERPRETATION_WAVE1_SPEC.md §5) — lazy,
   * read-time migration of a dream's OLD single-blended
   * interpretationText/interpretationAt fields (pre-wave-1) into the new
   * per-persona `interpretations` map, under the synthetic `classic` key.
   * Deliberately lazy/per-dream rather than a bulk migration pass over
   * every dream at load time — per the spec's own explicit instruction —
   * so this only ever does work for a dream someone actually opens the
   * interpretation surface for.
   *
   * Runs (and persists) AT MOST ONCE per dream: once `interpretations` is
   * a real object, later calls are a no-op read (the `!map.classic &&
   * dream.interpretationText` guard below only fires while `classic` is
   * still unset). The legacy interpretationText/interpretationAt fields
   * are deliberately left in place on the dream record afterward (never
   * cleared) — they're simply no longer written to going forward; every
   * new/updated reading is written through `interpretations` only (see
   * generateInterpretationReading above).
   *
   * `classic` is a synthetic persona key with NO matching entry in
   * js/interpreter-personas.js — js/interpret-experience.js's picker never
   * shows a "classic" card; a migrated `classic` reading only ever
   * surfaces via the revisit-without-network path (spec §3.0: "If the
   * dream already has ≥1 saved interpretation, open on reading phase
   * showing the most recent one"), same as any other already-saved
   * persona reading would.
   *
   * Returns the dream's `interpretations` map directly (not a copy) —
   * every call site here already holds a real dream record it's allowed
   * to mutate (ownership-guarded by its own caller), so returning the
   * live object (rather than forcing a redundant re-lookup) is safe and
   * matches this file's existing convention elsewhere (e.g. findDream's
   * own callers mutate its return value directly).
   */
  function ensureInterpretationsMigrated(dream) {
    if (!dream.interpretations) dream.interpretations = {};
    if (!dream.interpretations.classic && dream.interpretationText) {
      dream.interpretations.classic = { text: dream.interpretationText, at: dream.interpretationAt || Date.now(), qa: [] };
      persist();
    }
    return dream.interpretations;
  }

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

  /**
   * How many qualifying entries (real dreams OR "no recall" check-ins —
   * see getDreamLogStatus below) a week needs before home.html's This Week
   * card transforms from "locked" into the earned weekly summary, in
   * place, per tracker item for-product-build-homepage-wave-1-the-ri-xr8mir.
   */
  var WEEK_SUMMARY_TARGET = 3;

  /** Monday 00:00 local time of the week containing `d` — home.html's "This Week" window. Week starts Monday (matches the mock's own "Monday morning" framing), not Sunday. */
  function startOfWeekMs(d) {
    var day = d.getDay(); // 0=Sun..6=Sat
    var diffToMonday = day === 0 ? 6 : day - 1;
    var monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - diffToMonday);
    monday.setHours(0, 0, 0, 0);
    return monday.getTime();
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

  // Tags every pendingJob with the handle of whoever is logged in at write
  // time — both call sites (startGeneration below, and adoptPendingGeneration
  // right after signup succeeds in wizard.html/start.html) always run with
  // state.user already set (generation requires currentAccountEmail() for
  // the server-side token gate, which is null unless state.user is set; the
  // pre-signup adopt call is only ever made from inside DreamStore.signup()'s
  // own success callback — verified directly at both call sites). Same
  // account-scoping shape as dreams' ownerHandle (see getMyDreams below) —
  // this is what getPendingJob/resumePendingJob/requestNotifyOnReady filter
  // reads by, instead of logout() wholesale-clearing the job (which used to
  // also destroy a same-account resume after a mid-generation logout+
  // relogin — tracker.html's state-pendingjob-not-cleared-on-logout-s-p2ivk2,
  // review round 2).
  function savePendingJob(job) {
    state.pendingJob = Object.assign({}, job, { ownerHandle: state.user ? state.user.handle : null });
    persist();
  }
  function clearPendingJob() { state.pendingJob = null; persist(); }

  // Returns state.pendingJob only when it belongs to whoever is currently
  // logged in — never to a logged-out visitor (myHandle null) and never to
  // a job tagged for a different account, same filter shape as
  // getMyDreams()'s `d.ownerHandle === myHandle`. A job with no ownerHandle
  // at all (only possible for one already in a browser's localStorage from
  // before this scoping existed) is likewise treated as belonging to no one
  // — matches getMyDreams()'s existing behavior for any dream whose
  // ownerHandle doesn't match, and is the safe default per the bug this
  // closes: never guess an owner, just let it sit inert in storage.
  function scopedPendingJob() {
    var myHandle = state.user ? state.user.handle : null;
    return (state.pendingJob && myHandle && state.pendingJob.ownerHandle === myHandle) ? state.pendingJob : null;
  }

  /**
   * Fire-and-forget upsert into the shared feed-index blob. Local state is
   * always the source of truth for the owner's own view (Profile) — if this
   * fails, the dream still shows as published locally, it just might not
   * (yet) appear in others' Explore until the next successful sync.
   *
   * authToken (tracker item publish-dream-js-trusts-client-supplied--lkppcu):
   * publish-dream.js now requires a verified authToken and rejects any
   * request whose ownerHandle doesn't match it (see that file's own header
   * comment) — sourced from state.user.authToken exactly like
   * blockUser/unblockUser already do (see this file's own authToken-gated-
   * feature comments there). Every real call site here (finalizeDream,
   * publishDream, setOkToFeatureOnChannels) only ever calls this for a
   * dream whose ownerHandle already matches whoever is CURRENTLY signed in
   * (each guards `d.ownerHandle === myHandle` first), so state.user.authToken
   * is always the right token to send. The one exception is
   * backfillSharedFeed's one-time catch-up sweep, which loops over every
   * dream in the shared, cross-account state.dreams array regardless of
   * current owner — for a dream belonging to a DIFFERENT account that
   * previously used this browser, this now honestly fails server-side
   * (E6 owner_mismatch) instead of the old behavior of syncing it under
   * whatever ownerHandle the record itself carried; that's an accepted,
   * safe degrade (that dream was already synced once under its real
   * owner's own session at actual-publish time) rather than a regression
   * worth special-casing here. If state.user has no authToken on file at
   * all (a legacy/offline-fallback account, or one signed in before this
   * token mechanism existed) this simply sends `null`, which
   * publish-dream.js rejects (E4) — same "best-effort, never breaks the
   * app" fire-and-forget posture as every other failure mode here, it just
   * means the shared feed doesn't get this particular update.
   */
  function syncPublishedDreamToFeed(dream) {
    fetch('/.netlify/functions/publish-dream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: dream.id, ownerHandle: dream.ownerHandle, caption: dream.caption,
        style: dream.style, dur: dream.dur, videoUrl: dream.videoUrl,
        imageUrl: dream.imageUrl, mediaType: dream.mediaType || 'video',
        // Republish-license consent state (tracker item for-product-terms-
        // republish-license-per--fhpcxk) — carried into the SHARED feed-
        // index record (not just this browser's local copy) since that's
        // the one place a real, cross-device auto-posting engine could
        // ever actually read curation eligibility from. `undefined` here
        // (a dream published before this shipped) intentionally comes
        // through as `null` below — see publish-dream.js's own comment for
        // why that's the correct "not licensed, needs fresh consent" state,
        // not a bug to default away.
        channelLicenseGrantedAt: dream.channelLicenseGrantedAt || null,
        // Carried alongside channelLicenseGrantedAt for the same reason —
        // unpublishDream/deleteDream's revocation stamp is only useful to a
        // future "remove existing social posts on request" pass if it
        // actually reaches the shared record those posts would be sourced
        // from, not just this browser's local copy.
        channelLicenseRevokedAt: dream.channelLicenseRevokedAt || null,
        okToFeatureOnChannels: dream.okToFeatureOnChannels !== false,
        authToken: (state.user && state.user.authToken) || null
      })
    }).catch(function () { /* best-effort — see comment above */ });
  }

  /**
   * Fire-and-forget removal from the shared feed-index blob — same
   * best-effort contract as syncPublishedDreamToFeed above, including the
   * same authToken sourcing/degrade reasoning (see that function's own
   * doc comment) — unpublish-dream.js requires a verified authToken whose
   * username matches the target record's OWN stored ownerHandle (see that
   * file's header comment), not just any signed-in account's token.
   */
  function removePublishedDreamFromFeed(id) {
    fetch('/.netlify/functions/unpublish-dream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id, authToken: (state.user && state.user.authToken) || null })
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
      if (d.isPublished && (d.videoUrl || d.imageUrl)) syncPublishedDreamToFeed(d);
    });
    try { localStorage.setItem(FEED_BACKFILL_KEY, '1'); } catch (e) { /* storage unavailable — will just retry next load */ }
  }

  // ---------------------------------------------------------------------
  // New-likes notification hook (tracker item idea-notify-likes, v1 —
  // Manager-approved 2026-07-28): aggregate-count-only, no per-liker
  // identity, no email — see this item's own tracker detail for full scope.
  //
  // Likes on a dream are stored server-side on the shared feed record
  // (netlify/functions/like-dream.js's feed[idx].likes, fetched via
  // get-feed.js). This account's own published dreams are tracked locally
  // via getMyDreams()/isPublished, but the LOCAL .likes field only updates
  // when THIS browser toggles a like itself (toggleSharedLike above) — it
  // goes stale the moment anyone else likes one of this account's
  // published dreams. There is no push/poll here (explicitly out of
  // scope) — refreshNewLikesCount() below is a plain one-shot fetch,
  // called only from profile.html on page load.
  //
  // Two localStorage keys, both plain per-browser state (no server
  // storage — same posture as dreamtube_claim_sheet_shown_date and every
  // other soft per-browser UI preference in this file):
  //   - LIKES_SEEN_KEY: JSON map of { dreamId: lastSeenLikeCount }, this
  //     account's own "have I already counted these likes" baseline per
  //     dream. Missing an id (first time it's ever checked) seeds the
  //     baseline from this browser's own last-known LOCAL like count
  //     (the dream's .likes field, stale as it may be) rather than 0 or
  //     the just-fetched current count — 0 would flag every pre-existing
  //     like as "new" in one big burst, and the current count would make
  //     delta always compute to 0 on literally every account's first-ever
  //     check (seeding a baseline from the same fetch it's about to be
  //     diffed against always yields zero), silently swallowing every
  //     like accumulated by someone else since this browser last synced —
  //     including this feature's own rollout day.
  //   - LIKES_NEW_COUNT_KEY: the single cached integer every bottom-nav
  //     page (home.html/explore.html/profile.html) reads synchronously,
  //     with no fetch of its own, to decide whether to show the Profile
  //     tab's badge dot. It holds whatever refreshNewLikesCount() last
  //     computed. Visiting profile.html is what "clears" it for next
  //     time: that visit both shows the current total (this call's
  //     return value) AND immediately rolls LIKES_SEEN_KEY's baseline
  //     forward to the current counts, so the NEXT refreshNewLikesCount()
  //     call (the next profile.html load) naturally computes 0 and
  //     overwrites LIKES_NEW_COUNT_KEY with it — which is what makes the
  //     badge disappear on every page from that point on. Between those
  //     two profile.html visits, the badge stays visible everywhere
  //     (including a fresh explore.html/home.html load) since the cached
  //     count hasn't been cleared yet — that's the intended "there's
  //     something new to see on your profile" signal.
  var LIKES_SEEN_KEY = 'dreamtube_likes_seen_v1';
  var LIKES_NEW_COUNT_KEY = 'dreamtube_likes_new_count_v1';

  function readLikesSeenMap() {
    try {
      var raw = localStorage.getItem(LIKES_SEEN_KEY);
      var parsed = raw ? JSON.parse(raw) : {};
      return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch (e) { return {}; }
  }

  function writeLikesSeenMap(map) {
    try { localStorage.setItem(LIKES_SEEN_KEY, JSON.stringify(map)); } catch (e) { /* storage unavailable — best-effort, see doc block above */ }
  }

  function writeCachedNewLikesCount(n) {
    try { localStorage.setItem(LIKES_NEW_COUNT_KEY, String(n)); } catch (e) { /* storage unavailable — badge just won't show anywhere, no crash */ }
  }

  /**
   * Wipes both likes-tracking keys outright (not "write 0" — an outright
   * remove so a brand-new identity on this browser starts with no
   * per-dream seen-baseline either, not just a zeroed badge count).
   * Called from logout() (a cross-account localStorage leak flagged in
   * review: a signed-out session must never leave ANY likes-tracking
   * state around for whoever uses this browser next, same "shared
   * device, unrelated later visitor"
   * reasoning as clearPreAccountMarker() above) and, for defense in
   * depth, from every place a NEW account identity gets written into
   * state.user (login()'s two success paths, attemptLocalLogin,
   * commitLocalSignup) — login.html has no guard against submitting the
   * login/signup form while already signed in as someone else, so a
   * logout()-only fix would miss that path.
   */
  function clearLikesTrackingState() {
    try { localStorage.removeItem(LIKES_SEEN_KEY); } catch (e) { /* best-effort, see logout()'s own comment */ }
    try { localStorage.removeItem(LIKES_NEW_COUNT_KEY); } catch (e) { /* best-effort, see logout()'s own comment */ }
  }

  /** The status-polling endpoint for a given mediaType — video-status.js (returns videoUrl) or image-status.js (returns imageUrl). Default 'video' matches every other mediaType default in this file. */
  function statusEndpointFor(mediaType) {
    return mediaType === 'image' ? '/.netlify/functions/image-status' : '/.netlify/functions/video-status';
  }

  /**
   * email (optional) is threaded through to video-status.js/image-status.js
   * purely so a refund-eligible generation failure (E205/E208-class — see
   * either function's own doc block) can credit tokens back onto the
   * right account's balance server-side, the moment that failure is
   * determined — see lib/entitlements.js's refundTokensOnce. Never required
   * for the plain status check itself; an empty/missing email just means
   * no refund attempt (shouldn't happen in practice — generate-video.js's/
   * generate-image.js's own E112/E412 token gate already requires a real
   * email before a job can even be submitted, so every operationName this
   * polls for was necessarily submitted with one).
   */
  function pollUntilDone(operationName, startedAt, mediaType, email) {
    return new Promise(function (resolve, reject) {
      // Tracker item startgeneration-clears-pendingjob-on-any-s7wr0b: a
      // single dropped/transient fetch mid-poll used to reject this whole
      // promise immediately (E302), and startGeneration's outer .catch then
      // unconditionally clearPendingJob()'d — orphaning a real, still-
      // in-flight job and forcing a fresh (double-charged) resubmission on
      // the next attempt, over what was often just one momentary
      // connectivity blip, not a real outage. networkFailureCount tracks
      // CONSECUTIVE network/fetch-level failures only (a real server-
      // reported data.error below is never affected by this, and still
      // rejects immediately as before) — reset to 0 the moment any poll
      // gets a real response back, incremented only in the .catch below.
      // MAX_NETWORK_RETRIES bounds it: retried like the ordinary
      // not-done-yet path (same POLL_INTERVAL_MS delay) up to that many
      // consecutive misses (~3 * POLL_INTERVAL_MS = ~30s of sustained
      // failure, a reasonable bar per that tracker item's own reasoning)
      // before finally giving up and rejecting with E302 for real. The
      // overall MAX_POLL_MS check below still bounds the absolute worst
      // case regardless.
      var MAX_NETWORK_RETRIES = 3;
      var networkFailureCount = 0;
      function poll() {
        if (Date.now() - startedAt > MAX_POLL_MS) { reject(new Error('E301: generation_timeout')); return; }
        var url = statusEndpointFor(mediaType) + '?name=' + encodeURIComponent(operationName)
          + (email ? '&email=' + encodeURIComponent(email) : '');
        fetch(url)
          .then(function (res) { return res.json(); })
          .then(function (data) {
            networkFailureCount = 0; // a real response came back -- any prior transient-failure streak no longer applies
            if (data.error) {
              // tokensRefunded (see video-status.js/image-status.js) rides
              // along on the Error object itself (not encodable in the
              // "ENNN: reason" string) so processing.html's catch handler
              // can show "Your tokens were returned." exactly when a real
              // server-side refund actually landed — never assumed from
              // the client side.
              var refundErr = new Error(data.error);
              refundErr.tokensRefunded = !!data.tokensRefunded;
              reject(refundErr);
              return;
            }
            if (data.done) { resolve(mediaType === 'image' ? data.imageUrl : data.videoUrl); return; }
            setTimeout(poll, POLL_INTERVAL_MS);
          })
          .catch(function (err) {
            networkFailureCount += 1;
            if (networkFailureCount > MAX_NETWORK_RETRIES) {
              reject(new Error('E302: network_error_during_status_check' + (err && err.message ? ': ' + err.message : '')));
              return;
            }
            // Transient network/fetch-level failure -- retry exactly like
            // the ordinary not-done-yet path above instead of giving up on
            // the very first miss (see doc comment above).
            setTimeout(poll, POLL_INTERVAL_MS);
          });
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

  /**
   * mediaUrl is the finished videoUrl OR imageUrl, whichever mediaType
   * actually produced (see pollUntilDone above) — mediaType (default
   * 'video') decides which dream field it's stamped onto. For a
   * sourceDreamId regenerate, ONLY the field matching this mediaType is
   * ever touched — the "Turn this into a video" upsell (see
   * js/store.js's turnImageIntoVideo/result.html's CTA) relies on this:
   * it regenerates an existing image-type dream with mediaType:'video',
   * so this stamps videoUrl and flips mediaType to 'video', but
   * deliberately leaves the dream's original imageUrl in place
   * (provenance — not required for the v1 UI, but free to keep, per
   * docs/IMAGE_GENERATION_SPEC.md §6).
   *
   * operationName (added 2026-07-27, tracker.html's
   * result-htmls-firstvideocreated-still-dep-qfg48t) is the server-issued
   * job id (from generate-video.js/generate-image.js, see startGeneration
   * below) that just resolved into this completion — stamped onto the
   * dream as `sourceOperationName` so result.html can later prove, via
   * DreamStore.wasOperationJustCompleted, that its render is the genuine
   * moment-of-completion and not an ordinary revisit. See that function's
   * own doc comment and netlify/functions/lib/generation-completion-store.js
   * for why this REPLACED dreamId as the durable marker's key: dream ids
   * are client-invented and already public (explore.html/profile.html/
   * watch.html links), so anyone who knows/guesses one could otherwise
   * plant a marker for someone else's dream. operationName is server-
   * issued, never shown in any UI/URL, and independently re-verified
   * server-side before a marker is ever honored (see mark-generation-
   * completed.js) — not something an outside caller can target a specific
   * victim account/dream with.
   *
   * storyText (tracker item for-product-split-prompttext-storytext-
   * f-yt5kc7): the human-readable, first-person dream description —
   * distinct from `caption`, which is (and always was) the full
   * engineered generation prompt. Falls back to `caption` itself when the
   * caller doesn't have a distinct one (any caller not yet updated for
   * this feature, or a resumed pre-existing pendingJob that predates it)
   * — exactly matching this app's behavior before this field existed,
   * where the one caption string served both roles. Every field this
   * function stamps onto the dream reads from THIS resolved value, never
   * the raw `storyText` argument directly, so a dream saved here is
   * always internally consistent: `dream.storyText` (the deliberate new
   * field for anything display/interpretation reads) and `dream.caption`
   * (kept, unchanged in shape, as the backward-compatible alias every
   * pre-existing reader in this app already uses — result.html/
   * explore.html/share text/interpret-dream.js's caller are updated to
   * prefer storyText explicitly, but nothing else in the app breaks if it
   * doesn't get updated, since caption already carries the same value)
   * both equal the same human text; `dream.promptText` carries the full
   * engineered string that was actually sent to the model. Old dreams
   * saved before this field existed simply never gained a `promptText`/
   * distinct `storyText` at all (forward-only migration, per this
   * tracker item's own explicit instruction) — every reader that falls
   * back to `dream.caption` already handles that case for free.
   */
  function finalizeDream(mediaUrl, caption, style, sourceDreamId, mediaType, operationName, storyText) {
    mediaType = mediaType === 'image' ? 'image' : 'video';
    var resolvedStoryText = (storyText && storyText.trim()) ? storyText.trim() : caption;
    var dream;
    if (sourceDreamId) {
      dream = findDream(sourceDreamId);
      // Ownership guard (review finding, tracker item for-product-terms-
      // republish-license-per--fhpcxk, second round) — defense-in-depth at
      // the actual mutation point, not just at regenerateDream/
      // turnImageIntoVideo's own call sites: both funnel through
      // startGeneration's sourceDreamId option to land here, and neither
      // caller re-checks ownership at this point in time (a job can take
      // a while; the signed-in account could have changed by the time this
      // resolves). A sourceDreamId that doesn't belong to the current
      // account is treated exactly like one that doesn't resolve to any
      // dream at all — same not_found failure, no silent partial mutation.
      var myHandle = state.user ? state.user.handle : null;
      if (!dream || !myHandle || dream.ownerHandle !== myHandle) throw new Error('not_found');
      // Regenerating (Edit Dream -> Generate Again, or Try Again after a
      // failure) changes the dream's actual content, so any previously
      // generated interpretation was reflecting on content that no longer
      // exists — clear it here rather than silently leaving a stale
      // reflection attached to the new caption/style. This puts the dream
      // back in the "never generated" state, so the interpretation surface
      // shows its plain picker again and a fresh opt-in tap is required.
      // Interpretation Wave 1 (docs/INTERPRETATION_WAVE1_SPEC.md §3.6):
      // nulls the WHOLE per-persona `interpretations` map, not just the
      // old single blended interpretationText/interpretationAt fields —
      // stale readings of changed dream text are wrong for EVERY persona
      // equally, not just whichever one happened to be generated first.
      // The legacy fields themselves stay in the patch too (still cleared
      // the same way) since ensureInterpretationsMigrated's lazy migration
      // reads them if a dream somehow still has them set without a
      // migrated `interpretations` map yet.
      var patch = {
        caption: resolvedStoryText, promptText: caption, storyText: resolvedStoryText,
        style: style, mediaType: mediaType, interpretationText: null, interpretationAt: null,
        interpretations: null, sourceOperationName: operationName || null
      };
      if (mediaType === 'image') patch.imageUrl = mediaUrl; else patch.videoUrl = mediaUrl;
      Object.assign(dream, patch);
    } else {
      dream = {
        id: newId(),
        ownerHandle: state.user ? state.user.handle : '@you',
        caption: resolvedStoryText, promptText: caption, storyText: resolvedStoryText,
        style: style, mediaType: mediaType,
        likes: 0, likedByMe: false, isPublished: false,
        videoUrl: mediaType === 'video' ? mediaUrl : null,
        imageUrl: mediaType === 'image' ? mediaUrl : null,
        sourceOperationName: operationName || null,
        // createdAt (epoch ms, new — tracker item
        // for-product-build-homepage-wave-1-the-ri-xr8mir): only ever
        // stamped here, on a genuinely brand-new dream, never on the
        // sourceDreamId/regenerate branch above (a regenerate/"Try Again"
        // edits an EXISTING dream's content, it doesn't create a new
        // week/day entry). Feeds home.html's "This Week" dream count and
        // "logged today" check — same forward-only-migration shape as
        // storyText/promptText above: a dream saved before this field
        // existed simply has no createdAt, and every reader here treats a
        // missing createdAt as "don't count this for a date-based check"
        // rather than fabricating one.
        createdAt: Date.now()
      };
      // Images never set a duration — there's no clip length concept for a
      // still image (see explore.html/profile.html's guarded d.dur render).
      if (mediaType === 'video') dream.dur = '0:08';
      state.dreams.unshift(dream);
    }
    clearPendingJob();
    persist();
    // Edit Dream / Change Style can regenerate a dream that's already
    // published — keep the shared feed's copy from going stale.
    if (dream.isPublished) syncPublishedDreamToFeed(dream);
    // 'video_created' — fires on EVERY completed generation (fresh,
    // resumed, or a regenerate/"Try Again"/"Turn this into a video"), not
    // just the account's first ever (see markFirstVideoCreatedIfEligible/
    // 'first_video_created' above, a distinct one-time KPI). This is the
    // total creation-volume counter Phase 1 reporting needs — finalizeDream
    // is the single choke point every generation completion already runs
    // through (startGeneration's only call site, reached from
    // result.html's fresh generate, explore.html's resume-completion path,
    // and every regenerate/edit-style/turn-into-video flow alike), so this
    // is the one place that's true for all of them. PostHog only — unlike
    // FirstVideoCreated (a genuine one-time ad-optimization signal worth
    // sending to Meta), a per-generation volume counter fires far too often
    // to be a useful Meta conversion event, and Meta CAPI has no use for a
    // metric that isn't a discrete, rare "this person just did the thing"
    // moment (see docs/EVENT_TAXONOMY.md for the full reasoning). Same
    // "never break the app" fire-and-forget discipline as every other
    // analytics call in this file. Phase 1 reporting instrumentation —
    // tracker item for-product-phase-1-reporting-instrument-kjlh46.
    trackAnalytics('video_created', { style: dream.style, mediaType: dream.mediaType });
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
    // Default 'video' — every existing caller (generateVideo, and any
    // resumed pendingJob predating this field) keeps working unchanged.
    var mediaType = opts.mediaType === 'image' ? 'image' : 'video';
    // Only meaningful (and only ever sent) on the video path — the "Turn
    // this into a video" upsell (see turnImageIntoVideo below). An image
    // generation never takes a sourceImageUrl (there is no "image-to-image"
    // concept here).
    var sourceImageUrl = (mediaType === 'video' && opts.sourceImageUrl) ? opts.sourceImageUrl : null;
    // storyText (tracker item for-product-split-prompttext-storytext-
    // f-yt5kc7) — the human-readable dream description, distinct from
    // `caption` (the full engineered generation prompt this function's
    // `caption` argument always was). Never sent to generate-video.js/
    // generate-image.js (they only ever want the engineered prompt) —
    // only carried through savePendingJob (so a resumed job keeps it —
    // see resumePendingJob below) and finalizeDream (so the completed
    // dream record gets it). A caller that doesn't pass one (any
    // not-yet-updated call site, or a legacy resumed job) simply gets
    // finalizeDream's own caption fallback — see that function's doc
    // comment.
    var storyText = opts.storyText || null;
    var submitUrl = mediaType === 'image' ? '/.netlify/functions/generate-image' : '/.netlify/functions/generate-video';
    // Captured once, up front, so the SAME value is used both on the
    // submission request below and later on every status poll (see
    // pollUntilDone's own doc comment) — an account's email can't change
    // mid-generation in any way that should retroactively affect which
    // balance a post-submission-failure refund lands on.
    var email = currentAccountEmail();

    // Captured here (rather than threaded through pollUntilDone's own
    // resolved value) so finalizeDream below can stamp it onto the
    // completed dream — see that function's own doc comment for why.
    var capturedOperationName = null;

    var operationPromise = resume
      ? Promise.resolve(resume.operationName)
      : fetch(submitUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(Object.assign({
            caption: caption, style: style, characters: characters,
            cameraView: opts.cameraView || null,
            sceneryTime: opts.sceneryTime || null,
            sceneryPlace: opts.sceneryPlace || null,
            // Sent whenever the browser knows it (logged-in account with an
            // email on file) — this is load-bearing, not opportunistic: the
            // server-side E112/E412 token gate (see lib/entitlements.js and
            // the doc block above generate-video.js's guardrails) is
            // unconditional and always on, and identifies the caller's token
            // balance by this email. No email means no way to look up a
            // balance, so an anonymous/logged-out call here fails the gate.
            email: email,
            // Best-effort Cloudflare Turnstile token, resolved client-side by
            // processing.html before calling generateVideo/generateImage/
            // regenerateDream (see js/turnstile-config.js's
            // getTurnstileToken()) — null until a real TURNSTILE_SITE_KEY is
            // configured there. Only actually checked server-side (E113/
            // E413) once TURNSTILE_SECRET_KEY is likewise configured — see
            // generate-video.js's doc block.
            turnstileToken: opts.turnstileToken || null,
            // Opportunistic, same shape as email above — null for every
            // caller except the founder's own browser after a successful
            // verifyOwnerBypass() (see that function and admin.html's
            // "Owner Generation Bypass" control). generate-video.js/
            // generate-image.js independently re-verify this server-side
            // on every request (lib/owner-bypass.js's verifyBypassToken) —
            // this is never trusted as-is.
            ownerBypassToken: getOwnerBypassToken()
          }, sourceImageUrl ? { sourceImageUrl: sourceImageUrl } : {},
          // Audio/music toggle (tracker item for-product-audio-on-off-
          // choice-at-creat-dyyr98) — video-only, same reasoning as
          // sourceImageUrl above: only ever sent (and only ever
          // meaningful) on the video path, so an image submission never
          // carries these keys at all rather than sending an always-false
          // audioOn generate-image.js has no use for. musicStyle is only
          // included when audioOn is actually true — generate-video.js's
          // own server-side computation ignores it otherwise anyway, but
          // omitting it here keeps the wire payload honest about what
          // actually matters.
          mediaType === 'video' ? Object.assign(
            { audioOn: !!opts.audioOn },
            opts.audioOn ? { musicStyle: opts.musicStyle || null } : {}
          ) : {}))
        }).then(function (res) {
          return res.json().then(function (data) {
            if (!res.ok) throw new Error(data.error || 'E399: generation_failed');
            return data.operationName;
          });
        }, function (err) {
          throw new Error('E303: network_error_starting_generation' + (err && err.message ? ': ' + err.message : ''));
        });

    return operationPromise.then(function (operationName) {
      capturedOperationName = operationName;
      var startedAt = resume ? resume.startedAt : Date.now();
      savePendingJob({
        operationName: operationName, startedAt: startedAt,
        caption: caption, storyText: storyText, style: style, sourceDreamId: sourceDreamId,
        mediaType: mediaType,
        // Audio/music toggle (tracker item for-product-audio-on-off-
        // choice-at-creat-dyyr98) — stamped onto the job itself (not just
        // read off the draft) so processing.html's wait-screen checklist
        // can read this LIVE for a RESUMED job too (e.g. after leaving and
        // returning to Processing, or a page reload mid-generation), where
        // the original draft may already be gone/changed — same reasoning
        // as mediaType being stamped here rather than re-derived from the
        // draft each time. Video-only, mirrors the request payload's own
        // mediaType-gated audioOn above.
        audioOn: mediaType === 'video' ? !!opts.audioOn : false,
        // Reads state.pendingJob directly rather than through
        // scopedPendingJob() / the already-scoped `job` resumePendingJob()
        // obtained — safe here specifically because a resume can only ever
        // reach this line synchronously within the same microtask
        // resumePendingJob() called it from (operationPromise resolves
        // immediately via Promise.resolve(resume.operationName) on the
        // resume path, with nothing awaited in between that could log the
        // user out or switch accounts), so state.pendingJob is still
        // provably the same job that was just validated as theirs. Not
        // restructured to go through the scoped accessor too, to keep this
        // review round's fix to the actual bug (ownerHandle backfill,
        // above) rather than a speculative "while I'm here" refactor.
        notify: (resume && state.pendingJob && state.pendingJob.notify) || false
      });
      return pollUntilDone(operationName, startedAt, mediaType, email);
    }).then(function (mediaUrl) {
      var dream = finalizeDream(mediaUrl, caption, style, sourceDreamId, mediaType, capturedOperationName, storyText);
      // No duration concept applies to a still image — only probe/patch
      // dream.dur on the video path. Don't make the user wait on this —
      // probing needs a real network round trip to the video itself and
      // can be slow (or time out) for reasons that have nothing to do with
      // generation being done. Patch the duration in once it's known
      // instead of blocking completion.
      if (mediaType === 'video') {
        probeVideoDuration(mediaUrl).then(function (dur) {
          if (dur) { dream.dur = dur; persist(); }
        });
      }
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

  // Set by commitTransferredSession (below) exactly when THIS page load
  // just consumed a valid `?bt=` session-transfer token — i.e. the visitor
  // just landed here signed in, straight out of an FB/IG in-app webview's
  // "open in browser" action (see consumeSessionTransferTokenFromUrlSync's
  // own doc comment). Read by js/install-nudge.js's wasSessionJustTransferred
  // below — this is the "just escaped the webview into a real browser"
  // moment tracker item home-screen-shortcut-a2hs-nudge-founder--yylzoq's
  // placement analysis calls out as the best moment for the install nudge,
  // now absorbed into for-product-build-stage-0-pwa-web-push-f-jbutt5. A
  // page-load-scoped flag (never persisted) — deliberately not
  // localStorage-backed, since "was this THIS load" is exactly what it
  // needs to mean; every subsequent load of the same page starts false
  // again until another transfer token is consumed.
  var sessionTransferredThisLoad = false;

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
   * localStorage marker recording the PostHog distinct_id this browser was
   * explicitly identify()'d as BEFORE any real account existed for it —
   * today, only ever the marketing-funnel cross-domain handoff distinct_id
   * (see linkPreSignupIdentity below and start.html's call site), but
   * written generically enough to cover any future "identify once as
   * something, later identify again as the real account" call site the
   * same way.
   *
   * Root cause this exists to fix (tracker item
   * for-product-data-bug-posthog-identity-br-vytqwy, found building
   * founder analytics dashboards: a real signup's PostHog person history
   * started at 'signed_up', with every pre-signup funnel event sitting on
   * a separate, orphaned person): PostHog's identify() only auto-merges
   * the FIRST time it's ever called on a given browser (from PostHog's
   * default anonymous, device-generated distinct_id). A SECOND identify()
   * call with a genuinely different distinct_id — e.g. identifyForAnalytics
   * below, landing on a browser this app already explicitly identified
   * once via the funnel handoff — does NOT auto-merge; PostHog just starts
   * a brand-new, disconnected person, silently orphaning every pre-signup
   * funnel event under the first identify's distinct_id. identifyForAnalytics
   * reads this marker back and calls posthog.alias() to merge the two
   * identities into one PostHog person before ever calling identify() a
   * second time.
   *
   * Bounded by PRE_ACCOUNT_MARKER_TTL_MS (see its own comment) — a marker
   * older than that is treated as expired/ignorable by every reader
   * below, and cleared outright by logout()/deleteAccount(), specifically
   * to bound how long a stale marker from one visitor can survive to be
   * misread by someone else entirely on a shared device (review round 2,
   * tracker item for-product-data-bug-posthog-identity-br-vytqwy — see
   * readLivePreAccountMarker's own comment for the full writeup).
   */
  var PRE_ACCOUNT_DISTINCT_ID_KEY = 'dreamtube_ph_pre_account_distinct_id';
  var PRE_ACCOUNT_DISTINCT_ID_WRITTEN_AT_KEY = 'dreamtube_ph_pre_account_distinct_id_written_at';

  // How long a pre-account marker is trusted before it's treated as
  // expired garbage rather than something real to alias/merge against.
  // 6 hours — comfortably covers a real same-day "browse the funnel,
  // convert later that day" gap (this app has no session/cookie
  // expiry of its own to match against — everything here is plain
  // localStorage, see js/store.js's header), while still keeping the
  // window in which a stale marker from visitor X could get
  // misattributed to an unrelated visitor Y on a shared device (review
  // round 2 finding) short enough to be a non-issue in practice. Not a
  // vendor/security decision requiring sign-off — a plain tuning
  // parameter with no external dependency; can be adjusted later without
  // any architectural change if real PostHog data (once the live check
  // this tracker item is waiting on happens) suggests a different window
  // fits DreamTube's actual funnel-to-signup timing better.
  var PRE_ACCOUNT_MARKER_TTL_MS = 6 * 60 * 60 * 1000;

  /**
   * Reads the pre-account marker IFF it both exists and is still within
   * PRE_ACCOUNT_MARKER_TTL_MS of when it was written — otherwise returns
   * null, treating an expired marker exactly like no marker at all (and
   * opportunistically clearing it, since it's stale garbage either way).
   *
   * Root cause this bounds (review round 2, tracker item
   * for-product-data-bug-posthog-identity-br-vytqwy): the marker had no
   * expiry and no cleanup path other than identifyForAnalytics actually
   * consuming it. On a SHARED device (library, family computer), that
   * meant: visitor X hits the marketing funnel, never converts, and
   * abandons the device — the marker just sits in localStorage
   * indefinitely. A completely UNRELATED later visitor Y then logs into
   * THEIR OWN, pre-existing account on that same device; Y's login hits
   * identifyForAnalytics, finds X's stale marker, and merges X's
   * anonymous marketing-visit history into Y's real PostHog person —
   * silently corrupting ad-attribution data for a person who never even
   * touched the funnel. A TTL can't fully solve "is this the same
   * person" from localStorage alone (nothing client-side can, on a
   * shared device), but it bounds the exposure window to something
   * short relative to how rare same-device-different-person handoffs
   * inside a few hours actually are — logout()/deleteAccount() clearing
   * the marker outright (see their own call sites) covers the far more
   * common "device handed to someone else after a deliberate sign-out"
   * case immediately, without waiting out the TTL at all.
   */
  function readLivePreAccountMarker() {
    var distinctId = null;
    var writtenAt = null;
    try {
      distinctId = localStorage.getItem(PRE_ACCOUNT_DISTINCT_ID_KEY);
      writtenAt = parseInt(localStorage.getItem(PRE_ACCOUNT_DISTINCT_ID_WRITTEN_AT_KEY), 10);
    } catch (e) { return null; }
    if (!distinctId) return null;
    if (!writtenAt || Date.now() - writtenAt > PRE_ACCOUNT_MARKER_TTL_MS) {
      clearPreAccountMarker();
      return null;
    }
    return distinctId;
  }

  /** Writes the pre-account marker (distinct_id + a fresh timestamp for readLivePreAccountMarker's TTL check) — the one place either key is ever set. Best-effort, matching every other localStorage write in this file. */
  function writePreAccountMarker(distinctId) {
    try {
      localStorage.setItem(PRE_ACCOUNT_DISTINCT_ID_KEY, distinctId);
      localStorage.setItem(PRE_ACCOUNT_DISTINCT_ID_WRITTEN_AT_KEY, String(Date.now()));
    } catch (e) { /* best-effort — see PRE_ACCOUNT_DISTINCT_ID_KEY's own comment */ }
  }

  /** Removes the pre-account marker outright (both keys) — called once it's been consumed by identifyForAnalytics, once it's found expired by readLivePreAccountMarker, and from logout()/deleteAccount() (see their own call sites) so a signed-out/deleted session never leaves a dangling marker for whoever uses this device next. */
  function clearPreAccountMarker() {
    try {
      localStorage.removeItem(PRE_ACCOUNT_DISTINCT_ID_KEY);
      localStorage.removeItem(PRE_ACCOUNT_DISTINCT_ID_WRITTEN_AT_KEY);
    } catch (e) { /* best-effort */ }
  }

  /**
   * Records that this browser was just explicitly identify()'d as
   * `distinctId` for a reason OTHER than a real signed-in account existing
   * yet — today, only the marketing-funnel cross-domain handoff (see
   * start.html's own "Cross-app PostHog identity linking" comment, which
   * calls this instead of posthog.identify() directly). Persisted to
   * localStorage, not just an in-memory flag, because the real-account
   * identify() call this needs to merge with (identifyForAnalytics below)
   * can happen much later and/or on a completely different page load of
   * this static site — e.g. the visitor abandons start.html mid-funnel,
   * closes the tab, and signs up from wizard.html on the same browser
   * days later. identifyForAnalytics reads this back whenever that
   * eventually happens, however far apart in time (bounded by
   * PRE_ACCOUNT_MARKER_TTL_MS — see readLivePreAccountMarker), and
   * consumes (removes) it then.
   *
   * No-ops safely (same guarded shape as identifyForAnalytics/
   * trackAnalytics) if PostHog was never initialized or localStorage is
   * unavailable — never lets an analytics failure break the app.
   *
   * Three review-round findings, all fixed here (tracker item
   * for-product-data-bug-posthog-identity-br-vytqwy):
   *
   * (a) Already-signed-in browser re-triggering the funnel handoff — a
   * browser signed in as a real account has nothing meaningful to link
   * pre-signup: identifyForAnalytics already gave it the correct,
   * authoritative PostHog identity at signup/login time. Without this
   * guard, a funnel-handoff visit on a shared/reused browser (family
   * computer, a stale/shared marketing link) would re-identify it as the
   * funnel's distinct_id — misattributing every event captured for the
   * rest of THIS session to the wrong PostHog person — and write a
   * marker that a DIFFERENT real account's later identifyForAnalytics
   * call could then alias() against, merging one person's pre-signup
   * funnel history into an unrelated account. Mirrors
   * commitTransferredSession's own "already signed in" guard elsewhere in
   * this file (`if (state.user && ...) return;`) — same root concern,
   * same fix shape.
   *
   * (b) Repeat funnel visits before ever converting (ordinary retargeting
   * behavior) — PostHog persists its OWN distinct_id across page loads on
   * this app's origin, so by the time a SECOND linkPreSignupIdentity call
   * lands with a genuinely different distinctId, the browser is already
   * currently identified as the FIRST call's id, not anonymous. Calling
   * identify() again on its own would hit this exact fix's own documented
   * root cause (a second identify() to a different distinct_id does not
   * auto-merge) and silently orphan the first visit's pre-signup events
   * the moment the marker gets overwritten, with no later chance to alias
   * them back in. Fixed the same way identifyForAnalytics merges into a
   * real account below: alias the OLD marker's distinct_id into the NEW
   * one FIRST, so PostHog's person-merge composes transitively across
   * however many pre-signup visits happen before the eventual real
   * identifyForAnalytics call — nothing from any visit is ever lost.
   *
   * (c) A stale, un-consumed marker from a DIFFERENT, unrelated earlier
   * visitor on a shared device — see readLivePreAccountMarker's own
   * comment for the full writeup; fixed by the TTL check below plus
   * logout()/deleteAccount() clearing the marker outright.
   */
  function linkPreSignupIdentity(distinctId) {
    if (!distinctId) return;
    // (a) — see doc comment above.
    if (state.user) return;

    if (typeof window !== 'undefined' && window.posthog && typeof window.posthog.identify === 'function') {
      // (b)/(c) — see doc comment above.
      var previousDistinctId = readLivePreAccountMarker();
      if (previousDistinctId && previousDistinctId !== distinctId && typeof window.posthog.alias === 'function') {
        try { window.posthog.alias(distinctId, previousDistinctId); } catch (e) { /* analytics must never break the app */ }
      }
      try { window.posthog.identify(distinctId); } catch (e) { /* analytics must never break the app */ }
    }
    writePreAccountMarker(distinctId);
  }

  /**
   * Tells PostHog "this browser is now this account" right after a real
   * signup/login succeeds, so behavior before/after auth stitches into one
   * person and cross-session identity works for whatever real accounts
   * exist today — and keeps working unchanged once a real backend/session
   * system replaces this localStorage one, since this is called from the
   * same signup()/login() seam a real implementation would use too.
   *
   * Before ever calling identify() itself, checks PRE_ACCOUNT_DISTINCT_ID_KEY
   * (see its own comment for the full root-cause writeup) — if this
   * browser was already explicitly identified once before (today, only
   * via the funnel handoff, linkPreSignupIdentity above), calls
   * posthog.alias(usernameOrEmail, previousDistinctId) FIRST so the two
   * distinct_ids merge into one PostHog person, since a second identify()
   * call alone would not auto-merge them. posthog-js's
   * alias(alias_id, original_id) takes the NEW id first and the
   * ALREADY-identified id second — see posthog-js's own alias() docs/
   * typings; reversing this order would silently merge in the wrong
   * direction. The marker is consumed (removed) the moment it's read,
   * whether or not it actually needed an alias() call (e.g. it already
   * happens to equal usernameOrEmail) — its job is done either way, and
   * leaving it behind risks it getting aliased against a LATER, unrelated
   * identify() call (e.g. a different account logging in on a shared/
   * reused browser).
   *
   * No-ops safely if PostHog was never initialized (POSTHOG_KEY is still
   * the placeholder in js/analytics-config.js — see that file), since
   * window.posthog simply won't exist in that case. Never lets an
   * analytics failure break auth.
   *
   * Reads the marker via readLivePreAccountMarker (not a raw localStorage
   * read) — an expired marker (review round 2 finding: a stale marker
   * from an unrelated earlier visitor on a shared device — see that
   * function's own comment) is treated as absent, never aliased against.
   */
  function identifyForAnalytics(usernameOrEmail) {
    if (typeof window === 'undefined' || !window.posthog || typeof window.posthog.identify !== 'function') return;

    var previousDistinctId = readLivePreAccountMarker();
    if (previousDistinctId) {
      clearPreAccountMarker();
      if (previousDistinctId !== usernameOrEmail && typeof window.posthog.alias === 'function') {
        try { window.posthog.alias(usernameOrEmail, previousDistinctId); } catch (e) { /* analytics must never break auth */ }
      }
    }

    try { window.posthog.identify(usernameOrEmail); } catch (e) { /* analytics must never break auth */ }

    // Tracker item for-product-data-hygiene-tag-exclude-tes-2lp0uw: 22 of 23
    // purchase_completed events in PostHog turned out to be test fixtures
    // (@example.com emails, __probe_..._..__-style throwaway usernames) that
    // the existing Israel-geo filter never catches, contaminating the new
    // Business Overview dashboard's Purchases/Revenue tiles. Best-practice
    // fix per PostHog's own docs (Project settings -> "Filter out internal
    // and test users", driven off a dedicated person property) is to tag a
    // PERSON property once at identify time — not a per-event property
    // re-sent on every capture() call — so this is the one seam every real
    // identify() already goes through. This only makes the data taggable;
    // wiring the actual dashboard-level exclusion using it is explicitly
    // Manager's own follow-up per that tracker item, not this change.
    if (isTestOrInternalIdentity(usernameOrEmail)) {
      try {
        if (typeof window.posthog.setPersonProperties === 'function') {
          window.posthog.setPersonProperties({ is_test: true });
        }
      } catch (e) { /* analytics must never break auth */ }
    }
  }

  // Founder's own real accounts — excluded from revenue reporting per the
  // founder's standing "no contaminated data" rule. benbrightman14 is a
  // confirmed, founder-approved secondary identity (his son's account — see
  // owner-topup-tokens.js's own header comment on tracker item
  // for-product-extend-owner-top-up-with-a-t-2hmopn). These are USERNAMEs,
  // not emails: identifyForAnalytics is always called with the account's
  // username (the distinct_id this app identifies with), never its email —
  // see every call site above (commitLocalSignup/attemptLocalLogin/etc.).
  // Deliberately NOT OWNER_EMAIL itself: that's a server-only env var (see
  // lib/owner-bypass.js) with no client-side equivalent, and profile.html's
  // owner-topup-block already establishes this codebase's convention of
  // never hardcoding the real owner email client-side for an owner check.
  // The founder's known usernames serve this analytics-labeling purpose
  // just as well without that tradeoff — this is a low-stakes reporting
  // tag, not a privilege/security check.
  var TEST_OR_INTERNAL_USERNAMES = { ronbrightman: true, benbrightman14: true };

  /**
   * True if `usernameOrEmail` (whatever identifyForAnalytics was just asked
   * to identify as) should be tagged `is_test` in PostHog: a known founder
   * account, an `@example.com` test-fixture email (checked directly, and
   * via the matching account's on-file email in state.accounts, since the
   * distinct_id identifyForAnalytics receives is normally a username, not
   * an email), or a probe-style throwaway username matching the exact
   * `/^__.+__$/` shape register-account.js's E10 suspicious_username check
   * and this file's own signup() already treat as a synthetic autofill
   * placeholder rather than a real human-chosen name (see signup()'s own
   * comment for the incident this pattern comes from) — reused here rather
   * than a new heuristic, per the tracker item's own explicit instruction.
   */
  function isTestOrInternalIdentity(usernameOrEmail) {
    var raw = String(usernameOrEmail || '');
    var key = raw.toLowerCase();
    if (TEST_OR_INTERNAL_USERNAMES[key]) return true;
    if (/^__.+__$/.test(raw)) return true;
    if (/@example\.com$/i.test(raw)) return true;
    var account = state.accounts[key];
    if (account && account.email && /@example\.com$/i.test(account.email)) return true;
    return false;
  }

  /**
   * Bare, no-properties PostHog capture helper — same guarded shape as
   * every page's own local `track()` helper (see result.html/shop.html),
   * just living here since these particular fires happen from store-level
   * logic (signup, generation completion), not from a specific page's
   * inline script. Fire-and-forget: analytics must never break the actual
   * app flow it's attached to.
   */
  function trackAnalytics(name, props) {
    if (typeof window !== 'undefined' && window.posthog && typeof window.posthog.capture === 'function') {
      try { window.posthog.capture(name, props || {}); } catch (e) { /* analytics must never break the app */ }
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

  /** Writes a brand-new local account entry + signs in, exactly as signup() always has — used both when the server confirms the account was created, and as the offline/unreachable-server fallback below. `createdAt` (epoch ms) is new — this is the ONLY moment a brand-new account is ever created, so it's the one place that can stamp a real signup time; see getAccountCreatedAt's own doc comment for why a pre-existing account (created before this field existed) simply has none rather than a fabricated one. `authToken` (tracker item for-product-public-feed-safety-in-app-re-ppuw77) is register-account.js's own minted lib/account-auth-token.js token when this is the REAL server-confirmed branch, or `null` for the offline/unreachable-server fallback (see signup()'s own call sites) — there's no real server-verified identity to hand a token for in that fallback case, and that's fine: state.user.authToken simply stays null/absent, which every authToken-gated feature (currently just blockUser/unblockUser/syncBlockedHandlesFromServer) already treats as "skip the server-side sync, the local effect still fully applies" (see those functions' own doc comments). */
  function commitLocalSignup(username, password, email, authToken) {
    var key = username.toLowerCase();
    state.accounts[key] = { password: password, email: email.toLowerCase(), createdAt: Date.now() };
    // Realistically unreachable for the renamed account specifically (the
    // server-side rename already claims u:ronbrightman, so a real signup
    // attempt for it fails server-side before this offline-fallback path
    // ever runs) — pinned anyway for the same reason every other
    // state.user constructor in this file now routes through this: no
    // more relying on "should be unreachable" reasoning per site, see
    // pinLegacyRenameIdentity's own doc comment.
    username = pinLegacyRenameIdentity(key, username);
    // Defense in depth — see attemptLocalLogin's identical call and
    // clearLikesTrackingState's own doc comment.
    clearLikesTrackingState();
    state.user = { handle: '@' + username, username: username, authToken: authToken || null };
    persist();
    identifyForAnalytics(username);
    // 'signed_up' — a dedicated PostHog event distinct from the identify()
    // call above, so PostHog funnels/dashboards can query "an account was
    // actually created" directly rather than inferring it from identify()
    // calls (which also happen on every ordinary login — see
    // attemptLocalLogin/login() below, neither of which fires this).
    // commitLocalSignup is the ONE place a brand-new account is ever
    // created (both the server-confirmed and offline-fallback signup
    // branches route through here — see signup()'s own comment), so this
    // fires exactly once per real signup, never on a later login from any
    // device. Phase 1 reporting instrumentation — tracker item
    // for-product-phase-1-reporting-instrument-kjlh46.
    trackAnalytics('signed_up');
    return { ok: true, user: state.user };
  }

  // Monotonic call-sequence counter guarding commitLocalSignup against a
  // stale/abandoned DreamStore.signup() call's late settlement clobbering
  // state.user out from under a newer, still-current one (tracker item
  // dreamstore-signup-commits-state-user-unc-vv6rio). wizard.html and
  // start.html each already gate their OWN callback bodies with a
  // per-attempt signupAttemptToken (see either file's own doc comment for
  // that pattern's full "why") — but that guard lives entirely in the
  // caller, one layer above signup() itself, and commitLocalSignup's
  // state.user write happens INSIDE signup(), before any caller callback
  // (and thus before the caller's own token check) ever runs. So no
  // caller-side guard can prevent it: two concurrent DreamStore.signup()
  // calls (today only reachable via a devtools bypass of wizard.html's/
  // start.html's disabled Continue/Back buttons, or from any OTHER
  // caller — see login.html and claim-dream.html, neither of which has
  // an equivalent UI-level token — that never disables its own controls
  // the same careful way) would let whichever one's network response
  // happens to land LAST silently overwrite state.user set by
  // whichever landed first, even if that first one was actually the
  // attempt that should still be current.
  //
  // Fixed here, at the layer where the mutation actually happens, rather
  // than only in each caller: every signup() call that reaches the
  // network captures the NEXT value of this counter as its own sequence
  // number, right before firing the request. By the time its response
  // lands, it only commits if it's still the MOST RECENTLY STARTED call
  // — i.e. no newer signup() call has begun in the meantime. This is
  // call-ORDER based, not resolve-order based, deliberately: if call A
  // starts, then call B starts before A resolves, B is "current" from
  // the moment it starts, regardless of whether A's response happens to
  // arrive before or after B's. That matches wizard.html's/start.html's
  // own signupAttemptToken semantics (bumped on every new attempt) and
  // is the only ordering a caller's Back-then-resubmit flow can rely on.
  //
  // This makes DreamStore.signup() inherently safe for ANY caller, not
  // just wizard.html/start.html — the same idiom state.pendingJob already
  // uses for a different "which one is current" concern (ownerHandle
  // scoping, see savePendingJob/scopedPendingJob above), just applied to
  // call recency instead of account identity.
  var signupCallSeq = 0;

  /**
   * Commits a signup only if `mySeq` is still the most recently STARTED
   * signup() call (see signupCallSeq's own comment above). A superseded
   * call resolves with `{ ok:false, superseded:true, error }` instead of
   * writing anything — no state.accounts entry, no state.user, no
   * identifyForAnalytics call — so a stale attempt has zero observable
   * effect on local state, exactly like wizard.html's/start.html's own
   * token-gated callbacks already discard a stale UI-level result
   * wholesale rather than partially applying it. The account this call
   * itself just registered server-side (if this is the `ok:true` server
   * branch, not the offline fallback) is NOT lost: a later login() for
   * that same username re-checks the server (authoritative) and
   * materializes the local `accounts` entry then, same as any other
   * account created on a different device — see login()'s own comment.
   */
  function commitLocalSignupIfCurrent(mySeq, username, password, email, authToken) {
    if (mySeq !== signupCallSeq) {
      return { ok: false, superseded: true, error: 'Superseded by a newer signup attempt.' };
    }
    return commitLocalSignup(username, password, email, authToken);
  }

  /**
   * Bumps signupCallSeq WITHOUT starting a signup() call of its own — the
   * store-level half of tracker item
   * js-store-js-signupcallseq-only-invalidat-ijwpht. signupCallSeq (see
   * its own doc comment above) only ever bumped when a NEW signup() call
   * actually reached the network, which correctly invalidates an
   * abandoned attempt's late settlement against a genuinely newer
   * competing signup() call, but does nothing for the far more common
   * case: the visitor just navigates away (Back, Change email) and never
   * resubmits at all. In that case signupCallSeq never bumps again, so
   * commitLocalSignupIfCurrent's mySeq === signupCallSeq check still
   * passes once the original call's response lands late, and it silently
   * commits state.user/state.accounts anyway — even though
   * wizard.html's/start.html's own UI-level signupAttemptToken guard
   * correctly kept the visible screen from reacting to it. That UI-level
   * token only gates what the CALLER does with a stale response (skip
   * navigating, skip re-rendering); it has no way to reach into the
   * store and stop the write itself, since commitLocalSignupIfCurrent
   * runs inside signup(), before any caller callback (or its token
   * check) ever executes.
   *
   * Callable from any UI page the same moment it bumps its own
   * navigation-away token (wizard.html's/start.html's backBtn handlers,
   * start.html's Change-email link) — see each call site's own comment.
   * Synchronous, side-effect-free beyond the counter bump: matches
   * signupCallSeq's own stated design goal of making signup()'s
   * commit-guard safe for ANY caller, not just ones that happen to fire
   * a second signup() call.
   */
  function invalidatePendingSignup() {
    signupCallSeq++;
  }

  /** Maps register-account.js's error codes to the exact same human-readable strings signup() has always returned locally, so callers (e.g. start.html's attemptSignup, which string-matches 'That username is already taken.' to retry with a new suffix) don't need to know or care whether the rejection came from the server or a local check. */
  function mapRegisterError(code) {
    code = code || '';
    if (code.indexOf('email_taken') !== -1) return 'An account with that email already exists.';
    if (code.indexOf('invalid_username') !== -1) return 'Username must be at least 3 characters.';
    if (code.indexOf('suspicious_username') !== -1) return "That username doesn't look right — please type your own username.";
    if (code.indexOf('invalid_password') !== -1) return 'Password must be at least 3 characters.';
    if (code.indexOf('invalid_email') !== -1) return 'Enter a valid email address.';
    if (code.indexOf('rate_limited') !== -1) return "Too many signups from this network today — try again tomorrow.";
    // Default covers username_taken and anything else unexpected — matches
    // the original local-only error text for the single most common case.
    return 'That username is already taken.';
  }

  // One-off pair for the tracker item for-product-correct-founder-account-
  // user-flutrx (see netlify/functions/admin-rename-account.js's own header
  // comment for the server-side half of this rename) — hardcoded, on
  // purpose: this is a one-off correction for one real account, not a
  // general "migrate any rename" feature (the tracker item's own explicit
  // scope note). If another rename like this is ever needed, add another
  // hardcoded pair/call rather than generalizing this into a real feature.
  var LEGACY_ACCOUNT_RENAME = { fromUsername: '__probe_throwaway_user__', toUsername: 'ronbrightman' };

  /**
   * Re-stamps this BROWSER's own locally-cached data from the old
   * throwaway username onto the new one, the moment a login resolves to
   * LEGACY_ACCOUNT_RENAME.toUsername. admin-rename-account.js only ever
   * touches SERVER-side state (the account record, the shared feed) — it
   * has no way to reach into any browser's localStorage at all — so
   * without this, the very next login after that server-side rename would
   * hit login()'s existing "brand-new-to-this-device account" branch
   * below and silently show an empty account: state.dreams (filtered by
   * `d.ownerHandle === state.user.handle`, see getMyDreams/getDreamInsight/
   * getAccountBackup/etc.) and state.charactersByUser (keyed by lowercased
   * username) both stay local-only and keyed to the OLD identity forever,
   * unless something explicitly re-keys them. On the founder's own real,
   * actively-used account, that would look exactly like his dreams had
   * been destroyed by the rename, not merely relabeled.
   *
   * Safe to call on every login (cheap, idempotent) — once the data has
   * actually moved once, there's nothing left under the old handle/key to
   * find on any later call, so this becomes a permanent no-op after the
   * first real run. Only re-stamps dreams onto the new handle (never
   * pushes new entries — state.dreams is the one array shared by every
   * account that's ever used this browser, mutating d.ownerHandle in
   * place is safe exactly the same way toggleLike's own in-place dream
   * mutation is), and only moves charactersByUser's old-username entry
   * over if the new username doesn't already have real character data of
   * its own (defensive — never clobber data that's already legitimately
   * there under the new identity).
   *
   * Does NOT touch state.pendingJob — that's a single, short-lived
   * in-flight-generation slot (see savePendingJob/scopedPendingJob), not
   * a growing collection like dreams/characters; by the time this one-off
   * server-side rename actually runs, any pendingJob from testing under
   * the old throwaway identity is realistically long since resolved or
   * abandoned, and migrating a stale one risks resurfacing a confusing
   * "resume this old job" prompt for nothing.
   */
  function migrateLegacyThrowawayAccountData(serverUsername, displayUsername) {
    if (serverUsername !== LEGACY_ACCOUNT_RENAME.toUsername) return;

    // Match the old handle case-insensitively — the throwaway account may
    // have been logged into more than once with different typed casing
    // before this rename, and getMyDreams/etc.'s `===` match against
    // state.user.handle would otherwise silently leave a differently-cased
    // dream orphaned (unreachable under either the old or new identity).
    var oldHandleLower = ('@' + LEGACY_ACCOUNT_RENAME.fromUsername).toLowerCase();
    // login() now always pins displayUsername to the canonical lowercase
    // form for this one account (see its own comment), so this always
    // lands on the exact same handle string on every future login too —
    // no risk of the re-tag itself drifting across sessions.
    var newHandle = '@' + (displayUsername || LEGACY_ACCOUNT_RENAME.toUsername);
    state.dreams.forEach(function (d) {
      if ((d.ownerHandle || '').toLowerCase() === oldHandleLower) d.ownerHandle = newHandle;
    });

    var oldCharacters = state.charactersByUser[LEGACY_ACCOUNT_RENAME.fromUsername];
    var newCharacters = state.charactersByUser[LEGACY_ACCOUNT_RENAME.toUsername];
    if (oldCharacters && oldCharacters.length && (!newCharacters || !newCharacters.length)) {
      state.charactersByUser[LEGACY_ACCOUNT_RENAME.toUsername] = oldCharacters;
      delete state.charactersByUser[LEGACY_ACCOUNT_RENAME.fromUsername];
    }
  }

  /**
   * The ONE place every `state.user = {...}` construction site in this
   * file must route through, for this one hardcoded account. Review
   * found three consecutive rounds of "one more state.user-setting code
   * path got missed" (login()'s server-confirmed branch, then
   * attemptLocalLogin, then importAccountBackup) because each round's
   * fix was applied at its own call site instead of centralized here —
   * this function exists specifically so a FOURTH such gap can't happen:
   * every constructor of state.user for this account now calls this
   * exact same function, so there is nowhere left for the same bug to
   * hide. `key` must already be the canonical lowercase username (never
   * the raw typed/backup value) — every caller below already computes
   * this for its own purposes before constructing state.user, so this
   * never adds a new lowercase() call, just centralizes what happens
   * next. Returns the casing-pinned username to actually use.
   */
  function pinLegacyRenameIdentity(key, username) {
    if (key === LEGACY_ACCOUNT_RENAME.toUsername) {
      username = LEGACY_ACCOUNT_RENAME.toUsername;
    }
    migrateLegacyThrowawayAccountData(key, username);
    return username;
  }

  /** Maps delete-account.js's error codes to human-readable strings — same shape as mapRegisterError above. */
  function mapDeleteAccountError(code) {
    code = code || '';
    if (code.indexOf('incorrect_password') !== -1) return 'Incorrect password.';
    if (code.indexOf('rate_limited') !== -1) return 'Too many attempts — please wait and try again.';
    // deletion_failed: the password WAS verified — something failed while
    // actually deleting server-side (e.g. a Blobs error). Distinct from
    // not_found/incorrect_password, which are about the credential itself
    // — telling the user to re-check a password that already checked out
    // would be misleading.
    if (code.indexOf('deletion_failed') !== -1) return "Something went wrong deleting your account — please try again.";
    // not_found and anything else unexpected: this device's own local
    // account cache could in principle be stale (e.g. this account was
    // already deleted from a different device/tab) — surface a generic
    // message rather than implying the password itself was the problem.
    return "Couldn't verify your account — try again.";
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
    username = pinLegacyRenameIdentity(key, username);
    // Defense in depth (see clearLikesTrackingState's own doc comment):
    // login.html has no guard against submitting the login form while
    // already signed in as a different account, so this can't rely
    // solely on logout() having run first.
    clearLikesTrackingState();
    // authToken: null -- genuinely category-1 "no real server round trip
    // to mint one from" (reviewed explicitly for tracker item
    // publish-dream-js-trusts-client-supplied--lkppcu, which made Publish
    // authToken-gated too -- see that fix's own doc comments for why a
    // null token there is a bigger deal than it is for blockUser/
    // unblockUser). login()'s own comment above explains attemptLocalLogin
    // is ONLY ever reached when the real server-side account-login.js call
    // either found no matching account at all, or couldn't be reached --
    // by construction, there is no fresh, real password verification of
    // THIS login attempt to mint a token from. backfillAccountServerSide
    // below is a different thing entirely: a fire-and-forget, best-effort
    // registration of whatever's cached locally, which -- even when it
    // succeeds -- doesn't re-verify this attempt's password against any
    // pre-existing authoritative record (there wasn't one), so minting a
    // token off its result would look exactly as trustworthy as login()'s
    // real branch while actually being no stronger than the same local-
    // cache trust this whole fallback already represents. Net effect: a
    // dream published immediately after a local-only-account login (rare
    // -- only pre-server-store legacy accounts, or an outright
    // unreachable-server moment) won't reach the shared feed until this
    // account's next real, server-confirmed login elsewhere -- an honest,
    // accepted degrade, not a bug to chase further.
    state.user = { handle: '@' + username, username: username, authToken: null };
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

  /**
   * Commits a session-transfer-token-verified {username, email} as this
   * browser's current session — the passwordless counterpart to login()'s
   * own success branch (see that function's comment) — used ONLY by
   * consumeSessionTransferTokenFromUrlSync below, for an identity the
   * server has ALREADY verified via a real password check at token-MINT
   * time (see netlify/functions/create-session-transfer.js's own header
   * comment for why that's the real security boundary of this whole
   * feature). This function itself performs no verification of its own —
   * exactly like verify-session-transfer.js itself doesn't.
   *
   * Materializes a local `accounts` placeholder for `username` if this
   * browser has never seen it before (same "dreams/characters left empty,
   * synced elsewhere" shape login() already uses for a brand-new-to-this-
   * device account) — but with `password: null`, since there IS no
   * password to cache here (unlike login(), which always has the real
   * typed password on hand to store for this device's own future local-
   * fallback login). This one property is why a session established this
   * way can't opportunistically re-authenticate to password-gated,
   * best-effort endpoints like sendFirstDreamEmailBestEffort below (that
   * call simply no-ops server-side if the cached password doesn't match —
   * it never throws or blocks anything) — an accepted, narrow degrade,
   * not a bug: this session is real for everything else, it just never
   * had a password to cache.
   *
   * Round-2 review fix: refuses to commit if this browser is ALREADY
   * signed in as a genuinely DIFFERENT account. Without this, a valid
   * token minted for account A (a completely legitimate mint, using
   * A's own real password) landing on a device already signed in as B
   * would silently replace B's session with A's — reachable two ways:
   * (a) benignly, a shared/reused device switching identity with zero
   * warning the moment a stale/reused "open in browser" link lands; (b)
   * as a session-fixation-style vector, since nothing stops account A's
   * own holder from sending their own valid ?bt= URL to someone else —
   * "check this out" — and having that person's browser silently become
   * signed in AS A the moment they open it, with no confirmation, no
   * indication their own prior session (if any) just got swapped out.
   * A same-identity "refresh" (key already equals the signed-in user) is
   * still allowed through — harmless, matches what was already there.
   *
   * authToken (tracker item publish-dream-js-trusts-client-supplied--lkppcu,
   * found in review of that item's own fix): verify-session-transfer.js
   * now mints a real lib/account-auth-token.js token on every successful
   * verify — the exact same trust level as login()'s own real branch,
   * since the underlying password check already happened, just earlier,
   * at create-session-transfer.js's mint time. Before this, a session
   * committed here had a genuinely signed-in state.user with NO authToken
   * at all, which isn't a lesser-trust degrade the way a missing token is
   * for blockUser/unblockUser (whose LOCAL effect still fully applies
   * either way) — Publish has no local-only equivalent, so a null token
   * here meant a dream published right after this flow would silently,
   * permanently never reach the shared feed. See this function's own call
   * site (consumeSessionTransferTokenFromUrlSync) for where authToken
   * comes from.
   */
  function commitTransferredSession(username, email, authToken) {
    var key = (username || '').toLowerCase();
    if (!key) return;
    // Treat "signed in as someone whose username isn't readable" the same
    // as "signed in as someone" — block, don't fall through — so this
    // guard holds even against a malformed/legacy-shaped state.user, not
    // just the well-formed shape every current constructor produces.
    if (state.user && (!state.user.username || state.user.username.toLowerCase() !== key)) return;
    if (!state.accounts[key]) {
      state.accounts[key] = { password: null, email: (email || '').toLowerCase() || null };
    } else if (email) {
      state.accounts[key].email = email.toLowerCase();
    }
    var displayUsername = pinLegacyRenameIdentity(key, username);
    state.user = { handle: '@' + displayUsername, username: displayUsername, authToken: authToken || null };
    persist();
    identifyForAnalytics(displayUsername);
    sessionTransferredThisLoad = true;
  }

  window.DreamStore = {
    STYLE_GRADIENTS: STYLE_GRADIENTS,

    getCurrentUser: function () { return state.user; },

    /**
     * Public entry point for linkPreSignupIdentity above — see that
     * function's own doc comment for the full identity-merge story (tracker
     * item for-product-data-bug-posthog-identity-br-vytqwy). Called by
     * start.html's cross-app PostHog identity linking instead of it calling
     * posthog.identify() directly, so the marker that lets a LATER real
     * signup/login (identifyForAnalytics above) correctly alias() the two
     * distinct_ids together actually gets recorded.
     */
    linkPreSignupIdentity: linkPreSignupIdentity,

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
     *
     * Safe to call concurrently: if a newer call to this method starts
     * before an older one's network response lands, the older one's
     * result resolves as { ok:false, superseded:true, error } instead of
     * writing state.user/state.accounts — see signupCallSeq's doc
     * comment (just above commitLocalSignupIfCurrent) for the full
     * "why". Only the most-recently-STARTED call is ever allowed to
     * commit, regardless of resolve order.
     */
    signup: function (username, password, email) {
      username = (username || '').trim();
      var key = username.toLowerCase();
      email = (email || '').trim();
      if (username.length < 3) return Promise.resolve({ ok: false, error: 'Username must be at least 3 characters.' });
      // Real users never type a name wrapped in double underscores this
      // way — this exact shape (__word_word__) is the signature of a
      // privacy-focused mobile browser/extension auto-injecting a synthetic
      // placeholder into a field it detects via autocomplete="username"
      // (see the #fn-username/#login-username inputs), before the user
      // gets a chance to type their real choice. A real founder account
      // was created with the literal username "__probe_throwaway_user__"
      // this way. Rejecting the pattern outright can never false-positive
      // on a genuine human-chosen username.
      if (/^__.+__$/.test(username)) return Promise.resolve({ ok: false, error: "That username doesn't look right — please type your own username." });
      if (!password) return Promise.resolve({ ok: false, error: 'Enter a password.' });
      if (password.length < 3) return Promise.resolve({ ok: false, error: 'Password must be at least 3 characters.' });
      if (!EMAIL_RE.test(email)) return Promise.resolve({ ok: false, error: 'Enter a valid email address.' });
      if (state.accounts[key]) return Promise.resolve({ ok: false, error: 'That username is already taken.' });
      if (findAccountKeyByEmail(email)) return Promise.resolve({ ok: false, error: 'An account with that email already exists.' });

      // Captured now, right before the real network call fires (not
      // earlier — a synchronous validation-failure "call" above never
      // reaches here and must never bump this, or it could wrongly
      // supersede a genuinely-still-in-flight call). See signupCallSeq's
      // own comment for the full "why".
      var mySignupSeq = ++signupCallSeq;

      return fetch('/.netlify/functions/register-account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, password: password, email: email })
      }).then(function (res) {
        return res.json();
      }).then(function (data) {
        // authToken is only ever real on THIS branch (a genuine server-
        // confirmed account creation) — see commitLocalSignup's own doc
        // comment for why the two fallback branches below intentionally
        // pass none.
        if (data && data.ok) return commitLocalSignupIfCurrent(mySignupSeq, username, password, email, data.authToken);
        if (data && data.ok === false && data.error) return { ok: false, error: mapRegisterError(data.error) };
        // Unexpected/malformed response shape — treat the same as
        // unreachable below rather than surface a confusing error.
        return commitLocalSignupIfCurrent(mySignupSeq, username, password, email);
      }).catch(function () {
        // Network failure, or the functions runtime isn't available at all
        // (e.g. this repo's own static-file-server-only browser tests) —
        // degrade to local-only signup rather than hard-block account
        // creation. See this method's own doc comment above.
        return commitLocalSignupIfCurrent(mySignupSeq, username, password, email);
      });
    },

    /**
     * Invalidates any in-flight signup() call without starting a new one
     * — see invalidatePendingSignup's own doc comment above for the full
     * "why" (tracker item js-store-js-signupcallseq-only-invalidat-ijwpht).
     * Call this the same moment a caller bumps its own UI-level
     * navigation-away token (e.g. wizard.html's/start.html's backBtn
     * handlers, start.html's Change-email link), so an abandoned signup
     * attempt's late server response can never silently commit
     * state.user/state.accounts in the background after the visitor has
     * already navigated away, even though the visible screen correctly
     * never reacted to it.
     */
    invalidatePendingSignup: invalidatePendingSignup,

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
            // tracker.html's sync-private-dreams-videos-later item. The
            // ONE hardcoded exception is migrateLegacyThrowawayAccountData
            // below, for the one-off ronbrightman rename specifically —
            // see that function's own doc comment.
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
          displayUsername = pinLegacyRenameIdentity(serverUsername, displayUsername);
          // Defense in depth — see attemptLocalLogin's identical call and
          // clearLikesTrackingState's own doc comment.
          clearLikesTrackingState();
          // authToken: a real server-side password check just succeeded on
          // THIS branch, so data.authToken (account-login.js's freshly
          // minted lib/account-auth-token.js token) is a genuine proof of
          // identity -- see commitLocalSignup's doc comment for what this
          // enables/degrades-gracefully-without for authToken-gated
          // features.
          state.user = { handle: '@' + displayUsername, username: displayUsername, authToken: data.authToken || null };
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
      if (newPassword.length < 3) return Promise.resolve({ ok: false, error: 'Password must be at least 3 characters.' });

      return fetch('/.netlify/functions/verify-password-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token, consume: true, newPassword: newPassword })
      }).then(function (res) {
        return res.json();
      }).then(function (data) {
        if (!data || !data.ok) {
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

    /** The current user's account-creation timestamp (epoch ms), or null if unknown — either not logged in, or (the common case for now) an account that was created before this field existed, since there's no real history to backfill for those (same "don't fabricate" reasoning as tracker-store.js's createdAt/doneAt/startedAt). Used by the Settings support/feedback form to report "days since signup" as real context, never a guessed one. */
    getAccountCreatedAt: function () {
      return currentAccountCreatedAt();
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

    /**
     * Permanently deletes the signed-in account — both server-side (see
     * netlify/functions/delete-account.js's own header comment for exactly
     * what that deletes: the account record, the shared-feed's copy of any
     * published dreams, and the token ledger) and, ONLY once that server
     * call actually confirms success, THIS account's own slice of local
     * state (see wipeAllLocalState above — scoped to just this account,
     * not a wholesale wipe; still goes further than logout(), which only
     * ever clears state.user and leaves this account's own dreams/
     * characters/credentials in place for a later re-login). Requires the
     * account's real current password — the same re-check every other
     * destructive/password-gated flow in this codebase requires (see
     * delete-account.js's own header comment on why a client-claimed
     * username/email alone isn't enough here).
     *
     * Returns a Promise of { ok:true } or { ok:false, error } — error is
     * always a human-readable string, never a raw internal code (a
     * genuine network failure is mapped to a friendly message here, not
     * left as the literal 'network_error' for the caller to display
     * as-is). Never falls back to a local-only deletion the way signup()/
     * login() fall back to a local-only check on a server outage — unlike
     * those, there is no meaningful "local-only" version of permanently
     * destroying an account that might still be registered server-side; a
     * network failure here must surface as a real error, not silently
     * pretend to have deleted anything.
     */
    deleteAccount: function (password) {
      if (!state.user) return Promise.resolve({ ok: false, error: 'not_logged_in' });
      if (!password) return Promise.resolve({ ok: false, error: 'Enter your password to confirm.' });
      var username = state.user.username;
      var usernameKey = username.toLowerCase();
      var myHandle = state.user.handle;

      return fetch('/.netlify/functions/delete-account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, password: password })
      }).then(function (res) {
        return res.json();
      }).then(function (data) {
        if (data && data.ok) {
          wipeAllLocalState(usernameKey, myHandle);
          return { ok: true };
        }
        return { ok: false, error: mapDeleteAccountError(data && data.error) };
      }).catch(function () {
        return { ok: false, error: "Couldn't reach the server — check your connection and try again." };
      });
    },

    // Does NOT clear state.pendingJob — same account-scoping bug class as
    // state.dreams/charactersByUser (see getMyDreams below), but unlike a
    // wholesale clear-on-logout, pendingJob is now tagged with an
    // ownerHandle at write time (see savePendingJob) and every read
    // (getPendingJob/resumePendingJob/requestNotifyOnReady) is scoped to
    // whoever is CURRENTLY logged in via scopedPendingJob — so a different
    // account signing up/in on this browser before the job resolves can
    // never observe or overwrite it (the original bug,
    // state-pendingjob-not-cleared-on-logout-s-p2ivk2), while the SAME
    // account logging back out and back in mid-generation still sees and
    // can resume its own in-flight job (a real generation already spent
    // real tokens at submission — see generate-video.js's E112 doc block —
    // so silently losing the ability to resume/get notified on it would
    // waste that spend for no reason; an earlier version of this fix
    // wholesale-cleared pendingJob on logout and broke exactly this case,
    // caught in review).
    //
    // clearPreAccountMarker() (review round 2, tracker item
    // for-product-data-bug-posthog-identity-br-vytqwy): a signed-out
    // session must not leave a dangling PostHog pre-account marker
    // around for whoever uses this device next — see that function's own
    // comment for the full "shared device, unrelated later visitor" bug
    // this closes.
    //
    // clearLikesTrackingState() (cross-account localStorage leak flagged
    // in review of the notify-likes-badge branch): same "shared device,
    // unrelated later visitor" reasoning — a signed-out session must not
    // leave a stale LIKES_NEW_COUNT_KEY/LIKES_SEEN_KEY around for whoever
    // logs in next on this browser either. See that function's own
    // comment for the full repro this closes (an account with zero owned
    // published dreams could never clear a badge count it never earned,
    // since refreshNewLikesCount's own early-return used to skip the
    // write).
    logout: function () { state.user = null; clearPreAccountMarker(); clearLikesTrackingState(); persist(); },

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
     * home.html's Today/This-Week cards (tracker item
     * for-product-build-homepage-wave-1-the-ri-xr8mir) — local read, no
     * network call. Bundles three small, related date computations against
     * this account's own dreams (getMyDreams's own filter) PLUS the
     * account's "no recall" check-ins (see logNoRecallToday below — a
     * dream-log entry that deliberately never creates a fake dream record,
     * just a per-account date marker, so it never pollutes the shared
     * feed/My Dreams gallery/milestone count with content-less entries):
     *
     *   loggedToday    — true if a real dream (createdAt is today) OR a
     *                     "no recall" check-in for today exists.
     *   todayEntryType — 'dream' | 'no_recall' | null, whichever produced
     *                     loggedToday (a real dream wins if somehow both
     *                     exist the same day).
     *   todayDreamCaption — the caption of today's real dream, if that's
     *                     what loggedToday resolved from; null otherwise.
     *   loggedYesterday — same computation as loggedToday, one day back.
     *                     Exposed so a caller (home.html's silent-streak-
     *                     freeze analytics signal) never has to reach past
     *                     this function into raw localStorage/account
     *                     internals just to ask "was yesterday covered" —
     *                     everything about what "covered" means (a real
     *                     dream OR a no-recall check-in) stays defined in
     *                     exactly one place.
     *   weekCount      — qualifying entries (real dreams + no-recall
     *                     check-ins, each calendar day counted at most once
     *                     for no-recall since logNoRecallToday is itself
     *                     idempotent per day) since this week's Monday.
     *   weekTarget     — WEEK_SUMMARY_TARGET, exported so callers never
     *                     hardcode their own copy of the threshold.
     *   hasEverLogged  — true once this account has ever logged anything
     *                     at all (a real dream or a no-recall check-in) —
     *                     drives home.html's D1 (brand-new account)
     *                     next-step strip vs. the returning-user one.
     *
     * A dream saved before the createdAt field existed (see finalizeDream's
     * own doc comment) simply never counts toward loggedToday/weekCount —
     * same "missing means don't count it, never fabricate" rule every
     * other forward-only field in this file already follows.
     */
    getDreamLogStatus: function () {
      var myHandle = state.user ? state.user.handle : null;
      var mine = state.dreams.filter(function (d) { return !!myHandle && d.ownerHandle === myHandle && typeof d.createdAt === 'number'; });
      var key = state.user ? state.user.username.toLowerCase() : null;
      var account = key ? state.accounts[key] : null;
      var noRecallDates = (account && account.noRecallDates) || [];

      var now = new Date();
      var weekStart = startOfWeekMs(now);
      var weekDreamCount = mine.filter(function (d) { return d.createdAt >= weekStart; }).length;
      var weekNoRecallCount = noRecallDates.filter(function (ds) { return new Date(ds).getTime() >= weekStart; }).length;

      var todayStr = now.toDateString();
      var todayDream = mine.filter(function (d) { return new Date(d.createdAt).toDateString() === todayStr; })[0] || null;
      var todayNoRecall = noRecallDates.indexOf(todayStr) !== -1;

      var yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      var yesterdayStr = yesterday.toDateString();
      var loggedYesterday = mine.some(function (d) { return new Date(d.createdAt).toDateString() === yesterdayStr; }) || noRecallDates.indexOf(yesterdayStr) !== -1;

      return {
        loggedToday: !!todayDream || todayNoRecall,
        todayEntryType: todayDream ? 'dream' : (todayNoRecall ? 'no_recall' : null),
        todayDreamCaption: todayDream ? (todayDream.storyText || todayDream.caption) : null,
        loggedYesterday: loggedYesterday,
        weekCount: weekDreamCount + weekNoRecallCount,
        weekTarget: WEEK_SUMMARY_TARGET,
        hasEverLogged: mine.length > 0 || noRecallDates.length > 0
      };
    },

    /**
     * Logs a "no recall" dream-log entry for today — home.html's Today
     * card third entry point, alongside Write it/Speak it (see
     * getDreamLogStatus above for how this feeds loggedToday/weekCount).
     * Deliberately does NOT create a dream record: a no-recall entry has
     * no content to show on Explore, in My Dreams, or count toward the
     * Profile milestone chip, so folding it into state.dreams would mean
     * every reader of that array (the shared feed, profile.html's
     * grids, getDreamMilestone) would need a new "is this a real dream"
     * guard just to stay correct. Idempotent per calendar day (a second
     * tap the same day is a no-op, not a duplicate) and grants nothing —
     * no tokens, no achievement — per this wave's explicit scope cut
     * (achievement/grant ledger is a separate, not-yet-built tracker item).
     * No-ops (returns { ok:false }) when not logged in.
     */
    logNoRecallToday: function () {
      if (!state.user) return { ok: false };
      var key = state.user.username.toLowerCase();
      var account = state.accounts[key];
      if (!account) return { ok: false };
      if (!account.noRecallDates) account.noRecallDates = [];
      var todayStr = new Date().toDateString();
      if (account.noRecallDates.indexOf(todayStr) === -1) account.noRecallDates.push(todayStr);
      persist();
      return { ok: true };
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
      // Reachable, real path (see login.html's "Restore from backup" flow
      // and profile.html's own export-a-backup instruction) — pinned like
      // every other state.user constructor for the same reason, see
      // pinLegacyRenameIdentity's own doc comment. Known, accepted edge
      // case left as-is: a backup keyed to the OLD throwaway username
      // restored AFTER the rename does not itself get migrated here
      // (pinLegacyRenameIdentity/migrateLegacyThrowawayAccountData both
      // key off the account resolving to the NEW name) — it simply
      // restores the pre-rename identity locally, exactly as the backup
      // file describes. That's a deliberate "restore what the file says"
      // choice, not a gap: this function's whole contract is restoring
      // exactly what was exported, and silently rewriting a restored
      // backup's own identity to a different account would be a stranger
      // kind of surprise than leaving it alone.
      var username = pinLegacyRenameIdentity(key, backup.username);
      // authToken: null -- genuinely category-1 "no server round trip
      // happens here at all" (reviewed explicitly for tracker item
      // publish-dream-js-trusts-client-supplied--lkppcu, which made
      // Publish authToken-gated too -- see that fix's own doc comments for
      // why a null token is a bigger deal here than it is for
      // blockUser/unblockUser). This entire function is a local file
      // import -- it never talks to the server at all, so unlike
      // attemptLocalLogin's backfillAccountServerSide (which at least
      // fires an opportunistic, if unverifying, registration call), there
      // is nothing here to mint a token from. Net effect: a dream
      // published immediately after restoring a backup won't reach the
      // shared feed until this account's next real, server-confirmed
      // login on this device -- an honest, accepted degrade for a rare,
      // manual, user-initiated recovery flow, not a bug to chase further.
      state.user = { handle: '@' + username, username: username, authToken: null };
      persist();
      identifyForAnalytics(username);
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
    clearDraft: function () { state.draft = { caption: '', storyText: '', needsStoryRewrite: false, style: null, sourceDreamId: null, restore: false, characterIds: [], cameraView: null, sceneryTime: null, sceneryPlace: null, mediaType: null, sourceImageUrl: null, audioOn: false, musicStyle: null }; persist(); },

    /** Creates a brand new dream via fal.ai. Returns a Promise that resolves once the video is ready. opts: { characterIds, cameraView, sceneryTime, sceneryPlace, turnstileToken, audioOn, musicStyle }. Implicitly always 'video' — see generateImage below for the cheaper alternative; a caller that wants an image calls that instead, this method never looks at opts.mediaType. */
    generateVideo: function (caption, style, opts) {
      opts = opts || {};
      return startGeneration(caption, style, {
        characterIds: opts.characterIds, cameraView: opts.cameraView,
        sceneryTime: opts.sceneryTime, sceneryPlace: opts.sceneryPlace,
        turnstileToken: opts.turnstileToken,
        audioOn: opts.audioOn, musicStyle: opts.musicStyle,
        storyText: opts.storyText
      });
    },

    /**
     * Creates a brand new dream as a cheap still image instead of a video
     * (fal-ai/flux/dev, 10 tokens flat — see generate-image.js) — the
     * image-vs-video picker on style.html (see docs/IMAGE_GENERATION_SPEC.md
     * §5/§9). Thin wrapper: forwards every opt straight through to
     * startGeneration, just forcing mediaType to 'image'.
     */
    generateImage: function (caption, style, opts) {
      opts = opts || {};
      return startGeneration(caption, style, Object.assign({}, opts, { mediaType: 'image' }));
    },

    /**
     * Re-runs generation on an existing dream (Edit Dream / Try Again, or
     * the "Turn this into a video" upsell — see turnImageIntoVideo below),
     * including any selected Advanced fields. mediaType/sourceImageUrl are
     * forwarded straight through from patch — the caller decides both (see
     * result.html's proceedWithGenerateAgain, which explicitly carries the
     * target dream's own existing mediaType forward since there is no
     * media-type picker on regenerate, per docs/IMAGE_GENERATION_SPEC.md
     * §7's explicit scope cut) — startGeneration defaults a missing/absent
     * mediaType to 'video', same backward-compat default as everywhere else.
     * audioOn is passed as true, NOT left to startGeneration's own
     * default-off fallback (review finding, tracker items
     * for-product-audio-on-off-choice-at-creat-dyyr98/
     * for-product-cheap-generation-profile-for-yz2ina): those two items
     * scope the new default-off behavior to style.html's own creation-flow
     * toggle, a genuinely NEW generation. Regenerate has no audio picker
     * UI of its own and, before this toggle existed at all, always
     * generated WITH audio (gated only by the pre-existing condensing
     * rule) — silently flipping that to off here for two already-shipped,
     * unrelated features (Edit Dream/Try Again and the "Turn this into a
     * video" upsell) would be a real, unrequested behavior regression, not
     * a considered scope decision. Preserving the old always-on-unless-
     * condensed behavior here needs no founder sign-off, since it changes
     * nothing about what these two flows already did.
     */
    regenerateDream: function (id, patch) {
      return startGeneration(patch.caption, patch.style, {
        sourceDreamId: id, characterIds: patch.characterIds,
        cameraView: patch.cameraView, sceneryTime: patch.sceneryTime, sceneryPlace: patch.sceneryPlace,
        turnstileToken: patch.turnstileToken,
        mediaType: patch.mediaType, sourceImageUrl: patch.sourceImageUrl,
        audioOn: true,
        // See finalizeDream's own doc comment — result.html's Edit Dream
        // sheet edits the dream's DISPLAYED text (storyText, post-split),
        // so patch.storyText (set by persistGenerateAgainDraft below)
        // carries that edited human text through as-is. patch.caption
        // (the SAME edited text — see persistGenerateAgainDraft) becomes
        // the new promptText: an edit here has no separate chip-derived
        // enrichment to re-apply, same "the user's own typed text is both
        // the story and the prompt" semantics Write-it/Record-it already
        // have.
        storyText: patch.storyText
      });
    },

    /**
     * "Turn this into a video" upsell (result.html's CTA, shown only when
     * dream.imageUrl && !dream.videoUrl — see docs/IMAGE_GENERATION_SPEC.md
     * §6's exact spec). Sets a draft that routes back through
     * processing.html's existing regenerate machinery — mirrors the
     * existing "Generate Again" (Edit sheet) pattern exactly, reusing the
     * full-screen progress/fail-state machinery already built and tested
     * rather than inventing a new inline long-wait spinner here.
     * sourceDreamId ties this to the EXISTING dream record (finalizeDream
     * upgrades it in place rather than creating a new one — same id,
     * imageUrl kept for provenance, videoUrl gets set, mediaType flips to
     * 'video'). sourceImageUrl is fal's own hosted URL from the original
     * image generation, passed straight through to generate-video.js's
     * callFalImageToVideo as image_url — no re-hosting/new storage needed
     * (fal retains generated files for >=7 days, see generate-image.js's
     * header comment). mediaType:'video' means processing.html renders its
     * normal video copy/checklist with zero special-casing there.
     *
     * Returns true if the draft was set (a real image-type dream was
     * found), false otherwise (nothing to turn into a video — e.g. the
     * dream doesn't exist, has no imageUrl, or (review finding, tracker
     * item for-product-terms-republish-license-per--fhpcxk, second round)
     * doesn't belong to the currently signed-in account — same
     * `ownerHandle === myHandle` guard deleteDream/publishDream/
     * unpublishDream/setOkToFeatureOnChannels already use, needed here too
     * since result.html?id=<id> is legitimately reachable for another
     * account's published dream) — the caller (result.html) only navigates
     * to processing.html on true. Matches this file's existing layering:
     * store.js is model/logic only, every navigation in this app happens
     * in the HTML file that calls it, never here.
     */
    turnImageIntoVideo: function (dreamId) {
      var dream = findDream(dreamId);
      var myHandle = state.user ? state.user.handle : null;
      if (!dream || !dream.imageUrl || !myHandle || dream.ownerHandle !== myHandle) return false;
      Object.assign(state.draft, {
        // promptText (falling back to caption for a pre-split dream) is
        // the full engineered prompt — reused as-is so the resulting
        // video keeps the same content the image was generated from.
        // storyText (or its own caption fallback) is unchanged by
        // becoming a video — same dream, same human description.
        caption: dream.promptText || dream.caption, storyText: dream.storyText || dream.caption,
        style: dream.style, sourceDreamId: dream.id,
        sourceImageUrl: dream.imageUrl, mediaType: 'video', restore: false
      });
      persist();
      return true;
    },

    /** The CURRENT account's in-flight generation job, if any — survives navigation/refresh so Home can resume polling it. Scoped by ownerHandle (see scopedPendingJob) so a different account never sees another account's job. */
    getPendingJob: function () { return scopedPendingJob(); },

    /**
     * Adopts an ALREADY-SUBMITTED generation job as this browser's
     * pendingJob — used by wizard.html's "generate during signup" seam
     * (see start-pending-generation.js): the dream-builder wizard submits
     * to fal.ai the moment its contact-capture step collects an email,
     * before a real account exists, so by the time signup itself
     * completes there's already a real operationName in flight. This is
     * the exact same shape startGeneration's own savePendingJob call
     * produces, so a redirect straight to processing.html right after
     * signup "just works" with zero changes there: that page already
     * checks DreamStore.getPendingJob() on load and resumes polling it via
     * resumePendingJob(). Never re-submits to generate-video.js/
     * start-pending-generation.js — operationName already exists.
     *
     * mediaType (optional 5th arg, default 'video' — fully backward
     * compatible) mirrors start-pending-generation.js's own mediaType
     * support (see docs/IMAGE_GENERATION_SPEC.md §4/§6-revised). wizard.html
     * itself never passes this — its onboarding flow is deliberately
     * unchanged and always adopts a video — this parameter exists purely so
     * this method stays consistent with the rest of this file's mediaType
     * plumbing for any future caller of the pending-generation seam.
     *
     * storyText (optional 6th arg, tracker item for-product-split-
     * prompttext-storytext-f-yt5kc7) — wizard.html's own chip-based
     * pre-signup flow needs the same promptText/storyText split as
     * create.html's (see that file's own header comment on why it gets
     * "the same treatment"). Falls back to `caption` when omitted (a
     * not-yet-updated caller, or a legacy pending job), same fallback
     * finalizeDream itself applies.
     */
    adoptPendingGeneration: function (operationName, startedAt, caption, style, mediaType, storyText) {
      savePendingJob({ operationName: operationName, startedAt: startedAt, caption: caption, storyText: storyText || null, style: style, sourceDreamId: null, mediaType: mediaType === 'image' ? 'image' : 'video', notify: false });
    },

    /**
     * Materializes an already-finished dream (from claim-dream.html — the
     * abandoned-dream re-engagement email/WhatsApp link's landing page,
     * see verify-pending-claim.js) into the CURRENTLY signed-in account's
     * local dreams. Requires a logged-in user (claim-dream.html signs one
     * in — or up — first). Returns the new dream, same shape a normal
     * generateVideo() completion produces, so result.html works unchanged
     * for it.
     */
    saveClaimedDream: function (caption, style, videoUrl, storyText) {
      if (!state.user) return null;
      var resolvedStoryText = (storyText && storyText.trim()) ? storyText.trim() : caption;
      var dream = {
        id: newId(),
        ownerHandle: state.user.handle,
        caption: resolvedStoryText, promptText: caption, storyText: resolvedStoryText, style: style, mediaType: 'video',
        likes: 0, likedByMe: false, dur: '0:08', isPublished: false,
        videoUrl: videoUrl
      };
      state.dreams.unshift(dream);
      persist();
      probeVideoDuration(videoUrl).then(function (dur) {
        if (dur) { dream.dur = dur; persist(); }
      });
      return dream;
    },

    /** Marks the CURRENT account's pending job so its completion fires a real Notification wherever it resolves. */
    requestNotifyOnReady: function () {
      var job = scopedPendingJob();
      if (job) { job.notify = true; persist(); }
    },

    /** Resumes polling the CURRENT account's pending job left over from a previous page (e.g. the user left Processing). */
    resumePendingJob: function () {
      var job = scopedPendingJob();
      if (!job) return Promise.reject(new Error('no_pending_job'));
      return startGeneration(job.caption, job.style, {
        sourceDreamId: job.sourceDreamId,
        mediaType: job.mediaType,
        // Forwarded so startGeneration's own savePendingJob re-write (see
        // its doc comment) re-stamps the SAME audioOn the job was
        // originally submitted with, rather than silently resetting to
        // false because a resume's opts never otherwise mentions it — this
        // is a resume (no new request goes out; operationPromise below
        // resolves straight to job.operationName), so there's no live
        // toggle to re-read here, only this job's own already-decided value.
        audioOn: job.audioOn,
        // Same reasoning as audioOn above — job.storyText is whatever this
        // job was originally submitted/adopted with (see savePendingJob's
        // own call sites), re-stamped here rather than left to finalizeDream's
        // caption fallback just because this is a resume.
        storyText: job.storyText,
        resume: { operationName: job.operationName, startedAt: job.startedAt }
      });
    },

    publishDream: function (id) {
      var d = findDream(id);
      var myHandle = state.user ? state.user.handle : null;
      if (!d || !myHandle || d.ownerHandle !== myHandle) return null;
      if (d) {
        // 'video_published' fires only on the actual transition into
        // published (not already true) -- this is the real "publish
        // action" moment the tracker item asks for, distinct from
        // syncPublishedDreamToFeed's OTHER call sites (finalizeDream's
        // resync of an already-published dream after an edit/regenerate,
        // and backfillSharedFeed's one-time catch-up sync for dreams
        // published before the shared feed existed) -- neither of those is
        // a fresh publish action, so firing this from publish-dream.js
        // itself (which all three call sites hit identically) would
        // over-count. Phase 1 reporting instrumentation -- tracker item
        // for-product-phase-1-reporting-instrument-kjlh46.
        var isNewPublish = !d.isPublished;
        d.isPublished = true;
        // Republish license (tracker item for-product-terms-republish-
        // license-per--fhpcxk, terms.html "Your content"): a fresh publish
        // is itself the zero-click moment DreamTube is granted the
        // non-exclusive license to host/reproduce/display this dream,
        // expressly including DreamTube's own official social/promotional
        // channels — no separate checkbox, per the founder's explicit
        // "minimize it" direction. Stamped (not a plain boolean) so a
        // dream published before this code shipped — no stamp at all —
        // stays cleanly distinguishable from one published under the new
        // clause, satisfying the "no backfill" requirement without any
        // migration step. Re-publishing after an unpublish clears any
        // earlier revocation and re-grants fresh, same as any other
        // publish action.
        if (isNewPublish) {
          d.channelLicenseGrantedAt = Date.now();
          d.channelLicenseRevokedAt = null;
        }
        persist();
        syncPublishedDreamToFeed(d);
        if (isNewPublish) trackAnalytics('video_published', { style: d.style, mediaType: d.mediaType });
      }
      return d;
    },

    /** Takes one of the current user's own dreams back out of Explore. */
    unpublishDream: function (id) {
      var d = findDream(id);
      var myHandle = state.user ? state.user.handle : null;
      if (!d || !myHandle || d.ownerHandle !== myHandle) return null;
      if (d) {
        d.isPublished = false;
        // Ends the republish license for any FUTURE use as of right now —
        // see publishDream's channelLicenseGrantedAt comment above. This
        // timestamp is the concrete state a later "remove existing social
        // posts on request" pass would read; building that removal
        // mechanism itself is explicitly out of scope here.
        if (d.channelLicenseGrantedAt) d.channelLicenseRevokedAt = Date.now();
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
      // Same channel-license revocation as unpublishDream above, applied
      // before the record is dropped from local state entirely — deleting
      // a published dream stops future use under the license exactly like
      // explicitly unpublishing it first would.
      if (wasPublished && d.channelLicenseGrantedAt) d.channelLicenseRevokedAt = Date.now();
      state.dreams = state.dreams.filter(function (dream) { return dream.id !== id; });
      persist();
      if (wasPublished) removePublishedDreamFromFeed(id);
      return true;
    },

    /**
     * Per-dream "OK to feature on DreamTube's channels" opt-out (tracker
     * item for-product-terms-republish-license-per--fhpcxk) — defaults ON
     * (true) whenever unset, so publishing stays genuinely zero-click; this
     * is the one discoverable place to turn it back off for a specific
     * dream. Independent of isPublished/the license-grant timestamps above
     * — this only ever narrows an already-licensed dream's eligibility,
     * it can't grant a license unpublishing itself doesn't. Re-syncs the
     * shared feed record immediately if the dream is currently published,
     * same as any other already-published-dream edit.
     */
    setOkToFeatureOnChannels: function (id, enabled) {
      var d = findDream(id);
      var myHandle = state.user ? state.user.handle : null;
      if (!d || !myHandle || d.ownerHandle !== myHandle) return null;
      if (d) {
        d.okToFeatureOnChannels = !!enabled;
        persist();
        if (d.isPublished) syncPublishedDreamToFeed(d);
      }
      return d;
    },

    /**
     * Reads a dream's saved per-persona interpretation readings —
     * Interpretation Wave 1 (docs/INTERPRETATION_WAVE1_SPEC.md §5),
     * replacing the old single-blended getInterpretation. Purely local, no
     * network call. Returns null if the dream doesn't exist (or isn't this
     * account's own — same ownership guard every private per-account read
     * here uses); otherwise `{ [personaKey]: { text, at, qa } }`.
     *
     * NOTE on `qa`: the spec's own §5 documents this read shape as
     * `{ text, at }`, explicitly omitting `qa` ("result.html doesn't need
     * it") — written when result.html was still expected to be the direct
     * consumer of interpretation state. Under the actual Direction-B
     * build, result.html never touches interpretation internals at all
     * (it only calls InterpretExperience.open()); js/interpret-experience.js
     * is the real consumer, and it needs `qa` to honor spec §3.5's
     * "Regenerate... re-runs mode:'reading' with the same persona + same
     * qa" even on a REVISIT (opened straight to a saved reading, with no
     * in-session qa in memory yet). Returning `qa` here is therefore a
     * deliberate, documented superset of the spec's literal read shape,
     * not a narrowing — same ownership-gated, private-only read either
     * way, no privacy change (this data was always sitting in the raw
     * dream record; this just exposes it through the read method that
     * actually needs it, rather than a second bespoke accessor).
     *
     * Runs ensureInterpretationsMigrated first (see below) so a dream that
     * only ever has the OLD legacy interpretationText/interpretationAt
     * fields still shows up here, under the synthetic `classic` key, the
     * moment it's first read this way.
     */
    getInterpretations: function (id) {
      var d = findDream(id);
      // Ownership guard — same `ownerHandle === myHandle` convention every
      // other private per-account read/write in this file uses (see
      // publishDream/deleteDream/setOkToFeatureOnChannels above): a saved
      // interpretation reading is exactly as private as the old
      // interpretationText field was, and state.dreams is never cleared on
      // logout/login, so a dream record from a DIFFERENT account that
      // previously used this browser can still be sitting in state.dreams.
      var myHandle = state.user ? state.user.handle : null;
      if (!d || !myHandle || d.ownerHandle !== myHandle) return null;
      var map = ensureInterpretationsMigrated(d);
      var out = {};
      Object.keys(map).forEach(function (key) {
        var entry = map[key];
        if (entry) out[key] = { text: entry.text, at: entry.at, qa: entry.qa || [] };
      });
      return out;
    },

    /**
     * Requests 1-`maxQuestions` clarifying questions, in a given persona's
     * voice, via interpret-dream.js's `mode:"questions"` — the first
     * network call of a fresh interpretation flow (js/interpret-experience.js's
     * q_loading phase). Purely a network passthrough: NO local write
     * happens here (questions themselves are never saved — only the final
     * reading is, via generateInterpretationReading below), matching the
     * spec's "questions are never a gate" contract — a failure here is
     * meant to be silently swallowed by the caller, which falls straight
     * to a direct reading instead of surfacing an error screen (spec §3.2).
     *
     * On success resolves `{ questions }` (interpret-dream.js's own
     * `[ { id, text, chips }, ... ]` shape, passed through as-is). On
     * failure rejects with an Error whose message is the function's own
     * "E4NN: reason" string, or an uncoded
     * "network_error_requesting_interpretation" message for a request that
     * never reached the function at all — same error-passing convention
     * the old generateInterpretation used.
     */
    requestInterpretationQuestions: function (id, personaKey) {
      var d = findDream(id);
      var myHandle = state.user ? state.user.handle : null;
      // Ownership guard — same reasoning as getInterpretations above; a
      // dream that isn't this account's own is not a valid target for a
      // persona-flavored question call about its content either.
      if (!d || !myHandle || d.ownerHandle !== myHandle) return Promise.reject(new Error('not_found'));
      return fetch('/.netlify/functions/interpret-dream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // storyText (tracker item for-product-split-prompttext-storytext-
        // f-yt5kc7): the interpretation LLM must read the human dream
        // description, never the chip flow's camera-direction/style-
        // modifier promptText. d.storyText falls back to d.caption for a
        // dream saved before this field existed (see finalizeDream's own
        // doc comment) — behaviorally identical to today for every
        // existing dream, and correctly storyText-only for every new one.
        body: JSON.stringify({ caption: d.storyText || d.caption, personaKey: personaKey, mode: 'questions' })
      }).then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) throw new Error(data.error || 'E407: empty_or_invalid_response');
          return { questions: data.questions || [] };
        });
      }, function (err) {
        throw new Error('network_error_requesting_interpretation' + (err && err.message ? ': ' + err.message : ''));
      });
    },

    /**
     * Generates (or regenerates) a specific persona's reading via
     * interpret-dream.js's `mode:"reading"`, POSTing the dream's own
     * storyText/caption plus whatever `qa` (answers, may be `[]`) the
     * questions phase collected. Always opt-in — js/interpret-experience.js
     * only ever calls this from the r_loading phase (a persona pick
     * following through the questions flow, "Just interpret it", or an
     * explicit Regenerate tap), never automatically.
     *
     * On success, writes `dream.interpretations[personaKey] = { text, at,
     * qa }` and persists, then resolves `{ text, at }`. On failure,
     * rejects the same "E4NN: reason" / "network_error_requesting_interpretation"
     * way requestInterpretationQuestions above does.
     *
     * This is a private, local-only write: nothing here calls
     * syncPublishedDreamToFeed, and `interpretations` is never part of
     * that function's payload (see it above, and this file's own
     * ensureInterpretationsMigrated comment) — so this stays off the
     * shared feed even for a dream that's already published, same
     * guarantee the old interpretationText field always had.
     */
    generateInterpretationReading: function (id, personaKey, qa) {
      var d = findDream(id);
      var myHandle = state.user ? state.user.handle : null;
      // Ownership guard — same `ownerHandle === myHandle` check
      // deleteDream/publishDream/turnImageIntoVideo use: this is a
      // private, per-account write onto whatever dream id is passed in,
      // and an interpretation-surface deep link is legitimately reachable
      // for another account's published dream. Rejects the same way an id
      // that doesn't resolve to any dream at all already does.
      if (!d || !myHandle || d.ownerHandle !== myHandle) return Promise.reject(new Error('not_found'));
      return fetch('/.netlify/functions/interpret-dream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caption: d.storyText || d.caption, personaKey: personaKey, mode: 'reading', qa: qa || [] })
      }).then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) throw new Error(data.error || 'E407: empty_or_invalid_response');
          var dream = findDream(id);
          var at = Date.now();
          if (dream) {
            var map = ensureInterpretationsMigrated(dream);
            map[personaKey] = { text: data.interpretation, at: at, qa: qa || [] };
            persist();
          }
          return { text: data.interpretation, at: dream ? at : null };
        });
      }, function (err) {
        throw new Error('network_error_requesting_interpretation' + (err && err.message ? ': ' + err.message : ''));
      });
    },

    /**
     * The real, cross-browser shared feed — every published dream from
     * every user, fetched from Blobs via get-feed.js. Adds
     * mine/likedByMe/blockedByMe per-viewer, computed locally since the
     * shared record itself carries none of them (no real accounts to know
     * who's asking). `blockedByMe` (tracker item
     * for-product-public-feed-safety-in-app-re-ppuw77) is a lookup against
     * the CURRENTLY signed-in account's own blockedByUser map (see
     * currentBlockedMap/state.blockedByUser's own doc comment — this is
     * per-account, not a shared device-level map, so a different account
     * signed into this same browser never sees another account's blocks),
     * same mechanism as likedByMe otherwise — callers that want blocked
     * authors actually excluded (not just flagged) must filter on it
     * themselves (see explore.html's own render(), which drops any
     * d.blockedByMe dream before rendering) — this function itself never
     * drops entries, same "return everything, let the page decide what to
     * do with the flag" posture likedByMe/mine already have.
     */
    getSharedFeed: function () {
      return fetch('/.netlify/functions/get-feed').then(function (res) {
        return res.json();
      }).then(function (data) {
        if (data.error) throw new Error(data.error);
        lastDreamOfDayId = data.dreamOfDayId || null;
        var likedIds = state.likedIds || {};
        var blockedHandles = currentBlockedMap() || {};
        var myHandle = state.user ? state.user.handle : null;
        return (data.feed || []).map(function (d) {
          return Object.assign({}, d, {
            likedByMe: !!likedIds[d.id],
            mine: !!myHandle && d.ownerHandle === myHandle,
            blockedByMe: !!blockedHandles[d.ownerHandle]
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

    /**
     * Toggles a like against the real shared count. Returns a Promise of
     * { likes, likedByMe }. `likerHandle` (this browser's own
     * state.user.handle, e.g. '@alice', or null if logged out) is sent
     * alongside id/delta purely so like-dream.js — the single
     * choke-point that already knows the dream and its owner — can also
     * fire the 'like_given'/'like_received' PostHog events (Phase 1
     * reporting instrumentation, tracker item
     * for-product-phase-1-reporting-instrument-kjlh46); it has no other
     * effect on the like itself, which the server already fully resolves
     * from id+delta alone.
     */
    toggleSharedLike: function (id, currentlyLiked) {
      return fetch('/.netlify/functions/like-dream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: id, delta: currentlyLiked ? -1 : 1, likerHandle: state.user ? state.user.handle : null })
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

    // ===== Block user (tracker item for-product-public-feed-safety-in-app-re-ppuw77) =====
    //
    // Blocking hides a published author's dreams from THIS signed-in
    // account's own Explore feed going forward (see getSharedFeed's
    // blockedByMe flag + explore.html's own filtering). Requires being
    // signed in (see js/report-sheet.js's isLoggedIn gate — a logged-out
    // tap routes to the signup nudge instead of calling any of these) —
    // every function below is a no-op without state.user.
    //
    // PER-ACCOUNT, not device-level (review finding, fixed — an earlier
    // version of this mirrored state.likedIds' "purely local, not deduped
    // per-account" tradeoff, which the reviewer correctly flagged as wrong
    // for THIS feature specifically): a like is cosmetic, but a block is
    // the actual safety mechanism this feature exists to ship. Concrete
    // failure the per-account keying (state.blockedByUser, same scheme as
    // charactersByUser — see that field's own doc comment) fixes: on a
    // shared/family device, Account A blocks an abusive user and logs out;
    // Account B (a different real person) logs in and must NOT see A's
    // block as B's own, and must NOT be able to tap Unblock and silently
    // undo A's protection. See currentBlockedMap() above for the lookup
    // this all routes through.
    //
    // A signed-in account's blocks are ALSO written through to a durable
    // server-side store (netlify/functions/block-user.js/lib/block-store.js)
    // — best-effort and fire-and-forget: the LOCAL write (isBlocked/
    // getSharedFeed's blockedByMe) already fully applies on this device
    // regardless of whether the network call below ever succeeds, so a
    // Blobs write failure or offline network never blocks the feature from
    // working right now, only from being synced to another device later.
    //
    // SECURITY (review finding, fixed): block-user.js used to accept a bare
    // `username` string to identify the acting account — a real problem
    // specific to this action (unlike, say, save-push-subscription.js's own
    // bare-username trust, whose worst case is only a misdirected push
    // notification): this app's handles are PUBLIC, shown on every Explore
    // card, so anyone could have enumerated any account's blocklist (GET)
    // or silently stripped a block someone else set (POST unblock) just by
    // knowing their handle — defeating the entire point of the feature.
    // Fixed by requiring `state.user.authToken` (see login()/signup()'s own
    // doc comments for exactly when this is real vs. null) instead of a
    // bare username: block-user.js now derives the acting account from a
    // verified, unforgeable token minted only at a genuine server-side
    // login/signup success. The server sync below is skipped entirely when
    // signed in with no authToken on file (a legacy/fallback/offline
    // sign-in path — see those doc comments for which ones this is) — the
    // LOCAL block (already correctly scoped to this account, per above)
    // still fully applies on this device either way; only the durable
    // cross-device sync is unavailable until this browser's next real
    // login/signup mints one.

    /** True if the CURRENTLY signed-in account has locally blocked `handle` (e.g. "@alice"). False when logged out. Synchronous, no network. */
    isBlocked: function (handle) {
      var map = currentBlockedMap();
      return !!(handle && map && map[handle]);
    },

    /** Every handle the CURRENTLY signed-in account has locally blocked, as a plain array (empty when logged out) — feeds Settings' "Blocked accounts" list (see profile.html). */
    getBlockedHandles: function () {
      var map = currentBlockedMap();
      return map ? Object.keys(map) : [];
    },

    /**
     * Blocks `handle` for the CURRENTLY signed-in account: applies the
     * local flag immediately (synchronous, persisted before this
     * function's Promise ever settles — a caller that only cares about the
     * immediate on-device effect doesn't need to wait on the returned
     * Promise at all), then best-effort syncs it to the durable
     * server-side store if a real authToken is on file. The returned
     * Promise always resolves (never rejects) once the local write is done
     * — a server sync failure is swallowed, matching this feature's "local
     * effect must never depend on network" design above. No-ops entirely
     * when logged out (callers must gate this the same way
     * js/report-sheet.js already does).
     */
    blockUser: function (handle) {
      if (!handle || !state.user) return Promise.resolve();
      var key = state.user.username.toLowerCase();
      if (!state.blockedByUser[key]) state.blockedByUser[key] = {};
      state.blockedByUser[key][handle] = true;
      persist();
      if (!state.user.authToken) return Promise.resolve();
      return fetch('/.netlify/functions/block-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ authToken: state.user.authToken, blockedHandle: handle, action: 'block' })
      }).catch(function () { /* local block already applied -- server sync is best-effort, see header comment */ });
    },

    /** Unblocks `handle` for the CURRENTLY signed-in account — mirrors blockUser's local-first, best-effort-server-sync shape exactly. */
    unblockUser: function (handle) {
      if (!handle || !state.user) return Promise.resolve();
      var key = state.user.username.toLowerCase();
      if (state.blockedByUser[key]) delete state.blockedByUser[key][handle];
      persist();
      if (!state.user.authToken) return Promise.resolve();
      return fetch('/.netlify/functions/block-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ authToken: state.user.authToken, blockedHandle: handle, action: 'unblock' })
      }).catch(function () { /* local unblock already applied -- server sync is best-effort, see header comment */ });
    },

    /**
     * Hydrates the CURRENTLY signed-in account's local blockedByUser entry
     * from its durable server-side list (netlify/functions/block-user.js
     * GET) — a UNION merge (never removes a local block the server copy
     * doesn't have; a block made on THIS device moments ago and not yet
     * synced must not be reverted by this call), so this is always safe to
     * call speculatively on page load. No-ops (resolves immediately) when
     * logged out, or signed in with no authToken on file (see this
     * feature's own header comment for which sign-in paths that is) —
     * there's no verified identity to fetch a server list for. Never
     * rejects: a fetch failure (or a since-expired/invalid token) just
     * leaves the local list as-is, same honest-degrade posture as every
     * other best-effort network call in this file. Called by explore.html
     * on load so a different device (or a cleared browser) picks up an
     * already-signed-in account's existing blocks before the feed renders.
     */
    syncBlockedHandlesFromServer: function () {
      if (!state.user || !state.user.authToken) return Promise.resolve();
      var key = state.user.username.toLowerCase();
      return fetch('/.netlify/functions/block-user?authToken=' + encodeURIComponent(state.user.authToken))
        .then(function (res) { return res.json(); })
        .then(function (data) {
          var serverHandles = (data && data.ok && Array.isArray(data.blockedHandles)) ? data.blockedHandles : [];
          if (!state.blockedByUser[key]) state.blockedByUser[key] = {};
          serverHandles.forEach(function (h) { state.blockedByUser[key][h] = true; });
          persist();
        }).catch(function () { /* leave the local list as-is -- see header comment */ });
    },

    /**
     * Synchronous, no-network read of the last total this account's
     * refreshNewLikesCount() computed — see that function's own doc
     * block, and the LIKES_NEW_COUNT_KEY comment above it, for the full
     * "when does this go back to 0" story. This is what every bottom-nav
     * page (home.html/explore.html/profile.html) calls on load to decide
     * whether to show the Profile tab's badge dot — cheap enough to call
     * on every page load, unlike refreshNewLikesCount which hits the
     * network and is profile.html's job alone.
     */
    getCachedNewLikesCount: function () {
      var raw;
      try { raw = localStorage.getItem(LIKES_NEW_COUNT_KEY); } catch (e) { return 0; }
      var n = parseInt(raw, 10);
      return (isFinite(n) && n > 0) ? n : 0;
    },

    /**
     * profile.html's own page-load hook — the ONLY place in the app that
     * fetches the shared feed to check for new likes on this account's
     * own published dreams (see the doc block above LIKES_SEEN_KEY for
     * why: no polling, no push, a plain fetch on profile page load is
     * enough per this feature's own scope). Resolves to the total new
     * likes discovered THIS call (summed across every owned published
     * dream, each floored at 0 so an unlike bringing a count down never
     * produces a negative contribution) — also persists that total to
     * LIKES_NEW_COUNT_KEY for every page's badge, and rolls
     * LIKES_SEEN_KEY's baseline forward to today's counts so a second
     * call with no further likes correctly resolves to 0.
     *
     * Resolves to 0 on a logged-out account, an account with no published
     * dreams, or any fetch failure — this never throws and never blocks
     * the rest of profile.html's render. Every one of those 0-resolving
     * paths, same as the real computed-total success path, ALWAYS calls
     * writeCachedNewLikesCount (there is no early-return / catch branch
     * left that resolves without persisting what it resolved to) — this
     * closes a cross-account localStorage leak flagged in review: an
     * early return here used to leave a PRIOR account's
     * stale nonzero LIKES_NEW_COUNT_KEY untouched, so switching to an
     * account with zero owned dreams could never clear a badge it never
     * earned, since visiting profile.html — this app's only "clear the
     * badge" mechanism — took this exact early-return path and skipped
     * the write.
     */
    refreshNewLikesCount: function () {
      var myHandle = state.user ? state.user.handle : null;
      var mine = state.dreams.filter(function (d) { return !!myHandle && d.ownerHandle === myHandle && d.isPublished; });
      if (!mine.length) { writeCachedNewLikesCount(0); return Promise.resolve(0); }
      return fetch('/.netlify/functions/get-feed')
        .then(function (res) { return res.json(); })
        .then(function (data) {
          var feed = (data && data.feed) || [];
          var feedLikesById = {};
          feed.forEach(function (f) { feedLikesById[f.id] = f.likes || 0; });

          var seen = readLikesSeenMap();
          var total = 0;
          mine.forEach(function (d) {
            // Fallback to the local (possibly stale) count for a dream
            // that hasn't synced to the shared feed yet at all — never
            // treat "not in the feed response" as zero likes.
            var current = feedLikesById.hasOwnProperty(d.id) ? feedLikesById[d.id] : (d.likes || 0);
            // No seenMap entry yet (first time this dream is ever checked)?
            // Seed the baseline from this browser's own last-known LOCAL
            // like count (d.likes) — the last count this account actually
            // observed before this feature existed — NOT the current feed
            // value. Seeding from "current" would make delta always 0 on
            // literally every account's first-ever check, silently
            // swallowing every like already accumulated (including this
            // feature's own rollout day). Seeding from the stale local
            // count means a dream that picked up likes from other people
            // while this browser's local record sat stale correctly shows
            // up as new the first time it's checked, exactly once.
            var baseline = seen.hasOwnProperty(d.id) ? seen[d.id] : (d.likes || 0);
            total += Math.max(0, current - baseline);
            seen[d.id] = current;
          });

          writeLikesSeenMap(seen);
          writeCachedNewLikesCount(total);
          return total;
        })
        .catch(function () { writeCachedNewLikesCount(0); return 0; });
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
     * A self character's name is genuinely optional and stored as-is
     * (including empty) — create.html's self-mode sheet has no name field
     * at all, so most self characters never get one. This function does
     * NOT invent a placeholder name (previously defaulted a blank self name
     * to the literal string 'Me', which then got displayed verbatim as a
     * real chosen name in places like profile.html). Any display-time
     * fallback (a generic chip label, the account's @handle, etc.) is each
     * consumer's own responsibility, applied against the real empty value
     * — never baked into the stored data here.
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
        existing.name = name;
        existing.description = description;
        if (isSelf) existing.photoDataUrl = photoDataUrl; else delete existing.photoDataUrl;
        persist();
        return { ok: true, character: existing };
      }

      var character = { id: newCharId(), name: name, isSelf: isSelf, description: description };
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
     * Device-level "has this browser already dismissed the post-signup
     * FB/IG in-app-browser nudge card on the generation wait screen"
     * marker (see processing.html's/create.html's initInAppNudge-family
     * code). Device-level (not account-scoped) for the same reason as
     * getSoundPref/getSeenDreamOfDayId — the in-app-webview context belongs
     * to the browser/app the visitor is inside, not to whichever account
     * happens to be signed in.
     *
     * ROUND-2 FOUNDER FIX (tracker item for-product-webview-notify-escape-
     * nudge--5yray5): dismissing used to make the full card vanish forever
     * — the same one-shot-disappearance mistake the original A2HS nudge
     * had. This flag now means "show the small persistent re-entry chip
     * instead of the full card by default," not "never show anything
     * again" — callers still gate the FULL card on this being false, but
     * once it's true they show the small chip (which re-expands the full
     * card on tap) rather than nothing at all. No storage-shape change was
     * needed for this fix, just the read-site behavior around it.
     */
    getInAppNudgeDismissed: function () {
      try { return localStorage.getItem('dreamtube_inapp_nudge_dismissed_v1') === '1'; }
      catch (e) { return false; }
    },
    dismissInAppNudge: function () {
      try { localStorage.setItem('dreamtube_inapp_nudge_dismissed_v1', '1'); }
      catch (e) { /* ignore (private browsing / storage disabled) */ }
    },

    /**
     * Detects a Facebook/Instagram in-app-browser webview from the user
     * agent — the single shared source of truth for this check, used by
     * both the nudge card above (processing.html's initInAppNudge) and
     * the session-transfer URL maintenance below (both pages). Extracted
     * here rather than left as processing.html's own private
     * detectInAppHost so result.html doesn't need its own second copy —
     * this codebase's own "shared bits live in js/store.js, page-specific
     * logic stays in the page" precedent (see e.g. getTokenStatus's own
     * doc comment on being used by five different pages).
     *
     * Facebook's in-app browser UA carries both FBAN and FBAV tokens;
     * Instagram's carries the literal substring "Instagram". Neither
     * token appears in any normal desktop/mobile browser UA.
     */
    detectInAppWebviewHost: function () {
      var ua = navigator.userAgent || '';
      if (/FBAN|FBAV/.test(ua)) return 'Facebook';
      if (/Instagram/.test(ua)) return 'Instagram';
      return null;
    },

    /**
     * True exactly when THIS page load just consumed a real `?bt=`
     * session-transfer token (see sessionTransferredThisLoad's own doc
     * comment above and commitTransferredSession, which sets it) — i.e.
     * the visitor just landed here signed in, straight out of an FB/IG
     * in-app webview's "open in browser" action. Used by
     * js/install-nudge.js to gate the post-escape install nudge to
     * exactly that one moment, never a later plain revisit of the same
     * page (tracker.html's home-screen-shortcut-a2hs-nudge-founder--
     * yylzoq placement analysis, absorbed into for-product-build-stage-
     * 0-pwa-web-push-f-jbutt5).
     */
    wasSessionJustTransferred: function () {
      return sessionTransferredThisLoad;
    },

    /**
     * Device-level (not account-scoped — same reasoning as
     * getInAppNudgeDismissed above: the browser/device this nudge shows
     * in belongs to whoever is holding the phone, not to whichever
     * account happens to be signed in) "has this browser already
     * dismissed the install-to-home-screen (A2HS) nudge" marker — a
     * SEPARATE marker from getInAppNudgeDismissed/dismissInAppNudge
     * above, which gate the different in-app-webview-escape nudge card.
     * Once dismissed, js/install-nudge.js never shows the install nudge
     * again in this browser.
     */
    getInstallNudgeDismissed: function () {
      try { return localStorage.getItem('dreamtube_install_nudge_dismissed_v1') === '1'; }
      catch (e) { return false; }
    },
    dismissInstallNudge: function () {
      try { localStorage.setItem('dreamtube_install_nudge_dismissed_v1', '1'); }
      catch (e) { /* ignore (private browsing / storage disabled) */ }
    },

    /**
     * Per-account "has this account ever been genuinely VERIFIED as
     * installed to a home screen" flag — tracker item for-product-a2hs-
     * install-nudge-3-founder-vcofk7's fix for the nudge's "one-shot
     * disappearance" problem. This is deliberately a SEPARATE concept from
     * getInstallNudgeDismissed above: that one is a device-level "did the
     * visitor dismiss/ignore the small nudge card" marker (no proof
     * anything was actually installed), while this one only ever becomes
     * true off a REAL completion signal — never a user "I did it" self-
     * report. Two independent triggers set it, both wired in js/pwa.js:
     * (1) this exact page loading in `display-mode: standalone`
     * (PwaInstall.isStandalone()) for a signed-in account — proof the
     * visitor genuinely opened the app from a home-screen icon at least
     * once; (2) Android's `appinstalled` event firing — proof Chrome
     * actually completed a real install, worth marking immediately rather
     * than waiting for that same session's next standalone launch.
     *
     * Per-account (not device-level) because the homepage journey card
     * (home.html) needs "did THIS signed-in account's owner ever
     * install" — the same reasoning markFirstVideoCreatedIfEligible below
     * already uses for living on state.accounts[key] rather than a bare
     * localStorage key: an account can move devices/browsers over its
     * lifetime, and a fresh browser on the SAME account shouldn't have to
     * re-earn a completion that already genuinely happened.
     *
     * markInstallVerified is intentionally idempotent and returns false
     * (no-op) both when there's no signed-in account to persist against
     * and when the flag was already set — callers never need to guard
     * against double-marking themselves.
     */
    getInstallVerified: function () {
      if (!state.user) return false;
      var account = state.accounts[state.user.username.toLowerCase()];
      return !!(account && account.installVerified);
    },
    markInstallVerified: function () {
      if (!state.user) return false;
      var key = state.user.username.toLowerCase();
      var account = state.accounts[key];
      if (!account || account.installVerified) return false;
      account.installVerified = true;
      persist();
      return true;
    },

    /**
     * Device-level, per-page-key visit counter — used by
     * js/install-nudge.js to gate the install nudge's "repeat visitor on
     * result.html/profile.html" trigger (tracker.html's home-screen-
     * shortcut-a2hs-nudge-founder--yylzoq placement analysis: "also: repeat
     * visitors on result/profile in a real browser") to an actual REPEAT
     * visit, not a visitor's very first page load ever. Returns the new
     * count after incrementing (1 on a page's first-ever call in this
     * browser, 2+ from then on) so the caller can gate on `count >= 2`
     * without a second read. Best-effort — a private-browsing/storage-
     * disabled browser always reads back 1, which simply means the nudge
     * never fires from this trigger there (an honest degrade, same class
     * as every other localStorage-dependent feature in this codebase).
     */
    recordRealBrowserVisit: function (pageKey) {
      var key = 'dreamtube_visit_count_' + pageKey + '_v1';
      try {
        var count = parseInt(localStorage.getItem(key), 10) || 0;
        count += 1;
        localStorage.setItem(key, String(count));
        return count;
      } catch (e) { return 1; }
    },

    /**
     * Device-level "has this browser already been asked (in any outcome —
     * granted, denied, or just dismissed without answering) to subscribe
     * to push notifications" marker — see js/push-subscribe.js's own doc
     * comment for the full ask flow (tracker item for-product-build-
     * stage-0-pwa-web-push-f-jbutt5, part 3). Asked at most ONCE EVER per
     * browser, right after a first video starts generating — never
     * re-shown on every later generation, and never re-shown after a real
     * OS-level Notification.permission answer either (that's checked
     * separately, directly against Notification.permission itself, which
     * this marker doesn't duplicate).
     */
    getPushAskDismissed: function () {
      try { return localStorage.getItem('dreamtube_push_ask_dismissed_v1') === '1'; }
      catch (e) { return false; }
    },
    dismissPushAsk: function () {
      try { localStorage.setItem('dreamtube_push_ask_dismissed_v1', '1'); }
      catch (e) { /* ignore (private browsing / storage disabled) */ }
    },

    /**
     * Mints a session-transfer token (netlify/functions/create-session-
     * transfer.js) for the CURRENTLY signed-in account, using its own
     * already-cached local password — same "no new re-auth prompt, the
     * password is already on hand" shape as sendFirstDreamEmailBestEffort
     * above. Resolves the raw token string on success, or null on
     * anything short of that (not signed in, no cached password for this
     * account — e.g. an account itself established via a session-transfer
     * token, see commitTransferredSession's own doc comment — network
     * failure, or the server rejected the cached password because it's
     * gone stale since a reset on another device). Every null case is a
     * silent, no-error skip for the caller (maintainSessionTransferUrl
     * below) — minting is a pure convenience layered on top of an
     * already-working nudge feature, never something its failure should
     * surface to the user.
     */
    mintSessionTransferToken: function () {
      if (!state.user) return Promise.resolve(null);
      var key = state.user.username.toLowerCase();
      var account = state.accounts[key];
      if (!account || !account.password) return Promise.resolve(null);
      return fetch('/.netlify/functions/create-session-transfer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: state.user.username, password: account.password })
      }).then(function (res) { return res.json(); }).then(function (data) {
        return (data && data.ok && data.token) ? data.token : null;
      }).catch(function () { return null; });
    },

    /**
     * Keeps the CURRENT page's own URL carrying a fresh `?bt=<token>`
     * session-transfer param via history.replaceState, for as long as
     * this page stays open, signed in, and inside a detected FB/IG
     * webview — see this whole feature's own security notes (in the
     * originating tracker item / build task) for why this is safe to do:
     * the token this mints is bound to the CURRENTLY signed-in account
     * only, and only ever gets attached to THIS page's own address bar —
     * never to any link this page hands to anyone else (a published
     * dream's explore.html share link is built independently, straight
     * from location.origin + dream.id, see result.html's doShare — it
     * never touches location.href/location.search, so it can never pick
     * this param up). That's what makes it safe for the host app's own
     * 3-dots-menu "open in browser" action to carry an
     * auto-authenticating URL: that action always opens THIS page's
     * CURRENT address bar value, which is the one and only place this
     * token is ever written.
     *
     * Mints immediately on call, then re-mints on an interval well inside
     * the token's own ~15-minute TTL (netlify/functions/lib/session-
     * transfer-token.js) — covering both "the token already got consumed
     * by an earlier handoff" and "it's simply gotten old" without this
     * page needing to know which. A mint that resolves null (see
     * mintSessionTransferToken's own doc comment) just leaves the URL as
     * it already was — never clears an still-good existing param, and
     * never surfaces an error.
     *
     * No-ops entirely (returns without starting the interval) when this
     * page isn't in a detected webview or isn't signed in — the common
     * case for every normal, non-webview page load.
     */
    maintainSessionTransferUrl: function () {
      var self = this;
      if (!self.detectInAppWebviewHost()) return;
      if (!state.user) return;

      function applyToken(token) {
        if (!token) return;
        try {
          var url = new URL(location.href);
          url.searchParams.set('bt', token);
          history.replaceState(null, '', url.pathname + url.search + url.hash);
        } catch (e) { /* malformed URL API in this environment — leave the address bar as-is */ }
      }

      self.mintSessionTransferToken().then(applyToken);
      // ~10 minutes — comfortably inside the token's own 15-minute TTL,
      // so a fresh replacement is always minted well before the previous
      // one could expire out from under a still-open tab.
      setInterval(function () { self.mintSessionTransferToken().then(applyToken); }, 10 * 60 * 1000);
    },

    /**
     * Consumes a `?bt=<token>` session-transfer param from the CURRENT
     * page's URL, if one is present — netlify/functions/verify-session-
     * transfer.js verifies + consumes it (exactly once) and, on success,
     * commits the identity it vouches for as this browser's session via
     * commitTransferredSession. The `bt` param is stripped from the URL
     * via history.replaceState UNCONDITIONALLY, before the network call
     * even starts — so it is never left sitting in the visible/
     * bookmarkable address bar, valid or not, regardless of outcome.
     *
     * Deliberately SYNCHRONOUS (a blocking XMLHttpRequest, not fetch) —
     * this must fully resolve (commit the session, or not) BEFORE the
     * caller's own very-next line, `if(!DreamStore.getCurrentUser())
     * {...}`, runs — that guard, and the hundreds of lines of existing
     * page logic after it, all assume state.user is already whatever it's
     * going to be for this load, synchronously. Restructuring
     * processing.html/result.html's entire top-level script into an
     * async continuation just to await one rare, small request would be a
     * far larger and riskier change than this call's own brief,
     * intentionally-narrow-scope synchronous network request — this only
     * ever fires at all on a page load that happens to carry a `?bt=`
     * param, which itself only ever happens right after a session-
     * transfer handoff.
     *
     * Silent no-op — never throws, never surfaces an error — for a
     * missing/invalid/expired/already-consumed token, a network failure,
     * or a browser without synchronous XHR support: every one of those
     * simply falls through to the normal signed-out flow the very next
     * line already handles, per this feature's own spec.
     */
    consumeSessionTransferTokenFromUrlSync: function () {
      var token;
      try {
        token = new URL(location.href).searchParams.get('bt');
      } catch (e) { token = null; }
      if (!token) return;

      try {
        var url = new URL(location.href);
        url.searchParams.delete('bt');
        history.replaceState(null, '', url.pathname + url.search + url.hash);
      } catch (e) { /* malformed URL API — worst case the param stays visible this one load */ }

      try {
        var xhr = new XMLHttpRequest();
        xhr.open('POST', '/.netlify/functions/verify-session-transfer', false); // false = synchronous, see doc comment above
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.send(JSON.stringify({ token: token }));
        if (xhr.status !== 200) return;
        var data = JSON.parse(xhr.responseText || '{}');
        if (!data || !data.ok || !data.username) return;
        commitTransferredSession(data.username, data.email, data.authToken);
      } catch (e) { /* network failure / sync XHR unavailable — silent no-op, see doc comment above */ }
    },

    /**
     * Reads the signed-in account's current token balance — see
     * netlify/functions/lib/entitlements.js's getTokenStatus for the full
     * mechanism (220 on first-ever read; the daily grant — 100 on an
     * account's first-ever claim ever, 20 on every claim after that, see
     * FIRST_CLAIM_BONUS_AMOUNT's own doc comment — must be actively
     * CLAIMED via claimDailyTokens/claim-daily-tokens.js, never applied
     * lazily by this read — see that file's 2026-07-28 "daily token claim"
     * doc block). Resolves to
     * { balance:0, claimable:false, nextClaimAt:null, dailyClaimAmount:20,
     * streak:0, hasMadeFirstPurchase:false } with no network call at all
     * when there's no logged-in account or no email on file (a legacy
     * account that never added one — signup requires an email today, see
     * signup() above) since the server side has nothing to key a balance
     * on without one either way. Used by profile.html's/style.html's/
     * result.html's/processing.html's/shop.html's/explore.html's token UI —
     * the real enforcement is generate-video.js's server-side E112 check,
     * this is never the security boundary.
     */
    getTokenStatus: function () {
      var email = currentAccountEmail();
      // dailyClaimAmount here mirrors entitlements.js's real
      // DAILY_CLAIM_AMOUNT (20 as of the 2026-07-28 daily-claim switch —
      // see tracker item recurring-bug-class-hardcoded-daily-gran-h6swgy
      // for why this exact hand-maintained fallback keeps needing manual
      // updates: this is a plain script with no bundler/require, so it
      // can't import entitlements.js's live constants the way
      // get-token-status.js now does). claimable is unconditionally false
      // here — there's no identity to claim anything against with no email
      // on file. hasMadeFirstPurchase is unconditionally false here too —
      // no email on file means no identity that could have ever completed
      // a purchase, so shop.html's first-purchase-bonus callout is safe to
      // show (see that page's own script for how it uses this field).
      if (!email) return Promise.resolve({ balance: 0, claimable: false, nextClaimAt: null, dailyClaimAmount: 20, streak: 0, hasMadeFirstPurchase: false });
      return fetch('/.netlify/functions/get-token-status?email=' + encodeURIComponent(email))
        .then(function (res) { return res.json(); })
        .then(function (data) {
          if (data.error) throw new Error(data.error);
          return data;
        });
    },

    /**
     * Attempts the daily token claim for the signed-in account — thin
     * wrapper around POST claim-daily-tokens.js (see that file and
     * lib/entitlements.js's claimDailyTokens for the full mechanism:
     * rolling 20h server-clock cooldown, streak logic, single atomic
     * write). Resolves to `{ claimed:false, nextClaimAt:0 }` with no
     * network call when there's no logged-in account or no email on file —
     * same "nothing to key a claim on without an identity" guard
     * getTokenStatus above already has. Callers (js/purchase-sheet.js's
     * claim sheet) branch on `data.claimed`, never on HTTP status — a
     * "not yet claimable" response is a normal 200, not a rejection (see
     * claim-daily-tokens.js's own doc comment).
     */
    claimDailyTokens: function () {
      var email = currentAccountEmail();
      if (!email) return Promise.resolve({ claimed: false, nextClaimAt: 0 });
      return fetch('/.netlify/functions/claim-daily-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email })
      })
        .then(function (res) { return res.json(); })
        .then(function (data) {
          if (data.error) throw new Error(data.error);
          return data;
        });
    },

    /**
     * Fire-once-per-account guard for the "first video created" conversion
     * event (see result.html's call site + js/analytics-config.js's
     * fireMetaConversion). Returns true exactly once ever, for the
     * chronologically-first completed dream (ownerHandle + videoUrl) this
     * account ever generates — every other call (a revisit/reload of that
     * same dream, or the account's 2nd/Nth completed dream) returns false,
     * atomically: eligibility-check and flag-write happen in the same call
     * so there's no separate "check" step a caller could race against.
     *
     * The flag itself (firstVideoCreatedFired) lives directly on the
     * account record (state.accounts[key]) — the same per-account
     * persistence the email field above already uses — so it survives
     * logout/login and page reloads on this browser, the closest this
     * fake backend gets to a real backend's per-user "has this one-time
     * event already fired" column. Accounts that predate this feature
     * simply have the field undefined (falsy), which is exactly the
     * "not yet fired" state, no migration needed.
     *
     * dreamId is required and compared against the account's current
     * (and, given the length===1 check, only) completed dream — this
     * guards against firing for the wrong dream if the caller's own
     * "just generated" bookkeeping (e.g. a page-level sessionStorage
     * marker) is ever stale.
     */
    markFirstVideoCreatedIfEligible: function (dreamId) {
      if (!state.user || !dreamId) return false;
      var key = state.user.username.toLowerCase();
      var account = state.accounts[key];
      if (!account || account.firstVideoCreatedFired) return false;
      var myHandle = state.user.handle;
      var completed = state.dreams.filter(function (d) { return d.ownerHandle === myHandle && !!d.videoUrl; });
      if (completed.length !== 1 || completed[0].id !== dreamId) return false;
      account.firstVideoCreatedFired = true;
      persist();
      return true;
    },

    /**
     * Best-effort trigger for the "your dream is ready" RETENTION email
     * (tracker.html's for-product-retention-email-send-user-th-eke9ra
     * item — day-1 -> day-2+ return, distinct from the FirstVideoCreated
     * KPI event above though fired from the exact same choke point — see
     * result.html's/explore.html's call sites, right alongside their own
     * markFirstVideoCreatedIfEligible(dream.id) guard). Callers must
     * gate this on that SAME eligibility check already having returned
     * true — this function does not re-check eligibility itself, it just
     * fires the request. Fire-and-forget: never throws, never awaited,
     * must never block rendering. The server
     * (send-first-dream-email.js) does the actual security-sensitive
     * work — a real password re-check (see that file's own header
     * comment on why a bare username alone isn't enough here, unlike
     * most of this codebase's other client-trusted-identity endpoints:
     * this one has a real side effect on a third party's inbox plus a
     * permanent per-account guard), resolving the account's real
     * verified email, and the durable "exactly once per account" guard —
     * this call only supplies proof of which account it's firing for; it
     * is never trusted with the send decision itself. The password comes
     * from THIS account's own already-cached local credential
     * (state.accounts[key].password — the same plaintext-local account
     * model every other DreamStore method already relies on), so this
     * adds no new re-auth prompt for the user.
     *
     * Video-only, matching markFirstVideoCreatedIfEligible's own scope
     * above (it only ever returns true for a videoUrl dream) — an image-
     * type dream's completion never reaches this call in practice, but
     * the explicit videoUrl check below keeps that scope decision visible
     * here too rather than silently relying on the caller.
     */
    sendFirstDreamEmailBestEffort: function (dream) {
      if (!state.user || !dream || !dream.videoUrl) return;
      var key = state.user.username.toLowerCase();
      var account = state.accounts[key];
      if (!account) return;
      try {
        fetch('/.netlify/functions/send-first-dream-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: state.user.username,
            password: account.password,
            dreamId: dream.id,
            caption: dream.caption,
            style: dream.style,
            videoUrl: dream.videoUrl,
            mediaType: dream.mediaType || 'video'
          })
        }).catch(function () { /* best-effort, must never break the app */ });
      } catch (e) { /* best-effort, must never break the app */ }
    },

    /**
     * Enables the owner generation-rate-limit bypass for THIS browser
     * (tracker.html's for-product-founder-hit-the-per-ip-gener-7mjq2l
     * item — see netlify/functions/lib/owner-bypass.js's header comment
     * for the full mechanism and why this needs a real password, not just
     * being logged in as an account whose email happens to match
     * OWNER_EMAIL). Reuses the CURRENTLY signed-in account's own already-
     * cached local credential (state.accounts[key].password) — the exact
     * same "no new re-auth prompt" pattern sendFirstDreamEmailBestEffort
     * above already establishes — rather than asking for a password a
     * second time in a form, since admin.html (this method's only
     * intended caller) is already gated on being signed in as an account
     * whose email matches OWNER_EMAIL before it even shows the control.
     *
     * POSTs to verify-owner-bypass.js, which independently re-verifies
     * the real password server-side regardless of anything this client
     * believes about who's signed in — see that file's own header comment.
     * On success, stores the returned short-lived token + its expiry in
     * localStorage (getOwnerBypassToken reads it back) so every
     * subsequent startGeneration call in this browser attaches it
     * automatically until it expires. Returns a Promise resolving
     * { ok:true, expiresAt } or { ok:false, error }.
     */
    verifyOwnerBypass: function () {
      if (!state.user) return Promise.resolve({ ok: false, error: 'not_logged_in' });
      var key = state.user.username.toLowerCase();
      var account = state.accounts[key];
      if (!account) return Promise.resolve({ ok: false, error: 'not_logged_in' });
      return fetch('/.netlify/functions/verify-owner-bypass', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: state.user.username, password: account.password })
      })
        .then(function (res) { return res.json().then(function (data) { return { status: res.status, data: data }; }); })
        .then(function (result) {
          if (!result.data || !result.data.ok) {
            return { ok: false, error: (result.data && result.data.error) || 'request_failed' };
          }
          try {
            localStorage.setItem(OWNER_BYPASS_TOKEN_KEY, result.data.token);
            localStorage.setItem(OWNER_BYPASS_EXPIRES_KEY, String(result.data.expiresAt));
          } catch (e) { /* storage unavailable — bypass simply won't persist this session */ }
          return { ok: true, expiresAt: result.data.expiresAt };
        })
        .catch(function () {
          return { ok: false, error: 'network_error' };
        });
    },

    /**
     * Local read of the owner bypass's current status for this browser —
     * { active:boolean, expiresAt:number|null } — used by admin.html to
     * render "Active until …" vs. an "Enable" control. Never a security
     * check itself (see getOwnerBypassToken's own header note) — purely
     * UI state.
     */
    getOwnerBypassStatus: function () {
      var token = getOwnerBypassToken();
      if (!token) return { active: false, expiresAt: null };
      var expiresAt = parseInt(localStorage.getItem(OWNER_BYPASS_EXPIRES_KEY), 10);
      return { active: true, expiresAt: expiresAt || null };
    },

    /**
     * Clears any locally-stored owner bypass token for this browser —
     * lets admin.html offer an explicit "Disable" action rather than only
     * ever waiting out the 12h TTL. Purely a local, best-effort cleanup;
     * the token itself simply expires server-side on its own regardless.
     */
    clearOwnerBypass: function () {
      try {
        localStorage.removeItem(OWNER_BYPASS_TOKEN_KEY);
        localStorage.removeItem(OWNER_BYPASS_EXPIRES_KEY);
      } catch (e) { /* storage unavailable — nothing to clear */ }
    },

    /**
     * Durable, server-side replacement for the old sessionStorage
     * `dreamtube_just_generated_id` marker (tracker.html's
     * result-htmls-firstvideocreated-still-dep-qfg48t item,
     * founder-approved 2026-07-27 -- "make the carrier durable"). Called
     * from processing.html's attachTaskHandlers right before it redirects
     * to result.html on a successful generation (fresh or regenerated),
     * exactly where the old sessionStorage.setItem call used to be.
     *
     * POSTs to /.netlify/functions/mark-generation-completed, which
     * durably records "this operation was just seen to complete" keyed by
     * the JOB'S OWN operationName (see finalizeDream's doc comment for why
     * this is operationName-keyed, NOT dreamId-keyed -- a review finding:
     * dreamId is client-invented and already public elsewhere in this app,
     * so keying on it let any unauthenticated caller plant a marker for a
     * dreamId they merely knew/guessed, forging a false FirstVideoCreated
     * for someone else's account on their next ordinary revisit.
     * operationName is server-issued at submission time and never exposed
     * in any UI/URL, and mark-generation-completed.js independently
     * re-verifies it actually completed before honoring the write -- see
     * that file and lib/generation-completion-store.js's own header
     * comments for the full mechanics). `keepalive: true` gives this
     * request its best chance of actually completing even though the page
     * navigates away ~350ms later -- the same hazard (an in-flight request
     * getting cut off by navigation) that made sessionStorage an
     * unreliable carrier across some FB/IG in-app browser webview
     * redirects in the first place; a plain fetch here would just move the
     * same class of risk from "storage" to "network", not fix it.
     *
     * Fire-and-forget, best-effort: must never throw or delay the
     * redirect it runs right before. A failure here (offline, a webview
     * that kills the request anyway) means this specific completion's
     * FirstVideoCreated fire may be missed -- an honest degrade, not a
     * crash, same posture the old sessionStorage marker already had when
     * storage was disabled.
     */
    markGenerationJustCompleted: function (operationName) {
      if (!operationName) return;
      try {
        fetch('/.netlify/functions/mark-generation-completed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ operationName: operationName }),
          keepalive: true
        }).catch(function () { /* best-effort, must never break the app */ });
      } catch (e) { /* best-effort, must never break the app */ }
    },

    /**
     * Durable counterpart to markGenerationJustCompleted above -- consumes
     * (reads + deletes, exactly once) the durable marker for
     * `operationName` via /.netlify/functions/consume-generation-marker,
     * returning a Promise that resolves true only the first time this is
     * called for an operationName that was actually just marked complete
     * (and independently re-verified server-side, see mark-generation-
     * completed.js). Every call after that (a reload of result.html, an
     * operationName that was never marked/verified, or a network failure
     * reaching the endpoint at all) resolves false. `operationName` here
     * comes from the dream's own `sourceOperationName` field (see
     * finalizeDream) -- an old/legacy dream with none never even attempts
     * the network call, resolving false immediately (nothing to check).
     *
     * This is HALF of result.html's FirstVideoCreated eligibility check --
     * the durable replacement for the old
     * `sessionStorage.getItem('dreamtube_just_generated_id') ===
     * dream.id` comparison, proving this page load is the actual moment
     * generation just finished, not a later revisit/reload of an old
     * result.html?id=... URL. Callers must still separately gate the
     * actual conversion fire on markFirstVideoCreatedIfEligible(dreamId)
     * above (the OTHER, unchanged half -- is this genuinely the account's
     * first-ever completed dream) -- this function alone does not decide
     * eligibility, exactly like the old sessionStorage read never did
     * either. See docs/EVENT_TAXONOMY.md's "FirstVideoCreated" section for
     * the full two-guard picture.
     *
     * Never rejects in a way a caller needs to special-case: a network/
     * server failure resolves false (not fresh, don't fire) rather than
     * throwing, the same honest "storage unavailable, marker missing"
     * degrade the sessionStorage version already had.
     */
    wasOperationJustCompleted: function (operationName) {
      if (!operationName) return Promise.resolve(false);
      return fetch('/.netlify/functions/consume-generation-marker', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operationName: operationName })
      })
        .then(function (res) { return res.json(); })
        .then(function (data) { return !!(data && data.matched); })
        .catch(function () { return false; });
    },

    /**
     * Pure, read-only query: true if `dreamId` is (as far as this
     * account's own local dream data can tell) this account's ONLY
     * completed dream -- the exact same eligibility computation
     * markFirstVideoCreatedIfEligible above makes, minus that function's
     * one-time flag check-and-set. Unlike markFirstVideoCreatedIfEligible,
     * this has no side effect and can be called repeatedly (including on
     * an ordinary revisit, or for an account whose fire-once flag is
     * already set) without consuming anything.
     *
     * Exists purely to feed a PostHog sanity-check signal
     * (`first_video_result_view`, see result.html's call site and
     * docs/EVENT_TAXONOMY.md) that's independent of FirstVideoCreated's
     * own fire-once/durable-marker gating -- comparing this event's count
     * against FirstVideoCreated's own count is what makes any remaining
     * undercount (from the durable marker above still failing sometimes,
     * e.g. total network loss) visible after this fix ships, per
     * tracker.html's result-htmls-firstvideocreated-still-dep-qfg48t item.
     */
    isOnlyCompletedDream: function (dreamId) {
      if (!state.user || !dreamId) return false;
      var myHandle = state.user.handle;
      var completed = state.dreams.filter(function (d) { return d.ownerHandle === myHandle && !!d.videoUrl; });
      return completed.length === 1 && completed[0].id === dreamId;
    }
  };
})();
