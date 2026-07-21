# Analytics setup

DreamTube's launch analytics stack, why it looks the way it does, and exactly
what to do to turn it on for real.

## What's installed

- **PostHog** — primary product analytics: pageviews/autocapture, funnel and
  drop-off tracking (e.g. the onboarding/quiz funnel), and A/B experiments.
  Chosen over GA4 and Mixpanel specifically because PostHog's free tier
  includes real statistical A/B experiment analysis (which variant actually
  won, with confidence) — GA4 has no A/B testing tool at all (Google
  Optimize was discontinued in 2023), and Mixpanel gates experiment analysis
  behind a paid plan.
- **Meta Pixel** — base pixel snippet for Meta ads conversion tracking, since
  the founder is starting with Meta ads only.
- **PostHog `identify()` on signup/login** — wired into `js/store.js`'s
  `signup()`/`login()` functions so a user's activity before and after
  authenticating stitches into one PostHog person.
- **Session-replay input masking** for personal free-text content (see
  below) — this app's whole premise is personal, sometimes vulnerable
  content (what someone dreamed), so this needed to be explicit rather than
  left on defaults.

**Explicitly not installed: GA4.** The founder's only planned ad channel at
launch is Meta, and GA4's single standout advantage over this stack is its
native Google Ads integration (conversion import, Enhanced Conversions,
Smart Bidding signal) — none of which applies without a Google Ads account.
Adding GA4 now would mean wiring and maintaining a second, weaker funnel/event
system (GA4 requires registering every custom event parameter as a Custom
Definition in its UI to make it queryable — real ongoing overhead for a
multi-screen quiz funnel) for no near-term benefit. **If/when Google Ads
becomes a channel, add GA4 following the same pattern used here** — one more
guarded `<script>` block in `js/analytics-config.js` + every page's `<head>`,
gated on a third placeholder constant the same way PostHog and Meta are.

## Where the placeholder keys live, and how to replace them

Both vendor keys live in one file: **`js/analytics-config.js`**.

```js
var POSTHOG_KEY = 'REPLACE_WITH_REAL_POSTHOG_KEY';
var POSTHOG_HOST = 'https://us.i.posthog.com'; // or eu.i.posthog.com — see comment in file
var META_PIXEL_ID = 'REPLACE_WITH_REAL_PIXEL_ID';
```

To go live:

1. Create a PostHog account/project (founder action — an agent can't sign up
   for this) at <https://posthog.com>. Copy the **Project API key** from
   Project Settings, and note whether the project is US- or EU-hosted.
2. Create a Meta Pixel in Meta Events Manager (founder action, same reason)
   and copy its **Pixel ID**.
3. Edit `js/analytics-config.js` and replace the two `REPLACE_WITH_REAL_*`
   placeholder strings with the real values (and `POSTHOG_HOST` if the
   PostHog project is EU-hosted). That's the only file that needs editing —
   every page reads its keys from here.
4. Deploy. Every page's PostHog snippet, Meta Pixel snippet, and the
   `identify()` call in `js/store.js` all check for the literal placeholder
   string and currently no-op if it's still there — once real values are in
   place, all of it activates automatically with no other code changes.

Until step 3 happens, this is completely inert by design: no script loads,
no network calls to PostHog or Meta, no console errors. Safe to have merged
and deployed in the meantime.

## Meta Conversions API (CAPI)

**This is now implemented in code**, superseding the one-click-dashboard
approach originally described here. The founder generated a real CAPI
access token in Meta Events Manager and added it to Netlify's environment
variables as `META_CAPI_ACCESS_TOKEN` on the DreamTube site — that account
setup was the only manual step; everything else is code, already wired:

- `netlify/functions/lib/meta-capi.js` — shared `sendCapiEvent()` helper.
  Builds Meta's documented CAPI payload, hashes PII (`email`/`external_id`
  → SHA-256, lowercased+trimmed first) before sending, and reads
  `META_CAPI_ACCESS_TOKEN` server-side only — the token never reaches the
  client, including in error messages (redacted defensively even from
  network-layer error text).
- `netlify/functions/track-conversion.js` — the client-facing endpoint.
  `POST { event_name, event_id, event_source_url, email?, external_id?,
  fbc?, fbp?, custom_data? }`. `event_name` is restricted to exactly
  `CompleteRegistration`, `InitiateCheckout`, `Purchase`, `Subscribe` —
  not a general-purpose event-forwarding proxy.
- `js/analytics-config.js`'s `fireMetaConversion(eventName, extra)` — the
  one place a page fires one of the four tracked events. Generates one
  `event_id` and fires BOTH the client-side `fbq('track', ...)` Pixel call
  and the server-side `track-conversion.js` POST with that same id, so
  Meta's Pixel+CAPI dedup (matches on event_id + event_name) collapses
  them into a single counted conversion — this is why Event ID was
  selected as a parameter when the access token was set up. Also reads
  the `_fbc`/`_fbp` first-party cookies Meta's Pixel snippet sets, and
  includes them in the CAPI payload.
- Wired call sites: `start.html`'s `attemptSignup()` and `login.html`'s
  `?mode=signup` path (both → `CompleteRegistration`), `start.html`'s
  `renderScreen14()` pricing screen (→ `InitiateCheckout`), and
  `netlify/functions/stripe-webhook.js`'s `checkout.session.completed`
  handler (→ `Purchase` + `Subscribe`, currently dormant — see that
  file's comment — because no real checkout flow calls
  `create-checkout-session.js` yet; nothing fires these two events from
  `start.html`'s temporary payment bypass, deliberately).

If a custom event parameter beyond Meta's standard set is ever needed
(e.g. which A/B variant a converting user saw), add it to the
`custom_data` object at the relevant call site — the plumbing already
supports arbitrary `custom_data`.

## Session-replay privacy: why `#dream-text` is masked

DreamTube asks people to type genuinely personal content — what they
dreamed, sometimes vulnerable material — starting with the `#dream-text`
textarea in `create.html`, and this will extend to future free-text
quiz-funnel screens. Session replay is a powerful debugging/UX tool but by
default would otherwise let anyone with PostHog dashboard access watch that
text appear keystroke by keystroke.

Two independent layers protect this, both intentional and both documented
in code comments at their definition site — **do not remove either without
a deliberate privacy decision**:

1. `session_recording: { maskAllInputs: true }` in every page's PostHog
   init call (in the `<head>` block added by this change) — pins PostHog's
   own default (all input/textarea values are masked in replay) explicitly,
   so a future config change can't silently turn it off unnoticed.
2. The `ph-no-capture` CSS class on `#dream-text` in `create.html` — PostHog's
   documented marker for "never record this element's content in a replay at
   all," a second, independent guarantee for this specific field.

**For any future free-text field carrying personal content** (quiz-funnel
screens, etc.), add the same `ph-no-capture` class to that element.

## Files touched by this setup

- `js/analytics-config.js` — the two placeholder keys (new file)
- `index.html`, `login.html`, `explore.html`, `profile.html`, `create.html`,
  `style.html`, `processing.html`, `result.html`, `home.html` — PostHog +
  Meta Pixel snippets added to `<head>`
- `create.html` — `ph-no-capture` class added to `#dream-text`
- `js/store.js` — `identifyForAnalytics()` helper, called from `signup()`
  and `login()`

**Files touched by the Meta CAPI addition above:**

- `netlify/functions/lib/meta-capi.js` — new, shared `sendCapiEvent()` helper
- `netlify/functions/track-conversion.js` — new, client-facing CAPI endpoint
- `js/analytics-config.js` — `fireMetaConversion()`, `getMetaCookies()`,
  `generateEventId()` helpers
- `start.html` — `attemptSignup()` (CompleteRegistration) and
  `renderScreen14()` (InitiateCheckout)
- `login.html` — `?mode=signup` submit handler (CompleteRegistration)
- `netlify/functions/stripe-webhook.js` — `checkout.session.completed`
  handler (Purchase + Subscribe, dormant until real payment goes live)
