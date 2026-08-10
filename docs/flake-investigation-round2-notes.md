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

## Next steps (not yet done as of this commit)

- [ ] Finish run 1, capture the full list of `not ok` failures.
- [ ] Run 2 and run 3, same unmodified branch, to get the "different
      subset each time, clean in isolation" signature the tracker item
      describes (not just a single flaky file).
- [ ] For every file that actually failed (not just heuristic-matched),
      re-run in isolation to confirm it passes clean alone.
- [ ] For each confirmed-flaky file, read the specific failing
      assertion's causal ordering (as done above for the false-positive
      wizard-ui-behavioral case) before deciding it's the same mechanism.
- [ ] Only then decide: apply `settle()`/`gate()` to genuinely-confirmed
      same-mechanism cases, or write up a distinct root cause for
      anything that isn't that shape.
