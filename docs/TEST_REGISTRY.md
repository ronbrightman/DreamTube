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
| `GENERATION_MOCK_MODE` / `GENERATION_TEST_DURATION` themselves | `test/generate-video-mock.test.js`, `test/video-status-mock.test.js` | — |
| `generate-image.js` / `image-status.js` | `test/generate-image.test.js`, `test/image-status.test.js`, `test/image-status-refund.test.js`, `test/image-generation-style-toggle-behavioral.test.js`, `test/image-generation-turn-into-video-behavioral.test.js`, `test/image-status-rehost.test.js` | — |
| `video-status.js` (polling, refunds, model-agnostic) | `test/video-status-mock.test.js`, `test/video-status-model-agnostic.test.js`, `test/video-status-refund.test.js`, `test/video-status-rehost.test.js` | — |
| Own-storage media re-host on completion (`lib/media-rehost.js`, `lib/media-status.js`, `video-file.mjs`, `image-file.mjs`) — tracker item `for-product-owner-media-library-page-fou-1fwxaw` | `test/media-rehost.test.js`, `test/media-status.test.js`, `test/media-file-functions.test.js`, `test/video-status-rehost.test.js`, `test/image-status-rehost.test.js`, `test/dream-webhook.test.js` (the funnel webhook's own separate re-host path) | Best-effort by design (see `lib/media-rehost.js`'s header comment) — a re-host failure is expected to leave the fal URL in place, covered explicitly, not a gap. No live `FAL_KEY`/real fal media in this sandbox to confirm actual byte-for-byte fidelity against a real fal response — mocked fetch responses only, same limitation this codebase's other fal-adjacent tests already accept. |
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
| Media library page + backfill sweep (`media-library-x7q4.html`, `admin-backfill-media-rehost.js`, `admin-media-library-data.js`) — tracker items `for-product-owner-media-library-page-fou-1fwxaw`, `for-product-media-library-founder-feedba-wnr3iw` (Published/Private filter + desktop-scroll fix) | `test/admin-backfill-media-rehost.test.js` (auth, idempotency, pagination across the accounts→feed phases, per-field re-host outcomes), `test/admin-media-library-data.test.js` (auth, item shape, status classification matching `lib/media-status.js` directly, both/neither-media-field edge cases), `test/media-library-page.test.js` (Playwright: gate → unlock → grid render → status/account/published filters including all three combined, and a 1280×800 desktop-viewport test that seeds 60 items to force real overflow and proves the grid's internally-scrolling region actually reaches content past the fold) | Both admin endpoints are unpaginated on the FEED side and the data-listing endpoint is unpaginated on the accounts side too (documented in each file's own header comment as an accepted "fine at current scale" tradeoff, same posture `send-daily-claim-pushes.js` already established) — would need real pagination if the account base grows large. The Published/Private filter's underlying data (private items, `isPublished` flag) was already correct in both the backend and the per-card badge before this change — verified by reading `admin-media-library-data.js`/`lib/dream-store.js` before building; only the dedicated filter control was missing, so no backend change was needed for that part. The desktop-scroll bug's root cause: `#app` (no `.scroll-shell`/`.scroll-area`, the pattern `tracker.html` already uses for the same long-content-owner-page shape) gets a fixed height + `overflow:hidden` once the desktop phone-frame breakpoint (`@media min-width:560px` in `css/styles.css`) applies, with nothing to scroll content past that height — invisible on mobile, where `#app` is plain block flow and the whole document scrolls normally instead. |

## Cross-cutting / infrastructure

| Feature/surface | Covered by | Gaps |
|---|---|---|
| Rate limiting (`lib/rate-limit.js`) | Exercised indirectly inside several endpoint tests (e.g. `test/check-email.test.js`, `test/claim-daily-tokens.test.js`) | No single dedicated `rate-limit.test.js` isolating the shared helper itself |
| Netlify Blobs retry helper | `test/blobs-retry.test.js` | — |
| Shared bottom-sheet dismissal (`js/sheet-dismiss.js` — tap-outside, drag-to-dismiss, wired into all 13 `.sheet-overlay` call sites app-wide) | `test/sheet-dismiss-behavioral.test.js` (per-instance five-point suite across profile.html/result.html/create.html/wizard.html/js/purchase-sheet.js, plus a dedicated rapid-re-tap-after-open regression — tracker item `for-product-urgent-founder-posthog-recor-75ob70`: a tap-outside click landing within the sheet's own opening transition window used to self-dismiss it immediately, reading as "the sheet never opens" on a real PostHog recording) | — |
| Web push helper | covered via `test/push-dedup-store.test.js`/`test/push-subscription-store.test.js` and `test/helpers/mock-web-push.js` | — |
| **Live, real-origin, end-to-end smoke coverage** (as opposed to mocked-backend coverage) | `test/prod-smoke/*.test.js` (this file's own registry entry) | Intentionally narrow — see `test/prod-smoke/README.md`. Does NOT cover: payments/checkout, Facebook Login, admin/owner tooling, transcription, interpretation/Chamber, push notifications, or most retention email paths. Those stay covered only by the mocked `test/*.test.js` suite. |

## Last reconciled

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
