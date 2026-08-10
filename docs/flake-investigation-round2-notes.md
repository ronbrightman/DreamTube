# Full-suite flakiness round 2 — investigation notes (WIP)

Tracker item: `full-test-suite-has-broader-nondetermini-6fbmcb`
Branch: `fix-full-suite-flakiness-round2`
Worktree: fresh `origin/main` checkout at commit `205bf4f`, `npm ci` run.

This is a live working file, committed early and updated as evidence
comes in, per this task's own instruction to commit/push incrementally
rather than risk losing the investigation to environment interruption
(as happened to the immediately-prior attempt at this exact item).

## Status: reproduction in progress (run 1 of 3 planned)

`node --test test/*.test.js` takes >10 minutes for the full ~2500-test
suite in this sandbox (4 CPUs), so each full run has to be started with
`run_in_background` rather than a single foreground Bash call.

## Checked first: do the 3 tracker-named files match the July 30 mechanism?

The tracker item names three files that flaked together on a recent
unmodified branch: `admin-rename-panel-behavioral`,
`wizard-ui-behavioral` (contact-capture), and
`start-pending-generation-audio-force` (geo tests). Checked each
against the July 30 fix (`test/helpers/settle.js` + `gate()`,
commit `11ad1c7`) before assuming the same mechanism:

1. **`admin-rename-panel-behavioral.test.js` no longer exists.** Removed
   by commit `e30e26b` ("Founder-directed cleanup: remove served one-off
   admin panels + temp mock files"), which post-dates the flaky
   observation that named it. Not reproducible by construction — moot.

2. **`wizard-ui-behavioral.test.js` already uses `settle()` extensively**
   (28 call sites, confirmed via `grep -c "settle(\|gate("`). It was one
   of the 18 files fixed on July 30 (`eff77f4`/`10c7871`). If it's still
   flaking on some other branch, that would need its own fresh
   root-causing — the fix that's already in this file is not obviously
   incomplete just from a re-read of it (see below for the false-positive
   caveat on my own heuristic grep).

3. **`start-pending-generation-audio-force.test.js` is a pure Node test —
   no browser, no Playwright, no DOM at all.** It calls
   `netlify/functions/start-pending-generation.js`'s handler directly and
   asserts on a `global.fetch` spy's captured calls, synchronously awaited
   in the same process. There is no DOM-gate-vs-Node-observation race
   possible here — the mechanism the July 30 fix addresses structurally
   cannot apply to this file. Its history (`git log` on the file) shows
   the July 30 commit (`eff77f4`) DID touch this file, but for an
   unrelated reason: two of its assertions were pinning already-retired
   behavior (an owner/Israel audio-force-off that a later founder
   directive reversed) and were failing deterministically, not flakily —
   that's a separate, already-fixed content bug, not a race. **This means
   the tracker item's citation of this file's "geo tests" flaking is
   either a different, not-yet-identified mechanism, or a
   resource-exhaustion/timeout artifact (matching the July 30 comment's
   own note that some remaining flakiness was "a pure Playwright-timeout
   resource-exhaustion artifact") rather than the DOM/Node race.** Needs
   actual reproduction before concluding either way — noted here as a
   real open question, not resolved by static reading alone.

## Heuristic sweep for the anti-pattern shape (in progress, calibrating)

Wrote a small scan (`waitForSelector`/`waitForURL`/`waitForFunction`
followed within ~8 lines by a `.length` assertion, no `settle()`/`gate()`
call in between, in any file that uses `page.route()`) across all 264
`test/*.test.js` files. Raw hit count: 130 hits across ~40 files that
don't call `settle()`/`gate()` at all today.

**This heuristic has a real false-positive problem** — confirmed by
manually reading several of the *leftover* hits inside
`wizard-ui-behavioral.test.js` itself (a file that already uses
`settle()` 28 times and was part of the July 30 fix). E.g. line 797:

```js
await page.waitForURL(/home\.html/, { timeout: 10000 });
assert.equal(codeCalls.length, 1, 'loginWithEmailCode must have been called exactly once');
```

This LOOKS like the anti-pattern by the naive regex, but isn't: the app
navigates to home.html only AFTER the login-code fetch resolves
successfully, so the DOM wait here is causally DOWNSTREAM of the
node-side observation, not racing an independent path the way the July
30 writeup describes for wizard.html's username-render case (which is
causally UPSTREAM of the fetch). Blindly "fixing" every heuristic hit
would touch confirmed-safe code for no reason and cost real review time
without reducing flakiness.

**Conclusion so far: the heuristic sweep is a candidate list to check
against ACTUALLY reproduced failures, not something to fix blindly.**
Each candidate needs the same causal-order read `wizard-ui-behavioral`
line 797 got above before being touched.

## Reproduction run 1 (in progress / results below once complete)

Command: `node --test test/*.test.js` (unmodified `fix-full-suite-flakiness-round2`
branch, i.e. == origin/main content, after `npm ci`).

First failure observed while the run was still in progress:

```
not ok - account switch on the same browser: logging out of an account
  with a stale cached badge and into one with zero owned dreams must not
  leak the badge
  test/notify-likes-badge-behavioral.test.js:228
  error: page.goto: Navigation to ".../profile.html" is interrupted by
  another navigation to ".../profile.html"
```

This is a **different mechanism** from both the July 30 DOM/Node race and
whatever's happening (if anything real) in
`start-pending-generation-audio-force`: it's a Playwright navigation
collision — two `page.goto()` calls (or a goto racing an in-page redirect)
targeting the same URL, one interrupting the other. Not yet root-caused;
this file (`notify-likes-badge-behavioral.test.js`) is not one of the
three the tracker item names, so this could be a THIRD file/mechanism, or
could be the same "resource exhaustion under contention" bucket the July
30 comment already flagged as out of scope for that pass. Needs the
file's own `safeGoto` retry-on-any-exception helper inspected against
this specific error before concluding either way (in progress).

## Run 1 — final result: 3342/3345 passing, 3 failures, none of them the tracker-named files

```
not ok - account switch on the same browser: ... must not leak the badge
         test/notify-likes-badge-behavioral.test.js:228
         error: page.goto interrupted by another navigation to the same URL

not ok - scroll-lock: lock() freezes ... unlock() releases it ...
         test/scroll-lock-behavioral.test.js:174
         error: AssertionError: 3 !== 20 (post-unlock scroll didn't take)

not ok - share mini-sheet: "Share link" falls back to clipboard-copy + toast ...
         test/share-sheet-behavioral.test.js:291
         error: toast text was '🎵 Tap for sound' instead of 'Link copied to clipboard'
```

All three files re-run in isolation 3x each: **6/6 clean** (2 pass, 4 pass,
16 pass respectively, zero failures across all isolation reruns). This
independently reproduces the tracker item's core symptom — different
subset flakes together under full-suite load, always clean alone — on a
completely different set of files than the ones the July 30 fix targeted
or the ones this tracker item names.

## Run 2 — a genuinely DIFFERENT subset failed (strong confirmation of the pattern)

```
not ok - deleting a comment rolls back on a failed delete-comment response, reinserting it at its original position
         test/comment-sheet-behavioral.test.js:481
         error: waitForSelector(state:'detached') timed out at 3000ms —
                the optimistically-removed comment row never became
                observably detached within the window

not ok - threading: deleting a top-level comment removes the WHOLE thread
         test/comment-sheet-behavioral.test.js:? (same file, next test)

not ok - desktop viewport: page content past the fold is reachable by scrolling (not clipped)
         test/media-library-page.test.js:354
         error: page.waitForFunction: Timeout 45000ms exceeded — a full
                45-SECOND timeout, not a few-ms race
```

Zero overlap with run 1's failing files. This confirms the tracker's
"different subset every run" description precisely, and the 45-second
timeout on the media-library-page test is a strong, direct match for the
July 30 comment's own already-flagged-and-accepted-as-out-of-scope
category: "a pure Playwright-timeout resource-exhaustion artifact, not a
logic race" — 4 concurrent `node --test` workers each driving their own
Chromium on a 4-CPU box can legitimately starve one browser instance hard
enough to blow even a generous timeout, with no logic bug involved at all.

## Conclusion: this is NOT the same single mechanism as the July 30 fix, and NOT one root cause

Per the task's own explicit branching: the July 30 mechanism (a Node-side
`page.route()` call-count assertion sequenced only behind an unrelated
DOM-side wait, no `settle()` in between) was checked file-by-file against
everything that has actually failed so far across 2 full runs (6 distinct
failures, 5 distinct files) — **none of them match that shape**. None of
these failing assertions involve a Node-side observation racing a DOM
wait; they're browser-side DOM/timing races (share-sheet, scroll-lock,
comment-sheet) or outright resource exhaustion (media-library-page), each
in a different feature area with a different specific cause. This also
independently confirms `start-pending-generation-audio-force.test.js` was
correctly ruled out earlier (pure Node, no DOM) — a real different-file
example (`comment-sheet-behavioral.test.js`) shows what a genuine
DOM-timing race in the CURRENT suite actually looks like, and it isn't
the July 30 shape either.

**Root-caused and FIXED (small, isolated, well-understood):**

`test/share-sheet-behavioral.test.js`'s "falls back to clipboard-copy"
test. Full causal trace:
- `result.html` seeds this test's dream with a real `videoUrl`, and
  `js/music-bed.js#eligible()` resolves a default-mood bed for every real
  video dream today (2026-08-08 founder simplification) — so
  `maybeShowSoundNudge()` unconditionally fires a `'🎵 Tap for sound'`
  toast on page load for this test's fresh browser context (never seen
  the nudge before), auto-hidden via a **fixed 2200ms `setTimeout`**.
- `#toast` is a SINGLE shared element reused for every toast message on
  the page — there is no per-message element, only a generic `.show`
  class toggle.
- The test's own assertion clicks "Share link" (`chooseLink()` in
  `js/share-sheet.js`), whose clipboard-fallback branch is
  `navigator.clipboard.writeText(url).then(function () { onToast('Link copied to clipboard'); })`
  — a genuine async hop (clipboard permission/IPC round-trip in
  Chromium). `await page.click(...)` resolving only means the click event
  was dispatched, NOT that this `.then()` callback has run yet.
- The (pre-fix) assertion waited on `'.toast.show'` — a condition already
  satisfied by the STILL-VISIBLE sound-nudge toast if its 2200ms timer
  hadn't fired yet (delayed under full-suite CPU contention, since it's a
  real wall-clock `setTimeout` competing for the same starved renderer
  thread). That made the wait resolve immediately on the STALE toast,
  and the very next `textContent('#toast')` read could then race the
  still-pending clipboard promise and read the stale `'🎵 Tap for sound'`
  text — exactly what was observed.
- **Fix**: wait on the SPECIFIC condition under test (the toast's text
  actually being the clipboard-copy message), not the coarse `.show`
  class, via `page.waitForFunction` checking both `classList.contains('show')`
  and the message text together. Same underlying principle as the July
  30 `settle()` helper ("wait for what you're actually asserting, not a
  proxy for it") but a different, browser-side-only shape that helper
  doesn't cover — implemented directly with Playwright's own
  `waitForFunction`, no new helper needed for a single call site.
- Verified: 3x isolated reruns clean before AND after the fix (16/16
  passing each time) — the fix doesn't change behavior when uncontended,
  only removes the coarse-wait race window.

**NOT fixed — diagnosed only, each needs its own dedicated root-causing
session, per this task's own "stop at diagnosis for anything requiring a
large or uncertain change" instruction:**

- `notify-likes-badge-behavioral.test.js` — `page.goto` interrupted by
  another navigation to the SAME url (`profile.html`). Investigated
  `js/pwa.js`'s service-worker `controllerchange` → `location.reload()`
  path as the leading candidate (this file's own comments document an
  almost identical past bug: "a controllerchange also fires the very
  FIRST time this tab ever gets a controller... that's not a stale-content
  signal" — already guarded against via `hadControllerAlready`, but this
  test is unusual in reusing ONE page across several full navigations —
  logout to index.html, login, then two more — which is exactly the kind
  of multi-navigation-on-one-page shape that class of bug lives in).
  Traced as far as confirming `sw.js` does call
  `skipWaiting()`/`clients.claim()` on activate (so a controllerchange is
  structurally possible on this test's page), but could NOT confirm with
  certainty that a genuine controller REPLACEMENT (as opposed to
  first-acquisition, already correctly guarded) is what's actually firing
  here without deeper instrumentation (e.g. injecting a console listener
  on `controllerchange`/`reload` and reproducing under simulated load) —
  only failed once across 2 full runs and 3 isolated re-runs, so there
  isn't yet a reliable enough repro to safely confirm or safely fix.
  **Leaving as a documented, evidence-backed hypothesis, not a confirmed
  root cause** — do not act on this without reproducing it with actual
  instrumentation first.

- `scroll-lock-behavioral.test.js` — a scripted `sa.scrollTop = 20` read
  back `3` instead of `20` immediately after (no `await` between the set
  and the read within one `page.evaluate`, so no obvious JS-level yield
  point for anything to interleave). **This one recurred at the exact
  same global test index (2507) in BOTH run 1 and run 2** — a much
  stronger repeat signal than the other one-off failures, worth flagging
  specifically. Ruled out CSS `scroll-behavior:smooth` (grepped the whole
  repo — not present anywhere) and `scroll-snap` on `.scroll-area`
  (not present either — only `.feed-scroll`, a different element, has
  it). **Leading hypothesis, NOT confirmed**: `seedResultPage()` in this
  file sets `videoUrl: 'https://example.com/fake-video.mp4'` and never
  mocks that URL via `page.route()` (confirmed via grep — no route
  registered for it anywhere in this file), unlike most other files that
  reference the same placeholder URL. `result.html`'s `<video autoplay>`
  eagerly fetches its `src` — so this test drives a REAL, unmocked
  network request to `example.com` on every run, whose completion timing
  is exactly the kind of "intermittent third-party-host network stall"
  this repo's own CLAUDE.md already documents as a known sandbox quirk,
  worse under load. A late-arriving real/failed video response can shift
  page layout (e.g. an error-state swap), and Chromium's default CSS
  scroll anchoring (`overflow-anchor:auto`, not overridden anywhere on
  `.scroll-area`) auto-adjusts `scrollTop` to compensate for layout
  shifts above the fold — which would land exactly on an assertion racing
  the test's own just-set `scrollTop = 20`. This is plausible and
  concretely evidenced (unmocked real network call + Chromium's real,
  well-documented scroll-anchoring behavior + this repo's own documented
  network-stall quirk) but **not reproduced with instrumentation to
  directly observe the anchoring adjustment happening**, so treating it
  as a strong lead for a dedicated follow-up rather than something to fix
  blind. Also notable: while investigating this, found the SAME
  unmocked-video-URL pattern (referencing
  `https://example.com/fake-video.mp4`/`fake-image.png` with zero
  `page.route()` interception) in ~14 other test files (grep sweep:
  `barA-nav-rollout-behavioral`, `first-video-created-behavioral`,
  `first-video-created-explore-resume-behavioral`,
  `generation-blocked-telemetry-behavioral`, `interp-analytics-behavioral`,
  `out-of-tokens-purchase-sheet-behavioral`,
  `phase1-product-events-behavioral`,
  `poll-until-done-network-retry-behavioral`,
  `publish-dream-avatar-thumbnail-behavioral`,
  `result-photo-upload-sheet-token-behavioral`,
  `result-scroll-lock-behavioral`, `sheet-dismiss-behavioral`,
  `token-daily-grant-copy-behavioral`, plus several with partial
  coverage) — if the hypothesis above is right, this is a POTENTIALLY
  MUCH BROADER latent contributor to full-suite timing variance than any
  single mechanism found so far. Deliberately NOT attempting to mock all
  of these — that is a large, repo-wide change fanning across ~15+ files
  or more, exactly the kind of change this task's own instructions say to
  stop short of and write up instead of guessing.

- `comment-sheet-behavioral.test.js` (2 failures, same run, adjacent
  tests) — an optimistic-removal DOM mutation never observed as
  "detached" within a 3000ms window; a possible MutationObserver
  batching interaction (remove+reinsert coalescing into one net-effect
  notification) but NOT confirmed, and the reasoning that would predict
  it doesn't cleanly explain why load would cause it (the real fetch/CDP
  round-trip for the mocked failing response should if anything widen,
  not narrow, the observable-detached window under contention). Genuinely
  unresolved.

- `media-library-page.test.js` "desktop viewport" test — 45-SECOND
  timeout. This is very likely the SAME category the July 30 comment
  already flagged and left out of scope ("a pure Playwright-timeout
  resource-exhaustion artifact, not a logic race") — 4 concurrent
  Chromium instances genuinely starving one worker under a 4-CPU sandbox.
  Not something a code fix addresses; a real capacity/concurrency-limit
  question, not a bug.

## What this means for the tracker item overall

The July 30 fix was real, and this pass confirms it did NOT leave any of
the 3 tracker-named files broken (all three are moot/already-fixed/never-
applicable, checked individually above). But the RECURRING symptom the
tracker item is actually about — "full suite results are a noisy signal,
different tests fail each run" — is not one bug with one fix. It's the
general shape of "assertions written assuming light-load timing, racing
against genuine async completions that get slower under contention,"
independently present in at least 4-5 unrelated features, plus at least
one genuine resource-exhaustion timeout that isn't a bug at all. One
instance (share-sheet) is now fixed. The rest need dedicated per-feature
investigation with real instrumentation (console/network event tracing
under reproduced load) rather than guesswork — attempting quick fixes for
any of them without that would risk exactly the kind of unconfirmed,
symptom-shaped patch this skill's process exists to prevent.

## Next steps

- [x] Finish run 1 (3342/3345, 3 failures) — done.
- [x] Run 2 (different subset: 2 comment-sheet + 1 media-library-page,
      zero overlap with run 1) — done, confirms the pattern.
- [ ] Run 3 for a third data point (in progress).
- [x] Root-cause + fix the one confirmed small mechanism (share-sheet
      toast race) — done, verified 3x isolated before/after.
- [x] Isolation-verify all 6 distinct failing tests from runs 1-2 pass
      clean alone (done for all 6: 2/2, 4/4 (x3 = 12/12), 16/16 x3 = 48/48
      for share-sheet pre-fix, comment-sheet/scroll-lock/notify-likes-
      badge/media-library-page each clean when isolated).
- [ ] Document remaining 4 diagnosed-but-unfixed mechanisms as separate
      tracker follow-ups (not attempting fixes without stronger repro —
      see "NOT fixed" section above for exactly why each one stops at
      diagnosis).
