# Journey Manifest

**This file is the canonical, founder-approved ordered list of every
screen in DreamTube's two entry journeys** — the paid ad funnel and the
organic/direct entry — from first landing through the first video.

## Why this file exists

Tracker item `for-product-pin-the-funnel-journey-as-a--3uawmc` (founder,
2026-07-31), after catching two stale funnel screens himself (characters +
"preparing" transition, removed in `for-product-urgent-founder-screenshots-i-g64gjp`,
commit `d002c83`): *"How come there is no routine check to catch such
things?"* Root gap — tests pin per-change behavior, nothing pinned the
JOURNEY itself, so a stale screen could survive a partial consolidation
invisibly, only ever caught by a founder manually walking the app.

`test/journey-manifest.test.js` extracts the ACTUAL step sequence from
`start.html`'s and `wizard.html`'s own markup (their `SCREEN_RENDERERS`
arrays) and asserts it equals the lists below, by render-function name.
Adding, removing, or reordering a screen in either file breaks that test
until this manifest is deliberately updated to match — the point is to
force a conscious decision, not to prevent change.

## Editing this file

**Changing either ordered list below requires founder or Manager
approval** — same standing rule as any other funnel-journey change (see
`AGENT_POLICY.md`). This file existing at all does not pre-approve a
change to the journey it describes; it only makes an *undeclared* change
impossible to ship silently. When a screen is deliberately added, removed,
or reordered:

1. Get the change approved first (this is unchanged — this file doesn't
   relax that).
2. Update the relevant list below, in the same commit as the code change.
3. Update the "Last reconciled" line at the bottom.

## Journey 1 — Paid ad funnel (dreamtube-growth → this repo → first video)

The ad funnel's own hook/quiz/dream-capture/style-picker screens live in
the **separate `dreamtube-growth` repo** (out of scope for this repo's own
manifest/test — growth tracks its own funnel journey separately per
tracker item `for-product-pin-the-funnel-journey-as-a--3uawmc`'s own
routing). This repo's manifest starts where that funnel hands off, via
`start.html?resume=1&...`.

| # | Screen | File / render function | Notes |
|---|--------|------------------------|-------|
| 1 | Signup (email → password) | `start.html` — `renderScreen13` | Unified email-first screen (tracker item `for-product-signup-screen-the-single-big-bkwhbe`): email verified (format + `check-email.js`'s availability + MX/A/AAAA deliverability check, tracker item `for-product-signup-email-micro-step-foun-ns8uve`) and the real, billed pending-generation call captured BEFORE the password field is ever revealed, so an abandoner is still reachable by the abandoned-signup retention email. |
| 2 | Token intro + confirmation | `start.html` — `renderScreen14` | Formerly "pricing" — now a plain, honest acknowledgment of the signup token grant (no plans, no checkout). Continue completes the funnel. |
| 3 | Home (background generation) | `home.html` | **Lands directly on Home — no dedicated wait screen** (tracker item `for-product-funnel-ending-v2-founder-ins-tfuu0q`, founder GO 2026-07-31 evening, removed `processing.html`/the old step-4 redirect to `result.html`). The pending job started at step 1 (or a fresh generation, if that call failed) continues in the background; the My-dreams row's first tile shows a generating state, the Chamber is enterable immediately off the dream's text, and a toast + real thumbnail replace it on completion. Tapping the finished tile opens the dream's own room (`result.html`), which is no longer an automatic journey step. |

Record-it branch (mode=record, ad-funnel-only — the organic wizard has no
Record-it option): step 2's Continue redirects to `create.html?record=1`
instead of `home.html` (no dream text exists yet to poll for).

**Extracted/asserted array:** `start.html`'s `SCREEN_RENDERERS = [renderScreen13, renderScreen14]`.

## Journey 2 — Organic / direct entry (index.html → first video)

> **⚠️ SUPERSEDED 2026-08-14 (unify-all-creation-flows, founder-directed).** The
> three drifting creation flows (this repo's `wizard.html` + `create.html`, and
> the `dreamtube-growth` funnel) are collapsed into ONE flow: the `/go/`
> funnel. **`index.html`'s "Get Started" now routes organic visitors to
> `/go/?utm_source=organic` (the same-origin proxy to the growth funnel), NOT
> `wizard.html`** — reversing the 2026-07-26 decision below.
>
> **`wizard.html`'s own chip-first creation UI is now RETIRED to a
> funnel-arrival receiver.** An ANONYMOUS bare/direct hit to `wizard.html` (no
> `?resume=1`) **redirects to `/go/?utm_source=organic`** (the funnel); a
> SIGNED-IN bare hit goes to **`create.html`** (the logged-in creator, unchanged
> — it already shares the same content classifier). Either way the six-tile
> chooser and the Subject/Action/Style/FreeText/Recap chip-build steps (rows
> 0.5–5 below) are no longer reachable by any real user. The ONLY live path
> through `wizard.html` now is the growth-funnel handoff
> (`?resume=1&caption=...`), which lands DIRECTLY on the signup wall (row 6) with
> its pre-email content gate, PostHog identity stitch, Meta cookie persistence,
> and funnel-character-stash adoption intact. **Rows 0.5–5 are RETAINED-BUT-DEAD
> markup**, kept only so `SCREEN_RENDERERS`' positional indices (and therefore
> the wall's own `wizard_step_viewed {step:7}` analytics, progress dots, and Back
> navigation) stay byte-stable — deleting them from the array would shift the
> wall's live instrumentation. The table below is kept as the record of that
> retired flow; the live journeys for a real user are now:
> **(a) organic + ads →** `/go/` funnel → (`?resume=1&caption=`) →
> `wizard.html` **row 6 (wall)** → **row 7 (Home)**;
> **(b) logged-in creation →** `create.html` (UNCHANGED — the founder's decision
> 2026-08-14 was to KEEP logged-in creation on `create.html` since it already
> uses the shared classifier; the bottom-nav "+", Home Tonight CTA,
> "Make another", chamber "Begin", etc. all still point at `create.html`).

Founder decision 2026-07-26 (`for-product-route-organic-direct-visitor-olu8md`,
**superseded 2026-08-14 — see the note above**):
organic/direct visitors enter dream creation through `wizard.html` (a
lighter, chip-first, pre-signup dream builder purpose-built for this
entry), not `start.html`. `wizard.html` and `start.html` are two
DELIBERATELY separate implementations (founder decision 2026-07-24,
`for-product-funnel-is-getting-its-own-co-pihldm`) — this is approved
drift for the PRE-signup steps, not a bug.

| # | Screen | File / render function | Notes |
|---|--------|------------------------|-------|
| 0 | Welcome | `index.html` | Dark "night" theme (this repo's shared token language — home.html's palette). "Get Started" → `wizard.html`. |
| 0.5 | Question-first screen 1 (fresh entries only) | `wizard.html` — `showQuestionFirst` (a pre-step, deliberately NOT in `SCREEN_RENDERERS`) | "What was your dream about?" — a six-tile grid (🕊️ Flying / 🏃 Being chased / 👤 Someone specific / 🏞️ A place / 🌀 Something surreal / ✍️ I'll describe it) over a STATIC 2×2 store-image collage hero (no video, no "surprise me", no beta footnote), mirroring the growth funnel's finalized question-first entry. Replaced the old build/write/speak mode chooser: the six tiles ARE the mode choice and each SEEDS the wizard — the four scenario tiles seed the Action and skip the What step (→ Who → Style → …); "Someone specific" opens the who-detail character sheet on the Subject step (Action still asked); "I'll describe it" is write mode (→ step 4 free text). Speak-it is preserved as a secondary link (→ `create.html?record=1` via its login gate, hidden in FB/IG webviews). Shown only to fresh entries (`?entry=index` or direct) — never to Facebook return legs or `?resume=1` arrivals. Fires `wizard_entry_mode_chosen {mode, surface:'wizard', tile}` only — no `wizard_step_viewed`, so existing step numbering below is untouched. |
| 1 | Subject (Who) | `wizard.html` — `renderSubject` | "Who was in the dream?" (Layout-B copy) — multi-select; tapping Me selects it AND opens the character sheet in self mode (describe + photo upload, Cancel keeps Me selected with no details — founder round 8 + the 08-04 details-optional ruling); "Someone I know" rows keep their inline optional detail input. |
| 2 | Action (What) | `wizard.html` — `renderAction` | "What was happening?" — required, no skip. Skipped when a scenario tile already seeded it (see 0.5). Setting ("Where") was REMOVED as a question by the question-first trim — the place is now inferred per action (`WizardChips.inferFallbackPlaceKey`) and baked into the caption, exactly as a skipped Setting step always fell back. |
| 3 | Style | `wizard.html` — `renderStyleStep` | Layout-B pill rows (replaced the embedded style-card grid on this wizard only), auto-advances on pick. Mood ("How did it feel") was REMOVED as a question by the question-first trim — the mood/lighting is inferred (default dreamy + hazy-ethereal) into the caption; the stored `dream.mood` is null (visual-style music bed), the same as a declined mood. |
| 4 | Free text | `wizard.html` — `renderFreeText` | Optional escape hatch — and Write mode's landing step (see 0.5). |
| 5 | Recap (editable) | `wizard.html` — `renderRecap` | "Here's your dream — make it yours" — the editable dream text (pencil affordance, "Edit anything before we bring it to life.", "Looks good →" CTA) on its OWN screen before the wall (founder round 8, restoring the approved mock's structure). Fires the sanctioned `wizard_recap_viewed {}` instead of a renumbered `wizard_step_viewed` — every RETAINED step keeps its historical step value (Subject `step:1`, Action `step:3`, Style `step:5`, Free text `step:6`, wall `step:7`; the removed Setting `step:2` and Mood `step:4` simply no longer fire), see `wizard.html`'s `STEP_ANALYTICS`. |
| 6 | Signup wall (hybrid, screen-13 parity) | `wizard.html` — `renderSignupWall` | ONE merged screen replacing the former Contact-capture + username/password Signup pair (founder order, tracker item `for-product-wizard-signup-wall-is-the-ol-lt1l9j`): the forming-veil "your dream is forming" indicator and a single passwordless email field — the same wall `start.html`'s live screen 13 uses. Email deliverability-checked (`check-email.js`), then the real, billed pending-generation call fires in parallel with `DreamStore.signupPasswordless` — BEFORE any account exists; an already-registered email resolves via the same enter-the-code step as screen 13. Success claims + adopts the running job. |
| 7 | Home (background generation) | `home.html` | **Lands directly on Home — no dedicated wait screen** (tracker item `for-product-funnel-ending-v2-founder-ins-tfuu0q`, removed `processing.html`/the old redirect to `result.html`). Resumes the adopted job in the background — same Home-lands-with-a-generating-tile experience as journey 1's step 3. |

**Extracted/asserted array:** `wizard.html`'s `SCREEN_RENDERERS = [renderSubject, renderAction, renderStyleStep, renderFreeText, renderRecap, renderSignupWall]`.

## Known, flagged difference between the two journeys (not silently decided)

Journey 1 (ad funnel) shows a dedicated **token intro + confirmation**
screen (`renderScreen14`) between Signup and landing on Home. Journey 2
(organic) has no equivalent dedicated screen — `wizard.html`'s signup
wall (`renderSignupWall`) redirects straight to `home.html` on success.

This is a **real, felt difference** ("I hit different pages") the founder
noticed directly, not a stale-screen bug — `wizard.html` never had
`start.html`'s former stale characters/"preparing" screens to remove in
the first place (it's a separate, always-lighter implementation, approved
2026-07-24). Flagged here rather than silently patched: whether Journey 2
should gain an equivalent confirmation screen (matching step count with
Journey 1) or Journey 1's screen 14 should instead be folded away (matching
Journey 2's leaner shape) is a product-shape call for the founder/Manager,
not a bug fix — left open pending that decision.

## Last reconciled

2026-07-31 evening, alongside tracker item
`for-product-funnel-ending-v2-founder-ins-tfuu0q` (founder GO the same
evening): removed `processing.html` and its wait-screen step from both
journeys — both now land directly on `home.html`, which shows the
in-progress generation itself rather than a dedicated polling screen.
`test/journey-manifest.test.js`'s own asserted `SCREEN_RENDERERS` arrays
were UNCHANGED by this — both only ever covered the PRE-signup step
sequence, never the post-signup redirect target, so this was a real,
deliberate journey change that didn't need that test's expected arrays
touched (see this file's own header on why the test still exists to
catch a step being silently added/removed/reordered from those arrays,
just not this specific change).

Earlier reconciliation: 2026-07-31 (daytime), alongside tracker items
`for-product-realign-index-html-organic-w-lzbmfu`,
`for-product-pin-the-funnel-journey-as-a--3uawmc`, and
`for-product-signup-email-micro-step-foun-ns8uve`. Verified against
`start.html`/`wizard.html` on branch
`organic-path-realign-journey-manifest-email-capture`.
