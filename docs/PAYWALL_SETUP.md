# Paywall setup

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
- A gate in `netlify/functions/generate-video.js` that, **only when
  `PAYWALL_ENABLED === "true"`**, requires the request's email to have an
  active entitlement (error `E108`).
- Two safety nets on `generate-video.js` that are **active unconditionally,
  regardless of `PAYWALL_ENABLED`**: a per-IP/per-email daily generation
  cap (`E109`) and a global daily-spend circuit breaker (`E110`).

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
regardless of `PAYWALL_ENABLED`, since the endpoint has always had zero
abuse protection and that's worth fixing independent of the paywall
timeline.

## Environment variables introduced by this branch

| Variable | Required for | Default if unset | What it does |
|---|---|---|---|
| `STRIPE_SECRET_KEY` | `create-checkout-session.js`, `stripe-webhook.js` | none — function returns a clear error | Stripe's secret API key. Used to create Checkout Sessions and to construct/verify webhook events. |
| `STRIPE_WEBHOOK_SECRET` | `stripe-webhook.js` | none — function returns a clear error | The signing secret Stripe gives you when you register the webhook endpoint in the Dashboard. Used to verify that an incoming webhook payload genuinely came from Stripe (never trust an unverified payload). |
| `STRIPE_PRICE_MONTHLY` | `create-checkout-session.js` | none — function returns a clear error if a `monthly` checkout is requested | The Stripe Price ID (`price_...`) for the monthly plan. No amount or price ID is hardcoded anywhere in this code. |
| `STRIPE_PRICE_YEARLY` | `create-checkout-session.js` | none — function returns a clear error if a `yearly` checkout is requested | Same, for the yearly plan. |
| `PAYWALL_ENABLED` | `generate-video.js` | **unset (off)** — this default must never change without a human decision, see above | Set to the exact string `"true"` to turn on the entitlement gate. Any other value (or unset) leaves generation ungated, as it is today. |
| `MAX_GENERATIONS_PER_IP_PER_DAY` | `generate-video.js` | `20` | Per-IP (and, once an email is present on the request, also per-email) daily cap on generation requests, backed by a Blobs counter. Generous by design — it exists to stop obvious scripted hammering, not to constrain real users. Raise or lower via this var without a code change. |
| `DAILY_SPEND_CAP_USD` | `generate-video.js` | `50` | Global daily estimated-spend circuit breaker. Once today's estimated cumulative fal.ai spend (using the conservative ~$1.60/generation upper-bound estimate already documented in `generate-video.js`) reaches this cap, new generations are rejected with `E110` until the next UTC day. This is a backstop against a failure mode in the rate limiter above (e.g. a compromised or shared paying account), not a replacement for it. |

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
   `PAYWALL_ENABLED=true`**.

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
