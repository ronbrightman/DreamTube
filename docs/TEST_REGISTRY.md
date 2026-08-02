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
| Journey 2 full flow, live, real backend, real probe account | `test/prod-smoke/session.test.js` (test 1) | — |
| Generate-during-signup real chain (client → real server handlers) | `test/funnel-real-chain-behavioral.test.js` | — |
| Email deliverability/availability check (`check-email.js`) | `test/check-email.test.js`, `test/email-domain-check.test.js` | — |
| Pending-generation adoption (`start-pending-generation.js`, `claim-pending-generation.js`, `pending-dreams.js`) | `test/pending-dreams.test.js`, `test/funnel-real-chain-behavioral.test.js`, `test/claim-and-verify-pending.test.js` | — |
| A2HS / install nudge | `test/a2hs-install-nudge-journey-behavioral.test.js`, `test/install-first-door-behavioral.test.js` | — |

## Home (`home.html`, 2026-08-01 module set)

| Feature/surface | Covered by | Gaps |
|---|---|---|
| Overall page / round-4 rebuild | `test/home-behavioral.test.js`, `test/home-round4-behavioral.test.js` | — |
| Day-0/active dream room card (`#day0-card`) | `test/home-day0-dream-card-behavioral.test.js`, `test/edit-regeneration-forming-state-behavioral.test.js` | — |
| Tip of the Day, Get Inspired, Consider Publishing, Make It Yours, ritual/streak module — as a set, live on a real deployed origin | `test/prod-smoke/session.test.js` (test 2) | Per-module deep behavioral coverage (copy variants, edge/empty states, exact interaction details) is NOT this suite's job — check for a dedicated `test/*.test.js` file per module before assuming full coverage; several of these modules (Get Inspired, ritual/streak beyond the daily claim itself) currently have **no dedicated `test/*.test.js` file** of their own — home-behavioral/home-round4-behavioral cover the page broadly, not module-by-module |
| Bottom dock (`js/bottom-nav.js`, "Bar A") | `test/barA-nav-rollout-behavioral.test.js` | — |
| Webview escape nudge | `test/home-webview-escape-behavioral.test.js` | — |

## Generation (video/image)

| Feature/surface | Covered by | Gaps |
|---|---|---|
| `generate-video.js` (prompt build, guardrails, model rotation/config, tokens, Turnstile) | `test/generate-video-build-prompt.test.js`, `test/generate-video-model-rotation.test.js`, `test/generate-video-model-config.test.js`, `test/generate-video-tokens.test.js`, `test/generate-video-turnstile.test.js`, `test/generate-video-audio-toggle.test.js`, `test/generate-video-image-to-video.test.js` | — |
| `GENERATION_MOCK_MODE` / `GENERATION_TEST_DURATION` themselves | `test/generate-video-mock.test.js`, `test/video-status-mock.test.js` | — |
| `generate-image.js` / `image-status.js` | `test/generate-image.test.js`, `test/image-status.test.js`, `test/image-status-refund.test.js`, `test/image-generation-style-toggle-behavioral.test.js`, `test/image-generation-turn-into-video-behavioral.test.js` | — |
| `video-status.js` (polling, refunds, model-agnostic) | `test/video-status-mock.test.js`, `test/video-status-model-agnostic.test.js`, `test/video-status-refund.test.js` | — |
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
| Dodo Payments checkout + webhook | `test/create-checkout-session-dodo.test.js`, `test/dodo-webhook.test.js` | — |
| Stripe checkout + webhook (legacy/dormant path) | `test/stripe-webhook.test.js` | Live/branch merge status of the Stripe vs. Dodo path should be reconciled against `dodo-merge-decision`-style tracker history before assuming both are equally "live" — this row is about test coverage, not production status |
| Shop UI (purchase sheet, palette, conversion tracking) | `test/shop-behavioral.test.js`, `test/shop-first-purchase-callout-behavioral.test.js`, `test/shop-palette-variant-behavioral.test.js`, `test/shop-purchase-conversion-behavioral.test.js`, `test/out-of-tokens-purchase-sheet-behavioral.test.js` | — |
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
| FirstVideoCreated conversion event + durable markers (`mark-generation-completed.js`, `consume-generation-marker.js`) | `test/first-video-created-behavioral.test.js`, `test/first-video-created-explore-resume-behavioral.test.js`, `test/generation-completion-marker.test.js`, `test/retention-email-first-video-behavioral.test.js` | — |
| Web push (daily-claim-available, dedup) | `test/send-daily-claim-pushes.test.js`, `test/push-dedup-store.test.js`, `test/push-subscription-store.test.js` | — |
| Meta CAPI / conversion tracking (`track-conversion.js`) | `test/meta-capi.test.js`, `test/meta-capi-behavioral.test.js`, `test/funnel-meta-attribution-cookies-behavioral.test.js` | — |
| PostHog identity/test-traffic tagging | `test/posthog-identity-merge-behavioral.test.js`, `test/posthog-test-traffic-tagging-behavioral.test.js`, `test/server-analytics-containment.test.js` | — |
| Support/feedback inbox (`submit-support-message.js`, `get-support-messages.js`) | `test/support-feedback.test.js`, `test/support-feedback-behavioral.test.js` | Whether `get-support-messages.js` (the admin-read side) has its OWN direct handler-level test, vs. only being exercised indirectly through the behavioral submit flow, should be spot-checked next time this row is touched |

## Owner/admin tooling & coordination

| Feature/surface | Covered by | Gaps |
|---|---|---|
| Paywall toggle | `test/admin-paywall-toggle.test.js` | — |
| tracker.html (`get/add/update/delete-tracker-item.js`) | `test/tracker.test.js`, `test/tracker-behavioral.test.js`, `test/tracker-comments-behavioral.test.js`, `test/tracker-reviewed-behavioral.test.js`, `test/tracker-speak-behavioral.test.js`, `test/tracker-waiting-for-behavioral.test.js` | — |

## Cross-cutting / infrastructure

| Feature/surface | Covered by | Gaps |
|---|---|---|
| Rate limiting (`lib/rate-limit.js`) | Exercised indirectly inside several endpoint tests (e.g. `test/check-email.test.js`, `test/claim-daily-tokens.test.js`) | No single dedicated `rate-limit.test.js` isolating the shared helper itself |
| Netlify Blobs retry helper | `test/blobs-retry.test.js` | — |
| Web push helper | covered via `test/push-dedup-store.test.js`/`test/push-subscription-store.test.js` and `test/helpers/mock-web-push.js` | — |
| **Live, real-origin, end-to-end smoke coverage** (as opposed to mocked-backend coverage) | `test/prod-smoke/*.test.js` (this file's own registry entry) | Intentionally narrow — see `test/prod-smoke/README.md`. Does NOT cover: payments/checkout, Facebook Login, admin/owner tooling, transcription, interpretation/Chamber, push notifications, or most retention email paths. Those stay covered only by the mocked `test/*.test.js` suite. |

## Last reconciled

2026-08-01, alongside tracker item
`for-product-build-founder-directed-produ-miyfp4` (founder-directed,
HIGH priority) — built `test/prod-smoke/` and this file from scratch.
Whoever next touches a feature area above should update that row's
"Covered by"/"Gaps" columns in the SAME merge (see `AGENT_POLICY.md`'s
build/review definition-of-done).
