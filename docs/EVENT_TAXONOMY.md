# Event taxonomy

Every conversion/analytics event DreamTube fires today, across all three
vendors (Meta Pixel, Meta Conversions API, PostHog), in one place. See
`docs/ANALYTICS_SETUP.md` for the vendor-level setup story (why PostHog +
Meta, why GA4 isn't installed yet, the Meta CAPI mechanism itself); this
file is the event-level index — what triggers each one, which file fires
it, which vendors receive it, and any fire-once/guard semantics.

## Standard vs. custom Meta events

Meta's Pixel API distinguishes two kinds of client-side event:

- **Standard events** — Meta's own fixed, predefined names
  (`CompleteRegistration`, `InitiateCheckout`, `Purchase`, `Subscribe`,
  etc.), fired via `fbq('track', name, ...)`.
- **Custom events** — any other, app-defined name (`FirstVideoCreated`),
  fired via `fbq('trackCustom', name, ...)`.

This only matters for the client-side Pixel call. Meta's Conversions API
(server-side) takes `event_name` as a plain string either way —
`netlify/functions/lib/meta-capi.js`'s `sendCapiEvent()` never validates
it against Meta's standard list, it just forwards whatever
`track-conversion.js` passes through (itself gated by its own
`ALLOWED_EVENT_NAMES` allowlist, the actual security boundary — see that
file's header comment).

`js/analytics-config.js`'s `fireMetaConversion(eventName, extra, custom)`
is the one shared function every event below uses to fire its Pixel +
CAPI pair — pass `custom: true` for a custom event, omit/`false` for a
standard one. See that file's header comment for the full pairing
mechanics (shared `event_id` for Pixel+CAPI dedup, `_fbc`/`_fbp` cookie
forwarding, etc.).

## Events

### CompleteRegistration

| | |
|---|---|
| **Trigger** | A new account is created |
| **Fires from** | `start.html`'s `attemptSignup()`; `login.html`'s `?mode=signup` submit handler |
| **Vendors** | Meta Pixel (standard, `fbq('track', 'CompleteRegistration', ...)`) + Meta CAPI (via `track-conversion.js`) |
| **Guard** | None beyond "signup succeeded" — `DreamStore.signup()` returning `{ ok: true }` is itself a natural one-time gate (a username can't sign up twice) |

### InitiateCheckout

| | |
|---|---|
| **Trigger** | The funnel's pricing/token-intro screen (screen 14) renders, right after a successful signup |
| **Fires from** | `start.html`'s `renderScreen14()` |
| **Vendors** | Meta Pixel (standard) + Meta CAPI |
| **Guard** | None — fires every time screen 14 renders (once per funnel run, since the funnel doesn't allow re-visiting an earlier screen after signup) |

### Purchase / Subscribe

| | |
|---|---|
| **Trigger** | A real Stripe checkout session completes (`checkout.session.completed` webhook) |
| **Fires from** | `netlify/functions/stripe-webhook.js` |
| **Vendors** | Meta CAPI only — server-to-server, no client-side Pixel call for these (no browser page/tab is guaranteed to still be open when a webhook lands) |
| **Guard** | None beyond Stripe's own webhook delivery guarantees |
| **Status** | **Currently dormant** — nothing in this codebase calls `create-checkout-session.js` yet (`start.html`'s pricing screen is a temporary payment bypass); wired and tested, but won't fire in production until a real checkout flow exists |

### FirstVideoCreated / first_video_created

The newest event, added alongside this doc.

| | |
|---|---|
| **Trigger** | A user's first-ever dream video finishes generating and shows on `result.html` |
| **Fires from** | `result.html`, in the IIFE right after the page's first `render()` call |
| **Vendors** | Meta Pixel (**custom** event — `fbq('trackCustom', 'FirstVideoCreated', ...)`) + Meta CAPI (via `track-conversion.js`, same `ALLOWED_EVENT_NAMES` allowlist as the four events above) + **PostHog** (`first_video_created`, via `posthog.capture()`) |
| **Guard** | Two independent checks must both pass — see below |

**Why two guards, not one:**

1. **`sessionStorage.dreamtube_just_generated_id`** — set by
   `processing.html`'s `attachTaskHandlers()` right before it redirects to
   `result.html?id=...` on a successful generation (fresh or
   regenerated), and consumed (read + removed) exactly once by
   `result.html`. This confirms the *current page load* is the actual
   moment generation just finished — not a later revisit or reload of an
   old `result.html?id=...` URL for the same dream. sessionStorage (not a
   query param) specifically so a reload or a copy-pasted/shared URL
   can't carry this signal along with it.
2. **`DreamStore.markFirstVideoCreatedIfEligible(dreamId)`** — an atomic
   check-and-set against the signed-in account's state (see
   `js/store.js`): true only if (a) the account's own
   `firstVideoCreatedFired` flag isn't already set, AND (b) this dream is
   the account's only completed dream (`ownerHandle` match + `videoUrl`
   truthy, count === 1) and it matches the dream just marked as generated.
   Marks the flag and persists in the same call, so there's no separate
   "check" step a second call could race against.

Both guards exist because either alone has a gap the other closes:

- **The persisted-flag guard alone isn't enough on its own**: an account
  that already had exactly one completed dream *before* this feature
  shipped has `firstVideoCreatedFired` unset (accounts don't get
  migrated retroactively). Guarding purely on "flag unset + exactly one
  completed dream" would misfire the very next time that account simply
  *opens* `result.html` for their pre-existing dream — not just when a
  video actually just finished generating. The sessionStorage marker is
  what ties the event to the real generation-completion moment the
  founder asked for ("the moment a user's first-ever dream video
  finishes generating and shows on result.html"), not merely to dream
  count.
- **The sessionStorage marker alone isn't enough either**: it only
  proves "a generation job just completed and redirected here," not
  "this was the account's *first* one." Without the persisted-flag +
  dream-count check, every 2nd/3rd/Nth video would re-fire the event
  too.

Together: the event fires exactly once per account, at the literal moment
their first-ever completed dream lands on `result.html`, and never again
— not on a reload of that page, not on their 2nd+ dream, and not
retroactively for an account that already had exactly one dream before
this feature shipped (their flag stays unset until they generate their
*next* video, at which point the dream count is 2 and the eligibility
check correctly declines to fire at all).

**What's sent:** `style` only (`{ style: dream.style }`), never the dream
caption — the caption is personal, sometimes vulnerable free-text content
(same reasoning as `create.html`'s `#dream-text` session-replay masking,
see `docs/ANALYTICS_SETUP.md`), not something to forward to an ad
platform. `email` is included when the account has one on file (via
`DreamStore.getAccountEmail()`), same as the other events above.

**Files touched:**

- `js/analytics-config.js` — `fireMetaConversion()`'s new `custom` param
- `netlify/functions/track-conversion.js` — `FirstVideoCreated` added to
  `ALLOWED_EVENT_NAMES`
- `js/store.js` — `markFirstVideoCreatedIfEligible(dreamId)`
- `processing.html` — sets the `dreamtube_just_generated_id` sessionStorage marker
- `result.html` — new local `track()` PostHog helper + the call site
