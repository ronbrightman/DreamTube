# test/prod-smoke — production smoke/regression suite

A Playwright suite that drives a real browser against a **real origin**
(default: live production, `https://dreamtube1.netlify.app`) with **real
network calls and no backend mocking**, except for the generation-money
surface (fal.ai video/image submission and its LLM-adjacent siblings —
see `helpers/generation-mocks.js`), which is always mocked, client-side,
regardless of which origin this suite targets.

This is deliberately **separate** from the repo's existing `test/*.test.js`
suite (`npm test`), which mocks the entire backend and runs against a local
static server — that suite proves the app's own client-side logic is
correct in isolation; this suite proves the real, currently-deployed site
actually works end to end, today, for a genuinely new user. It is **not**
wired into `npm test` and is not meant to run on every PR — it's meant to
run on a schedule (daily) against production, and on demand after a
deploy.

## Running it

```
npm run smoke:prod
```

Defaults to production. To point it at something else (a branch deploy
preview, or a local static server for verifying the suite itself — see
"Local verification" below):

```
PROD_SMOKE_ORIGIN=https://deploy-preview-123--dreamtube1.netlify.app npm run smoke:prod
# or
node --test test/prod-smoke/*.test.js --origin=http://127.0.0.1:PORT
```

Requires the same Playwright/Chromium setup the rest of this repo's
browser tests use (`/opt/pw-browsers/chromium`) — no separate install.

## What it covers

1. **Home renders every currently-approved module** (as of 2026-08-01):
   Tip of the Day, Get Inspired, Consider Publishing, Make It Yours,
   the ritual/streak module, and the hero. See `session.test.js`'s own
   test 2 — and see that file's own comment on why some of these are only
   asserted to *exist*, not to be visible, where visibility is
   legitimately data-conditional (e.g. "Get inspired" needs public dreams
   in the shared feed to show anything).
2. **Funnel screens match `docs/JOURNEY_MANIFEST.md`**: `session.test.js`
   drives Journey 2 (organic, `wizard.html`) end to end as part of the
   real signup; `journey1-funnel-render.test.js` separately confirms
   Journey 1's entry screen (`start.html?resume=1`, the paid-ad-funnel
   handoff) is alive on the target origin. Neither re-implements the
   repo's existing `test/journey-manifest.test.js`, which already pins
   the exact ordered screen sequence at the source level — these are
   live, deployed-build confidence checks, not a replacement for it.
3. **Signup → first daily-token claim → create a dream (mocked
   generation) → forming card → the dream's own room → edit the dream
   (mocked generation again) → the regenerating veil → completion →
   reload** — `session.test.js`, one continuous session. The reload step
   is a direct regression check for tracker item
   `for-product-bug-founder-repro-high-edit--i2yzqo` (two concurrent
   "resumers" of the same job clobbering a legitimate completion): the
   test navigates to the dream's own room *while an edit is still
   in-flight*, confirms the veil, lets it complete, then reloads and
   asserts the NEW content — not a stale reversion — is what's displayed,
   both in the DOM and in the persisted local record.
4. **Publish, then unpublish** the dream — real `publish-dream.js`/
   `unpublish-dream.js` round trips against the real shared feed.
5. **A bottom-dock nav walk** — home → explore → create → profile → home.

## Safety — why this is safe to run daily against real production

- **Zero fal.ai (or LLM) cost, ever, regardless of origin.** Every
  generation-adjacent endpoint (`start-pending-generation`,
  `claim-pending-generation`, `generate-video`, `generate-image`,
  `video-status`, `image-status`, `mark-generation-completed`,
  `consume-generation-marker`, `realign-dream-prompt`,
  `rewrite-dream-story`) is intercepted client-side via Playwright's
  `page.route()` before the browser ever sends the request — see
  `helpers/generation-mocks.js`'s own header comment for the full list
  and reasoning. The real server never sees these requests.
- **A single, freshly-created, throwaway "probe" account per run**, using
  an `@example.com` email — see `helpers/config.js`'s own comment for why
  that's the convention reused here rather than the historical
  `__probe_throwaway_user__` literal-username shape (which
  `register-account.js`'s own `E10 suspicious_username` guard would
  reject at signup today). `js/store.js`'s existing
  `isTestOrInternalIdentity()` already tags any `@example.com` account as
  test/internal for analytics purposes — this suite doesn't invent a new
  convention, it reuses that one.
- **Self-cleaning.** The probe account is deleted via the real
  `delete-account.js` endpoint at the end of every run (which itself also
  removes any dream the probe published from the shared feed — see that
  file's own header comment) — `session.test.js`'s `test.after` runs this
  even if an earlier step in the run failed, so a broken run never leaves
  a stray account behind silently.
- **Well under every existing rate limit** (`netlify/functions/lib/rate-
  limit.js` and each endpoint's own per-IP/per-day cap) — this suite
  makes at most one real call to each non-generation endpoint per run
  (one signup, one login-verification, one delete, one daily-claim, one
  publish, one unpublish, plus a couple of cheap reads), nowhere near any
  default cap (20-100/day depending on the endpoint), even run daily
  indefinitely.

## Local verification (this suite's own tests, not production)

This repo has no local Netlify Functions runtime available in every
environment (no `netlify dev` guaranteed installed) — `test/*.test.js`'s
own local static server (`test/helpers/static-server.js`) deliberately
serves static files only, never functions (see that file's own header
comment). Since this suite calls REAL functions for everything except
generation, verifying it end-to-end against a local static server alone
isn't possible without also standing up a functions backend of some kind
for that verification session — point `PROD_SMOKE_ORIGIN`/`--origin` at
whatever environment you're using for that (a `netlify dev` instance, a
branch deploy preview, or a throwaway Netlify site) rather than assuming
`test/helpers/static-server.js` alone is enough.

**This suite has NOT been run against real production as part of building
it** — per this task's own instructions, that first real run should only
happen once a human/Manager has reviewed the suite itself. It WAS
verified end to end (all 9 assertions, both files, twice for stability)
against a throwaway local stand-in server implementing just the handful
of real endpoints this suite calls, built for this one verification pass
and not shipped as part of this suite — see this task's own build report
for what that caught and fixed (a video-status polling model mismatch,
and a real, previously-uncaught discrepancy where `wizard.html`'s
`#fn-username` field is validated client-side but the real account name
is always server-derived from the email instead).
