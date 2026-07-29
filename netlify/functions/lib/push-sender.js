// netlify/functions/lib/push-sender.js
//
// Shared Web Push delivery helper — tracker item for-product-build-
// stage-0-pwa-web-push-f-jbutt5, parts 3/4. Uses the `web-push` npm
// package (the standard reference implementation for the Web Push
// protocol + VAPID — see package.json), matching this codebase's existing
// "small self-contained lib file per concern" convention rather than
// spreading this across each caller.
//
// VAPID CONFIGURATION: `VAPID_PRIVATE_KEY` must be set as a real Netlify
// environment variable before any send actually goes out — see
// docs/PWA_PUSH_SETUP.md for the exact value and setup steps, and
// js/push-config.js's header comment for why the PUBLIC half is safe to
// commit but the private half never is. Every call here fails CLOSED
// (returns `{ ok:false, error:'vapid_not_configured' }`, never throws)
// when it's unset — the safe default for a codebase that already deploys
// with several other "inert until a human sets a real key" features (see
// docs/TURNSTILE_SETUP.md/docs/ANALYTICS_SETUP.md for the identical
// pattern).
//
// DEAD-SUBSCRIPTION CLEANUP: a push service responding 404/410 to a send
// is the Web Push protocol's own standard signal that a subscription will
// NEVER accept another push (uninstalled, permission revoked, or the
// browser's push service itself expired it) — see
// https://developer.mozilla.org/en-US/docs/Web/API/Push_API. Rather than
// silently retrying that endpoint forever, this removes it from
// lib/push-subscription-store.js the moment it's confirmed dead.
//
// 'push_sent' POSTHOG EVENT (part 5 of this feature): fired once per
// account per sendToUser() call that delivers to at least one real
// subscription — mirrors lib/posthog-capture.js's established
// distinct_id-must-match-the-client's-posthog.identify()-value discipline
// (see that file's own header comment) — `username` IS that raw value
// here, not resolved from anything else, since every caller of
// sendToUser already has it on hand.

var webpush = require('web-push');
var pushSubscriptionStore = require('./push-subscription-store');
var posthogCapture = require('./posthog-capture');
var VAPID_PUBLIC_KEY = require('../../../js/push-config').VAPID_PUBLIC_KEY;

var PUSH_TYPES = {
  VIDEO_READY: 'video-ready',
  DAILY_CLAIM_AVAILABLE: 'daily-claim-available'
};

/**
 * Configures web-push's VAPID details. Deliberately re-evaluated on EVERY
 * call rather than cached after the first success: `setVapidDetails` is a
 * trivial, local, no-network call (just stashes the three strings for
 * `sendNotification` to sign requests with later), so there's no real
 * performance reason to cache it, and NOT caching means a Netlify env var
 * change takes effect on this function's very next invocation rather than
 * only after its next cold start — plus it keeps this honestly testable
 * (test/video-ready-push.test.js's "fails closed when VAPID_PRIVATE_KEY
 * isn't configured" case would otherwise only ever see whatever the FIRST
 * call in a given process observed). Returns false (configures nothing)
 * when VAPID_PRIVATE_KEY isn't set — see header comment on why this is
 * the safe default, not an error.
 */
function ensureVapidConfigured() {
  var privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!privateKey) return false;
  // A real, reachable mailto is the Web Push protocol's own recommended
  // VAPID subject (a way for a push-service operator to contact the
  // sender about abuse) — falls back to a generic placeholder if
  // OWNER_EMAIL isn't set, which still functions technically (web-push
  // doesn't validate deliverability) but isn't a real contact address.
  var subject = process.env.OWNER_EMAIL ? 'mailto:' + process.env.OWNER_EMAIL : 'mailto:support@dreamtube.app';
  try {
    webpush.setVapidDetails(subject, VAPID_PUBLIC_KEY, privateKey);
  } catch (e) {
    console.error('push-sender: setVapidDetails failed (malformed VAPID_PRIVATE_KEY?)', e && e.message);
    return false;
  }
  return true;
}

/**
 * Sends `payload` (a plain object — see this file's callers for the
 * shape sw.js's own `push` event handler expects: { title, body, url,
 * type }) to every subscription on file for `username`, stamping
 * `distinctId: username` onto it so sw.js's notificationclick handler can
 * attribute a later 'push_clicked' fire to the right person without any
 * other source of identity (a service worker has no access to this app's
 * localStorage-backed DreamStore state).
 *
 * Returns { ok: true, sent: N, attempted: M } if at least one real send
 * succeeded, or { ok: false, error, attempted } otherwise (no
 * subscriptions on file, VAPID not configured, or every send failed).
 * Never throws — every failure mode here is this feature's own honest
 * degrade, same discipline as every other best-effort notification path
 * in this codebase (see lib/first-dream-email-sender.js).
 */
async function sendToUser(event, username, payload) {
  if (!ensureVapidConfigured()) {
    return { ok: false, error: 'vapid_not_configured', attempted: 0 };
  }

  var subs = await pushSubscriptionStore.getSubscriptions(event, username);
  if (!subs.length) {
    return { ok: false, error: 'no_subscriptions', attempted: 0 };
  }

  var body = JSON.stringify(Object.assign({}, payload, { distinctId: username }));

  var outcomes = await Promise.all(subs.map(function (sub) {
    return webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, body)
      .then(function () {
        return { ok: true };
      })
      .catch(function (err) {
        var statusCode = err && err.statusCode;
        if (statusCode === 404 || statusCode === 410) {
          return pushSubscriptionStore.removeSubscription(event, username, sub.endpoint).then(function () {
            return { ok: false, expired: true };
          });
        }
        console.error('push-sender: sendNotification failed for ' + username, (err && err.message) || err);
        return { ok: false, error: (err && err.message) || 'send_failed' };
      });
  }));

  var sentCount = outcomes.filter(function (o) { return o.ok; }).length;

  if (sentCount > 0) {
    try {
      await posthogCapture.captureEvent({
        event: 'push_sent',
        distinct_id: username,
        properties: { type: payload && payload.type }
      });
    } catch (e) { /* analytics must never break the app */ }
  }

  if (sentCount === 0) {
    return { ok: false, error: 'all_sends_failed', attempted: subs.length };
  }
  return { ok: true, sent: sentCount, attempted: subs.length };
}

module.exports = { PUSH_TYPES, sendToUser, ensureVapidConfigured };
