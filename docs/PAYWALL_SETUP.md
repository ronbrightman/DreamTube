# Paywall setup

> **Superseded for the generation gate itself (token-economy branch).**
> `generate-video.js` no longer reads `PAYWALL_ENABLED`, the in-product
> override below, or `isEntitled`/`E108`/`E111` at all — it's gated
> unconditionally by a token balance instead (`E112`, see
> `netlify/functions/lib/entitlements.js`'s doc block). The rest of this
> document (Stripe Checkout backend, `stripe-webhook.js`, the
> `active`/`plan`/`stripeCustomerId` entitlement fields, `admin.html`'s
> on/off toggle) is unaffected code-wise and stays in place, fully dormant
> — nothing calls `create-checkout-session.js`/`stripe-webhook.js` from
> anywhere in the product today — but as of this branch none of it is
> consulted by the generation gate anymore, so `admin.html`'s paywall
> switch currently has no effect on whether generation is allowed.
>
> **Dodo Payments (below the Stripe section) is different: it is LIVE**,
> wired to `shop.html`'s ("The Vault") 4-pack ($0.99/$1.99/$4.99/$9.99)
> one-time token-pack purchases (founder-approved 2026-08-02, tracker item
> for-product-build-ship-today-founder-app-zn9zyy — this replaced the
> earlier 3-pack $2.99/$7.99/$14.99 lineup, "Token Economy C", which had
> itself replaced an original 2-pack $1.99/$8.95 lineup). See "Dodo
> Payments — one-time token-pack purchases" further down for what that
> involves and what a human still needs to set up before it can actually
> process a payment.

This document covers the Stripe subscription paywall backend added in this
branch: what it is, every new environment variable it introduces, and
exactly what a human still has to do before any of it can go live. Read
`AGENT_POLICY.md` for why this is written this way — creating accounts and
choosing vendors are both human-approval items this work deliberately did
not do.

## What this branch does and does not do

**Does:**
- `netlify/functions/create-checkout-session.js` — creates a Stripe
  Checkout Session for a subscription (`monthly` or `yearly`) and returns
  its URL for the client to redirect to.
- `netlify/functions/stripe-webhook.js` — verifies Stripe's webhook
  signature and writes/updates an entitlement record (keyed by normalized
  email) on `checkout.session.completed`, `customer.subscription.updated`,
  and `customer.subscription.deleted`.
- `netlify/functions/lib/entitlements.js` — shared helper other functions
  use to check/write that entitlement record.
- A gate in `netlify/functions/generate-video.js` that, **only when the
  paywall's effective state is on** (see "Two ways to turn the paywall
  on/off" below), requires the request's email to have an active
  entitlement (error `E108`) — unless the request is the owner (see
  "Owner bypass" below).
- Two safety nets on `generate-video.js` that are **active unconditionally,
  regardless of paywall state, including for the owner**: a per-IP/per-email
  daily generation cap (`E109`) and a global daily-spend circuit breaker
  (`E110`).
- `netlify/functions/lib/paywall-settings.js` — Blobs-backed on/off
  override for the paywall, so it can be flipped from inside the product.
- `netlify/functions/admin-paywall-toggle.js` — the function `admin.html`
  calls to read/write that override.
- `admin.html` — a minimal, owner-only page with a single switch for the
  paywall's on/off state.

**Does not do** (explicitly out of scope for this branch):
- Create a Stripe account, product, price, or webhook endpoint. All of the
  above is driven entirely by environment variables that **do not exist
  yet** in any environment — this code cannot run end-to-end until a human
  creates them (see "What a human still needs to do" below).
- Build the pricing/checkout page UI. The visible funnel pages don't exist
  yet (still in mockup/design review, per the design agent's normal
  process) — this is backend plumbing only.

## The critical safety flag: `PAYWALL_ENABLED`

**DreamTube is a live product with real existing users, and until this
branch, `generate-video.js` had zero gating of any kind.** If the
entitlement check were unconditional, merging this branch would instantly
block video generation for every current user, with no checkout UI yet
built for them to pay through.

`PAYWALL_ENABLED` solves this:
- **Unset, or any value other than the exact string `"true"`** (this
  includes not setting it at all, which is the default in every
  environment today): the entitlement gate is skipped entirely.
  Generation works exactly as it did before this branch — ungated. This is
  safe to merge and deploy immediately.
- **Set to exactly `"true"`**: `generate-video.js` requires the request to
  carry an email with an active entitlement, returning `E108:
  payment_required` otherwise.

**Do not set `PAYWALL_ENABLED=true` in any environment until:**
1. A real Stripe account exists with real subscription products/prices.
2. `stripe-webhook.js`'s endpoint is registered in the Stripe Dashboard and
   actually receiving events (so entitlements actually get created).
3. A real checkout/pricing page exists in front of users, so a user who
   hits the paywall has somewhere to go pay — this branch does not build
   that page.

The two safety nets below (`E109` rate limiting, `E110` spend cap) are
**not** behind this flag — they're active as soon as this branch deploys,
regardless of the paywall's state (env var, override, or owner bypass —
see below), since the endpoint has always had zero abuse protection and
that's worth fixing independent of the paywall timeline.

## Two ways to turn the paywall on/off

There are now two mechanisms, checked in this order by
`generate-video.js`'s gate (via `lib/paywall-settings.js`'s
`isPaywallEnabled`):

1. **The in-product toggle** — `admin.html`, a single switch that calls
   `admin-paywall-toggle.js`, which writes a plain boolean into a
   `dreamtube-settings` Blobs store. If this has ever been set in a given
   environment, **it wins outright**, regardless of what `PAYWALL_ENABLED`
   is set to. This is what lets the founder flip the paywall on/off
   without touching Netlify's dashboard or redeploying.
2. **The `PAYWALL_ENABLED` env var**, exactly as described above — only
   consulted as a fallback, when the in-product toggle has never been
   touched in that environment.

`admin.html` only renders its controls if the currently logged-in
account's email matches `OWNER_EMAIL` — checked both client-side (for UX,
so the page doesn't show controls to a random logged-in user) and, more
importantly, server-side in `admin-paywall-toggle.js`'s `POST` handler,
which is the actual enforcement: any `POST` whose `email` doesn't
normalize-match `OWNER_EMAIL` gets a `403`, full stop, regardless of what
the client rendered. This mirrors the same client-supplied-identity
pattern already used everywhere else in this app (see `js/store.js`'s
whole account model) rather than introducing a heavier auth system just
for this one page.

## Owner bypass

Independent of whether the paywall is on (via either mechanism above), a
`generate-video` request whose (normalized) email matches `OWNER_EMAIL`
**always** skips the entitlement check — so the founder can keep testing
the live product freely without needing their own active Stripe
subscription. `E109`'s rate limit and `E110`'s spend cap still apply to
the owner exactly like everyone else — those are cost/abuse protection,
not payment gating, and are deliberately left untouched by this bypass.

## Environment variables introduced by this branch

| Variable | Required for | Default if unset | What it does |
|---|---|---|---|
| `STRIPE_SECRET_KEY` | `create-checkout-session.js`, `stripe-webhook.js` | none — function returns a clear error | Stripe's secret API key. Used to create Checkout Sessions and to construct/verify webhook events. |
| `STRIPE_WEBHOOK_SECRET` | `stripe-webhook.js` | none — function returns a clear error | The signing secret Stripe gives you when you register the webhook endpoint in the Dashboard. Used to verify that an incoming webhook payload genuinely came from Stripe (never trust an unverified payload). |
| `STRIPE_PRICE_MONTHLY` | `create-checkout-session.js` | none — function returns a clear error if a `monthly` checkout is requested | The Stripe Price ID (`price_...`) for the monthly plan. No amount or price ID is hardcoded anywhere in this code. |
| `STRIPE_PRICE_YEARLY` | `create-checkout-session.js` | none — function returns a clear error if a `yearly` checkout is requested | Same, for the yearly plan. |
| `PAYWALL_ENABLED` | `generate-video.js` | **unset (off)** — this default must never change without a human decision, see above | Set to the exact string `"true"` to turn on the entitlement gate. Any other value (or unset) leaves generation ungated, as it is today. Only consulted as a fallback — the in-product toggle (`admin.html`), once ever used in a given environment, overrides this. |
| `OWNER_EMAIL` | `admin-paywall-toggle.js`, `generate-video.js` | none — `admin.html`'s toggle is unusable (`403` on every write) and the owner bypass never matches anyone | The founder's own email (normalized the same way every other email in this codebase is — trimmed, lowercased). Two effects: (1) only a request whose email matches this can write the in-product paywall toggle; (2) a `generate-video` request whose email matches this always skips the entitlement check, regardless of paywall state. Not client-writable — a request only *claims* an email, same tradeoff already accepted everywhere else in this app. |
| `MAX_GENERATIONS_PER_IP_PER_DAY` | `generate-video.js` | `20` | Per-IP (and, once an email is present on the request, also per-email) daily cap on generation requests, backed by a Blobs counter. Generous by design — it exists to stop obvious scripted hammering, not to constrain real users. Raise or lower via this var without a code change. |
| `DAILY_SPEND_CAP_USD` | `generate-video.js` | `50` | Global daily estimated-spend circuit breaker. Once today's estimated cumulative fal.ai spend (using the conservative ~$1.20/generation upper-bound estimate documented in `lib/spend-guard.js`, covering the worst case across all three generation paths — see that file's header comment) reaches this cap, new generations are rejected with `E110` until the next UTC day. This is a backstop against a failure mode in the rate limiter above (e.g. a compromised or shared paying account), not a replacement for it. |

None of these have a hardcoded fallback price, amount, or key anywhere in
the code — every one of them must be set explicitly in the Netlify site's
environment variables (Site settings → Environment variables, or the
Netlify CLI) before the corresponding function can do anything.

## What a human still needs to do (not something this branch does)

Per `AGENT_POLICY.md`, creating any account or signing up for any service
is a human-approval action an agent should not take autonomously. Concretely,
before any of this can be turned on:

1. **Create a Stripe account** (or use an existing one) for DreamTube.
   Vendor choice was already made and researched (Stripe, not Paddle/
   RevenueCat/Stripe Managed Payments — see the research docs this task
   was scoped from) — this step is just the actual account creation,
   which nobody but the founder can do.
2. **Create the subscription product and its two prices** (monthly,
   yearly) in the Stripe Dashboard, and copy their Price IDs into
   `STRIPE_PRICE_MONTHLY` / `STRIPE_PRICE_YEARLY`.
3. **Copy the Stripe secret key** into `STRIPE_SECRET_KEY`.
4. **Register the webhook endpoint** in the Stripe Dashboard, pointing at
   `https://<your-site>/.netlify/functions/stripe-webhook`, subscribed to
   at minimum `checkout.session.completed`, `customer.subscription.updated`,
   and `customer.subscription.deleted`. Copy the signing secret Stripe
   generates for that endpoint into `STRIPE_WEBHOOK_SECRET`.
5. **Build the actual pricing/checkout page UI** (separate, later work —
   not part of this branch) that calls `create-checkout-session.js` and
   redirects the browser to the returned Checkout URL.
6. Only after 1-5 are done and verified working: **set
   `PAYWALL_ENABLED=true`**, or (once this branch is live) flip the
   toggle on `admin.html`.
7. **Set `OWNER_EMAIL`** to the founder's own email so `admin.html`'s
   toggle is usable and the owner bypass in `generate-video.js` applies to
   them. This is a plain env var, not a new account/service, so it's not
   gated the same way as 1-4 above — but it should still be set
   deliberately (whoever's email goes here can always generate for free
   and is the only one who can flip the paywall from the product).

## How to test this once the above exists (nothing here can be tested without it)

This branch was written correct-by-inspection against Stripe's current
Node.js Checkout Session and webhook-verification APIs — it could not be
exercised end-to-end in this environment since no Stripe credentials
exist here. Once a human has done the setup above:

- **Checkout session creation**: `POST` `{ email, plan: "monthly" }` (or
  `"yearly"`) to `/.netlify/functions/create-checkout-session` and confirm
  it returns a `url` that opens a real Stripe Checkout page for the
  correct price.
- **Webhook flow**: use the Stripe CLI (`stripe listen --forward-to
  localhost:8888/.netlify/functions/stripe-webhook` against `netlify dev`,
  or Stripe's Dashboard "send test webhook" against a deployed URL) to fire
  a test `checkout.session.completed` event and confirm a record appears
  in the `dreamtube-entitlements` Blobs store for that email with
  `active: true`.
- **Subscription sync**: cancel a test subscription in the Dashboard and
  confirm `customer.subscription.deleted` flips that email's record to
  `active: false`.
- **The gate itself**: with `PAYWALL_ENABLED=true` set (in a test/branch
  deploy, never production, until everything above is verified), confirm
  a `generate-video` request with a non-entitled (or missing) email gets
  `E108: payment_required`, and one with an entitled email proceeds
  normally.
- **Rate limit / spend cap**: these need no Stripe setup to test — they're
  live as soon as this branch deploys. Hammering `generate-video` from one
  IP more than `MAX_GENERATIONS_PER_IP_PER_DAY` times in a day should
  return `E109`; there's no easy way to test `E110` without actually
  spending close to `DAILY_SPEND_CAP_USD`, so that one is best verified by
  code review plus watching the `dreamtube-spend-guard` Blobs store's
  daily counter in production.
- **The in-product toggle**: also needs no Stripe setup. With `OWNER_EMAIL`
  set, log into `admin.html` as that account and confirm the switch shows
  the current effective state and flips it; confirm `GET
  /.netlify/functions/admin-paywall-toggle` reflects the change
  immediately. Confirm a `POST` with a non-owner `email` gets `403`
  (`E5: forbidden`), and that `admin.html` itself shows "not available"
  rather than the switch when logged in as a non-owner account.
- **The owner bypass**: with the paywall on (either mechanism) and
  `OWNER_EMAIL` set, confirm a `generate-video` request whose `email`
  matches `OWNER_EMAIL` succeeds with no entitlement record at all, while
  still being subject to `E109`/`E110` if those limits are hit.

## Dodo Payments — one-time token-pack purchases (LIVE)

Separate from everything above: Dodo Payments is DreamTube's real,
chosen-and-approved payment processor for `shop.html`'s ("The Vault")
four token packs — $0.99/300 tokens (one-time starter), $1.99/500,
$4.99/1500 ("Most popular"), $9.99/4000 ("Best value") — founder-approved
2026-08-02, tracker item for-product-build-ship-today-founder-app-zn9zyy.
This REPLACES the previous pack100/pack300/pack700 lineup (200/600/1400
tokens, same shape but different prices/ids) and its one-time +50%
first-purchase bonus entirely — see `create-checkout-session-dodo.js`'s
own header comment for the full no-grandfathering reasoning (fresh pack
ids/env vars, never reusing the old ones, so a historical webhook record
for the old lineup is never silently reinterpreted). A genuine one-time
purchase, not a subscription. The vendor decision itself (Dodo over
Paddle/2Checkout/BlueSnap/Xsolla) was already made and approved by the
founder — see the tracker — this section is the engineering setup that
follows from it, per `AGENT_POLICY.md`'s "creating any account or signing
up for any service is a human-approval action" rule (an agent building
this code did not, and could not, create the Dodo account itself).

**What this is:**
- `netlify/functions/create-checkout-session-dodo.js` — creates a Dodo
  Checkout Session for a token pack (`pack099`, `pack199`, `pack499`, or
  `pack999`) and returns its URL; `shop.html`'s buttons call this directly
  and redirect the browser there. Also refuses (`E9`) a `pack099` request
  from an account that has already completed a pack purchase before — see
  that file's own header comment for the one-time-starter enforcement.
- `netlify/functions/dodo-webhook.js` — verifies Dodo's webhook signature
  (Standard Webhooks spec) and, on a confirmed `payment.succeeded` event,
  credits the buyer's token balance via `lib/entitlements.js`'s
  `creditTokenPackOnce` (idempotent by Dodo `payment_id`, so a redelivered
  webhook event can't double-credit — see that function's own doc
  comment). No bonus multiplier of any kind — the credited amount is
  always the plain pack token count.
- This is intentionally NOT the same shape as the Stripe subscription
  backend above: no `active`/`plan` entitlement fields are touched at all.
  A token-pack purchase is a straight, one-time balance credit, exactly
  like `owner-topup-tokens.js`'s manual top-up, just triggered by a real
  payment instead of the owner's own request.
- Does not touch the generation gate (`E112`) at all — tokens purchased
  this way just add to the same balance the signup grant and the daily
  CLAIM (`claim-daily-tokens.js`, see that file/`lib/entitlements.js` —
  2026-07-28 replaced the old automatic daily drip with an active,
  user-tapped claim) already fill; `generate-video.js` doesn't know or
  care where a token came from.

**Environment variables this introduces:**

| Variable | Required for | What it does |
|---|---|---|
| `DODO_API_KEY` | `create-checkout-session-dodo.js`, `dodo-webhook.js` | Dodo's bearer API key. Used to create Checkout Sessions; also passed to the SDK client `dodo-webhook.js` constructs (not actually used for signature verification itself, but the SDK constructor requires *some* value). |
| `DODO_WEBHOOK_SECRET` | `dodo-webhook.js` | The signing key Dodo gives you when you register the webhook endpoint. Used to verify an incoming payload genuinely came from Dodo (Standard Webhooks signature, never trust an unverified payload). |
| `DODO_PRODUCT_PACK_099` | `create-checkout-session-dodo.js`, `dodo-webhook.js` | The Dodo product id (`pdt_...`) for the 300-token/$0.99 one-time-purchase starter product. No amount or id is hardcoded anywhere in this code. |
| `DODO_PRODUCT_PACK_199` | `create-checkout-session-dodo.js`, `dodo-webhook.js` | Same, for the 500-token/$1.99 pack. |
| `DODO_PRODUCT_PACK_499` | `create-checkout-session-dodo.js`, `dodo-webhook.js` | Same, for the 1500-token/$4.99 pack ("Most popular" on `shop.html`). |
| `DODO_PRODUCT_PACK_999` | `create-checkout-session-dodo.js`, `dodo-webhook.js` | Same, for the 4000-token/$9.99 pack ("Best value" on `shop.html`). |
| `DODO_ENVIRONMENT` | both | `live_mode` (default) or `test_mode` — passed straight to the Dodo SDK client. Leave unset once real payments should actually go through. |

**Old env vars, now unused (safe to leave set or remove):**
`DODO_PRODUCT_PACK_100`/`_300`/`_700` are no longer read by either
function — the old pack100/pack300/pack700 products they pointed at can
stay configured in Dodo's dashboard (harmless, just orphaned) or be
retired there; nothing in this codebase references those env var names
anymore.

Each pack degrades independently and gracefully if its own env var isn't
set yet: `create-checkout-session-dodo.js` returns `E6 missing_product_id`
for that specific pack only — the other packs keep working normally. So
the four Dodo products don't all need to exist at once; add them as you
go and each pack lights up as soon as its own env var is set. **As of this
writing the four new Dodo dashboard products do not exist yet** — the
founder is creating them separately, and will supply the real product id
values as a follow-up; every env var above resolves to `undefined` (and
that pack refuses to sell, via the existing `E6` guard) until then.

**What a human still needs to do before this can process a real payment:**

1. **Create the four one-time-purchase products** in the Dodo dashboard —
   300 tokens at $0.99, 500 tokens at $1.99, 1500 tokens at $4.99, 4000
   tokens at $9.99 (or whatever amount/price is currently live on
   `shop.html` — keep them matched by hand, nothing enforces it). Copy
   their product ids into `DODO_PRODUCT_PACK_099` / `DODO_PRODUCT_PACK_199`
   / `DODO_PRODUCT_PACK_499` / `DODO_PRODUCT_PACK_999`.
2. **Copy the Dodo API key** into `DODO_API_KEY`.
3. **Register the webhook endpoint** in the Dodo dashboard, pointing at
   `https://<your-site>/.netlify/functions/dodo-webhook`, subscribed to at
   least `payment.succeeded`. Copy the signing key into
   `DODO_WEBHOOK_SECRET`.
4. Confirm `DODO_ENVIRONMENT` matches whichever mode those product ids and
   that API key actually belong to (`live_mode` for real money).

**How to test once the above exists** (nothing here can be exercised
end-to-end without real Dodo credentials/products — it was written
correct-by-inspection against Dodo's current Node SDK and public API
docs, and against `test/create-checkout-session-dodo.test.js` /
`test/dodo-webhook.test.js`, which mock the API boundary the same way
this codebase already mocks fal.ai/Twilio/Resend elsewhere):

- **Checkout session creation**: on `shop.html`, click any pack button
  while logged in with an account that has an email on file; confirm it
  redirects to a real Dodo Checkout page for the right product/amount.
- **Webhook flow**: use Dodo's dashboard "send test webhook" (or trigger a
  real test-mode payment) and confirm the buyer's email shows the correct
  new balance via `get-token-status.js` shortly after — Blobs is only
  eventually consistent (up to ~60s), which is exactly why `shop.html`'s
  own `?checkout=success` return handler polls the balance a few times
  rather than assuming it's already updated.
- **Idempotency**: resend the same test webhook event a second time (same
  `payment_id`) and confirm the balance does NOT increase again.
- **Starter one-time enforcement**: confirm a brand-new account can start
  a `pack099` checkout, and that a SECOND attempt from that same account
  (after any pack purchase has completed) is refused with `E9` before ever
  reaching Dodo — no charge, no checkout URL.
- **A real end-to-end $0.99/$1.99/$4.99/$9.99 charge** is the only way to
  fully confirm the amount actually charged matches what the product's
  Dodo configuration says — nothing in this codebase enforces or checks
  that from the DreamTube side.

**Known limitation, deliberately out of scope for this pass:** a refund
does not claw back already-granted tokens — `dodo-webhook.js` ignores
`refund.*` events entirely (same as the original branch this was adapted
from). If this becomes a real problem, handle `refund.succeeded` by
deducting via `lib/entitlements.js`'s `spendTokens` (already floors at 0,
so it can never go negative even if the tokens were already spent).
