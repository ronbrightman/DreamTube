// js/analytics-config.js
//
// Single shared source of truth for the two analytics vendor keys DreamTube
// needs at launch: PostHog (product analytics, funnels, A/B experiments) and
// Meta Pixel (ad conversion tracking for Meta-only ad spend). See
// docs/ANALYTICS_SETUP.md for the full picture, including why GA4 is
// deliberately NOT installed yet.
//
// Both constants below are placeholders on purpose — no real PostHog or Meta
// account exists yet (creating either is a human sign-up step, not something
// this codebase can do for itself). Every init call on every page checks for
// the literal placeholder string and skips initialization entirely if it's
// still there, so:
//   - this file is safe to ship/deploy right now: no console errors, no
//     network calls to PostHog or Meta, nothing to disable before merging.
//   - the moment real keys are dropped in below, analytics "just works" on
//     every page with zero other code changes.
//
// TO GO LIVE: replace the two REPLACE_WITH_* values below with the real
// values from the founder's PostHog project settings page and Meta Events
// Manager > Pixel > Settings page. That is the ONLY edit needed anywhere in
// the codebase to turn analytics on — every page reads from this one file.

var POSTHOG_KEY = 'phc_qNfAvjah7yJCsMvzDETpCWxj3wzhdRFemfdVZkFGbS7o';

// Region of the founder's PostHog project. PostHog Cloud is region-locked at
// signup time (US or EU) — https://us.i.posthog.com is correct for a US
// project; change to https://eu.i.posthog.com if the project is EU-hosted.
// This only matters once POSTHOG_KEY above is a real key.
var POSTHOG_HOST = 'https://us.i.posthog.com';

var META_PIXEL_ID = '2464464964036457';
