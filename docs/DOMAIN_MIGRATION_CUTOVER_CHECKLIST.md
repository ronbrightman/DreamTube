# Domain migration cutover checklist

Founder-approved target structure (2026-07-31, tracker item
`for-product-domain-migration-prep-founde-iahddm`, referencing
`decision-future-planned-migration-only-m-fk2m28`):

- **App**: `dreamtube.life` (with `www.dreamtube.life` → redirect to the
  bare domain)
- **Ad funnel**: `go.dreamtube.life` (separate `dreamtube-growth` repo —
  not this checklist's concern)
- **Creative(-review) surface**: `creative.dreamtube.life`

This document is a **cutover-time checklist only**. Nothing here has been
changed today — this is prep so that when Manager/founder give the go,
cutover is "work through this list" rather than "figure out what needs
touching." See this branch's commit history / PR description for what the
accompanying zero-behavior-change code sweep did
(`js/install-nudge.js`'s mock browser toolbar now reads the real current
host instead of a hardcoded literal, and
`netlify/functions/share-dream.js`'s `FALLBACK_HOST` now derives from
Netlify's own built-in `process.env.URL` before falling back to the
literal).

Each item below: **what it is, where to find/update it, and who can do
it** (agent vs. requires a human with dashboard access).

---

## 1. Netlify itself

- **Add `dreamtube.life` (and `www.dreamtube.life`) as a custom domain**
  on the Netlify site, then set `dreamtube.life` as the **primary domain**.
  This is the one flip that matters most for code in this repo: every
  Netlify Function gets `process.env.URL` set automatically to whatever
  the site's current primary domain is — the code sweep in this branch
  made `netlify/functions/share-dream.js`'s host fallback read from that
  var, so once Netlify's own primary-domain setting flips, that fallback
  updates itself with **no further code change**.
  - Requires: human with Netlify dashboard access (domain purchase/DNS
    already done per tracker `for-ron-tomorrow-07-29...`/`decision-future...`
    — this step is specifically the Netlify-side "point it here and make
    it primary" action).
  - Also configure the `www` → apex redirect (Netlify's domain settings
    page has a toggle for this once both are added) so
    `www.dreamtube.life` redirects to `dreamtube.life`, not a dead zone.

## 2. Dodo Payments

- **Webhook endpoint URL**: registered in the Dodo dashboard (Developer →
  Webhooks, or wherever Dodo's current UI puts it — verify the exact
  path in the dashboard itself, don't trust a remembered click-path).
  Currently points at
  `https://dreamtube1.netlify.app/.netlify/functions/dodo-webhook`. Update
  to `https://dreamtube.life/.netlify/functions/dodo-webhook` at cutover.
  See `docs/PAYWALL_SETUP.md` step 3 ("Register the webhook endpoint") for
  the setup context.
  - `DODO_WEBHOOK_SECRET` does not change (it's tied to the webhook
    subscription's signing key, not the URL) — but reconfirm after
    updating the endpoint that Dodo didn't rotate it.
- **Redirect/return URLs**: `netlify/functions/create-checkout-session-dodo.js`
  builds `return_url`/`cancel_url` dynamically from the request's own
  `x-forwarded-host`/`host` header at checkout-creation time — **no
  dashboard-side redirect URL allow-list to update for this**, it already
  follows whatever domain the request came in on. Worth a smoke-test
  after cutover anyway (start a real/sandbox checkout from
  `https://dreamtube.life/shop.html` and confirm the Dodo Checkout page's
  own "back to merchant" link lands back on `dreamtube.life`, not the old
  domain).
  - Requires: human with Dodo dashboard (Live Mode) access.

## 3. Resend

- **Transactional email content**: `send-first-dream-email.js` (via
  `netlify/functions/lib/first-dream-email-sender.js`), `dream-webhook.js`,
  `request-password-reset.js`, and `submit-support-message.js` all build
  their email links (`profile.html`, `create.html`, the password-reset
  link) dynamically from the request's own host header — **no hardcoded
  domain in the email body links to change**.
- **From-address**: all four of those files currently send from
  `DreamTube <onboarding@resend.dev>` (the Resend sandbox address). This
  is being flipped to a verified `dreamtube.life` sender address under a
  **separate, already-in-flight tracker item**
  (`for-product-flip-email-sender-to-verifie-w5gal7`) — not this
  checklist's job, just flagging so cutover doesn't duplicate or
  conflict with that work. By the time domain cutover happens this is
  very likely already done.
- **Resend account/domain verification** itself (DNS records, verified
  domain status) is dashboard-side, not code — already handled per that
  same tracker item.
  - Requires: human with Resend dashboard access (only if the sender
    flip above hasn't already landed by cutover time).

## 4. PostHog

- **Toolbar authorized domains / allowed domains list**: PostHog project
  settings have an allow-list of domains the PostHog toolbar (and some
  autocapture/heatmap features) will activate on. This is a **dashboard
  setting, not code** — add `dreamtube.life` (and `creative.dreamtube.life`
  if that surface also embeds PostHog) to the allow-list at cutover.
  Verify the exact current location/label in the PostHog dashboard itself
  before clicking anything (UI labels drift).
  - `posthog.init(...)` calls in the HTML files (`home.html`, `profile.html`,
    `wizard.html`, `watch.html`, etc.) use `POSTHOG_KEY`/`POSTHOG_HOST`
    constants, not a hardcoded domain — no code change needed there.
  - Requires: human with PostHog dashboard access.

## 5. `manifest.json` (PWA manifest)

- Already domain-agnostic: `start_url` is `"./home.html"` (relative), and
  there is no `scope` field at all (Netlify/browsers default scope to the
  manifest's own directory, i.e. wherever it's served from). **No change
  needed at cutover** — confirmed by reading the file directly as part of
  this prep pass, not assumed.

## 6. OG (Open Graph) / link-preview URLs

- `netlify/functions/share-dream.js` is the only place in this codebase
  that emits `og:` meta tags, and it already derives the canonical/image
  URLs from the request's own host header (falling back to
  `process.env.URL`'s host as of this branch's sweep — see item 1 above).
  **No hardcoded OG domain to change** once Netlify's primary domain is
  flipped.
- No static HTML file in this repo has hardcoded `og:*` meta tags — grepped
  for `og:url`/`og:image`/`canonical` across every `.html` file, zero
  hits outside the dynamically-generated share-dream.js page.

## 7. Facebook (Meta) App dashboard — OAuth redirect allow-list

Not explicitly asked for in the prep task, but directly load-bearing for
the in-flight Facebook Login feature (tracker
`for-ron-social-login-research-done-decis-b0ye72`), so flagging here
rather than letting it surface as a surprise at cutover:

- `js/facebook-config.js`'s `facebookRedirectUri()` and
  `netlify/functions/facebook-oauth-callback.js`'s `redirectUri()` both
  derive the redirect URI from `location.origin`/the request host
  dynamically — no code change needed. **But** Meta's own App dashboard
  requires the exact redirect URI to be pre-registered under "Valid OAuth
  Redirect URIs" (Facebook Login product settings) and the domain under
  "App Domains" (Basic Settings). Add
  `https://dreamtube.life/.netlify/functions/facebook-oauth-callback` (and
  `dreamtube.life` to App Domains) at cutover, alongside whatever
  `dreamtube1.netlify.app` entry already exists there — don't remove the
  old one until the flip is confirmed working, in case of rollback.
  - Requires: human/Manager with Meta Business/App dashboard access (same
    track already driving Meta Business Verification for this domain).

## 8. Cloudflare Turnstile — allowed domains

- `js/turnstile-config.js`'s `TURNSTILE_SITE_KEY` is tied to a specific
  Turnstile "site" in the Cloudflare dashboard, which itself has a domain
  allow-list (see `docs/TURNSTILE_SETUP.md` step 2: "pointing at
  DreamTube's real domain(s)"). Add `dreamtube.life` to that site's
  allowed domains at cutover — same reasoning as PostHog's allow-list
  above, dashboard-side only, no code change.
  - Requires: human with Cloudflare dashboard access.

## 9. Docs mentioning `dreamtube1.netlify.app` — update after cutover, not before

These are living operational docs (read by every agent session at the
start of its run), not code, and their `curl`/example URLs are correct
**today** — updating them before the actual cutover would make them
wrong in the meantime. Update these once `dreamtube.life` is actually
live and confirmed working, in the same pass that flips the primary
domain:

- `AGENT_POLICY.md` — the `get-tracker-items` curl example
- `.claude/agents/build.md` — same curl example
- `.claude/agents/ab-test-creator.md` — same curl example
- `FOUNDER_PRINCIPLES.md` — two narrative mentions (funnel-vs-app visual
  identity comparison, and "the shared tracker" reference)
- `MANAGER_BRIEF.md` — one mention, `tracker.html` live-URL reference

## 10. What is explicitly NOT part of this checklist

Per the founder's own scoping (`for-product-domain-migration-prep-founde-iahddm`):

- **Ad destination URLs** (Meta ad campaigns pointing at the funnel) stay
  on the current funnel URL until growth's own natural next campaign
  change, to avoid a Meta learning-phase reset. Tracked separately in the
  `dreamtube-growth` repo/session — not this checklist's job.
- **`dreamtube-growth` repo's own 6 files** hardcoding
  `dreamtube1.netlify.app`-equivalent references — out of scope for this
  (product repo) session entirely; that repo needs its own equivalent
  sweep, done by whoever has access to it.
- **The actual primary-domain flip** (item 1 above) itself — this is the
  founder/Manager-gated step; nothing in this branch performs it.

---

*Compiled 2026-07-31 as part of tracker item
`for-product-domain-migration-prep-founde-iahddm`, alongside the
zero-behavior-change env/relative-URL code sweep on this same branch.*
