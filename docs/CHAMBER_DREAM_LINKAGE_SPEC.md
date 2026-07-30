# Interpreter's Chamber — Dream-Linkage Clarity Spec

Design pass, 2026-07-30, for tracker item
`for-product-chamber-dream-linkage-is-unc-00s2dr` (founder, priority
high). Extends `docs/INTERPRETATION_WAVE1_SPEC.md`.

**Founder's own words (verbatim):** "how is the interpretation linked to
a specific dream so is it always the last one and what happens if I want
to get an interpretation for previous Dream so the connection here is not
clear."

**Status:** two directions proposed, mockup rendered
(`chamber_mockup.html`, published to Ron as an Artifact) — founder to
pick before build starts, per his own explicit "mock-review before ship
if the layout changes materially" ask on this item.

---

## 0. Freshness check

Grounded against the real, current `origin/main` (fetched directly from
GitHub, not a stale local checkout — this exact staleness bit an earlier
pass on this feature): `result.html`'s own comment confirms the old
`home.html` Chamber-card deep-link via `?openInterp=1` is GONE, superseded
by Interpretation Wave 1's `InterpretExperience.open()`. `profile.html`
was last touched 2026-07-29, before the Chamber shipped — it does not yet
load `interpreter-personas.js`/`interpret-experience.js` and has zero
Chamber awareness today.

## 1. Current, real code

- **`js/interpret-experience.js`** — `renderTopbar()` runs every phase.
  During `picker` phase specifically, the topbar renders an empty flex
  spacer + close button — **literally no dream information shown
  anywhere in the Chamber today.** This is exactly the gap the founder
  flagged.
- **`open(dreamId)`** already accepts an arbitrary dream id, validates via
  `DreamStore.getDream()`, and fully re-initializes `session` —
  **no changes needed to this function itself** to support switching.
- **`home.html`'s `renderChamberCard()`** — the one-tap latest-dream
  default. Not touched by this spec at all.
- **`home.html`'s `renderMyDreamsCard()`** — 3 recent thumbnails, each a
  plain `<a href="result.html?id=...">`, zero Chamber awareness today.
- **`profile.html`'s `vcard` grid** — same gap, plus missing the two
  Chamber `<script>` tags entirely.

## 2. Research — real products, named and specific

Per the standing "copy proven solutions, don't invent" rule:

| App | Pattern found | Source |
|---|---|---|
| **Rosebud** (AI journal, founder-named) | Reverse-chronological entry feed; "Insights" tab lists past analyzed entries, tap to open/re-analyze | [rosebud.app](https://www.rosebud.app/), [Fast Company](https://www.fastcompany.com/91167593/rosebud-ai-journaling-app-writing-partner) |
| **Oniri** (dream journal, founder-named) | Explicit List view / Calendar view toggle + search, for picking which dream to open | [oniri.io/dream-journal](https://www.oniri.io/dream-journal) |
| **Daylio** (mood diary, mainstream comparator) | Timeline (list) + Calendar view, same "reverse-chronological list, tap to open" shape at scale | [daylio.net](https://daylio.net/) |
| **Apple Journal** (native iOS default) | Scrollable reverse-chronological entry list, filter/search | [Apple Support](https://support.apple.com/guide/iphone/view-and-search-journal-entries-iph6257be047/ios) |

**Dominant pattern:** a reverse-chronological list of entries (thumbnail
+ date, most recent first), opened from a dedicated affordance — not a
carousel, not a dropdown. This also matches DreamTube's own existing
`.sheet-overlay` bottom-sheet component, so the switcher reuses an
already-built piece, not a new one.

## 3. Product spec

**Flow:** Home Chamber card (unchanged, one-tap latest dream) → Chamber
opens with a new persistent current-dream indicator, visible every phase
→ tap it → bottom sheet (`.sheet-overlay`, reused) lists completed
dreams, newest first, current one checked → tap a different dream →
`InterpretExperience.open(newDreamId)` — the exact same function used
everywhere else, no new interpretation-flow logic needed.

**My Dreams gallery** (`home.html` + `profile.html`) gets a secondary
deep-link into the Chamber for that specific dream (mechanism differs by
direction, §4).

**Edge cases:**
- Only one completed dream exists → hide/disable the change-dream
  control (nothing to switch to).
- Dream fetch fails on switch → reuse `open()`'s existing toast + no-op,
  no new error UI.
- Mid-`questions` answers discarded on switch — matches existing
  close/reopen behavior, not a new inconsistency.
- Dream thumbnails in the switcher reuse the exact 3-way media fallback
  (video → image → gradient) `renderMyDreamsCard()` already has.

**Data/API:** none new server-side. Reuses `DreamStore.getMyDreams()`,
`getDream()`, `getInterpretations()` as-is.

**New analytics** (neutral, matching existing `interp_*` convention):
`interp_dream_switcher_opened`, `interp_dream_switched` `{from_dream_id,
to_dream_id}`, `interp_gallery_deep_link_tapped` `{source}`.

**Out of scope this pass:** search/filter inside the switcher (graduate
to once dream volume justifies it), calendar view, any change to
`result.html`'s existing pill or the Home Chamber card's routing.

## 4. Two directions (founder picks — mockup rendered, see live link)

Both share the switcher sheet itself. They differ in how the current-
dream indicator sits in the topbar, and how the gallery deep-links.

### Direction A — "Persistent Dream Strip" (recommended)

New row directly under `.itp-topbar`, present in every phase: thumbnail
(36×36) + title/date + "Change ⌄", full-row tap target, hairline top
border. Switcher opens on tap. Gallery gets an additive corner badge
("✨" pill) on each thumbnail — reusing `profile.html`'s existing
multi-badge thumbnail convention — that deep-links into the Chamber
without changing the thumbnail's existing primary tap-to-`result.html`
behavior.

**Grounded in:** Oniri/Apple Journal's list (the sheet), `profile.html`'s
own existing badge-stacking convention (the gallery badge).

**Tradeoff:** ~40-50px of new permanent chrome on every Chamber screen
(a real, material layout change — hence the mock-review ask). In
exchange: the dream is always legible with real text, and the gallery's
existing behavior has zero regression risk.

### Direction B — "Topbar-Integrated Chip"

No new row — a small chip folds into the existing topbar, replacing the
picker phase's empty spacer. Same switcher sheet on tap. Gallery's
primary tap target *becomes* `InterpretExperience.open()` (mirroring the
Home Chamber card's own mechanism verbatim), with a small icon retained
for the old `result.html` path.

**Grounded in:** reusing the Home Chamber card's own already-shipped
open-on-click mechanism verbatim.

**Tradeoff:** during `questions`/`reading` phases, four elements now
compete in one ~36px row (back, chip, persona name+attribution, close).
The persona attribution is the first thing squeezed out — undercutting
the founder's actual ask ("always know which dream") in exactly the
phases where it matters most. Also changes an existing, relied-on
gallery behavior (thumbnail → result.html) to a new default, a bigger
behavioral change than Direction A's purely additive badge.

### Recommendation

Direction A. Costs more chrome height, but delivers the stated goal
without ambiguity in any phase and changes zero existing gallery
behavior. Direction B is cheaper to build but trades away clarity in the
reading phase specifically, and changes an existing behavior rather than
adding a new one.

## 5. Build checklist

- `js/interpret-experience.js` — new dream-indicator render function
  (wired into `render()`, every phase) + switcher-sheet render function
- `home.html` — `renderMyDreamsCard()` gains the deep-link badge/tap
  (direction-dependent); `renderChamberCard()` untouched
- `profile.html` — add the two Chamber `<script>` tags; `vcard` grid
  gains the same deep-link treatment
- `css/styles.css` — new `.itp-dream-strip`/`.itp-dream-chip` rules,
  matching existing `.itp-*` visual language
- `test/` — coverage for switch-dream flow, gallery deep-link, edge
  cases above

---

*Design pass 2026-07-30. Mockup rendered as a live Artifact
(chamber_mockup.html) for founder mock-review, per this item's own
explicit ask. Research sources cited inline (§2).*
