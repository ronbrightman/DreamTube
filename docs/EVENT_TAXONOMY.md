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
| **Guard** | `sessionStorage.dreamtube_pending_purchase` — `purchasePack()` sets it (`{ pack, tokens, price, eventId }`, derived from the same `PACK_INFO` map as the visible price tags, plus the `eventId` `create-checkout-session-dodo.js` returned — see below) immediately before `location.href = data.url` redirects to Dodo, and `handleCheckoutReturn` reads + unconditionally removes it exactly once. Without this, the event would fire off the bare `?checkout=success` query param alone, which anyone can produce by hand (stale bookmark, shared link, manual URL edit) with no real payment behind it — same reasoning as `FirstVideoCreated`'s `dreamtube_just_generated_id` marker below. A reload of the success page, or a cross-device/cross-browser return, has no marker and fires nothing |
| **What's sent** | `value`/`price` and `tokens` come from `PACK_INFO`, not from anything Dodo returns on the redirect — this is a client-side approximation for analytics, not the credited amount (that's decided server-side by `dodo-webhook.js`, independent of this event entirely) |
| **Known gap this event alone can't cover** | Client-only: misses a reload of the return page, a cross-device/cross-browser return trip, and a closed tab after paying — all real, non-trivial gaps for revenue reporting. See the next entry, the P0 fix for this (Phase 1 reporting instrumentation, tracker item `for-product-phase-1-reporting-instrument-kjlh46`, founder-greenlit 2026-07-26) |

### Purchase / purchase_completed (Dodo, SERVER-SIDE — the durable source of truth)

| | |
|---|---|
| **Trigger** | `dodo-webhook.js` receives and signature-verifies a real `payment.succeeded` event from Dodo, AND resolves both a buyer email and a token amount, AND `entitlements.creditTokenPackOnce` reports `credited: true` for THIS specific call (not a redelivery of an already-processed payment) |
| **Fires from** | `netlify/functions/dodo-webhook.js`'s `firePurchaseConversion`, called immediately after a fresh token credit succeeds |
| **Vendors** | PostHog (`purchase_completed`, via the new `netlify/functions/lib/posthog-capture.js` helper — PostHog's public HTTP capture API, since this codebase has no server-side PostHog SDK) + Meta CAPI (`Purchase`, via `lib/meta-capi.js`'s `sendCapiEvent` directly — no need to round-trip through the client-facing `track-conversion.js` endpoint, since the webhook is already server-to-server) |
| **Why this exists** | Revenue/CPA/ROI reporting was client-side-only before this — the event above misses reloads, cross-device returns, and closed tabs. This webhook is Dodo's own signature-verified confirmation that a payment actually happened (the same reasoning `creditTokenPackOnce` already relies on to credit tokens), so it's the trustworthy, durable place to also report the conversion, independent of whatever the buyer's browser does afterward |
| **Dedup against the client-side event above** | A single `event_id` is minted once, in `create-checkout-session-dodo.js`, at checkout-session-creation time (`crypto.randomBytes(16).toString('hex')`), threaded through Dodo's own `metadata.dreamtube_event_id` (which Dodo echoes back verbatim on `payment.succeeded`) AND returned directly in that function's response (`{ url, sessionId, eventId }`). `shop.html`'s `purchasePack()` stashes it in the same `dreamtube_pending_purchase` sessionStorage object the client-side event above already reads, and its own Purchase fire passes it through as `fireMetaConversion`'s new `explicitEventId` 4th argument (Meta's Pixel+CAPI dedup, matching every other paired event in this file) and as `properties.$insert_id` on the PostHog `track()` call (PostHog's own documented dedup key — see `lib/posthog-capture.js`'s header comment). The webhook's fire uses the exact same `event_id` for both vendors. A purchase whose metadata is missing this field for any reason (e.g. one that happened before this instrumentation shipped) falls back to a fresh id on whichever side is missing it — that specific Purchase simply won't dedupe, which is honest (rather than fabricating a shared id that was never actually shared), not a bug |
| **What's sent** | `value` (USD, resolved server-side via `resolvePackTokens`'s sibling `resolvePackPrice` — prefers matching the payment's actual `product_cart[0].product_id` against `DODO_PRODUCT_PACK_100`/`DODO_PRODUCT_PACK_500`, falling back to `metadata.dreamtube_price`; **never** trusts a client-supplied price, same "don't trust the client for money" rule as every other server-side amount in this codebase) + `currency: 'USD'` + `timestamp` (an ISO string, plus the underlying epoch-ms passed to `lib/posthog-capture.js`'s own `timestamp` param) — this is what makes D1/D4 revenue, CPA, and (eventually, deferred for now) LTV computable straight from this one event, per the tracker item |
| **distinct_id (PostHog)** | The buyer's account **username** (not email, not an `@handle`) — resolved via `lib/account-store.js`'s `getByEmail`, so this server-fired event ties to the exact same PostHog person the buyer's own browser already identified as (`js/store.js`'s `identifyForAnalytics`, called with the raw username at signup/login). Falls back to the normalized email itself only if no matching account record exists (e.g. an unbackfilled legacy local-only account) |
| **Guard against double-reporting a redelivered webhook** | `creditTokenPackOnce` returns `{ credited: boolean }` — `false` means this exact `paymentId` was already fully processed (a genuine Dodo redelivery, or a duplicate resume of an interrupted attempt), a safe no-op for the token BALANCE but not a fresh purchase to report. `firePurchaseConversion` only runs when `credited === true`, so a redelivered `payment.succeeded` never double-fires Purchase even though the balance-crediting path itself is correctly idempotent either way |
| **Never blocks the real credit** | Wrapped in its own `try/catch`, entirely separate from the credit's own error handling — a PostHog/Meta failure can never turn a successful token credit into a 500 (which would make Dodo redeliver and risk a double-credit); "analytics must never break the app" applies to a webhook exactly as much as it does to a page |

### video_created

| | |
|---|---|
| **Trigger** | ANY generation completes — a fresh generate, a resumed pending job, or a regenerate/"Try Again"/"Turn this into a video" upsell — every single one, not just the account's first ever |
| **Fires from** | `js/store.js`'s `finalizeDream` — the one function every completed generation runs through regardless of caller (`startGeneration`'s only call site, itself reached from `result.html`'s fresh-generate flow, `explore.html`'s resume-completion path, and every regenerate/edit-style/turn-into-video flow), so it's the single choke point true for all of them |
| **Vendors** | PostHog only. Deliberately **not** sent to Meta CAPI — this is a raw creation-volume counter, not a discrete "this person just did something rare and conversion-worthy" moment the way `FirstVideoCreated` is; firing it to an ad platform on every single generation has no ad-optimization value and would just be noise there |
| **Guard** | None — fires every time `finalizeDream` runs, by design (this is explicitly meant to be a volume metric, distinct from `first_video_created`'s fire-once-per-account KPI just below) |
| **What's sent** | `{ style, mediaType }` — same non-PII shape as `FirstVideoCreated`, never the dream's caption |
| **Relationship to FirstVideoCreated** | Complementary, not overlapping in purpose: `first_video_created` answers "did this account ever create a video" (a one-time activation KPI); `video_created` answers "how many generations happen, total, across every account, every time" (a volume metric). An account's very first generation fires BOTH events; every generation after that fires only `video_created` |

### video_published

| | |
|---|---|
| **Trigger** | A dream transitions from not-published to published — the actual "Publish" tap, not a later re-sync of an already-published dream |
| **Fires from** | `js/store.js`'s `publishDream(id)` |
| **Vendors** | PostHog only — a publish is a product engagement/content signal, not an ad-optimization conversion |
| **Guard** | `!d.isPublished` checked before flipping it to `true` — `publishDream`'s own `syncPublishedDreamToFeed(d)` call (which POSTs to `publish-dream.js`) is ALSO reached from two other places that are NOT a fresh publish action: `finalizeDream`'s resync of an already-published dream after an edit/regenerate, and `backfillSharedFeed`'s one-time catch-up sync for dreams that were published before the shared feed existed. Firing this event from `publish-dream.js` itself (the server function all three call sites hit identically, with no way to distinguish them from the payload alone) would have over-counted against all three; gating on the actual local state transition, client-side, is what keeps this to real publish actions only |
| **What's sent** | `{ style, mediaType }` |

### like_given / like_received

| | |
|---|---|
| **Trigger** | A dream is liked (not unliked) — `delta === 1` sent to `like-dream.js` |
| **Fires from** | `netlify/functions/like-dream.js` — the single choke-point that already knows the dream, its owner, and the delta, per the tracker item |
| **Vendors** | PostHog only — a like is a social engagement signal, not an ad-optimization conversion |
| **Guard** | Only fires on `delta === 1` (a genuine like). Toggling a like back off (`delta === -1`, an "unlike") fires neither event — these measure real like *actions*, not a net count, and firing a negative-signal event on every unlike (including a fast double-tap undoing an in-flight like) would misrepresent that as its own distinct action |
| **Two different subjects, one action** | `like_given`'s `distinct_id` is the liker (`payload.likerHandle`, sent by `js/store.js`'s `toggleSharedLike` alongside `id`/`delta` — the current browser's own `state.user.handle`, purely for this attribution, with no other effect on the like itself); `like_received`'s `distinct_id` is the dream's owner (`feed[idx].ownerHandle`, already known server-side from the feed record). Both are `@`-prefixed handles in this codebase's local-account model — `like-dream.js`'s `stripHandle()` strips the leading `@` so each matches the raw-username `distinct_id` the corresponding account's browser already identified as. A dream liked by its own owner (self-like) fires both events on the same distinct_id — not specially handled, since that's an honest reflection of what happened |
| **What's sent** | `{ dreamId }` on each |

### signed_up

| | |
|---|---|
| **Trigger** | A brand-new account is actually created — NOT a later login of an existing account from any device |
| **Fires from** | `js/store.js`'s `commitLocalSignup` — the ONE place a new account is ever created (both `signup()`'s server-confirmed branch and its offline-fallback branch route through here; see that function's own comment) |
| **Vendors** | PostHog only, no properties beyond the implicit `distinct_id` PostHog's own `identify()` call (fired immediately before this, same function) already established |
| **Guard** | None needed beyond `commitLocalSignup` itself only ever running once per real signup — unlike `identifyForAnalytics` (called from here AND from every ordinary login, e.g. `attemptLocalLogin`/`login()`), this event is deliberately NOT fired from either login path, so it stays a true signup-completion signal distinct from `CompleteRegistration` (which already exists — this is a dedicated PostHog-only companion, not a replacement) |

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
