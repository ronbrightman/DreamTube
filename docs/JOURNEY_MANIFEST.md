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
| 1 | Signup (email → password) | `start.html` — `renderScreen13` | Unified email-first screen (tracker item `for-product-signup-screen-the-single-big-bkwhbe`): email verified (format + `check-email.js`'s availability + MX/A/AAAA deliverability check, tracker item `for-product-signup-email-micro-step-foun-ns8uve`) and the real, billed pending-generation call captured BEFORE the password field is ever revealed, so an abandoner is still reachable by the abandoned-signup retention email. Facebook Login is additive on this same screen (not a separate screen). |
| 2 | Token intro + confirmation | `start.html` — `renderScreen14` | Formerly "pricing" — now a plain, honest acknowledgment of the signup token grant (no plans, no checkout). Continue completes the funnel. |
| 3 | Generation polling | `processing.html` | Resumes the pending job started at step 1 if it succeeded; falls back to a fresh generation otherwise. |
| 4 | First video | `result.html` | End of journey. |

Record-it branch (mode=record, ad-funnel-only — the organic wizard has no
Record-it option): step 2's Continue redirects to `create.html?record=1`
instead of `processing.html` (no dream text exists yet to poll for).

**Extracted/asserted array:** `start.html`'s `SCREEN_RENDERERS = [renderScreen13, renderScreen14]`.

## Journey 2 — Organic / direct entry (index.html → first video)

Founder decision 2026-07-26 (`for-product-route-organic-direct-visitor-olu8md`):
organic/direct visitors enter dream creation through `wizard.html` (a
lighter, chip-first, pre-signup dream builder purpose-built for this
entry), not `start.html`. `wizard.html` and `start.html` are two
DELIBERATELY separate implementations (founder decision 2026-07-24,
`for-product-funnel-is-getting-its-own-co-pihldm`) — this is approved
drift for the PRE-signup steps, not a bug.

| # | Screen | File / render function | Notes |
|---|--------|------------------------|-------|
| 0 | Welcome | `index.html` | Dark "night" theme (this repo's shared token language — home.html's palette). "Get Started" → `wizard.html`. |
| 1 | Subject | `wizard.html` — `renderSubject` | "Who's the dream about?" — reuses the character sheet. |
| 2 | Setting | `wizard.html` — `renderSetting` | "Where does it take place?" |
| 3 | Action | `wizard.html` — `renderAction` | "What's happening?" — required, no skip. |
| 4 | Mood | `wizard.html` — `renderMood` | "What's the mood?" |
| 5 | Style | `wizard.html` — `renderStyleStep` | Reuses style.html's style cards. |
| 6 | Free text | `wizard.html` — `renderFreeText` | Optional escape hatch. |
| 7 | Contact capture | `wizard.html` — `renderContact` | Email verified (format + `check-email.js`'s availability + deliverability check) and the real, billed pending-generation call captured here, BEFORE Signup — same "verify → capture → reveal" ordering as journey 1's step 1, just on its own dedicated screen instead of a DOM swap within one screen. |
| 8 | Signup (username + password) | `wizard.html` — `renderSignup` | Adopts the already-running generation job on success. |
| 9 | Generation polling | `processing.html` | Resumes the adopted job. |
| 10 | First video | `result.html` | End of journey. |

**Extracted/asserted array:** `wizard.html`'s `SCREEN_RENDERERS = [renderSubject, renderSetting, renderAction, renderMood, renderStyleStep, renderFreeText, renderContact, renderSignup]`.

## Known, flagged difference between the two journeys (not silently decided)

Journey 1 (ad funnel) shows a dedicated **token intro + confirmation**
screen (`renderScreen14`) between Signup and generation polling. Journey 2
(organic) has no equivalent dedicated screen — `wizard.html`'s own Signup
screen (`renderSignup`) folds the same core fact ("220 tokens on signup,
no card needed") into one line of that screen's own copy, then redirects
straight to `processing.html`.

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

2026-07-31, alongside tracker items `for-product-realign-index-html-organic-w-lzbmfu`,
`for-product-pin-the-funnel-journey-as-a--3uawmc`, and
`for-product-signup-email-micro-step-foun-ns8uve`. Verified against
`start.html`/`wizard.html` on branch
`organic-path-realign-journey-manifest-email-capture`.
