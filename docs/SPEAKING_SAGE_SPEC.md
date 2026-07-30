# Speaking Sage — Voice/Audio Wave for the Interpreter's Chamber
Design agent, 2026-07-30. Build-ready spec, extending
`docs/INTERPRETATION_WAVE1_SPEC.md` (§9's forward-compat slot). Two
distinct UX directions for §3/§4 below — founder picks (escalation gate
(a), `AGENT_POLICY.md`).

**Status:** approved scope, not a from-scratch idea — tracker item
`for-product-build-speaking-sage-wave-fou-8uobuh`, founder "Go." This
spec exists because `AGENT_POLICY.md`'s standing rule requires a design
pass before build on any substantial new user-facing feature; the scope
itself (TTS on readings + one-time lip-synced intro clips, per the brief)
is not up for re-litigation here — only the concrete UX mechanics are.

**Codebase-freshness note for whoever builds this:** this spec was
written against the REAL, current `main` (fetched directly from GitHub —
`js/interpret-experience.js`, `js/interpreter-personas.js`,
`css/styles.css`'s `.itp-*` rules, and the actual `docs/
INTERPRETATION_WAVE1_SPEC.md`), not a stale local checkout. If a build
agent's own local working tree still shows only the old single-persona
`result.html` sheet and no `js/interpret-experience.js`, its clone is
behind `origin/main` and needs a fresh pull before touching this feature
— building against the stale copy would silently fork the Chamber.

---

## 1. What's already there (read directly, not assumed)

- **`js/interpret-experience.js`** — `InterpretExperience.open(dreamId)` /
  `.close()` / `.ensureMounted()` mounts a full-screen overlay
  (`.itp-overlay`, `z-index:80`, `#050505` background; centered
  480px-wide "phone" card on ≥560px viewports) directly over whatever page
  called it (`home.html`'s Chamber card, today).
- **Persistent top-bar** (`.itp-topbar`): back button, `.itp-portrait`
  (circular persona portrait), `.itp-topbar-persona-name`,
  `.itp-topbar-persona-sub` (the "inspired by…" microcopy), close button.
  This is the exact forward-compat slot named in Wave 1 §9 — Speaking Sage
  plugs into it, no new header component.
- **Five personas**, `js/interpreter-personas.js`, `window
  .InterpreterPersonas` (also `require()`-able server-side, single source
  of truth): `jung` (The Depth Analyst, `#8b7ec8`), `freud` (The Analyst,
  `#c97a5a`), `gestalt` (The Mirror, `#5fa89f`), `scientist` (The
  Scientist, `#5b8fd4`), `talmudic` (The Sage, `#c9a15a`) — each with
  `portrait` (a `.webp` asset), `voice`/`method`/`questionFocus` system-
  prompt fields, `maxQuestions`.
- **`dream.interpretations[personaKey] = { text, at, qa }`** —
  localStorage-only, private, never synced to the shared feed (Wave 1 §5).
- **`interp_*` PostHog-only events** already live (`interp_surface_opened`,
  `interp_persona_selected`, `interp_questions_shown`,
  `interp_question_answered`, `interp_skipped_to_reading`,
  `interp_questions_failed`, `interp_reading_shown`,
  `interp_reading_failed`, `interp_another_take`, `interp_closed`) — all
  neutral names, no Meta Pixel/CAPI, matching Wave 1 §7 exactly.
- **`.spinner-inline`** (existing loading-spinner class, reused
  everywhere in the app) and **`Icons.play`/`Icons.pause`/
  `Icons.volumeOn`/`Icons.volumeMuted`** (`js/icons.js`) already exist —
  no new icon needs designing for this wave.
- **`FAL_KEY`** already provisioned; the submit-then-poll pattern
  (`generate-video.js`/`video-status.js`, `transcribe-audio.js`/
  `transcribe-status.js`) is this codebase's established convention for
  any fal.ai call that isn't a short synchronous text completion.

## 2. Research — real products this spec copies from, named and specific

Per the standing "copy proven solutions, don't invent" rule, three current
products were researched for exactly the four things this brief asks
about (autoplay convention, caption/transcript sync, scrub controls,
"speaking" visual state):

1. **Character.AI's "Character Calls"** (real-time voice-call mode,
   launched 2024, still the current live pattern as of this research —
   [TechCrunch](https://techcrunch.com/2024/06/27/character-ai-now-allows-users-to-talk-with-avatars-over-calls),
   [CX Today](https://cxtoday.com/conversational-ai/look-whos-talking-character-ai-launches-two-way-avatar-conversation-feature)):
   the call is explicitly **tap-to-start** (a real user gesture opens the
   call), the 2D avatar **animates while speaking** (mouth/expression
   motion, not just a static glow), there is **no scrub bar or seek
   control at all**, and interruption is handled via an explicit **"tap
   to interrupt"** affordance rather than a pause button. This is the
   pattern behind Direction 2 below (§3.2).
2. **Calm's guided-session player** ([IXD@Pratt design critique](https://ixd.prattsi.org/2018/01/design-critique-calm-ios-app/),
   [Usability Geek case study](https://usabilitygeek.com/ux-case-study-calm-mobile-app/)):
   deliberately minimal — **play/pause and stop only**, a **progress ring**
   instead of a scrubber, and **no fast-forward** (15s-only rewind) by
   deliberate design choice to discourage skipping through narrated
   content. Directly analogous to a Sage's reading: a short, authored,
   one-shot narration, not a track you'd want to scrub through mid-way.
   This is the pattern behind Direction 1 below (§3.1).
3. **Spotify's auto-generated Enhanced Transcripts** (rolled out across
   podcasts, current as of this research —
   [Spotify's own creator docs](https://creators.spotify.com/resources/grow/automated-transcripts-chapters)):
   the transcript **highlights the exact word being spoken in sync with
   playback**, displayed in the Now Playing view, auto-generated (not
   hand-authored SRT in the common case). This is the concrete precedent
   for word-synced captions specified in §4 below — a current, real,
   word-level "karaoke" sync pattern, not an invented one.
4. **Instagram/Facebook's own in-feed video convention** (muted autoplay,
   tap to unmute — confirmed as the standard mobile-webview autoplay
   workaround: [Chrome for Developers' autoplay
   policy](https://developer.chrome.com/blog/autoplay), [MDN's autoplay
   guide](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay)).
   This isn't a competitive UX choice so much as a platform-constraint
   reality — but it's specifically relevant here because DreamTube's
   actual traffic sits *inside* these exact host apps' webviews, so
   mirroring their own native convention (rather than any other app's) is
   the least-surprising unlock gesture for this specific audience. Drives
   §6's fallback design directly.

## 3. Play control placement & behavior — two directions (founder picks)

Both directions share everything else in this spec (data model, API,
analytics, safety, intro-clip mechanics, fallback UX) — they differ only
in **how the per-reading TTS control is presented and where the
"speaking" state lives on screen.** Both mount inside the existing
`.itp-topbar`/reading-card structure; neither requires new screens.

### Direction 1 — "The Docked Player" (Calm-grounded)

A slim, persistent control bar appears directly under the `.itp-topbar`
the moment a reading (§3.5 of Wave 1) renders: a play/pause button
(`Icons.play`/`Icons.pause`), a thin **progress ring around the portrait
itself** (not a linear scrubber — Calm's own choice, and appropriate here
since a 150–220 word reading isn't something a user meaningfully wants to
scrub mid-sentence), and elapsed/total time as small text
("0:14 / 1:02"). Word-synced captions (§4) render **inside the existing
reading card**, replacing the static reading text with a live, word-
highlighted version of the same text as it's spoken — the card the user
was already going to read becomes the caption surface, rather than adding
a second text block.

- **Tradeoff:** more discoverable and more "podcast/audiobook"-familiar
  (a visible, named control a first-time user recognizes instantly), but
  it adds visible chrome to a screen that's currently very quiet, and the
  progress ring needs a bit more portrait-CSS work than Direction 2.

### Direction 2 — "Tap the Sage" (Character.AI Call-grounded)

No separate play/pause button at all. **The portrait itself is the tap
target** — tapping it starts the reading's TTS playback; tapping it again
while speaking pauses (Character.AI's "tap to interrupt," adapted to
pause rather than fully end the session, since there's no live
back-and-forth to interrupt here). Captions render as a **compact
floating strip directly beneath the portrait, inside the top-bar itself**
(replacing `.itp-topbar-persona-sub`'s "inspired by…" text for the
duration of playback, then reverting once done) — never touching the
reading card below, which stays exactly as it renders today. A single
small caption-visibility toggle (an eye/CC-style icon) lets a user hide
the floating caption strip if they just want to listen.

- **Tradeoff:** more minimal and more consistent with the Chamber's
  existing "quiet, portrait-forward" visual language (no new button
  chrome anywhere) and cheapest to build, but it's a less discoverable
  affordance — a first-time user has no visual cue that the portrait is
  tappable until told, so it needs a one-time inline hint the first time
  a reading with audio appears ("Tap [persona name] to hear this read
  aloud" — dismissed permanently after first tap or first explicit
  dismiss, stored per-browser in localStorage).

**Recommendation, not a decision:** Direction 2 is the better fit for
this Chamber's existing quiet aesthetic and is meaningfully cheaper to
build (no progress-ring CSS, no new visible control), but Direction 1 is
the safer discoverability bet for a totally new interaction (TTS playback
has never existed anywhere in this app before now). Real tradeoff between
"fits what's already here" and "will people find it" — genuinely the
founder's call, not something to collapse to one option.

## 4. Portrait animation + word-synced captions — mechanism

**Portrait "speaking" state (both directions):** while TTS audio plays,
`.itp-portrait` gets an added `.itp-portrait--speaking` class driving (a)
a soft pulsing glow (`box-shadow` breathing animation, using the active
persona's own `accent` color already defined per-persona — e.g. Jung's
`#8b7ec8` — so each Sage's glow is visually distinct, reusing data that
already exists rather than inventing new per-persona styling) and (b) a
very subtle scale pulse (1.0 → 1.02 → 1.0, ~1.8s cycle, eased) — same
spirit as the researched "orb breathes/pulses" voice-assistant convention,
scaled down to a static portrait image rather than a reactive 3D orb
(this app has no real-time amplitude signal to react to, since audio is
pre-rendered, not a live mic feed — so the animation is a fixed, gentle
loop tied to playback state, not amplitude-reactive). Respects
`prefers-reduced-motion`: glow only, no scale pulse, if set.

**Word-synced captions — timing mechanism:**

Neither of fal's two named TTS options reliably returns word-level timing
in its own output: Kokoro's and F5-TTS's hosted fal endpoints return audio
+ duration, not word alignment (confirmed via fal's own model docs during
this research pass — no `timestamps`/`alignment` field documented on
either's output schema). Rather than falling back straight to sentence-
level sync, this spec proposes reusing **infrastructure already live in
this codebase**: `transcribe-audio.js` already calls `fal-ai/whisper` with
`chunk_level: 'none'` for speech-to-text; **fal's Whisper endpoint also
supports `chunk_level: 'word'`**, returning per-word start/end timestamps.
So the pipeline is:

1. Generate TTS audio for the reading text (Kokoro, per-dream, ~$0.02/1k
   chars).
2. Re-run that same generated audio through the existing `fal-ai/whisper`
   call, `chunk_level: 'word'`, to get real word-level timestamps aligned
   to the actual rendered audio (not the source text — this matters,
   since TTS pacing isn't perfectly predictable from text alone).
3. Store the resulting `[{ word, startMs, endMs }, …]` array alongside
   the audio URL.

This reuses the exact vendor/model this codebase already pays for and has
working integration code for (no new API surface to learn), and produces
**genuine word-level sync**, not an approximation. **Fallback**, only if
step 2 fails or returns unusable output: sentence-level sync — split the
reading text on sentence boundaries, distribute the audio's total
duration across sentences proportional to each sentence's character
count, and highlight one sentence at a time. This is a real degradation
path, not silently broken captions, and should be flagged as such in
`interp_voice_tts_failed`-adjacent telemetry (§7) if it ever engages in
production, since it means the word-level path failed and should be
investigated.

Caption rendering itself: current word (or sentence, on fallback)
highlighted (background pill or brightened text color, using the active
persona's `accent`), already-spoken words at full opacity, not-yet-spoken
words dimmed — standard karaoke-style treatment, matching Spotify's own
researched pattern (§2.3).

## 5. One-time persona intro clip — trigger & visual distinction

**Trigger:** the pre-rendered Kling AI Avatar v2 Standard lip-synced clip
(~5–10s greeting, ONE shared asset per persona, amortized across every
user — never regenerated per-dream) plays **once per persona-selection
commit** — i.e., the moment a user taps "Begin with [persona]" from the
picker (Wave 1 §3.1 → §3.2 transition), not on every re-open of an
already-active session. If a user closes and reopens the Chamber for a
dream where that persona is already the active/most-recent one, the
intro does **not** replay (avoids the same 8-second clip becoming
annoying on repeat visits) — gated by a simple per-dream-per-persona
"intro already shown" flag alongside the existing `interpretations
[personaKey]` record (`dream.interpretations[personaKey].introShownAt`),
not a global one-time-ever flag, since a user picking a *different*
persona on the *same* dream should still see that persona's own intro.

**Visual distinction from per-reading TTS audio (this matters — same
portrait slot, two different things):**

- The intro clip is genuinely **lip-synced video**, not audio-over-a-
  static-portrait — it visibly replaces the static portrait image with a
  short looping/playing video element in the exact same position/size as
  `.itp-portrait`, then **crossfades back to the static portrait** the
  instant the clip ends (300ms fade), returning to the normal picker→
  questions flow.
- No caption strip and no play/pause control render during the intro —
  it's a one-shot, uninterruptible-by-design greeting (mirrors why
  Direction 2's "tap to pause" doesn't apply here: this is a fixed,
  short, always-the-same clip, not a per-dream reading someone might want
  to pause and resume mid-listen).
- A single small "Skip" text link appears (bottom-corner of the overlay,
  low-emphasis, matching the existing `.skipline`/quiet-link visual
  language already used for "Just interpret it →") for anyone who's
  already seen this persona's greeting on another dream and wants past it
  immediately without waiting the full clip.
- On mobile-webview autoplay block (§6), the intro clip behaves exactly
  like the reading's TTS — capability-detected, tap-to-play fallback,
  never assumed to autoplay.

## 6. Mobile-webview autoplay fallback UX

Majority of this app's traffic is inside FB/IG in-app-browser webviews,
which — per this research pass and matching those platforms' own native
in-feed video convention (§2.4) — allow **muted** autoplay freely but
block **audio-on** autoplay without a prior user gesture on that page.

**Capability detection, not assumption:** on mounting the Chamber (or on
first reaching a screen with a real audio/video element to play), attempt
a real, tiny, muted test play (or use the standard `canPlayType`/user-
activation-state check available to the page) rather than hard-coding
"webview = blocked." Concretely: attempt playback; if the returned Promise
from `.play()` rejects (the standard signal for an autoplay block), fall
back to the tap-to-play state below. Never gate purely on user-agent
sniffing (webview detection by UA string is unreliable and drifts) —
detect the actual failure, every time, for every surface (intro clip AND
reading TTS independently, since a user could, in principle, unlock one
and not the other depending on exactly which gesture unlocked the audio
context).

**What the user sees when blocked:**

- The portrait (or intro-clip video frame, paused on its first frame)
  shows a **single, unmistakable tap-to-play affordance** directly on it
  — a centered play triangle overlay (reusing `Icons.play`, enlarged,
  on a soft dark scrim over the portrait) — never a separate modal, never
  an explanation of *why* (per the founder's own "capability-detect and
  hide, don't handhold" principle — a blocked-audio state gets a clean
  tap-to-play control, not an apologetic explainer about browser
  restrictions).
- The very first tap anywhere on that overlay both (a) unlocks the
  audio context for the rest of this Chamber session and (b) starts
  playback immediately — one gesture, no second confirmation step.
- If TTS/intro generation itself is still in flight when the tap lands
  (rare, but possible on a slow connection), the tap-to-play overlay
  shows the existing `.spinner-inline` briefly rather than doing nothing.
- Text (the reading itself, or the intro's persona tagline) is **never
  blocked by this** — the reading card and persona name/tagline render
  immediately regardless of audio-unlock state; only the audio/video
  layer waits on the tap. A user who never taps still gets the full
  reading experience Wave 1 already shipped, just silently, exactly as
  today.

## 7. Data model & API extensions

**Persona schema** (`js/interpreter-personas.js`) — additive, no
migration needed for existing per-persona records:

```js
{
  // ...existing fields unchanged (key, name, inspiredBy, tagline,
  // asksAbout, accent, portrait, loadingQuestions, loadingReading,
  // voice, method, questionFocus, maxQuestions)...
  voiceId: 'af_bella',           // Kokoro voice id (or F5-TTS reference), per Wave 1's own forward-compat note
  introClipUrl: 'assets/interpreters/intro/jung.mp4'  // the ONE shared pre-rendered clip, not per-user
}
```

**Per-dream, per-persona record** (`dream.interpretations[personaKey]`)
— additive fields, existing `text`/`at`/`qa` unchanged:

```js
dream.interpretations[personaKey] = {
  text: "…", at: 169…, qa: [...],   // unchanged from Wave 1
  audioUrl: "https://…",             // TTS audio for THIS reading, per-dream
  audioDurationMs: 62000,
  captions: [                        // word-level (or sentence-level fallback)
    { word: "Your", startMs: 0, endMs: 180 }, …
  ],
  captionsLevel: 'word' | 'sentence', // which mechanism actually produced this
  introShownAt: 169…                  // set once, gates §5's replay logic — NOT cleared by edit/regenerate
}
```

`finalizeDream`'s existing edit-clear (Wave 1 §3.6, nulls the whole
`interpretations` map) also clears `audioUrl`/`captions`/`captionsLevel`
for free, since they live on the same per-persona object — no separate
clear-path needed. `introShownAt` is intentionally NOT part of that clear
(seeing this persona's greeting once shouldn't reset just because the
dream text was edited).

**New Netlify functions** (parallel structure to
`transcribe-audio.js`/`transcribe-status.js` — submit-then-poll, not
sync, learning directly from that file's own documented 504 gotcha:
even a fast model can sit `IN_QUEUE` past Netlify's function timeout, so
this must poll, not block):

```
POST generate-interp-audio.js
  { dreamId, personaKey, text }   // text = the already-generated reading
  → 200 { operationName }

GET  interp-audio-status.js?operationName=…
  → 200 { status: 'processing' }
  → 200 { status: 'done', audioUrl, audioDurationMs, captions, captionsLevel }
  → 200 { status: 'failed', error }
```

- Internally: submits to `queue.fal.run/fal-ai/kokoro` (default — cheapest
  confirmed option, $0.02/1k chars; model swappable via an env var
  following `generate-video.js`'s own `FAL_MODEL_*` convention, e.g.
  `FAL_MODEL_INTERP_TTS`), then on completion internally chains the
  existing Whisper call (`chunk_level: 'word'`) against the resulting
  audio before returning — the client only ever sees one poll cycle to
  manage, not two separate jobs, keeping `js/store.js`'s calling code
  identical in shape to `pollUntilDone`'s existing pattern.
- Rate-limit scope: new `interp-audio-ip` bucket (same
  `lib/rate-limit.js`, same per-IP daily ceiling reasoning as
  `interpret-ip`) — kept separate from the text-generation bucket so a
  heavy day of text readings doesn't starve audio, and vice versa.
- Error codes: new `E5xx` block (following the `E4xx` = interpret-dream.js
  convention) — `E501 method_not_allowed`, `E502 missing_api_key`,
  `E503 invalid_json`, `E504 text_required`, `E505 unknown_persona`,
  `E506 tts_request_failed`, `E507 rate_limited`, `E508
  caption_alignment_failed` (non-fatal — triggers the sentence-level
  fallback in §4, not a hard error to the client).
- **Intro clips are NOT generated by any of the above** — they're a
  one-time, founder-approved, manually-triggered Kling AI Avatar v2
  Standard batch job (5 personas × ~$0.45–0.56 ≈ ~$3 total, already
  approved as normal testing budget), producing 5 static `.mp4` assets
  checked into `assets/interpreters/intro/`. No runtime API call, no
  per-user cost, ever, for this part.

## 8. Analytics — `interp_voice_*` events

All PostHog-only (via the Chamber's existing local `track()` helper),
neutral naming matching the `interp_*` convention exactly — no Meta
Pixel/CAPI, per Wave 1 §7's own explicit rule and this wave's own scope
item 4.

| Event | Trigger | Props |
|---|---|---|
| `interp_voice_intro_shown` | The persona's one-time intro clip actually starts playing (autoplay succeeded, or a blocked-autoplay tap just unlocked it) | `{ persona }` |
| `interp_voice_intro_completed` | Intro clip finishes playing naturally, end to end | `{ persona }` |
| `interp_voice_intro_skipped` | User taps the intro's "Skip" link, OR closes the Chamber mid-intro | `{ persona, via: 'skip_link' \| 'closed' }` |
| `interp_voice_autoplay_blocked` | Capability-detection (§6) determines audio-on playback was blocked for either the intro or the reading, and the tap-to-play overlay is shown | `{ persona, surface: 'intro' \| 'reading' }` |
| `interp_voice_play` | The reading's TTS audio actually begins playing — autoplay succeeded, a tap-to-play unlock just fired, or the control was manually tapped | `{ persona, source: 'auto' \| 'tap_unlock' \| 'manual' }` |
| `interp_voice_paused` | User manually pauses reading playback before it completes | `{ persona, position_ms }` |
| `interp_voice_complete` | Reading TTS finishes playing to the end, uninterrupted | `{ persona, duration_ms }` |
| `interp_voice_replay` | User re-plays a reading's audio after it already completed once | `{ persona }` |
| `interp_voice_listen_time` | Fires once, on Chamber close (same choke point as the existing `interp_closed`) — total audio dwell for this session | `{ persona, listened_ms, audio_duration_ms, completed: bool }` |
| `interp_voice_tts_failed` | `generate-interp-audio.js`/status poll returns a hard failure — reading falls back to text-only, no audio control shown at all | `{ persona, error_code }` |
| `interp_voice_caption_fallback` | `captionsLevel` resolves to `'sentence'` instead of `'word'` for a completed generation — signals the Whisper-realignment path (§4) failed and the degrade path engaged | `{ persona }` |

`interp_voice_listen_time` mirrors `interp_closed`'s existing
`read_time_ms` reasoning (Wave 1 §7) — the same "how long did they
actually engage" signal, for audio dwell instead of read dwell, so this
wave's real usage is measurable the same way Wave 1's already is (this
wave ships fully instrumented, per scope item 3, precisely so a future
pricing decision has real data rather than a guess).

## 9. Safety & compliance — unchanged, reaffirmed

Nothing in this wave changes any safety rail from Wave 1 §4:

- Same crisis-language instruction, same banned-language list (therapy,
  diagnosis, healing, mental health, treatment), same "never mention
  you're an AI" rule — these govern the TEXT the TTS reads aloud, which
  is the exact same already-generated/validated reading text from Wave 1,
  never a new, separately-generated script. TTS narrates what was already
  checked; it doesn't introduce new copy of its own.
- Same reflection/entertainment framing carries into the audio
  experience — the disclaimer line (Wave 1 §3.5) stays visible on screen
  throughout playback in both directions above, never hidden behind the
  caption strip or progress ring.
- Nothing pricing-visible anywhere in this wave's UI (scope item 3) — no
  token cost, no "this uses X tokens," no paywall/upsell copy on any
  audio-related surface, even though this is now the most expensive-to-
  generate part of the whole Chamber. Fully instrumented (§8) instead, so
  a future pricing decision has real usage numbers.
- Still zero exposure on any ad-facing surface — no Meta Pixel, no CAPI,
  matching Wave 1's explicit rule and this wave's scope item 4.

## 10. Out of scope (this wave)

- **Per-dream lip-synced video** — explicitly ruled out in the brief as
  uneconomic (~$2/reading). Only the intro clip is lip-synced video;
  every per-dream reading is audio-only (TTS) over the existing static
  portrait/caption UI.
- **Pricing/gating UI of any kind** — ships free, fully instrumented,
  during this wave (scope item 3).
- **Live/real-time TTS streaming** (word-by-word generation as it's
  read) — the reading is already fully generated text by the time TTS
  runs (Wave 1's existing `mode:"reading"` call completes first); this
  wave generates one complete audio file per reading, not a streaming
  voice.
- **Voice cloning / custom user voices** — F5-TTS's cloning capability is
  noted as available in the brief but not used here; each persona has one
  fixed `voiceId`, founder/design-picked, not user-customizable.
- **Changing which TTS/avatar vendor is used** — Kokoro (reading TTS) and
  Kling AI Avatar v2 Standard (intro clips) are both already
  founder-confirmed in the brief; swapping either is a separate decision
  (`AGENT_POLICY.md` escalation gate (b), vendor choice) not covered here.
- **Re-litigating Direction A vs B from Wave 1** — the Chamber's overall
  full-screen structure is already shipped and out of scope for change;
  only §3's two sub-directions (play-control placement) are open here.

## 11. Build checklist (files touched, expected)

- `js/interpreter-personas.js` — add `voiceId`, `introClipUrl` per persona
- `js/interpret-experience.js` — portrait speaking-state class toggling,
  caption rendering, play-control UI (whichever direction is picked),
  intro-clip mount/crossfade, autoplay capability-detection + tap-to-play
  overlay, all `interp_voice_*` fire sites
- `css/styles.css` — new `.itp-portrait--speaking` (glow/pulse keyframes,
  `prefers-reduced-motion` variant), caption strip/inline-highlight
  styles, tap-to-play overlay, (Direction 1 only) progress-ring +
  docked-bar styles
- `netlify/functions/generate-interp-audio.js` — new
- `netlify/functions/interp-audio-status.js` — new
- `netlify/functions/lib/rate-limit.js` — new `interp-audio-ip` scope
  (reuse existing helper, new bucket key)
- `js/store.js` — `generateInterpAudio(dreamId, personaKey)` +
  polling wrapper (mirrors `pollUntilDone`/`requestInterpretationQuestions`
  shape); extends `dream.interpretations[personaKey]` read/write; extends
  the existing edit-clear to null the new audio fields too
  (no separate clear path)
- `assets/interpreters/intro/*.mp4` — 5 new static assets (one-time
  Kling AI Avatar v2 Standard batch, ~$3 total, already approved)
- `docs/EVENT_TAXONOMY.md` — add the `interp_voice_*` table (§8 above),
  matching how every other wave's events got indexed there

## 12. Open items the build agent cannot determine alone

1. **Direction 1 vs Direction 2 (§3)** — founder pick, escalation gate
   (a). Nothing in §3 is buildable until this is resolved.
2. **Which Kokoro voice id per persona** (`voiceId`, §7) — five real
   choices (tone/gender/accent matching each persona's character), a
   real creative/casting decision, not something to default silently.
   Founder should hear a short sample per persona before this is locked
   (same "always show him a design/visual before deciding" standing rule,
   applied to audio — a same-in-spirit "let him actually hear it" gate).
3. **Exact Kokoro `voiceId` catalog values** — this spec names the model
   (`fal-ai/kokoro`) and cost, already confirmed available in the brief;
   the literal list of selectable voice ids should be pulled fresh from
   fal's own model page at build time (not from this spec, not from
   memory) since voice catalogs are exactly the kind of vendor detail
   that drifts — matches this repo's own "assumptions have expiry dates"
   principle.
4. **First-time "tap the portrait" hint copy (Direction 2 only)** — a
   real microcopy decision (exact wording, exact dismiss mechanics); a
   reasonable default is proposed in §3.2 but not locked.

---

*Design pass 2026-07-30, for tracker item
for-product-build-speaking-sage-wave-fou-8uobuh. Research sources cited
inline (§2). Two open founder decisions before build can start on the
play-control UI: §3's Direction 1 vs 2, and §12 item 2's voice casting.*
