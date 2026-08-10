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

**Independent re-verification (separate session, same day)**: confirmed
the mechanism and the fix, but with a different measured base rate and a
different specific assertion observed failing. Pre-fix: 1 failure in 23
isolated runs (~4%, not the ~65-80% measured above) — plausibly a
machine/Chromium-version timing sensitivity, since this is a real
millisecond-scale race, not a difference in the underlying mechanism.
The one failure caught was NOT the "`setScroll(20)` unreachable"
assertion described above, but the earlier "doc scroll position is
restored to where the user was" assertion (`3 !== 4`) — fully consistent
with the same root cause (docDiff hadn't reached 0 yet when `openPos`
was captured before `lock()`, but had shifted by the time position was
checked after `unlock()`), just a different point in the same file where
a stale mid-decay `document` scroll measurement can surface as a
mismatch. Post-fix: 0 failures in 30 isolated runs. Confirms the fix
(waiting for `#app`'s animation before any measurement, applied at the
earliest point in `seedResultPage()`) is correctly positioned to prevent
every assertion in this file that depends on settled document scroll
geometry, not just the one specific assertion this round happened to
observe failing most often.

## Priority 2: media-library-page.test.js resource exhaustion — mechanism confirmed, tuning has a real cost, not shipped

This test's own header comment (added in an earlier session, commit
`7fc7f7a`) already correctly diagnosed this as genuine Playwright
resource exhaustion, not a logic bug — confirmed independently here, not
re-litigated. What round 2 left open was whether `--test-concurrency`
tuning or file-glob reordering could reduce it (a scheduling/config
question, not a code fix).

### A faster reproduction proxy

A full `node --test test/*.test.js` run takes ~10 minutes, too slow to
iterate on a scheduling experiment. Round 2's failures always landed at
a global test index around 1895/~3345 (~57% through), which — since
`node --test`'s default file concurrency spreads work roughly evenly
across the whole run — lines up almost exactly with running only the
first 155 of 264 alphabetically-sorted test files (`ls test/*.test.js |
sort | head -155`, which includes `media-library-page.test.js` and
comfortably more). This subset reproduces the same real contention
profile in ~5 minutes instead of ~10, confirmed by reproducing the exact
same failure at test index 1896 in the truncated run:

```
not ok 1896 - desktop viewport: page content past the fold is reachable by scrolling (not clipped)
  duration_ms: 46299.360758
  error: 'page.waitForFunction: Timeout 45000ms exceeded.'
```

(46299ms against a 45000ms budget — a hair over, exactly the kind of
narrow, load-dependent overrun the existing test comment already
describes, not a hang.)

### The experiment

Node's test runner defaults to file-level concurrency of
`os.availableParallelism() - 1` (confirmed empirically: 3 concurrent
`chromium` processes observed live via `ps aux` during a run on this
4-CPU sandbox). Ran the same 155-file subset three more times, comparing
default concurrency against `--test-concurrency=2`:

| Run | Concurrency | Pass | Fail | media-library-page timeout? | Wall clock |
|---|---|---|---|---|---|
| A | default (3) | 2089/2092 | 3 | **YES** (46299ms, over the 45000ms budget) | 328.5s |
| B | 2 | 2090/2092 | 2 (unrelated: comment-sheet, ritual-constel — see below) | no | 288.4s |
| C | 2 | 2092/2092 | 0 | no | 272.3s |

Zero media-library-page timeouts in 2/2 runs at `--test-concurrency=2`,
against a reliable reproduction at default concurrency — and critically,
when it DID pass at concurrency=2, it did so with real margin, not a
lucky near-miss: actual duration was 683ms and 747ms across the two
clean runs, ~60x under the 45000ms budget, vs. the 46299ms that blew the
budget at default concurrency. That gap is the direct, measurable
signature of removing CPU contention, not scheduling coincidence.

**On the 155-file subset, wall-clock time was also faster at
`--test-concurrency=2`** (288s, 272s) than at default concurrency (328s).
I initially wrote this up as a "strict win" (fewer flakes AND faster) —
**that claim does not survive the full 264-file run below and I'm
correcting it here rather than leaving it stand.**

### Full-suite confirmation (all 264 files) — corrects the "faster" claim above

| Run | Concurrency | Pass | Fail | media-library-page timeout? | Wall clock |
|---|---|---|---|---|---|
| D (this round, unmodified branch, run independently and reviewed by the coordinator) | default (3) | 3341/3341 | 0 | no (didn't reproduce this time — consistent with round 2's own ~66%, not 100%, base rate) | 592.3s |
| E | 2 | 3334/3336 | 2 (unrelated: `comment-sheet-behavioral.test.js`, `result.html "Start over instead"` — neither is media-library-page, not investigated further) | no | 915.8s |

At full scale, `--test-concurrency=2` is **~55% SLOWER** (915.8s vs
592.3s), the opposite of what the 155-file subset suggested. The subset
result wasn't wrong, it was unrepresentative: the first 155
alphabetically-sorted files are not a random sample of the suite's true
weight, and extrapolating a small subset's timing ratio to the full
264-file run was a mistake — flagging this explicitly rather than
quietly fixing the number, since getting caught by an unrepresentative
sample is itself worth remembering for next time. Also notable: even
run D's clean 3341/3341 pass is a reminder that media-library-page's
timeout is genuinely probabilistic at default concurrency (round 2 saw
it in 2/3 runs; this round's one default-concurrency full run happened
to be the lucky 1/3) — a single clean run doesn't disprove the
mechanism, and a single reduced-concurrency win doesn't prove the tuning
is free of cost either.

**Combined picture across all 5 runs this round (2 subset + 1 full at
default; 2 subset + 1 full at concurrency=2): media-library-page's
timeout appeared in 1/2 default-concurrency runs and 0/3
concurrency=2 runs.** That's consistent with `--test-concurrency=2`
meaningfully reducing (not necessarily fully eliminating — n is small)
this specific test's resource-exhaustion failure, genuinely rooted in
less CPU contention per browser (confirmed via the 683-747ms vs
46299ms margin above) — but it comes with a real, non-trivial cost: a
~55% longer full-suite run, and it does not make the suite flake-free
in general (2 other, unrelated tests failed in the concurrency=2 full
run that don't fail at default).

**Decision: not shipping a `package.json` concurrency change.** This
is a genuine tradeoff (a well-documented, already-accepted occasional
flake in ONE test vs. a permanently ~50% slower full suite for every
future build/review agent run) rather than a free, no-downside fix —
the kind of call this file's own escalation policy and this task's
"only ship what you can prove, and be honest when a finding doesn't
hold" standard both point toward leaving to a human/coordinator
decision rather than an autonomous package.json edit. Documenting the
full evidence here so that decision can be made with real numbers
instead of a guess.

**Two other, unrelated failures surfaced during this experiment** (not
part of this round's scope, noted for whoever picks them up next):
- `test/comment-sheet-behavioral.test.js`'s "deleting a comment rolls
  back..." test (index 479 in both run A and run B) — this is round 2's
  own previously-diagnosed, still-unconfirmed MutationObserver-batching
  lead. Consistent with round 2's notes; not re-investigated here.
- `home.html`'s ritual-constellation 0x0-render regression test (index
  1542, run B only, absent from run C) — a NEW one-off flake not seen in
  any prior round's notes. Only observed once; not enough signal to
  investigate further this round. Flagging for whoever picks up the
  next round.

### Recommendation (not applied)

An earlier draft of this section recommended setting
`--test-concurrency=2` in `package.json`'s `test`/`test:full` scripts.
**That recommendation is superseded by the full 264-file confirmation
run above**, which found a real ~55% wall-clock cost that the smaller
155-file subset didn't surface. See "Full-suite confirmation" above for
the corrected picture and the decision not to ship it autonomously —
this is a real tradeoff (occasional single-test flake vs. permanently
slower full-suite runs for every future build/review agent) for a
human/coordinator to decide with the numbers above, not something to
bake into the repo's default test invocation unilaterally.

If the tradeoff IS accepted later: the mechanically simplest way to
apply it without touching the shared `test`/`test:full` scripts (so
default behavior for anyone who wants the faster/noisier suite is
unchanged) would be a separate script, e.g. `"test:full:stable":
"node --test --test-concurrency=2 test/*.test.js"`, left for whoever
makes that call.

## Summary for whoever picks this up next

- **Fixed and verified**: `test/scroll-lock-behavioral.test.js` (branch
  `fix-full-suite-flakiness-round3`, merged to `main` as `589d581`). 20
  clean isolated runs post-fix (up from ~30-35% before), plus confirmed
  clean under a real, independently-reviewed full-suite run (3341/3341,
  0 failures).
- **Investigated, mechanism confirmed, not shipped**:
  `test/media-library-page.test.js`'s desktop-viewport timeout.
  `--test-concurrency=2` measurably reduces it (0/3 vs 1/2 at default
  concurrency across this round's runs, with a decisive ~60x timing
  margin when clean) but costs ~55% more full-suite wall-clock time at
  full scale — a real tradeoff, documented above with full numbers, left
  for a human decision rather than an autonomous `package.json` change.
- **New, unconfirmed leads surfaced this round, not investigated**
  (flagging only, zero repro attempts spent on these — out of this
  round's assigned scope):
  - `profile.html`: "cancelling a pending regeneration when editing an
    existing self character..." — failed once (155-file subset, default
    concurrency run A, index 318). Not seen in round 2's notes. Single
    occurrence only.
  - `home.html`'s ritual-constellation 0x0-render test — failed once
    (155-file subset, concurrency=2 run B, index 1542). Not seen in
    round 2's notes. Single occurrence only, notable because its own
    title says it's a regression test for exactly this rendering
    failure mode, so a timing-driven false positive here is worth a
    closer look by whoever has bandwidth — but not chased down this
    round.
- **Still open from round 2, not touched this round** (per this round's
  explicit two assigned priorities — not re-investigated, still valid
  leads for a future round): `notify-likes-badge-behavioral.test.js`'s
  SW-controllerchange-reload hypothesis;
  `comment-sheet-behavioral.test.js`'s MutationObserver-batching
  hypothesis (recurred again this round, still unconfirmed);
  `result-photo-upload-sheet-token-behavioral.test.js`'s 30s timeout
  (same resource-exhaustion category as media-library-page, not
  separately re-verified this round).
- `docs/TEST_REGISTRY.md` not touched — matching round 2's own precedent
  for its analogous share-sheet fix, this is a test-infrastructure fix
  (a condition-based wait, replacing a race-prone measurement), not a
  behavior/coverage change.

## Round 4 — comment-sheet-behavioral.test.js's delete-rollback flake, ROOT-CAUSED AND FIXED

Tracker item `for-product-low-behavioral-test-suite-se-4on41a` (LOW
priority). Branch `fix-behavioral-suite-order-dependent-flakes`. Picks
up round 2's own "MutationObserver-batching, NOT confirmed" hypothesis
for `comment-sheet-behavioral.test.js`'s "deleting a comment rolls back
on a failed delete-comment response" test, which had recurred across
multiple rounds (round 2, round 3's own priority-2 experiment run E, and
independently again this round) without ever being pinned down.

### Environment note: this sandbox runs multiple concurrent agent sessions

Confirmed directly via `ps`/`/proc/<pid>/cwd`: while investigating,
**a completely separate session's own `npm test` (a different worktree,
`dreamtube-fix-out-of-tokens-inline-claim`, an unrelated branch) was
running concurrently** on this same 4-CPU sandbox, driving the observed
load average up to 17-20 (vs. 4 cores). This is a REAL, broader form of
the "resource exhaustion" theme rounds 2-3 already established — full-
suite runs on this infrastructure are subject to genuine CROSS-SESSION
CPU contention, not only node:test's own file-level concurrency among a
single suite's own workers. Worth knowing for anyone else chasing a
load-dependent flake here: a suspiciously bad run (or a suspiciously
long one) may be someone else's session, not a regression.

### Step 1 — reproduce

Isolated (`node --test test/comment-sheet-behavioral.test.js`): 16/16
clean, 2/2 runs — matches every prior round's finding. Ran the full
suite; the environment's live cross-session load made a true full
264-273-file run impractical to complete inside a single tool
invocation (see below), so used round 3's own established "faster
reproduction proxy" technique: the first 90 alphabetically-sorted files
(`ls test/*.test.js | sort | head -90`, comment-sheet-behavioral.test.js
is file #43). This subset reliably reproduced the exact real symptom on
the first attempt: `not ok 508 - deleting a comment rolls back on a
failed delete-comment response...` / `page.waitForSelector: Timeout
3000ms exceeded ... 10 x locator resolved to visible ... never
detached` — identical error shape to every prior round's capture.

### Step 2 — distinguish shared-state vs. resource-exhaustion (task's own suggested test)

Structurally already ruled out per `test/helpers/settle.js`'s own header
comment: `node --test test/*.test.js` runs every FILE in its own child
process, so no JS module-level state can leak between files at all —
confirmed independently again by inspecting this file: every test opens
its own fresh `browser.newContext()` (isolated storage), the one
file-level shared `browser` instance is only reused as a Chromium
process handle (no shared page/state), and `js/comment-sheet.js`'s own
`currentGen` guard variable lives inside the PAGE's JS realm, reset on
every fresh navigation. Genuinely nothing to leak.

### Step 3 — direct instrumentation confirms the precise mechanism

Built a standalone instrumented reproduction (`page.on('console')`
logging + Node-side `Date.now()` timestamps around each step, plus an
in-page `MutationObserver`) mirroring the failing test's exact steps,
run alongside real concurrent Chromium-driven test files (not raw CPU
busy-loops — an early attempt at those over-saturated the box badly
enough to produce an unrelated symptom, a real network stall on this
file's own unmocked `https://example.com/fake-feed-video.mp4` — see
"other findings" below).

Under real contention (`media-library-page.test.js` +
`wizard-ui-behavioral.test.js` + `social-layer-v2-profile-
behavioral.test.js` running concurrently), reproduced the EXACT real
failure twice in a row. Timestamps from one run:

```
T+202ms  NODE: delete-comment route handler invoked
T+202ms  NODE: delete-comment route.fulfill() returned
T+237ms  PAGE CONSOLE: Failed to load resource: the server responded with a status of 500
T+265ms  clicked delete (page.click() resolved)
T+3269ms TIMED OUT waiting for detached: page.waitForSelector: Timeout 3000ms exceeded.
```

**The mocked 500 response was already fulfilled and processed by the
page — including running `.catch()` and reinserting the row — 28ms
BEFORE Node even resolved its own `await page.click(...)` a few lines
earlier in the test.** Under low/no contention (same script, no
concurrent load), the identical sequence completes end-to-end in ~100ms
with `page.click()` resolving well before the route fires, so the
transient "detached" window is easily observed by the very first poll.

**Root cause**: `js/comment-sheet.js`'s `deleteCommentAction` removes
the row from `loadedComments` and calls `renderList()` SYNCHRONOUSLY on
click, before `fetch()` is even called — so far so correct, and not the
bug. The bug is entirely in the test: the mocked `delete-comment` route
(`route.fulfill()`, zero artificial delay — a real network call would
never resolve this fast) requires only ONE CDP round-trip through Node.
Under CPU/scheduling contention, Node's own message-processing loop can
lag badly enough that a handful of its own SEQUENTIAL awaits (here,
`page.click()` itself) resolve LATE relative to what has already
happened inside the browser — including the entire remove -> mocked-fail
-> rollback-reinsert cycle, which needs no further help from Node once
the route has fired. By the time the test's own
`waitForSelector(state:'detached')` call is even reached, the transient
detached state has ALREADY come and gone — it will not recur, so no
amount of additional timeout budget could ever catch it (confirmed: the
observed failure is not "ran out of time", it's "10/10 polls, never
once caught mid-transition"). This is the same causal-ordering-
assumption family `test/helpers/settle.js`'s own header comment already
documents (a fixed await sequence assumes an ordering that Node-side/CDP
delay doesn't actually guarantee under load) — but the earlier documented
cases there are about a DOM gate racing a Node-side counter; this one is
about a Node-side mocked network reply racing Node's own outstanding
awaits, a variant not previously named in that file.

This also DEFINITIVELY answers round 2's own "the reasoning [for
MutationObserver batching] doesn't cleanly explain why load would cause
it" concern: it isn't MutationObserver batching at all — it's a genuine
causal race between Node's own event-loop scheduling and a same-tick-fast
mocked network reply, which real network calls are never fast enough to
trigger (explaining why this specific pattern is rare) but a mocked,
zero-delay `route.fulfill()` can, given `page.click()`'s own resolution
is what's variably delayed under contention, not the round-trip itself.

### Fix — gate the mocked response (test-only, no product code touched)

`test/comment-sheet-behavioral.test.js`'s "deleting a comment rolls back
on a failed delete-comment response" test now holds the mocked
`delete-comment` 500 response behind `test/helpers/settle.js`'s own
`gate()` helper — the exact, already-established remedy this file's own
header comment documents for "a mocked endpoint racing the test's own
drive-to-state" (previously used there for the "abandoned attempt"
tests' fixed-`setTimeout` pattern; applied here as a NEW use of the same
primitive, not a new mechanism). The response cannot be fulfilled until
the test explicitly opens the gate, which it now does only AFTER
confirming the optimistic removal — eliminating the race by
construction rather than by widening an unwindable window. `js/comment-
sheet.js` was not touched; this is purely a test-timing fix for an
assertion sequence that was unsound under load, matching this round's
own "root cause first, no symptom patches" standard (a longer timeout
was considered and rejected — the transient state genuinely cannot recur
once past, so more budget doesn't help, only removing the race does).

**Not touched, flagged for a future pass**: `test/comment-sheet-
behavioral.test.js`'s sibling "posting a comment rolls back on a failed
add-comment response" test already anticipated this exact class of race
(its own comment: "an instantly-resolving mock races the optimistic-
insert assertion... since both happen on the same tick") and works
around it with a fixed `setTimeout(r, 900... 200)` delay instead of a
gate — the same inferior pattern `test/helpers/settle.js`'s own header
comment already argues against ("there is no 'safe' number to raise 900
to; the window is a race by construction"). It has not been observed
failing in any round so far, so left alone this round (one fix at a
time, in scope), but it is latent risk of the identical family and a
good target for the SAME `gate()` treatment next time it's touched.

### Verification

- Isolated, before fix: 16/16 clean (2/2 runs).
- Isolated, after fix: 16/16 clean (2/2 runs).
- **The exact 90-file subset that reproduced the original failure, re-run
  with the fix applied**: the target test passed at the identical test
  index (508) it failed at before; 0 failures in 683/~700 tests reached
  before the run was cut off by this environment's live cross-session
  load (see below) — a direct apples-to-apples comparison against the
  pre-fix reproduction above.
- **The real, fixed test file re-run 3x under the SAME real concurrent
  Chromium contention that reproduced the original failure twice via the
  standalone instrumented script** (`media-library-page.test.js` +
  `wizard-ui-behavioral.test.js` + `social-layer-v2-profile-
  behavioral.test.js` running concurrently): 16/16 clean, 3/3 runs. One
  of these three runs saw an UNRELATED test in the same file
  ("empty composer disables Post...", which this fix does not touch)
  flake once and pass clean on immediate isolated re-run — consistent
  with this repo's already-documented broader theme (other tests in this
  suite still have their own, separate contention sensitivity; out of
  this task's scope, not a regression from this change).
- **A true, complete `npm test` run could not be captured as a single
  tool invocation** in this environment during this investigation — this
  sandbox's per-call tool timeout ceiling (600s) is shorter than a full
  273-file run even under IDEAL conditions (this doc's own "Test tiering"
  section in `docs/TEST_REGISTRY.md` states 15-30 min normally), and was
  further slowed by the confirmed live cross-session contention above.
  Multiple large partial runs (90-580+ files reached per invocation) were
  used instead as the closest available proxy, consistent with round 3's
  own established precedent for exactly this constraint.
- `docs/TEST_REGISTRY.md` not touched — same rationale as round 3's own
  scroll-lock fix: pure test-timing fix, no behavior/coverage change.
