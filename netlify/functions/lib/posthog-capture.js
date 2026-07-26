// netlify/functions/lib/posthog-capture.js
//
// Server-side PostHog event capture — the missing server-side half of this
// codebase's PostHog wiring. Before this file, PostHog was fired
// client-only, everywhere, via each page's own local `track()` helper
// calling window.posthog.capture() (see docs/EVENT_TAXONOMY.md). That's a
// real gap for anything whose true source of truth is a server event (a
// webhook, a Netlify Function) rather than a browser page load — see
// dodo-webhook.js's Purchase fire, the first caller of this helper, for
// exactly why (misses reloads, cross-device returns, and closed tabs the
// client-side purchase_completed event can never see).
//
// No PostHog server SDK (posthog-node) is installed — this codebase has no
// build step / npm bundling story for a heavier server SDK beyond what's
// already a plain require()-able dependency (see CLAUDE.md), so this is
// instead a thin, dependency-free POST straight to PostHog's public HTTP
// "capture" endpoint (https://posthog.com/docs/api/capture), which is all
// posthog-node itself does under the hood anyway for a single event.
//
// POSTHOG_KEY/POSTHOG_HOST are require()'d from js/analytics-config.js —
// the same single source of truth the client-side <script> snippet on
// every page already reads, and the exact precedent
// netlify/functions/lib/meta-capi.js already set for META_PIXEL_ID (see
// that file's header comment for the full "why one place, not two"
// reasoning, and analytics-config.js's own comment on the UMD-lite
// module.exports guard that makes this require() safe under Node without
// changing how that file behaves as a plain <script> global in the
// browser). Neither value is secret — PostHog's "project API key" is
// designed to be public/embeddable (see https://posthog.com/docs/api) —
// so, like META_PIXEL_ID, there's no concern about this constant being
// require()-able server-side.
//
// distinct_id discipline: this MUST match whatever the client uses, so a
// server-fired event ties to the same PostHog person as that user's
// browser session. The client identifies via
// window.posthog.identify(usernameOrEmail) with the account's raw username
// (no leading '@' — see js/store.js's identifyForAnalytics, called at
// every signup/login site with `username`, never `state.user.handle`).
// Every caller of captureEvent() below must resolve and pass that same raw
// username as distinct_id — resolving it from an email via
// lib/account-store.js's getByEmail when only an email is on hand (e.g.
// dodo-webhook.js, which only ever hears a Payment's email, never a
// username) — never a bare email or an '@'-prefixed handle.
//
// $insert_id: PostHog's own documented event-deduplication mechanism
// (https://posthog.com/docs/data/deduplication) — passing the same
// properties.$insert_id twice within its dedup window collapses to one
// counted event. This is PostHog's equivalent of Meta's Pixel+CAPI
// event_id dedup (see lib/meta-capi.js's header comment) — callers that
// need to dedupe a server-side fire against an existing (or potential)
// client-side fire of the same real-world event should set
// properties.$insert_id to that shared event_id.
//
// Fire-and-forget discipline, same as every other analytics call in this
// codebase ("analytics must never break the app"): every failure mode here
// — missing/placeholder key, a non-2xx response, the fetch itself
// rejecting — is caught and returned as { ok: false, error }, never thrown.
// Callers still choose not to `await` this (or to await but ignore the
// result) when the calling request's own success must never depend on
// PostHog being reachable — see dodo-webhook.js for the pattern.

var POSTHOG_KEY = require('../../../js/analytics-config').POSTHOG_KEY;
var POSTHOG_HOST = require('../../../js/analytics-config').POSTHOG_HOST;

/**
 * Captures one PostHog event server-side via PostHog's public HTTP capture
 * API. `params`:
 *   event        (required) — event name, e.g. 'purchase_completed'
 *   distinct_id  (required) — MUST match the client's posthog.identify()
 *                 value (the account's raw username) — see header comment
 *   properties   (optional object) — event properties, passed through as-is
 *                 (set $insert_id here for dedup against a paired
 *                 client-side fire — see header comment)
 *   timestamp    (optional) — epoch ms or anything `new Date()` accepts;
 *                 defaults to now
 * Returns a Promise of { ok: true } or { ok: false, error }. Never rejects.
 */
async function captureEvent(params) {
  params = params || {};

  if (!POSTHOG_KEY) {
    return { ok: false, error: 'missing_posthog_key' };
  }
  if (!params.event || !params.distinct_id) {
    return { ok: false, error: 'event_and_distinct_id_required' };
  }

  var body = {
    api_key: POSTHOG_KEY,
    event: params.event,
    distinct_id: params.distinct_id,
    properties: params.properties || {},
    timestamp: new Date(params.timestamp || Date.now()).toISOString()
  };

  try {
    var res = await fetch(POSTHOG_HOST + '/capture/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      var text = '';
      try { text = await res.text(); } catch (e2) { /* best-effort detail only */ }
      return { ok: false, error: 'posthog_request_failed: ' + res.status + (text ? ' ' + text : '') };
    }

    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'posthog_network_failure' + (e && e.message ? ': ' + e.message : '') };
  }
}

module.exports = { captureEvent: captureEvent };
