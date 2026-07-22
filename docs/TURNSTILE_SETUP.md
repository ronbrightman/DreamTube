# Cloudflare Turnstile setup

A baseline bot-abuse layer in front of DreamTube's real video generation
call, per the founder-approved recommendation from the anti-abuse-
guardrails research: Turnstile is free, low build cost, and stops naive
scripted abuse — it doesn't stop a determined attacker alone, but it's a
cheap complement to the existing `E109` rate limit / `E110` spend cap /
`E112` token gate already in `netlify/functions/generate-video.js`. Read
`AGENT_POLICY.md` for why the Cloudflare account/site itself is a human
step this document does not do.

## Why this is attached to generation, not signup

Turnstile requires a server-side verification call (Cloudflare's
`siteverify` API, using a secret key) at the same request that does the
sensitive action. `js/store.js`'s `signup()` is 100% client-side (writes
to localStorage only, no server call at all today), so there is nowhere
server-side to verify a token there without inventing new server surface —
deliberately avoided for the same reason during the token-economy work
(see `netlify/functions/lib/entitlements.js`'s doc comment on the per-IP
signup-bonus cap, enforced at first-token-read time specifically to avoid
a new signup endpoint).

`netlify/functions/generate-video.js` already has a real backend round
trip, and all three generation paths — a brand-new generation from
`style.html`, an edit/regenerate from `result.html`, and a retry from
`processing.html` — funnel through the exact same handler via
`processing.html`'s `runGeneration()`. That's the one real choke point,
and where the widget/token is attached.

## What this feature does and does not do

**Does:**
- `js/turnstile-config.js` — loads Cloudflare's Turnstile script and
  renders a widget in **Managed or Invisible mode** (whichever the site
  key itself is configured as in Cloudflare's dashboard — see below),
  obtaining a token asynchronously before `processing.html`'s
  `runGeneration()` fires the actual `generate-video` request, and
  attaching it to that request body as `turnstileToken`.
- `netlify/functions/lib/turnstile.js` — calls Cloudflare's `siteverify`
  API with the secret key + the client's token.
- A guardrail in `netlify/functions/generate-video.js` (`E113`, see that
  file's error-code doc block) that rejects the request (`403`) if
  verification fails or the token is missing — **only when
  `TURNSTILE_SECRET_KEY` is configured**.

**Does not do** (explicitly out of scope):
- Create a Cloudflare account or a Turnstile site. This cannot run at all
  until a human does that — see "What a human still needs to do" below.
- Touch `js/store.js`'s `signup()` — see "Why this is attached to
  generation, not signup" above.
- Replace or weaken `E109`/`E110`/`E112` — this is an additional,
  independent layer alongside them, not a substitute for any of them.

## The critical safety flag: `TURNSTILE_SECRET_KEY`

**DreamTube is a live product with real existing users, and until a real
Cloudflare Turnstile site exists, there is no token for the client to send
and no secret key to verify one against.** If the `E113` check were
unconditional, this would instantly block every real generation the
moment this code deploys, with no Cloudflare site behind it yet.

- **Unset, or still the placeholder value** (this is the default in every
  environment today, including right after this branch merges): the
  `E113` guardrail is skipped entirely, server-side. Generation works
  exactly as it did before this feature — ungated by Turnstile. This is
  safe to merge and deploy immediately, same as `PAYWALL_ENABLED`'s
  default-off pattern in `docs/PAYWALL_SETUP.md`.
- **Set to a real secret key**: `generate-video.js` requires a valid
  `turnstileToken` on every request, returning `E113:
  turnstile_verification_failed` otherwise.

The client-side half (`js/turnstile-config.js`'s `TURNSTILE_SITE_KEY`)
follows the identical placeholder-checked pattern already used by
`js/analytics-config.js`'s `POSTHOG_KEY`/`META_PIXEL_ID`: while it's still
the placeholder string, no Turnstile script is ever loaded, no widget is
ever rendered, and no delay is ever added to the generation flow —
`getTurnstileToken()` resolves immediately with `null`.

**Do not set `TURNSTILE_SECRET_KEY` in any environment until:**
1. A real Cloudflare account and Turnstile site exist (see below).
2. `TURNSTILE_SITE_KEY` in `js/turnstile-config.js` has also been updated
   to the matching real site key — a secret key configured without the
   matching site key deployed client-side means every real request would
   arrive with no token at all, and get rejected by `E113`.

## Managed vs. Invisible mode — a dashboard choice, not a code choice

Turnstile's widget mode (Managed, Non-Interactive, or Invisible) is chosen
**when the site key itself is created**, in Cloudflare's Turnstile
dashboard — it is not a parameter this codebase's `render()` call
controls. This feature deliberately targets Managed or Invisible (not the
always-visible checkbox widget), since Cloudflare's own Managed mode is
frequently non-interactive for normal traffic — chosen specifically to
avoid adding friction to the generation flow for legitimate users.

`js/turnstile-config.js` renders the widget into a container that starts
hidden (`display:none`) and stays that way for the whole session on
Invisible mode (never shows UI at all) and for the common Managed-mode
case (Cloudflare's risk scoring passes non-interactively). But Managed
mode can also decide a specific request needs an interactive
checkbox/puzzle challenge — when that happens, `getTurnstileToken()`
promotes the same container to a visible, centered overlay (via
Turnstile's `before-interactive-callback`/`after-interactive-callback`
hooks) so that user can actually see and complete it, then hides it again
once resolved. Without this, a Managed-mode challenge would render into a
permanently invisible container, time out, and silently block generation
for exactly the users Cloudflare flagged.

## Environment variables

| Variable | Where it's used | Default if unset | What it does |
|---|---|---|---|
| `TURNSTILE_SITE_KEY` | `js/turnstile-config.js` (client-facing constant, not a secret — safe to ship in a static JS file, same as `META_PIXEL_ID`) | placeholder string — Turnstile stays fully inert (no script load, no widget, no delay) | The Cloudflare Turnstile site key. Once set to a real value, `getTurnstileToken()` starts actually loading the widget and obtaining tokens. |
| `TURNSTILE_SECRET_KEY` | `netlify/functions/generate-video.js` (server-only — **never** exposed to the client, never referenced from any `.html`/`js/*.js` file) | unset — the `E113` guardrail is skipped entirely, exactly as if this feature didn't exist | Cloudflare's Turnstile secret key, used only to call the `siteverify` API server-side. Must be set in the Netlify site's environment variables (Site settings → Environment variables, or the Netlify CLI) — never checked into source. |

## What a human still needs to do (not something this branch does)

Per `AGENT_POLICY.md`, creating any account or signing up for any service
is a human-approval action an agent should not take autonomously.
Concretely, before any of this can go live:

1. **Create a Cloudflare account** (or use an existing one) for
   DreamTube, if one doesn't already exist.
2. **Create a Turnstile site** in the Cloudflare dashboard (Turnstile →
   Add a site), pointing at DreamTube's real domain(s). Choose **Managed**
   or **Invisible** widget mode when prompted (see "Managed vs. Invisible
   mode" above) — not the always-visible checkbox mode.
3. **Copy the Site Key** into `js/turnstile-config.js`'s
   `TURNSTILE_SITE_KEY` constant (replacing the placeholder string).
4. **Copy the Secret Key** into `TURNSTILE_SECRET_KEY` in the Netlify
   site's environment variables — never commit this to source, and never
   put it in any client-side file.
5. Deploy both changes together (steps 3 and 4 need to land at the same
   time — see the safety-flag section above for why setting the secret
   key alone, without the matching site key deployed, would block real
   generation).

## How to test this once the above exists

- **Fully inert (today's default, before any setup)**: confirm
  `npm test` passes unmodified and a real `generate-video` request (mock
  mode or otherwise) succeeds with no `turnstileToken` in the request body
  at all — see `test/generate-video-turnstile.test.js`'s "guardrail is a
  no-op when TURNSTILE_SECRET_KEY is unset" coverage.
- **Missing token, secret key configured**: with `TURNSTILE_SECRET_KEY`
  set in a test/branch deploy, a `generate-video` request with no
  `turnstileToken` (or an empty one) gets `E113:
  turnstile_verification_failed: missing_token`.
- **Invalid/expired token**: a request whose `turnstileToken` Cloudflare's
  `siteverify` rejects gets `E113` with the short reason Cloudflare
  returned.
- **Real end-to-end pass**: with both keys configured and deployed,
  load `processing.html` in a real browser, confirm the Network tab shows
  a call to `challenges.cloudflare.com` and that the `generate-video`
  request's body includes a non-null `turnstileToken`, and confirm
  generation completes normally.
