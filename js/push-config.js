// js/push-config.js
//
// Client-safe half of DreamTube's Web Push VAPID keypair — tracker item
// for-product-build-stage-0-pwa-web-push-f-jbutt5, part 3. Same
// "one file, both a browser <script> global and a require()-able Node
// module" UMD-lite pattern js/analytics-config.js already established for
// POSTHOG_KEY/META_PIXEL_ID (see that file's own header comment for the
// full reasoning) — kept in its own file rather than folded into
// analytics-config.js since this is a genuinely different vendor/concern
// (browser Push API, not an analytics pixel).
//
// VAPID_PUBLIC_KEY is NOT a secret — it's the whole point of the
// VAPID (RFC 8292) key PAIR: the public half is meant to travel with
// every client-side pushManager.subscribe() call (see js/push-subscribe.js)
// so the browser's push service can verify that whoever later sends a
// push actually holds the matching PRIVATE key. Safe to ship in a static
// JS file, same non-secret status as POSTHOG_KEY/META_PIXEL_ID above it.
//
// This is a REAL keypair, generated with the standard `web-push` npm
// library's own generateVAPIDKeys() (the reference implementation for
// this — see package.json) — not a placeholder. The matching PRIVATE key
// is deliberately NOT in this file, or anywhere else in this repo: per
// this codebase's existing pattern for every other real secret
// (FAL_KEY/TURNSTILE_SECRET_KEY/OWNER_EMAIL — see docs/TURNSTILE_SETUP.md),
// it must be set as a real Netlify environment variable
// (`VAPID_PRIVATE_KEY`) by a human with access to the live Netlify site's
// settings — see docs/PWA_PUSH_SETUP.md for the exact value and setup
// steps. netlify/functions/lib/push-sender.js reads it from
// `process.env.VAPID_PRIVATE_KEY` only, never from a checked-in file.
var VAPID_PUBLIC_KEY = 'BFZpeJsvF2BZVcMLYn4ZrKoVNYvkkM1qnbwUFSJ5dVkBkTbzEoqL7L8lTelqQQT-5-WbyLTrg09-_g9sIP1qMvY';

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { VAPID_PUBLIC_KEY: VAPID_PUBLIC_KEY };
}
