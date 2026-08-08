// test/critical-tests-manifest.js
//
// CRITICAL TIER manifest -- part of the test-suite tiering scheme added
// per tracker item for-product-test-suite-pruning-tiering-f-qminmq
// (founder pushback 2026-08-07: "are you sure we need 350 tests?"). See
// docs/TEST_REGISTRY.md's "Test tiering" section for the full scheme;
// this file is just the machine-readable list `npm run test:critical`
// (scripts/run-critical-tests.js) actually runs against.
//
// WHAT'S IN THIS TIER (both categories, run together as one fast pass):
//   1. Every test file that guards money/data/auth or a documented race/
//      concurrency bug family -- signup, login, sessions, tokens/
//      entitlements, generation, payments (Dodo/Stripe), persistence
//      (dream-store/dream-sync/publish), rate limiting, Blobs CAS/dedup,
//      refunds -- i.e. exactly the bug families that have actually hit
//      production in this project's history (races, double-credits, data
//      loss, auth bypass). NEVER remove a file from this list to make
//      the critical run faster -- these are the ones a broken PR must
//      not be allowed to ship on top of.
//   2. A short, explicitly curated set of core-user-flow behavioral
//      tests (home, wizard/create, shop, the funnel journey, the
//      Playwright-driven result.html interaction suite) -- not
//      money/data/auth themselves, but the primary screens a broken PR
//      would be immediately, visibly wrong on.
//
// WHAT'S NOT IN THIS TIER: everything else -- admin one-off tools with
// no live traffic, secondary/cosmetic UI surfaces (chamber, postpack,
// tracker.html, WhatsApp capture, PWA/A2HS polish, moderation review,
// etc.), and the bulk of the *-copy-*/*-restyle-*/*-makeover-*-style
// regression suites pinning a specific founder-approved redesign's
// details. None of that is LESS real coverage -- `npm run test:full` /
// `npm test` (unchanged, still node --test test/*.test.js) still runs
// literally everything, every file, every time it's invoked. This tier
// only controls what's fast enough to run on every build/PR; the full
// sweep is the nightly/pre-merge safety net that catches the rest.
//
// HOW A NEW TEST FILE GETS CLASSIFIED (do this when you add one):
//   - Touches money, real user data, auth, or a race/concurrency/CAS/
//     atomic-write concern? -> add its filename below. When in doubt,
//     add it -- the cost of being in this tier is a slightly slower
//     critical run, not lost coverage either way (test:full always runs
//     it regardless of this list).
//   - Is a genuinely core, everyday user-facing flow (something most
//     users hit on a normal path: home, wizard/create, shop, signup,
//     result/publish)? -> add it too, same reasoning.
//   - Otherwise (a secondary surface, an admin/one-off tool, a specific
//     redesign's copy/visual regression suite) -> leave it OUT. It still
//     runs in the nightly full sweep and still blocks a PR if the driver
//     chooses to run `npm test` before merging (this tier is an
//     additive fast option, not a replacement for the full suite before
//     a merge that touches something sensitive).
//   - This file is intentionally plain data (a `.js` module exporting an
//     array, not JSON) so it can carry this documentation inline,
//     matching this repo's own no-build-step convention -- see
//     CLAUDE.md.

module.exports = [
  "account-auth-token.test.js",
  "account-store-facebook.test.js",
  "account-store.test.js",
  "admin-backfill-media-rehost.test.js",
  "admin-diagnose-account-duplicates.test.js",
  "admin-diagnose-dodo-payment.test.js",
  "admin-diagnose-rename-conflict.test.js",
  "admin-reset-account-markers.test.js",
  "admin-restore-founder-email.test.js",
  "auto-refund-behavioral.test.js",
  "blobs-cas.test.js",
  "blobs-retry.test.js",
  "block-user.test.js",
  "channel-republish-license-behavioral.test.js",
  "check-email.test.js",
  "claim-and-verify-pending.test.js",
  "claim-daily-tokens.test.js",
  "claim-dream-retention-motivators-behavioral.test.js",
  "claim-install-bonus.test.js",
  "consolidate-accounts-client-migration-behavioral.test.js",
  "content-classifier.test.js",
  "content-gate-generation.test.js",
  "create-checkout-session-dodo.test.js",
  "daily-claim-behavioral.test.js",
  "delete-account-behavioral.test.js",
  "delete-account.test.js",
  "dodo-webhook.test.js",
  "download-video-status.test.js",
  "dream-store.test.js",
  "dream-sync-client-behavioral.test.js",
  "dream-sync.test.js",
  "dream-webhook.test.js",
  "email-domain-check.test.js",
  "entitlements-achievements.test.js",
  "entitlements-daily-claim.test.js",
  "entitlements-refund.test.js",
  "entitlements-token-purchases.test.js",
  "entitlements-tokens.test.js",
  "facebook-login-signup-behavioral.test.js",
  "facebook-oauth-callback.test.js",
  "fal-cost-categorize.test.js",
  "fal-usage-client.test.js",
  "fal-webhook-jwks-cache.test.js",
  "funnel-meta-attribution-cookies-behavioral.test.js",
  "funnel-real-chain-behavioral.test.js",
  "funnel-signup-navigation-token-guard-behavioral.test.js",
  "generate-image.test.js",
  "generate-video-audio-toggle.test.js",
  "generate-video-build-prompt.test.js",
  "generate-video-image-to-video.test.js",
  "generate-video-mock.test.js",
  "generate-video-model-config.test.js",
  "generate-video-model-rotation.test.js",
  "generate-video-tokens.test.js",
  "generate-video-turnstile.test.js",
  "generation-blocked-telemetry-behavioral.test.js",
  "geo.test.js",
  "home-behavioral.test.js",
  "home-round4-behavioral.test.js",
  "image-status-refund.test.js",
  "image-status-rehost.test.js",
  "image-status.test.js",
  "job-owners.test.js",
  "journey-manifest.test.js",
  "life-origin-generate-handoff-behavioral.test.js",
  "like-dream.test.js",
  "mark-report-handled.test.js",
  "media-rehost.test.js",
  "media-status.test.js",
  "moderation-review-page.test.js",
  "out-of-tokens-purchase-sheet-behavioral.test.js",
  "owner-bypass.test.js",
  "owner-topup-target-behavioral.test.js",
  "owner-topup-tokens.test.js",
  "password-reset-account.test.js",
  "passwordless-signup.test.js",
  "pending-dreams.test.js",
  "private-dream-sync-navigation-race.test.js",
  "publish-dream-avatar-thumbnail-behavioral.test.js",
  "publish-dream-avatar-validation.test.js",
  "publish-dream.test.js",
  "publish-unpublish-dream-auth.test.js",
  "push-dedup-store.test.js",
  "push-subscription-store.test.js",
  "realign-dream-prompt.test.js",
  "reconcile-fal-cost.test.js",
  "record-mode-behavioral.test.js",
  "rename-migration-login-behavioral.test.js",
  "report-block-behavioral.test.js",
  "report-dream.test.js",
  "report-smoke-status.test.js",
  "resend-bounce-webhook.test.js",
  "result-photo-upload-sheet-token-behavioral.test.js",
  "route-organic-to-wizard-behavioral.test.js",
  "send-daily-claim-pushes.test.js",
  "session-transfer-behavioral.test.js",
  "session-transfer.test.js",
  "settle-helper.test.js",
  "shop-behavioral.test.js",
  "shop-checkout-confirmation-behavioral.test.js",
  "shop-purchase-conversion-behavioral.test.js",
  "signup-method-analytics-behavioral.test.js",
  "signup-passwordless-behavioral.test.js",
  "signup-reveal-variant-behavioral.test.js",
  "signup-screen-behavioral.test.js",
  "signup-screen-layout-spacing-behavioral.test.js",
  "split-prompttext-storytext-behavioral.test.js",
  "start-pending-generation-audio-force.test.js",
  "start-pending-generation.test.js",
  "store-signup-call-sequence-guard-behavioral.test.js",
  "stripe-webhook.test.js",
  "token-daily-grant-copy-behavioral.test.js",
  "token-functions.test.js",
  "turnstile-config-behavioral.test.js",
  "turnstile.test.js",
  "ui-behavioral.test.js",
  "unsubscribe-token.test.js",
  "video-ready-push.test.js",
  "video-status-mock.test.js",
  "video-status-model-agnostic.test.js",
  "video-status-refund.test.js",
  "video-status-rehost.test.js",
  "watermark-download-client.test.js",
  "watermark-video.test.js",
  "wizard-action-chip-curation-behavioral.test.js",
  "wizard-chips.test.js",
  "wizard-photo-upload-sheet-token-behavioral.test.js",
  "wizard-ui-behavioral.test.js"
];
