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
6. **Real media serving** (`media-serving.test.js`) — a plain HTTP check
   (no browser) that video-file.mjs/image-file.mjs actually serve a real
   stored file (200 + the right content-type, or a valid redirect) against
   a known-good fixture key, plus a clean-404 check for an unknown key.
   Exists specifically to catch a regression class the mocked
   `test/media-file-functions.test.js` structurally cannot see — see that
   file's own header comment for the full "why" (tracker item
   for-product-add-a-prod-smoke-assertion-f-bqt2sh, following up on
   for-product-urgent-reopen-video-repair-p-cyp8np's module-load-crash
   incident).
7. **shop.html renders real pack cards + a real server-confirmed token
   balance** for the same signed-in probe session — `session.test.js`'s
   nav-walk section, added for tracker item
   `for-product-reliability-net-spec-v1-smok-x1o5zc`'s "state-seeded
   journeys" ask.
8. **Domain routing matrix** (`domain-routing-matrix.test.js`) — plain HTTP
   checks (no browser) against BOTH real production hosts by name
   (`dreamtube1.netlify.app` and `dreamtube.life`), regardless of which
   one this run's own `--origin`/`PROD_SMOKE_ORIGIN` resolved to: both are
   live, the canonical/primary relationship between them is what's
   documented, `www.dreamtube.life` redirects correctly, and a core
   function endpoint works on both. See `docs/DOMAIN_ROUTING_MATRIX.md`
   for the full write-up (tracker item
   `for-product-reliability-net-spec-v1-smok-x1o5zc`, piece 3).

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

## Both-domain runs

Both `dreamtube1.netlify.app` and `dreamtube.life` are genuinely live
production surfaces today, not one real domain and one stale leftover —
see `docs/DOMAIN_ROUTING_MATRIX.md`. `domain-routing-matrix.test.js`
above always checks both by name, regardless of origin resolution. Every
OTHER file in this suite (`session.test.js`, `journey1-funnel-render.
test.js`, `media-serving.test.js`) still only runs against whichever
single origin `config.js` resolves for that invocation — since
`js/store.js`'s account/dream state is per-origin localStorage (see
`docs/DOMAIN_ROUTING_MATRIX.md`'s own note on this), a full run against
ONE origin cannot see a bug that only manifests on the OTHER origin, or
on an origin hop between the two (exactly the shape of
`for-product-urgent-founder-repro-on-drea-uq3a36`/
`for-product-urgent-founder-repro-index-g-c6boa9`, both 2026-08-02).

Two convenience `npm` scripts run the WHOLE suite once against each real
domain by name:

```
npm run smoke:prod:dreamtube1   # PROD_SMOKE_ORIGIN=https://dreamtube1.netlify.app
npm run smoke:prod:life         # PROD_SMOKE_ORIGIN=https://dreamtube.life
```

Each creates and self-cleans its OWN throwaway probe account (a fresh
`@example.com` identity per invocation — see `helpers/config.js`), so
running both back to back is safe and doesn't collide.

## Nightly scheduling — why this can't run INSIDE a Netlify Function

Tracker item `for-product-reliability-net-spec-v1-smok-x1o5zc` (piece 2,
"state-seeded journeys") asked for this suite to run nightly against
production on its own schedule, and to investigate honestly whether
Netlify's own scheduled-Functions mechanism (the same one
`send-daily-claim-pushes.js`/`reconcile-fal-cost.js`/`both-domain-
smoke.js` already use) could run it directly, the way those simpler
plain-HTTP background jobs do.

**Conclusion: no, not as specced, for a concrete, checkable reason** —
this suite needs a REAL Chromium binary (`playwright.chromium.launch()`,
the same `/opt/pw-browsers/chromium` this whole repo's browser tests
already depend on), and a Netlify Function's own deployed bundle has no
such binary available and no reasonable way to add one:

- Netlify Functions ship as a zipped Lambda-compatible bundle with a real,
  documented size ceiling (50MB compressed / 250MB uncompressed) — a real
  Chromium binary alone is comfortably tens of MB compressed, and would
  need to sit ALONGSIDE this repo's existing function dependencies
  (`@netlify/blobs`, `dodopayments`, `stripe`, `web-push`, etc.), not
  replace them — a real risk of blowing that ceiling for a bundle that
  otherwise stays lean on purpose.
- Even if the binary fit, Netlify Functions run under a real execution
  TIME ceiling per invocation (this repo's own existing scheduled
  functions are simple, fast, single-digit-second jobs — a full
  Playwright session doing a real signup → claim → generate → edit →
  publish/unpublish → nav-walk → shop render, PLUS a second full pass for
  the other domain, routinely takes well past a single function
  invocation's budget in this repo's own local runs — see this build's
  own report for a real measured wall-clock time).
- No `netlify dev`/local Functions runtime was available in this sandbox
  to even attempt a real end-to-end proof either way — this conclusion is
  reasoned from Netlify's own documented bundle-size and execution-time
  limits, not asserted from a failed attempt; flagged as such rather than
  overclaiming a test that was never actually run.

**What's built instead**: this environment's own external scheduling
capability (the same kind of thing that already runs this session's daily
`self-improving-agent` reflection pass, per `AGENT_POLICY.md`) fires a
nightly Routine that runs a REAL Node process (not a Netlify Function) —
`npm run smoke:prod:dreamtube1 && npm run smoke:prod:life` — against
production, then reports its pass/fail result to
`report-smoke-status.js` (a normal, public Netlify Function endpoint,
shared-secret-gated — see that file's own header comment), which writes
into the SAME `lib/smoke-status-store.js` both-domain-smoke.js itself
writes to directly. `get-smoke-status.js` reads both producers' results
back out as one combined view. See this build's own report for the exact
Routine and the one remaining human step (setting
`SMOKE_STATUS_REPORT_TOKEN` in Netlify) needed before that reporting step
actually writes anything.

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

**Update, 2026-08-03 (reliability-net build):** this suite HAS since been
run for real against production — `media-serving.test.js` and
`domain-routing-matrix.test.js` (both plain HTTP, no browser) passed
cleanly against real production as part of building the reliability-net
pieces. A real, full Chromium run of `session.test.js` against
production was ALSO attempted twice during this same build, but hit a
sandbox-wide Chromium-egress outage unrelated to this suite or to
production itself — confirmed by a minimal repro (even
`page.goto('https://example.com/')` failed with
`net::ERR_CONNECTION_RESET` via this sandbox's own Playwright/Chromium at
the time, while a plain `curl`/`fetch` to the exact same URLs succeeded
immediately) — see this build's own report for the full investigation.
One of the two attempts got the furthest through the whole session before
that outage hit (`duration_ms` ~223s total for the 9-test file, cascading
failures downstream of the very first `page.goto` once the outage
started) — that number is the "real measured wall-clock time" this file's
own "Nightly scheduling" section above cites for why a full two-domain
Playwright pass cannot fit inside a single Netlify Function invocation.
The new `shop.html` assertion this build added follows the exact same
`safeGoto`/`waitForSelector`/`textContent` pattern as its immediately
adjacent, previously-verified sibling test, and was confirmed via direct
source inspection to target real, currently-deployed selectors
(`#shop-topbar-balance`, `.pack-card`) — but was not itself confirmed by
a clean live Chromium run due to that outage; whoever next runs this
suite in a healthy environment should treat that as the first real
confirmation of this specific addition.

**Before this build**, per the ORIGINAL task's own instructions, that
first real run was intentionally held until a human/Manager had reviewed
the suite itself. It WAS verified end to end (all 9 assertions, both
files, twice for stability)
against a throwaway local stand-in server implementing just the handful
of real endpoints this suite calls, built for this one verification pass
and not shipped as part of this suite — see this task's own build report
for what that caught and fixed (a video-status polling model mismatch,
and a real, previously-uncaught discrepancy where `wizard.html`'s
then-current `#fn-username` field was validated client-side but the real
account name was always server-derived from the email instead — that
field no longer exists at all as of the merged passwordless signup wall,
tracker item `for-product-wizard-signup-wall-is-the-ol-lt1l9j`, which
also made the probe account passwordless; see `cleanupProbeAccount`'s
KNOWN GAP comment in `session.test.js` for what that means for the
suite's self-cleanup step).
