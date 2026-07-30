# DreamTube — Edit-a-Dream Mechanism: Product Spec + Design Directions

Tracker: `for-product-new-edit-mechanism-founder-i-qmsdgj` (priority:
high, founder-approved direction — not from-scratch ideation)

## 0. Grounding: what's actually in the code today

- **`result.html`**'s existing edit sheet (`#sheet-edit-overlay`) is a
  *mini wizard re-walk*: a caption textarea (`#edit-text`), a 4-option
  style grid (Cartoon/Cinematic/Anime/Realistic), an advanced section
  (characters/camera/scenery chips), a feature-toggle row, and a single
  `#edit-generate-again` primary button plus `#edit-cancel`. This is the
  thing being replaced as the *default* path — not deleted.
- **`js/store.js`**'s `finalizeDream(mediaUrl, caption, style,
  sourceDreamId, mediaType, operationName, storyText)` already tracks two
  separate fields per dream: `promptText` (the full engineered string
  actually sent to the model) and `storyText` (the human-readable,
  first-person description). This split is exactly what makes prompt
  realignment tractable — the LLM edit-merge step should operate on
  `promptText` (what the model needs) while regenerating `storyText` too
  (what the user reads back), rather than trying to diff a single
  blended string.
- **`generate-video.js`** wires exactly one model for the standard path
  today: `FAL_MODEL_TEXT_TO_VIDEO` env var, defaulting to
  `fal-ai/veo3.1/lite`. Reference-to-video and image-to-video are
  separately hardcoded to `fal-ai/veo3.1/fast/...` variants. **No
  PixVerse integration and no per-generation `modelUsed` field exist** —
  both are new in this spec.
- **`rewrite-dream-story.js`** and **`interpret-dream.js`** are the
  existing precedent for LLM calls in this codebase: both call
  `openai/gpt-4o-mini` through fal.ai's own OpenRouter passthrough
  (`https://fal.run/openrouter/router/openai/v1/chat/completions`), same
  auth (`Authorization: Key <FAL_KEY>`), same request shape (system+user
  messages, temperature, max_tokens), same error handling (checks both
  OpenAI-style `data.error` and fal's `data.detail`). **The new
  edit-merge LLM call should be a new function built on this exact same
  pattern** — no new vendor, no new auth scheme, nothing for the build
  agent to improvise.
- **Voice input** already exists in `create.html`'s "Record it" flow:
  `getUserMedia({audio:true})` → `MediaRecorder` → base64 blob → POST
  `/.netlify/functions/transcribe-audio` → poll
  `/.netlify/functions/transcribe-status` (2.5s interval, 90s timeout) →
  editable transcript textarea. The edit sheet's mic button reuses this
  exact chain, not a new one.
- **Cost**: `entitlements.js` confirms **100 tokens = one video
  generation, uniformly for a new generation, an edit/regenerate, or a
  style change** — already the same cost. Point 4 (unchanged pricing)
  requires no code change at all; just don't introduce a new price tier.
- **Analytics naming**: `docs/EVENT_TAXONOMY.md` shows snake_case,
  verb/state-based custom events routed through PostHog (`video_created`,
  `video_published`, `first_video_created`, `like_given`/`like_received`)
  vs. PascalCase Meta standard events. `edit_started`, `edit_submitted`,
  `model_used` all already fit this convention as given — no renaming
  needed.
- **Design tokens** (`css/styles.css`): pure black/white app
  (`--bg-app:#000`, `--surface:#1a1a1a`, `--accent:#fff`,
  `--danger:#FF3040`), Manrope throughout, pill buttons
  (`radius:100px`), 26px-radius bottom sheets sliding up from
  `translateY(100%)` with a `.32,.72,0,1` cubic-bezier — a deliberately
  quiet, monochrome, native-app-like sheet system. Any new UI should look
  like it was always part of this sheet, not a bolted-on new component.

## 1. Research: how successful apps stage "refine this result" (point 3)

Dominant shape across every current example researched: **a
conversational, single-instruction refinement loop that keeps the
previous result's context intact, rather than a form re-walk.**
Specifically:

- **Midjourney Remix + Vary Region** — Remix Mode lets a user edit
  *only the prompt text* (or region) while keeping the rest of the
  generation's parameters/composition; "Vary controls **where** an edit
  lands, Remix controls **what** the edit is." The user never re-answers
  the full original brief — they state the delta, and the system
  re-composes around it. ([Midjourney docs](https://docs.midjourney.com/hc/en-us/articles/32799074515213-Remix),
  [Vary Region](https://docs.midjourney.com/hc/en-us/articles/32794723105549-Vary-Region))
- **ChatGPT image editing** — has moved explicitly from "regenerate a
  new image" to a **conversational editor**: "select Edit to describe
  your changes in the conversation panel... instead of regenerating a
  whole new image each time, you can keep the layout and style, then ask
  for precise edits." This is the single-question, plain-text delta
  pattern almost verbatim. ([OpenAI Help Center](https://help.openai.com/en/articles/11084440-images-in-chatgpt))
- **Runway "Modify Video"** — re-renders an existing clip with a new
  instruction "while preserving motion" rather than restarting from a
  blank prompt; Aleph does small targeted edits (sky, lighting,
  background) "without regenerating from scratch." ([AI-Mindset cheatsheet](https://www.ai-mindset.ai/runway-cheatsheet))
- **Pika**, by contrast, has no dedicated "modify" flow of its own
  comparable weight — it leans on fast full regeneration rather than
  delta-editing. Notable as the counter-example: it confirms
  delta-editing is the differentiator these other tools built
  deliberately, not something every generator has by default.

**Conclusion:** copy the Midjourney/ChatGPT shape exactly — one
plain-text delta question, prior result's parameters held constant
except what the delta addresses, no re-walk of the original brief. This
directly matches the founder's own framing.

## 2. Model rotation (point 2) — verified

**Confirmed**: fal.ai hosts `fal-ai/pixverse/v6/text-to-video`. At 720p,
no audio, 8s duration (matching DreamTube's current default): **$0.045/s
× 8s = $0.36** — exactly the price point the founder named. Compare to
today's default: `fal-ai/veo3.1/lite` at 720p/audio-off/8s = **$0.24**.
PixVerse V6 is ~50% more per edit than the Lite default, but nowhere near
Kling-class pricing — comfortably a "comparable-cost" rotation partner,
not a silent upgrade to a premium model. **No Kling routing anywhere in
this mechanism, ever, without a separate explicit founder cost
approval — hard gate, matching the founder's own words.**

**Rotation rule**:
- New field on the dream record: `modelUsed` (`"veo3.1-lite"` |
  `"pixverse-v6"`), stamped on every generation, original or edited.
- Default edit rule: **alternate** — if `modelUsed` on the dream being
  edited is `veo3.1-lite`, route the edit to `pixverse-v6`, and vice
  versa. A dream edited twice ping-pongs, never repeats the model it
  just tried.
- **Anime-style override**: if the dream's `style === "Anime"`, route
  the edit to `pixverse-v6` specifically. **Caveat, stated plainly
  rather than smuggled in as fact**: no internal DreamTube document
  confirms this by style — `FOUNDER_PRINCIPLES.md`'s only internal model
  eval (the veo3.1/lite decision) predates PixVerse integration entirely
  and isn't broken out by style. This override is a reasonable
  industry-informed hypothesis, not a verified internal finding — watch
  it via the kept/published-rate instrumentation (§3.5), cut by style ×
  model, so it either earns its keep with real data or gets removed.
- Reference-to-video and image-to-video paths (both hardcoded to Fast
  variants, no Lite/PixVerse equivalent exists yet) are **out of scope
  for rotation this wave** — an edit on one of those simply reuses the
  same model.

## 3. Product spec

### 3.1 Entry point

On `result.html`, replace the current `#open-edit-sheet` behavior (which
opens the full mini-wizard sheet) so it opens a new, single-question
sheet by default. The existing sheet's full controls are **not
deleted** — they move behind a secondary link inside the new sheet
(§4.1).

### 3.2 Flow — step by step

1. User taps "Edit" on a finished result (existing entry point, same
   button, same location — no new button needed).
2. New edit sheet opens asking: *"What would you like to change?"* — an
   empty, focused textarea plus a mic button (reusing `create.html`'s
   existing `getUserMedia` → `MediaRecorder` → `transcribe-audio`/
   `transcribe-status` chain verbatim).
3. User types or records a delta (e.g. "make it daytime instead of
   night, and add my dog flying next to me"). Recording reuses the exact
   same recording/reviewing/transcribing/text-review states already
   built for `create.html`.
4. User taps "Apply this change." Client-side: `edit_started` fires the
   moment the sheet opens (not on submit); `edit_submitted` fires here,
   with the delta text's character length only (never the raw text
   itself — per `EVENT_TAXONOMY.md`'s own stated rule).
5. Token check (unchanged mechanism, same `regenerateAgainCost()`/
   `tokensBlockGeneration()` calls already wired today): if insufficient
   tokens, show the existing `PurchaseSheet` exactly as today.
6. Server-side realignment call (new function, e.g.
   `netlify/functions/realign-dream-prompt.js`, built on
   `rewrite-dream-story.js`'s exact LLM-call pattern): sends the dream's
   current `promptText`, current `storyText`, and the user's delta text
   to `openai/gpt-4o-mini` via fal's OpenRouter passthrough. Returns a
   new `promptText` and a new `storyText`, both keeping everything the
   delta didn't mention stable (§3.4 for the exact system prompt and a
   worked example).
7. Model rotation applied (§2) — the regeneration call to
   `generate-video.js` is stamped with the rotated model, not the
   dream's original one.
8. Regeneration proceeds exactly like today's "Generate Again" — same
   `processing.html` polling flow, same `finalizeDream()` call, now also
   writing `modelUsed` on the resulting dream record.
9. Result replaces the prior video on `result.html`. `model_used` fires
   alongside `video_created` with the rotated model's identifier.
10. Satisfaction proxy: the existing `video_published` event, cut
    specifically for dreams where the most recent action before publish
    was an edit — the instrumentation point per §3.5, not a new event.

### 3.3 Edge cases

| Case | Behavior |
|---|---|
| Empty state | Sheet opens with textarea empty, cursor focused, placeholder: *"e.g. make it daytime, add my dog flying next to me"*. "Apply this change" disabled until non-whitespace input or a confirmed transcript. |
| Loading (realignment) | Textarea becomes read-only, button label changes to "Realigning your dream…" before advancing to processing — one continuous state, not two spinners. |
| Loading (regeneration) | Identical to today's existing `processing.html` polling UI. |
| Realignment LLM failure | Fall back to naive concatenation merge (`promptText + ". " + delta`) rather than blocking the user — log a silent-skip telemetry event. No token charged yet at this point. |
| Generation failure (after tokens spent) | Identical to today's existing refund handling (`tokens_refunded`). |
| Mic permission denied / in-app-webview block | Reuses `create.html`'s existing exact copy and fallback panel verbatim. |
| User wants the full re-walk instead | "Start over instead" link opens the *existing* full mini-wizard sheet, unchanged — satisfies point 1's requirement that the full path stays available, demoted to secondary. |
| Delta references something never in the original dream | Out of scope for correction logic this wave — the LLM does its best with the delta as literal instruction. |

### 3.4 Data / API needs

**New/changed fields on a dream record** (`js/store.js` dream object):
- `modelUsed: "veo3.1-lite" | "pixverse-v6"` — stamped on every
  generation (new field, backfilled as `null`/unknown for pre-existing
  dreams, not retroactively guessed).
- `editHistory` (optional, lightweight): an array of `{ deltaLength,
  timestamp, modelUsed }` per edit — no raw delta text stored
  server-side beyond what's needed to power the LLM call in-flight.

**New Netlify function**: `realign-dream-prompt.js`
- Input: `{ promptText, storyText, deltaText }`
- Same call shape as `rewrite-dream-story.js`: `openai/gpt-4o-mini` via
  `https://fal.run/openrouter/router/openai/v1/chat/completions`,
  `Authorization: Key <FAL_KEY>`.
- **System prompt**: "You edit an AI-video-generation prompt based on a
  user's requested change. You will be given the CURRENT prompt (a list
  of visual/technical keywords for a video model), the CURRENT story (a
  first-person, human-readable one-to-two sentence description of the
  same dream), and a CHANGE the user wants. Produce an UPDATED prompt and
  an UPDATED story that apply ONLY the requested change and leave every
  other detail — setting, subject, mood, camera style, time of day, and
  anything else not mentioned in the change — exactly as it was. Do not
  invent new details beyond what the change requires. Respond as JSON:
  `{"promptText": "...", "storyText": "..."}`."
- User message template: `Current prompt: ${promptText}\nCurrent story:
  ${storyText}\nChange: ${deltaText}`
- `temperature: 0.5` (lower than `rewrite-dream-story.js`'s 0.8 — a
  constrained edit task, not a creative rewrite), `max_tokens: 200`.
- Response validated the same way as the existing two functions (JSON
  parse check, minimum length check on both fields).

**Worked example** (real sample text, not lorem ipsum):

| | |
|---|---|
| **Original `promptText`** | "Cinematic aerial POV shot, dreamer gliding through a night sky above a golden-lit city skyline, streetlights twinkling below, gentle wind motion in hair, warm golden-hour glow transitioning to night, smooth continuous flight camera movement, sense of freedom and wonder, photorealistic lighting, 16:9, no text overlays." |
| **Original `storyText`** | "I'm flying over a golden city at night, gliding past twinkling lights, feeling completely free." |
| **User's delta** | "Make it daytime instead of night, and add my dog flying right next to me." |
| **Realigned `promptText`** | "Cinematic aerial POV shot, dreamer gliding through a bright daytime sky above a golden-lit city skyline, a dog flying right alongside the dreamer, sunlight glinting off skyscraper windows below, gentle wind motion in hair and fur, smooth continuous flight camera movement, sense of freedom and wonder, photorealistic lighting, 16:9, no text overlays." |
| **Realigned `storyText`** | "I'm flying over a golden city in daylight, gliding past the skyscrapers with my dog flying right beside me, feeling completely free." |

Everything not mentioned in the delta is held stable — only night→day
and the added dog changed.

### 3.5 Instrumentation

- `edit_started` — fires when the new edit sheet opens.
- `edit_submitted` — properties: `{ deltaLength: <int>, dreamId }` —
  never raw delta text.
- `model_used` — fires alongside the existing `video_created` event.
  Properties: `{ modelUsed: "veo3.1-lite" | "pixverse-v6", wasEdit:
  bool }`.
- Satisfaction proxy — not a new event: the existing `video_published`
  rate, segmented by `wasEdit`, plus a "kept" proxy (no further
  edit/regenerate within the session). Computed from existing events cut
  by the new `model_used` property.

### 3.6 Explicitly out of scope this wave

- Any pricing change to edits (stays at 100 tokens, unchanged).
- Any vendor beyond fal.ai-hosted models (no PixVerse direct account, no
  Kling, no new vendor of any kind).
- Rotation logic for reference-to-video/image-to-video paths.
- Region-specific/inpainting-style edits — whole-dream delta only.
- Multi-turn conversational back-and-forth as a distinct follow-up UI.
- Confirmation-before-generate UI (Direction B below) — proposed as an
  option, not committed to either way.

## 4. Design directions (founder picks)

Both directions reuse `result.html`'s existing bottom-sheet system
verbatim: `.sheet-overlay`/`.sheet` classes, `26px 26px 0 0` radius,
black `#1a1a1a` surface, white text, Manrope, pill `.btn-primary`
(white bg/black text), `.32,.72,0,1` slide-up easing.

### Direction A — "Fast conversational edit" (ChatGPT/Midjourney-Remix)

One question, one tap, model swap invisible — matches the founder's own
words most literally, matches how none of the researched apps expose
backend model routing to the end user. Mic icon reuses `create.html`'s
existing record/review/transcribe states embedded in the same textarea.
"Apply this change" → token check → "Realigning your dream…" (label
change, no separate screen) → hands off to existing `processing.html`.
"Start over instead" opens today's existing full mini-wizard sheet
unchanged.

**Tradeoff:** fastest possible loop. No human-visible checkpoint between
typing a delta and tokens being spent — if the LLM realignment misreads
the delta, the user only discovers the miss after paying the same 100
tokens and waiting for a full generation (same risk as today's blind
"Generate Again," not worse, not improved either).

### Direction B — "Confirm-before-generate" (Runway Modify / Vary Region)

Step 1 identical to Direction A. Step 2, inserted before token/
regeneration: shows the realigned `storyText` (never the raw
`promptText`) read-only, in the app's existing quoted-caption display
style, with "Generate this · 100 tokens" as the commit button and "Edit
again" going back to step 1 with the delta preserved.

**Tradeoff:** catches a wrong LLM realignment before tokens are spent —
directly protects against Direction A's accepted failure mode. Costs one
extra screen/tap, and shows the user AI-written text about their own
dream, a small trust-and-tone risk Direction A avoids entirely.

### Recommendation

Direction A is the closer match to the founder's own literal words and
to the strongest reference pattern (ChatGPT never shows an intermediate
confirm step either). Direction B is the safer bet if the LLM-merge
quality turns out shakier in practice than the worked example above —
worth prototyping A first and only adding B's checkpoint if real edit
sessions show a meaningful miss rate.

## 5. Build checklist

- `result.html` — new default edit sheet (Direction A or B), "Start over
  instead" link to the existing full sheet
- `netlify/functions/realign-dream-prompt.js` — new
- `netlify/functions/generate-video.js` — add `fal-ai/pixverse/v6/
  text-to-video` as a second model option, rotation logic, `modelUsed`
  stamping
- `js/store.js` — `modelUsed`/`editHistory` fields, wiring the new edit
  flow's calls
- `create.html`'s mic/record component — reused, not duplicated (extract
  if not already reusable as-is)
- `test/` — coverage for the realign call, rotation logic, edge cases
  above

---

*Design pass 2026-07-30, for tracker item
for-product-new-edit-mechanism-founder-i-qmsdgj. Research sources cited
inline (§1). Two open founder decisions before build starts: §4's
Direction A vs B, and confirming the anime-style PixVerse override
(§2) is acceptable as a testable hypothesis rather than a verified fact.*
