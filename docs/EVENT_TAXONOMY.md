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

### Purchase / Subscribe (Stripe, server-side)

| | |
|---|---|
| **Trigger** | A real Stripe checkout session completes (`checkout.session.completed` webhook) |
| **Fires from** | `netlify/functions/stripe-webhook.js` |
| **Vendors** | Meta CAPI only — server-to-server, no client-side Pixel call for these (no browser page/tab is guaranteed to still be open when a webhook lands) |
| **Guard** | None beyond Stripe's own webhook delivery guarantees |
| **Status** | **Currently dormant** — Stripe was superseded by Dodo Payments as the live processor (see `Purchase / purchase_completed` below for the checkout flow actually in use); this path is unused code left in place, not the live purchase signal |

### Purchase / purchase_completed (Dodo, client-side return trip)

| | |
|---|---|
| **Trigger** | The browser lands back on `shop.html?checkout=success` after a real Dodo Payments checkout, AND the `dreamtube_pending_purchase` sessionStorage marker set right before the outbound redirect to Dodo is still present |
| **Fires from** | `shop.html`'s `handleCheckoutReturn` IIFE, in the `checkout === 'success'` branch |
| **Vendors** | Meta Pixel (standard event, `fbq('track', 'Purchase', ...)`) + Meta CAPI (via `track-conversion.js`, already in `ALLOWED_EVENT_NAMES`) + PostHog (`purchase_completed`, via the page's local `track()` helper) — and since `shop_palette_variant` is registered as a PostHog super-property on every event from this browser (see the shop-palette A/B test comment further up this file), this is the event that lets that experiment be scored by conversion, not just exposure |
| **Guard** | `sessionStorage.dreamtube_pending_purchase` — `purchasePack()` sets it (`{ pack, tokens, price }`, derived from the same `PACK_INFO` map as the visible price tags) immediately before `location.href = data.url` redirects to Dodo, and `handleCheckoutReturn` reads + unconditionally removes it exactly once. Without this, the event would fire off the bare `?checkout=success` query param alone, which anyone can produce by hand (stale bookmark, shared link, manual URL edit) with no real payment behind it — same reasoning as `FirstVideoCreated`'s `dreamtube_just_generated_id` marker below. A reload of the success page, or a cross-device/cross-browser return, has no marker and fires nothing |
| **What's sent** | `value`/`price` and `tokens` come from `PACK_INFO`, not from anything Dodo returns on the redirect — this is a client-side approximation for analytics, not the credited amount (that's decided server-side by `dodo-webhook.js`, independent of this event entirely) |

### FirstVideoCreated / first_video_created

| | |
|---|---|
| **Trigger** | A user's first-ever dream video finishes generating and shows on `result.html` **OR** finishes via `explore.html`'s resume-completion path (a pending job left running when the user navigated away from `processing.html`, picked back up and completed there instead — see `resumePendingJob()`) |
| **Fires from** | Two sites, both required for reliable coverage — see `for-product-make-firstvideocreated-relia-5i9o0t` on `tracker.html` for why a second site was needed: (1) `result.html`, in the IIFE right after the page's first `render()` call; (2) `explore.html`'s `fireFirstVideoCreatedIfEligible()`, called from `resumePendingJob().then()` |
| **Vendors** | Meta Pixel (**custom** event — `fbq('trackCustom', 'FirstVideoCreated', ...)`) + Meta CAPI (via `track-conversion.js`, same `ALLOWED_EVENT_NAMES` allowlist as the four events above) + **PostHog** (`first_video_created`, via `posthog.capture()`) — identical at both fire sites |
| **Guard** | `result.html` requires two independent checks to both pass — see below. `explore.html`'s resume-completion path only needs the second (account-level) one — see the "Why explore.html doesn't need the sessionStorage guard" note below |

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

**Why `explore.html` doesn't need the sessionStorage guard:** the
sessionStorage marker on `result.html` exists purely to distinguish a
fresh post-generation redirect from a later plain revisit/reload of an
old `result.html?id=...` URL for the same dream — see the "Why two
guards, not one" reasoning above. `explore.html`'s resume-completion
call site has no equivalent revisit risk: `fireFirstVideoCreatedIfEligible`
only ever runs inside `resumePendingJob().then()`, which resolves only on
a genuine, just-happened completion of a job that was actually in flight
(never on a page reload or revisit). So the account-level
`markFirstVideoCreatedIfEligible` check alone is sufficient to cover that
specific revisit risk, without needing a second, sessionStorage-based
guard. This also means `explore.html`'s fire site has no
sessionStorage-availability dependency at all — a real advantage on
traffic where sessionStorage may not survive (e.g. Meta/Instagram
in-app browser webviews), though `result.html`'s own direct-landing path
still carries that dependency; see
`for-product-make-firstvideocreated-relia-5i9o0t` on `tracker.html` for
the fuller history of why this event needed hardening.

**Known limitation, not fixed by the above (tracked separately):**
`markFirstVideoCreatedIfEligible`'s account-flag check is only atomic
within a single JS execution context, not across tabs/devices — two tabs
open on the same account's pendingJob at once (e.g. one on
`explore.html`, one on `processing.html`/`result.html`) could in theory
both read the flag as unset before either write lands, and both fire.
This is a pre-existing property of the flag's own design, not introduced
by adding the `explore.html` call site — but that call site does add a
second independent poller against the same shared state, which widens
the window this could occur in. Neither fire site claims an unqualified
"fires exactly once no matter what" guarantee; both rely on this being
rare in practice.

**What's sent:** `style` only (`{ style: dream.style }`), never the dream
caption — the caption is personal, sometimes vulnerable free-text content
(same reasoning as `create.html`'s `#dream-text` session-replay masking,
see `docs/ANALYTICS_SETUP.md`), not something to forward to an ad
platform. `email` is included when the account has one on file (via
`DreamStore.getAccountEmail()`), same as the other events above. Identical
at both fire sites.

**Files touched:**

- `js/analytics-config.js` — `fireMetaConversion()`'s new `custom` param
- `netlify/functions/track-conversion.js` — `FirstVideoCreated` added to
  `ALLOWED_EVENT_NAMES`
- `js/store.js` — `markFirstVideoCreatedIfEligible(dreamId)`
- `processing.html` — sets the `dreamtube_just_generated_id` sessionStorage marker
- `result.html` — new local `track()` PostHog helper + the call site
- `explore.html` — new local `track()` PostHog helper +
  `fireFirstVideoCreatedIfEligible()`, called from the resume-completion
  path (`resumePendingJob().then()`)

### Retention email send — "your dream is ready" (first-dream retention email)

Not a Meta/PostHog conversion event — a real EMAIL send point, included here
because it's triggered from the exact same choke point as `FirstVideoCreated`
above and shares the same fire-once-per-account discipline, so it belongs in
this index for anyone auditing that choke point (tracker.html's
`for-product-retention-email-send-user-th-eke9ra` item, founder-greenlit
2026-07-26 — "start now, before paywall — getting users back is valid now
too"). Goal: day-1 -> day-2+ return.

| | |
|---|---|
| **Trigger** | Same moment `FirstVideoCreated` fires — an account's first-ever completed dream **video** (mediaType scope matches `FirstVideoCreated`'s own — see below) shows on `result.html`, or finishes via `explore.html`'s resume-completion path |
| **Fires from** | `js/store.js`'s `sendFirstDreamEmailBestEffort(dream)`, called from `result.html` and `explore.html`'s `fireFirstVideoCreatedIfEligible`, immediately after the `FirstVideoCreated` calls, both gated on the same `markFirstVideoCreatedIfEligible(dream.id)` check already having returned `true` — no separate eligibility check |
| **What it does** | POSTs `{ username, password, dreamId, caption, style, videoUrl, mediaType }` to `netlify/functions/send-first-dream-email.js`, which first requires a real password re-check via `accountStore.verifyLogin` (review fix — since every account handle is public, a bare client-claimed username alone would let anyone spam a real stranger's inbox and permanently poison their guard below; `password` comes from this account's own already-cached local credential, no new re-auth prompt), then resolves the account's real, verified email from that same just-verified record (the client-supplied username is never trusted for the address itself, same pattern `submit-support-message.js` already established), and — gated on a durable, cross-device "already sent" flag (`lib/first-dream-email-store.js`, keyed per account, checked before send, only ever reached after the password check passes) — emails a Resend "your dream is ready" message: a style-colored banner (no real video-frame thumbnail infra exists, see that file's own comment), a "Watch it" link, and a soft nudge to make another dream |
| **The watch link** | `explore.html?id=` only renders a dream already in the PUBLISHED shared feed — most first dreams are still private at send time, so this uses a new, separate mechanism: `lib/dream-share-token.js` mints a random, 30-day, account-scoped token (same generate/store-in-Blobs/verify shape as `lib/pending-dream-token.js`, but for an existing account's own already-real dream, not a pre-signup one) that lets a new page, `watch.html`, render that one dream via `get-shared-dream.js`, no login required |
| **Media-type scope** | Video only — matches `markFirstVideoCreatedIfEligible`'s own existing scope (it already only counts a dream with a `videoUrl`), kept consistent rather than quietly broadened. An image-only first dream fires neither `FirstVideoCreated` nor this email today |
| **Guard** | `lib/first-dream-email-store.js`'s `markSentOnce(event, username, dreamId)` — a durable, per-account, plain existence-check-then-write flag (same accepted-race shape as every other Blobs-backed store in this codebase), checked server-side BEFORE any send, so even the known client-side cross-tab race already accepted for `FirstVideoCreated` (see above) can send at most once — a losing racer's request always finds the flag already set |
| **Never blocks** | Best-effort throughout, same discipline as `dream-webhook.js`'s `sendReadyEmail`/`request-password-reset.js` — no-ops (logged, not thrown) if `RESEND_API_KEY` isn't configured, if the account has no verified email on file, or if Resend itself rejects the send; never turns into a failure the generation-completion flow surfaces |

**Files touched:**

- `netlify/functions/lib/first-dream-email-store.js` — new, the per-account send-once guard
- `netlify/functions/lib/dream-share-token.js` — new, the private-dream view token
- `netlify/functions/send-first-dream-email.js` — new, the send endpoint
- `netlify/functions/get-shared-dream.js` — new, resolves a share token for `watch.html`
- `watch.html` — new, the unauthenticated dream-view landing page
- `js/store.js` — new `sendFirstDreamEmailBestEffort(dream)`
- `result.html` / `explore.html` — call sites, right alongside the existing `FirstVideoCreated` ones

### ReachedEmailEntry / funnel_step_viewed(email_capture)

Requested by Growth: `CompleteRegistration` only fires on signup
*completion*, which is too low-volume a signal to optimize Meta delivery
against this early. This fires on merely *reaching* the email-entry
screen — everyone who gets this far is a real, higher-volume mid-funnel
intent signal, upstream of the eventual conversion event.

| | |
|---|---|
| **Trigger** | The funnel's email-entry screen (screen 13, `TAGS[cur] === 'email_capture'`) renders |
| **Fires from** | `start.html`'s `render()`, right after the existing generic `funnel_step_viewed` PostHog capture |
| **Vendors** | Meta Pixel (**custom** event — `fbq('trackCustom', 'ReachedEmailEntry', ...)`) + Meta CAPI (via `track-conversion.js`, added to `ALLOWED_EVENT_NAMES`) + PostHog (already covered — `funnel_step_viewed` with `screen: 'email_capture'` is the paired capture, no separate PostHog event needed) |
| **Guard** | None — fires every time this screen renders, same as every other `funnel_step_viewed` step. Re-visiting (browser back) re-fires; that's expected for a volume/reach metric, not a one-time conversion |

**Files touched:**

- `start.html` — the `TAGS[cur] === 'email_capture'` check in `render()`
- `netlify/functions/track-conversion.js` — `ReachedEmailEntry` added to `ALLOWED_EVENT_NAMES`
