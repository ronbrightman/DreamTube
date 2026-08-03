# Domain routing matrix

**What actually serves what, right now, verified live** — tracker item
`for-product-reliability-net-spec-v1-smok-x1o5zc`, piece 3 ("routing
matrix"). This is a **different document from
`docs/DOMAIN_MIGRATION_CUTOVER_CHECKLIST.md`**, deliberately not a
duplicate or a replacement of it — see "How this relates to the cutover
checklist" below for exactly how the two differ and why both stay.

## The current live state (verified 2026-08-03, `curl` against real production)

Both of these are real, currently-live production hosts serving the
**same deployed site** (same Netlify site, same deploy, same functions —
not two separate apps):

| Host | Status | Role |
|---|---|---|
| `https://dreamtube.life` | 200, no `Link: rel="canonical"` header on its own responses | **Primary/canonical domain** — this is the one Netlify treats as authoritative today |
| `https://dreamtube1.netlify.app` | 200, **carries `Link: <https://dreamtube.life/PATH>; rel="canonical"`** on every response | **Live alias** — still fully serves real traffic (not redirected), but marks itself as pointing at the canonical host via that header |
| `https://www.dreamtube.life` | 301 → `https://dreamtube.life/` (apex, no path preserved beyond root) | www→apex redirect, already wired |

Verified directly, not assumed (see this codebase's own "verify at
source" standing lesson — `FOUNDER_PRINCIPLES.md`'s "verify-at-source
law"):

```
$ curl -sSI https://dreamtube1.netlify.app/home.html | grep -i '^link\|^etag'
link: <https://dreamtube.life/home.html>; rel="canonical"
etag: "ca7f8fc342893495359efc8f337267b7-ssl"

$ curl -sSI https://dreamtube.life/home.html | grep -i '^link\|^etag'
etag: "ca7f8fc342893495359efc8f337267b7-ssl"
```

Identical `etag` on both hosts for the same path confirms this is truly
one deploy served from two hostnames, not two divergent copies. Function
endpoints behave identically on both hosts too (spot-checked
`get-feed`: 200 on both).

**This means BOTH domains are genuinely live production surfaces today**
— not a stale leftover netlify.app subdomain nobody uses anymore. Real
founder-reported bugs have hit both
(`for-product-urgent-founder-repro-on-drea-uq3a36`,
`for-product-urgent-founder-repro-index-g-c6boa9`, both 2026-08-02), and
this repo's own client-side state (`js/store.js`'s localStorage-backed
account/dream data) is **per-origin** — an account, a pending generation,
a login session on `dreamtube1.netlify.app` does not exist on
`dreamtube.life` and vice versa, since browsers scope localStorage by
origin. Anything that assumes "the user's browser state carries over
between the two hosts" is wrong; anything that tests only ONE host is
structurally blind to a whole class of bug that only shows up on an
origin hop (see the two tracker items above for two real, founder-hit
examples of exactly that).

## How this relates to the cutover checklist

`docs/DOMAIN_MIGRATION_CUTOVER_CHECKLIST.md` (compiled 2026-07-31) is a
**forward-looking, pre-cutover TODO list** — "when Manager/founder give
the go, work through this list" — for a list of *other* systems (Dodo,
Resend, PostHog, Meta OAuth, Cloudflare Turnstile, this repo's own docs)
that still need a human to flip a dashboard setting or update a doc
pointer once `dreamtube.life` becomes primary. Its own item 1 is
literally "add `dreamtube.life` as a custom domain, then set it as the
primary domain."

**That item 1 step already appears live**, per the verified evidence
above (the canonical `Link` header only appears this way once Netlify's
own primary-domain setting has been flipped to `dreamtube.life` — this
is Netlify's own documented behavior for a site with a custom domain set
as primary and old netlify.app subdomain access left enabled). This
document does not edit that checklist's own item 1 (whether the *rest*
of its steps — Dodo webhook URL, Resend sender, PostHog allow-list, Meta
OAuth redirect URIs, Cloudflare Turnstile allow-list, the doc-pointer
sweep — have also been completed is genuinely unknown from this repo
alone, and each needs its own dashboard-side verification by whoever has
that access) — flagged as a discrepancy worth a human/Manager
reconciliation pass in this build's own report, not silently resolved
here.

**This document's job is narrower and different in kind**: it's a
snapshot of *what is verifiably true about routing right now*, backed by
a real test (`test/prod-smoke/domain-routing-matrix.test.js`) that keeps
re-verifying it, so the next time routing regresses (one domain starts
behaving differently from the other, the www redirect breaks, a function
starts failing on only one host) **CI catches it**, instead of the
founder noticing something broken first — this codebase's own recurring
failure mode (see `for-product-urgent-founder-repro-index-g-c6boa9`'s own
tracker text: "How come there is no routine check to catch such
things?", asked about the funnel journey and equally true here).

## What the test asserts

`test/prod-smoke/domain-routing-matrix.test.js` (part of
`npm run smoke:prod`, real HTTP against real production, no browser
needed):

1. Both `dreamtube1.netlify.app` and `dreamtube.life` return a real 200
   for a couple of key pages.
2. `dreamtube1.netlify.app`'s responses carry the canonical `Link` header
   pointing at `dreamtube.life` for the SAME path.
3. `dreamtube.life`'s own responses do NOT carry that header (it doesn't
   point at itself) — confirms it, not the netlify.app host, is the one
   Netlify considers canonical.
4. `www.dreamtube.life` redirects (3xx) to the bare `dreamtube.life` apex.
5. A "core" function endpoint (`get-feed`) returns a real 200 on BOTH
   hosts — proving functions, not just static pages, are equally live on
   both.

If any of these ever stop being true — say, `dreamtube1.netlify.app`
starts 404ing, or the canonical header disappears, or `www` stops
redirecting — this test fails on the next `npm run smoke:prod` run
(scheduled, see `test/prod-smoke/README.md`) rather than waiting for a
founder repro.

## Re-verifying this by hand

```
curl -sSI https://dreamtube1.netlify.app/home.html | grep -i '^link'
curl -sSI https://dreamtube.life/home.html | grep -i '^link'
curl -sSI https://www.dreamtube.life/ | grep -i '^location'
```

If the picture ever changes (a real cutover step flips which host is
primary, `www` stops redirecting, etc.), update the table above AND
`test/prod-smoke/domain-routing-matrix.test.js`'s own assertions in the
same change — same "keep the written record honest" discipline
`docs/TEST_REGISTRY.md`'s own header comment already holds this repo to.

---

*Compiled 2026-08-03, tracker item
`for-product-reliability-net-spec-v1-smok-x1o5zc`. Last verified against
real production the same day — see the `curl` output above.*
