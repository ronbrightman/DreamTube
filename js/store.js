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
//   signupPasswordless(email) -> Promise, POST /.netlify/functions/register-
//       account-passwordless (tracker item for-product-build-passwordless-
//       signup-fo-at2fko) — the founder-decided passwordless entry path: no
//       password field, ever. Username is derived server-side. A genuinely
//       NEW email creates the account and signs the caller in immediately,
//       with `emailVerified:false` until a later, deferred verification
//       (see verifyEmailCode/resendVerificationCode below and
//       js/email-verify-sheet.js) — never blocking at signup time. An
//       ALREADY-REGISTERED email does NOT sign the caller in — see
//       loginWithEmailCode below and this method's own SECURITY FIX doc
//       comment for why a bare email match must never grant access to an
//       existing account. Falls back to a LOCAL-ONLY account (same "server
//       unreachable" degrade signup() already has) if the network call
//       itself can't be completed at all — the local fallback's account is
//       marked `emailVerified:true` (see commitLocalPasswordlessSignup's own
//       comment for why: with no server round trip, no code was ever sent
//       to gate against, so treating it as verified is the "under-gate"
//       side of this feature's own stated default).
//   loginWithEmailCode(email,code) -> Promise, POST /.netlify/functions/
//       login-with-email-code — completes signupPasswordless's "resolve an
//       existing account" branch: a genuine LOGIN (no prior session), only
//       granted once the server confirms the mailed 6-digit code actually
//       matches.
//   getAccountEmailVerified() -> local read of the signed-in account's own
//       cached `emailVerified` (refreshed on every signup/login response)
//       — lets UI (js/email-verify-sheet.js) decide whether to ever bother
//       prompting, with no network call.
//   verifyEmailCode(code) -> Promise, POST /.netlify/functions/verify-
//       email-code {authToken, code} — the explicit "type the code back
//       in" half of deferred verification for an ALREADY-signed-in,
//       unverified account (not to be confused with loginWithEmailCode
//       above, which establishes a session in the first place).
//   resendVerificationCode(opts) -> Promise, POST /.netlify/functions/resend-
//       verification-code {authToken, auto:!!opts.auto} -- see that
//       endpoint's own header comment for what `auto` opts into.
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
//   getFollowStatus()            -> GET  /.netlify/functions/get-following (Social Layer v2
//       slice 3 "follow" — the CURRENT account's own following list + follower count, never
//       anyone else's — see that function's own header comment)
//   toggleFollow(targetHandle,currentlyFollowing) -> POST /.netlify/functions/follow-user
//   isBlocked(handle) / getBlockedHandles() -> local reads of this device's block list
//   blockUser(handle) / unblockUser(handle) -> local write + best-effort POST
//       /.netlify/functions/block-user (public feed safety, tracker item
//       for-product-public-feed-safety-in-app-re-ppuw77)
//   syncBlockedHandlesFromServer() -> best-effort GET /.netlify/functions/block-user,
//       merges a signed-in account's durable server-side block list into this device
//   Private dreams (never-published, or unpublished-again) also get a
//   durable per-account server-side copy now (tracker item
//   for-product-build-p0-server-side-dream-p-zl3rb2, lib/dream-store.js /
//   dream-sync.js) — reconcilePrivateDreamsFromServer() merges this
//   account's local dreams with that server copy right after every real
//   login()/signup() success (never clobbering a newer local edit).
//   login()'s own server-confirmed branch AWAITS this call (chains its
//   promise) rather than firing it off unobserved — tracker item
//   for-product-urgent-founder-family-repro--nsbbg5, a real production
//   data-loss report, found that a fire-and-forget call here races an
//   immediate post-login redirect (login.html does exactly that, for
//   both an ordinary login and a post-password-reset login — both funnel
//   through this same login()): the browser can abort the in-flight
//   fetch when the document unloads, before the merge/persist() this
//   function performs ever runs, silently discarding a webview-wipe/
//   password-reset restore that had already round-tripped successfully.
//   See reconcilePrivateDreamsFromServer's own doc comment for the full
//   reproduction. syncPrivateDreamBestEffort()/deletePrivateDreamBestEffort()
//   still fire fully fire-and-forget on every local create/edit/unpublish/
//   delete — those aren't followed by an immediate redirect the way login
//   is, so the same race doesn't apply. All three are internal (not
//   exposed on the DreamStore object below), reusing the SAME
//   state.user.authToken block-user's own sync above already mints/
//   threads — see their own doc comments just above them for the full
//   merge logic and the PRIVATE_DREAM_SYNC_ENABLED staged-rollout flag.
//   Deliberately triggered eagerly at login/signup (unlike
//   syncBlockedHandlesFromServer's own lazy explore.html-page-load trigger)
//   — a brand-new-to-this-device login is exactly what webview-storage-wipe
//   recovery looks like, so restoring dreams as early as possible matters
//   more here than it does for a blocklist.
//   getMyDreams()               -> GET  /api/users/me/dreams
//   getDreamInsight()           -> local read, recurring dream-theme detection for Profile (idea #4)
//   getDreamMilestone()         -> local read, dream-count milestone for Profile (idea #5)
//   getDreamLogStatus()         -> local read, home.html's Today/This-Week card state (loggedToday,
//       todayEntryType, weekCount vs. weekTarget, hasEverLogged, isFirstEverNight) — tracker item
//       for-product-build-homepage-wave-1-the-ri-xr8mir (isFirstEverNight added by
//       for-product-funnel-ending-v2-founder-ins-tfuu0q — see that field's own doc comment)
//   getPendingDreamId()         -> local read, the synthetic `pending:<operationName>` id the
//       Chamber opens for a still-generating dream — see findPendingDream's own doc comment
//   pendingDreamIdFor(opName)   -> pure helper, the same synthetic id for an operationName whose
//       pendingJob has ALREADY been cleared (a just-settled generation) — see its own doc comment
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
//   generateInterpAudio(id,personaKey,text) -> Speaking Sage Option D (docs/SPEAKING_SAGE_SPEC.md,
//       tracker item for-product-build-speaking-sage-wave-fou-8uobuh) — POST
//       /.netlify/functions/generate-interp-audio then polls /.netlify/functions/interp-audio-status
//       to completion (mirrors pollUntilDone's shape, own doc comment near its definition below).
//       On success writes audioUrl/audioDurationMs/captions/captionsLevel onto
//       interpretations[personaKey] (same object generateInterpretationReading already writes
//       text/at/qa onto) and persists. Only ever called for a persona whose
//       js/interpreter-personas.js entry has a non-null voiceId (currently: talmudic/The Sage only).
//   hasIntroShown(id,personaKey) / markIntroShown(id,personaKey) -> local read/write of a
//       PER-DREAM-PER-PERSONA "already played this persona's one-time intro clip" flag —
//       deliberately NOT nested inside interpretations[personaKey] (unlike audioUrl/captions
//       above) so it survives finalizeDream's edit-clear (which nulls the WHOLE interpretations
//       map — Wave 1 §3.6), per docs/SPEAKING_SAGE_SPEC.md §7's explicit requirement that seeing
//       a persona's greeting once shouldn't reset just because the dream's text was later edited.
//   getTokenStatus()                      -> GET  /.netlify/functions/get-token-status
//   markFirstVideoCreatedIfEligible(dreamId) -> local read+write, fire-once-per-account guard for
//                                                the "first video created" conversion event (see
//                                                result.html's call site + js/analytics-config.js)
//   markGenerationJustCompleted(operationName) -> fire-and-forget, POST /.netlify/functions/mark-generation-completed
//       — durable (server-side, operationName-keyed and server-verified) replacement for the old
//       sessionStorage "just generated" marker; called from processing.html right before its redirect.
//   wasOperationJustCompleted(operationName) -> Promise<boolean>, POST /.netlify/functions/consume-generation-marker
//       — durable counterpart to markGenerationJustCompleted, consumed exactly once by result.html.
//   markResultViewed(operationName) -> fire-and-forget, POST /.netlify/functions/mark-result-viewed
//       — durable server marker that the user actually WATCHED their result (fullscreen open); the
//       suppression signal for the "unwatched dream" retention nudge. Called from result.html's openFullscreenVideo.
//   isOnlyCompletedDream(dreamId) -> local read-only query, same eligibility computation as
//       markFirstVideoCreatedIfEligible minus its one-time flag — feeds the PostHog
//       first_video_result_view sanity-check signal (see result.html's call site).
//   saveThumbnailBestEffort(dreamId, imageDataUrl) -> fire-and-forget, POST
//       /.netlify/functions/upload-dream-thumbnail — persists a client-captured video-frame-1
//       still (result.html draws the <video> element to a <canvas>) as this dream's imageUrl,
//       so the retention email above can show a real thumbnail instead of its flat-color
//       fallback — see netlify/functions/upload-dream-thumbnail.js's own header comment.
//   verifyOwnerBypass() -> Promise, POST /.netlify/functions/verify-owner-bypass — real
//       password re-check for the currently signed-in account; on success, stores a
//       short-lived owner generation-rate-limit bypass token locally (see
//       netlify/functions/lib/owner-bypass.js and admin.html's "Owner Generation Bypass" control).
//   getOwnerBypassStatus() / clearOwnerBypass() -> local read/write of that token's UI state.
//   adoptPendingGeneration(operationName,startedAt,caption,style,mediaType,storyText,mood) -> local
//       write, adopts an already-submitted (pre-signup) generation job as this browser's
//       pendingJob — see wizard.html's "generate during signup" seam and
//       start-pending-generation.js. `mood` (tracker item for-product-founder-08-04-evening-
//       music--jfjco0) is the wizard's Mood step answer; this is the ONLY place it can be
//       attached on that path, since it never calls startGeneration on the way out.
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
//   E304 dream_sync_unconfirmed  — NOT a rejected-Promise error like the four
//        above (never thrown, never shown to the user) — a synthetic
//        `generation_failed` reason tag (see that event's own doc block
//        below and docs/EVENT_TAXONOMY.md) fired when a dream that DID
//        finish generating still has no confirmed server-side dream-sync
//        copy after attemptPrivateDreamSync's full local retry budget is
//        exhausted — the observable shape of the P0 data-loss "vanish" bug
//        (tracker item for-product-p0-data-loss-founder-repro-0-6bzvv1,
//        fix merged as commit 7b7828c) reappearing, kept in this same E3xx
//        range purely for a consistent reason-code shape across every
//        generation_failed fire, instrumentation-only (tracker item
//        for-product-track-avg-video-generation-t-2ci8ue).
//
// 'generation_failed' (PostHog) — fired once per terminal generation
// failure, from TWO independent choke points so every real failure shape is
// covered, not just the refund-eligible subset:
//   (1) startGeneration's own outer .catch — covers a real fal-reported
//       error (E205/E208/E505/E508 etc, passed through from video-status.js/
//       image-status.js as-is), a client-side poll timeout (E301), a
//       sustained poll network failure (E302), and a submission-time
//       failure (E1xx/E4xx from generate-video.js/generate-image.js, or
//       E303/E399 client-side). Deliberately skipped for a STALE/superseded
//       edit's late failure (see isStaleEdit below) — that attempt was
//       already quietly ignored (no error toast, the newer attempt owns
//       pendingJob and settles on its own), so counting it as a real
//       failure would double-count against the same dream's other, live
//       attempt.
//   (2) attemptPrivateDreamSync's own terminal give-up (see that function
//       below) — covers the E304 vanish shape above, a class of failure
//       that never rejects startGeneration's promise at all (the
//       generation itself succeeded; only the sync of the finished dream
//       record failed).
// `{ reason, mediaType, elapsed_ms, model }` — `reason` is the same
// "ENNN: ..." string this codebase already surfaces elsewhere (tokens_refunded's
// own `reason`, err.message here) for (1), or the synthetic E304 tag for
// (2); `elapsed_ms` is time-since-submission for (1) (mirrors
// video_created's own `duration_ms`, see finalizeDream below) or
// time-since-dream-creation for (2) (a long-unconfirmed dream is a more
// useful signal there than the short local retry-burst window);  `model` is
// whichever rotation-eligible model key the job reported (video only, null
// otherwise — same null-means-not-applicable convention as `model_used`).
// See docs/EVENT_TAXONOMY.md for the full spec.
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

  // Founder's own explicit stated threshold (2026-08-10, tracker item
  // for-product-track-avg-video-generation-t-2ci8ue): "alert if any single
  // job exceeds 3 minutes." Deliberately a literal 3 * 60 * 1000, not
  // derived from MAX_POLL_MS or POLL_INTERVAL_MS above — this is a
  // reporting/alerting threshold about how long is "unusually slow," a
  // completely separate concern from MAX_POLL_MS's "give up entirely"
  // ceiling (10 minutes) — a generation can cross this and still finish
  // completely normally.
  var GENERATION_SLOW_THRESHOLD_MS = 3 * 60 * 1000;

  // Single on/off point for the whole private-dream server-sync feature
  // (tracker item for-product-build-p0-server-side-dream-p-zl3rb2) — the
  // "staged, reversible rollout" the tracker item explicitly asks for.
  // Flipping this to `false` and redeploying fully disables every sync
  // call site below (syncPrivateDreamBestEffort/deletePrivateDreamBestEffort/
  // reconcilePrivateDreamsFromServer all check it first and no-op) without
  // touching any other code or reverting this branch — every one of those
  // functions already degrades to a silent no-op on a missing authToken
  // (see commitLocalSignup's own doc comment for exactly which sign-in
  // paths mint a real one vs. leave it null), so this flag is purely
  // an extra manual override on top of that, for a fast kill switch if
  // something unexpected turns up in production after merge.
  var PRIVATE_DREAM_SYNC_ENABLED = true;

  var STYLE_GRADIENTS = {
    Cartoon:   'linear-gradient(165deg,#FFD68A,#FFB199)',
    Cinematic: 'linear-gradient(165deg,#3E6E8E,#182A44 55%,#0B0A1F)',
    Anime:     'linear-gradient(165deg,#FF8FCB,#9F8FFF)',
    Realistic: 'linear-gradient(165deg,#7C8AAE,#2A2F4A)'
  };

  // Deterministic per-username fallback avatar palette (tracker item
  // for-product-ui-founder-directed-2026-07--djgjn0: the Explore feed-user-
  // row's circle used to render permanently empty -- see explore.html's
  // cardHTML/avatarHTML). When there's no real photo to show (no avatar
  // thumbnail synced yet, or a legacy dream published before this feature
  // shipped at all), every viewer's device must land on the exact SAME
  // color + initial for a given username -- this is a pure function of the
  // username alone (see hashString/avatarFallback below), never
  // Math.random or anything else that could differ render to render or
  // device to device. Order is significant (index picked by hash) --
  // appending a new entry is safe (every existing username keeps its
  // current color), but never reorder or remove one, or every existing
  // user's fallback color would silently shift. Colors are drawn from
  // this app's existing accent families (STYLE_GRADIENTS above,
  // --gradient-ig/--accent-trust/--accent-value/--accent-growth in
  // css/styles.css) so a fallback circle still reads as "on-brand", not an
  // arbitrary rainbow.
  var AVATAR_FALLBACK_PALETTE = [
    'linear-gradient(135deg,#833AB4,#FD1D1D)',
    'linear-gradient(135deg,#6C8CFF,#3E6E8E)',
    'linear-gradient(135deg,#D9A653,#FFB199)',
    'linear-gradient(135deg,#5FB88A,#1E3A2F)',
    'linear-gradient(135deg,#FF8FCB,#9F8FFF)',
    'linear-gradient(135deg,#FFD68A,#FF8FCB)',
    'linear-gradient(135deg,#7C8AAE,#2A2F4A)',
    'linear-gradient(135deg,#FCB045,#833AB4)'
  ];

  /**
   * Small, deterministic (no Math.random) string hash — classic djb2. Same
   * input always produces the same non-negative 32-bit output, which is
   * exactly what avatarFallback below needs: a given username must render
   * identically across every device and every render, not just within one
   * session.
   */
  function hashString(str) {
    var hash = 5381;
    for (var i = 0; i < str.length; i++) {
      hash = ((hash * 33) ^ str.charCodeAt(i)) >>> 0;
    }
    return hash;
  }

  /**
   * Deterministic per-username fallback avatar: { gradient, initial }. Pure
   * function of `handle` alone (the '@'-prefixed or bare username) — see
   * AVATAR_FALLBACK_PALETTE's own doc comment for why this must never
   * depend on anything else. `initial` is the first letter/digit of the
   * display name (displayHandle-stripped), uppercased; '?' for an empty/
   * non-string handle so this never renders truly blank either.
   */
  function avatarFallback(handle) {
    var clean = (typeof handle === 'string' ? handle : '').replace(/^@/, '').trim();
    var match = clean.match(/[a-z0-9]/i);
    var initial = match ? match[0].toUpperCase() : '?';
    var idx = clean ? (hashString(clean.toLowerCase()) % AVATAR_FALLBACK_PALETTE.length) : 0;
    return { gradient: AVATAR_FALLBACK_PALETTE[idx], initial: initial };
  }

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
      // isEditDelta/editDeltaLength (docs/EDIT_MECHANISM_SPEC.md §3.4,
      // tracker item for-product-new-edit-mechanism-founder-i-qmsdgj): set
      // by result.html's new edit sheet's persistEditDeltaDraft, right
      // alongside sourceDreamId, so processing.html's runGeneration knows to
      // call DreamStore.startDreamEdit (model-rotation + editHistory)
      // instead of the plain regenerateDream every other sourceDreamId
      // draft (the old full mini-wizard's "Generate Again", "Turn this into
      // a video") already uses. editDeltaLength carries the user's
      // ORIGINAL delta text's character length only — never the raw text
      // itself, matching edit_submitted's own instrumentation rule.
      // musicBedOn (tracker item for-product-build-founder-approved-08-03-
      // jlkjy9) — REMOVED as of the 2026-08-03 founder simplification ("no
      // user choice," see js/music-bed.js's header comment): this draft no
      // longer carries a music-bed preference at all. audioOn/musicStyle
      // are the retired server-side model-audio request fields, still
      // seeded here permanently inert — see generate-video.js's own header
      // comment.
      draft: { caption: '', storyText: '', needsStoryRewrite: false, style: null, sourceDreamId: null, restore: false, characterIds: [], cameraView: null, sceneryTime: null, sceneryPlace: null, mediaType: null, sourceImageUrl: null, audioOn: false, musicStyle: null, mood: null, isEditDelta: false, editDeltaLength: null },
      dreams: [],
      pendingJob: null, // { ..., ownerHandle } once set (see savePendingJob) — like dreams'
                         // ownerHandle, reads are scoped to whoever is CURRENTLY logged in
                         // (see scopedPendingJob) rather than the job ever being cleared on
                         // logout, so a same-account mid-generation logout/relogin can still
                         // resume it, but a different account signing in on this browser never
                         // can.
      pendingInterpretations: {}, // operationName -> { personaKey: { text, at, qa } }, mirrors a
                         // real dream's own `interpretations` map shape exactly. Home.html's
                         // "funnel ending v2" day-0 flow (tracker item
                         // for-product-funnel-ending-v2-founder-ins-tfuu0q) lets the Chamber open
                         // for a dream that's STILL GENERATING (no dream id exists yet — only a
                         // pendingJob) via the synthetic `pending:<operationName>` id findDream()
                         // resolves below; a reading started there has nowhere durable to live
                         // until the real dream record exists, so it's held here, keyed by the
                         // job's own operationName, and migrated onto the finalized dream's real
                         // `interpretations` map the moment finalizeDream creates it (see that
                         // function's own comment) — so "already interpreted" carries over
                         // seamlessly from the generating tile to the finished dream, satisfying
                         // result.html's own "View your reading" state-aware hero button. Cleaned
                         // up (deleted) once migrated, or on a failed generation's retry (see
                         // startGeneration's own catch) — never left to grow unbounded.
      charactersByUser: {}, // lowercased username -> array of character objects. Private
                             // per-user and reusable across dreams, same key scheme as accounts.
      likedIds: {}, // dream id -> true. Purely local "have I liked this" state for the shared
                    // feed's heart icon — the real aggregate like count lives server-side in
                    // Blobs (see getSharedFeed/toggleSharedLike), this just decides +1 vs -1
                    // and which browsers see a filled heart. Not deduped across devices/users;
                    // there's no real account system to dedupe against, same as everywhere else.
      blockedByUser: {}, // lowercased username -> { ownerHandle (e.g. "@alice"): true, ... }.
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
      profileBioByUser: {} // lowercased username -> bio string (<=150 chars). Private local
                    // cache of THIS account's own public-profile bio (Social Layer v2 slice 1
                    // — docs/SOCIAL_LAYER_V2_DESIGN.md), keyed per account, same scheme as
                    // charactersByUser/blockedByUser above — so a different account signed
                    // into this same browser never sees or overwrites another account's bio.
                    // The server-side copy (netlify/functions/lib/profile-store.js's
                    // dreamtube-profiles record) is the one that actually renders on u.html —
                    // this local copy exists purely so profile.html's Edit-profile sheet has
                    // something to prefill from without a network round trip, mirroring why
                    // charactersByUser is local-first too. Display name/avatar don't need an
                    // equivalent local field: they're already sourced from the isSelf
                    // character record (see getMeCharacter in profile.html) — bio is the one
                    // genuinely new piece of profile data this feature introduces.
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
      if (!parsed.pendingInterpretations) parsed.pendingInterpretations = {};
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
      // `mood` (tracker item for-product-founder-08-04-evening-music--jfjco0)
      // — the dream-builder wizard's Mood step answer, carried to the
      // finished dream record so js/music-bed.js can pick a mood-keyed
      // ambient bed from it. NOT the retired `musicStyle` field just above
      // (a permanently-inert server-side model-audio request modifier) —
      // completely unrelated despite both sounding music-ish. A draft
      // written before this field existed simply has no mood, which is the
      // same "no mood" state a SKIPPED mood step produces, and both fall
      // back to the visual-style bed — see js/music-bed.js's urlForDream.
      if (parsed.draft.mood === undefined) parsed.draft.mood = null;
      // musicBedOn migration removed (tracker item for-product-build-
      // founder-approved-08-03-jlkjy9, 2026-08-03 founder simplification) —
      // the field no longer means anything (js/music-bed.js's eligible()
      // never reads it), so there is nothing left to backfill. A pre-
      // existing draft blob that still HAS a stale musicBedOn key from the
      // toggle era simply keeps carrying that inert leftover key around
      // (harmless — nothing reads it) rather than this migration actively
      // stripping it; see this file's own forward-only-migration convention
      // for why an inert extra key is left alone rather than surgically
      // deleted.
      if (!parsed.likedIds) parsed.likedIds = {};
      if (!parsed.blockedByUser) parsed.blockedByUser = {};
      if (!parsed.profileBioByUser) parsed.profileBioByUser = {};
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
   * (dreamtube_sound_on, dreamtube_dod_seen_id) — none of those are this
   * account's data (see backfillSharedFeed's own "safe to run again"
   * comment, and getSoundPref's "like a volume setting" comment), so an
   * account deletion has no more reason to touch them than logging out already
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
    delete state.profileBioByUser[usernameKey];
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

  // "pending:<operationName>" — the synthetic dream id the Chamber (js/
  // interpret-experience.js) opens for a still-generating dream (tracker
  // item for-product-funnel-ending-v2-founder-ins-tfuu0q: "Chamber readable
  // immediately... interpretation only needs the dream text, so it's
  // enterable immediately"). See pendingInterpretations' own doc comment
  // above (seed()) for the full mechanism this id plugs into.
  var PENDING_DREAM_ID_PREFIX = 'pending:';

  /** The synthetic pending-dream id for an operationName. Sole place the prefix is ever concatenated — see the exported pendingDreamIdFor's own doc comment for why callers need this for an ALREADY-settled job too. */
  function pendingDreamIdFor(operationName) {
    return operationName ? PENDING_DREAM_ID_PREFIX + operationName : null;
  }

  /**
   * The CURRENT account's real, already-finalized dream that a given
   * operationName produced, or null. `sourceOperationName` is stamped by
   * finalizeDream at the moment any job lands on a dream, and is already
   * this file's established way to answer "which dream did this job
   * become?" after pendingJob itself is gone — see isPendingJobStillCurrent,
   * which disambiguates exactly the same cleared-pendingJob ambiguity from
   * exactly the same field. Ownership-scoped the same way scopedPendingJob/
   * getMyDreams are: another account's dream is never a match, and neither
   * is anything at all while logged out.
   */
  function findResolvedDreamForOperation(operationName) {
    var myHandle = state.user ? state.user.handle : null;
    if (!operationName || !myHandle) return null;
    for (var i = 0; i < state.dreams.length; i++) {
      var d = state.dreams[i];
      if (d && d.sourceOperationName === operationName && d.ownerHandle === myHandle) return d;
    }
    return null;
  }

  /**
   * Resolves a `PENDING_DREAM_ID_PREFIX`-id to a lightweight, in-memory
   * dream-shaped object built straight off the CURRENT account's own
   * pendingJob — or, once that job has finished, to the REAL dream it
   * produced (see the fall-through below). Null only when neither exists:
   * no such in-flight job AND no finalized dream from it (a failed
   * generation, or a job belonging to a different account than the one
   * currently signed in — scopedPendingJob()/findResolvedDreamForOperation
   * both enforce that same ownership check every other pendingJob read in
   * this file gets).
   *
   * **The post-completion fall-through is load-bearing, not defensive.**
   * The whole point of the pending id (tracker item for-product-founder-
   * ask-08-04-offer-the--rlcai3) is that a reading can START while the video
   * is still generating — which means a reading/TTS request can still be IN
   * FLIGHT at the moment the video lands, and finalizeDream clears
   * pendingJob in the very same tick it creates the real dream. Without this
   * fall-through, such a response comes back to a pending id that no longer
   * resolves to anything, and generateInterpretationReading/
   * generateInterpAudio's `if (dream)` write guards skip the persist
   * SILENTLY: the reading renders in the live session (js/interpret-
   * experience.js's notifyDreamResolved/stillTargetsDream deliberately
   * tolerate the swap) but is gone on the next visit, and any real TTS spend
   * behind it is wasted. Resolving through to the real dream here fixes
   * every findDream() caller at once rather than bolting an id-repair step
   * onto each write path separately.
   *
   * `interpretations` is NOT a copy — it's the live
   * `state.pendingInterpretations[operationName]` object itself (created
   * empty on first read if it doesn't exist yet), so a write through
   * generateInterpretationReading's normal `map[personaKey] = {...};
   * persist();` path (findDream -> this function -> mutate the returned
   * object) durably persists here with ZERO special-case code in that
   * function — it already treats whatever findDream() gives it as the real
   * record to mutate. Post-completion the same is true for free: the object
   * handed back IS the real dream, and finalizeDream has already carried
   * `state.pendingInterpretations[operationName]` over onto its
   * `interpretations` map, so a late write lands on the same map any earlier
   * pre-completion write did.
   *
   * Every other field is read-only scaffolding (storyText/caption/style/
   * mediaType) — good enough for the interpretation flow (which only ever
   * reads `d.storyText || d.caption`), but the PRE-completion object is
   * deliberately NOT a real dream: it's never added to state.dreams, so
   * getMyDreams/getDreamMilestone/the shared feed/profile grids never see
   * it — only findDream() (and therefore getDream/getInterpretations/
   * requestInterpretationQuestions/generateInterpretationReading/
   * generateInterpAudio, every one of which routes through findDream) ever
   * resolves one.
   */
  function findPendingDream(operationName) {
    var job = scopedPendingJob();
    if (!job || job.operationName !== operationName) {
      // No live job under this name — but it may simply have finished
      // while a caller was mid-flight against its pending id. See above.
      return findResolvedDreamForOperation(operationName);
    }
    if (!state.pendingInterpretations[operationName]) state.pendingInterpretations[operationName] = {};
    return {
      id: PENDING_DREAM_ID_PREFIX + operationName,
      ownerHandle: job.ownerHandle,
      caption: job.caption, storyText: job.storyText || job.caption,
      style: job.style, mediaType: job.mediaType,
      isPublished: false,
      interpretationText: null, interpretationAt: null,
      interpretations: state.pendingInterpretations[operationName],
      _pending: true
    };
  }

  function findDream(id) {
    if (typeof id === 'string' && id.indexOf(PENDING_DREAM_ID_PREFIX) === 0) {
      return findPendingDream(id.slice(PENDING_DREAM_ID_PREFIX.length));
    }
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
   * shows a "classic" card. As of the founder-directed picker-always-first
   * fix (tracker item for-product-bug-founder-see-meaning-from-tecvrs,
   * 2026-08-11), open() defaults to the picker even for a dream with saved
   * REAL-persona readings — but a dream whose ONLY saved reading is this
   * `classic` key keeps the old direct-to-reading fast path (open()'s own
   * `classicOnly` branch), since there is no persona tile the picker could
   * ever show for it and no other way to reach this data at all.
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
   * Speaking Sage Option D (docs/SPEAKING_SAGE_SPEC.md §7, tracker item
   * for-product-build-speaking-sage-wave-fou-8uobuh) — per-dream-per-
   * persona "has this persona's one-time intro clip already played for
   * THIS dream" flag. Lives on `dream.introShownPersonas` (a plain
   * `{ [personaKey]: timestamp }` map), deliberately a SIBLING of
   * `interpretations`, not nested inside `interpretations[personaKey]` —
   * finalizeDream's edit-clear (Wave 1 §3.6) nulls the whole
   * `interpretations` map wholesale on every edit/regenerate, and the spec
   * is explicit that seeing a persona's greeting once must NOT reset just
   * because the dream's text was later edited (§7: "not cleared by
   * edit/regenerate"). Nesting this flag inside `interpretations[key]`
   * (as an early draft of this spec literally described) would make that
   * impossible given how finalizeDream's patch actually works — flagged
   * here as a deliberate, documented deviation from that literal text, not
   * an oversight, same spirit as js/interpret-experience.js's own
   * documented deviations elsewhere in this codebase.
   */
  function hasIntroShownFlag(dream, personaKey) {
    return !!(dream && dream.introShownPersonas && dream.introShownPersonas[personaKey]);
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

  /**
   * Cross-tab/cross-device staleness check for a generation attempt about to
   * finalize (tracker item for-product-bug-founder-repro-edited-dre-jcasn1,
   * the "stale async callback" bug class this codebase has hit repeatedly —
   * see e.g. signupAttemptToken/pendingGenerationToken in wizard.html/
   * start.html for the same shape applied at the UI layer). A second edit/
   * regenerate of the SAME dream, submitted from another tab or device
   * before the first one's own poll resolves, overwrites this account's
   * single pendingJob slot with ITS OWN operationName the moment IT starts
   * (see savePendingJob above) — so by the time the FIRST attempt's
   * pollUntilDone finally resolves, state.pendingJob no longer names it.
   * Reads localStorage FRESH (not this page's own in-memory `state`, which
   * a second tab/device's write never updates here — this app has no
   * cross-tab storage-event sync) so this is reliable even when the newer
   * attempt was submitted somewhere else entirely, not just later on this
   * same page. Fails open (true) on any storage/parse hiccup — never block
   * a legitimate completion over an infra blip, same reasoning as this
   * file's other defensive localStorage reads.
   *
   * BUG FIX (tracker item for-product-bug-founder-repro-high-edit--i2yzqo,
   * founder repro directly on top of jcasn1 shipping): a MISSING pendingJob
   * (`job` falsy) used to be treated as unconditionally "superseded"
   * (`!!job && ...` short-circuits to false) — but a cleared pendingJob is
   * AMBIGUOUS, not proof of that. It can mean either:
   *   (a) a genuinely NEWER edit of this same dream was submitted AND has
   *       already itself finished (cleared pendingJob on ITS OWN
   *       completion) — this attempt really is stale, must not clobber it
   *       (the exact scenario this guard was built for, and this repo's
   *       own regression test for it — "a SECOND edit... wins" below);
   *   (b) a CONCURRENT resumer of THIS EXACT SAME operationName already
   *       finished it first and cleared the slot — this attempt is NOT
   *       stale, just redundant. Completely realistic in production, not
   *       just theoretical: home.html's own "resume on load"
   *       (`if(pendingJob){ DreamStore.resumePendingJob(); }`) and
   *       result.html's identical "regenerating resume driver" can both be
   *       alive at once for the SAME operationName — e.g. the tab that
   *       actually submitted the edit (home.html) is left open (or
   *       preserved by the browser's back-forward cache — bfcache does
   *       not abort an in-flight fetch, it just freezes/thaws it) while
   *       the user separately opens or returns to the dream's own room
   *       mid-generation. Reproduced directly with two concurrent
   *       Playwright pages sharing one localStorage, both auto-resuming
   *       the same seeded pendingJob: whichever finished first
   *       legitimately cleared pendingJob, and the second (the one the
   *       "user" was actually watching) had the OLD `!!job` check wrongly
   *       read that as supersession, silently swallowing its own
   *       completion — `resumePendingJob().then()` got back `null`, so
   *       result.html's own `if(!finishedDream) return;` bailed with no
   *       render(), no toast, and the frame stayed stuck showing the
   *       regenerating veil (over the OLD pre-edit video underneath)
   *       forever — exactly the founder's report.
   * Disambiguating (a) from (b) needs one more signal beyond pendingJob
   * alone, since clearing it destroys which job cleared it: `sourceDreamId`
   * (now threaded through as a second argument) lets this read the DREAM's
   * own `sourceOperationName` — stamped by finalizeDream at the moment ANY
   * job actually lands on this dream. If it already equals THIS
   * operationName, case (b): a concurrent resumer of the same job beat
   * this one to it, not a genuinely different attempt — not stale (see
   * finalizeDream's own matching idempotency guard for what happens next
   * once this lets a redundant-but-legitimate same-job completion
   * through). If it's anything else (a different operationName, or the
   * dream doesn't even exist), case (a): genuinely superseded, stale.
   */
  function isPendingJobStillCurrent(operationName, sourceDreamId) {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return true;
      var parsed = JSON.parse(raw);
      var job = parsed.pendingJob;
      if (job) return job.operationName === operationName;
      // pendingJob is cleared -- ambiguous, see doc comment above.
      // Disambiguate via the dream's own sourceOperationName.
      var dreams = Array.isArray(parsed.dreams) ? parsed.dreams : [];
      var dream = null;
      for (var i = 0; i < dreams.length; i++) {
        if (dreams[i] && dreams[i].id === sourceDreamId) { dream = dreams[i]; break; }
      }
      if (!dream) return true; // can't tell -- fail open, same philosophy as the rest of this function
      return dream.sourceOperationName === operationName;
    } catch (e) { return true; }
  }

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

  // Avatar thumbnail attached to a published dream (tracker item
  // for-product-ui-founder-directed-2026-07--djgjn0): the Me character's
  // photoDataUrl (profile.html/create.html's identity photo, already
  // downscaled to 768px/0.82 quality for THIS device's own use) is only
  // ever local — publish-dream.js's shared record had no avatar field at
  // all, so another visitor's device had nothing to render for a
  // published author's circle. That 768px photo is far too big to attach
  // to every published dream, though: get-feed.js's single feed-index
  // blob is downloaded whole by every visitor, and the SAME author's photo
  // would otherwise be duplicated once per published dream. This resizes
  // it down again, much further ("aggressively resized, few KB" per the
  // tracker item), purely for this cross-device thumbnail — same
  // canvas-based downscale technique as profile.html/create.html's own
  // resizeImageFile, just operating on an already-decoded data URL (no
  // FileReader step needed, there's no raw File here).
  var AVATAR_THUMB_MAX_DIM = 48;
  var AVATAR_THUMB_QUALITY = 0.55;
  function resizeDataUrlForAvatarThumb(dataUrl) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onerror = function () { reject(new Error('decode_failed')); };
      img.onload = function () {
        var scale = Math.min(1, AVATAR_THUMB_MAX_DIM / Math.max(img.width, img.height));
        var w = Math.max(1, Math.round(img.width * scale));
        var h = Math.max(1, Math.round(img.height * scale));
        var canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', AVATAR_THUMB_QUALITY));
      };
      img.src = dataUrl;
    });
  }

  // Public-profile avatar (Social Layer v2 slice 1, docs/
  // SOCIAL_LAYER_V2_DESIGN.md's own field spec: "avatarDataUrl (Me-photo
  // re-downscaled 256px JPEG via resizeImageFile)") — a THIRD size
  // alongside the Me character's own full-quality 768px photoDataUrl
  // (profile.html/create.html's identity sheet) and the tiny 48px feed
  // thumbnail immediately above. Same canvas-based downscale technique,
  // just its own max-dimension/quality tuned for a public profile page's
  // single hero avatar rather than a small feed-row circle.
  // Bio length cap (Social Layer v2 slice 1, docs/SOCIAL_LAYER_V2_DESIGN.md's
  // own field spec: "bio <=150 chars (IG parity)") — shared by
  // DreamStore.setMyBio's local validation and mirrored server-side by
  // sync-profile.js's own BIO_MAX_CHARS constant.
  var BIO_MAX_CHARS = 150;

  var PROFILE_AVATAR_MAX_DIM = 256;
  var PROFILE_AVATAR_QUALITY = 0.82;
  function resizeDataUrlForProfileAvatar(dataUrl) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onerror = function () { reject(new Error('decode_failed')); };
      img.onload = function () {
        var scale = Math.min(1, PROFILE_AVATAR_MAX_DIM / Math.max(img.width, img.height));
        var w = Math.max(1, Math.round(img.width * scale));
        var h = Math.max(1, Math.round(img.height * scale));
        var canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', PROFILE_AVATAR_QUALITY));
      };
      img.src = dataUrl;
    });
  }

  /**
   * Resolves to a 256px avatar for whoever is CURRENTLY signed in's Me
   * character, or null if there isn't one (no self character yet, a
   * describe-only self character with no photo, or logged out). Never
   * rejects — same "always resolves, callers chain a single .then()"
   * shape as currentUserAvatarThumbnail immediately below, so a decode
   * failure just degrades to "no avatar this sync" rather than blocking
   * the profile sync itself.
   */
  function currentUserProfileAvatarDataUrl() {
    var self = state.user ? myCharacterList().filter(function (c) { return c.isSelf; })[0] : null;
    if (!self || !self.photoDataUrl) return Promise.resolve(null);
    return resizeDataUrlForProfileAvatar(self.photoDataUrl).catch(function () { return null; });
  }

  /**
   * Fire-and-forget upsert of the CURRENTLY signed-in account's public
   * profile record (netlify/functions/sync-profile.js — Social Layer v2
   * slice 1). Called from two places, exactly matching the design doc's
   * "written by token-gated sync-profile.js (on Edit-profile save and on
   * first publish)": profile.html's Edit-profile save handler, and
   * publishDream() below's isNewPublish branch. Same best-effort,
   * never-blocks-the-caller posture as syncPublishedDreamToFeed — a
   * failure here just means u.html serves a stale/blank profile record
   * until the next successful sync, never a broken publish/save flow.
   *
   * displayName sources from the Me character's own name (falling back to
   * the bare handle when unset, so a profile record is never saved with a
   * genuinely empty display name); avatarDataUrl from
   * currentUserProfileAvatarDataUrl above; bio from this device's own
   * local profileBioByUser cache (see setMyBio below — always the freshest
   * value THIS device knows, since bio has no other local source of
   * truth the way name/photo do via the Me character).
   */
  function syncProfileToServer() {
    if (!state.user || !state.user.authToken) return; // no verified identity to sync under -- see this file's other authToken-gated call sites' identical degrade
    var handle = state.user.handle;
    var self = myCharacterList().filter(function (c) { return c.isSelf; })[0] || null;
    var displayName = (self && self.name) ? self.name : (typeof handle === 'string' ? handle.replace(/^@/, '') : '');
    currentUserProfileAvatarDataUrl().then(function (avatarDataUrl) {
      fetch('/.netlify/functions/sync-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          authToken: state.user.authToken,
          handle: handle,
          displayName: displayName,
          avatarDataUrl: avatarDataUrl,
          bio: state.profileBioByUser[state.user.username.toLowerCase()] || ''
        })
      }).catch(function () { /* best-effort — see comment above */ });
    });
  }

  /**
   * Resolves to a tiny avatar thumbnail for whoever is CURRENTLY signed
   * in's Me character, or null if there isn't one to send (no self
   * character yet, a describe-only self character with no photo, or
   * logged out). Never rejects — same "always resolves, callers chain a
   * single .then()" shape as this file's generateAvatarFromDescription-
   * style helpers, so a decode failure just degrades to "no avatar this
   * sync" rather than blocking the publish sync itself.
   */
  function currentUserAvatarThumbnail() {
    var self = state.user ? myCharacterList().filter(function (c) { return c.isSelf; })[0] : null;
    if (!self || !self.photoDataUrl) return Promise.resolve(null);
    return resizeDataUrlForAvatarThumb(self.photoDataUrl).catch(function () { return null; });
  }

  /**
   * Adds the local, per-viewer mine/likedByMe/blockedByMe flags to a raw
   * array of shared-feed dream records — shared by getSharedFeed's own GET
   * and by DreamStore.decorateFeedDreams (for callers with a raw dream
   * array from a different endpoint, e.g. get-profile.js). See
   * getSharedFeed's own doc comment for what each flag means and why none
   * of them live on the shared record itself.
   */
  function decorateFeedDreams(dreams) {
    var likedIds = state.likedIds || {};
    var blockedHandles = currentBlockedMap() || {};
    var myHandle = state.user ? state.user.handle : null;
    return (dreams || []).map(function (d) {
      return Object.assign({}, d, {
        likedByMe: !!likedIds[d.id],
        mine: !!myHandle && d.ownerHandle === myHandle,
        blockedByMe: !!blockedHandles[d.ownerHandle]
      });
    });
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
    // Avatar thumbnail generation is itself async (canvas decode) — resolve
    // it first, then send the same upsert as before either way. See
    // currentUserAvatarThumbnail's own doc comment for why this never
    // rejects (a decode failure just means `avatar: null` goes out, same
    // as having no Me photo at all).
    currentUserAvatarThumbnail().then(function (avatar) {
      fetch('/.netlify/functions/publish-dream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: dream.id, ownerHandle: dream.ownerHandle, caption: dream.caption,
          style: dream.style, dur: dream.dur, videoUrl: dream.videoUrl,
          imageUrl: dream.imageUrl, mediaType: dream.mediaType || 'video',
          avatar: avatar,
          // createdAt (tracker item for-product-media-library-stamp-durable--
          // u4oju3) — this dream's real generation-time timestamp (stamped
          // once, at finalizeDream, see that assignment's own doc comment),
          // carried into the SHARED feed-index record so the owner media-
          // library page has a genuine "when was this actually made" value
          // instead of only ever approximating with publishedAt (which can be
          // well after actual generation if a dream sits unpublished for a
          // while — see publish-dream.js's own header comment on that
          // imprecision). Only ever sent as a real finite number or null —
          // never fabricated for a dream that predates this field (see
          // js/store.js's createdAt assignment comment on why a missing
          // value stays missing rather than getting a guessed one).
          createdAt: (typeof dream.createdAt === 'number' && isFinite(dream.createdAt)) ? dream.createdAt : null,
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
          // mood (tracker item for-product-founder-08-04-evening-music--
          // jfjco0) — carried into the SHARED feed-index record, not just
          // this browser's local copy, for the same reason
          // caption/style/mediaType already are: explore.html builds its
          // cards entirely from the feed record, so a mood that never
          // reaches it can never influence that surface's music bed. Absent
          // on anything published before this shipped, which publish-dream.js
          // stores as null — the documented "fall back to the style bed"
          // state, identical to what those cards already do today.
          mood: dream.mood || null,
          // musicBedOn field removed from this payload (tracker item
          // for-product-build-founder-approved-08-03-jlkjy9, 2026-08-03
          // founder simplification) — js/music-bed.js's eligible() no
          // longer reads it at all (see that file's header comment), so
          // there is nothing meaningful left to carry into the shared
          // feed-index record; a published dream's music bed is now
          // computed purely from its own videoUrl/style, same on
          // explore.html as on result.html.
          authToken: (state.user && state.user.authToken) || null
        })
      }).catch(function () { /* best-effort — see comment above */ });
    });
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

  // ---------------------------------------------------------------------
  // Private-dream server sync (tracker item
  // for-product-build-p0-server-side-dream-p-zl3rb2) — dream-sync.js +
  // lib/dream-store.js. Closes the gap this file's OWN header comment used
  // to document as explicitly deferred: a PRIVATE (never-published, or
  // unpublished-again) dream previously lived ONLY in this browser's
  // localStorage — permanently lost the moment that storage is
  // cleared/evicted, which happens routinely for real users opening this
  // app inside Facebook/Instagram's in-app webview (this app's biggest
  // acquisition channel — see the webview-detection code elsewhere in this
  // file). PUBLISHED dreams already have a durable server-side copy (the
  // shared feed-index, see syncPublishedDreamToFeed above) and are
  // deliberately NOT duplicated here — see dream-sync.js's own header
  // comment.
  //
  // Reuses the SAME `state.user.authToken` block-user's own sync above
  // already mints/threads through login()/signup() — this is deliberately
  // NOT a second token/identity mechanism, since lib/account-auth-token.js
  // is already a general-purpose "verified identity, not a bare
  // client-claimed username" primitive (see that file's own "NOT a general
  // session-replacement... expand its use deliberately" header comment) —
  // dream-sync.js is simply its second consumer.
  //
  // Same "local effect always applies immediately, server sync is
  // fire-and-forget/best-effort, degrades gracefully if it fails" contract
  // every call site in this section follows (mirrors blockUser/unblockUser/
  // syncBlockedHandlesFromServer's own contract exactly) — none of these
  // ever throw, block, or surface an error to the caller; a failure just
  // means this device's private-dream server copy is one sync behind, same
  // as a failed syncPublishedDreamToFeed call leaves the shared feed one
  // sync behind. Every entry point also no-ops silently — before ever
  // touching the network — when either PRIVATE_DREAM_SYNC_ENABLED is off
  // (the staged-rollout kill switch, see that flag's own comment) or
  // `state.user.authToken` isn't on file (not signed in via a real
  // server-verified login/signup this session — see commitLocalSignup's
  // own doc comment for exactly which flows mint a real token and which
  // deliberately don't).

  /**
   * Fire-and-forget upsert of one PRIVATE dream into this account's
   * server-side dream-sync record. Called from every local mutation site
   * that creates/changes a dream while it's NOT currently published
   * (finalizeDream, saveClaimedDream, unpublishDream, generateInterpretation
   * — see each call site's own comment). Never called for a published
   * dream — its durable copy is the shared feed instead (see header
   * comment above), and dream-sync.js's own server-side sanitization would
   * force isPublished back to false regardless, so calling this for one
   * would be actively misleading about what's actually being persisted.
   *
   * CONFIRMATION + RETRY (tracker item
   * for-product-p0-data-loss-founder-repro-0-6bzvv1 — a real, token-
   * charged generation, confirmed by its own PostHog video_created event,
   * completed and was written to local state but never reached the
   * server-side dream-sync store at all, so a fresh device/browser never
   * saw it). Before this fix, this function was pure fire-and-forget with
   * no retry and no way to tell later whether the write had actually
   * landed — the ONLY thing that ever retried a failed private-dream sync
   * was reconcilePrivateDreamsFromServer's own login-only catch-up push
   * (see that function's own doc comment), which never fires again for an
   * account that doesn't happen to log out and back in. Two concrete
   * gaps that both produce exactly this symptom, neither requiring the
   * other:
   *   (a) `state.user.authToken` can legitimately be null even for an
   *       existing, real, already-"signed in" account — see
   *       attemptLocalLogin's own doc comment for the local-only-fallback
   *       path that produces exactly that (a transient moment where the
   *       real server-side login couldn't be reached). This function
   *       already correctly no-ops rather than pretending to sync in
   *       that case — but pre-fix, a dream created during that window
   *       stayed permanently unsynced even after the account's session
   *       eventually regained a real authToken (nothing ever revisited
   *       it, since no NEW login necessarily follows just because a
   *       token quietly reappears).
   *   (b) A genuine transient failure (a dropped connection, a real
   *       server-side 5xx from dream-sync.js's own E8 sync_write_failed)
   *       used to be swallowed by a bare `.catch()` that didn't even
   *       inspect the response status — a real synchronous 500 was
   *       treated exactly like a full success from this function's point
   *       of view.
   * `dream.syncConfirmed` (local-only bookkeeping — deliberately never
   * sent to the server, see the fixed field whitelist below) tracks
   * whether THIS dream's server-side copy has actually been confirmed
   * written. Stamped `false` up front on every call (including ones this
   * function itself immediately no-ops on below) so
   * retryUnconfirmedPrivateDreamSyncs — called on every ordinary page
   * load, see its own doc comment — has something durable to retry later,
   * regardless of why this particular attempt didn't confirm. Only ever
   * flipped to `true` once a real 200 ok:true response is actually
   * observed.
   */
  function syncPrivateDreamBestEffort(dream) {
    if (!dream || dream.isPublished) return;
    dream.syncConfirmed = false;
    persist();
    if (!PRIVATE_DREAM_SYNC_ENABLED) return;
    if (!state.user || !state.user.authToken) return;
    attemptPrivateDreamSync(dream, 0);
  }

  // Retry-with-backoff budget for confirming ONE dream's server-side sync
  // while a page stays open. Originally just [800, 2500] (three attempts,
  // all within ~3.3s). Extended (tracker item for-product-track-avg-video-
  // generation-t-2ci8ue / E304 dream_sync_unconfirmed investigation): the
  // three-attempt/3.3s burst gave up server-side persistence for the whole
  // page load after only ~3 seconds, then relied ENTIRELY on
  // retryUnconfirmedPrivateDreamSyncs running on a LATER page load to
  // recover. That recovery model is exactly wrong for this codebase's
  // single biggest cohort — FB/IG in-app-webview users (see
  // lib/dream-store.js's own header comment), whose localStorage is wiped
  // BETWEEN sessions and who routinely do one short session: if dream-sync
  // is failing (a real transient E8/5xx, a proxy 502, a dropped
  // connection) for the ~3.3s of that burst, and they close the webview
  // before any later page load, the just-generated dream is written to a
  // localStorage that gets wiped and never reached the server — a silent
  // vanish (the observable E304 shape). Keeping the same first two fast
  // attempts (a momentary blip still confirms in well under a second) but
  // adding a few longer-spaced ones lets an OPEN page ride out a much
  // longer transient window within the single session the user actually
  // gives us — home.html while the dream generates, then result.html while
  // they watch it — so it confirms properly (flips syncConfirmed, stops
  // re-firing E304) instead of banking on a second visit that a wiped-
  // storage webview user may never make. Still bounded and still gives up
  // eventually (firing E304 for a genuinely stuck sync), just over ~76s of
  // an open page rather than ~3s. Belt-and-suspenders: a pagehide/hidden
  // beacon flush (see flushUnconfirmedPrivateDreamsBeacon below) is the
  // final last-chance push as the tab actually goes away.
  var PRIVATE_DREAM_SYNC_RETRY_DELAYS_MS = [800, 2500, 8000, 20000, 45000];

  // The exact upsert payload dream-sync.js persists off a client-supplied
  // `dream` — an explicit, hand-maintained whitelist (dream-sync.js's own
  // DREAM_FIELDS mirrors it server-side; a new dream field is NOT carried
  // automatically and omitting one fails silently, so both halves must be
  // kept in sync). Extracted so the retrying fetch path
  // (attemptPrivateDreamSync) and the pagehide beacon flush
  // (flushUnconfirmedPrivateDreamsBeacon) build byte-identical bodies from
  // one place rather than drifting apart.
  //   createdAt — HAS been carried since finalizeDream stamped it, but was
  //     once dropped here, so the owner media-library page (server-records
  //     only) saw every synced dream as timeless; sent as a real finite
  //     number or null, never fabricated (tracker for-product-media-
  //     library-stamp-durable--u4oju3).
  //   mood — the dream-builder Mood step answer js/music-bed.js keys the
  //     ambient bed off; without it a dream RESTORED onto a new device or
  //     after a webview storage wipe (the whole reason this sync exists)
  //     comes back moodless and falls back to its visual-style bed (tracker
  //     for-product-founder-08-04-evening-music--jfjco0).
  function buildDreamSyncUpsertBody(dream, authToken) {
    return {
      authToken: authToken,
      action: 'upsert',
      dream: {
        id: dream.id, ownerHandle: dream.ownerHandle,
        caption: dream.caption, promptText: dream.promptText || null, storyText: dream.storyText || null,
        style: dream.style, mediaType: dream.mediaType || 'video',
        videoUrl: dream.videoUrl || null, imageUrl: dream.imageUrl || null, dur: dream.dur || null,
        sourceOperationName: dream.sourceOperationName || null,
        interpretationText: dream.interpretationText || null, interpretationAt: dream.interpretationAt || null,
        createdAt: (typeof dream.createdAt === 'number' && isFinite(dream.createdAt)) ? dream.createdAt : null,
        mood: dream.mood || null,
        updatedAt: dream.updatedAt || Date.now()
      }
    };
  }

  function attemptPrivateDreamSync(dream, attemptIndex) {
    var authToken = state.user && state.user.authToken;
    if (!authToken) return; // lost its token between attempts (e.g. logout) — nothing to sync against right now
    fetch('/.netlify/functions/dream-sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildDreamSyncUpsertBody(dream, authToken))
    }).then(function (res) {
      return res.json().then(function (data) { return res.ok && !!(data && data.ok); }, function () { return false; });
    }).then(function (confirmed) {
      if (confirmed) {
        dream.syncConfirmed = true;
        persist();
        return;
      }
      scheduleRetryOrGiveUp();
    }, function () { scheduleRetryOrGiveUp(); });

    function scheduleRetryOrGiveUp() {
      if (attemptIndex < PRIVATE_DREAM_SYNC_RETRY_DELAYS_MS.length) {
        setTimeout(function () { attemptPrivateDreamSync(dream, attemptIndex + 1); }, PRIVATE_DREAM_SYNC_RETRY_DELAYS_MS[attemptIndex]);
      } else {
        // 'generation_failed' reason:'E304: dream_sync_unconfirmed' (tracker
        // item for-product-track-avg-video-generation-t-2ci8ue) — the
        // OBSERVE-only half of this build: this is the exact shape of the
        // P0 data-loss "vanish" bug (for-product-p0-data-loss-founder-
        // repro-0-6bzvv1, fix merged as commit 7b7828c) — a real, already-
        // finished generation whose local dream record still has no
        // confirmed server-side copy after this function's own full local
        // retry budget (PRIVATE_DREAM_SYNC_RETRY_DELAYS_MS) is exhausted.
        // Fires here, not in startGeneration's own .catch above, because
        // this failure never rejects that promise at all — the generation
        // itself succeeded; only ITS SYNC failed. Deliberately re-fires
        // every time this gives up again for the same still-unconfirmed
        // dream (e.g. retryUnconfirmedPrivateDreamSyncs sweeping it again
        // on a later page load) — each occurrence is a real, continued
        // instance of the shape being observed, not a one-time flag; see
        // this file's own E304 doc comment near the top for the full
        // reasoning, including why elapsed_ms is measured from the dream's
        // createdAt rather than this retry burst's own (much shorter) span.
        trackAnalytics('generation_failed', {
          reason: 'E304: dream_sync_unconfirmed',
          mediaType: dream.mediaType || 'video',
          elapsed_ms: dream.createdAt ? (Date.now() - dream.createdAt) : null,
          model: dream.modelUsed || null,
          // dreamId (review finding, tracker for-product-track-avg-video-
          // generation-t-2ci8ue): this event deliberately re-fires every
          // time this function's retry budget exhausts again for the SAME
          // still-unconfirmed dream (see the doc comment above) -- without
          // a stable per-dream key, raw PostHog event volume can't tell
          // "1 dream vanished, observed 10 times" from "10 dreams each
          // vanished once", which corrupts the exact "true vanish rate"
          // this instrumentation exists to produce. dream.id is already
          // sent to the server elsewhere (e.g. publish-dream's own payload),
          // so this adds no new exposure.
          dreamId: dream.id || null
        });
      }
    }
  }

  /**
   * Sweeps this account's local private dreams for any whose server-side
   * dream-sync copy was never confirmed (see syncPrivateDreamBestEffort's
   * own syncConfirmed doc comment) and retries each — tracker item
   * for-product-p0-data-loss-founder-repro-0-6bzvv1. Called once on every
   * ordinary page load (see the bottom of this file, right where
   * backfillSharedFeed's identical-shape one-time catch-up already runs)
   * — deliberately NOT gated behind a fresh login/signup the way
   * reconcilePrivateDreamsFromServer's own catch-up push is, since an
   * already-"signed in" session that fell into a temporarily authToken-
   * less state (see attemptLocalLogin's own doc comment) has no natural
   * reason to ever log out and back in again just because its token quietly
   * came back — this closes that gap directly, with no login required.
   * Deliberately skips the GET/compare round trip reconcile does first —
   * dream-sync.js's own upsert is idempotent by id, so redundantly
   * re-pushing an already-server-side dream is a harmless no-op, which
   * keeps this cheap enough to run unconditionally on every load rather
   * than needing its own one-time-ever gate the way backfillSharedFeed
   * does.
   */
  function retryUnconfirmedPrivateDreamSyncs() {
    if (!PRIVATE_DREAM_SYNC_ENABLED) return;
    if (!state.user || !state.user.authToken) return;
    var myHandle = state.user.handle;
    state.dreams.forEach(function (d) {
      if (d.ownerHandle === myHandle && !d.isPublished && d.syncConfirmed !== true) {
        syncPrivateDreamBestEffort(d);
      }
    });
  }

  /**
   * Last-chance flush of every still-unconfirmed private dream to the
   * server as this page is actually going away — fired from `pagehide` and
   * `visibilitychange`→hidden (see the wiring near this file's init). The
   * E304 dream_sync_unconfirmed / P0-vanish investigation (tracker item
   * for-product-p0-data-loss-founder-repro-0-6bzvv1) confirmed the residual
   * loss shape: the fetch-based retry above only recovers a sync that keeps
   * failing by running again on a LATER page load
   * (retryUnconfirmedPrivateDreamSyncs) — but this app's single biggest
   * cohort is FB/IG in-app-webview users (see lib/dream-store.js's header)
   * whose localStorage is wiped BETWEEN sessions and who often do exactly
   * one short session. If dream-sync was failing for the whole time their
   * page(s) were open and they then close the webview, that later page load
   * never happens before the wipe, and the dream is gone.
   *
   * `navigator.sendBeacon` is the correct tool here specifically because a
   * normal `fetch` started during unload/hide is routinely cancelled by the
   * browser, whereas a beacon is guaranteed-delivery, queued by the browser
   * to complete even after the page is gone. It is fire-and-forget by
   * design — there is no response to read — so this deliberately does NOT
   * flip `dream.syncConfirmed` (only a real observed 200/ok does that, see
   * attemptPrivateDreamSync); its whole job is to get the dream's DATA onto
   * the server so it can be pulled back by reconcilePrivateDreamsFromServer
   * on any future load/device, NOT to confirm. dream-sync.js parses
   * event.body as JSON, so the beacon is sent as an application/json Blob
   * carrying the exact same upsert body the fetch path builds
   * (buildDreamSyncUpsertBody). Idempotent by dream id server-side, so
   * beaconing a dream that a still-in-flight fetch also lands is a harmless
   * double-write, never a corruption. Purely additive insurance on top of
   * the retry/​sweep above — it changes none of their behavior.
   */
  function flushUnconfirmedPrivateDreamsBeacon() {
    if (!PRIVATE_DREAM_SYNC_ENABLED) return;
    if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') return;
    if (!state.user || !state.user.authToken) return;
    var authToken = state.user.authToken;
    var myHandle = state.user.handle;
    state.dreams.forEach(function (d) {
      if (d.ownerHandle === myHandle && !d.isPublished && d.syncConfirmed !== true) {
        try {
          var body = new Blob([JSON.stringify(buildDreamSyncUpsertBody(d, authToken))], { type: 'application/json' });
          navigator.sendBeacon('/.netlify/functions/dream-sync', body);
        } catch (e) { /* best-effort last chance — must never throw during unload */ }
      }
    });
  }

  /**
   * Fire-and-forget removal of one dream from this account's server-side
   * dream-sync record. Called both when a private dream is actually
   * DELETED (deleteDream), and when one is PUBLISHED (publishDream) — a
   * published dream's durable copy is the shared feed from that point on,
   * so it no longer belongs in this store either (see header comment
   * above). Safe/idempotent to call for a dream that was never synced
   * here in the first place — dream-sync.js's own removePrivateDream is a
   * no-op in that case, not an error.
   */
  function deletePrivateDreamBestEffort(dreamId) {
    if (!PRIVATE_DREAM_SYNC_ENABLED) return;
    if (!state.user || !state.user.authToken) return;
    fetch('/.netlify/functions/dream-sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authToken: state.user.authToken, action: 'delete', dreamId: dreamId })
    }).catch(function () { /* best-effort — see section comment above */ });
  }

  /**
   * Reconciles this account's LOCAL private dreams with its server-side
   * dream-sync record — called once right after every real server-verified
   * login/signup (see each call site's own comment). Returns a Promise that
   * always resolves (never rejects — see the .catch below), so a caller
   * that needs the merge to actually have landed in localStorage before
   * doing anything else (a redirect, most importantly — see tracker item
   * for-product-urgent-founder-family-repro--nsbbg5) can chain onto it. A
   * failure here (offline, functions runtime unreachable) leaves this
   * device's local dreams exactly as they already were — never worse off,
   * just not yet caught up with whatever another device may have synced.
   *
   * NAVIGATION-RACE NOTE (nsbbg5 root cause): this used to be called
   * fire-and-forget (no `return` on the fetch chain below) from login()'s
   * success branch, with login.html's own click handler doing
   * `DreamStore.login(...).then(() => location.href = nextUrl)` right
   * after. On a real network (not a same-tick mock), that `location.href`
   * assignment starts unloading the current document — and an in-flight
   * `fetch()` initiated by a document that's being unloaded gets aborted,
   * so this function's own `.then()` (the part that actually merges
   * server dreams into `state.dreams` and calls `persist()`) never ran.
   * Confirmed by reproduction: driving login.html's real reset-password UI
   * end-to-end with a ~400ms-delayed dream-sync response landed on
   * home.html with the restored dream completely absent from
   * localStorage, even though the GET request itself had gone out. This
   * reproduced identically for a plain (non-reset) login too — it's a
   * property of ANY caller that redirects immediately after login()
   * resolves, not something specific to the password-reset flow; reset
   * just happens to be the scenario where a restore is most likely to
   * both be needed (a fresh/wiped device) AND get raced (the reset form's
   * own two chained network round trips before this one only make the
   * timing worse). Fixed at the source: login()'s success branch now
   * returns this function's promise (chained, not fire-and-forget), so
   * its own caller's `.then()` — including login.html's redirect for
   * BOTH the ordinary and the post-reset login path, since both funnel
   * through this same login() function — never fires until the merge (or
   * its failure) has actually settled.
   *
   * MERGE, NOT CLOBBER (tracker item's own explicit instruction — a device
   * with newer local edits must not lose them to a stale server copy, and
   * vice versa) — per dream id, scoped to this account's own dreams only:
   *   - Missing locally entirely: this device lost it (webview wipe) or
   *     never had it (a different device created/synced it first) —
   *     restore it from the server copy. This is the actual data-loss fix
   *     this whole feature exists for.
   *   - Present locally AND already published: left alone completely,
   *     regardless of what the server-side dream-sync record says — a
   *     published dream's durable copy is the shared feed (see header
   *     comment above), and this device's local isPublished:true is
   *     already the authoritative truth; a stale dream-sync record here
   *     (e.g. publishDream's own best-effort delete-from-dream-sync call
   *     failed on a flaky connection) must never un-publish anything by
   *     silently overwriting it.
   *   - Present locally, NOT published, and the server's `updatedAt` is
   *     newer: the server has a newer edit (made from a different
   *     device) — take it.
   *   - Present locally, NOT published, and THIS device's `updatedAt` is
   *     newer (or the server's copy is missing `updatedAt` at all, i.e.
   *     older than this field existed): this device's edit hasn't reached
   *     the server yet (e.g. made while offline) — re-push it, rather
   *     than silently leaving the server-side copy stale.
   *
   * Deliberately NEVER deletes a local dream just because the server
   * doesn't have a copy of it — there is no delete-tombstone mechanism
   * here (this store has no concept of "deleted at", only "present" or
   * "absent"), so treating "absent server-side" as "delete it locally"
   * would risk destroying a dream a user still wants the moment they log
   * in on a second device that simply hasn't synced it yet. The accepted
   * tradeoff (see this feature's own build report): a dream deleted on
   * device A does not automatically vanish from device B's local cache
   * until B also explicitly deletes it — a known, narrow limitation, far
   * preferable to the alternative of a merge that can silently destroy
   * data. Any local-only private dream the server doesn't know about yet
   * (e.g. created entirely offline) is pushed up as a catch-up sync,
   * exactly like the newer-locally branch above.
   */
  function reconcilePrivateDreamsFromServer() {
    if (!PRIVATE_DREAM_SYNC_ENABLED) return Promise.resolve();
    if (!state.user || !state.user.authToken) return Promise.resolve();
    var myHandle = state.user.handle;
    var authToken = state.user.authToken;
    return fetch('/.netlify/functions/dream-sync?authToken=' + encodeURIComponent(authToken))
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data || data.ok !== true || !Array.isArray(data.dreams)) return;

        var localById = {};
        state.dreams.forEach(function (d) {
          if (d.ownerHandle === myHandle) localById[d.id] = d;
        });

        var changed = false;
        var serverIds = {};
        data.dreams.forEach(function (serverDream) {
          serverIds[serverDream.id] = true;
          var local = localById[serverDream.id];
          if (!local) {
            state.dreams.push(serverDream);
            localById[serverDream.id] = serverDream;
            changed = true;
            return;
          }
          if (local.isPublished) return; // local already authoritative — see doc comment
          var localUpdatedAt = local.updatedAt || 0;
          var serverUpdatedAt = serverDream.updatedAt || 0;
          if (serverUpdatedAt > localUpdatedAt) {
            Object.assign(local, serverDream);
            changed = true;
          } else if (localUpdatedAt > serverUpdatedAt) {
            syncPrivateDreamBestEffort(local);
          }
        });

        // Catch-up: any private dream this device has that the server
        // doesn't know about at all yet (e.g. created while offline).
        state.dreams.forEach(function (d) {
          if (d.ownerHandle === myHandle && !d.isPublished && !serverIds[d.id]) {
            syncPrivateDreamBestEffort(d);
          }
        });

        if (changed) persist();
      })
      .catch(function () { /* best-effort — local state already fully usable, see section comment above */ });
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

  // Speaking Sage Option D's own poll budget — deliberately smaller than
  // video/image's MAX_POLL_MS: this is a short voice clip plus a caption-
  // alignment pass over it, not a multi-minute video render, so waiting
  // this long already means something is genuinely stuck.
  var INTERP_AUDIO_MAX_POLL_MS = 3 * 60 * 1000;

  /**
   * Polls interp-audio-status.js to completion, following whichever
   * `operationName` each response hands back (see that file's own header
   * comment — the caption-alignment chain hands off a NEW operationName
   * mid-flight once the TTS stage completes; this loop always polls
   * whatever name it was told to use most recently, never assumes the
   * name is static across the whole job the way pollUntilDone's video/
   * image jobs can). Resolves `{ audioUrl, audioDurationMs, captions,
   * captionsLevel }` on `status:'done'`, rejects on `status:'failed'` or a
   * sustained network failure, same "ENNN: reason" Error convention as
   * pollUntilDone above.
   */
  function pollInterpAudioUntilDone(operationName) {
    return new Promise(function (resolve, reject) {
      var startedAt = Date.now();
      var currentName = operationName;
      function poll() {
        if (Date.now() - startedAt > INTERP_AUDIO_MAX_POLL_MS) { reject(new Error('E506: tts_request_failed: timed_out')); return; }
        fetch('/.netlify/functions/interp-audio-status?name=' + encodeURIComponent(currentName))
          .then(function (res) { return res.json(); })
          .then(function (data) {
            if (data.status === 'failed') { reject(new Error(data.error || 'E506: tts_request_failed')); return; }
            if (data.status === 'done') {
              resolve({
                audioUrl: data.audioUrl,
                audioDurationMs: typeof data.audioDurationMs === 'number' ? data.audioDurationMs : null,
                captions: Array.isArray(data.captions) ? data.captions : [],
                captionsLevel: data.captionsLevel === 'word' ? 'word' : 'sentence'
              });
              return;
            }
            if (data.operationName) currentName = data.operationName;
            setTimeout(poll, POLL_INTERVAL_MS);
          })
          .catch(function (err) {
            reject(new Error('network_error_during_interp_audio_status_check' + (err && err.message ? ': ' + err.message : '')));
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

  // ===== Edit-mechanism model rotation (docs/EDIT_MECHANISM_SPEC.md §2/§3.4,
  // tracker item for-product-new-edit-mechanism-founder-i-qmsdgj) =====
  // Same fixed string literals generate-video.js's MODEL_KEY_VEO_LITE/
  // MODEL_KEY_PIXVERSE_V6 use — kept as plain, independent duplicates here
  // (this is a static multi-page site with no shared JS bundle between
  // netlify/functions and js/store.js) rather than a shared constants file,
  // matching this codebase's established per-file-owns-its-own-copy
  // convention for exactly this kind of small, stable literal (see e.g.
  // create.html's own copy of processing.html's detectInAppHost() trio).
  var MODEL_KEY_VEO_LITE = 'veo3.1-lite';
  var MODEL_KEY_PIXVERSE_V6 = 'pixverse-v6';

  /**
   * Picks which rotation-eligible model an EDIT of `dream` should route to
   * — docs/EDIT_MECHANISM_SPEC.md §2's rotation rule, verbatim:
   *   - Anime-style override: style === 'Anime' always routes to
   *     pixverse-v6, regardless of the dream's current modelUsed (flagged
   *     in the spec as an untested hypothesis worth watching via
   *     instrumentation, not a verified fact — built as specified anyway,
   *     per the founder's explicit approval).
   *   - Otherwise, alternate: veo3.1-lite -> pixverse-v6, pixverse-v6 ->
   *     veo3.1-lite, so a dream edited twice ping-pongs and never repeats
   *     the model it just tried.
   *   - A dream with no modelUsed yet (null/undefined — a legacy dream
   *     from before this field existed, or a dream whose only prior
   *     generation was one of the out-of-rotation-scope self-photo/
   *     turn-into-video paths) alternates away from veo3.1-lite, the
   *     implicit historical default every dream used before PixVerse
   *     existed at all — same reasoning the spec itself gives for this
   *     exact case.
   * Pure function — takes no action itself, callers (startDreamEdit below)
   * decide what to do with the result. Never called for a FRESH/non-edit
   * generation — those always default to generate-video.js's own
   * veo3.1-lite path (no requestedModel sent at all).
   */
  function pickEditModel(dream) {
    if (!dream) return MODEL_KEY_PIXVERSE_V6;
    if (dream.style === 'Anime') return MODEL_KEY_PIXVERSE_V6;
    if (dream.modelUsed === MODEL_KEY_PIXVERSE_V6) return MODEL_KEY_VEO_LITE;
    return MODEL_KEY_PIXVERSE_V6;
  }

  /**
   * Calls realign-dream-prompt.js to merge a user's plain-text edit delta
   * into a dream's existing promptText/storyText (docs/EDIT_MECHANISM_SPEC.md
   * §3.4) — result.html's new edit sheet's step between "submit a delta" and
   * Direction B's confirm-before-generate screen.
   *
   * NEVER rejects: a network failure, a non-200, or a malformed response
   * (that function's own E7xx errors, or fetch throwing outright) all fall
   * back to a naive concatenation merge — spec §3.3's "Realignment LLM
   * failure" edge case: "Fall back to naive concatenation merge... rather
   * than blocking the user... log a silent-skip telemetry event. No token
   * charged yet at this point." — so the caller can always advance to the
   * confirm screen once this resolves, with no separate error branch to
   * build. Resolves `{ promptText, storyText, realigned }` — realigned:false
   * means the fallback path was used.
   *
   * No raw delta text is ever included in the fallback-telemetry event —
   * same "never the raw text, only what's needed" rule as edit_submitted's
   * own deltaLength-only property (docs/EVENT_TAXONOMY.md).
   */
  function realignDreamPrompt(promptText, storyText, deltaText) {
    return fetch('/.netlify/functions/realign-dream-prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ promptText: promptText, storyText: storyText, deltaText: deltaText })
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok || !data || typeof data.promptText !== 'string' || typeof data.storyText !== 'string') {
          throw new Error((data && data.error) || 'realign_failed');
        }
        return { promptText: data.promptText, storyText: data.storyText, realigned: true };
      });
    }).catch(function (err) {
      trackAnalytics('edit_realign_fallback', {
        reason: (err && err.message) ? String(err.message).slice(0, 60) : 'unknown'
      });
      return {
        promptText: promptText + '. ' + deltaText,
        storyText: storyText + ' ' + deltaText,
        realigned: false
      };
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
   *
   * extra (optional 8th arg, docs/EDIT_MECHANISM_SPEC.md §3.4 — tracker
   * item for-product-new-edit-mechanism-founder-i-qmsdgj) — `{ modelUsed,
   * editHistoryEntry }`, both optional:
   *   - modelUsed: "veo3.1-lite" | "pixverse-v6" | null — whichever
   *     rotation-eligible model generate-video.js actually used (see that
   *     file's own `modelUsed` response field), or null for a mediaType
   *     other than 'video', or for the self-photo reference-to-video /
   *     "turn this into a video" image-to-video paths, which are
   *     explicitly out of rotation scope this wave (spec §3.6) — those
   *     never change a dream's existing modelUsed, so on a REGENERATE
   *     (sourceDreamId branch) a null modelUsed here means "keep whatever
   *     this dream already had," never "erase it." A brand-new dream
   *     (no sourceDreamId) simply gets whatever came back, null included
   *     — there's no prior value to preserve.
   *   - editHistoryEntry: `{ deltaLength, timestamp }` — only ever present
   *     when this completion came from the NEW edit-delta mechanism
   *     (result.html's "What would you like to change?" sheet, via
   *     DreamStore.startDreamEdit below) — appended (with modelUsed
   *     folded in) onto the dream's own lightweight `editHistory` array.
   *     No raw delta text is ever stored here or anywhere server-side,
   *     per the spec's explicit "no raw delta text stored beyond what's
   *     needed to power the LLM call in-flight" — only its length.
   *     Never applies to a brand-new dream (no sourceDreamId) — there is
   *     no dream to have an edit history yet.
   *   - musicBedOn no longer accepted/set here (tracker item for-product-
   *     build-founder-approved-08-03-jlkjy9, 2026-08-03 founder
   *     simplification — "no user choice"). Music-bed eligibility is now
   *     computed purely from a dream's own videoUrl/style at watch time
   *     (js/music-bed.js's eligible()), so there is nothing left for this
   *     function to read from `extra` or write onto the dream record.
   */
  function finalizeDream(mediaUrl, caption, style, sourceDreamId, mediaType, operationName, storyText, extra) {
    mediaType = mediaType === 'image' ? 'image' : 'video';
    var resolvedStoryText = (storyText && storyText.trim()) ? storyText.trim() : caption;
    var extraModelUsed = (extra && typeof extra.modelUsed !== 'undefined') ? extra.modelUsed : null;
    // mood (tracker item for-product-founder-08-04-evening-music--jfjco0) —
    // the wizard's Mood step answer, stamped onto the dream so
    // js/music-bed.js can pick a mood-keyed bed at playback time. null means
    // "no usable mood" (skipped, free-text "+ Something else", or a creation
    // path with no mood step at all — Write it / Record it / claim-dream),
    // which is a first-class, permanently-supported state, not a gap to
    // backfill: it falls back to the visual-style bed exactly as today.
    var extraMood = (extra && extra.mood) || null;
    // durationMs (tracker item for-product-track-avg-video-generation-t-
    // 2ci8ue) — startGeneration's own hoisted `startedAt`, threaded
    // through via `extra` (see that function's finalizeDream call site).
    // null for any caller that doesn't pass one (there is none today — the
    // sole call site always does — but this stays honest rather than
    // fabricating a number the way every other forward-only field in this
    // function already does, e.g. createdAt/modelUsed above).
    var durationMs = (extra && typeof extra.startedAt === 'number') ? (Date.now() - extra.startedAt) : null;
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
      // Idempotent-redundant-completion guard (tracker item for-product-
      // bug-founder-repro-high-edit--i2yzqo) — isPendingJobStillCurrent's
      // own fix (see that function's doc comment) now correctly lets a
      // completion through even when pendingJob was already cleared by a
      // CONCURRENT resumer of this EXACT SAME operationName (two page
      // contexts alive at once — e.g. an earlier tab bfcache-preserved or
      // simply left open, both auto-resuming the same in-flight job). That
      // fix makes it possible for finalizeDream to legitimately be called
      // TWICE for the same completed job. If this dream was already
      // patched by THIS exact operationName (not a different, genuinely
      // newer one), don't re-mutate/re-clear/re-sync/re-fire analytics a
      // second time for what is, from this dream's point of view, a no-op
      // — just hand back the dream exactly as it already stands so the
      // CALLER's own render()/toast still fires (this is what actually
      // resolves the founder's reported stuck-on-the-old-video symptom —
      // the caller previously received `null` here and silently gave up).
      if (operationName && dream.sourceOperationName === operationName) {
        return dream;
      }
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
      // modelUsed: preserve the dream's existing value when this completion
      // didn't come back with one of its own (the reference-to-video/
      // image-to-video paths, or mediaType:'image') — see this function's
      // own doc comment above for why null here means "unchanged," not
      // "erase it."
      var patch = {
        caption: resolvedStoryText, promptText: caption, storyText: resolvedStoryText,
        style: style, mediaType: mediaType, interpretationText: null, interpretationAt: null,
        interpretations: null, sourceOperationName: operationName || null,
        modelUsed: extraModelUsed || dream.modelUsed || null,
        // mood: preserve whatever this dream already had whenever THIS
        // completion didn't carry one of its own — exactly the same
        // "null here means unchanged, not erase it" rule as modelUsed
        // directly above. Regenerate/Try Again/Edit Dream have no mood
        // picker of their own (they re-run an EXISTING dream, they don't
        // re-walk the wizard), so they always land here with extraMood
        // null and must leave the dream's music bed exactly as the user
        // already knows it — silently dropping to the style bed mid-edit
        // would be a real, unrequested behavior change.
        mood: extraMood || dream.mood || null,
        // updatedAt (tracker item for-product-build-p0-server-side-dream-p-
        // zl3rb2): stamped on every mutation so reconcilePrivateDreamsFromServer
        // can tell which of two devices' copies of this dream is newer.
        updatedAt: Date.now()
      };
      if (extra && extra.editHistoryEntry) {
        var existingHistory = Array.isArray(dream.editHistory) ? dream.editHistory.slice() : [];
        existingHistory.push({
          deltaLength: extra.editHistoryEntry.deltaLength,
          timestamp: extra.editHistoryEntry.timestamp || Date.now(),
          modelUsed: patch.modelUsed
        });
        patch.editHistory = existingHistory;
      }
      if (mediaType === 'image') patch.imageUrl = mediaUrl; else patch.videoUrl = mediaUrl;
      Object.assign(dream, patch);
    } else {
      dream = {
        id: newId(),
        ownerHandle: state.user ? state.user.handle : '@you',
        caption: resolvedStoryText, promptText: caption, storyText: resolvedStoryText,
        style: style, mediaType: mediaType,
        // mood (tracker item for-product-founder-08-04-evening-music--jfjco0)
        // — see extraMood above. Forward-only, same shape as
        // createdAt/storyText/modelUsed: a dream created before this field
        // existed simply has no mood and is never retroactively guessed.
        mood: extraMood,
        likes: 0, likedByMe: false, isPublished: false,
        videoUrl: mediaType === 'video' ? mediaUrl : null,
        imageUrl: mediaType === 'image' ? mediaUrl : null,
        sourceOperationName: operationName || null,
        // modelUsed (new — docs/EDIT_MECHANISM_SPEC.md §3.4): whichever
        // rotation-eligible model this ORIGINAL generation used (always
        // "veo3.1-lite" for a fresh generation today — rotation only ever
        // kicks in on an edit, see js/store.js's pickEditModel/startDreamEdit
        // below), or null for a mediaType:'image' or self-photo/turn-into-
        // video generation (rotation out of scope for those). A dream saved
        // before this field existed simply has no modelUsed at all (forward-
        // only migration, same as promptText/storyText/createdAt above) —
        // never retroactively guessed.
        modelUsed: extraModelUsed || null,
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
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      // Images never set a duration — there's no clip length concept for a
      // still image (see explore.html/profile.html's guarded d.dur render).
      if (mediaType === 'video') dream.dur = '0:08';
      // Migrates any interpretation(s) started against this job's
      // pending:<operationName> synthetic id (see pendingInterpretations'
      // own doc comment above seed(), and findPendingDream) onto the real,
      // now-finalized dream — durably carrying "already interpreted" over
      // from the generating tile to the finished dream, so result.html's
      // state-aware Chamber hero (tracker item
      // for-product-funnel-ending-v2-founder-ins-tfuu0q) reads correctly
      // for a reading opened WHILE the video was still generating. Only
      // applies to a brand-new dream (this branch, no sourceDreamId) — a
      // regenerate always resets `interpretations` to null on purpose (see
      // the sourceDreamId branch above), which is correct there since the
      // content itself changed; the pending-Chamber path never applies to a
      // regenerate in the first place (it only exists pre-first-completion).
      if (operationName && state.pendingInterpretations[operationName]) {
        dream.interpretations = state.pendingInterpretations[operationName];
        delete state.pendingInterpretations[operationName];
      }
      state.dreams.unshift(dream);
    }
    clearPendingJob();
    persist();
    // Edit Dream / Change Style can regenerate a dream that's already
    // published — keep the shared feed's copy from going stale.
    if (dream.isPublished) {
      syncPublishedDreamToFeed(dream);
      // Defensive — a published dream shouldn't be in the private-dream
      // store at all (publishDream's own best-effort delete already
      // handles the normal case), but a regenerate is a convenient extra
      // chance to self-heal if that earlier delete ever silently failed.
      deletePrivateDreamBestEffort(dream.id);
    } else {
      syncPrivateDreamBestEffort(dream);
    }
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
    // duration_ms (tracker item for-product-track-avg-video-generation-t-
    // 2ci8ue, founder ask 2026-08-10: "track average video/image generation
    // time") — same `_ms` naming convention js/interpret-experience.js's
    // interp_voice_complete event already uses, rather than inventing a new
    // one. null on the same honest-gap basis as durationMs's own doc
    // comment above (should be unreachable today — the sole call site
    // always passes startedAt — but never fabricated if it somehow isn't).
    trackAnalytics('video_created', { style: dream.style, mediaType: dream.mediaType, duration_ms: durationMs });
    // 'generation_slow' (same tracker item, same founder ask: "alert if any
    // single job exceeds 3 minutes") — a SEPARATE event, not just a flag
    // property riding along on video_created, specifically so Growth/Ron
    // can build a PostHog alert/insight directly off this event's own
    // volume without having to first filter video_created by a duration
    // property (matches how e.g. `tokens_refunded` is its own event rather
    // than a flag on video_created, even though both are about the same
    // underlying job). Carries enough to chase a slow job down by model/
    // style, per the founder's own ask. Only ever fires alongside
    // video_created (same completed-job precondition), never on its own.
    if (durationMs !== null && durationMs > GENERATION_SLOW_THRESHOLD_MS) {
      trackAnalytics('generation_slow', {
        style: dream.style, mediaType: dream.mediaType, modelUsed: dream.modelUsed || null, duration_ms: durationMs
      });
    }
    // 'model_used' (docs/EDIT_MECHANISM_SPEC.md §3.5) — fires alongside
    // video_created above, video-only (mediaType 'video' is the only
    // mediaType the model-rotation mechanism ever applies to — see
    // FAL_MODEL_PIXVERSE_V6 in generate-video.js). wasEdit is true for any
    // regenerate of an existing dream (sourceDreamId truthy) — including
    // the OLD full mini-wizard's "Generate Again" (which never rotates,
    // so it always reports modelUsed:"veo3.1-lite"), not just the new
    // edit-delta mechanism — deliberately so the satisfaction-proxy cut
    // this event powers (video_published rate by modelUsed/wasEdit, per
    // the spec) can compare "an edit that rotated" against "an edit that
    // didn't" on equal footing. modelUsed can be null here (an edit that
    // hit the out-of-rotation-scope reference-to-video/image-to-video
    // paths) — sent as-is, never coerced to a fake value.
    if (dream.mediaType === 'video') {
      trackAnalytics('model_used', { modelUsed: dream.modelUsed || null, wasEdit: !!sourceDreamId });
    }
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
    // musicBedOn no longer exists as an opt here (tracker item for-product-
    // build-founder-approved-08-03-jlkjy9, 2026-08-03 founder
    // simplification — "no user choice"). The ambient music bed is now
    // always resolved purely from the finished dream's own `style` at
    // watch time (js/music-bed.js's eligible()), so there is nothing for
    // this function, or finalizeDream below, to read or carry through.
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
    // mood (tracker item for-product-founder-08-04-evening-music--jfjco0) —
    // the dream-builder wizard's Mood step answer (one of js/wizard-chips.js's
    // six real MOOD_CHIPS keys, or null when the step was SKIPPED / answered
    // with "+ Something else" free text / never existed for this path).
    // Purely a CLIENT-SIDE playback hint: deliberately NOT added to the
    // generate-video.js/generate-image.js request payload below, because the
    // mood already reached the model through the assembled prompt text
    // itself (js/wizard-chips.js's assembleCaption emits a "<mood> mood,"
    // clause) — sending it a second time as its own field would be
    // redundant plumbing on a paid endpoint for no behavior change. It only
    // needs to travel as far as savePendingJob (so a resumed job keeps it)
    // and finalizeDream (so the finished dream record carries it), exactly
    // the same route storyText above already takes.
    var mood = opts.mood || null;
    // ── Infer the mood from the dream's own text when none was chosen ──
    // (founder standing rule 08-13). The 3-question Build-flow trim removed
    // the Mood step from create.html, wizard.html and the growth funnel, so
    // every chip/Build/Write dream now reaches here with mood null or the
    // untouched DEFAULT_MOOD ('dreamy'), which killed mood-music variety
    // (js/music-bed.js keys the bed off dream.mood). Rather than re-add a
    // question, derive the mood deterministically from the dream's own text —
    // storyText (the human sentence) preferred, else the engineered caption.
    // This is a CLIENT-SIDE PLAYBACK HINT ONLY: it reassigns the local `mood`
    // var that flows to savePendingJob/finalizeDream, and NEVER touches
    // `caption`/promptText (the generation prompt is unchanged — inference
    // drives MUSIC/mood selection, not the prompt).
    //
    // This is THE single hookpoint that covers all three surfaces without
    // duplicating logic, because every creation path converges here:
    // create.html's "Build it" and Write-it (home.html -> generateVideo ->
    // startGeneration), wizard.html's pre-signup funnel + the growth handoff
    // (adoptPendingGeneration -> resumePendingJob -> startGeneration with the
    // job's own mood/storyText), and every edit/regenerate (also here, but
    // gated out below).
    //
    // Three gates, so it only ever ADDS variety, never overrides a real
    // signal:
    //   - sourceDreamId: a regenerate / Try-Again / edit re-runs an EXISTING
    //     dream that has no mood picker of its own; finalizeDream already
    //     preserves that dream's stored mood, so inferring here would wrongly
    //     clobber it. Skip.
    //   - explicit-pick: only null/absent OR the untouched DEFAULT_MOOD is
    //     treated as "infer". A real non-default user pick (should the Mood
    //     step ever be restored) is left exactly as chosen. No surface sets a
    //     non-default mood today, so treating null/'dreamy' as "infer" is
    //     correct now and forward-safe.
    //   - availability: WizardChips is a browser global, loaded by every real
    //     generation-start page (create/wizard/result/style.html, and — added
    //     for this — home/explore.html). Reached via the same
    //     `typeof window`/window.X pattern store.js already uses for posthog;
    //     if it is somehow absent, mood simply stays as-is (no crash), and
    //     the dream falls back to its style/default bed exactly as before.
    if (!sourceDreamId && (!mood || mood === 'dreamy') &&
        typeof window !== 'undefined' && window.WizardChips &&
        typeof window.WizardChips.inferMoodFromText === 'function') {
      var moodInferSource = opts.storyText || caption;
      if (moodInferSource && String(moodInferSource).trim()) {
        mood = window.WizardChips.inferMoodFromText(moodInferSource);
      }
    }
    var submitUrl = mediaType === 'image' ? '/.netlify/functions/generate-image' : '/.netlify/functions/generate-video';
    // Captured once, up front, so the SAME value is used both on the
    // submission request below and later on every status poll (see
    // pollUntilDone's own doc comment) — an account's email can't change
    // mid-generation in any way that should retroactively affect which
    // balance a post-submission-failure refund lands on.
    var email = currentAccountEmail();

    // startedAt — hoisted here (previously computed only after the
    // submission request had already resolved, inside operationPromise's
    // own .then below) so it's available even when submission itself fails
    // (E1xx/E303/E399, never previously had a startedAt to measure
    // elapsed_ms from) and so pollUntilDone's own timeout budget, the
    // pending job's persisted startedAt, and every generation_failed/
    // video_created elapsed/duration figure below all measure from the
    // exact same moment. Moving this earlier for a fresh (non-resume)
    // submission means it now marks "request kicked off" rather than
    // "submission request resolved" — a difference of at most the
    // submission round trip (typically well under a second), and if
    // anything a more honest "generation start" moment than before.
    var startedAt = resume ? resume.startedAt : Date.now();

    // Captured here (rather than threaded through pollUntilDone's own
    // resolved value) so finalizeDream below can stamp it onto the
    // completed dream — see that function's own doc comment for why.
    var capturedOperationName = null;
    // modelUsed (docs/EDIT_MECHANISM_SPEC.md §3.4) — on a fresh submission
    // this is set from generate-video.js's own response (see the .then
    // below); on a RESUME (opts.resume), there is no fresh response to read
    // it from at all (operationPromise just resolves to the already-known
    // operationName), so it's carried over from opts.modelUsed instead —
    // resumePendingJob passes the pending job's own already-stamped
    // job.modelUsed here, same "re-stamp what this job already decided"
    // pattern opts.audioOn/opts.storyText already use for a resume.
    var capturedModelUsed = (resume && typeof opts.modelUsed !== 'undefined') ? opts.modelUsed : null;

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
            opts.audioOn ? { musicStyle: opts.musicStyle || null } : {},
            // Model-rotation request (docs/EDIT_MECHANISM_SPEC.md §2/§3.4) —
            // only ever set by DreamStore.startDreamEdit below (via
            // pickEditModel), video-only, and only meaningful on
            // generate-video.js's plain text-to-video branch (that file
            // silently ignores it on the self-photo/turn-into-video
            // paths — see its own rotationApplies). Every other caller
            // (a fresh generateVideo, the old full mini-wizard's
            // regenerateDream) sends no requestedModel at all, so
            // generate-video.js's own default (veo3.1-lite) applies,
            // completely unchanged from before this feature existed.
            opts.requestedModel ? { requestedModel: opts.requestedModel } : {}
          ) : {}))
        }).then(function (res) {
          return res.json().then(function (data) {
            if (!res.ok) throw new Error(data.error || 'E399: generation_failed');
            capturedModelUsed = (typeof data.modelUsed === 'string') ? data.modelUsed : null;
            return data.operationName;
          });
        }, function (err) {
          throw new Error('E303: network_error_starting_generation' + (err && err.message ? ': ' + err.message : ''));
        });

    return operationPromise.then(function (operationName) {
      capturedOperationName = operationName;
      // startedAt is now hoisted to the top of startGeneration (see its own
      // doc comment above) — no longer re-declared here.
      savePendingJob({
        operationName: operationName, startedAt: startedAt,
        caption: caption, storyText: storyText, style: style, sourceDreamId: sourceDreamId,
        mediaType: mediaType,
        // mood — same "re-stamp what this job already decided" reasoning as
        // audioOn/storyText below: carried on the pending job itself so a
        // RESUME (resumePendingJob) still finalizes the dream with the mood
        // the wizard originally chose, even though the draft it came from
        // may be long gone by then. See this function's own `mood` comment.
        mood: mood,
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
        // modelUsed (docs/EDIT_MECHANISM_SPEC.md §3.4) — carried on the
        // pending job itself so a RESUME of this job (see resumePendingJob
        // below) can pass it back in as opts.modelUsed, same reasoning as
        // audioOn/storyText just above.
        modelUsed: capturedModelUsed,
        // editHistoryEntry (docs/EDIT_MECHANISM_SPEC.md §3.4) — only ever
        // set by DreamStore.startDreamEdit below. Carried on the pending
        // job so a resumed edit-delta job still records its editHistory
        // entry on completion — resumePendingJob re-passes job.editHistoryEntry
        // back in as opts.editHistoryEntry, same "re-stamp what this job
        // already decided" pattern as audioOn/storyText/modelUsed above.
        editHistoryEntry: opts.editHistoryEntry || null,
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
      // Stale-completion guard (tracker item for-product-bug-founder-repro-
      // edited-dre-jcasn1) — only ever applies to a regenerate/edit of an
      // EXISTING dream (sourceDreamId set): a fresh, brand-new generation
      // always creates its own new dream record on finalize, so there is no
      // existing dream's content for a "supersede" to clobber. If a second
      // edit/regenerate of THIS SAME dream has been submitted (anywhere —
      // another tab, another device) since this attempt's own savePendingJob
      // call above, this completion is superseded: skip finalizing (no
      // dream mutation, no clearPendingJob, no analytics/toast) so it can
      // never silently overwrite the newer attempt's already-in-progress
      // state. Resolves to null rather than rejecting — this isn't a
      // failure from the user's point of view, just a stale straggler with
      // nothing left to do; callers (home.html/result.html) treat a null
      // result as a quiet no-op.
      if (sourceDreamId && !isPendingJobStillCurrent(capturedOperationName, sourceDreamId)) {
        return null;
      }
      var dream = finalizeDream(mediaUrl, caption, style, sourceDreamId, mediaType, capturedOperationName, storyText, {
        modelUsed: capturedModelUsed,
        editHistoryEntry: opts.editHistoryEntry || null,
        mood: mood,
        // startedAt (tracker item for-product-track-avg-video-generation-t-
        // 2ci8ue) — lets finalizeDream compute duration_ms for video_created
        // and decide whether to fire generation_slow. See this function's
        // own hoisted startedAt doc comment above.
        startedAt: startedAt
      });
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
      // Same stale-completion guard as the success path above, mirrored for
      // a failure: only ever clear THIS account's live pendingJob slot (and
      // let the failure surface normally) if it's still this attempt's own
      // — an attempt that never even got as far as savePendingJob
      // (capturedOperationName still null — e.g. E303, the fetch to submit
      // it failed outright) never touched pendingJob in the first place, so
      // clearing unconditionally there is exactly as safe as it always was.
      // A superseded edit's late failure is tagged (err.superseded) instead
      // of clearing/rejecting normally, so a caller can quietly ignore it
      // rather than showing an error toast about an attempt the user has
      // already moved on from — the newer attempt owns the account's
      // pendingJob now and will settle (success or failure) on its own.
      var isStaleEdit = sourceDreamId && capturedOperationName && !isPendingJobStillCurrent(capturedOperationName, sourceDreamId);
      if (isStaleEdit) {
        err.superseded = true;
      } else {
        clearPendingJob();
        // 'generation_failed' (tracker item for-product-track-avg-video-
        // generation-t-2ci8ue) — the single, consistent fire covering EVERY
        // real terminal failure this promise chain can reject with: a
        // fal-reported error (E205/E208/E505/E508, passed through as-is), a
        // client-side poll timeout (E301), a sustained poll network failure
        // (E302), or a submission-time failure (E1xx/E4xx from generate-
        // video.js/generate-image.js, or E303/E399 client-side) — see this
        // file's own E3xx doc block above for the full reasoning, including
        // why this is deliberately skipped on the isStaleEdit branch (that
        // attempt was already quietly ignored, never shown to the user as a
        // failure, and counting it here would double-count against the same
        // dream's other, live attempt).
        trackAnalytics('generation_failed', {
          reason: (err && err.message) || 'unknown_error',
          mediaType: mediaType,
          elapsed_ms: Date.now() - startedAt,
          model: capturedModelUsed
        });
      }
      // Defensive cleanup — a failed job's own pendingInterpretations entry
      // (if the user opened the Chamber while it was still generating,
      // before it failed) has no dream to ever migrate onto (a retry
      // submits a genuinely NEW operationName, see startGeneration's own
      // header comment), so it would otherwise sit orphaned in local
      // storage forever. Harmless either way (this map only ever grows by
      // one entry per opened-Chamber-during-generation, and only until this
      // point), just hygiene.
      if (capturedOperationName && state.pendingInterpretations[capturedOperationName]) {
        delete state.pendingInterpretations[capturedOperationName];
      }
      throw err;
    });
  }

  var state = load();
  backfillSharedFeed();
  // tracker item for-product-p0-data-loss-founder-repro-0-6bzvv1 — see
  // retryUnconfirmedPrivateDreamSyncs' own doc comment.
  retryUnconfirmedPrivateDreamSyncs();

  // Last-chance private-dream sync flush as the page goes away (tracker
  // item for-product-p0-data-loss-founder-repro-0-6bzvv1 / E304 vanish
  // investigation — see flushUnconfirmedPrivateDreamsBeacon's own doc
  // comment). `pagehide` covers the tab/webview actually closing or
  // navigating; `visibilitychange`→hidden covers a mobile webview being
  // backgrounded (which on iOS/Android is frequently the last event a page
  // reliably gets before it's frozen/discarded — `pagehide`/`unload` are
  // not guaranteed to fire there, so both are wired). Guarded to never
  // throw during unload. Both listeners are safe to run repeatedly (the
  // flush is a no-op once nothing is left unconfirmed).
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('pagehide', flushUnconfirmedPrivateDreamsBeacon);
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') flushUnconfirmedPrivateDreamsBeacon();
      });
    }
  }

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

  // Founder's own real accounts and known aliases — excluded from revenue
  // reporting per the founder's standing "no contaminated data" rule
  // (tracker item for-product-founder-alias-exclusion-by-p-f7qyxo, 08-01).
  // These are base NAMES, not exact usernames/emails: matched via
  // normalizeIdentityBase() below rather than a hardcoded exact-string
  // list, so a numbered throwaway account the founder creates later (e.g.
  // ronbrightman8877, already a real example in this codebase's data)
  // or a Gmail dot-variant of one of his real inboxes (Gmail ignores dots
  // in the local part — ri.chardharrisman@gmail.com and
  // richardharrisman@gmail.com are the same real inbox) is caught without
  // needing a code change every time. benbrightman14 (his son's confirmed,
  // founder-approved secondary account — see owner-topup-tokens.js's own
  // header comment on tracker item
  // for-product-extend-owner-top-up-with-a-t-2hmopn) is deliberately
  // stored here as its reduced base, "benbrightman": normalizeIdentityBase
  // strips a trailing numeric suffix from EVERY identity it checks (that's
  // the whole point — see below), so keeping the literal "benbrightman14"
  // in this list would never match anything (the normalized form of the
  // input "benbrightman14" is "benbrightman", not "benbrightman14") and
  // would silently stop matching the very account this list exists to
  // cover. Storing the already-reduced base keeps this list internally
  // consistent with the same rule applied to every other entry.
  //
  // Compared against the RAW identifyForAnalytics input only (a username
  // in every current call site — see the comment above
  // identifyForAnalytics for why never an email), the same shape the old
  // exact-match TEST_OR_INTERNAL_USERNAMES map checked. Deliberately NOT
  // also checked against state.accounts[key].email below (unlike the
  // @example.com check, which was already checking account.email before
  // this change) — that's a real gap the tracker item didn't ask this
  // pass to close, left alone to keep this change minimal and scoped.
  var TEST_OR_INTERNAL_BASE_NAMES = {
    richardharrisman: true,
    jackflaa: true,
    ronbrightman: true,
    benbrightman: true
  };

  /**
   * Normalizes a username or email to the "base name" TEST_OR_INTERNAL_BASE_NAMES
   * is matched against: lowercase, email domain dropped (compare on the
   * local part only — Gmail's dot-insensitivity is a local-part rule),
   * dots stripped (ri.chardharrisman -> richardharrisman), then any
   * trailing run of digits stripped (ronbrightman8877 -> ronbrightman).
   * Digits/dots anywhere OTHER than a trailing run, or in the domain, are
   * left alone — this is base-name normalization, not general sanitizing,
   * so it doesn't over-match an unrelated real user whose name merely
   * contains a digit or a dot (e.g. "sonbrightman99" normalizes to
   * "sonbrightman", which still compares unequal to "ronbrightman").
   *
   * Exposed as window.normalizeIdentityBase purely so
   * test/founder-alias-exclusion-behavioral.test.js can assert this exact
   * function's output directly (both in-browser and via source-extraction
   * against netlify/functions/lib/test-identity.js's server-side twin —
   * see that file's own header for why a byte-for-byte duplicate exists
   * there instead of a shared requireable module, and the parity test
   * that keeps the two from silently drifting).
   */
  function normalizeIdentityBase(usernameOrEmail) {
    var s = String(usernameOrEmail == null ? '' : usernameOrEmail).toLowerCase();
    var at = s.indexOf('@');
    if (at !== -1) s = s.slice(0, at);
    s = s.replace(/\./g, '');
    s = s.replace(/\d+$/, '');
    return s;
  }

  /** True if `raw` (a username or email) normalizes to one of the founder's known base names — see TEST_OR_INTERNAL_BASE_NAMES above. */
  function isKnownFounderOrInternalBase(raw) {
    return !!TEST_OR_INTERNAL_BASE_NAMES[normalizeIdentityBase(raw)];
  }

  /**
   * True if `usernameOrEmail` (whatever identifyForAnalytics was just asked
   * to identify as) should be tagged `is_test` in PostHog: a known founder
   * account/alias (matched by normalized base name — see
   * isKnownFounderOrInternalBase above), an `@example.com` test-fixture
   * email (checked directly, and via the matching account's on-file email
   * in state.accounts, since the distinct_id identifyForAnalytics receives
   * is normally a username, not an email), or a probe-style throwaway
   * username matching the exact `/^__.+__$/` shape register-account.js's
   * E10 suspicious_username check and this file's own signup() already
   * treat as a synthetic autofill placeholder rather than a real
   * human-chosen name (see signup()'s own comment for the incident this
   * pattern comes from) — reused here rather than a new heuristic, per the
   * tracker item's own explicit instruction.
   */
  function isTestOrInternalIdentity(usernameOrEmail) {
    var raw = String(usernameOrEmail || '');
    var key = raw.toLowerCase();
    if (isKnownFounderOrInternalBase(raw)) return true;
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
    // Fire-and-forget — see reconcilePrivateDreamsFromServer's own doc
    // comment. No-ops silently when authToken is null (the offline-
    // fallback branch, or a brand-new account with nothing to reconcile
    // yet either way).
    reconcilePrivateDreamsFromServer();
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
    //
    // signup_method: 'email' (tracker item for-product-signup-method-
    // analytics-foun-y1oqt4, founder ask 2026-08-03) — commitLocalSignup is
    // ONLY ever reached via the manual username/password wall (start.html's
    // attemptSignup, login.html's ?mode=signup, wizard.html's own
    // renderSignup) — commitLocalPasswordlessSignup/commitTransferredSession
    // are the passwordless-code and Facebook equivalents respectively (see
    // each of those for their own signup_method value), so this is a fixed
    // constant here, not a threaded parameter. Joinable in PostHog against
    // the same-named custom_data property on the paired CompleteRegistration
    // CAPI event (see js/analytics-config.js's fireMetaConversion call
    // sites above).
    trackAnalytics('signed_up', { signup_method: 'email' });
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

  // ==========================================================================
  // Passwordless signup (tracker item for-product-build-passwordless-signup-
  // fo-at2fko) — see this file's own header comment (signupPasswordless) for
  // the feature summary. Reuses signupCallSeq/commitLocalSignupIfCurrent's
  // exact "only the most-recently-STARTED call may ever commit" guard
  // (signupPasswordless() below bumps the SAME counter signup() does), same
  // reasoning as that mechanism's own doc comment: this is a second real
  // caller of "create an account and commit state.user", not a special case
  // that needs its own parallel guard.
  // ==========================================================================

  /** Writes a brand-new local passwordless account entry + signs in — the passwordless-signup equivalent of commitLocalSignup above. `password` is always null (this account never has one). `emailVerified` mirrors the server's own resolved state for the server-confirmed branch; the offline-fallback branch (network unreachable) passes `true` — see this file's own header comment on signupPasswordless for why that's the correct, "under-gate" default when no verification email could ever have been sent in the first place. `fireSignedUpEvent` is false when this call RESOLVED an existing account (not a genuinely new one) — mirrors commitLocalSignup's own "signed_up fires exactly once per real account" invariant. */
  function commitLocalPasswordlessSignup(username, email, authToken, emailVerified, fireSignedUpEvent) {
    var key = username.toLowerCase();
    state.accounts[key] = { password: null, email: email.toLowerCase(), createdAt: Date.now(), emailVerified: emailVerified !== false };
    username = pinLegacyRenameIdentity(key, username);
    clearLikesTrackingState();
    state.user = { handle: '@' + username, username: username, authToken: authToken || null };
    persist();
    identifyForAnalytics(username);
    reconcilePrivateDreamsFromServer();
    // signup_method: 'passwordless_code' (tracker item for-product-signup-
    // method-analytics-foun-y1oqt4, founder ask 2026-08-03) — see
    // commitLocalSignup's own comment on why this is a fixed constant
    // rather than a threaded parameter.
    if (fireSignedUpEvent) trackAnalytics('signed_up', { signup_method: 'passwordless_code' });
    // `created` mirrors fireSignedUpEvent (both are true exactly for a
    // genuinely NEW account, never a resolved-existing one) — exposed on
    // the return value so a caller (start.html's passwordless signup arm)
    // can decide whether to fire its own CompleteRegistration Pixel event,
    // the same "only a real new signup, never a login" rule attemptSignup's
    // own CompleteRegistration call site already follows.
    return { ok: true, user: state.user, created: !!fireSignedUpEvent };
  }

  /** Same "only the most-recently-STARTED call commits" guard as commitLocalSignupIfCurrent — see that function's own doc comment for the full "why" (shared signupCallSeq counter). */
  function commitLocalPasswordlessSignupIfCurrent(mySeq, username, email, authToken, emailVerified, fireSignedUpEvent) {
    if (mySeq !== signupCallSeq) {
      return { ok: false, superseded: true, error: 'Superseded by a newer signup attempt.' };
    }
    return commitLocalPasswordlessSignup(username, email, authToken, emailVerified, fireSignedUpEvent);
  }

  /** Derives a simple, collision-free-against-THIS-DEVICE'S-own-local-accounts username from an email — the OFFLINE-FALLBACK-ONLY equivalent of lib/derive-username.js's server-side derivation (that module can't run in a browser — no require(), see CLAUDE.md). Deliberately simpler than the server version (no unbounded retry loop against a store that, offline, is just this device's own small local `accounts` object) — good enough for the rare "functions runtime totally unreachable" case this backs, matching signup()'s own existing "offline degrades, never blocks" posture. */
  function deriveLocalUsernameForPasswordlessFallback(email) {
    var local = ((email || '').split('@')[0] || '').toLowerCase();
    var sanitized = local.replace(/[^a-z0-9]/g, '');
    if (sanitized.length < 3) sanitized = (sanitized + 'dreamer').slice(0, Math.max(3, sanitized.length + 4));
    var base = sanitized.slice(0, 20) || 'dreamer';
    var candidate = base;
    var attempts = 0;
    while (state.accounts[candidate] && attempts < 8) {
      candidate = base + Math.floor(1000 + Math.random() * 9000);
      attempts++;
    }
    return candidate;
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
   * way can't opportunistically re-authenticate to any password-gated,
   * best-effort endpoint that relies on the cached local password (such a
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
     * True once THIS browser's localStorage has ever held any real,
     * signed-up-or-logged-in account — regardless of whether anyone is
     * currently signed in. state.accounts is deliberately NOT cleared by
     * logout() (see that function's own single-line body: only
     * state.user/the pre-account analytics marker/likes-tracking state
     * are reset — the account cache itself survives so the same browser
     * can log back into it later without re-registering locally). That
     * makes it the right, durable signal for "is this a RETURNING visitor
     * to this browser/origin, just currently logged out" — as opposed to
     * "a genuinely brand-new visitor who has never touched this browser
     * before" — used by wizard.html's own entry guard (tracker item
     * for-product-life-origin-generate-handoff-founder-repro-8yc4wm) to
     * decide whether a logged-out visit belongs in the pre-signup wizard
     * at all. Exported here rather than left as a private state.accounts
     * read because that state is otherwise never exposed to callers
     * outside this file (see e.g. currentAccountEmail's own doc comment
     * on why account data generally stays scoped to the signed-in user
     * only) — this is a deliberate, narrow exception: existence-only,
     * never any account's actual data (password, email, etc.).
     */
    hasLocalAccountHistory: function () { return Object.keys(state.accounts).length > 0; },

    /**
     * Display-only helper: strips a leading '@' off a handle for rendering
     * (tracker item for-product-ui-founder-directed-2026-07--w3mc4v — drop
     * the '@' prefix from every place a username/handle is shown to the
     * user). Every handle is stored/compared WITH its '@' (state.user.handle,
     * d.ownerHandle, etc. — see signup/login/getSharedFeed and this file's
     * own header doc) because that's the format every equality check,
     * lookup, and the getSharedFeed data-filter-user filter already relies
     * on; changing the stored/matching format itself is explicitly out of
     * scope. This is the ONE place that ever strips it, so every render
     * site should call this instead of inlining its own `.replace(/^@/, '')`
     * — used at every DOM render site across profile.html, home.html,
     * explore.html and js/report-sheet.js. Safe on already-bare handles,
     * null/undefined, and non-string values (returns them unchanged).
     */
    displayHandle: function (handle) {
      return (typeof handle === 'string') ? handle.replace(/^@/, '') : handle;
    },

    /**
     * Deterministic per-username fallback avatar — { gradient, initial } —
     * for when there's no real photo to render (see AVATAR_FALLBACK_PALETTE/
     * avatarFallback's own doc comment above). Pure function of `handle`
     * alone, so every device renders the exact same fallback for a given
     * username, every time.
     */
    avatarFallback: avatarFallback,

    /**
     * This account's own Me-character photo, straight from local state —
     * no network round trip. explore.html uses this to backfill the
     * viewer's OWN published dreams with their real photo immediately
     * (tracker item for-product-ui-founder-directed-2026-07--djgjn0's
     * explicit ask), rather than waiting on the small server-synced
     * `avatar` thumbnail (see syncPublishedDreamToFeed) to have round-
     * tripped through get-feed.js — this device already has the freshest,
     * full-quality copy of that photo. Returns null if logged out, or
     * there's no Me character / it's describe-only (no photo).
     */
    getMeAvatarDataUrl: function () {
      var self = state.user ? myCharacterList().filter(function (c) { return c.isSelf; })[0] : null;
      return (self && self.photoDataUrl) || null;
    },

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
     * Passwordless signup (tracker item for-product-build-passwordless-
     * signup-fo-at2fko) — see this file's own header comment for the full
     * feature summary. Returns a Promise of one of:
     *   { ok:true, user }                      — a brand-new account, or the
     *                                             offline-fallback branch;
     *                                             signed in immediately.
     *   { ok:true, pendingVerification:true, email } — the email already has
     *                                             an account. NO session is
     *                                             established (see the
     *                                             SECURITY FIX note below) —
     *                                             the caller must show a
     *                                             "check your email" step
     *                                             and call
     *                                             loginWithEmailCode(email,
     *                                             code) once the visitor has
     *                                             the code, or wait for a
     *                                             link click.
     *   { ok:false, error }                    — a real rejection.
     * No password is ever sent, required, or stored.
     *
     * SECURITY FIX (round-2 review finding, real, fixed 2026-08-02): this
     * used to commit a local session straight off ANY ok:true response,
     * including a resolve-into-an-existing-account one — server-side,
     * register-account-passwordless.js used to mint a real authToken for
     * that existing account with zero proof the caller controlled its
     * inbox (a one-request account takeover, closed server-side — see that
     * file's own header comment for the full incident writeup). Even after
     * that server-side fix, this client function still needed its own
     * fix: `pendingVerification:true` is also `ok:true`, and blindly
     * routing every `ok:true` through commitLocalPasswordlessSignupIfCurrent
     * would have tried to sign in with `data.username === undefined` (a
     * TypeError waiting to happen, since that branch never sends a
     * username at all now) — checked FIRST, explicitly, below.
     *
     * Shares signupCallSeq with signup() above (see
     * commitLocalPasswordlessSignupIfCurrent's own doc comment) — a
     * password-path signup() call and a signupPasswordless() call racing
     * each other (not a realistic UI state today, since no screen offers
     * both at once, but nothing stops a future one from) still resolve to
     * "only the most recently STARTED one wins", the same invariant either
     * mechanism guarantees on its own.
     */
    signupPasswordless: function (email) {
      email = (email || '').trim();
      if (!EMAIL_RE.test(email)) return Promise.resolve({ ok: false, error: 'Enter a valid email address.' });

      var mySignupSeq = ++signupCallSeq;

      return fetch('/.netlify/functions/register-account-passwordless', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email })
      }).then(function (res) {
        return res.json();
      }).then(function (data) {
        // Checked BEFORE the generic `data.ok` branch below — see this
        // method's own SECURITY FIX doc comment for why order matters
        // here. No local state is touched at all on this branch: there is
        // no session to commit yet.
        if (data && data.ok && data.pendingVerification) {
          return { ok: true, pendingVerification: true, email: email };
        }
        if (data && data.ok) {
          return commitLocalPasswordlessSignupIfCurrent(mySignupSeq, data.username, email, data.authToken, data.emailVerified, !!data.created);
        }
        if (data && data.ok === false && data.error) {
          return { ok: false, error: mapRegisterError(data.error) };
        }
        // Unexpected/malformed response — same "degrade, don't hard-block"
        // treatment as the network-failure branch below.
        return commitLocalPasswordlessFallback();
      }).catch(function () {
        return commitLocalPasswordlessFallback();
      });

      /** Offline/unreachable-server fallback — see this file's header comment on signupPasswordless for why emailVerified:true is the correct default here (no code could ever have been sent). Derives a username locally since there's no server round trip to derive one for us. */
      function commitLocalPasswordlessFallback() {
        var username = deriveLocalUsernameForPasswordlessFallback(email);
        return commitLocalPasswordlessSignupIfCurrent(mySignupSeq, username, email, null, true, true);
      }
    },

    /**
     * Completes the "resolve into an existing account" half of
     * signupPasswordless (tracker item for-product-build-passwordless-
     * signup-fo-at2fko's SECURITY FIX — see that method's own doc comment
     * for the full incident writeup). POSTs the mailed 6-digit code to
     * login-with-email-code.js — a genuine LOGIN (this device has no prior
     * session at all), which only ever mints a real authToken once the
     * server confirms the code actually matches what was mailed to that
     * address. Returns a Promise of { ok:true, user } or { ok:false,
     * error }. A successful call also implicitly verifies the account
     * (checking a real code IS ownership proof — same rule verify-email-
     * code.js's own success path already follows), so no separate
     * verification step is ever needed afterward.
     *
     * Materializes/updates the local `accounts` entry the same way login()
     * does (brand-new-to-this-device vs. already-known-locally), including
     * awaiting reconcilePrivateDreamsFromServer() before resolving — same
     * "a login is exactly what webview-storage-wipe recovery looks like"
     * reasoning login()'s own doc comment gives for why that isn't
     * fire-and-forget here either.
     */
    loginWithEmailCode: function (email, code) {
      email = (email || '').trim();
      code = (code || '').trim();
      if (!code) return Promise.resolve({ ok: false, error: 'Enter the code from your email.' });

      return fetch('/.netlify/functions/login-with-email-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, code: code })
      }).then(function (res) {
        return res.json();
      }).then(function (data) {
        if (!data || !data.ok || !data.username) {
          var err = (data && data.error) || '';
          if (err.indexOf('too_many_attempts') !== -1) return { ok: false, error: 'Too many tries — request a fresh code and try again.' };
          return { ok: false, error: "That code didn't match — try again." };
        }
        var key = data.username.toLowerCase();
        if (!state.accounts[key]) {
          // Same brand-new-to-this-device placeholder shape login() itself
          // materializes — no password (this is, and stays, a passwordless
          // account), emailVerified true (a real code check just proved
          // ownership).
          state.accounts[key] = { password: null, email: (data.email || '').toLowerCase(), emailVerified: true };
        } else {
          state.accounts[key].password = null;
          if (data.email) state.accounts[key].email = data.email.toLowerCase();
          state.accounts[key].emailVerified = true;
        }
        var username = pinLegacyRenameIdentity(key, data.username);
        clearLikesTrackingState();
        state.user = { handle: '@' + username, username: username, authToken: data.authToken || null };
        persist();
        identifyForAnalytics(username);
        return reconcilePrivateDreamsFromServer().then(function () {
          return { ok: true, user: state.user };
        });
      }).catch(function () {
        return { ok: false, error: "Couldn't reach the server — try again." };
      });
    },

    /**
     * Local, no-network read of the signed-in account's own cached
     * `emailVerified` (tracker item for-product-build-passwordless-signup-
     * fo-at2fko) — refreshed into state.accounts on every
     * signup/signupPasswordless/login response (see each of those). `true`
     * (never gate) if logged out, or for any account this field predates —
     * same "under-gate, never over-gate" default account-store.js's own
     * server-side reads use.
     */
    getAccountEmailVerified: function () {
      if (!state.user) return true;
      var key = state.user.username.toLowerCase();
      var acct = state.accounts[key];
      return !acct || acct.emailVerified !== false;
    },

    /**
     * Submits a 6-digit code against the signed-in account's own pending
     * verification (netlify/functions/verify-email-code.js). Returns a
     * Promise of { ok:true } or { ok:false, error }. On success, updates
     * the local cached emailVerified flag so getAccountEmailVerified()
     * reflects it immediately with no extra round trip.
     */
    verifyEmailCode: function (code) {
      if (!state.user || !state.user.authToken) {
        return Promise.resolve({ ok: false, error: "You're not signed in." });
      }
      return fetch('/.netlify/functions/verify-email-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ authToken: state.user.authToken, code: code })
      }).then(function (res) { return res.json(); }).then(function (data) {
        if (data && data.ok) {
          var key = state.user.username.toLowerCase();
          if (state.accounts[key]) state.accounts[key].emailVerified = true;
          persist();
          // bonus: the server's +20 verification-grant result
          // (verify-email-code.js — { granted, amount, balance? }), passed
          // through verbatim so the sheet/home can celebrate exactly when
          // the server says the grant landed, never by guessing. Absent on
          // pre-bonus responses — callers must null-check.
          return { ok: true, bonus: data.bonus || null };
        }
        var err = (data && data.error) || '';
        if (err.indexOf('too_many_attempts') !== -1) return { ok: false, error: 'Too many tries — request a fresh code and try again.' };
        if (err.indexOf('invalid_or_expired_token') !== -1) return { ok: false, error: "You're not signed in." };
        return { ok: false, error: "That code didn't match — try again." };
      }).catch(function () {
        return { ok: false, error: "Couldn't reach the server — try again." };
      });
    },

    /**
     * Asks the server to re-send a fresh verification code
     * (netlify/functions/resend-verification-code.js). Best-effort from
     * the caller's perspective (the sheet just shows a generic "sent!"
     * regardless of the real Resend outcome, matching this codebase's own
     * established discipline of never surfacing raw email-delivery
     * failures to an end user — see lib/verification-email-sender.js) —
     * still returns the real { ok, error } shape so a genuinely broken
     * session (not signed in / expired token) CAN be told apart from "sent,
     * who knows if it lands".
     */
    // opts.auto (optional bool, fix for tracker item for-product-bug-
    // founder-repro-08-09-veri-g71t7u) -- set ONLY by js/email-verify-
    // sheet.js's autoSendOnOpen (an automatic, no-user-action call), never
    // by the manual "Resend" link -- see resend-verification-code.js's own
    // header comment for the full "why" (an automatic call this close to
    // signup's own send is a genuine duplicate; a manual tap never is).
    resendVerificationCode: function (opts) {
      if (!state.user || !state.user.authToken) {
        return Promise.resolve({ ok: false, error: "You're not signed in." });
      }
      return fetch('/.netlify/functions/resend-verification-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ authToken: state.user.authToken, auto: !!(opts && opts.auto) })
      }).then(function (res) { return res.json(); }).then(function (data) {
        if (data && data.ok) return { ok: true };
        return { ok: false, error: "Couldn't send a new code — try again." };
      }).catch(function () {
        return { ok: false, error: "Couldn't reach the server — try again." };
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
            // etc.) doesn't break from a missing accounts entry. Characters
            // still have no server-side copy at all (out of scope), so
            // charactersByUser stays empty here — but private dreams DO
            // now get backfilled from the server, via
            // reconcilePrivateDreamsFromServer() below (tracker item
            // for-product-build-p0-server-side-dream-p-zl3rb2), which is
            // exactly the case this matters most for: a brand-new-to-this-
            // device login is precisely what happens after a webview wipe.
            // The ONE hardcoded exception is migrateLegacyThrowawayAccountData
            // below, for the one-off ronbrightman rename specifically —
            // see that function's own doc comment.
            state.accounts[serverUsername] = { password: password, email: (data.email || '').toLowerCase(), emailVerified: data.emailVerified !== false };
          } else {
            // Already known locally (e.g. this is the account's original
            // device) — keep the local mirror in sync with whatever the
            // server just accepted, in case they'd drifted (e.g. a
            // password reset applied server-side from a different device
            // since).
            state.accounts[serverUsername].password = password;
            if (data.email) state.accounts[serverUsername].email = data.email.toLowerCase();
            // emailVerified (tracker item for-product-build-passwordless-
            // signup-fo-at2fko) — keeps this device's cache in sync with
            // whatever verified this account server-side since its last
            // login here (e.g. an implicit-verification link clicked on a
            // different device).
            state.accounts[serverUsername].emailVerified = data.emailVerified !== false;
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
          // AWAITED, not fire-and-forget — see reconcilePrivateDreamsFromServer's
          // own doc comment (NAVIGATION-RACE NOTE, tracker item nsbbg5) for
          // exactly why: this is the single most important call site for
          // it, and a brand-new-to-this-device login (see the comment just
          // above) is exactly what a webview-storage-wipe recovery looks
          // like — a caller (login.html) that redirects the instant this
          // promise resolves must not be able to outrun the restore.
          return reconcilePrivateDreamsFromServer().then(function () {
            return { ok: true, user: state.user };
          });
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

    /**
     * The CURRENTLY signed-in account's own already-cached local password,
     * or null if there is none to give (not signed in, or this account has
     * no locally-cached password at all — e.g. one established purely via
     * a session-transfer token, see commitTransferredSession's own doc
     * comment). Same "no new re-auth prompt, the password is already on
     * hand" shape as mintSessionTransferToken above — added for shop.html's
     * returning-buyer checkout prefill (create-checkout-session-dodo.js's
     * OPTIONAL password field, tracker item
     * for-product-repeat-purchase-friction-dod-b6pzs6): that endpoint only
     * ever attaches a stored Dodo customer_id / enables saved payment
     * methods after verifying this password server-side, and falls back
     * silently to today's plain checkout if it's missing or wrong — so
     * handing it over here is a pure convenience, never something whose
     * absence should surface as an error to the caller.
     */
    getCachedPassword: function () {
      if (!state.user) return null;
      var key = state.user.username.toLowerCase();
      var account = state.accounts[key];
      return (account && account.password) || null;
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
     *   isFirstEverNight — true when EVERY qualifying entry this account
     *                     has ever logged (real dream, legacy pre-createdAt
     *                     dream, or no-recall check-in) is from TODAY —
     *                     i.e. this is genuinely the account's first-ever
     *                     logged night, whether tonight's entry is a
     *                     still-generating pending job, an already-finished
     *                     dream, or a no-recall check-in. Tracker item
     *                     for-product-funnel-ending-v2-founder-ins-tfuu0q's
     *                     combined ritual-module state (home.html:
     *                     "🔥 1 night" / "Your streak starts tonight" +
     *                     the first-claim bonus eyebrow, shown only when the
     *                     server's first-claim amount exceeds the normal 20 —
     *                     as of the 2026-08-08 retune it equals 20, so the
     *                     eyebrow stays hidden) keys off
     *                     `isFirstEverNight && loggedToday` — deliberately
     *                     a SEPARATE flag from hasEverLogged (which is also
     *                     true tonight, but stays true forever afterward)
     *                     so a returning day-2+ user never mistakenly gets
     *                     the day-0-only copy again.
     *
     * A dream saved before the createdAt field existed (see finalizeDream's
     * own doc comment) simply never counts toward loggedToday/weekCount —
     * same "missing means don't count it, never fabricate" rule every
     * other forward-only field in this file already follows. hasEverLogged
     * is the one deliberate exception: it only needs ownership, not a date,
     * so a legacy pre-createdAt dream still counts there (see the fix
     * below) — otherwise a real, active account with only legacy dreams
     * would wrongly get the brand-new-user D1 hint forever.
     */
    getDreamLogStatus: function () {
      var myHandle = state.user ? state.user.handle : null;
      var mine = state.dreams.filter(function (d) { return !!myHandle && d.ownerHandle === myHandle && typeof d.createdAt === 'number'; });
      // hasEverLogged only needs "has this account logged ANYTHING, ever" --
      // it must NOT require createdAt (unlike `mine` above, which genuinely
      // needs it for date bucketing into loggedToday/weekCount). A dream
      // saved before the createdAt field existed (see finalizeDream's own
      // doc comment) still counts as having-logged even though it can't be
      // date-bucketed -- same ownership-only match getMyDreams() already
      // uses, just filtered here rather than calling that method directly
      // (avoids a second full array scan for a value we already have `mine`
      // half-computed for). Root cause of a real bug (tracker item
      // for-product-home-screen-spec-drift-from--575djz, fix 4): an account
      // with only legacy, pre-createdAt dreams was getting
      // hasEverLogged:false, which wrongly showed the brand-new-user
      // "New here?" hint (renderNextStrip in home.html) to an already-active
      // account.
      var myAny = state.dreams.filter(function (d) { return !!myHandle && d.ownerHandle === myHandle; });
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
      // A still-generating dream counts as "logged tonight" too (tracker
      // item for-product-funnel-ending-v2-founder-ins-tfuu0q: the Tonight
      // hero shows its already-logged state the moment a funnel/create.html
      // generation is SUBMITTED, not once it finishes) — scopedPendingJob()
      // already scopes this to the currently signed-in account, same as
      // every other read here. startedAt is stamped at submission time (see
      // savePendingJob's own call sites), so this reads as "today" from the
      // instant the job exists, exactly like a real dream's createdAt would.
      var pendingJob = scopedPendingJob();
      var pendingToday = !!(pendingJob && typeof pendingJob.startedAt === 'number' && new Date(pendingJob.startedAt).toDateString() === todayStr);

      var yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      var yesterdayStr = yesterday.toDateString();
      var loggedYesterday = mine.some(function (d) { return new Date(d.createdAt).toDateString() === yesterdayStr; }) || noRecallDates.indexOf(yesterdayStr) !== -1;

      // isFirstEverNight (see this function's own doc comment above): true
      // when nothing OTHER than today (a real dream, a legacy pre-createdAt
      // dream, or a no-recall check-in) has ever been logged by this
      // account. `mine` only ever contains dreams WITH a createdAt, so a
      // legacy dream (no createdAt at all — see this function's own header
      // comment on why those never count toward loggedToday/weekCount) is
      // counted separately here via the myAny/mine length difference —
      // such a dream necessarily predates today (createdAt didn't exist
      // yet when it was saved), so it always disqualifies "first ever."
      var priorRealCount = mine.filter(function (d) { return new Date(d.createdAt).toDateString() !== todayStr; }).length;
      var legacyDreamCount = myAny.length - mine.length;
      var priorNoRecallCount = noRecallDates.filter(function (ds) { return ds !== todayStr; }).length;
      var isFirstEverNight = (priorRealCount + legacyDreamCount + priorNoRecallCount) === 0;

      return {
        loggedToday: !!todayDream || todayNoRecall || pendingToday,
        todayEntryType: todayDream ? 'dream' : (todayNoRecall ? 'no_recall' : (pendingToday ? 'pending' : null)),
        todayDreamCaption: todayDream ? (todayDream.storyText || todayDream.caption) : (pendingToday ? (pendingJob.storyText || pendingJob.caption) : null),
        loggedYesterday: loggedYesterday,
        weekCount: weekDreamCount + weekNoRecallCount + (pendingToday && !todayDream ? 1 : 0),
        weekTarget: WEEK_SUMMARY_TARGET,
        hasEverLogged: myAny.length > 0 || noRecallDates.length > 0 || pendingToday,
        isFirstEverNight: isFirstEverNight
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

    /**
     * Publicly-exposed cross-device hydrate (founder fix 2026-08-11): pulls
     * this signed-in account's server-synced private dreams (dream-sync GET)
     * and merges them into local state, so a page reached by a DEEP LINK to a
     * dream that isn't in THIS browser's localStorage yet (e.g. an emailed
     * result.html?id=...&interp=1 link opened on a new device, or after an
     * in-app-webview storage wipe) can re-resolve it instead of dead-ending.
     * Thin pass-through to the internal reconcile (already used on login/init)
     * — same MERGE-not-clobber semantics, same best-effort never-throws
     * contract; resolves once the merge (or its failure) has settled.
     */
    reconcilePrivateDreamsFromServer: function () { return reconcilePrivateDreamsFromServer(); },
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
    clearDraft: function () { state.draft = { caption: '', storyText: '', needsStoryRewrite: false, style: null, sourceDreamId: null, restore: false, characterIds: [], cameraView: null, sceneryTime: null, sceneryPlace: null, mediaType: null, sourceImageUrl: null, audioOn: false, musicStyle: null, mood: null, isEditDelta: false, editDeltaLength: null }; persist(); },

    /** Creates a brand new dream via fal.ai. Returns a Promise that resolves once the video is ready. opts: { characterIds, cameraView, sceneryTime, sceneryPlace, turnstileToken, audioOn, musicStyle }. Implicitly always 'video' — see generateImage below for the cheaper alternative; a caller that wants an image calls that instead, this method never looks at opts.mediaType. musicBedOn is no longer a recognized opt (tracker item for-product-build-founder-approved-08-03-jlkjy9, 2026-08-03 founder simplification) — music-bed eligibility is now computed purely from the finished dream's own style, see js/music-bed.js. */
    generateVideo: function (caption, style, opts) {
      opts = opts || {};
      return startGeneration(caption, style, {
        characterIds: opts.characterIds, cameraView: opts.cameraView,
        sceneryTime: opts.sceneryTime, sceneryPlace: opts.sceneryPlace,
        turnstileToken: opts.turnstileToken,
        audioOn: opts.audioOn, musicStyle: opts.musicStyle,
        storyText: opts.storyText,
        // mood (tracker item for-product-founder-08-04-evening-music--jfjco0)
        // — the wizard's Mood step answer, forwarded through so the finished
        // dream record carries it for music-bed selection. See
        // startGeneration's own `mood` comment.
        mood: opts.mood
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
     *
     * UPDATE 2026-08-02 (tracker item for-product-turn-off-audio-dialogue-
     * gene-ooeyoj): audioOn:true sent here is now a no-op — generate-
     * video.js/start-pending-generation.js force generate_audio:false
     * unconditionally server-side regardless of what any caller sends.
     * Left as-is deliberately (not rewritten to audioOn:false) per that
     * tracker item's own instruction to leave this plumbing intact and
     * inert rather than rip it out — a trivial flip back on if the
     * founder ever reverses the directive.
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
     * Picks which rotation-eligible model an edit of `dream` should use —
     * see the module-level pickEditModel's own doc comment for the full
     * rotation rule (alternation + Anime override). Exposed as a pure,
     * read-only function so result.html can compute (and, if it wants,
     * display/log) the target model BEFORE calling startDreamEdit below —
     * startDreamEdit calls this internally too, so a caller never needs to
     * compute it twice; this is here for callers that just want to know
     * without submitting anything yet.
     */
    pickEditModel: pickEditModel,

    /**
     * Realigns a dream's prompt/story with a user's plain-text edit delta —
     * see the module-level realignDreamPrompt's own doc comment. Never
     * rejects (falls back to a naive concatenation merge on any failure) —
     * see that function's doc comment for the full edge-case handling.
     */
    realignDreamPrompt: realignDreamPrompt,

    /**
     * Submits the edit-delta mechanism's actual regeneration (docs/
     * EDIT_MECHANISM_SPEC.md §3.2 step 7-9, tracker item
     * for-product-new-edit-mechanism-founder-i-qmsdgj) — result.html's new
     * default edit sheet's "Generate this · 100 tokens" commit button,
     * called only AFTER the user has reviewed Direction B's confirm screen
     * (the realigned storyText). Like regenerateDream above, but additionally:
     *   - applies model rotation (pickEditModel) via startGeneration's
     *     opts.requestedModel — the one behavioral difference from a plain
     *     Edit-sheet regenerate, which never rotates.
     *   - records a lightweight editHistory entry on the resulting dream
     *     (deltaLength/timestamp/modelUsed only — see finalizeDream's own
     *     doc comment for why no raw delta text is kept here or
     *     anywhere server-side beyond the in-flight realign call).
     *
     * opts: { promptText, storyText, characterIds, deltaLength,
     * turnstileToken }. promptText/storyText are whatever
     * DreamStore.realignDreamPrompt (or its own naive fallback) already
     * resolved to — result.html's confirm screen is what the user actually
     * reviewed before this is called, so this function doesn't re-run
     * realignment itself. deltaLength is the user's ORIGINAL delta text's
     * character length only (never the raw text — matches edit_submitted's
     * own instrumentation rule). mediaType/style are always carried over
     * from the dream being edited — the new edit sheet has no media-type or
     * style picker of its own (whole-dream delta only, per spec §3.6).
     *
     * Returns a rejected Promise (Error('not_found')) if dreamId doesn't
     * resolve to a real dream this account owns — same ownership guard
     * finalizeDream's own sourceDreamId branch already enforces
     * defense-in-depth, surfaced here early so a caller can show a clear
     * failure immediately rather than waiting on a submission that would
     * fail later anyway.
     */
    startDreamEdit: function (dreamId, opts) {
      opts = opts || {};
      var dream = findDream(dreamId);
      var myHandle = state.user ? state.user.handle : null;
      if (!dream || !myHandle || dream.ownerHandle !== myHandle) return Promise.reject(new Error('not_found'));
      var requestedModel = pickEditModel(dream);
      return startGeneration(opts.promptText, dream.style, {
        sourceDreamId: dreamId,
        storyText: opts.storyText,
        characterIds: opts.characterIds,
        turnstileToken: opts.turnstileToken,
        mediaType: dream.mediaType || 'video',
        requestedModel: requestedModel,
        // Same reasoning as regenerateDream's own audioOn:true above — the
        // new edit sheet has no audio picker either, and this is still a
        // regenerate of an existing dream, not a genuinely new generation.
        audioOn: true,
        editHistoryEntry: { deltaLength: opts.deltaLength, timestamp: Date.now() }
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
     * The synthetic `pending:<operationName>` dream id (see findPendingDream's
     * own doc comment above) for the CURRENT account's in-flight generation
     * job, or null if there isn't one — home.html's single source of truth
     * for "what dream id does the Chamber open while the My-dreams row's
     * first tile is still generating." Centralized here (rather than every
     * caller string-concatenating its own `'pending:' + job.operationName`)
     * so the prefix itself only ever needs to change in one place.
     */
    getPendingDreamId: function () {
      var job = scopedPendingJob();
      return job ? pendingDreamIdFor(job.operationName) : null;
    },

    /**
     * The synthetic `pending:<operationName>` id for an arbitrary
     * operationName — the same string getPendingDreamId above returns, but
     * computable AFTER that job has already settled (finalizeDream clears
     * state.pendingJob before the completion promise resolves, so
     * getPendingDreamId() is already null by the time a caller learns the
     * generation finished). home.html's onGenerationSettled needs exactly
     * that: "which synthetic id did the dream that just landed used to be
     * addressed by," so an interpretation opened against the still-
     * generating dream can be re-pointed at the real one
     * (InterpretExperience.notifyDreamResolved). Pure string math, no
     * state read and no ownership guard of its own — it names an id, it
     * doesn't grant access to anything (findPendingDream/findDream still
     * apply every existing ownership check when that id is actually used).
     */
    pendingDreamIdFor: function (operationName) {
      return pendingDreamIdFor(operationName);
    },

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
    adoptPendingGeneration: function (operationName, startedAt, caption, style, mediaType, storyText, mood) {
      savePendingJob({ operationName: operationName, startedAt: startedAt, caption: caption, storyText: storyText || null, style: style, sourceDreamId: null, mediaType: mediaType === 'image' ? 'image' : 'video',
        // mood (tracker item for-product-founder-08-04-evening-music--jfjco0)
        // — wizard.html's pre-signup flow never touches startGeneration on
        // the way OUT (the real submission already happened server-side via
        // start-pending-generation.js), so this adoption is the ONLY place
        // its Mood step answer can be attached to the job that eventually
        // finalizes the dream. Omitted by any caller that has no mood
        // (start.html's own pre-signup flow has no Mood step at all) —
        // undefined becomes null, the documented "fall back to the
        // style bed" state.
        mood: mood || null,
        notify: false });
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
        videoUrl: videoUrl,
        // createdAt (tracker item for-product-media-library-stamp-durable--
        // u4oju3) — this function previously stamped NO createdAt at all
        // (unlike finalizeDream's own real-generation path), so every
        // claimed dream (claim-dream.html's abandoned-dream re-engagement
        // landing page) had no timestamp anywhere, client or server. The
        // actual generation happened earlier, before the account existed to
        // own it, and that original moment isn't available here — Date.now()
        // at claim time is the best real signal this function has (the
        // moment this browser first materializes a real local record for
        // it), same "honest, non-fabricated stand-in" reasoning
        // publish-dream.js's own publishedAt-as-createdAt-fallback already
        // documents for an equivalent gap.
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      state.dreams.unshift(dream);
      persist();
      syncPrivateDreamBestEffort(dream);
      probeVideoDuration(videoUrl).then(function (dur) {
        if (dur) {
          dream.dur = dur;
          dream.updatedAt = Date.now();
          persist();
          syncPrivateDreamBestEffort(dream);
        }
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
        // mood — same reasoning again (tracker item for-product-founder-
        // 08-04-evening-music--jfjco0). This is the line that actually makes
        // wizard.html's pre-signup flow work end to end: that path NEVER
        // calls generateVideo, it adopts a server-started job and lets
        // home.html resume it, so without re-stamping job.mood here the
        // wizard's Mood step answer would be silently dropped on the exact
        // funnel it matters most for.
        mood: job.mood,
        // modelUsed/editHistoryEntry (docs/EDIT_MECHANISM_SPEC.md §3.4) —
        // same "re-stamp what this job already decided" reasoning as
        // audioOn/storyText above: a resume has no fresh generate-video.js
        // response to read modelUsed from, and no live edit-sheet state to
        // read editHistoryEntry from, so both are carried forward from
        // whatever this job was originally submitted with.
        modelUsed: job.modelUsed,
        editHistoryEntry: job.editHistoryEntry || null,
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
        // A published dream's durable copy is now the shared feed above —
        // it no longer belongs in the private-dream store (tracker item
        // for-product-build-p0-server-side-dream-p-zl3rb2). Best-effort,
        // safe to call even if it was never synced there in the first
        // place (see lib/dream-store.js's own removePrivateDream doc
        // comment).
        deletePrivateDreamBestEffort(d.id);
        // Social Layer v2 slice 1 (docs/SOCIAL_LAYER_V2_DESIGN.md) — first
        // publish is the OTHER trigger point for syncing this account's
        // public-profile record (alongside profile.html's Edit-profile
        // save), so a dreamer who publishes without ever opening Edit
        // profile still gets a real, u.html-visible profile record (name/
        // avatar sourced from their Me character, same as
        // syncProfileToServer's own doc comment describes) rather than the
        // profile page staying permanently unsynced. Only on the actual
        // transition into published, same isNewPublish gate as the
        // license-grant/analytics calls just above — a re-sync of an
        // already-published dream (finalizeDream) has no reason to also
        // re-sync the profile record every time.
        if (isNewPublish) syncProfileToServer();
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
        d.updatedAt = Date.now();
        persist();
        removePublishedDreamFromFeed(id);
        // This dream is private again as of right now — give it a fresh
        // durable server-side copy (tracker item
        // for-product-build-p0-server-side-dream-p-zl3rb2), same reasoning
        // as every other private-dream mutation in this file.
        syncPrivateDreamBestEffort(d);
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
      // Unconditional (not just the !wasPublished case) — tracker item
      // for-product-build-p0-server-side-dream-p-zl3rb2. Safe/idempotent
      // either way (see lib/dream-store.js's own removePrivateDream doc
      // comment): a published dream should never have had a private-store
      // copy in the first place, but this is cheap insurance against that
      // ever having drifted (e.g. a prior best-effort delete on publish
      // silently failing).
      deletePrivateDreamBestEffort(id);
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
        if (!entry) return;
        // audioUrl/audioDurationMs/captions/captionsLevel — Speaking Sage
        // Option D additive fields (docs/SPEAKING_SAGE_SPEC.md §7). Present
        // only once generateInterpAudio below has actually completed for
        // this persona's reading; `undefined` on every existing reading
        // (no migration needed — see that spec section).
        out[key] = {
          text: entry.text, at: entry.at, qa: entry.qa || [],
          audioUrl: entry.audioUrl, audioDurationMs: entry.audioDurationMs,
          captions: entry.captions, captionsLevel: entry.captionsLevel
        };
      });
      return out;
    },

    /** See hasIntroShownFlag's own doc comment above for the full "why a sibling field, not nested" reasoning. Read-only; same ownership guard every other per-dream read in this file uses. */
    hasIntroShown: function (id, personaKey) {
      var d = findDream(id);
      var myHandle = state.user ? state.user.handle : null;
      if (!d || !myHandle || d.ownerHandle !== myHandle) return false;
      return hasIntroShownFlag(d, personaKey);
    },

    /** Marks `personaKey`'s one-time intro clip as shown for THIS dream — idempotent (a second call for an already-shown persona is a harmless no-op re-stamp of the same timestamp field). */
    markIntroShown: function (id, personaKey) {
      var d = findDream(id);
      var myHandle = state.user ? state.user.handle : null;
      if (!d || !myHandle || d.ownerHandle !== myHandle) return;
      if (!d.introShownPersonas) d.introShownPersonas = {};
      d.introShownPersonas[personaKey] = Date.now();
      persist();
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
        // operationName (the dream's server-issued job id) lets interpret-
        // dream.js record a durable server-side "this persona was read on
        // this dream" marker (lib/interp-read-store.js), the signal the two
        // interpretation retention emails need — keyed by the SAME id
        // result.html's watched-marker uses, so a dream's watched-state and
        // its interpretation-read-set line up. Null for a dream with no
        // sourceOperationName yet (a legacy/edge record); the server simply
        // skips the marker then. Sent ONLY on the reading call (a generated
        // reading is the "read" signal), never the questions call.
        body: JSON.stringify({ caption: d.storyText || d.caption, personaKey: personaKey, mode: 'reading', qa: qa || [], operationName: d.sourceOperationName || null })
      }).then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) throw new Error(data.error || 'E407: empty_or_invalid_response');
          var dream = findDream(id);
          var at = Date.now();
          if (dream) {
            var map = ensureInterpretationsMigrated(dream);
            map[personaKey] = { text: data.interpretation, at: at, qa: qa || [] };
            dream.updatedAt = at;
            persist();
            // Only for a still-private dream — a published dream's durable
            // copy is the shared feed, which never carries
            // interpretationText at all (see syncPublishedDreamToFeed's own
            // payload) — see this file's private-dream-sync section header
            // comment for the full "why".
            if (!dream.isPublished) syncPrivateDreamBestEffort(dream);
          }
          return { text: data.interpretation, at: dream ? at : null };
        });
      }, function (err) {
        throw new Error('network_error_requesting_interpretation' + (err && err.message ? ': ' + err.message : ''));
      });
    },

    /**
     * Speaking Sage Option D (docs/SPEAKING_SAGE_SPEC.md, tracker item
     * for-product-build-speaking-sage-wave-fou-8uobuh) — generates this
     * persona's per-reading voice track for a dream's ALREADY-GENERATED
     * reading `text` (generateInterpretationReading's own output — this
     * never re-generates the reading itself). Submits via
     * generate-interp-audio.js, then polls interp-audio-status.js to
     * completion — same submit-then-poll shape pollUntilDone (video/image)
     * already established in this file, tailored for this feature's own
     * "one poll cycle, operationName may change mid-flight" contract (see
     * that function's own header comment).
     *
     * On success, writes `audioUrl`/`audioDurationMs`/`captions`/
     * `captionsLevel` onto the SAME `interpretations[personaKey]` object
     * generateInterpretationReading above already wrote `text`/`at`/`qa`
     * onto (never overwriting those fields) and persists. Resolves
     * `{ audioUrl, audioDurationMs, captions, captionsLevel }`. On
     * failure, rejects with an Error the same "ENNN: reason" convention
     * every other function in this file uses — js/interpret-experience.js
     * treats this as a soft failure (interp_voice_tts_failed, reading
     * falls back to text-only), never a hard gate on the reading itself.
     *
     * Deliberately does NOT ownership-guard against `d` the way
     * generateInterpretationReading does at call time only — it
     * re-resolves+re-checks ownership at the WRITE point below (mirroring
     * generateInterpretationReading's own "the signed-in account could
     * have changed by the time this resolves" reasoning), since audio
     * generation is slower (a real TTS + alignment pipeline, not a single
     * LLM completion) and has more time to race a sign-out/switch.
     */
    generateInterpAudio: function (id, personaKey, text) {
      var d = findDream(id);
      var myHandle = state.user ? state.user.handle : null;
      if (!d || !myHandle || d.ownerHandle !== myHandle) return Promise.reject(new Error('not_found'));
      return fetch('/.netlify/functions/generate-interp-audio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dreamId: id, personaKey: personaKey, text: text })
      }).then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) throw new Error(data.error || 'E506: tts_request_failed');
          // Sync-first path (generate-interp-audio.js, 2026-08-04): the
          // function now usually returns the FINISHED result in one round
          // trip — no polling at all, the voice can start immediately.
          // The { operationName } shape remains the queue-fallback path.
          if (data.done && data.audioUrl) {
            return {
              audioUrl: data.audioUrl,
              audioDurationMs: typeof data.audioDurationMs === 'number' ? data.audioDurationMs : null,
              captions: Array.isArray(data.captions) ? data.captions : [],
              captionsLevel: data.captionsLevel === 'word' ? 'word' : 'sentence'
            };
          }
          return pollInterpAudioUntilDone(data.operationName);
        });
      }, function (err) {
        throw new Error('network_error_requesting_interp_audio' + (err && err.message ? ': ' + err.message : ''));
      }).then(function (result) {
        var dream = findDream(id);
        var currentHandle = state.user ? state.user.handle : null;
        if (dream && currentHandle && dream.ownerHandle === currentHandle) {
          var map = ensureInterpretationsMigrated(dream);
          var entry = map[personaKey] || { text: text, at: Date.now(), qa: [] };
          entry.audioUrl = result.audioUrl;
          entry.audioDurationMs = result.audioDurationMs;
          entry.captions = result.captions;
          entry.captionsLevel = result.captionsLevel;
          map[personaKey] = entry;
          persist();
        }
        return result;
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
        return decorateFeedDreams(data.feed || []);
      });
    },

    /**
     * Adds the SAME per-viewer mine/likedByMe/blockedByMe flags
     * getSharedFeed() above computes, to an already-fetched array of raw
     * shared-feed dream records — for callers that fetch a dream list from
     * a DIFFERENT server endpoint returning the same raw record shape (get-
     * feed.js's own `feed` entries) rather than through getSharedFeed()
     * itself. Added for u.html (Social Layer v2 slice 1): get-profile.js
     * returns a server-filtered `dreams` array (already scoped to one
     * ownerHandle), and re-fetching the ENTIRE shared feed just to get
     * these three local flags would be wasteful. Pure/synchronous — no
     * network call of its own.
     */
    decorateFeedDreams: function (dreams) {
      return decorateFeedDreams(dreams || []);
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

    // ===== Follow user (Social Layer v2 slice 3 "follow" —
    // docs/SOCIAL_LAYER_V2_DESIGN.md, tracker item
    // for-product-build-social-layer-v2-direct-34047c) =====

    /**
     * Fetches the CURRENTLY signed-in account's own following list +
     * follower count from the durable server-side store (netlify/functions/
     * get-following.js/lib/follow-store.js). Both are OWNER-ONLY private
     * data (see that endpoint's own header comment for why there is no
     * `handle` param at all — identity resolves 100% from
     * state.user.authToken) — this is never used to look up anyone ELSE's
     * following list or follower count. Resolves to
     * { following:[...handles], followerCount:N } (both empty/0 when
     * logged out, signed in with no authToken on file, or on any fetch
     * failure — same honest-degrade posture as syncBlockedHandlesFromServer).
     * Never rejects.
     */
    getFollowStatus: function () {
      if (!state.user || !state.user.authToken) return Promise.resolve({ following: [], followerCount: 0 });
      return fetch('/.netlify/functions/get-following?authToken=' + encodeURIComponent(state.user.authToken))
        .then(function (res) { return res.json(); })
        .then(function (data) {
          return {
            following: (data && data.ok && Array.isArray(data.following)) ? data.following : [],
            followerCount: (data && data.ok && typeof data.followerCount === 'number') ? data.followerCount : 0
          };
        }).catch(function () { return { following: [], followerCount: 0 }; });
    },

    /**
     * Toggles follow/unfollow against `targetHandle` (e.g. "@luna") for the
     * CURRENTLY signed-in account — netlify/functions/follow-user.js.
     * Returns a Promise of { following:bool }, or REJECTS on a real failure
     * (not signed in, network error, invalid/expired token, self-follow) —
     * deliberately NOT the "never rejects" honest-degrade shape
     * getFollowStatus/blockUser use above: unlike a background list
     * hydration, a follow toggle's caller (u.html's own Follow button) needs
     * to KNOW when it failed so it can roll back the optimistic
     * Follow/Following flip it already applied — same "resolve on real
     * success, reject otherwise" contract as toggleSharedLike.
     */
    toggleFollow: function (targetHandle, currentlyFollowing) {
      if (!state.user || !state.user.authToken) return Promise.reject(new Error('not_signed_in'));
      return fetch('/.netlify/functions/follow-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ authToken: state.user.authToken, targetHandle: targetHandle, action: currentlyFollowing ? 'unfollow' : 'follow' })
      }).then(function (res) { return res.json(); })
        .then(function (data) {
          // Checks `data.error` too, not just `data.ok === false` -- an
          // HTTP-level failure (e.g. a 500) returns a bare `{error:...}`
          // body with no `ok` field at all (see follow-user.js's own error
          // shapes), which `data.ok === false` alone would miss entirely
          // and silently treat as success. Mirrors toggleSharedLike's own
          // `data.error` check above for the identical reason.
          if (!data || data.error || data.ok === false) throw new Error((data && data.error) || 'follow_toggle_failed');
          return { following: data.following };
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

    // ===== Public-profile bio (Social Layer v2 slice 1) =====
    // Local-first, per-account cache — see state.profileBioByUser's own
    // doc comment for why this isn't folded into saveCharacter's isSelf
    // record. The server-side dreamtube-profiles record (what u.html
    // actually renders) is only ever updated via syncProfileToServer,
    // which reads this same local cache — call setMyBio, THEN
    // syncProfileToServer, same two-step "write local, sync best-effort"
    // shape saveCharacter/syncPublishedDreamToFeed already use.

    /** This account's own bio, or '' if unset/logged out. */
    getMyBio: function () {
      if (!state.user) return '';
      return state.profileBioByUser[state.user.username.toLowerCase()] || '';
    },

    /**
     * Sets this account's own bio (trimmed, capped at BIO_MAX_CHARS — IG
     * parity, matches sync-profile.js's own server-side cap). Returns
     * { ok:true } or { ok:false, error }. Does NOT itself call
     * syncProfileToServer — callers (profile.html's Edit-profile save)
     * chain that explicitly, same as every other local-write-then-sync
     * pair in this file.
     */
    setMyBio: function (bio) {
      if (!state.user) return { ok: false, error: 'not_logged_in' };
      var trimmed = (bio || '').trim();
      if (trimmed.length > BIO_MAX_CHARS) return { ok: false, error: 'Bio must be ' + BIO_MAX_CHARS + ' characters or fewer.' };
      state.profileBioByUser[state.user.username.toLowerCase()] = trimmed;
      persist();
      return { ok: true };
    },

    /** See syncProfileToServer's own doc comment above. */
    syncProfileToServer: syncProfileToServer,

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
     * Whether dreamtube_sound_on has ever been WRITTEN by a real tap on a
     * mute/unmute control, as distinct from getSoundPref()'s own boolean
     * return — that only reports the current effective value, and reads
     * `false` both for "explicitly muted" and "never touched, defaulted to
     * muted," which look identical from the outside. Added for tracker
     * item for-product-p1-founder-repro-08-04-12-40-6icx89: used solely to
     * gate the one-time sound-discoverability nudge below, which only
     * makes sense for someone who has never had a reason to notice the
     * mute control exists (see hasSeenSoundNudge's own doc comment for the
     * full story of why that nudge exists at all).
     */
    hasEverSetSoundPref: function () {
      try { return localStorage.getItem('dreamtube_sound_on') !== null; }
      catch (e) { return true; } // fail closed -- can't reliably track "seen" either without storage, so don't nudge
    },

    /**
     * Device-level "has this device already been shown the one-time
     * sound-discoverability nudge" marker (tracker item
     * for-product-p1-founder-repro-08-04-12-40-6icx89). Music beds
     * (js/music-bed.js) are the first real audio this app has ever
     * shipped — every video before 2026-08-04 was permanently silent
     * (generate_audio:false), so getSoundPref's mute-by-default above was
     * harmless: nobody ever had a reason to tap unmute, since there was
     * nothing to hear either way. Now it silently mutes the one thing
     * worth hearing, for virtually the entire installed base, with no
     * affordance telling anyone sound exists. result.html/explore.html
     * show a brief toast + a short pulse on the existing mute icon (no new
     * modal/banner — the mute button itself already works and already
     * shows the honest current state, so this only needs to point at it)
     * the first time a bed-eligible video is shown to a visitor who has
     * never touched sound (hasEverSetSoundPref() false) and has never
     * seen this nudge before. Gated as its OWN separate flag (not folded
     * into hasEverSetSoundPref) so the nudge still fires exactly once per
     * device even though a visitor can see it more than once without
     * touching sound (e.g. two different bed-eligible dreams back to
     * back) before hasEverSetSoundPref() would otherwise catch up.
     * Device-level (not account-scoped) for the same reason as
     * getSoundPref/getSeenDreamOfDayId — sound is a property of the
     * device/browser, not of whichever account happens to be signed in.
     */
    hasSeenSoundNudge: function () {
      try { return localStorage.getItem('dreamtube_sound_nudge_seen') === '1'; }
      catch (e) { return true; } // fail closed -- same reasoning as hasEverSetSoundPref
    },
    markSoundNudgeSeen: function () {
      try { localStorage.setItem('dreamtube_sound_nudge_seen', '1'); }
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
     *
     * MEASURE (tracker item for-product-install-first-door-founder-d-
     * b60cls): this flag flipping true used to be silent — no PostHog event
     * fired anywhere, so "install-verified rate" had no way to become an
     * actual retention-sprint scoreboard number even though the underlying
     * signal was already real and durable. markInstallVerified now fires a
     * guarded install_verified capture (same defensive try/catch pattern
     * every other posthog call in this file already uses — e.g.
     * setCurrentUser's identify/alias calls above) the one time it actually
     * transitions false -> true, carrying `source` (js/pwa.js's two real
     * triggers: 'standalone_load' or 'appinstalled') through as a prop so
     * the two completion paths stay distinguishable in PostHog. Extends the
     * existing install_* taxonomy (install_nudge_shown/dismissed/outcome in
     * js/install-nudge.js) rather than inventing a separate one.
     */
    getInstallVerified: function () {
      if (!state.user) return false;
      var account = state.accounts[state.user.username.toLowerCase()];
      return !!(account && account.installVerified);
    },
    markInstallVerified: function (source) {
      if (!state.user) return false;
      var key = state.user.username.toLowerCase();
      var account = state.accounts[key];
      if (!account || account.installVerified) return false;
      account.installVerified = true;
      persist();
      if (typeof window !== 'undefined' && window.posthog && typeof window.posthog.capture === 'function') {
        try { window.posthog.capture('install_verified', { source: source || 'unknown' }); }
        catch (e) { /* analytics must never break the app */ }
      }
      return true;
    },

    /**
     * Per-account "Make DreamTube yours" install-bonus claimed flag
     * (tracker item for-product-build-ship-founder-approved--9ta1j0, "Home
     * round 4"). The real, once-ever grant of the +20 token reward lives
     * server-side (claim-install-bonus.js -> lib/entitlements.js's
     * applyAchievementGrant, the SAME idempotent once-per-account-per-id
     * marker pattern FIRST_CLAIM_BONUS_AMOUNT/the achievement ledger
     * already use) — this is only a LOCAL mirror of "did this account's
     * claim already land," so home.html can render the card's done-state
     * (and, on a later visit, hide the card entirely — per the mock's own
     * "This card says goodbye — it won't be here next visit") without an
     * extra network round trip on every load. Scoped to
     * state.accounts[key], the same per-account (not device-level, not a
     * bare localStorage key) pattern getInstallVerified/noRecallDates
     * already use above — see tracker item
     * recurring-pattern-new-features-re-introd-dhfty9 for exactly the
     * mistake (an unscoped localStorage dedup key on a shared browser)
     * this is written to avoid repeating.
     */
    getInstallBonusClaimed: function () {
      if (!state.user) return false;
      var account = state.accounts[state.user.username.toLowerCase()];
      return !!(account && account.installBonusClaimed);
    },
    markInstallBonusClaimed: function () {
      if (!state.user) return;
      var key = state.user.username.toLowerCase();
      var account = state.accounts[key];
      if (!account) return;
      account.installBonusClaimed = true;
      persist();
    },

    /**
     * Claims the "Make DreamTube yours" verified-install +20 token bonus
     * — thin wrapper around POST claim-install-bonus.js, same shape as
     * claimDailyTokens above. The server enforces the real once-per-account
     * grant (lib/entitlements.js's applyAchievementGrant); this call is
     * only reachable from the UI once DreamStore.getInstallVerified() is
     * already true (home.html's own gate on the claim button — a verified
     * standalone-launch signal, "client-attested is an accepted signal at
     * this reward size" per the tracker item), so THIS function doesn't
     * re-check installVerified itself — same division of responsibility
     * claimDailyTokens has with its own server-side cooldown.
     *
     * Resolves `{ granted: true, balance }` on a fresh grant, or
     * `{ granted: false }` if this account already claimed it (a safe,
     * expected no-op, not an error — mirrors applyAchievementGrant's own
     * `granted:false` semantics) — either way marks the local
     * installBonusClaimed mirror above so the card retires. Resolves
     * `{ granted: false }` with no network call when there's no logged-in
     * account or no email on file, matching claimDailyTokens' identical
     * "nothing to key a claim on" guard.
     */
    claimInstallBonus: function () {
      var email = currentAccountEmail();
      if (!email) return Promise.resolve({ granted: false });
      return fetch('/.netlify/functions/claim-install-bonus', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email })
      })
        .then(function (res) { return res.json(); })
        .then(function (data) {
          if (data.error) throw new Error(data.error);
          if (state.user) { // mark the local mirror regardless of granted:true/false -- both mean "this account is done claiming"
            var key = state.user.username.toLowerCase();
            var account = state.accounts[key];
            if (account) { account.installBonusClaimed = true; persist(); }
          }
          return data;
        });
    },

    /**
     * Per-account "Tip of the day" rotation state (tracker item
     * for-product-build-ship-founder-approved--9ta1j0). Home.html owns the
     * actual tip CONTENT (the 10 approved tips, verbatim from
     * home-mock5-x7q4.html) — this only persists which ones this account
     * has already seen, so store.js doesn't need to hardcode copy it
     * doesn't own. Scoped to state.accounts[key], same per-account pattern
     * as every other field on this doc block (see
     * recurring-pattern-new-features-re-introd-dhfty9 above).
     *
     * Returns `{ currentId, seenIds }` — `currentId` is null the very
     * first time this account has ever seen the card (nothing shown yet);
     * home.html calls advanceTipOfDay once to seed a real first tip in
     * that case, the same "unseen-first" pick advanceTipOfDay always makes
     * from a seenIds:[] start.
     */
    getTipOfDayState: function () {
      if (!state.user) return { currentId: null, seenIds: [] };
      var account = state.accounts[state.user.username.toLowerCase()];
      if (!account) return { currentId: null, seenIds: [] };
      return { currentId: account.tipCurrentId || null, seenIds: (account.tipsSeenIds || []).slice() };
    },
    /**
     * Advances to the next UNSEEN tip and persists it as this account's
     * current one. `allTipIds` is the caller's own full, ordered list of
     * tip ids (home.html's TIPS array) — passed in rather than hardcoded
     * here, since this file doesn't own the tip content. Unseen-first: the
     * first id in `allTipIds` not yet in the account's seen set wins; once
     * every id has been seen, the cycle restarts (seenIds resets to just
     * the freshly-shown tip) rather than leaving the rotation stuck.
     * Returns the new currentId, or null if not logged in.
     */
    advanceTipOfDay: function (allTipIds) {
      if (!state.user || !Array.isArray(allTipIds) || !allTipIds.length) return null;
      var key = state.user.username.toLowerCase();
      var account = state.accounts[key];
      if (!account) return null;
      var seen = account.tipsSeenIds || [];
      var unseen = allTipIds.filter(function (id) { return seen.indexOf(id) === -1; });
      var pool = unseen.length ? unseen : allTipIds; // every tip already seen this cycle -- restart
      var nextId = pool[0];
      account.tipsSeenIds = unseen.length ? seen.concat([nextId]) : [nextId];
      account.tipCurrentId = nextId;
      persist();
      return nextId;
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
     * already-cached local password — the "no new re-auth prompt, the
     * password is already on hand" pattern (state.accounts[key].password,
     * the same plaintext-local account model every other DreamStore method
     * relies on). Resolves the raw token string on success, or null on
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
     * mechanism (220 on first-ever read; the daily grant — 20 per claim,
     * including the first-ever claim as of the 2026-08-08 retune, see
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
      // a purchase, so shop.html's welcome-offer hero (the one-time $0.99
      // starter pack) is safe to show (see that page's own script for how
      // it uses this field).
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
     * Best-effort client-side "frame 1" thumbnail capture (tracker item
     * for-product-dream-ready-email-real-first-qr9fbj — founder request: a
     * real first-frame image in the "your dream is ready" retention email
     * instead of the flat colored placeholder banner). result.html owns
     * drawing the <video> element's own already-decoded current frame to a
     * <canvas> and encoding it (once autoplay has genuinely advanced past
     * a moment, avoiding a black pre-decode frame — see that file's own
     * capture IIFE for exactly when) — this function owns everything past
     * that: the upload, the local dream.imageUrl write, and the existing
     * dream-sync upsert (HTML owns the DOM-specific bit, store.js owns the
     * network/state bit).
     *
     * Server-side frame extraction was ruled out (impractical inside a
     * Netlify Function) and a second paid fal image-generation call per
     * video was ruled out (real ongoing spend not worth it for a cosmetic
     * email detail) — see the tracker item's own investigation notes. The
     * synced imageUrl this captures is what the "unwatched dream" retention
     * nudge (send-unwatched-dream-nudges.js) later reads by correlating the
     * dream's sourceOperationName, so a captured thumbnail lands in that
     * email; a dream whose thumbnail never syncs is simply dropped from the
     * nudge rather than emailed thumbnail-less (see that scan's header
     * comment).
     *
     * Every failure mode here (not signed in, dream not found/not this
     * account's own, imageUrl already set, upload-dream-thumbnail.js
     * rejecting/erroring, a network failure) is a silent, harmless no-op
     * — never throws, never surfaces anything to the user. A dream that
     * never gets a captured thumbnail simply keeps using the color-banner
     * fallback forever, the same honest degrade every other best-effort
     * call in this file already accepts.
     */
    saveThumbnailBestEffort: function (dreamId, imageDataUrl) {
      if (!state.user || !state.user.authToken || !dreamId || !imageDataUrl) return;
      var dream = findDream(dreamId);
      if (!dream || dream.ownerHandle !== state.user.handle || dream.imageUrl) return;
      try {
        fetch('/.netlify/functions/upload-dream-thumbnail', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ authToken: state.user.authToken, dreamId: dreamId, imageDataUrl: imageDataUrl })
        }).then(function (res) {
          return res.json().catch(function () { return null; });
        }).then(function (body) {
          if (!body || !body.ok || !body.url) return;
          // Re-resolve + re-check fresh, not the closed-over `dream` above
          // — the round trip could have raced an edit/regenerate/delete,
          // or a second tab's own concurrent capture already won. Same
          // defensive re-check discipline as this file's other best-effort
          // setters (e.g. finalizeDream's own idempotent-redundant guard).
          var d = findDream(dreamId);
          if (!d || d.ownerHandle !== state.user.handle || d.imageUrl) return;
          d.imageUrl = body.url;
          d.updatedAt = Date.now();
          persist();
          if (!d.isPublished) {
            syncPrivateDreamBestEffort(d);
          } else {
            syncPublishedDreamToFeed(d);
          }
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
     * cached local credential (state.accounts[key].password) — the same
     * "no new re-auth prompt, the password is already on hand" pattern
     * requestSessionTransferToken above uses — rather than asking for a
     * password a second time in a form, since admin.html (this method's only
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
     * Records, server-side, that the user actually WATCHED their fresh
     * video result -- fire-and-forget, POST
     * /.netlify/functions/mark-result-viewed { operationName }. This is the
     * suppression signal for the "unwatched dream" retention nudge: the
     * scheduled scan (send-unwatched-dream-nudges.js) can't read the client-
     * only `first_video_result_view` PostHog event or any localStorage flag,
     * so it needs this durable server marker to tell a watched dream from an
     * unwatched one. Called from result.html's openFullscreenVideo -- i.e.
     * the ENGAGED watch (opening the fullscreen player), NOT the mere page
     * render, since the render is also what captures the thumbnail and would
     * make "thumbnail available AND unwatched" impossible (see
     * mark-result-viewed.js's header comment). `operationName` is the dream's
     * own `sourceOperationName` (the server-issued job id) -- a legacy dream
     * with none simply never marks (nothing to key on), an honest no-op.
     * keepalive so a mark issued as the player opens still completes even if
     * the page is navigated moments later.
     */
    markResultViewed: function (operationName) {
      if (!operationName) return;
      try {
        fetch('/.netlify/functions/mark-result-viewed', {
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
