# Interpretation Wave 1 — Method-First Interactive Interpretation
Design agent, 2026-07-29. Build-ready product spec + two visual/UX directions.

Inputs: `interpretation-research.md`, `interpretation-evaluation.md` (same directory);
codebase at `/home/user/DreamTube` (result.html interp pill + sheet, `netlify/functions/interpret-dream.js`,
`js/store.js` getInterpretation/generateInterpretation, `css/styles.css` sheet/style-card/chip patterns,
`js/wizard-chips.js`, `js/analytics-config.js`, `AGENT_POLICY.md`).

**Founder decisions honored (2026-07-29, verbatim where quoted):**
- Method first: "first user needs to choose Method I think. Then the interpreter asks the questions
  as that avatar and probably also according to what matters in this method."
- Named 'inspired-by' personas approved ("persona naming- not a real threat I think"):
  Jung / Freud / Gestalt / The Scientist / Talmudic.
- Pricing/gating deferred ("lets think about that later... not to be determined now") — wave 1 is free,
  unlimited, same as today. No token UI anywhere on this surface.
- Text-first. No TTS/avatar video in wave 1 (Speaking Sage is a later gated wave), but persona cards
  with faces/illustrations from day one, architected so voice/avatar slots in without redesign.
- **Entry point / placement: OUT OF SCOPE (founder amendment 2026-07-29).** Founder has a homepage
  plan coming and will decide where this lives. This spec designs the experience as a fully
  self-contained surface keyed by a dream id, mountable from anywhere (see §8).

---

## 1. Product summary

Replace the single blended "Your reflection" with a three-step, method-first interpretation
experience on any saved dream:

1. **Pick a method** — five persona cards (illustrated faces), each an AI character
   "inspired by" a real interpretive tradition.
2. **Answer 1–3 clarifying questions** — asked *in that persona's voice*, about *what that
   method cares about*. Every question skippable; a persistent "Just interpret it" escape
   jumps straight to the reading. Never a gate.
3. **Receive the reading** — 150–220 words, method-true, in-persona, weaving the user's
   answers in. From the reading: get another method's take on the same dream (unlimited),
   regenerate, or close.

Why this shape wins (research-verified): "scary accurate" is manufactured by anchoring the
reading to the user's waking life via clarifying questions (Rosebud's 2–3 adaptive follow-ups,
Oniri's "contextual questions", Dreamly's best-in-category reviews) — not by the symbol system.
Method personas are the differentiation (no competitor ships named-method lenses; DreamOn's
Scientific/Symbolic dual-mode is the closest precedent) and the future monetization surface.

## 2. The five personas (data, not code — §5)

All five are **AI characters inspired by published methods, not the real people**. Picker
carries a one-line footer: "AI characters inspired by real methods — for reflection, not advice."
Freud persona inherits the existing hard ban on sexualized readings (present system prompt keeps it).

| key | Display name | Card tagline | "Asks about" (founder-specified question focus) | Voice notes |
|---|---|---|---|---|
| `jung` | **The Depth Analyst** — inspired by Carl Jung | "Your dream is a message from your deeper self." | Your current life situation; what feels unbalanced (compensation) | Warm, symbolic, archetypes/shadow, mythic but grounded |
| `freud` | **The Analyst** — inspired by Sigmund Freud | "Every dream hides a wish." | First associations to the dream's key elements (free association) | Incisive, wry, provocative-but-kind; NO sexualized readings |
| `gestalt` | **The Mirror** — inspired by Fritz Perls (Gestalt) | "Everything in the dream is you." | Pick one element of the dream and speak *as* it | Present-tense, experiential, gently challenging |
| `scientist` | **The Scientist** — grounded in modern dream research | "Dreams rehearse what your mind is working on." | Current waking concerns and stressors (continuity hypothesis) | Plain, evidence-flavored, zero mysticism; cites ideas not papers |
| `talmudic` | **The Sage** — inspired by the Talmudic tradition | "A dream follows its interpretation — let's turn yours toward the good." | Your life context; then the reading always turns toward the good (hatavat chalom) | Gentle, blessing-like, hopeful; respectful, never kitsch, no religious rulings |

Display-name pattern: original archetypal name + explicit "inspired by" attribution — the
research's recommended level-2/level-3 blend (named tradition, stylized original character,
zero photoreal likeness). Swappable per-market because personas are pure data.

## 3. Step-by-step flow (all states)

State machine (one surface, five phases): `picker → q_loading → questions → r_loading → reading`,
plus error/fallback branches. The surface is opened for exactly one dream (`dreamId` param).

### 3.0 Open
- Input: a dream id whose record has `storyText || caption` (same source the current
  `generateInterpretation` POSTs — human dream text, never promptText).
- If the dream already has ≥1 saved interpretation: open on **reading** phase showing the most
  recent one (persona header + text), with "Another take" leading to the picker — mirrors
  today's revisit-without-network behavior. Otherwise open on **picker**.

### 3.1 Picker (no network; persona data is local)
- Title: "Who should read this dream?"
- Five persona cards (portrait, name, tagline, one-line "Asks about: …"). Personas the user
  already got a reading from on THIS dream show a small ✓ badge ("Read" state) — tapping one
  reopens its saved reading (no network) with a Regenerate affordance.
- Footer microcopy: "AI characters inspired by real methods — for reflection, not advice."
- Tap a card → phase `q_loading` for that persona.
- Empty state: none possible (static data). Error state: none.

### 3.2 Questions loading (`q_loading`)
- Persona header appears (small portrait + name + "inspired by…" microcopy) and persists from
  here on — this header is the future avatar/voice slot (§9).
- Loading line, persona-flavored from data (e.g. "The Depth Analyst is considering your dream…"),
  reusing the existing `.spinner-inline` row pattern.
- Network: `POST interpret-dream` `{ caption, personaKey, mode:"questions" }` → `{ questions:[…] }`
  (§6). Target < 4s.
- **Failure fallback (hard rule: questions are never a gate):** on any error (network, 5xx,
  invalid/unparseable questions) → skip silently to `r_loading` with `qa: []` (a direct reading).
  No error screen exists for this phase. Fire `interp_questions_failed` for visibility.
- 429 rate-limited is the one exception: show the friendly limit message (§3.5).

### 3.3 Questions (1–3, one at a time — slot-filling stepper/chat)
For each question `i`:
- Question text in the persona's voice (`dir="auto"`).
- Answer affordances, all three always present:
  1. **2–4 suggested-answer chips** (LLM-generated with the question; tap = answer). Chips are
     the primary mobile path — paid-traffic users are in the FB/IG webview where typing is friction.
  2. **Free-text field** (single-line growable, `dir="auto"`, maxlength 280) + send.
  3. **"Skip" quiet link** — answer recorded as skipped, advance.
- Progress: subtle "1 of 3" dots. Advancing is instant/local — no network between questions.
- **Persistent "Just interpret it →" link** (visible throughout the questions phase): jumps to
  `r_loading` immediately with whatever answers exist so far. Founder-required, non-negotiable.
- After the last question (or Just-interpret-it) → `r_loading`.
- Back behavior: a back affordance from questions returns to picker (answers for that persona
  discarded); sheet/page dismissal rules in §8.

### 3.4 Reading loading (`r_loading`)
- Persona header + persona-flavored loading line ("Weaving your answers into the reading…" /
  persona-specific variant from data).
- Network: `POST interpret-dream` `{ caption, personaKey, mode:"reading", qa:[…] }`
  → `{ interpretation }`.

### 3.5 Reading (`reading`)
- Persona header (portrait + name + "inspired by …").
- Reading text — existing `.interp-text` styling (`dir="auto"`, pre-wrap).
- Trust/privacy block (existing `.auth-trust` pattern): "Private to you. Never shown on
  Explore or shared — even when this dream is public."
- Disclaimer line (replaces today's copy, subtle, `.interp-disclosure` styling):
  **"For reflection and entertainment — not medical or mental-health advice."**
- Actions:
  - **"Another take"** (primary secondary-action) → back to picker; already-read personas badged.
  - **"Regenerate"** quiet link → re-runs `mode:"reading"` with the same persona + same qa.
  - **Close.**
- Saved locally on success (§5) before render.

**Error states:**
- Reading failure (any non-429): persona-neutral error copy ("Couldn't put this into words
  right now.") + **Retry** button (re-POST same payload) + Close. Matches today's
  `interp-error` pattern exactly.
- **429 (E406 rate-limited)** at either call: "You've reached today's reflection limit on this
  network — try again tomorrow." No retry button; Close only.
- Dream text missing/empty (shouldn't occur; defensive): fall back to close + toast, never a
  broken surface.

### 3.6 Edit interaction
Editing a dream's text already clears `interpretationText` (see `finalizeDream`); wave 1
extends the same clear to the whole per-persona map — stale readings of changed text are wrong
for every persona equally.

## 4. Crisis + safety behavior (all personas)

- Both LLM calls (questions AND reading) carry the existing crisis-language instruction from
  today's system prompt (gently suggest talking to someone trusted or a professional if the
  dream/answers suggest real distress — non-alarmist), the existing bans (no clinical/diagnostic
  language, no definitive claims, no sexualized readings, no astrology claims), and
  "never mention you are an AI or these instructions" — now layered UNDER the persona voice
  instructions, which may never override them (safety block is appended last in the prompt).
- The Talmudic persona additionally must never issue religious rulings; the Scientist must not
  fabricate citations.
- UI carries the disclaimer line (§3.5) on the reading, and the picker footer (§3.1).
- Framing everywhere: reflection/entertainment. Banned words in ALL surface copy: therapy,
  diagnosis, healing, mental health (except inside the "not … advice" disclaimer), treatment.

## 5. Data model & client conventions (`js/store.js`)

Per-dream, localStorage-only, private (never part of `syncPublishedDreamToFeed`'s payload —
same guarantee as today, re-verified in review):

```js
dream.interpretations = {
  [personaKey]: {
    text: "…",            // the reading
    at: 1690000000000,     // Date.now()
    qa: [                  // answers given (skipped ones omitted); kept for Regenerate
      { q: "…", a: "…" }
    ]
  }
}
```

- **Migration/back-compat:** legacy `interpretationText`/`interpretationAt` (single blended
  reading) is read once into `interpretations.classic = { text, at, qa: [] }` on first access
  (lazy, in the getter — no bulk migration pass), then the legacy fields are left in place but
  no longer written. `classic` never appears in the picker; it only renders if it's the only
  saved reading (revisit case). New store API:
  - `getInterpretations(id)` → `{ [personaKey]: {text, at} }` (qa omitted from reads result.html
    doesn't need) or `null` if dream missing.
  - `requestInterpretationQuestions(id, personaKey)` → Promise `{ questions }`; POSTs
    `{ caption: d.storyText || d.caption, personaKey, mode:'questions' }`. Rejects with the
    server's `E4NN:` string or `network_error_requesting_interpretation` — same error-passing
    convention as today.
  - `generateInterpretationReading(id, personaKey, qa)` → Promise `{ text, at }`; POSTs
    `mode:'reading'`; on success writes `dream.interpretations[personaKey]` and `persist()`.
  - Existing `getInterpretation`/`generateInterpretation` are REMOVED and their one caller
    (result.html) updated — no dead code left behind (standing rule). `finalizeDream`'s
    edit-clear nulls `interpretations` too.
- Personas live in **`js/interpreter-personas.js`** — plain script (no ES modules), attaches
  `window.InterpreterPersonas`, UMD-lite `module.exports` guard so
  `netlify/functions/interpret-dream.js` can `require()` the SAME file (single source of truth —
  exact pattern of `js/analytics-config.js` / `wizard-chips.js`). Schema per persona:

```js
{
  key: 'jung',
  name: 'The Depth Analyst',
  inspiredBy: 'inspired by Carl Jung',
  tagline: 'Your dream is a message from your deeper self.',
  asksAbout: 'your current life, and what feels unbalanced',
  accent: '#8b7ec8',                     // per-persona accent color (cards, chips, header)
  portrait: 'assets/interpreters/jung.webp',
  loadingQuestions: 'The Depth Analyst is considering your dream…',
  loadingReading: 'Weaving your answers into the reading…',
  voice: '…system-prompt paragraph: persona voice/tone…',
  method: '…system-prompt paragraph: the interpretive moves of this method…',
  questionFocus: '…system-prompt paragraph: what to ask 1–3 questions about…',
  maxQuestions: 3
}
```

Server uses `voice`/`method`/`questionFocus`/`maxQuestions`; client uses the display fields.
Adding/removing/renaming a persona = editing this one file (persona-agnostic architecture,
the evaluation's "cheapest insurance").

## 6. API (`netlify/functions/interpret-dream.js` — extend, don't fork)

One function, one rate-limit scope (`interpret-ip`, 40/day/IP unchanged — a full flow is 2
calls, so ~20 flows/day/IP; both modes count), same fal.ai OpenRouter passthrough
(`fal.run/openrouter/router/openai/v1/chat/completions`, `FAL_KEY`, no new vendor/secret),
same sync `fal.run` variant (both calls are short text completions), same `openai/gpt-4o-mini`.

Request/response contract:

```
POST { caption, personaKey, mode: "questions" }
  → 200 { questions: [ { id, text, chips: ["…", …] }, …1–3 items ] }

POST { caption, personaKey, mode: "reading", qa: [ { q, a }, … ] }   // qa may be []
  → 200 { interpretation: "…" }

POST { caption }            // legacy shape, no personaKey/mode
  → 200 { interpretation }  // unchanged blended behavior (kept until result.html migrates in
                            // the same branch; then the legacy branch is DELETED — no dead code)
```

- `mode:"questions"` call: system prompt = persona voice + method + questionFocus + safety
  block; instructed to return STRICT JSON `{"questions":[{"text":"…","chips":["…"]}]}` with
  1–`maxQuestions` questions, each ≤140 chars, 2–4 chips each ≤40 chars, questions in the
  persona's voice, about the method's focus, answerable by a layperson in one line.
  `temperature 0.8, max_tokens 400`. Server parses (tolerating a fenced code block), validates
  shape/lengths, assigns `id`s (`q1`…), strips empties. Invalid/unparseable → `502 E407`-class
  error — the client's silent fallback (§3.2) handles it; never retried server-side.
- `mode:"reading"` call: system prompt = persona voice + method + safety block + "150–220 words,
  second person, weave the dreamer's answers in naturally where given (never quote them back
  mechanically), method-true, end with one short in-persona closing line." User message carries
  the dream text + the qa pairs (or "The dreamer chose not to answer questions" when empty).
  `temperature 0.9, max_tokens 500`. Existing `MIN_VALID_LENGTH`-style guard kept.
- Validation errors: unknown `personaKey` → 400 (new code `E408 unknown_persona`); unknown
  `mode` with a personaKey present → 400 (`E409 invalid_mode`); existing E401–E407 unchanged.
  Error-code comment block extended — same convention.
- Cost: 2 gpt-4o-mini calls/flow ≈ well under $0.01. No new spend approval needed.

## 7. Analytics (PostHog via each page's existing `track()` helper — neutral names only)

This also lands evaluation item J (instrument interpretation) for the new surface. Event names
are deliberately neutral (`interp_*`, never health-flavored — the ad pixel shares the domain):

| Event | Props |
|---|---|
| `interp_surface_opened` | `{ has_existing: bool }` |
| `interp_persona_selected` | `{ persona }` |
| `interp_questions_shown` | `{ persona, count }` |
| `interp_question_answered` | `{ persona, index, via: 'chip'\|'text'\|'skip' }` |
| `interp_skipped_to_reading` | `{ persona, answered }` |
| `interp_questions_failed` | `{ persona }` (silent-fallback fired) |
| `interp_reading_shown` | `{ persona, answered, regenerated: bool }` |
| `interp_reading_failed` | `{ persona, rate_limited: bool }` |
| `interp_another_take` | `{ from_persona }` |
| `interp_closed` | `{ phase }` |

No Meta Pixel/CAPI events for interpretation — it stays entirely off the ad-conversion surface.

## 8. Self-contained mounting (because placement is founder-pending)

The whole experience is built as **one self-contained unit keyed by `dreamId`**, with zero
assumptions about its host page:
- All markup lives in one root element; all logic in one init function
  `InterpretExperience.open(dreamId)` / `.close()` (plain script attaching one global, matching
  `purchase-sheet.js` — the codebase's existing precedent for a complex shared sheet component).
- CSS in `css/styles.css` under one prefixed block (`.itp-*`).
- Wave 1 mounts it on `result.html` only as a *temporary* host (replacing the current interp
  sheet internals — the pill's tap handler just calls `InterpretExperience.open(dream.id)`),
  but nothing binds it there: when the founder's homepage plan lands, any page can include the
  scripts and call `open(id)`. Direction B additionally works as a standalone page
  (`interpret.html?dream=<id>`) if the homepage plan prefers a link target — see §10.

**OUT OF SCOPE — founder-pending (do not build, do not decide):** where this lives on
result.html long-term, homepage integration, navigation/discovery, any new entry points, deep
links from pushes/emails. The result.html hookup above is plumbing continuity only (the pill
already exists and must not dead-end), not a placement decision.

## 9. Forward-compatibility for the Speaking Sage (later wave — design now, build later)

- The persistent **persona header** (portrait + name) is the future avatar/voice slot: portrait
  becomes an animated/speaking portrait, a play/audio control mounts beside the name. Both
  directions keep this header structurally identical so no redesign is needed.
- `interpretations[personaKey]` can later grow `audioUrl`/`videoUrl` fields without migration.
- Persona data schema already carries per-persona identity (accent, portrait) that a voice id
  (`voiceId`) can join later.
- Pricing/gating hooks: none in wave 1 (founder-deferred). The "Another take" tap is the natural
  future gate point; nothing in wave 1's UI hard-codes "free" anywhere, so adding a token pill
  later is additive.

## 10. Out of scope (wave 1)

- **Entry points / placement / homepage integration** — founder-pending (§8).
- **Pricing, gating, tokens** — founder-deferred explicitly.
- **TTS, avatar video, lip-sync** (Speaking Sage wave), pre-rendered persona clips.
- Open-ended free chat beyond the 1–3 structured questions (no unbounded chat loop in wave 1).
- Sharing/exporting readings; any feed/Explore exposure (readings stay private-only).
- Server-side persistence of dreams/readings (localStorage-only stands; known deferred project).
- Culturally-localized lenses (Ibn Sirin, Zhougong) — double-gated per evaluation.
- Interpretation→video bridge (idea F) — separate item, not smuggled in here.
- Editing the dream from inside this surface.

## 11. Build checklist (files touched)

- `js/interpreter-personas.js` — NEW (personas as data, UMD-lite).
- `netlify/functions/interpret-dream.js` — extend (modes, persona prompts, E408/E409, JSON
  question parsing/validation); delete legacy branch once result.html migrates.
- `js/store.js` — `interpretations` map + 3 new methods, remove 2 old ones, extend
  finalizeDream's edit-clear, lazy legacy migration.
- `css/styles.css` — `.itp-*` block (reuses `.sheet*`, `.style-card` visual language, chip
  styling, `.interp-text`/`.interp-disclosure`/`.auth-trust` as bases).
- `result.html` — pill handler → `InterpretExperience.open()`; old sheet internals removed.
- `js/interpret-experience.js` — NEW (the surface itself; name per direction chosen).
- `test/` — unit tests for persona data validity + server question-JSON validation (node,
  matching `wizard-chips.test.js` style); GENERATION_MOCK_MODE-equivalent not needed (LLM calls
  are cheap; use real calls sparingly or stub fetch).
- Portrait assets — see §12.

## 12. Open items the build agent cannot determine alone

1. **Persona portrait assets.** Five stylized illustrated portraits (NOT photoreal, NOT
   likenesses of the real Jung/Freud/Perls — original characters with era/mood flavor), one
   visual family, ~512px, committed under `assets/interpreters/`. Recommended production path:
   generate via the existing flux/schnell pipeline (~$0.02 total, within normal testing budget)
   with a shared style prompt, then **founder eyeballs the five faces** (creative direction —
   escalation gate (a)). Build should ship with a graceful fallback (accent-gradient +
   initial) so the branch never blocks on asset approval.
2. **Which direction (A/B below)** — founder decision, escalation gate (a).
3. **Reading length/model**: spec says gpt-4o-mini, 150–220 words; if founder wants noticeably
   richer readings, a frontier-class model is still ≈$0.05–0.10/reading — flag, don't switch
   unilaterally.
4. Exact persona display names/taglines are proposals — founder may rename on mock review;
   they're data-file edits either way.

---

# The two visual/UX directions (founder picks — gate (a))

Both directions implement the identical spec above (same states, API, data, analytics, safety).
They differ only in the surface's form.

## Direction A — "The Reading Table" (layered bottom sheet)

**Grounded in:** DreamTube's own established `.sheet-overlay` bottom-sheet language (the
app-wide pattern per styles.css) + the psychic/tarot-app **advisor-picker row** (Purple Ocean /
Tarot-app "choose your reader" card rows) + **Google-style quick-reply chips / slot-filling**
conversational forms (the dominant 2026 mobile chatbot pattern for structured Q&A without a
full chat transcript).

**Layout & interaction:**
- Everything happens inside ONE bottom sheet (the existing `.sheet` on the host page), phases
  swapped in place exactly like today's loading/ready/error swap — familiar, cheap, dismissal
  via the already-wired `SheetDismiss` pattern.
- **Picker:** sheet title "Who should read this dream?" over a **horizontally snap-scrolling
  row of five persona cards** (~118×150px), each reusing the `.style-card` visual grammar the
  app already trained users on (portrait fills card, bottom gradient scrim, name over it,
  ✓ badge = already read). One line of the selected card's tagline + "Asks about…" shows under
  the row as you scroll (carousel caption). Tap = select and advance.
- **Questions:** compact persona header (28px round portrait + name + "inspired by…" micro-line)
  pins at the sheet top; below it the current question renders as a short persona speech line,
  then answer chips (wrap, 2–4), a slim free-text field, "Skip" quiet link; "1 of 3" dots and
  the persistent "Just interpret it →" quiet link sit at the sheet's bottom edge. One question
  at a time; answering swaps the question in place (slot-filling stepper, not a transcript).
- **Reading:** same pinned persona header; reading text scrolls within the sheet (88dvh cap
  already handles long content); trust + disclaimer + "Another take" / "Regenerate" / Close.

**Tradeoff vs Direction B:** smallest possible build on the app's most battle-tested pattern —
fastest to ship, feels native to the existing product, zero new navigation, and trivially
mountable on any page (it's just a sheet). The cost: less immersion and less character
presence — the persona is a header, not a presence; the Q&A reads as a smart form rather than
a conversation; and the sheet's height budget leaves less room for the Speaking Sage wave to
grow into (an animated speaking portrait inside a bottom sheet will always feel like a widget,
not an encounter).

## Direction B — "The Interpreter's Chamber" (full-screen conversational takeover)

**Grounded in:** **Character.AI's 1-on-1 persona chat** (avatar-anchored conversation with a
designed character — the mainstream, 3+-years-proven pattern for talking to a named persona)
+ **Rosebud's interactive guided-reflection mode** (AI asks 2–3 adaptive follow-ups as chat
turns) + full-width **carousel character-select** (Character.AI discovery / game character-select
convention).

**Layout & interaction:**
- A **full-screen overlay** (or standalone `interpret.html?dream=<id>` — works as both; same
  component), dark immersive background derived from the app's existing result-screen
  aesthetic, top bar with back/close.
- **Picker:** full-width **swipeable persona carousel** — one card ≈72vw, large portrait
  (~50% of card), name, "inspired by…", tagline, "Asks about: …", page dots, per-persona accent
  glow; a fixed **"Begin with [name]"** button confirms (two-tap select — browsing is the point
  here; the five characters ARE the feature's shop window).
- **Questions + reading as a chat transcript:** persona portrait + name pinned in the top bar
  (the avatar/voice slot); a brief typing indicator, then each question arrives as a
  persona-accented chat bubble; chips render under the latest bubble; the user's answer
  (chip or typed) appears as a right-aligned user bubble; "Just interpret it →" sits persistently
  above the composer. The final reading arrives as a **distinct reading card** in the
  transcript — bordered with the persona accent, larger type — followed by trust + disclaimer
  lines and "Another take" / "Regenerate" as in-transcript actions. The whole session reads
  back as a conversation the user can scroll.
- Revisit opens straight to the saved reading card with its persona in the top bar.

**Tradeoff vs Direction A:** maximum character presence and differentiation — this is the
version that makes the personas feel like the flagship the founder described, produces a
conversation (which is what Rosebud/Character.AI prove users sink time into), and gives the
Speaking Sage wave a natural home (the top-bar portrait animates and speaks; audio messages
drop into the transcript — zero redesign). The cost: roughly 2× Direction A's build surface
(new full-screen surface, transcript scroll/keyboard management in the FB/IG webview — a known
risk area per the mobile-smoke-test rule), and it introduces a second surface language beside
the app's sheet-everywhere convention, so it must be executed well or it will feel like a
different app stapled on.

**Compressed recommendation framing (not a decision):** A = the fast native step that ships the
method-first mechanic this week and can be promoted into B later; B = the destination
experience that pre-builds the avatar wave's home now. Both are honest implementations of the
approved feature; the founder's homepage plan may itself favor one (a sheet mounts inside any
page; a chamber can be a linked destination) — worth choosing with that plan in view.
