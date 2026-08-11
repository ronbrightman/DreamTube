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
| **Fires from** | `start.html`'s `attemptSignup()` and `renderScreen13Passwordless()` (the passwordless arm); `login.html`'s `?mode=signup` submit handler; `wizard.html`'s `renderWallEmailStep()` (the merged passwordless signup wall, tracker item `for-product-wizard-signup-wall-is-the-ol-lt1l9j` — replaced the former `renderSignup()` username/password wall); `claim-dream.html`'s `fireMetaConversionIfAvailable()` |
| **Vendors** | Meta Pixel (standard, `fbq('track', 'CompleteRegistration', ...)`) + Meta CAPI (via `track-conversion.js`) |
| **Guard** | None beyond "signup succeeded" — `DreamStore.signup()`/`DreamStore.signupPasswordless()` returning `{ ok: true }` is itself a natural one-time gate (a username/email can't sign up twice); the passwordless arm additionally only fires when the server confirms this was a genuinely NEW account (`result.created === true`), never on a resolve-into-an-existing-account (that branch — `pendingVerification:true` — never reaches this call site at all; a subsequent login completed via `login-with-email-code.js`/`renderCodeStep` is explicitly NOT this event either, same "never on a login" rule the other fire sites already follow — see that code path's own `returning_user_login_succeeded` track() call instead). Fires at the exact same funnel depth as `attemptSignup()` — right after the account genuinely exists server-side, before advancing to screen 14 — deliberately unaffected by deferred email verification (verification never blocks or delays this fire, matching the reveal-wall spec's "CompleteRegistration fires at the same depth" requirement). Depth parity across all three `signupVariant` arms ('unified'/'reveal'/'passwordless') was explicitly re-confirmed 2026-08-02 (round-2 security review request) via `test/signup-passwordless-behavioral.test.js`'s real-Chromium `track-conversion.js` interception — the same technique `test/signup-reveal-variant-behavioral.test.js` already used to confirm 'reveal' — genuinely verified, not assumed. |
| **`custom_data.signup_method`** | Tracker item `for-product-signup-method-analytics-foun-y1oqt4` (founder ask, 2026-08-03): every call site above tags a fixed `signup_method` value — `'email'` (`attemptSignup`, `login.html`, `claim-dream.html` — the plain username/password walls) or `'passwordless_code'` (`renderScreen13Passwordless`, and `wizard.html`'s merged wall — which moved off `'email'` when it went passwordless) — forwarded through Meta CAPI's `custom_data` unchanged (`test/meta-capi.test.js`'s "forwards custom_data.signup_method" test) and joinable in PostHog against the same-named property on the paired `signed_up` capture below, since both fire from the same guarded call sites. (A `'facebook'` value existed until Facebook Login was removed, 2026-08-11.) |

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
| **Vendors** | Meta Pixel (standard event, `fbq('track', 'Purchase', ...)`) + Meta CAPI (via `track-conversion.js`, already in `ALLOWED_EVENT_NAMES`) + PostHog (`purchase_completed`, via the page's local `track()` helper) |
| **Guard** | `sessionStorage.dreamtube_pending_purchase` — `purchasePack()` sets it (`{ pack, tokens, price, starter, eventId }`, derived from the same `PACK_INFO` map as the visible price tags, plus the `eventId` `create-checkout-session-dodo.js` returned — see below) immediately before `location.href = data.url` redirects to Dodo, and `handleCheckoutReturn` reads + unconditionally removes it exactly once. Without this, the event would fire off the bare `?checkout=success` query param alone, which anyone can produce by hand (stale bookmark, shared link, manual URL edit) with no real payment behind it — same reasoning as `FirstVideoCreated`'s `dreamtube_just_generated_id` marker below. A reload of the success page, or a cross-device/cross-browser return, has no marker and fires nothing |
| **What's sent** | `value`/`price`, `tokens`, and `starter` (true only for the one-time $0.99 pack099, tracker item `for-product-build-ship-today-founder-app-zn9zyy`) come from `PACK_INFO`, not from anything Dodo returns on the redirect — this is a client-side approximation for analytics, not the credited amount (that's decided server-side by `dodo-webhook.js`, independent of this event entirely) |
| **Known gap this event alone can't cover** | Client-only: misses a reload of the return page, a cross-device/cross-browser return trip, and a closed tab after paying — all real, non-trivial gaps for revenue reporting. See the next entry, the P0 fix for this (Phase 1 reporting instrumentation, tracker item `for-product-phase-1-reporting-instrument-kjlh46`, founder-greenlit 2026-07-26) |

### Purchase / purchase_completed (Dodo, SERVER-SIDE — the durable source of truth)

| | |
|---|---|
| **Trigger** | `dodo-webhook.js` receives and signature-verifies a real `payment.succeeded` event from Dodo, AND resolves both a buyer email and a token amount, AND `entitlements.creditTokenPackOnce` reports `credited: true` for THIS specific call (not a redelivery of an already-processed payment) |
| **Fires from** | `netlify/functions/dodo-webhook.js`'s `firePurchaseConversion`, called immediately after a fresh token credit succeeds |
| **Vendors** | PostHog (`purchase_completed`, via the new `netlify/functions/lib/posthog-capture.js` helper — PostHog's public HTTP capture API, since this codebase has no server-side PostHog SDK) + Meta CAPI (`Purchase`, via `lib/meta-capi.js`'s `sendCapiEvent` directly — no need to round-trip through the client-facing `track-conversion.js` endpoint, since the webhook is already server-to-server) |
| **Why this exists** | Revenue/CPA/ROI reporting was client-side-only before this — the event above misses reloads, cross-device returns, and closed tabs. This webhook is Dodo's own signature-verified confirmation that a payment actually happened (the same reasoning `creditTokenPackOnce` already relies on to credit tokens), so it's the trustworthy, durable place to also report the conversion, independent of whatever the buyer's browser does afterward |
| **Dedup against the client-side event above** | A single `event_id` is minted once, in `create-checkout-session-dodo.js`, at checkout-session-creation time (`crypto.randomBytes(16).toString('hex')`), threaded through Dodo's own `metadata.dreamtube_event_id` (which Dodo echoes back verbatim on `payment.succeeded`) AND returned directly in that function's response (`{ url, sessionId, eventId }`). `shop.html`'s `purchasePack()` stashes it in the same `dreamtube_pending_purchase` sessionStorage object the client-side event above already reads, and its own Purchase fire passes it through as `fireMetaConversion`'s new `explicitEventId` 4th argument (Meta's Pixel+CAPI dedup, matching every other paired event in this file) and as `properties.$insert_id` on the PostHog `track()` call (PostHog's own documented dedup key — see `lib/posthog-capture.js`'s header comment). The webhook's fire uses the exact same `event_id` for both vendors. A purchase whose metadata is missing this field for any reason (e.g. one that happened before this instrumentation shipped) falls back to a fresh id on whichever side is missing it — that specific Purchase simply won't dedupe, which is honest (rather than fabricating a shared id that was never actually shared), not a bug |
| **What's sent** | `value` (USD, resolved server-side via `resolvePackTokens`'s sibling `resolvePackPrice` — prefers matching the payment's actual `product_cart[0].product_id` against `DODO_PRODUCT_PACK_STARTER300`/`_199`/`_499`/`_999`, falling back to `metadata.dreamtube_price`; **never** trusts a client-supplied price, same "don't trust the client for money" rule as every other server-side amount in this codebase) + `currency: 'USD'` + `timestamp` (an ISO string, plus the underlying epoch-ms passed to `lib/posthog-capture.js`'s own `timestamp` param) + `starter` (true only for the one-time $0.99 pack099, resolved via `resolveIsStarterPack` — lets growth measure starter-pack conversion specifically, tracker item `for-product-build-ship-today-founder-app-zn9zyy`) — this is what makes D1/D4 revenue, CPA, and (eventually, deferred for now) LTV computable straight from this one event, per the tracker item |
| **distinct_id (PostHog)** | The buyer's account **username** (not email, not an `@handle`) — resolved via `lib/account-store.js`'s `getByEmail`, so this server-fired event ties to the exact same PostHog person the buyer's own browser already identified as (`js/store.js`'s `identifyForAnalytics`, called with the raw username at signup/login). Falls back to the normalized email itself only if no matching account record exists (e.g. an unbackfilled legacy local-only account) |
| **Guard against double-reporting a redelivered webhook** | `creditTokenPackOnce` returns `{ credited: boolean }` — `false` means this exact `paymentId` was already fully processed (a genuine Dodo redelivery, or a duplicate resume of an interrupted attempt), a safe no-op for the token BALANCE but not a fresh purchase to report. `firePurchaseConversion` only runs when `credited === true`, so a redelivered `payment.succeeded` never double-fires Purchase even though the balance-crediting path itself is correctly idempotent either way |
| **Never blocks the real credit** | Wrapped in its own `try/catch`, entirely separate from the credit's own error handling — a PostHog/Meta failure can never turn a successful token credit into a 500 (which would make Dodo redeliver and risk a double-credit); "analytics must never break the app" applies to a webhook exactly as much as it does to a page |

### Subscribe / Purchase / purchase_completed (Dreamer Pass subscription, SERVER-SIDE)

| | |
|---|---|
| **Trigger** | `dodo-webhook.js` receives and signature-verifies a real Dreamer Pass charge — either a `payment.succeeded` that's the FIRST real charge (trial-end conversion, or a non-trial first payment; routed through `handleDreamerPassPayment`), or a `subscription.renewed` event carrying a `payment_id` (a monthly renewal; routed through `handleSubscriptionEvent`) — AND `entitlements.creditTokenPackOnce` (via `grantDreamerPassCharge`) reports `credited: true` for THIS specific call, not a redelivery of an already-processed charge |
| **Fires from** | `netlify/functions/dodo-webhook.js`'s `fireDreamerPassConversion` — a SIBLING of `firePurchaseConversion` above (not a generalization of it — the two charge shapes are different enough that sharing one function would mean threading pack-only concepts through a call site that has none of them), called immediately after a fresh Dreamer Pass token credit succeeds, from both `handleDreamerPassPayment` and `handleSubscriptionEvent`'s `subscription.renewed` branch |
| **Vendors** | PostHog (`purchase_completed`, same helper and event name as the pack path above — PostHog has no Subscribe/Purchase distinction, so `subscription: true` + `renewal: true/false` properties carry that distinction instead, for growth to filter on) + Meta CAPI, via `lib/meta-capi.js`'s `sendCapiEvent` |
| **Why this exists** | The Dreamer Pass has been **LIVE FOR EVERYONE since 2026-08-09** (`shop.html`'s "Dreamer Pass is LIVE FOR EVERYONE" comment, founder "flip for everyone" — real customers can subscribe today) but had **NO conversion event of its own** until this instrumentation (tracker item `for-product-build-conversion-tracking-fo-k5ow3q`) — the pack path already had durable server-side Purchase tracking; the subscription did not, meaning real subscription revenue had been flowing completely untracked in Meta CAPI/PostHog since go-live. This closes that active gap, it is not tracking wired ahead of a future launch |
| **Meta event name: `Subscribe` vs. `Purchase`** | `Subscribe` fires for the FIRST real charge (`handleDreamerPassPayment`); `Purchase` fires for every later renewal (`handleSubscriptionEvent`'s `subscription.renewed` branch) — the standard Meta convention (Subscribe = subscription start, Purchase = each subsequent charge), which is what lets Meta's own subscription-value reporting work correctly. This mirrors the pack path's "fire per confirmed newly-credited payment" behavior, not a "once ever per account" gate — growth wants total ad-attributed subscription revenue tracked (every renewal counts), not just the first conversion |
| **`event_id` / dedup** | Deliberately NOT resolved the same way as the pack path's `payment.metadata.dreamtube_event_id` for every case. `create-checkout-session-dodo.js` does mint an `eventId` and thread it through `metadata.dreamtube_event_id` on a Dreamer Pass checkout too — but a subscription's metadata lives on the SUBSCRIPTION object and is echoed back verbatim on every event for that subscription's whole lifetime, unlike a pack's metadata (fresh per checkout/payment). Reusing that one static id across multiple distinct renewal charges would make Meta's own `event_id` dedup collapse every renewal after the first into "already seen" — silently dropping real conversions. So: the FIRST charge (a genuine 1:1 match between the checkout session that minted the id and this one first charge) passes that metadata id through; every renewal mints a fresh id instead. The Dreamer Pass checkout flow IS live (`shop.html`'s `purchasePlan`) and does fire its own client-side event on return — but that's `subscription_started` (PostHog only, no Meta pair), fired at trial-START (a `$0` authorization, not a real charge; see `shop.html`'s `handleCheckoutReturn`). Neither the first real charge (which lands up to 3 days later, off a separate webhook delivery) nor any renewal has a same-event-name client-side fire to dedupe against — this server-side event is the only place either moment is ever reported |
| **`value` (never trusted from the client)** | Resolved from the REAL Dodo object each call site is holding — `payment.total_amount` (in cents, the actual amount charged including tax) for the first charge, `sub.recurring_pre_tax_amount` (in cents) for a renewal, since a `subscription.renewed` event carries no nested Payment object with its own `total_amount`. Both are divided by 100 for the reported `value`; `currency` is read off the same object (`payment.currency` / `sub.currency`), falling back to `'USD'`. There is no Dreamer-Pass-equivalent of `resolvePackPrice`'s lookup table — the $9.99 list price is never hardcoded as the reported value, only ever the actual object field. If neither resolves to a real positive number, the conversion fire is skipped entirely (same "don't guess" posture as `resolvePackPrice`'s own undefined-return contract) — the token credit itself is unaffected either way |
| **`subscription`/`renewal`/`plan` properties (PostHog)** | `subscription: true` on every fire from this event; `renewal: false` on the first charge, `true` on a renewal; `plan: entitlements.DREAMER_PASS_PLAN` (`'dreamer_pass'`) |
| **distinct_id (PostHog)** | Same resolution as the pack path above — the buyer's account username via `lib/account-store.js`'s `getByEmail`, falling back to the normalized email |
| **Guard against double-reporting a redelivered/duplicate charge** | Same `credited: true` gate as the pack path, via `grantDreamerPassCharge`'s `entitlements.creditTokenPackOnce` call — a redelivered `payment.succeeded`, OR a `subscription.renewed` and a `payment.succeeded` sharing the same underlying `payment_id` (both real Dodo behaviors this handler already dedupes for the token credit itself), never double-fires the conversion |
| **Never blocks the real credit** | Same `try/catch` isolation as `firePurchaseConversion` — a PostHog/Meta failure can never turn a successful subscription token credit into a failed webhook response |

### video_created

| | |
|---|---|
| **Trigger** | ANY generation completes — a fresh generate, a resumed pending job, or a regenerate/"Try Again"/"Turn this into a video" upsell — every single one, not just the account's first ever |
| **Fires from** | `js/store.js`'s `finalizeDream` — the one function every completed generation runs through regardless of caller (`startGeneration`'s only call site, itself reached from `result.html`'s fresh-generate flow, `explore.html`'s resume-completion path, and every regenerate/edit-style/turn-into-video flow), so it's the single choke point true for all of them |
| **Vendors** | PostHog only. Deliberately **not** sent to Meta CAPI — this is a raw creation-volume counter, not a discrete "this person just did something rare and conversion-worthy" moment the way `FirstVideoCreated` is; firing it to an ad platform on every single generation has no ad-optimization value and would just be noise there |
| **Guard** | None — fires every time `finalizeDream` runs, by design (this is explicitly meant to be a volume metric, distinct from `first_video_created`'s fire-once-per-account KPI just below) |
| **What's sent** | `{ style, mediaType, duration_ms }` — same non-PII shape as `FirstVideoCreated`, never the dream's caption. `duration_ms` (tracker item `for-product-track-avg-video-generation-t-2ci8ue`, founder ask 2026-08-10: "track average video/image generation time") is `Date.now() - startedAt`, where `startedAt` is `startGeneration`'s own hoisted submission timestamp (the same moment `pollUntilDone`'s `MAX_POLL_MS` budget and the persisted `pendingJob.startedAt` both measure from) — same `_ms` naming convention `js/interpret-experience.js`'s `interp_voice_complete` event already uses. `null` on the same honest-gap basis as every other forward-only field in `finalizeDream` (should be unreachable today — the sole call site always passes it — but never fabricated if it somehow doesn't) |
| **Relationship to FirstVideoCreated** | Complementary, not overlapping in purpose: `first_video_created` answers "did this account ever create a video" (a one-time activation KPI); `video_created` answers "how many generations happen, total, across every account, every time" (a volume metric). An account's very first generation fires BOTH events; every generation after that fires only `video_created` |

### generation_slow

Tracker item `for-product-track-avg-video-generation-t-2ci8ue` (founder ask,
2026-08-10): "alert if any single job exceeds 3 minutes" — the founder's own
explicit stated threshold (180000ms, not derived from any other constant in
this codebase — see `js/store.js`'s `GENERATION_SLOW_THRESHOLD_MS`, kept
deliberately separate from `MAX_POLL_MS`'s 10-minute "give up entirely"
ceiling; a generation can cross this and still finish completely normally).

| | |
|---|---|
| **Trigger** | The completed job's own `duration_ms` (see `video_created` above) exceeds 180000ms |
| **Fires from** | `js/store.js`'s `finalizeDream`, immediately after `video_created`, on the SAME completed job |
| **Vendors** | PostHog only — an internal reliability/ops signal, not an ad-optimization conversion |
| **Guard** | `durationMs !== null && durationMs > GENERATION_SLOW_THRESHOLD_MS`. A SEPARATE event, not just a flag property riding along on `video_created` — deliberately, so Growth/Ron can build a PostHog alert/insight directly off this event's own volume without first having to filter `video_created` by a duration property (mirrors how `tokens_refunded` is its own event rather than a flag on `video_created`, even though both describe the same underlying job). Only ever fires alongside `video_created` on the same job, never on its own |
| **What's sent** | `{ style, mediaType, modelUsed, duration_ms }` — `modelUsed` (video-only, null otherwise — same convention as `model_used`'s own field) is included specifically so a slow job can be chased down by model/style, per the founder's own ask |

### generation_failed

Tracker item `for-product-track-avg-video-generation-t-2ci8ue` (founder ask,
2026-08-10): "the true fail/vanish rate" — before this event, PostHog could
only see `tokens_refunded` (fired 0 times against 205 `video_created` over
60 days of real production data — see that event's own entry above), which
covers only the narrow E205/E208-refund-eligible subset of failures, never
a poll timeout, a transport-level hiccup, or a completed generation whose
dream record never confirmed syncing. This event covers EVERY terminal
failure shape, not just the refund-eligible one, from two independent choke
points.

| | |
|---|---|
| **Trigger (choke point 1 — a real rejected generation)** | `startGeneration`'s own outer `.catch` rejects for any reason: a real fal-reported error passed through as-is (E205/E208/E505/E508, and every other E1xx-E5xx code — not just the refund-eligible subset), a client-side poll timeout (`E301: generation_timeout`), a sustained poll network failure (`E302`), or a submission-time failure (`E303`/`E399`, or an E1xx/E4xx from `generate-video.js`/`generate-image.js`) |
| **Trigger (choke point 2 — the E304 "vanish" shape)** | `attemptPrivateDreamSync`'s own local retry budget (`PRIVATE_DREAM_SYNC_RETRY_DELAYS_MS`, 3 attempts total) is fully exhausted for a dream that still has no confirmed server-side dream-sync copy — i.e. the generation itself genuinely succeeded, only ITS SYNC failed. This is the exact observable shape of the P0 data-loss "vanish" incident (tracker item `for-product-p0-data-loss-founder-repro-0-6bzvv1`, fix merged as commit `7b7828c`) — this event OBSERVES that shape recurring, it does not re-fix the sync mechanism itself (already hardened by that earlier fix: retry-with-backoff plus `retryUnconfirmedPrivateDreamSyncs`' load-time sweep). Deliberately re-fires every time this gives up again for the same still-unconfirmed dream (e.g. a later page load's sweep retrying and exhausting again) — each occurrence is a real, continued instance being observed, not a one-time flag |
| **Fires from** | `js/store.js`'s `startGeneration` (.catch) and `attemptPrivateDreamSync` (terminal give-up) |
| **Vendors** | PostHog only — an internal reliability signal, not an ad-optimization conversion |
| **Guard (choke point 1)** | Deliberately SKIPPED for a STALE/superseded edit's late failure (`isStaleEdit` — see `js/store.js`'s own doc comment) — that attempt is already silently ignored elsewhere in the app (no error toast; the newer attempt owns `pendingJob` and settles on its own), so firing here too would double-count against the same dream's other, live attempt. Regression-covered by `test/generation-instrumentation-behavioral.test.js`'s own stale-edit test |
| **What's sent** | `{ reason, mediaType, elapsed_ms, model }`, plus `dreamId` on choke point 2 only (review finding: since that fire deliberately re-triggers on the SAME dream across repeated retry-budget exhaustions, raw event volume alone can't distinguish one repeatedly-observed vanished dream from several distinct ones — `dreamId` lets a downstream query dedupe to a true distinct-dream count; `dream.id` is already sent to the server elsewhere, e.g. the first-dream email send, so this adds no new exposure). `reason` is the same `"ENNN: ..."` string convention this codebase already uses elsewhere (`tokens_refunded`'s own `reason`, `err.message` verbatim for choke point 1) — or the synthetic `'E304: dream_sync_unconfirmed'` tag for choke point 2 (see `js/store.js`'s own E3xx doc block for why E304 was added to that same range purely for a consistent reason-code shape, even though it's never a thrown/rejected JS `Error` the way E301-E303/E399 are). `elapsed_ms` is time-since-submission for choke point 1 (mirrors `video_created`'s own `duration_ms`, measured from the same hoisted `startedAt`) or time-since-dream-creation for choke point 2 (`Date.now() - dream.createdAt` — a long-unconfirmed dream is a more useful signal there than the short, fixed ~3.3s local retry-burst window itself would be). `model` is whichever rotation-eligible model key the job reported (video only, null otherwise — same convention as `model_used`) |
| **Known gap this build's investigation surfaced (not fixed here — instrumentation only)** | Re: the `tokens_refunded` silence this event exists to help explain — no code-level wiring bug was found in the refund→event pipeline itself (`video-status.js`/`image-status.js`'s `refundAndReport`, `lib/entitlements.js`'s `refundTokensOnce`, `lib/job-owners.js`'s fail-closed-by-design authorization check, `lib/posthog-capture.js`'s production-safe test guard — all read correctly wired end to end). The more likely explanation: `tokens_refunded` only ever fires for the narrow E205/E208 subset (a fal-CONFIRMED failure), while a real transport-level hiccup (E203/E204/E206/E207 — never refund-eligible, per `REFUND_ELIGIBLE_CODES`'s own deliberate scope) still rejects the user-visible generation exactly the same way. If those transient codes are common in production (a separate tracker item, `for-product-netlify-cost-deploys-are-97--9vbpd4`, references a 17.6% raw status-check request error rate, though that figure was never confirmed to mean "17.6% of jobs fail" specifically), most real user-facing failures may already be landing outside refund-eligible scope by design, not by bug. `generation_failed`'s full reason-code breakdown (once real production data accumulates) is what will make this empirically answerable rather than a guess — revisiting `REFUND_ELIGIBLE_CODES`'s scope with that real distribution is a follow-up decision for the founder, not something this build changes |

**Files touched:**

- `js/store.js` — `GENERATION_SLOW_THRESHOLD_MS`, `startGeneration`'s hoisted `startedAt` (now also carried through submission-time failures, not just post-submission ones), `finalizeDream`'s `durationMs`/`video_created`'s new `duration_ms` property/new `generation_slow` fire, `startGeneration`'s outer `.catch`'s new `generation_failed` fire, `attemptPrivateDreamSync`'s new E304 `generation_failed` fire on terminal give-up, new E304 doc block
- `test/generation-instrumentation-behavioral.test.js` — new, full behavioral coverage for all of the above
- `docs/TEST_REGISTRY.md` — new row

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

### tokens_refunded

Founder-approved auto-refund policy (tracker item `idea-auto-refund-policy`,
2026-07-26): "refund IMMEDIATELY on every post-submission generation failure
(E205/E208-class), not once/day. Server-side, in the same path that marks
the dream failed; credit back the exact cost (100 video / 10 image);
idempotent per job-id... Instrument `tokens_refunded` event (job id, cost,
reason) so refund volume is visible from launch day." Tokens only — a real
money refund (Dodo Payments purchase) stays a manual, support-driven
process, untouched by this event or the crediting mechanism behind it.

| | |
|---|---|
| **Trigger** | `video-status.js`/`image-status.js` (the two places that check a submitted fal.ai job's status) determine, on fal's own authority, that the job is refund-eligible — E205/E208 for video, E505/E508 for image (fal itself marked the job failed, or it completed with no usable video/image URL back) — AND `lib/entitlements.js`'s `refundTokensOnce` reports `refunded: true` for THIS specific job id (not a resumed/redelivered poll of an already-refunded job) |
| **Fires from** | `netlify/functions/video-status.js`'s `refundAndReport` / `netlify/functions/image-status.js`'s `refundAndReport` — called from each file's `exports.handler`, right where the refund-eligible error is about to be returned to the client |
| **Vendors** | PostHog only — an internal cost/reliability signal, not an ad-optimization conversion (same reasoning as `video_created`/`like_given`) |
| **Scope: only E205/E208-class, not every error code** | A transport-level hiccup talking to fal (E203/E204/E206/E207 and their E5xx counterparts) doesn't actually prove the job failed — only that this particular status check couldn't confirm either way — so those stay outside automatic refund/event scope entirely; the existing support-form fallback covers them, per the founder's own spec |
| **Idempotency** | `refundTokensOnce` folds the job id into the SAME Blobs write as the balance credit (a new `refundedJobIds` array on the per-email entitlement record, alongside `tokens.balance`) — mirrors `creditTokenPackAmountOnce`'s own "both facts, one write" fix for Dodo purchase crediting, for the identical reason (a page reload mid-poll re-polls the same operationName from scratch, and fal's own job status is terminal/stable, so a resumed poll of an already-failed job would otherwise refund a second time). The event only fires on a genuine fresh refund (`refunded: true`), never on a dedup no-op — same "only fire on the real thing" discipline as `dodo-webhook.js`'s `firePurchaseConversion` (`credited === true` gate) |
| **distinct_id** | The account's raw username, resolved via `lib/account-store.js`'s `getByEmail` from the email the client's poll carried — falls back to the normalized email itself if no matching account record exists, same resolution `dodo-webhook.js`'s server-side Purchase event already uses |
| **What's sent** | `{ jobId, cost, reason, mediaType }` — `jobId` is the operationName (fal's own request id, prefixed `fal:<model>:` — or `mock:...`, though the mock path never actually fails/refunds by design), `cost` is the exact token amount refunded (100 video / 10 image, matching what was actually spent for that job type), `reason` is the full `"ENNN: ..."` error string that triggered the refund, `mediaType` is `'video'` or `'image'` |
| **Never blocks the failure notice** | `refundAndReport` never throws — a refund attempt that hits a genuine Blobs write exhaustion (see `refundTokensOnce`'s own "EXHAUSTION MUST THROW" doc comment) is caught and logged, not surfaced as a 500; the generation-failure response the user is waiting on always still reaches them. There's no webhook-style redelivery mechanism here to give a thrown error a real second attempt the way `dodo-webhook.js` has, so this fails soft rather than fail closed — the support-form fallback is the intended catch-all for that rare case |
| **Client-visible effect** | `video-status.js`/`image-status.js`'s response carries `tokensRefunded: true` only when a refund genuinely landed just now; `js/store.js`'s `pollUntilDone` attaches this to the rejected `Error` object (`err.tokensRefunded`) rather than encoding it into the `"ENNN: reason"` string, and `processing.html`'s failure screen shows "Your tokens were returned." only when that flag is set — never assumed just because generation failed at all |

**Files touched:**

- `netlify/functions/lib/entitlements.js` — new `refundTokensOnce`, new `refundedJobIds` field on the entitlement record
- `netlify/functions/video-status.js` / `netlify/functions/image-status.js` — new `refundAndReport`/`isRefundEligibleError`, wired into each `exports.handler`
- `js/store.js` — `pollUntilDone` now threads `email` through to the status-poll request and attaches `tokensRefunded` to a rejected generation-failure `Error`
- `processing.html` — new `#proc-fail-refund` copy line, shown conditionally in the failure `.catch` handler

### signed_up

| | |
|---|---|
| **Trigger** | A brand-new account is actually created — NOT a later login of an existing account from any device |
| **Fires from** | `js/store.js`'s `commitLocalSignup` (email) and `commitLocalPasswordlessSignup` (passwordless_code) — the two places a new account is ever created via those paths (both `signup()`'s server-confirmed branch and its offline-fallback branch route through `commitLocalSignup`; see that function's own comment) |
| **Vendors** | PostHog only |
| **`signup_method` property** | Tracker item `for-product-signup-method-analytics-foun-y1oqt4` (founder ask, 2026-08-03): `'email'` or `'passwordless_code'` — see `CompleteRegistration`'s own `custom_data.signup_method` entry above for the full per-site breakdown; both events fire from the same guarded call sites so the two are directly joinable, with no properties beyond `signup_method` and the implicit `distinct_id` PostHog's own `identify()` call (fired immediately before this, same function) already established. (A `'facebook'` value existed until Facebook Login was removed, 2026-08-11.) |
| **Guard** | None needed beyond each fire site itself only ever running once per real signup — unlike `identifyForAnalytics` (called from here AND from every ordinary login, e.g. `attemptLocalLogin`/`login()`), this event is deliberately NOT fired from any login path, so it stays a true signup-completion signal distinct from `CompleteRegistration` (which already exists — this is a dedicated PostHog-only companion, not a replacement) |

> **Removed 2026-08-11:** the `signup_facebook_*` events (`signup_facebook_click`,
> `signup_facebook_started`, `signup_facebook_completed`, `signup_facebook_error_shown`)
> were retired with the Facebook Login feature. `signup_method` now only ever
> takes `'email'` or `'passwordless_code'`.

### FirstVideoCreated / first_video_created

| | |
|---|---|
| **Trigger** | A user's first-ever dream video finishes generating and shows on `result.html` **OR** finishes via `explore.html`'s resume-completion path (a pending job left running when the user navigated away from `processing.html`, picked back up and completed there instead — see `resumePendingJob()`) |
| **Fires from** | Two sites, both required for reliable coverage — see `for-product-make-firstvideocreated-relia-5i9o0t` on `tracker.html` for why a second site was needed: (1) `result.html`, in the IIFE right after the page's first `render()` call; (2) `explore.html`'s `fireFirstVideoCreatedIfEligible()`, called from `resumePendingJob().then()` |
| **Vendors** | Meta Pixel (**custom** event — `fbq('trackCustom', 'FirstVideoCreated', ...)`) + Meta CAPI (via `track-conversion.js`, same `ALLOWED_EVENT_NAMES` allowlist as the four events above) + **PostHog** (`first_video_created`, via `posthog.capture()`) — identical at both fire sites |
| **Guard** | `result.html` requires two independent checks to both pass — see below. `explore.html`'s resume-completion path only needs the second (account-level) one — see the "Why explore.html doesn't need the sessionStorage guard" note below |

**Why two guards, not one:**

1. **`DreamStore.wasOperationJustCompleted(operationName)`** (a durable,
   server-side marker — see `netlify/functions/lib/generation-completion-
   store.js`, `netlify/functions/mark-generation-completed.js` /
   `consume-generation-marker.js`) — set by `processing.html`'s
   `attachTaskHandlers()` (via
   `DreamStore.markGenerationJustCompleted(operationName)`) right before
   it redirects to `result.html?id=...` on a successful generation (fresh
   or regenerated), and consumed (read + deleted) exactly once by
   `result.html`, using the dream's own `sourceOperationName` field (see
   `js/store.js`'s `finalizeDream`). This confirms the *current page load*
   is the actual moment generation just finished — not a later revisit or
   reload of an old `result.html?id=...` URL for the same dream. Keyed by
   `operationName`, not `dreamId` — see the security note below.
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
  video actually just finished generating. The durable "just completed"
  marker is what ties the event to the real generation-completion moment
  the founder asked for ("the moment a user's first-ever dream video
  finishes generating and shows on result.html"), not merely to dream
  count.
- **The "just completed" marker alone isn't enough either**: it only
  proves "a generation job just completed," not "this was the account's
  *first* one." Without the persisted-flag + dream-count check, every
  2nd/3rd/Nth video would re-fire the event too.

Together: the event fires exactly once per account, at the literal moment
their first-ever completed dream lands on `result.html`, and never again
— not on a reload of that page, not on their 2nd+ dream, and not
retroactively for an account that already had exactly one dream before
this feature shipped (their flag stays unset until they generate their
*next* video, at which point the dream count is 2 and the eligibility
check correctly declines to fire at all).

**Why guard #1 moved off sessionStorage (2026-07-27, tracker.html's
`result-htmls-firstvideocreated-still-dep-qfg48t`):** the original
version of guard #1 was a `sessionStorage.dreamtube_just_generated_id`
marker — same "prove this page load is the fresh moment" job, just
carried in sessionStorage instead of server-side. That carrier didn't
reliably survive some FB/IG in-app-browser webview redirects from
`processing.html` to `result.html` — exactly where this app's paid ad
traffic lands, and exactly the event Meta optimizes ad delivery toward —
so the event silently undercounted there. The FIX is a durable carrier,
not a semantics change: the founder's own framing was "keep
moment-of-completion, make the carrier durable."

**Why keyed by `operationName`, not `dreamId` (review finding, fixed
2026-07-27 — see git history for the original, vulnerable version): the
first cut of this fix used a server-side marker keyed by `dreamId`,
chosen over a per-email flag (the other option on the table) because
`netlify/functions/lib/account-store.js` only backfills an account
server-side if it has an email (`js/store.js`'s
`backfillAccountServerSide`) — gating on server-verified account identity
the way `send-first-dream-email.js` does would have silently stopped
working for every account without an email on file. That reasoning was
right, but `dreamId` itself turned out to be the wrong key: dream ids are
client-invented AND already public elsewhere in this app
(`explore.html`/`profile.html`/`watch.html` links, `profile.html`'s own
dreams grid being the ORDINARY way a user revisits their own past
dream) — so keying the marker on `dreamId` meant any unauthenticated
caller who merely knew/guessed a real one could plant a marker for it,
which the victim's own next ordinary revisit would silently consume,
forging a `FirstVideoCreated` fire for an account that never actually
just generated anything. Strictly worse than the sessionStorage design it
replaced (settable only by the victim's own browser from a real redirect).
The fix re-keys on the job's own server-issued `operationName` instead —
never client-invented, never exposed in any UI/URL anywhere in this app —
AND has `mark-generation-completed.js` independently RE-VERIFY (against
fal's own status endpoint, or the mock path's embedded-timestamp check)
that the claimed `operationName` genuinely completed before writing
anything, rather than trusting a bare client claim. See
`netlify/functions/lib/generation-completion-store.js`'s and
`mark-generation-completed.js`'s own header comments for the full
mechanics, and `test/generation-completion-marker.test.js`'s
`SECURITY:`-prefixed tests for the regression coverage.**

**Why `explore.html` doesn't need guard #1 at all:** guard #1 (whichever
carrier) exists purely to distinguish a fresh post-generation redirect
from a later plain revisit/reload of an old `result.html?id=...` URL for
the same dream — see the "Why two guards, not one" reasoning above.
`explore.html`'s resume-completion call site has no equivalent revisit
risk: `fireFirstVideoCreatedIfEligible` only ever runs inside
`resumePendingJob().then()`, which resolves only on a genuine,
just-happened completion of a job that was actually in flight (never on
a page reload or revisit). So the account-level
`markFirstVideoCreatedIfEligible` check alone is sufficient to cover that
specific revisit risk, without needing a second guard at all. This also
means `explore.html`'s fire site has no dependency on guard #1's carrier
(sessionStorage before, the durable marker now) — see
`for-product-make-firstvideocreated-relia-5i9o0t` on `tracker.html` for
the fuller history of why this event needed hardening.

**PostHog sanity check — `first_video_result_view`:** a distinct,
PostHog-only event fired from `result.html` (via
`DreamStore.isOnlyCompletedDream(dreamId)`, a pure read-only query — same
eligibility computation as guard #2 above, minus its one-time flag and
side effect) every time this looks like the account's only completed
video, independent of both guards above. Comparing this event's count
against `first_video_created`'s own count in PostHog is what makes any
remaining undercount from guard #1's durable marker (e.g. a total network
failure reaching `mark-generation-completed`/`consume-generation-marker`,
not just a storage failure) visible after this fix ships — the whole
point of the sanity check the founder asked for. Expect a small,
persistent, non-closing gap from grandfathered accounts (pre-existing
single-video accounts revisiting `result.html`, which correctly never
fire `first_video_created` at all per the guard-#2 semantics above) —
that's expected noise from an intentional exclusion, not evidence of a
reliability bug; a real reliability gap would show up as the TOTAL gap
shrinking once this fix is live, not as this specific noise disappearing.

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
- `processing.html` — sets the "just generated" marker
- `result.html` — new local `track()` PostHog helper + the call site
- `explore.html` — new local `track()` PostHog helper +
  `fireFirstVideoCreatedIfEligible()`, called from the resume-completion
  path (`resumePendingJob().then()`)

**Files touched by the 2026-07-27 durable-carrier fix
(`result-htmls-firstvideocreated-still-dep-qfg48t`), as landed after a
review round caught the dreamId-keying gap described above:**

- `netlify/functions/lib/generation-completion-store.js` — new, the
  operationName-keyed Blobs store backing the durable "just completed"
  marker
- `netlify/functions/mark-generation-completed.js` — new, POST endpoint
  `processing.html` calls to set the marker; independently re-verifies
  the claimed `operationName` actually completed (`verifyOperationCompleted`)
  before writing anything
- `netlify/functions/consume-generation-marker.js` — new, POST endpoint
  `result.html` calls to read + consume the marker
- `js/store.js` — `finalizeDream` gained a new `operationName` param,
  stamped onto the completed dream as `sourceOperationName`;
  `startGeneration` threads its own captured `operationName` through to
  it; new `markGenerationJustCompleted(operationName)`,
  `wasOperationJustCompleted(operationName)`, `isOnlyCompletedDream(dreamId)`
- `processing.html` — replaced the `sessionStorage.setItem(
  'dreamtube_just_generated_id', ...)` call with
  `DreamStore.markGenerationJustCompleted(dream.sourceOperationName)`
- `result.html` — replaced the synchronous sessionStorage read/consume
  with `DreamStore.wasOperationJustCompleted(dream.sourceOperationName)
  .then(...)`, and added the new `first_video_result_view` PostHog
  sanity-check event
- `test/generation-completion-marker.test.js` — new, unit coverage for
  the store + both endpoints, including `SECURITY:`-prefixed tests
  proving an unverified/forged `operationName` (or a `dreamId`-only
  payload, the old vulnerable shape) can never become consumable

### Retention email send — "your dream is ready" (first-dream retention email)

Not a Meta/PostHog conversion event (though it DOES now fire its own PostHog
event on an actual send, see below) — a real EMAIL send point, included here
because it's triggered from the exact same choke point as `FirstVideoCreated`
above and shares the same fire-once-per-account discipline, so it belongs in
this index for anyone auditing that choke point (tracker.html's
`for-product-retention-email-send-user-th-eke9ra` item, founder-greenlit
2026-07-26 — "start now, before paywall — getting users back is valid now
too"; ACTIVATED automatically 2026-07-27 per
`for-product-activate-automatic-retention-4n74rw`, founder-approved — "start
sending... AUTOMATICALLY... do not wait for manual triggering"). Goal: day-1
-> day-2+ return.

**Two trigger paths now feed the same guarded send** (`lib/first-dream-email-
sender.js`'s `sendIfEligible`, wrapping `lib/first-dream-email-store.js`'s
atomic per-account guard) — whichever reaches it first for a given account
wins; the other is a harmless no-op:

| | |
|---|---|
| **Trigger (automatic, primary)** | `netlify/functions/mark-generation-completed.js` — the genuine, server-verified "a generation just finished" choke point for every normal signed-in generation path (no real fal webhook exists for this path — see that file's own header comment) — the instant `verifyOperationCompleted` confirms completion, independent of whether the browser ever loads `result.html` at all, this ENQUEUES the send (`lib/first-dream-email-pending-store.js`'s `markPending`) rather than sending immediately (changed 2026-08-04, tracker item `for-product-email-redesign-unsubscribe-l-16ysmp`'s founder-approved thumbnail-gating follow-up — see next row) |
| **Trigger (automatic, actual send)** | `send-pending-first-dream-emails.js` — a scheduled function (every minute) that resolves the ACTUAL send off the queue above: sends immediately once a real thumbnail has synced (`lib/dream-store.js`, correlated by `sourceOperationName`), or sends the no-thumbnail fallback once 3 minutes have elapsed since the trigger with no thumbnail — the founder's own explicit bound ("wait up to 3 MINUTES for the captured image... if not, SEND ANYWAY at the 3-minute mark") |
| **Identity (automatic path)** | Resolved via `lib/job-owners.js`'s `getJobOwnerRecord(operationName)` (bound at generation-SUBMISSION time in `generate-video.js`/`generate-image.js`) → email → `accountStore.getByEmail`. No password, no client-claimed identity at all — ownership is proven by knowing the server-issued, unguessable, independently-re-verified `operationName` |
| **Trigger (client fallback)** | Same moment `FirstVideoCreated` fires client-side — an account's first-ever completed dream **video** shows on `result.html`, or finishes via `explore.html`'s resume-completion path. Kept as a safety net for whatever the automatic path might miss (a legacy dream with no `sourceOperationName`, a lost `mark-generation-completed` request) |
| **Fires from (client fallback)** | `js/store.js`'s `sendFirstDreamEmailBestEffort(dream)` → POSTs `{ username, password, dreamId, caption, style, videoUrl, mediaType }` to `netlify/functions/send-first-dream-email.js`, which requires a real password re-check via `accountStore.verifyLogin` before resolving the account's real email (review fix — a bare client-claimed username alone would let anyone spam a real stranger's inbox) |
| **What it does** | Both paths ultimately call `lib/first-dream-email-sender.js`'s `sendIfEligible`, which — gated on the shared guard below — emails a Resend "your dream is ready" message: a real captured video-frame-1 thumbnail when one's on file (`upload-dream-thumbnail.js`, tracker item `for-product-dream-ready-email-real-first-qr9fbj`), falling back to the original style-colored banner otherwise, a "View my dreams" link to **`profile.html`** (founder decision 2026-07-27 — not a per-dream watch link), and a soft nudge to make another dream. The automatic path has no caption/style available at its choke point (see `mark-generation-completed.js`'s own comment on why), so it gets generic copy; the client fallback path still personalizes with the dream's own caption/style |
| **The link** | Changed 2026-07-27 (founder decision): used to mint a `lib/dream-share-token.js` one-time-to-mint `watch.html` link for that one specific (possibly-private) dream. Now a plain, direct `https://<host>/profile.html` URL — no token needed, since profile.html is already an authenticated app page. `lib/dream-share-token.js`/`get-shared-dream.js`/`watch.html` are UNCHANGED and still independently functional/tested, just no longer linked from this email |
| **Media-type scope** | Video only — matches `markFirstVideoCreatedIfEligible`'s own existing scope. The automatic path checks this via `job-owners.js`'s recorded `mediaType` (set at submission time in `generate-video.js`/`generate-image.js`) and fails CLOSED (no auto-send) if it's missing/unrecognized, never assuming 'video' |
| **Guard** | `lib/first-dream-email-store.js`'s `markSentOnce(event, username, dreamId)` — a durable, per-account, now-**atomic** (`lib/blobs-retry.js`-backed, claimId read→mutate→write→verify) flag, checked server-side BEFORE any send. Tightened from a plain existence-check-then-write specifically because the automatic path fires unconditionally on every completion, not just a gated one-time page load — see that file's own header comment |
| **PostHog event** | `first_dream_email_sent` (`distinct_id`: the account's raw username, `properties.auto`: true/false for which path sent it) — fired server-side via `lib/posthog-capture.js` ONLY on an actual send, never on a skip, so Growth can measure return-rate lift off a real "this account was emailed" signal |
| **Never blocks** | Best-effort throughout, same discipline as `dream-webhook.js`'s `sendReadyEmail`/`request-password-reset.js` — no-ops (logged, not thrown) if `RESEND_API_KEY` isn't configured, if no real account resolves, or if Resend itself rejects the send; never turns into a failure the generation-completion flow surfaces |

**Files touched (2026-07-27 activation):**

- `netlify/functions/lib/first-dream-email-store.js` — `markSentOnce` rewritten to use `lib/blobs-retry.js` for genuine atomicity
- `netlify/functions/lib/first-dream-email-sender.js` — new, the shared guard+send core both trigger paths call
- `netlify/functions/lib/job-owners.js` — `recordJobOwner` gained an optional `mediaType` param; new `getJobOwnerRecord`
- `netlify/functions/generate-video.js` / `generate-image.js` — now record `mediaType` alongside the existing job-owner binding
- `netlify/functions/mark-generation-completed.js` — new `maybeSendAutomaticFirstDreamEmail`, called after a verified completion
- `netlify/functions/send-first-dream-email.js` — now delegates to the shared sender; link changed to `profile.html`

**Files from the original 2026-07-26 feature (unchanged in shape, `dream-share-token.js`/`get-shared-dream.js`/`watch.html` just no longer linked from this email):**

- `netlify/functions/lib/dream-share-token.js` — the private-dream view token
- `netlify/functions/get-shared-dream.js` — resolves a share token for `watch.html`
- `watch.html` — the unauthenticated dream-view landing page
- `js/store.js` — `sendFirstDreamEmailBestEffort(dream)`
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

### Out-of-tokens purchase sheet (out_of_tokens_shown / out_of_tokens_choice / store_viewed / checkout_started / checkout_cancelled / blocked_action_resumed)

Founder directive, 2026-07-26 (tracker item
`for-product-build-out-of-tokens-purchase-2y8hyw`): "the store must come
up whenever a user tries any action without enough tokens." PostHog only
for every event below — these are product/funnel signals about the
purchase flow itself, not ad-optimization conversions (the existing
`Purchase`/`purchase_completed` pair above already covers the actual
money-conversion moment for Meta; these are additive, upstream/downstream
of it). All six share `js/purchase-sheet.js` as their one fire site,
except `store_viewed`/`checkout_started`/`checkout_cancelled` on
shop.html itself (see below) — kept in this one place rather than
duplicated per call site, mirroring how `track-conversion.js`'s
`ALLOWED_EVENT_NAMES` centralizes Meta's own allowlist.

| | |
|---|---|
| **`out_of_tokens_shown`** | Fires every time the purchase sheet (`PurchaseSheet.show()`) actually renders — the "store came up" moment itself. `{ source, mediaType, cost, balance, needed, pack }` — `pack` is whichever single contextual pack `pickContextualPack` picked for the one-tap CTA at that moment (the $0.99 starter if unused, otherwise the $1.99 pack — see that function's own doc comment) |
| **`out_of_tokens_choice`** | Fires once per sheet interaction, whichever exit the user takes: `choice: 'buy_pack'` (tapped the primary CTA — precedes `checkout_started` below), `'see_all_packs'` (tapped the secondary link), `'dismiss'` (closed the sheet without acting, e.g. tap-outside), or `'claim_unblocked'` (tracker item `for-product-low-out-of-tokens-sheet-inli-uqt6or` — the sheet's own inline "Claim +N" landed a real claim that itself lifted balance to cover cost, so the sheet closed and proceeded instead of re-rendering "need 0 more"; see `js/purchase-sheet.js`'s `claimInline()`). `{ source, choice, pack }` (`pack` only on `buy_pack`) |
| **`store_viewed`** | Fires from `shop.html`'s own load, reading whatever `?source=` query param got it there (`blocked_action` from the sheet's "See all packs" link or a processing.html E112/E412 fail state routed here on a convenience-fetch failure; `balance_chip` from the create/style/result topbar chip; `null` for a direct/organic visit — never guessed). `{ source }` |
| **`checkout_started`** | Fires right before POSTing to `create-checkout-session-dodo.js`, from BOTH `js/purchase-sheet.js`'s buy button and `shop.html`'s own `purchasePack()` (unified — a checkout initiated via the sheet's own one-tap buy and one initiated by browsing to a shop.html pack card are the same funnel step). `{ source, pack }` |
| **`checkout_cancelled`** | Fires on a `?checkout=cancelled` return, from `style.html`/`result.html`/`processing.html` (via `PurchaseSheet.fireCheckoutCancelled`, only ever `source: 'blocked_action'` at those call sites — their cancelUrl always points back at themselves) and from `shop.html`'s own existing cancelled branch (`source` from that page's own `?source=`, or `null` for a direct shop visit). `{ source }` |
| **`blocked_action_resumed`** | The actual "auto-resume" moment — fires from `processing.html` once `PurchaseSheet.pollForCredit` confirms the post-checkout token credit has landed and the originally-blocked generation is about to re-run via the intact draft. Never fires on the honest-degrade path (poll timeout) — that path requires a manual "Generate" tap instead, which just calls the same generation function directly without this event (the resume wasn't automatic in that case). `{ source }` |

### Post-checkout credit confirmation (purchase_credit_confirmed / purchase_credit_unconfirmed)

Added for tracker item `for-product-webhook-p0-reframed-by-found-peytt8`
(2026-08-04). PostHog only — like the block above, these are product/
reliability signals about the purchase flow, not ad-optimization
conversions; the `Purchase`/`purchase_completed` pair above remains the one
money-conversion moment reported to Meta, and these deliberately do not
duplicate it.

They exist because the founder's real purchase exposed a gap nothing in the
data could show: `dodo-webhook.js` credited his 500 tokens **36 seconds**
after payment (correct behavior), while `shop.html`'s return page stopped
looking after 15 seconds and told him nothing either way. Neither the
latency nor the missed confirmation was visible in any event. This pair
makes the webhook's real, end-user-facing latency measurable in production
rather than discoverable only by a founder hitting it on his own phone.

| | |
|---|---|
| **`purchase_credit_confirmed`** | Fires once per purchase, from `shop.html`'s `?checkout=success` handler, at the moment a real `get-token-status` read PROVES the pack's tokens landed on the balance (never on the redirect alone). `{ pack, tokens, balance, waited_ms, attempt }` — `waited_ms` is the real wall-clock wait from landing back on the page to the credit being observed (the number that would have surfaced this bug on its own), and `attempt` is which confirmation round proved it (1 on the normal path, >1 if the buyer had to tap "Check again"). Fires at most once per page load even across retries |
| **`purchase_credit_unconfirmed`** | Fires each time a full confirmation window (`PurchaseSheet.pollForCredit`'s real 75s) elapses without the credit being observed — i.e. every time the banner falls back to its explicit retryable state. `{ pack, tokens, waited_ms, attempt, reason }` — `pack`/`tokens` are `null` on a marker-less return (private-mode storage, cross-device, or a hand-typed URL), which is also the one case where this event does not imply anything actually went wrong. `reason` is `'timeout'` (the normal case: a real pre-purchase baseline existed, the credit just never cleared it inside the window) or `'no_baseline'` (no baseline could be established at all — the marker carried no `balanceBefore` AND every `get-token-status` read in the window failed — so the page deliberately refused to guess rather than confirm off a fabricated zero baseline; see `shop.html`'s `startCreditConfirmation` doc comment) |

**Reading these together:** a healthy shop shows `purchase_credit_confirmed`
with a low `waited_ms` and almost no `purchase_credit_unconfirmed` carrying
a real `pack`. A rising `waited_ms` distribution is early warning that the
webhook path is degrading, well before it becomes "I paid and nothing
happened." A rising `reason: 'no_baseline'` share means something different
and worth separating out: `get-token-status` itself is unreachable on the
return trip, not the webhook being slow.

**Why `checkout_started`/`checkout_cancelled` also touch shop.html, not just the new sheet:** `source` describes where a checkout journey *began* (`blocked_action`, `balance_chip`, or organic), not just whether it started from `js/purchase-sheet.js`'s own buy button — a visit that starts at the sheet's "See all packs" link and completes the purchase on shop.html itself is still part of the same blocked-action funnel, and would otherwise be invisible in this pair of events.

**Draft-persistence bug this feature's build also fixed (not a new event, but load-bearing for `blocked_action_resumed` to ever be honest):** `style.html` previously only called `DreamStore.setDraft(...)` inside `proceedToGenerate()`, skipped entirely on the blocked path; `result.html` never persisted the edit sheet's caption/style (or `turnImageIntoVideo`'s own draft) before its old quota modal at all. `PurchaseSheet.show()`'s `persistDraft` callback is now the single choke point every blocked-action call site routes through, called BEFORE the sheet ever renders — see `js/purchase-sheet.js`'s own header comment for the full story, and `test/out-of-tokens-purchase-sheet-behavioral.test.js` for the regression coverage.

**Files touched:**

- `js/purchase-sheet.js` — new, the shared sheet/balance-chip/checkout-return module (all six events' actual `trackLocal`/`fire*` implementations live here except shop.html's own two call sites below)
- `style.html` / `result.html` / `processing.html` — replaced the old per-page `#modal-quota` with `PurchaseSheet.show()`; `result.html`'s and `style.html`'s blocked-action click handlers now call `persistDraft` before ever showing the sheet
- `create.html` / `style.html` / `result.html` — new topbar balance chip (`PurchaseSheet.mountBalanceChip`/`renderBalanceChip`)
- `shop.html` — `store_viewed` on load (reads `?source=`), `checkout_started` in `purchasePack()`, `checkout_cancelled` in the existing cancelled branch
- `netlify/functions/create-checkout-session-dodo.js` — new relative-path-only allowlist guard (`isSafeRedirectPath`, error code `E8`) on `successUrl`/`cancelUrl`, closing an open-redirect gap this feature's own custom successUrl usage would otherwise have widened from latent to actually exploitable — see that file's own header comment
- `css/styles.css` — new `.purchase-*`/`.token-chip-compact`/`.proc-payment-*` rules
- `test/create-checkout-session-dodo.test.js` — new `SECURITY:`-prefixed coverage for the redirect guard
- `test/purchase-sheet.test.js` — unit coverage for the pure pack-selection/arithmetic/countdown logic
- `test/out-of-tokens-purchase-sheet-behavioral.test.js` — new, real-browser coverage of the sheet appearing with correct arithmetic on all three blocked-action entry points, draft persistence before redirect, the auto-resume round trip, and the honest-degrade path

### Daily token claim (daily_claim_shown / daily_claim_completed / daily_claim_dismissed)

Founder decision, 2026-07-28 (tracker items
`for-growth-research-founder-directed-dai-kguvk3` /
`for-product-build-the-daily-token-claim--fngrwd`): the old lazy
background +20/24h drip (and its ≥200 grant ceiling) is retired in favor
of a standard "tap to claim" daily-reward pattern (games, Duolingo,
TikTok-style check-ins) — see `lib/entitlements.js`'s own doc block for
the full mechanism (a rolling 20h server-clock cooldown, a display-only
streak, no more ceiling). All three events fire from
`js/purchase-sheet.js` (both the dedicated claim sheet and the out-of-
tokens sheet's inline "Claim +N" affordance) and from `shop.html`'s own
inline claim button, mirroring how the out-of-tokens sheet's own events
above are centralized rather than duplicated per call site.

| | |
|---|---|
| **`daily_claim_shown`** | Fires whenever a claim surface actually becomes visible: the dedicated claim sheet opening (`{ source, surface: 'claim_sheet' }`, `source` one of `'balance_chip'` \| `'auto_open'` \| a page-specific auto-open source like `'home_today_card'`), or the out-of-tokens sheet's inline claim button appearing (`{ source, surface: 'out_of_tokens_sheet' }`). Never fires just because `tokenStatus.claimable` is true somewhere off-screen — only on an actual render |
| **`daily_claim_completed`** | Fires ONLY once `DreamStore.claimDailyTokens()`/`POST claim-daily-tokens.js` resolves with a genuine `claimed: true` — never optimistically, never on tap alone. `{ source, streak, balance, surface }` (`surface` one of `'claim_sheet'` \| `'out_of_tokens_sheet'` \| `'shop_balance_card'`) |
| **`daily_claim_dismissed`** | Fires when the dedicated claim sheet is closed (tap outside) without claiming. `{ source }`. Deliberately NOT fired for the out-of-tokens sheet's inline claim button (dismissing that whole sheet already fires `out_of_tokens_choice: 'dismiss'` above — a second, redundant dismiss event for the same tap would double-count) |

**Why `claimable` alone never implies a fire:** unlike the old lazy drip (which materialized tokens as a side effect of a plain read), a claim is a real user action with a real event trail — `getTokenStatus`'s `claimable` field is a pure read-only projection (see `lib/entitlements.js`'s own doc comment), so `daily_claim_shown` only fires when a claim surface is actually rendered on screen, and `daily_claim_completed` only fires on the server's own confirmed response, matching this build's explicit "never optimistic" requirement.

**Files touched:**

- `netlify/functions/lib/entitlements.js` — `claimDailyTokens` (the actual claim/streak/cooldown logic), `getTokenStatus`'s new `{balance, claimable, nextClaimAt, dailyClaimAmount, streak}` shape (replaces `{nextGrantAt, dailyGrantAmount, grantCeiling, atCeiling}`), `GRANT_CEILING`/`DAILY_GRANT_AMOUNT`/`GRANT_INTERVAL_MS`/the lazy-drip branch of `syncTokens` all removed
- `netlify/functions/claim-daily-tokens.js` — new, the claim endpoint (its own `claim-ip`/`claim-email` rate-limit bucket)
- `netlify/functions/get-token-status.js` / `js/store.js` — updated to the new response shape; `js/store.js` gains `claimDailyTokens()`
- `js/purchase-sheet.js` — `waitLineText` flips to claim-framed copy; `mountBalanceChip`/`renderBalanceChip` gain the pulsing claimable state + tap-to-claim; new `showClaimSheet`/`hideClaimSheet`/`maybeAutoOpenClaimSheet`; the out-of-tokens sheet gains the inline claim button
- `create.html` / `style.html` / `result.html` / `shop.html` / `home.html` — auto-open wiring + claim UI; `explore.html` — new topbar chip mount (previously the one page missing it). `profile.html` had this wiring too until 2026-07-30, when the founder-approved Profile night restyle (tracker item `for-product-build-founder-approved-2026--to6ew2`) deleted every claim mechanic from that page — no claim chip state, no tap-to-claim, no auto-open — leaving `home.html` as the sole ritual/claim surface. Profile now mounts `mountBalanceChip`'s `plain:true` variant, which fires no `daily_claim_*` events at all.
- `css/styles.css` — pulsing chip state, inline claim button, claim sheet + confetti
- `test/entitlements-daily-claim.test.js` / `test/claim-daily-tokens.test.js` — server-side claim/streak/cooldown/rate-limit coverage
- `test/daily-claim-behavioral.test.js` — real-browser coverage of the chip, claim sheet, auto-open-once, explore.html's new mount, and the copy sweep
- `test/token-daily-grant-copy-behavioral.test.js` / `test/out-of-tokens-purchase-sheet-behavioral.test.js` / `test/ui-behavioral.test.js` / `test/purchase-sheet.test.js` / `test/owner-topup-tokens.test.js` / `test/entitlements-tokens.test.js` / `test/token-functions.test.js` — updated off the old `{nextGrantAt, dailyGrantAmount, grantCeiling, atCeiling}` shape to the new one, including removing tests for the now-retired ≥200 ceiling entirely

### claim_page_viewed / claim_page_maybe_later_clicked

Founder ask, 2026-07-28 (tracker item `for-product-claim-dream-html-retention-e-b27l7l`): `claim-dream.html` — the unauthenticated, publicly-linked page reached from a retention/abandonment email for a pending dream that was never claimed — previously fired no analytics at all (a deliberate prior default: "not part of the tracked funnel"). This ask explicitly overrides just the product-analytics half of that default (Meta Pixel stays unloaded on this page; only PostHog was added).

| | |
|---|---|
| **`claim_page_viewed`** | Fires exactly once per page load, from whichever of the 5 terminal branches this visit lands on: `{ status: 'ready' \| 'not_ready' \| 'invalid_or_expired' \| 'missing_params' \| 'fetch_failed', hasParams: boolean }` |
| **`claim_page_maybe_later_clicked`** | Fires when the "Just watching — maybe later" escape link is clicked, purely additive to that link's existing (unchanged) behavior — `{}` |

**Files touched:** `claim-dream.html` — PostHog loading added to `<head>` (reads `POSTHOG_KEY`/`POSTHOG_HOST` from `js/analytics-config.js`, same snippet as every other page), a `track()` helper, a `viewedFired` once-guard, and two short benefit bullets next to the signup CTA (reusing `processing.html`'s `.proc-checklist`/`.proc-check-item` styling) — the "maybe later" escape itself is unchanged, both in position and in not being blocked by the bullets. `test/claim-dream-retention-motivators-behavioral.test.js` — new, real-browser coverage.

### push_prompt_shown / push_prompt_granted / push_prompt_denied / push_sent / push_clicked

Web Push instrumentation — tracker item `for-product-build-stage-0-pwa-
web-push-f-jbutt5` (Stage 0 of a staged app-store plan, founder-approved
2026-07-29). PostHog only (no Meta CAPI — this is product-engagement
instrumentation, not an ad-optimization conversion event).

| | |
|---|---|
| **`push_prompt_shown`** | Fires when `js/push-subscribe.js`'s own ask card renders on `processing.html`, right after a video/image starts generating — see that file's `maybeShowAsk` for every gate (real browser, `Notification.permission === 'default'`, never asked before in this browser). `{}` |
| **`push_prompt_granted`** / **`push_prompt_denied`** | Fires off the REAL OS-level `Notification.requestPermission()` result, the moment the visitor answers that dialog (not the card's own "Notify me" tap, which only triggers the request) — `granted` also kicks off `PushSubscribe.subscribe()` right after. `{}` |
| **`push_sent`** | Server-side, `netlify/functions/lib/push-sender.js`'s `sendToUser` — fires once per `sendToUser` call that delivers to at least one real subscription (not once per device — an account with 3 subscribed devices getting the same push fires this once, not 3 times). `distinct_id` is the account's raw username (matches `identifyForAnalytics`'s value). `{ type: 'video-ready' \| 'daily-claim-available' }` |
| **`push_clicked`** | Fires from `sw.js`'s own `notificationclick` handler via a bare `fetch()` straight to PostHog's public capture endpoint (no PostHog JS SDK inside a service worker, and often no open tab to relay through either — see that handler's own doc comment). `distinct_id` comes from the notification's own `data.distinctId`, stamped there by `push-sender.js` at send time. `{ type: 'video-ready' \| 'daily-claim-available' }` |

**Two push types wired in this build:**
- **video-ready** (`netlify/functions/mark-generation-completed.js`'s new
  `maybeSendVideoReadyPush`) — fires from the same server-verified
  "generation just completed" choke point the automatic first-dream
  retention email already uses, but is a DELIBERATELY independent second
  channel with its own per-`operationName` dedup marker
  (`netlify/functions/lib/push-dedup-store.js`) — see that file's header
  comment for exactly why it can't reuse the email's once-ever-per-account
  marker, and `maybeSendVideoReadyPush`'s own doc comment for how the two
  channels are meant to coordinate (both firing for the same completion is
  the intended outcome, not a bug).
- **daily-claim-available** (`netlify/functions/send-daily-claim-pushes.js`)
  — this repo's first Scheduled Function, hourly, scanning
  `lib/entitlements.js`'s own store for any account whose
  `lastClaimAt + CLAIM_COOLDOWN_MS` was just crossed.

**Files touched:** `js/push-config.js` (VAPID public key), `js/push-subscribe.js`
(ask flow), `js/install-nudge.js`/`js/pwa.js` (unrelated PWA-installability
work from the same tracker item, see `docs/PWA_PUSH_SETUP.md`),
`netlify/functions/save-push-subscription.js`,
`netlify/functions/lib/push-subscription-store.js`,
`netlify/functions/lib/push-sender.js`,
`netlify/functions/lib/push-dedup-store.js`,
`netlify/functions/send-daily-claim-pushes.js`, `sw.js`,
`netlify/functions/mark-generation-completed.js` (new
`maybeSendVideoReadyPush`), `netlify.toml` (schedule declaration). See
`docs/PWA_PUSH_SETUP.md` for the human setup step (`VAPID_PRIVATE_KEY`)
this feature needs before any push actually delivers.

### result_hero_interpret

The success metric for the interpret-primary result-screen redesign
(founder-decided 2026-07-30, tracker item
`for-product-build-founder-decided-2026-0-75fnlk`). That decision made the
interpretation entry the ONE hero on `result.html` — displacing publish,
which dropped to a quiet link — on the reasoning that new users need
confidence before they broadcast, and interpretation is the product's
depth direction. This event is how that bet gets read: **interpretation-open
rate from result**, with downstream Chamber completion coming from the
existing `interp_*` events `js/interpret-experience.js` already fires.

PostHog only — this is product instrumentation, not an ad-optimization
conversion event, so no Meta Pixel/CAPI leg.

| | |
|---|---|
| **Fires** | On tap of `result.html`'s hero pill (`#interp-cta-btn`, "✨ What does this dream mean?"), immediately before `InterpretExperience.open(dream.id)`. Every tap, no once-per-session/once-per-dream guard — the metric is a rate, so repeat taps are real signal, not noise |
| **Props** | `{ first_video: boolean }` — true when this dream is the account's only completed video, i.e. the user is tapping this on their very first dream (the confidence moment the founder's decision is actually about), false on a returning user's Nth dream. Computed from `DreamStore.isOnlyCompletedDream(dream.id)`, the same read-only query `first_video_result_view` above already uses — deliberately not a second definition of "first" |
| **Does NOT fire for** | home.html's Chamber card, which opens the same Interpreter's Chamber from the other entry point. That path is intentionally uninstrumented by this event — the whole point is measuring the RESULT-screen entry specifically. Compare against the `interp_*` events (fired inside the Chamber regardless of entry point) to see the split |

**Files touched:** `result.html` (hero markup/styling now lives entirely in
this page's own `<style>` block — `.heropill`/`.result-hero-micro` — as
part of the 2026-07-31 ritual-card rebuild; the click handler and
`first_video` computation are unchanged), `test/ui-behavioral.test.js`
(real-browser coverage of the event firing with the correct `first_video`
value in both states).

### edit_started / edit_submitted / model_used

New edit mechanism (docs/EDIT_MECHANISM_SPEC.md, tracker item
`for-product-new-edit-mechanism-founder-i-qmsdgj`, founder-approved
Direction B "Confirm-before-generate," with PixVerse V6 model-rotation
cost-approved and live from day one). `result.html`'s new default edit
sheet ("What would you like to change?") replaces `#open-edit-sheet`'s old
behavior of opening the full mini-wizard sheet — that full sheet is NOT
deleted, it moves behind this new sheet's "Start over instead" link.

PostHog only for all three — none are ad-optimization conversions.

| | |
|---|---|
| **`edit_started`** | Fires the moment the new edit sheet opens (`result.html`'s `openEditDeltaSheet`) — not on submit. `{}` |
| **`edit_submitted`** | Fires when the user taps "Apply this change," before the realignment call. `{ deltaLength: <int>, dreamId }` — the delta text's character length only, **never the raw delta text itself** (this file's own established rule for anything touching a dream's free-text content) |
| **`model_used`** | Fires alongside the existing `video_created` event, from `js/store.js`'s `finalizeDream` — video-only (the model-rotation mechanism never applies to `mediaType:'image'`). `{ modelUsed: "veo3.1-lite" \| "pixverse-v6" \| null, wasEdit: boolean }`. `wasEdit` is true for ANY regenerate of an existing dream (`sourceDreamId` truthy) — including the old full mini-wizard's "Generate Again," which never rotates and so always reports `modelUsed:"veo3.1-lite"` — not just the new edit-delta mechanism, so the satisfaction-proxy read this powers (`video_published` rate cut by `modelUsed`/`wasEdit`) can compare a rotated edit against a non-rotated one on equal footing. `modelUsed` is `null` for the self-photo reference-to-video and "turn this into a video" image-to-video paths, both explicitly out of rotation scope this wave |

**Realignment fallback telemetry — `edit_realign_fallback`:** fires from
`js/store.js`'s `realignDreamPrompt` only when `netlify/functions/
realign-dream-prompt.js` fails (any E7xx error, a network failure, or a
malformed response) and the naive-concatenation fallback merge is used
instead — the spec's edge-case table's "log a silent-skip telemetry event"
requirement for this failure path. `{ reason: <short string, truncated,
never the raw delta or dream text> }`. No token is charged when this
fallback path is used — the realign call happens entirely before the
confirm screen, upstream of any spend.

**Model rotation itself (not a new event, but what these events measure):**
`netlify/functions/generate-video.js` accepts an optional `requestedModel`
("veo3.1-lite" | "pixverse-v6") on the plain text-to-video path only (self-
photo reference-to-video and "turn this into a video" image-to-video are
explicitly out of scope for rotation) and returns the model actually used
as `modelUsed` on its response. `js/store.js`'s `pickEditModel(dream)` is
the rotation rule: Anime-style dreams always route to `pixverse-v6`
regardless of history (an explicitly-flagged untested hypothesis, watched
via `model_used` cut by style — not a verified fact); otherwise the model
alternates from whatever the dream's current `modelUsed` is (or from the
implicit historical default, `veo3.1-lite`, if unset), so a dream edited
twice ping-pongs and never repeats the model it just tried.

**Files touched:** `result.html` (new `#sheet-edit-delta-overlay` default
edit sheet, reusing `create.html`'s exact recording/transcription chain
under its own `delta-*` ids; `#sheet-edit-overlay`, the old full mini-
wizard, is unchanged and reachable via "Start over instead"),
`processing.html` (`runGeneration` routes an `isEditDelta` draft to the
new `DreamStore.startDreamEdit` instead of `regenerateDream`),
`netlify/functions/realign-dream-prompt.js` (new), `netlify/functions/
generate-video.js` (`FAL_MODEL_PIXVERSE_V6`/`callFalPixverse`, the
`requestedModel`/`modelUsed` request/response fields, new E115 error
code), `js/store.js` (`pickEditModel`, `realignDreamPrompt`,
`startDreamEdit`, `modelUsed`/`editHistory` fields on the dream record,
`isEditDelta`/`editDeltaLength` draft fields), `test/realign-dream-
prompt.test.js`, `test/generate-video-model-rotation.test.js` (new).

### interp_voice_*

Speaking Sage — Option D (`docs/SPEAKING_SAGE_SPEC.md`, tracker item
`for-product-build-speaking-sage-wave-fou-8uobuh`, founder GO on "Option D"
2026-08-02/08-03). Voice/captions wave for the Interpreter's Chamber: a
one-time lip-synced intro per persona, then a per-reading Kokoro (`am_onyx`,
speed `0.8`) voice track played over the user's OWN dream video (bounce-
looped) with timed captions overlaid — no per-reading lip-sync (ruled out
as too expensive, ~$0.30/reading, per this item's own tracker history).
Ships FREE (negligible marginal cost per the founder's own "negligible =
free" rule) behind a founder-preview gate (`?sagevoice=1`, sticky per
browser) — see `js/interpret-experience.js`'s own header comment. All
PostHog-only, neutral naming matching the existing `interp_*` convention
exactly (no Meta Pixel/CAPI, same standing rule as every other
interpretation event).

| Event | Fires | Props |
|---|---|---|
| `interp_voice_intro_shown` | The persona's one-time intro clip actually starts playing — autoplay succeeded, or a blocked-autoplay tap just unlocked it | `{ persona }` |
| `interp_voice_intro_completed` | Intro clip finishes playing naturally, end to end | `{ persona }` |
| `interp_voice_intro_skipped` | User taps the intro's "Skip" link, or closes the Chamber while the intro is still playing | `{ persona, via: 'skip_link' \| 'closed' }` |
| `interp_voice_autoplay_blocked` | Capability-detection (a real `.play()` Promise rejection, never user-agent sniffing) determines audio-on playback was blocked for either the intro or the reading, and the tap-to-play overlay is shown | `{ persona, surface: 'intro' \| 'reading' }` |
| `interp_voice_play` | The reading's TTS audio actually begins playing | `{ persona, source: 'auto' \| 'tap_unlock' }` |
| `interp_voice_paused` | User manually pauses reading playback before it completes | `{ persona, position_ms }` |
| `interp_voice_complete` | Reading TTS finishes playing to the end, uninterrupted | `{ persona, duration_ms }` |
| `interp_voice_replay` | User re-plays a reading's audio after it already completed once | `{ persona }` |
| `interp_voice_listen_time` | Once, on Chamber close, IF a voice stage was ever mounted this session (same choke point as `interp_closed`) — total audio dwell | `{ persona, listened_ms, audio_duration_ms, completed: bool }` |
| `interp_voice_tts_failed` | `generate-interp-audio.js`/`interp-audio-status.js` returns a hard failure — the whole voice stage is hidden, reading falls back to Wave 1's plain text-only card | `{ persona, error_code }` |
| `interp_voice_caption_fallback` | `captionsLevel` resolves to `'sentence'` instead of `'word'` — the Whisper word-alignment pass (see `interp-audio-status.js`'s own header comment on why this reuses that pattern instead of the tracker-referenced ffmpeg `silencedetect` method) failed or returned nothing usable, and the client-side sentence-proportional fallback engaged | `{ persona }` |
| `interp_voice_saved_audio_expired` | A REVISITED reading's persisted `audioUrl` (fal-hosted, no guaranteed lifetime) fires a real `<audio>` `error` — dead/expired/unreachable — and the stage silently regenerates it via `generate-interp-audio` instead of dying to text. Fires at most once per reading-open (`vs.regenerateAttempted`); if the regenerated track errors too, `interp_voice_tts_failed{error_code:'regenerated_audio_error'}` follows instead. A rising rate here is the signal that fal's audio retention has shortened | `{ persona }` |

**Asset status:** `talmudic`'s (The Sage's) intro is the real, founder-
approved Option D handoff, landed on `main` (commit `c0b9202`) as TWO
separate files — a silent looping visual (`sage-intro-reference.mp4`) and
its paired spoken-greeting voice track (`sage-intro-voice.wav`) — see
`js/interpreter-personas.js`'s own header comment for the full "why two
files" story. No placeholder remains.

**Files touched:** `js/interpreter-personas.js` (`voiceId`/`introClipUrl`/
`introVoiceUrl` per persona), `js/interpret-experience.js` (voice stage
mount/teardown, intro/reading phase state machine, caption rendering,
capability-detected tap-to-play, every event above), `css/styles.css`
(`.itp-voice-*`), `netlify/functions/generate-interp-audio.js` (new),
`netlify/functions/interp-audio-status.js` (new), `js/store.js`
(`generateInterpAudio`, `hasIntroShown`/`markIntroShown`,
`getInterpretations`'s extended shape), `assets/interpreters/intro/
sage-intro-reference.mp4`/`sage-intro-voice.wav` (real assets, commit
`c0b9202`), `test/generate-interp-audio.test.js`, `test/interp-audio-
status.test.js`, `test/interp-voice-captions.test.js`, `test/interp-voice-
behavioral.test.js` (all new).
