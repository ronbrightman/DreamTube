// test/critical-tests-exclude-list.js
//
// CRITICAL TIER manifest -- part of the test-suite tiering scheme added
// per tracker item for-product-test-suite-pruning-tiering-f-qminmq
// (founder pushback 2026-08-07: "are you sure we need 350 tests?"). See
// docs/TEST_REGISTRY.md's "Test tiering" section for the full scheme;
// this file is just the machine-readable list `npm run test:critical`
// (scripts/run-critical-tests.js) actually runs against.
//
// EXCLUDE-LIST, NOT INCLUDE-LIST (changed 2026-08-08, tracker comment on
// qminmq). The critical tier was originally built as an include-list
// (default excluded, add a file once someone recognizes it as
// sensitive) -- across three independent review rounds, three different
// audit methodologies (eyeball scan, filename-keyword sweep, filename-
// keyword sweep + header-comment reading + TEST_REGISTRY.md
// cross-reference) each found real money/data/security-relevant test
// files silently missing, including one case where a file was added for
// an explicit `SECURITY:`-labeled test while its own sibling file in the
// SAME feature/PR, with an equally explicit `SECURITY:` test, was missed
// in the same pass. An include-list is structurally fragile: every
// oversight silently DROPS coverage from the fast tier with no signal
// that anything is wrong. An exclude-list inverts the failure mode: the
// default is IN, so a new test file is automatically critical-tier from
// the moment it's added -- an oversight here just means a cosmetic file
// runs a few seconds longer in the fast tier, never a missed real
// concern.
//
// This file now exports EXCLUDED_FROM_CRITICAL -- filenames explicitly
// reviewed and confirmed NOT money/data/auth/security/core-flow relevant.
// scripts/run-critical-tests.js computes the actual critical set as
// (every file in test/*.test.js) MINUS this list.
//
// WHAT BELONGS ON THIS EXCLUDE LIST (the ONLY categories -- when in
// doubt, do NOT add a file here; leave it in the fast tier by default):
//   1. Admin one-off tools with no live user traffic (admin-diagnose-*,
//      admin-repair-*, audit-*-page.test.js) -- owner-only diagnostic/
//      repair scripts run manually, not part of any real user's path.
//   2. tracker.html's own test family -- an internal owner/Manager-only
//      coordination tool, not customer-facing, same risk class as the
//      admin tools above.
//   3. Secondary/non-core channels explicitly parked below the primary
//      email/app surface (WhatsApp capture -- save-whatsapp-number,
//      send-whatsapp-morning-capture, whatsapp-morning-capture-opt-in,
//      admin-submit-whatsapp-template; postpack/social-share asset
//      assembly -- postpack-*, assemble-instagram-tiktok-postpack,
//      share-sheet-behavioral's own page-level UI test). NOT
//      share-dream.test.js or share-profile.test.js -- round 4 review
//      found both carry real CRLF-header-injection and XSS-escaping
//      defense tests with no compensating coverage elsewhere; both
//      stay in the critical tier alongside sync-profile.test.js.
//   4. Analytics/telemetry-plumbing tests where a bug produces a wrong
//      METRIC, not a wrong charge, a data leak, or a broken user flow
//      (posthog-capture, posthog-identity-merge-behavioral,
//      posthog-test-traffic-tagging-behavioral, phase1-product-events-
//      behavioral, funnel-distinct-id-behavioral, meta-capi-behavioral,
//      founder-alias-exclusion-behavioral, interp-analytics-behavioral).
//      Note: meta-capi.test.js (singular, the actual CAPI call including
//      its own access-token-leak-prevention test) is NOT here -- that's
//      a real credential-leak boundary, stays in the fast tier.
//   5. A specific founder-approved redesign's own copy/visual-pin
//      regression suite, where the underlying behavior it rides on has
//      separate, real coverage elsewhere (home-mky-copy-behavioral,
//      home-day0-dream-card-behavioral, profile-night-restyle-
//      behavioral, chamber-makeover-behavioral, logo-purple-retouch-
//      asset-sweep, sound-nudge-behavioral, legal-pages-behavioral,
//      faq-section-behavioral).
//   6. Pure UI/interaction-polish behavioral suites with no money/data/
//      auth stake even on total failure -- a broken scroll lock, a
//      stuck install-nudge banner, a webview escape hint not showing,
//      a PWA update toast, a nebula/veil visual loading state, a
//      Chamber dream-strip layout, an at-ceiling paused-state chip,
//      a like-badge notify dot, an avatar-fallback placeholder, an
//      audio toggle's on-screen state, a scroll-lock helper, a result-
//      page image render/thumbnail-capture/play-intent/scroll-lock
//      quirk, an explore-resume behavioral nuance, an email-verify-
//      sheet nudge, a settings-row copy check, or a support/feedback
//      form's own UI (the endpoint's rate-limit/owner-read logic is
//      real, but its own harm-on-failure is spam noise, not user
//      money/data loss).
//   7. Internal build/deploy/reliability-net tooling with no user-facing
//      surface at all (deploy-log-store, get-deploy-count, effective-
//      config-logging, generate-version, smoke-status-store, get-smoke-
//      status, sw-fetch-handler, media-file-functions, poll-until-done-
//      network-retry-behavioral, both-domain-smoke).
//   8. Narrow generation-variant/style-toggle UI tests that explicitly
//      state zero real fal.ai cost in their own header and don't touch
//      a rate limit or a charge decision (image-generation-style-
//      toggle-behavioral, image-generation-turn-into-video-behavioral,
//      mood-music-bed-behavioral, music-bed-behavioral, result-image-
//      render-behavioral, interp-voice-behavioral, interp-voice-
//      captions, interpreter-personas, sage-during-generation-
//      behavioral, notify-likes-badge-behavioral, content-block-panel-
//      behavioral, create-record-inapp-webview-guard-behavioral,
//      dream-thumbnail-capture-behavioral, explore-avatar-fallback-
//      behavioral, feed-windowing-behavioral, forming-veil-nebula-
//      behavioral, home-webview-escape-behavioral, install-first-door-
//      behavioral, profile-me-character-behavioral, result-play-intent-
//      behavioral, result-scroll-lock-behavioral, result-thumbnail-
//      crossorigin-capture-behavioral, retention-email-first-video-
//      behavioral, scroll-lock-behavioral, sheet-dismiss-behavioral,
//      a2hs-install-nudge-journey-behavioral, pwa-stage0-behavioral,
//      pwa-sw-update-behavioral, pwa-version-fallback-behavioral,
//      transcript-text-review-behavioral, verify-email-settings-row-
//      behavioral, media-library-page -- NOT email-public-origin.test.js,
//      which round 4 review found was misfiled here: it's the
//      regression test for a real, documented past production incident
//      (broken image/unsubscribe-link URLs in retention emails,
//      tracker for-product-bug-two-blank-square-emails--3fvxvc), not a
//      generation-variant UI test, and stays in the critical tier --
//      this last one is ALSO the repo's one documented pre-existing
//      full-suite-load flake, unrelated to this branch).
//
// HOW A NEW TEST FILE GETS CLASSIFIED (do this when adding one): by
// DEFAULT it's already in the critical tier -- do nothing. Only add it
// to EXCLUDED_FROM_CRITICAL below if it clearly and only matches one of
// the 8 categories above, AND you can point to WHERE its real underlying
// behavior (if any) is covered elsewhere. If it touches money, real user
// data, auth, a race/concurrency/CAS/atomic-write concern, a real fal.ai/
// paid-vendor call with its own rate limit, or a documented past
// production incident -- leave it in, full stop, even if it also has
// some cosmetic assertions mixed in.
//
// This file is intentionally plain data (a `.js` module exporting an
// array, not JSON) so it can carry this documentation inline, matching
// this repo's own no-build-step convention -- see CLAUDE.md.

module.exports = [
  "a2hs-install-nudge-journey-behavioral.test.js",
  "admin-diagnose-dream-edit.test.js",
  "admin-diagnose-lost-generations.test.js",
  "admin-media-library-data.test.js",
  "admin-postpack-data.test.js",
  "admin-recovery-sweep-page.test.js",
  "admin-repair-feed-likes.test.js",
  "admin-repair-lost-generations.test.js",
  "admin-repair-oversized-media.test.js",
  "admin-submit-whatsapp-template.test.js",
  "assemble-instagram-tiktok-postpack.test.js",
  "audio-toggle-behavioral.test.js",
  "audit-lost-generations-page.test.js",
  "avatar-describe-behavioral.test.js",
  "barA-nav-rollout-behavioral.test.js",
  "both-domain-smoke.test.js",
  "chamber-dream-strip-behavioral.test.js",
  "chamber-makeover-behavioral.test.js",
  "content-block-panel-behavioral.test.js",
  "create-record-inapp-webview-guard-behavioral.test.js",
  "deploy-log-store.test.js",
  "dream-thumbnail-capture-behavioral.test.js",
  "effective-config-logging.test.js",
  "email-verify-sheet-behavioral.test.js",
  "explore-avatar-fallback-behavioral.test.js",
  "faq-section-behavioral.test.js",
  "feed-windowing-behavioral.test.js",
  "first-video-created-explore-resume-behavioral.test.js",
  "forming-veil-nebula-behavioral.test.js",
  "founder-alias-exclusion-behavioral.test.js",
  "funnel-distinct-id-behavioral.test.js",
  "generate-version.test.js",
  "get-deploy-count.test.js",
  "get-smoke-status.test.js",
  "home-day0-dream-card-behavioral.test.js",
  "home-mky-copy-behavioral.test.js",
  "home-webview-escape-behavioral.test.js",
  "image-generation-style-toggle-behavioral.test.js",
  "image-generation-turn-into-video-behavioral.test.js",
  "install-first-door-behavioral.test.js",
  "interp-analytics-behavioral.test.js",
  "interp-voice-behavioral.test.js",
  "interp-voice-captions.test.js",
  "interpreter-personas.test.js",
  "legal-pages-behavioral.test.js",
  "logo-purple-retouch-asset-sweep.test.js",
  "media-file-functions.test.js",
  "media-library-page.test.js",
  "meta-capi-behavioral.test.js",
  "mood-music-bed-behavioral.test.js",
  "music-bed-behavioral.test.js",
  "notify-likes-badge-behavioral.test.js",
  "phase1-product-events-behavioral.test.js",
  "poll-until-done-network-retry-behavioral.test.js",
  "posthog-capture.test.js",
  "posthog-identity-merge-behavioral.test.js",
  "posthog-test-traffic-tagging-behavioral.test.js",
  "postpack-caption.test.js",
  "postpack-page.test.js",
  "postpack-selector.test.js",
  "profile-me-character-behavioral.test.js",
  "profile-night-restyle-behavioral.test.js",
  "pwa-stage0-behavioral.test.js",
  "pwa-sw-update-behavioral.test.js",
  "pwa-version-fallback-behavioral.test.js",
  "result-image-render-behavioral.test.js",
  "result-play-intent-behavioral.test.js",
  "result-scroll-lock-behavioral.test.js",
  "result-thumbnail-crossorigin-capture-behavioral.test.js",
  "retention-email-first-video-behavioral.test.js",
  "sage-during-generation-behavioral.test.js",
  "save-whatsapp-number.test.js",
  "scroll-lock-behavioral.test.js",
  "send-whatsapp-morning-capture.test.js",
  "share-sheet-behavioral.test.js",
  "sheet-dismiss-behavioral.test.js",
  "smoke-status-store.test.js",
  "sound-nudge-behavioral.test.js",
  "support-feedback-behavioral.test.js",
  "support-feedback.test.js",
  "sw-fetch-handler.test.js",
  "tracker-behavioral.test.js",
  "tracker-comments-behavioral.test.js",
  "tracker-reviewed-behavioral.test.js",
  "tracker-speak-behavioral.test.js",
  "tracker-waiting-for-behavioral.test.js",
  "tracker.test.js",
  "transcript-text-review-behavioral.test.js",
  "verify-email-settings-row-behavioral.test.js",
  "whatsapp-morning-capture-opt-in-behavioral.test.js"
];
