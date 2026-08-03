# Test Registry

A living map of **feature/surface → what actually covers it → known
gaps**, seeded honestly from the real feature set as of 2026-08-01 (not
an aspirational list) — see `docs/JOURNEY_MANIFEST.md`, `home.html`, and
`netlify/functions/*.js` for the source of truth this was built against.
Gaps are listed on purpose, not papered over.

**Discipline rule (see `AGENT_POLICY.md`'s build/review sections):** a
feature merge must update this file's relevant row(s) — new coverage
added, or what's covered redefined — as part of that same merge. `review`
checks this happened.

Two kinds of automated coverage exist in this repo, and most rows below
cite one or both:

- **`test/*.test.js`** (`npm test`) — mocked backend, runs against a local
  static server. Proves the app's own client/server logic is correct in
  isolation. This is the vast majority of this repo's test coverage.
- **`test/prod-smoke/*.test.js`** (`npm run smoke:prod`) — real backend,
  runs against a real origin (default production). Proves the currently
  *deployed* site actually works end to end for a real new user. Deliberately
  thin — a handful of end-to-end flows, not exhaustive per-feature coverage
  (see that directory's own `README.md`).

A row with only `test/*.test.js` coverage and no prod-smoke row is
**normal, not a gap** — prod-smoke is intentionally narrow. A row with
**no coverage at all** is a real gap, called out as such.

## Auth & accounts

| Feature/surface | Covered by | Gaps |
|---|---|---|
| Signup (`register-account.js`, `js/store.js#signup`) | `test/signup-screen-behavioral.test.js`, `test/funnel-real-chain-behavioral.test.js`, `test/facebook-login-signup-behavioral.test.js`, `test/account-store.test.js`, `test/wizard-ui-behavioral.test.js` | — |
| Screen 13 'reveal' challenger — forming veil, "Send me my dream" copy, save-framing reassurance, graceful preview degradation (tracker item `for-product-build-now-email-wall-fix-1-n-6qvebd`, mock-only — `SIGNUP_REVEAL_CHALLENGER_LIVE` is `false`) | `test/signup-reveal-variant-behavioral.test.js` | Not yet live in the real A/B (founder must approve the mock — `reveal-variant-mock-x7q4.html` — first); no PostHog experiment-readout coverage since nothing is actually splitting real traffic yet |
| Passwordless signup — email-only entry, no password ever (`register-account-passwordless.js`, `js/store.js#signupPasswordless`, `start.html`'s `renderScreen13Passwordless`, tracker item `for-product-build-passwordless-signup-fo-at2fko`, founder-decided hybrid, mock-only — `SIGNUP_PASSWORDLESS_LIVE` is `false`) | `test/passwordless-signup.test.js` (create-vs-resolve identity resolution, offline-fallback local commit shape, rate limiting), `test/signup-passwordless-behavioral.test.js` (real Chromium run: no password field ever rendered, email-only submit, reaches screen 14, CompleteRegistration fires exactly once at the same depth via the real `track-conversion.js` call — see `docs/EVENT_TAXONOMY.md` — local state has `password:null`/`emailVerified:false`, the deferred-sheet session marker is pre-set, and undeliverable-email validation) | Not yet live for real traffic (feature-flagged off, same posture as the 'reveal' challenger above — no mock-review artifact exists for this arm yet, unlike 'reveal's `reveal-variant-mock-x7q4.html`, since the founder's own spec (his exact words, tracker item body) already fully specified the UI shape rather than leaving it to a design pass); no `test/prod-smoke/` coverage (payments/signup-variant paths are out of that suite's intentionally narrow scope, same as every other signup arm) |
| **SECURITY FIX, 2026-08-02** (round-2 independent review finding, real, fixed same day): the RESOLVE branch (an already-registered email POSTed to `register-account-passwordless.js`) used to mint a fully usable `authToken` with ZERO proof the caller controlled that inbox — a one-request account takeover of any existing account, given only its email address. Fixed: that branch now sends a fresh code/link and returns NO authToken/username at all (`pendingVerification:true`); a real session is only ever granted via the NEW `login-with-email-code.js` endpoint (a genuine login, mailed-code-as-credential) or a clicked `verify-email-link.js` link (which now also mints a `lib/session-transfer-token.js` token, same mechanism `facebook-oauth-callback.js` already uses once IT has proven identity, redirecting to `/home.html` — the one page that already consumes `?bt=` — instead of the old default `/profile.html`, which never did). `start.html`'s passwordless arm gained a new inline code-entry step (`renderCodeStep`) for this branch. See `netlify/functions/register-account-passwordless.js`'s own header comment for the full incident writeup. | `test/passwordless-signup.test.js` (the exact attacker scenario: a caller who is not the account's owner gets no authToken/username, the victim's own original token is completely undisturbed; `login-with-email-code.js`'s full error surface incl. no-enumeration between "wrong code" and "no such account"; `verify-email-link.js`'s `bt` token is real and independently consumable via `verify-session-transfer.js`), `test/signup-passwordless-behavioral.test.js` (real Chromium: an already-registered email shows the code step and leaves the browser genuinely signed OUT, a correct code completes login WITHOUT firing CompleteRegistration, a wrong code shows an inline error and never advances) | — |
| Deferred email verification — 6-digit code (`verify-email-code.js`, `resend-verification-code.js`, `login-with-email-code.js` for the security-fix login-via-code path above), implicit verification via clicked email link (`verify-email-link.js`), the "next visit" deferred-prompt sheet (`js/email-verify-sheet.js`, wired on `home.html`), `lib/email-verification-store.js` | `test/passwordless-signup.test.js` (code correctness incl. attempt-limiting, authToken-only identity for `verify-email-code.js` — never a client-claimed username, link-token single-use, open-redirect guard on `verify-email-link.js`'s `redirect` param, resend no-op-if-already-verified), `test/email-verify-sheet-behavioral.test.js` (real Chromium run against home.html: the sheet auto-opens for an unverified account on a fresh visit, a correct code marks it verified and shows the confirmation view, a wrong code shows an inline error without closing, "Resend code" calls the real endpoint, a verified/password-based account is never shown the prompt, and the session-already-offered marker correctly suppresses a repeat show) | The "before publish"/"before purchase" DEFERRED-PROMPT triggers (as opposed to the server-side GATE, which both enforce — see the gate-list row below) are not wired to interactively open `js/email-verify-sheet.js` in this pass — only the "next visit" trigger is; publish is fire-and-forget client-side (see `js/store.js`'s `syncPublishedDreamToFeed`) so has no reaction point today. `shop.html`'s E10 branch DOES open the sheet reactively (see that file's `purchasePack`), but has no dedicated behavioral/Playwright test of its own yet — only the server-side E10 rejection is covered above. |
| Gate list — accounts with `emailVerified:false` are blocked from purchasing (`create-checkout-session-dodo.js`, E10) and publishing to the shared feed (`publish-dream.js`, E8); every pre-existing account-creation path (`register-account.js`, `facebook-oauth-callback.js`) is unaffected/still defaults to verified — see `lib/account-store.js`'s own GATE LIST header comment for the authoritative, exhaustive list | `test/passwordless-signup.test.js` | — |
| Bounce handling — Resend `email.bounced` webhook, hard (Permanent) bounces only, flags `emailBounced` (`resend-bounce-webhook.js`, `lib/resend-webhook-verify.js`) | `test/resend-bounce-webhook.test.js` (real, locally-computed Svix/HMAC-SHA256 signatures — the actual algorithm, not a stubbed-out check) | **Cannot be exercised end-to-end against real Resend** — no live Resend account/webhook subscription in this sandbox; someone with Resend dashboard access still needs to register this endpoint's URL as a webhook (subscribed to `email.bounced`) and set `RESEND_WEBHOOK_SECRET` in Netlify before it ever receives a real delivery — same "can't do this from the sandbox" class as Dodo/Netlify-env-var setup elsewhere in this registry. `emailBounced` is also currently informational only — nothing in this codebase yet refuses an action off it. |
| Login (`account-login.js`) | `test/account-store.test.js`, `test/rename-migration-login-behavioral.test.js`, `test/facebook-login-signup-behavioral.test.js`, `test/password-reset-account.test.js` | — |
| Facebook Login / OAuth (`facebook-oauth-callback.js`, `facebook-complete-signup.js`) | `test/facebook-oauth-callback.test.js`, `test/facebook-login-signup-behavioral.test.js`, `test/account-store-facebook.test.js` | — |
| Password reset (`request-password-reset.js`, `verify-password-reset.js`) | `test/password-reset-account.test.js` | — |
| Account deletion (`delete-account.js`) | `test/delete-account.test.js`, `test/delete-account-behavioral.test.js` | `test/prod-smoke/session.test.js` (real delete, used for its own probe-account cleanup — proves the endpoint works against real prod, not a dedicated feature test) |
| Auth tokens (`lib/account-auth-token.js`) | `test/account-auth-token.test.js` | — |
| Cross-device session transfer (`create-session-transfer.js`, `verify-session-transfer.js`) | `test/session-transfer.test.js`, `test/session-transfer-behavioral.test.js` | — |
| Account rename/consolidation (one-off admin tools) | `test/admin-diagnose-rename-conflict.test.js`, `test/consolidate-accounts-client-migration-behavioral.test.js`, `test/admin-restore-founder-email.test.js` | These are one-off hardcoded tools per `AGENT_POLICY.md`'s "remove one-off admin panels after use" policy — coverage is expected to be retired alongside the tool itself, not maintained indefinitely. |

## Onboarding funnel (`docs/JOURNEY_MANIFEST.md`)

| Feature/surface | Covered by | Gaps |
|---|---|---|
| Journey sequence itself (both journeys' documented screen order) | `test/journey-manifest.test.js` (source-level, pins `SCREEN_RENDERERS`) | — |
| Journey 1 entry render, live on a real deployed origin | `test/prod-smoke/journey1-funnel-render.test.js` | Only checks screen 13 renders — doesn't complete a second full signup (see that file's own header comment for why) |
| Journey 1 full flow (`start.html`) | `test/funnel-signup-navigation-token-guard-behavioral.test.js`, `test/funnel-meta-attribution-cookies-behavioral.test.js`, `test/facebook-login-signup-behavioral.test.js` | — |
| Journey 2 full flow (`wizard.html`, organic) | `test/wizard-ui-behavioral.test.js`, `test/wizard-chips.test.js`, `test/wizard-action-chip-curation-behavioral.test.js`, `test/wizard-photo-upload-sheet-token-behavioral.test.js`, `test/record-mode-behavioral.test.js` | — |
| Subject step (Step 1, "Who's the dream about?") multi-select — tracker item `for-product-wizard-characters-step-is-si-paxp07`, founder repro 2026-08-02: selecting a character then adding another used to UNCHECK the first (single-active-subject model treated as one-choice). Fixed to real independent toggles: any number of staged characters (`staged.subjectCharacterIds`) compose with at most one of the four "other" chips (`subjectOtherKind`, still single-select among just those four) — see `wizard.html`'s own design note above `renderSubject` for the full reasoning and `js/wizard-chips.js`'s doc comment for the new `subjects`-array input `assembleCaption`/`buildDeterministicStory` both accept (create.html's own separate single-select "Build it" subject step is unaffected — still uses the old singular fields, still covered above) | `test/wizard-chips.test.js` (unit-level `subjects`-array coverage: single-entry array matches the singular path byte-for-byte, the founder's own 3-subject worked example, a photo character combined with described characters — correct phrase/id split preserved per-entry, 2-subject "and" joining, empty-array fallback, `buildDeterministicStory`'s equivalent "with X, Y and Z" joining incl. the "me" + one-other "with" upgrade), `test/wizard-ui-behavioral.test.js` (3 tests: selecting Me + "Someone I know" + "A stranger" all stay selected together — the literal founder example; deselecting one of several via a toggle-off tap then re-selecting it via a DIRECT `#subject-chip-row` chip tap, independent of the character-sheet path; the full end-to-end trace — all three selections reaching the real `start-pending-generation.js` POST body's `caption`/`characters`/`characterIdsForGeneration`, not just DOM selected-state), `test/sheet-dismiss-behavioral.test.js` (section 7c — the same founder scenario exercised through a NORMALLY-opened character sheet, regression coverage for the interaction with the 75ob70 sheet-dismiss fix, since this exact step was that fix's own originally-reported instance) | — |
| Entry-routing guard: a logged-out visitor with stale local account history (a browser that already held a real account, even after logout — `DreamStore.hasLocalAccountHistory()`) never lands mid-funnel/wizard, always the welcome/choice screen (`index.html`) instead — tracker item `for-product-life-origin-generate-handoff-founder-repro-8yc4wm` | `test/life-origin-generate-handoff-behavioral.test.js`, `test/route-organic-to-wizard-behavioral.test.js` (genuinely-first-time-visitor control case) | — |
| Journey 2 full flow, live, real backend, real probe account | `test/prod-smoke/session.test.js` (test 1) | — |
| Generate-during-signup real chain (client → real server handlers) | `test/funnel-real-chain-behavioral.test.js` | — |
| Email deliverability/availability check (`check-email.js`) | `test/check-email.test.js`, `test/email-domain-check.test.js` | — |
| Pending-generation adoption (`start-pending-generation.js`, `claim-pending-generation.js`, `pending-dreams.js`) | `test/pending-dreams.test.js`, `test/funnel-real-chain-behavioral.test.js`, `test/claim-and-verify-pending.test.js` | — |
| A2HS / install nudge | `test/a2hs-install-nudge-journey-behavioral.test.js`, `test/install-first-door-behavioral.test.js` | — |
| A2HS small nudge card (`js/install-nudge.js`) — "install" vs "add to your home screen" CTA-copy unification, matching its own head's phrasing | `test/home-hero-whisper-mky-copy-behavioral.test.js` | — |

## Home (`home.html`, 2026-08-01 module set)

| Feature/surface | Covered by | Gaps |
|---|---|---|
| Overall page / round-4 rebuild | `test/home-behavioral.test.js`, `test/home-round4-behavioral.test.js` | — |
| Day-0/active dream room card (`#day0-card`) | `test/home-day0-dream-card-behavioral.test.js`, `test/edit-regeneration-forming-state-behavioral.test.js` | — |
| Ritual module's daily claim button + bonus-tokens countdown (`#ritual-claim`/`#ritual-countdown`) — the countdown ("Next N free tokens in Xh Ym") re-added inside the ritual module itself (tracker item `for-product-bonus-tokens-countdown-vanis-qm96xc`, founder feedback: it had quietly dropped out of an earlier "Home round N" rebuild), lives INSIDE `#ritual` rather than as a separate page element, hides while claimable (the claim button takes its spot), and ticks live via a 60s interval that re-fetches once `nextClaimAt` actually passes (same pattern as `shop.html`'s `#shop-countdown`) | `test/home-behavioral.test.js` | — |
| `?generate=1` fresh-in-app-generation handoff — the room card/Tonight-hero must show forming IMMEDIATELY on a brand-new (non-edit) submission, not only once the real pendingJob lands seconds later (worst on a first-ever-on-this-browser-origin account, where nothing else on Home hints anything is happening) — tracker item `for-product-life-origin-generate-handoff-founder-repro-8yc4wm` | `test/life-origin-generate-handoff-behavioral.test.js` | — |
| Tonight hero "empty sky" — moon + cycling whisper only, no streak-sky/constellation stars (dropped per founder amendment, tracker item `for-product-build-ship-today-founder-app-zn9zyy`; the ritual module's own constellation is unaffected, still covered below) — plus the whisper's own no-overlap-at-any-viewport guarantee | `test/home-hero-whisper-mky-copy-behavioral.test.js` | — |
| Tip of the Day, Get Inspired, Consider Publishing, Make It Yours, ritual/streak module — as a set, live on a real deployed origin | `test/prod-smoke/session.test.js` (test 2) | Per-module deep behavioral coverage (copy variants, edge/empty states, exact interaction details) is NOT this suite's job — check for a dedicated `test/*.test.js` file per module before assuming full coverage; several of these modules (Get Inspired, ritual/streak beyond the daily claim itself) currently have **no dedicated `test/*.test.js` file** of their own — home-behavioral/home-round4-behavioral cover the page broadly, not module-by-module |
| Make It Yours — "install" vs "add to your home screen" copy unification (reward line, done-state, inline install-row CTA + its supporting text, webview-fallback note) — tracker item `for-product-build-ship-today-founder-app-zn9zyy` | `test/home-hero-whisper-mky-copy-behavioral.test.js` | — |
| Bottom dock (`js/bottom-nav.js`, "Bar A") | `test/barA-nav-rollout-behavioral.test.js` | — |
| Webview escape nudge | `test/home-webview-escape-behavioral.test.js` | — |

## Generation (video/image)

| Feature/surface | Covered by | Gaps |
|---|---|---|
| `generate-video.js` (prompt build, guardrails, model rotation/config, tokens, Turnstile) | `test/generate-video-build-prompt.test.js`, `test/generate-video-model-rotation.test.js`, `test/generate-video-model-config.test.js`, `test/generate-video-tokens.test.js`, `test/generate-video-turnstile.test.js`, `test/generate-video-audio-toggle.test.js`, `test/generate-video-image-to-video.test.js` | — |
| Audio/dialogue generation — `generate_audio` unconditionally `false` for EVERY video generation path (`generate-video.js`'s plain/reference-to-video/image-to-video/PixVerse-rotation calls, and `start-pending-generation.js`'s own independent pre-signup computation), overriding whatever `audioOn` the client sends — tracker item `for-product-turn-off-audio-dialogue-gene-ooeyoj`, founder directive 2026-08-02 (cost, and to stop Veo's native audio from lip-syncing invented dialogue the user never wrote). Supersedes the 2026-07-28→07-29 history of a client-honored toggle + a retired owner/IL force-off (`resolveGenerationProfile`'s `forceAudioOff` field removed as dead weight; `profile` label survives for cost-attribution logging only). **Still in effect, unconditionally, untouched by the music-bed row below** — the generated video FILE itself is, and will remain, permanently silent; the `audioOn`/`musicStyle` payload plumbing (`js/store.js`, `home.html`/`result.html`'s regenerate/turn-into-video paths) is left intact and inert, a trivial flip back on if ever reversed. style.html's toggle itself, previously shown disabled here (`.toggle-switch.disabled`), is re-enabled as of the music-bed row below — see that row, not this one, for its current real behavior | `test/generate-video-audio-toggle.test.js` (every call shape — plain, reference-to-video, image-to-video-adjacent, PixVerse rotation — always `generate_audio:false` regardless of `audioOn`/`musicStyle`/`OWNER_EMAIL`/geo/condensing; `resolveGenerationProfile` no longer returns a `forceAudioOff` key), `test/start-pending-generation-audio-force.test.js` (the same unconditional-off contract on this file's own independent `generateAudio` computation, incl. its self-photo reference-to-video branch), `test/audio-toggle-behavioral.test.js` (real Chromium: every generation, toggle on or off, still only ever sends the permanently-inert `audioOn:false`/`musicStyle:null`/no `musicBedOn` at all to `generate-video.js`; `regenerateDream`'s pre-existing `audioOn:true` client payload is confirmed to still be sent — deliberately inert plumbing, not a behavior change) | — |
| **Music-bed playback (CLIENT-SIDE ONLY, not server-side audio generation)** — tracker item `for-product-build-founder-approved-08-03-jlkjy9` (founder-approved Option B). style.html's Audio & music toggle is real and interactive again (default **ON**, a deliberate reversal of its pre-ooeyoj default-off), but controls a reusable, one-time-generated, style-matched AMBIENT MUSIC BED (`assets/music-beds/{cartoon,cinematic,anime,realistic}.wav`, served as plain static files — no build step, no new endpoint), never anything model-generated — the row above's `generate_audio:false` fix is completely untouched. Per-dream choice persisted as a new `musicBedOn` boolean (`js/store.js`'s draft shape + `finalizeDream`, forward-only migration — a dream saved before this feature has no such field and is treated as silent, same convention as `modelUsed`/`createdAt`) and threaded into the shared feed-index record too (`publish-dream.js`/`js/store.js`'s `syncPublishedDreamToFeed`) so a published dream's bed plays on explore.html as well as result.html. Playback is a synced `<audio>` element (`js/music-bed.js`) that starts/stops with the video's own play/pause state and shares the video's own device-level mute preference (`DreamStore.getSoundPref`/`setSoundPref`) — wired into result.html's player and explore.html's feed (home.html's own ambient preview thumbnail and the admin-only media-library lightbox were deliberately scoped OUT, see `js/music-bed.js`'s and this row's own detail below). **Implementation-choice tradeoff, stated explicitly (per the tracker item's own ask):** client-side playback, not muxed into the video file at generation — ships without a new ffmpeg/vendor dependency, but means a downloaded or externally-shared video file carries no audio at all; the bed only ever plays inside DreamTube's own player UI. Root-caused via systematic-debugging: a freshly created, `preload="none"` `<audio>` element's first `.play()` call, made synchronously inside an `IntersectionObserver` callback, intermittently (~1 run in 3 in headless Chromium) silently never started (no error/event at all) — fixed with a bounded, event-driven retry (the video's own recurring `timeupdate`, never a blind timeout) in both result.html and explore.html. **Known gap, scoped out deliberately:** `watch.html` (the retention-email "watch it" link) and `claim-dream.html` (the pre-signup claim moment) read a dream through server-side projection endpoints (`get-shared-dream.js`, the claim flow's own endpoint) that don't carry `style`/`musicBedOn` at all — extending those would mean threading a new field through `dream-sync.js`'s private-dream schema and those endpoints' own response projections, a materially larger, separate change from the client-only surfaces this pass covers; both stay silent (unchanged from before this feature) until a follow-up does that work. | `test/music-bed-behavioral.test.js` (all 4 bed assets resolve as real static files at their production path; `js/music-bed.js`'s `urlForStyle`/`eligible` fail-closed contract — unknown style, non-literal-`true` `musicBedOn`, a pre-feature dream with the field missing entirely, an image-only dream — all silent; result.html and explore.html both confirmed, via real Chromium, to play/pause/mute a bed in sync with the video only when eligible, never otherwise), `test/audio-toggle-behavioral.test.js` (toggle defaults ON and is a real interactive control again, the old music-style chip picker confirmed removed from the DOM entirely, `musicBedOn` persisted onto the finished dream both ways, and a regenerate/edit with no music picker of its own confirmed to preserve the SOURCE dream's existing `musicBedOn` rather than forcing a value) | `watch.html`/`claim-dream.html` playback (see detail column — real, scoped-out gap, not silently missed); home.html's own ambient preview thumbnail and the admin-only media-library lightbox are deliberate silent-by-design exclusions, not gaps (see `js/music-bed.js`/explore.html's own comments for why) |
| `GENERATION_MOCK_MODE` / `GENERATION_TEST_DURATION` themselves | `test/generate-video-mock.test.js`, `test/video-status-mock.test.js` | — |
| `generate-image.js` / `image-status.js` | `test/generate-image.test.js`, `test/image-status.test.js`, `test/image-status-refund.test.js`, `test/image-generation-style-toggle-behavioral.test.js`, `test/image-generation-turn-into-video-behavioral.test.js`, `test/image-status-rehost.test.js` | — |
| `video-status.js` (polling, refunds, model-agnostic) | `test/video-status-mock.test.js`, `test/video-status-model-agnostic.test.js`, `test/video-status-refund.test.js`, `test/video-status-rehost.test.js` | — |
| Own-storage media re-host on completion (`lib/media-rehost.js`, `lib/media-status.js`, `video-file.mjs`, `image-file.mjs`), including the streaming-function `MAX_STREAMABLE_BYTES` size gate + oversized-redirect defense-in-depth, and the `force`-bypass option repair tooling uses — tracker items `for-product-owner-media-library-page-fou-1fwxaw`, `for-product-urgent-founder-repro-on-drea-uq3a36` (SIZE fix), `for-product-urgent-reopen-video-repair-p-cyp8np` (`force` option) | `test/media-rehost.test.js` (including the SIZE-gate and `force`-option cases), `test/media-status.test.js`, `test/media-file-functions.test.js` (including each file's own oversized-redirect defense-in-depth check), `test/video-status-rehost.test.js`, `test/image-status-rehost.test.js`, `test/dream-webhook.test.js` (the funnel webhook's own separate re-host path), `test/prod-smoke/media-serving.test.js` (real, currently-deployed `video-file.mjs`/`image-file.mjs` actually serving a real stored file — 200/302 + correct content-type — against a known-good production fixture key; the module-load-crash class of regression `test/media-file-functions.test.js`'s mocked suite structurally cannot see, per that file's own header comment — tracker item `for-product-add-a-prod-smoke-assertion-f-bqt2sh`) | Best-effort by design (see `lib/media-rehost.js`'s header comment) — a re-host failure is expected to leave the fal URL in place, covered explicitly, not a gap. No live `FAL_KEY`/real fal media in this sandbox to confirm actual byte-for-byte fidelity against a real fal response — mocked fetch responses only, same limitation this codebase's other fal-adjacent tests already accept. The new prod-smoke image-serving check is opt-in via `MEDIA_SMOKE_IMAGE_KEY` and currently skips — no verified real image key was available to hardcode; see that test file's own header comment. |
| Legacy broken-metadata repair sweep for own-storage media re-hosted BEFORE the SIZE fix shipped (`admin-repair-oversized-media.js`) — tracker item `for-product-urgent-reopen-video-repair-p-cyp8np` | `test/admin-repair-oversized-media.test.js` (auth, pagination across accounts→feed same as the backfill sweep, the cheap metadata-only-backfill tier vs. the real fal-refetch tier, `fal_result_gone`/`missing_or_invalid_source_operation_name`/`missing_fal_key`/`blobMissing` failure paths all reported not crashed, `dryRun` performing zero writes/fal calls, `targetDreamIds`/`targetKeys` filtering) | Never executed against real production data or a live `FAL_KEY` from this sandbox (no live `FAL_KEY`, no live Netlify deploy target, no real owner password available here) — every fal call and Blobs read/write is mocked. A human with live access (Manager or Ron) must run it against production and verify the specific records per the founder's own stated DONE bar before this tracker item can close; see that item's own notes for the exact request shape. |
| Edit-delta mechanism (`realign-dream-prompt.js`, the edit sheet) | `test/edit-mechanism-behavioral.test.js`, `test/realign-dream-prompt.test.js` | — |
| Edit/regen forming-state + stale-completion race guard | `test/edit-regeneration-forming-state-behavioral.test.js` | — |
| Edit/regen forming veil + reload persistence, live on a real deployed origin (the i2yzqo regression class) | `test/prod-smoke/session.test.js` (test 5) | — |
| Avatar generation (`generate-avatar.js`) | `test/generate-avatar.test.js`, `test/avatar-describe-behavioral.test.js` | — |
| Record-it voice capture + transcription (`transcribe-audio.js`, `transcribe-status.js`, real `MediaRecorder`/`getUserMedia`) | — | **Real gap.** `test/transcript-text-review-behavioral.test.js` covers reviewing/editing ALREADY-transcribed text, not the actual recording/transcription call chain. No test exercises `transcribe-audio.js`/`transcribe-status.js` directly. |
| Model cost categorization/reconciliation (`fal-cost-categorize.js`, `reconcile-fal-cost.js`) | `test/fal-cost-categorize.test.js`, `test/reconcile-fal-cost.test.js` | — |

## Dreams: storage, publish/unpublish, feed, social

| Feature/surface | Covered by | Gaps |
|---|---|---|
| Local dream store / edit history | `test/dream-store.test.js` | — |
| Server-side private dream persistence (`dream-sync.js`) | `test/dream-sync.test.js`, `test/dream-sync-client-behavioral.test.js` | — |
| Post-generation sync confirmation + retry (`js/store.js#syncPrivateDreamBestEffort`/`retryUnconfirmedPrivateDreamSyncs`) — tracker item `for-product-p0-data-loss-founder-repro-0-6bzvv1`: a completed, token-charged generation could silently never reach the server-side private-dream store at all (present locally at best, absent on any other device/browser), with no retry and no way to tell later whether the write had landed. Fixed with a local `syncConfirmed` flag + retry-with-backoff (genuine transient/5xx failures) + a load-time sweep that retries any not-yet-confirmed dream the next time ANY page loads with a real `authToken` on file — no fresh login required, unlike `reconcilePrivateDreamsFromServer`'s own login-only catch-up push | `test/private-dream-sync-navigation-race.test.js` (a real transient server-side 5xx retried to success; a dream generated while `state.user.authToken` is null — a real, documented `attemptLocalLogin` fallback shape, not a contrived state — never even attempts a sync, then reaches the server automatically on the next ordinary page load once a real token is on file, with no explicit login/logout) | The write-side mirror of `nsbbg5`'s navigation-abort race (an in-flight `dream-sync` POST outrun by same-tab SPA navigation or the tab closing) was investigated directly but could NOT be reliably reproduced as a genuine server-side loss in this harness — Netlify Functions generally complete server-side once a request is dispatched, regardless of client fate — so it is not confirmed as a live mechanism, only defended against as a matter of course by the same retry/confirmation fix. See the build session's own report for the full investigation. |
| Admin diagnose/repair for a generation that was charged but never got a surviving dream record (`admin-diagnose-lost-generations.js`, `admin-repair-lost-generations.js`) — tracker item `for-product-p0-data-loss-founder-repro-0-6bzvv1`, cross-references `lib/job-owners.js` (who submitted a job) against `lib/dream-store.js` (who has a finished dream record) by operationName, per-account or swept across all accounts since a timestamp; repair re-queries fal's own result endpoint and writes a real recovered dream record (placeholder caption unless a human supplies `captionOverride`/`styleOverride` — job-owners.js never records the original caption/style) | `test/admin-diagnose-lost-generations.test.js`, `test/admin-repair-lost-generations.test.js` | Cannot be run against real production from this sandbox (no live `FAL_KEY`/owner password) — built and tested against mocked fixtures only; whoever has real production access must actually run it. `lib/job-owners.js` has no secondary index by account or date, so both tools page over its full key list — fine at this app's current scale, would need real pagination discipline (already built in, via `cursor`/`nextCursor`) at a much larger scale. |
| Publish/unpublish (`publish-dream.js`, `unpublish-dream.js`) | `test/publish-dream.test.js`, `test/publish-unpublish-dream-auth.test.js`, `test/publish-dream-avatar-thumbnail-behavioral.test.js`, `test/publish-dream-avatar-validation.test.js` | — |
| Publish/unpublish, live, real feed, real probe dream | `test/prod-smoke/session.test.js` (test 6) | — |
| Shared feed (`get-feed.js`), windowing | `test/feed-windowing-behavioral.test.js` | No dedicated `get-feed.test.js` at the plain-handler level — coverage is behavioral/client-side only |
| Explore feed rendering, avatar fallback | `test/explore-avatar-fallback-behavioral.test.js` | — |
| Likes (`like-dream.js`) | `test/like-dream.test.js`, `test/notify-likes-badge-behavioral.test.js` | — |
| Block / report (`block-user.js`, `report-dream.js`) | `test/block-user.test.js`, `test/report-dream.test.js`, `test/report-block-behavioral.test.js` | Admin-side moderation QUEUE (`get-moderation-reports.js`) has **no test coverage** — only the report-submission side is tested |
| Sharing (`share-dream.js`, `get-shared-dream.js`) | `test/share-dream.test.js`, `test/share-sheet-behavioral.test.js` | — |
| Channel republish license consent | `test/channel-republish-license-behavioral.test.js` | — |

## Tokens, entitlements, payments

| Feature/surface | Covered by | Gaps |
|---|---|---|
| Entitlements core (balance, daily claim, refunds, purchases, achievements) | `test/entitlements-tokens.test.js`, `test/entitlements-daily-claim.test.js`, `test/entitlements-refund.test.js`, `test/entitlements-token-purchases.test.js`, `test/entitlements-achievements.test.js` | — |
| Daily claim (`claim-daily-tokens.js`, `get-token-status.js`) | `test/claim-daily-tokens.test.js`, `test/daily-claim-behavioral.test.js`, `test/token-daily-grant-copy-behavioral.test.js` | — |
| Daily claim, live, real server-confirmed balance change | `test/prod-smoke/session.test.js` (test 3) | — |
| Auto-refund on failed generation | `test/auto-refund-behavioral.test.js` | — |
| Install bonus (`claim-install-bonus.js`) | `test/claim-install-bonus.test.js` | — |
| Dodo Payments checkout + webhook, incl. "The Vault" pack ladder (pack099/199/499/999, $0.99/$1.99/$4.99/$9.99) and the pack099 starter one-time enforcement (E9) | `test/create-checkout-session-dodo.test.js`, `test/dodo-webhook.test.js`, `test/shop-pricing-copy-sweep.test.js` (repo-wide old-pricing/old-pack-id sweep) | A real end-to-end charge against the 4 new Dodo dashboard products is the only way to fully confirm the amount actually charged matches configuration — see `docs/PAYWALL_SETUP.md` |
| Stripe checkout + webhook (legacy/dormant path) | `test/stripe-webhook.test.js` | Live/branch merge status of the Stripe vs. Dodo path should be reconciled against `dodo-merge-decision`-style tracker history before assuming both are equally "live" — this row is about test coverage, not production status |
| Shop UI ("The Vault" — welcome-offer hero, pack cards, out-of-tokens sheet's single contextual offer, purchase conversion tracking incl. the `starter` flag) | `test/shop-behavioral.test.js`, `test/shop-purchase-conversion-behavioral.test.js`, `test/out-of-tokens-purchase-sheet-behavioral.test.js`, `test/purchase-sheet.test.js` | — (the shop's old "best value" pack-card palette A/B test and its own test file, `test/shop-palette-variant-behavioral.test.js`, were retired 2026-08-02 along with the page structure they targeted — see `docs/SHOP_PALETTE_REDESIGN_SPEC.md`'s superseded note; `test/shop-first-purchase-callout-behavioral.test.js` was likewise removed along with the +50%-bonus callout it covered, replaced by the starter-pack coverage above) |
| Owner top-up / bypass (`owner-topup-tokens.js`, `verify-owner-bypass.js`) | `test/owner-topup-tokens.test.js`, `test/owner-topup-target-behavioral.test.js`, `test/owner-bypass.test.js` | — |

## Interpretation / Chamber

| Feature/surface | Covered by | Gaps |
|---|---|---|
| `interpret-dream.js`, persona questions/readings | `test/interpret-dream.test.js`, `test/interpreter-personas.test.js` | — |
| Chamber dream strip (home embed) | `test/chamber-dream-strip-behavioral.test.js` | — |

## Retention / notifications / analytics

| Feature/surface | Covered by | Gaps |
|---|---|---|
| First-dream retention email | `test/automatic-first-dream-email.test.js`, `test/send-first-dream-email.test.js`, `test/first-dream-email-store.test.js` | — |
| Retention-email real first-frame thumbnail (`upload-dream-thumbnail.js`, `lib/first-dream-email-sender.js`'s `buildHtml`/`absoluteImageUrl`, `js/store.js`'s `DreamStore.saveThumbnailBestEffort`, result.html's capture IIFE) — tracker item `for-product-dream-ready-email-real-first-qr9fbj` | `test/upload-dream-thumbnail.test.js` (endpoint validation, authToken identity, per-account key namespacing, idempotency, and proving the write is served back out unchanged by `image-file.mjs`), `test/send-first-dream-email.test.js` (real-`<img>` vs flat-color-banner branch, relative→absolute url resolution, `absoluteImageUrl` unit cases), `test/automatic-first-dream-email.test.js` (asserts the automatic path — no `dreamId` at its choke point — always still falls back to the color banner), `test/dream-thumbnail-capture-behavioral.test.js` (`DreamStore.saveThumbnailBestEffort`'s every guard branch — not signed in, not-owner, already-has-imageUrl, failed upload — plus a REAL end-to-end Chromium run: a genuine tiny decodable WebM clip, result.html's capture IIFE actually drawing a frame to canvas and uploading it, syncing onto the dream, capturing exactly once per page load) | The automatic send (`mark-generation-completed.js`) can never supply a real thumbnail — it has no `dreamId` at its choke point by design (see that file's own header comment) — so in practice only the client-triggered `send-first-dream-email.js` fallback path realistically benefits; this is a documented, accepted scope limit, not a bug. Capture is also only wired on result.html, not explore.html's separate resume-completion path (`fireFirstVideoCreatedIfEligible`) — that path has no dedicated full-size `<video>` element to capture a frame from, so a dream completed that way keeps the flat-color banner until it's later opened on result.html. |
| FirstVideoCreated conversion event + durable markers (`mark-generation-completed.js`, `consume-generation-marker.js`) | `test/first-video-created-behavioral.test.js`, `test/first-video-created-explore-resume-behavioral.test.js`, `test/generation-completion-marker.test.js`, `test/retention-email-first-video-behavioral.test.js` | — |
| Web push (daily-claim-available, dedup) | `test/send-daily-claim-pushes.test.js`, `test/push-dedup-store.test.js`, `test/push-subscription-store.test.js` | — |
| Morning Capture Ritual — WhatsApp channel (opt-in field, `save-whatsapp-number.js`, `send-whatsapp-morning-capture.js`, per-day dedup) — tracker item `for-product-build-whatsapp-morning-captu-skez3n` | `test/account-store.test.js` (whatsappNumber field), `test/save-whatsapp-number.test.js`, `test/send-whatsapp-morning-capture.test.js`, `test/whatsapp-morning-capture-opt-in-behavioral.test.js` | Cannot exercise a real Meta send — no live `WHATSAPP_ACCESS_TOKEN`/approved template in this sandbox, same honest-degrade limitation `test/send-daily-claim-pushes.test.js` already accepts for real push delivery. No email/push sibling channel exists yet for this same ritual (this is currently the only channel) — see `send-whatsapp-morning-capture.js`'s own header comment. |
| Meta CAPI / conversion tracking (`track-conversion.js`) | `test/meta-capi.test.js`, `test/meta-capi-behavioral.test.js`, `test/funnel-meta-attribution-cookies-behavioral.test.js` | — |
| PostHog identity/test-traffic tagging | `test/posthog-identity-merge-behavioral.test.js`, `test/posthog-test-traffic-tagging-behavioral.test.js`, `test/server-analytics-containment.test.js` | — |
| Support/feedback inbox (`submit-support-message.js`, `get-support-messages.js`) | `test/support-feedback.test.js`, `test/support-feedback-behavioral.test.js` | Whether `get-support-messages.js` (the admin-read side) has its OWN direct handler-level test, vs. only being exercised indirectly through the behavioral submit flow, should be spot-checked next time this row is touched |

## Owner/admin tooling & coordination

| Feature/surface | Covered by | Gaps |
|---|---|---|
| Paywall toggle | `test/admin-paywall-toggle.test.js` | — |
| tracker.html (`get/add/update/delete-tracker-item.js`) | `test/tracker.test.js`, `test/tracker-behavioral.test.js`, `test/tracker-comments-behavioral.test.js`, `test/tracker-reviewed-behavioral.test.js`, `test/tracker-speak-behavioral.test.js`, `test/tracker-waiting-for-behavioral.test.js` | — |
| Media library page + backfill sweep (`media-library-x7q4.html`, `admin-backfill-media-rehost.js`, `admin-media-library-data.js`) — tracker items `for-product-owner-media-library-page-fou-1fwxaw`, `for-product-media-library-founder-feedba-wnr3iw` (Published/Private filter + desktop-scroll fix), `for-product-media-library-clicking-a-vid-bnlcus` (card-tap lightbox) | `test/admin-backfill-media-rehost.test.js` (auth, idempotency, pagination across the accounts→feed phases, per-field re-host outcomes), `test/admin-media-library-data.test.js` (auth, item shape, status classification matching `lib/media-status.js` directly, both/neither-media-field edge cases), `test/media-library-page.test.js` (Playwright: gate → unlock → grid render → status/account/published filters including all three combined, a 1280×800 desktop-viewport test that seeds 60 items to force real overflow and proves the grid's internally-scrolling region actually reaches content past the fold, and the card-tap lightbox — opens a real unmuted controls-enabled `<video>` or a bigger `<img>` using the item's real url rather than the in-grid muted/lazy thumbnail, and closes via its own close button, Escape, or tap-outside-the-media, while a tap ON the media itself does not close it) | Both admin endpoints are unpaginated on the FEED side and the data-listing endpoint is unpaginated on the accounts side too (documented in each file's own header comment as an accepted "fine at current scale" tradeoff, same posture `send-daily-claim-pushes.js` already established) — would need real pagination if the account base grows large. The Published/Private filter's underlying data (private items, `isPublished` flag) was already correct in both the backend and the per-card badge before this change — verified by reading `admin-media-library-data.js`/`lib/dream-store.js` before building; only the dedicated filter control was missing, so no backend change was needed for that part. The desktop-scroll bug's root cause: `#app` (no `.scroll-shell`/`.scroll-area`, the pattern `tracker.html` already uses for the same long-content-owner-page shape) gets a fixed height + `overflow:hidden` once the desktop phone-frame breakpoint (`@media min-width:560px` in `css/styles.css`) applies, with nothing to scroll content past that height — invisible on mobile, where `#app` is plain block flow and the whole document scrolls normally instead. The lightbox's tap-outside-to-close deliberately reuses `js/sheet-dismiss.js`'s `SheetDismiss.wire()` for its same-spot re-tap guard rather than a bespoke listener (see `media-library-x7q4.html`'s own inline comment); Escape-to-close is a small standalone `keydown` listener since that module doesn't cover it. |

## Cross-cutting / infrastructure

| Feature/surface | Covered by | Gaps |
|---|---|---|
| Rate limiting (`lib/rate-limit.js`) | Exercised indirectly inside several endpoint tests (e.g. `test/check-email.test.js`, `test/claim-daily-tokens.test.js`) | No single dedicated `rate-limit.test.js` isolating the shared helper itself |
| Netlify Blobs retry helper | `test/blobs-retry.test.js` | — |
| Shared bottom-sheet dismissal (`js/sheet-dismiss.js` — tap-outside, drag-to-dismiss, wired into all 13 `.sheet-overlay` call sites app-wide) | `test/sheet-dismiss-behavioral.test.js` (per-instance five-point suite across profile.html/result.html/create.html/wizard.html/js/purchase-sheet.js, plus a dedicated rapid-re-tap-after-open regression — tracker item `for-product-urgent-founder-posthog-recor-75ob70`: a tap-outside click landing within the sheet's own opening transition window used to self-dismiss it immediately, reading as "the sheet never opens" on a real PostHog recording) | — |
| Web push helper | covered via `test/push-dedup-store.test.js`/`test/push-subscription-store.test.js` and `test/helpers/mock-web-push.js` | — |
| **Live, real-origin, end-to-end smoke coverage** (as opposed to mocked-backend coverage) | `test/prod-smoke/*.test.js` (this file's own registry entry) | Intentionally narrow — see `test/prod-smoke/README.md`. Does NOT cover: payments/checkout, Facebook Login, admin/owner tooling, transcription, interpretation/Chamber, push notifications, or most retention email paths. Those stay covered only by the mocked `test/*.test.js` suite. |

## Last reconciled

2026-08-02, alongside tracker item `for-product-wizard-characters-step-is-si-
paxp07` (founder repro): fixed `wizard.html`'s Subject step (Step 1) from a
single-active-subject model to real independent multi-select toggles
(`staged.subjectCharacterIds` + `subjectOtherKind` composing together), and
extended `js/wizard-chips.js`'s `assembleCaption`/`buildDeterministicStory`
with a new, backward-compatible `subjects`-array input to carry multiple
selections all the way into the assembled generation prompt — see the
Onboarding funnel row above for the full writeup and its test coverage.
Also fixed a real, pre-existing bug found while touching this exact code
path: the in-place-login (already-registered-email) branch's post-flush
`draft.characterIds` id remap used to run BEFORE the `draftPatch` setDraft
call that immediately overwrote it back to the stale pre-flush local id(s)
— reordered to match the normal-signup branch's own (already-correct)
ordering.

2026-08-02, SECURITY FIX (round-2 independent review of tracker item
`for-product-build-passwordless-signup-fo-at2fko`): closed a real account-
takeover bug — a bare POST of an already-registered email to
`register-account-passwordless.js` used to mint a fully usable session with
zero ownership proof. Fixed via a new `login-with-email-code.js` endpoint
(the real access-control gate — a genuine login, mailed-code-as-credential)
and `verify-email-link.js` now also minting a `lib/session-transfer-
token.js` token on success. See the new SECURITY FIX row above for the full
writeup and its test coverage.

2026-08-02, alongside tracker item `for-product-build-passwordless-signup-fo-
at2fko` (founder-decided passwordless-signup hybrid): added the passwordless
signup path (`register-account-passwordless.js`, mock-only —
`SIGNUP_PASSWORDLESS_LIVE` is `false`), deferred email verification
(`verify-email-code.js`, `resend-verification-code.js`,
`verify-email-link.js`'s implicit-verification-via-link-click,
`js/email-verify-sheet.js`'s "next visit" prompt), the gate list
(`create-checkout-session-dodo.js`'s E10, `publish-dream.js`'s E8 — see
`lib/account-store.js`'s GATE LIST header comment), and Resend hard-bounce
handling (`resend-bounce-webhook.js`) — see the Auth & accounts rows above.

2026-08-02, alongside tracker item `for-product-urgent-founder-posthog-recor-
75ob70`: fixed `js/sheet-dismiss.js`'s tap-outside-to-close listener
self-dismissing a sheet within ~50ms of its own open (a rapid re-tap at the
trigger button's coordinates landing on the just-opened overlay backdrop,
before the `.sheet` panel had visibly slid into view) — a same-position
re-tap guard (not a flat time window, which regressed
`test/out-of-tokens-purchase-sheet-behavioral.test.js`'s several
genuinely-intentional immediate tap-outside-to-dismiss cases; see
`js/sheet-dismiss.js`'s own comment for why position, not time, is the
right signal) now ignores a tap-outside only when it lands within ~48px of
the most recent click that happened somewhere else on the page. Also added
the Cross-cutting/infrastructure row above for this shared module (which
had no dedicated registry row despite already having its own
`test/sheet-dismiss-behavioral.test.js` file).

2026-08-02, alongside tracker item `for-product-dream-ready-email-real-first-
qr9fbj`: added the retention email's real first-frame thumbnail (new
`upload-dream-thumbnail.js` endpoint, `lib/first-dream-email-sender.js`'s
`buildHtml` real-`<img>`/flat-banner branch and `absoluteImageUrl` helper,
`js/store.js`'s `DreamStore.saveThumbnailBestEffort`, result.html's
client-side canvas capture IIFE) — see the Retention row above.

2026-08-02, alongside tracker item `for-product-build-whatsapp-morning-captu-
skez3n`: added the Morning Capture Ritual's WhatsApp channel (`whatsappNumber`
account field, `save-whatsapp-number.js`'s profile.html Settings opt-in,
`send-whatsapp-morning-capture.js`'s daily scheduled sender + per-day dedup
via `lib/push-dedup-store.js`) — see the Retention row above.

2026-08-02, alongside tracker item
`for-product-owner-media-library-page-fou-1fwxaw`: added own-storage media
re-hosting (video-status.js/image-status.js/dream-webhook.js completion
paths, `lib/media-rehost.js`, `lib/media-status.js`, `image-file.mjs`), the
owner-only backfill sweep (`admin-backfill-media-rehost.js`), and the owner
media library page + its data endpoint (`media-library-x7q4.html`,
`admin-media-library-data.js`) — see the rows above.

2026-08-01, alongside tracker item
`for-product-build-founder-directed-produ-miyfp4` (founder-directed,
HIGH priority) — built `test/prod-smoke/` and this file from scratch.
Whoever next touches a feature area above should update that row's
"Covered by"/"Gaps" columns in the SAME merge (see `AGENT_POLICY.md`'s
build/review definition-of-done).

2026-08-02, alongside tracker item
`for-product-add-a-prod-smoke-assertion-f-bqt2sh` (a direct follow-up to
`for-product-urgent-reopen-video-repair-p-cyp8np`'s module-load-crash
incident): added `test/prod-smoke/media-serving.test.js` — a real,
currently-deployed-origin check that `video-file.mjs`/`image-file.mjs`
actually serve stored media (200/302 + correct content-type) against a
known-good production video fixture, plus a clean-404 check. Image
coverage is opt-in via `MEDIA_SMOKE_IMAGE_KEY` and currently skips (no
verified real image key was available to hardcode) — see that Own-storage
media re-host row above and the test file's own header comment.
