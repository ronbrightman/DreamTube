# Full-suite flakiness round 3 — investigation notes

Tracker item: `full-test-suite-has-broader-nondetermini-6fbmcb`
Branch: `fix-full-suite-flakiness-round3`
Worktree: fresh `origin/main` checkout at commit `bf0f03a`, `npm ci` run.

This is a live working file, committed and pushed as soon as the first
real finding was confirmed (per this task's own instruction — a prior
attempt on this same tracker item was lost entirely to container
recycling because nothing had been pushed).

Round 2 (`docs/flake-investigation-round2-notes.md`) left two priorities
for this round:

1. `test/scroll-lock-behavioral.test.js`'s "lock() freezes ... unlock()
   releases" test — recurred at the identical global test index (2507)
   in 3/3 full-suite runs, the strongest reproducibility signal found.
   Round 2 formed and then explicitly **walked back** a hypothesis
   (unmocked placeholder video URL → real network stall → layout
   shift → Chromium scroll-anchoring compensating mid-assertion) after
   finding real counter-evidence (a sibling file shares the same
   unmocked-URL gap without reproducing the failure) — and recommended
   real instrumentation instead of re-testing that hypothesis.
2. `test/media-library-page.test.js`'s desktop-viewport test — recurring
   45s timeouts at global index 1895, likely genuine Playwright resource
   exhaustion, not a logic bug; a process/config question
   (`--test-concurrency` tuning, glob reordering).

## Priority 1: scroll-lock-behavioral.test.js — ROOT-CAUSED AND FIXED

### Step 1 — reproduce, with instrumentation, per round 2's own recommendation

Round 2 explicitly recommended: "a console listener on the page, logging
`.scroll-area`'s `scrollTop`/`scrollHeight` and any `video`
`error`/`loadedmetadata` events around the failing assertion, run under
simulated contention — rather than re-testing the already-disproven
hypothesis."

Added temporary instrumentation (gated behind `DT_SL_DEBUG=1`, zero
behavior change when unset) directly to the target test: a Playwright
`page.on('console'/'requestfinished'/'requestfailed')` listener plus
in-page logging of `document.scrollingElement`'s and `.scroll-area`'s
`scrollHeight`/`clientHeight`/`scrollTop` at every major step (initial
scroll, lock, unlock, before/after each assertion, before/after the
final `setScroll(20)` call that fails), plus `video` element event
listeners (`loadstart`/`loadedmetadata`/`error`/etc.) and network
listeners filtered on `example.com` (the placeholder video host).

**First surprise: this reproduced in COMPLETE ISOLATION**, with no
full-suite contention needed at all — `node --test
test/scroll-lock-behavioral.test.js` run alone, repeatedly, failed 4-5
times out of every 6 runs (a ~70-80% base failure rate). This
immediately weakens the "CPU-contention-driven race" framing round 2
carried forward from the tracker item's overall theme — whatever this
is, load isn't a precondition for it.

### Step 2 — read the instrumented evidence

The failing assertion is `assert.equal(s.pos, 20, s.kind + ' scroller
responds to a scroll after unlock')` inside a `.forEach` over ALL active
scrollers returned by `installScrollProbe()`. The failure was always on
**`s.kind === 'doc'`** (the whole `document`/window scroller), never
`'inner'` (`.scroll-area`, the real product scroller) — a detail the
original bare assertion text ("3 !== 20") didn't surface, but the
instrumented run captured explicitly.

Full instrumented trace of one failing run (abbreviated):

```
STEP after-initial-scroll | doc sh=643 ch=640 st=3 | sa sh=696 ch=640 st=56
STEP after-lock           | doc sh=640 ch=640 st=0 | sa sh=696 ch=640 st=56 | body pos=fixed top=-3px overflow=hidden
STEP after-unlock         | doc sh=643 ch=640 st=3 | sa sh=696 ch=640 st=56
STEP before-getScroll-check | doc sh=643 ch=640 st=3 | ...
STEP after-getScroll-check  | doc sh=643 ch=640 st=3 | ...
STEP before-setScroll-20    | doc sh=642 ch=640 st=2 | ...   <- shrank from 3 to 2
setScroll(20) kind=doc before=2 immediatelyAfterSet=2         <- clamped, can't reach 20
setScroll(20) kind=inner before=56 immediatelyAfterSet=20     <- the REAL scroller works fine
```

Across 6 captured runs, `document.scrollingElement`'s `scrollHeight -
clientHeight` ("docDiff") was **never 0 at page-settle time and never
zero** at the point `installScrollProbe()` first samples it — it started
at 3-4px and **decayed monotonically toward 0-1px** over the ~15-25ms the
test's own steps take to run. In the one run (out of 6) that happened to
pass, `docDiff` had already decayed to exactly 1px (not `> 1`) by the
time `setScroll(20)` ran, so `installScrollProbe()`'s own inclusion
filter (`scrollHeight - clientHeight > 1`) excluded `'doc'` from the
scroller list entirely that run — the test only exercised `'inner'`,
which always passes. **The flake is a coin-flip on whether the sampling
happens to land before or after that decay crosses the `>1` threshold**,
not a network race and not scroll-anchoring compensating for anything.
No `video` events and no `example.com` network activity were observed in
any of the 6 runs at all (this seeded dream is `isPublished:false` with
no generation status set, so result.html apparently never actually
attempts to load the placeholder `videoUrl` in this state) — direct,
empirical evidence against round 2's walked-back video-network
hypothesis for this specific mechanism, not just weak counter-evidence.

### Step 3 — find WHY the document has 3-4px of decaying overflow

Checked `css/styles.css`: `#app{ ...; animation:fadeIn .25s ease; }`,
with `@keyframes fadeIn{ from{ opacity:0; transform:translateY(6px);}
to{ opacity:1; transform:translateY(0);} }` — a 250ms entrance animation
applied to `#app` on every page load, including result.html.

Wrote a standalone verification script (not part of the shipped test)
sampling `document.scrollingElement`'s `scrollHeight - clientHeight`,
`getComputedStyle(#app).transform`, and `#app.getAnimations()` every 5ms
from page load. Confirmed directly:

```
t=+50ms  docDiff=4  transform=matrix(1,0,0,1,0,4.23094)  currentTime=50ms
t=+83ms  docDiff=3  transform=matrix(1,0,0,1,0,2.54386)  currentTime=83ms
t=+117ms docDiff=1  transform=matrix(1,0,0,1,0,1.39738)  currentTime=117ms
t=+167ms docDiff=0  transform=matrix(1,0,0,1,0,0.451188) currentTime=167ms
t=+216ms docDiff=0  transform=matrix(1,0,0,1,0,0.0620448) currentTime=217ms
t=+220ms docDiff=0  transform=none                        animsRunning=[] (finished)
```

`docDiff` tracks the transform's residual `translateY` 1:1 and hits
exactly 0 the instant the animation's `playState` reports `finished`.
**Root cause confirmed**: a `translateY` transform still resolving on
`#app` transiently extends its post-transform paint bounds below its
resting position, which Chromium includes in `document.scrollingElement`
/`documentElement`'s scrollable overflow region until the transform
settles at `translateY(0)`. This is invisible and harmless to a real
user (a few px of never-actually-reachable scroll headroom for ~250ms on
page load), but `installScrollProbe()` (deliberately written to mirror
`js/scroll-lock.js`'s own `windowIsScroller()` threshold of
`scrollHeight - clientHeight > 1`) treats it as "a real, testable
scroller" whenever the test's timing happens to sample mid-decay.

This is the same root mechanism round 2's walked-back hypothesis was
reaching for (a transient layout/geometry perturbation racing the
test's fixed-value assertions) but the actual source is completely
different (a CSS entrance-animation transform, not a real unmocked
network fetch) — which is exactly why the sibling-file counter-evidence
round 2 found didn't actually disprove anything: `#app`'s `fadeIn`
animation runs on **every** page load including that sibling file's, but
the sibling file never calls the specific "scroll to a small absolute
target and confirm it landed exactly there" assertion that this
mechanism can break — it was never going to reproduce there regardless
of the true cause.

### Fix

`test/scroll-lock-behavioral.test.js`'s `seedResultPage()` now waits for
`#app`'s CSS animations to finish (`Promise.all(app.getAnimations().map(a
=> a.finished))`) before returning — a real condition-based wait (same
philosophy as this repo's `test/helpers/settle.js`: wait for the actual
transient condition to resolve, not a fixed sleep) rather than an
arbitrary delay or a threshold tweak that doesn't explain why. This
makes every scroll-probe measurement in the file reflect final, settled
page geometry.

**Deliberately test-only.** `#app`'s `fadeIn` animation itself is
intentional visual polish, not a bug — nothing in `css/styles.css` or
`js/scroll-lock.js` was touched. The tiny transient document-level
overflow it causes is real but genuinely harmless (imperceptible, and
`js/scroll-lock.js`'s own `windowIsScroller()` check having the same
`>1` threshold as the test is fine in production: even if a real overlay
were opened/closed during that 250ms window, locking and instantly
releasing 0-4px of never-visible scroll headroom has no user-observable
effect). Widening that product-code threshold to "fix" this at the
source was considered and rejected — it would be touching the actual
runtime iOS-freeze-fix code for a purely test-timing reason, out of
scope for a test-flake investigation and carrying real regression risk
of its own for zero behavioral benefit.

### Verification

- 20/20 clean isolated runs after the fix (`node --test
  test/scroll-lock-behavioral.test.js`), up from a measured ~30-35% pass
  rate before it (2-3 passes out of every 6 runs across two separate
  6-run batches).
- Confirmed via the same instrumentation that `docDiff` is now `0` at
  every sampled step post-fix, in all 5 spot-checked post-fix runs — the
  document is correctly never misclassified as an active scroller
  anymore.
- Sibling file `test/result-scroll-lock-behavioral.test.js` (which
  doesn't touch this mechanism at all) re-verified still 4/4 clean,
  confirming no unintended interaction.
- [Full-suite verification: see below, added after this section during
  the same investigation pass.]

## Priority 2: media-library-page.test.js resource exhaustion

[To be completed — see below for status.]
