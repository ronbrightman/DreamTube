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

// This is also the single source of truth for the server side of Meta
// tracking: netlify/functions/lib/meta-capi.js require()s this exact
// META_PIXEL_ID rather than hardcoding its own copy of the literal above,
// so there's exactly one place this ID lives — previously it was
// duplicated independently in both files, a silent-drift risk if the
// Pixel is ever rotated and only one copy gets updated. The guard below
// is a UMD-lite pattern (not full UMD — this codebase has no bundler/ES
// modules, see CLAUDE.md): `typeof module` is `'undefined'` in every
// browser, so this block is a safe no-op there (this file stays a plain
// global-defining <script>, exactly as before); it's `'object'` under
// Node, where a plain `var` alone wouldn't be visible to a require()
// caller at all. Pixel IDs aren't secret (see meta-capi.js's own header),
// so there's no concern about this constant being require()-able.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { META_PIXEL_ID: META_PIXEL_ID };
}

// ---------------------------------------------------------------------
// Meta Conversions API (CAPI) — server-side event tracking that
// complements the client-side Pixel above. See
// netlify/functions/track-conversion.js and
// netlify/functions/lib/meta-capi.js for the server side of this; the
// access token itself never appears anywhere client-side, including here
// — this file only knows the (non-secret) Pixel ID.
//
// Every conversion DreamTube tracks pairs a client-side Pixel call with a
// server-side CAPI call, sharing the SAME event_id between them, so
// Meta's Pixel+CAPI deduplication (matches on event_id + event_name)
// collapses the two into a single counted conversion instead of
// double-counting — this is exactly why Event ID was selected as a
// parameter when CAPI access was set up. fireMetaConversion() below is
// the one place that pairing happens; every page that fires one of these
// events (CompleteRegistration, InitiateCheckout, Purchase, Subscribe —
// Meta *standard* events — or FirstVideoCreated, a Meta *custom* event,
// see the `custom` param doc below) should call this instead of calling
// fbq(...) directly. (Purchase/Subscribe are currently only fired
// server-side, from stripe-webhook.js's real payment-confirmation path —
// see that file's comment — so this function's Purchase/Subscribe
// branches exist for when a client-side moment for them exists too, e.g.
// a checkout-return page; nothing in this codebase calls them yet.)
//
// Standard vs. custom Meta events: Meta's Pixel API has two distinct
// client-side calls — fbq('track', name, ...) for its fixed list of
// *standard* event names (CompleteRegistration/InitiateCheckout/Purchase/
// Subscribe/etc.), and fbq('trackCustom', name, ...) for any other,
// app-defined *custom* event name (FirstVideoCreated is one). CAPI itself
// doesn't draw this distinction server-side — Meta's Conversions API
// endpoint takes event_name as a plain string either way (see
// lib/meta-capi.js's sendCapiEvent — it never validates event_name
// against Meta's standard list, it just forwards whatever the caller
// passed), so the CAPI half of this function is identical for both;
// only the client-side fbq call name changes. See docs/EVENT_TAXONOMY.md
// for the full list of every event this codebase fires, per vendor.
// ---------------------------------------------------------------------

/** New v4 UUID via the browser's crypto API, with a low-tech fallback for the rare browser without crypto.randomUUID. */
function generateEventId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
  return 'evt-' + Date.now() + '-' + Math.random().toString(36).slice(2);
}

/** Reads Meta's own first-party click/browser cookies (_fbc/_fbp), set automatically by the Pixel snippet once it loads. Either can be null (Pixel not loaded yet, an ad blocker, or META_PIXEL_ID still the placeholder above). */
function getMetaCookies() {
  function readCookie(name) {
    var match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return match ? decodeURIComponent(match[1]) : null;
  }
  return { fbc: readCookie('_fbc'), fbp: readCookie('_fbp') };
}

/**
 * Fires both halves of one conversion: the client-side Pixel call
 * (fbq('track', eventName, {}, {eventID: ...}) — or fbq('trackCustom', ...)
 * when `custom` is true, see below) and the server-side CAPI call (POSTs
 * to netlify/functions/track-conversion.js), sharing one generated
 * event_id between them — see the header comment above for why.
 *
 * eventName must be one of the names track-conversion.js's
 * ALLOWED_EVENT_NAMES allows. `extra` can carry { email, external_id,
 * custom_data }; anything else is ignored by the server function.
 *
 * `custom` (optional, default false): pass true for a Meta *custom* event
 * (currently just FirstVideoCreated) so the Pixel call goes out as
 * fbq('trackCustom', ...) instead of fbq('track', ...) — required by
 * Meta's Pixel API for any event name outside its fixed standard-event
 * list (see the header comment above for the standard-vs-custom
 * distinction). The CAPI POST below is unaffected either way — Meta's
 * CAPI endpoint takes event_name as a plain string regardless of which
 * client-side call produced it.
 *
 * Fire-and-forget: analytics must never block or break the actual user
 * flow (same rule every page's existing `track()` PostHog helper
 * already follows), so every failure mode here — fbq not defined yet,
 * the fetch itself rejecting, a non-2xx from the server — is swallowed
 * rather than surfaced.
 */
function fireMetaConversion(eventName, extra, custom) {
  extra = extra || {};
  var eventId = generateEventId();

  if (typeof window.fbq === 'function') {
    try { window.fbq(custom ? 'trackCustom' : 'track', eventName, {}, { eventID: eventId }); } catch (e) { /* analytics must never break the app */ }
  }

  try {
    var cookies = getMetaCookies();
    var body = {
      event_name: eventName,
      event_id: eventId,
      event_source_url: location.href,
      fbc: cookies.fbc,
      fbp: cookies.fbp,
      email: extra.email,
      external_id: extra.external_id,
      custom_data: extra.custom_data
    };
    fetch('/.netlify/functions/track-conversion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).catch(function () { /* analytics must never break the app — network failure here is a no-op */ });
  } catch (e) { /* analytics must never break the app */ }
}
