# Speaking Sage WAVE 2 — Cinematic Talking-Head Personas

**Spec-only pass.** Per tracker item `for-product-founder-inspiration-2026-07--7bln97`: proper
spec + cost estimate before any build commitment. Nothing here is a build authorization.

## 1. Scope boundary vs. Wave 1

This spec does not require, and does not block on, Wave 1's persona/voice-casting decision
being finalized. Wave 2's video/cost architecture applies to "whichever 5 personas Wave 1
ships" — nothing here needs a specific voice ID or a specific play-control layout to be true.
The two open decisions in this spec (source-art direction; whether to regenerate the intro
clip) are orthogonal to Wave 1's two open decisions (play-control direction; voice casting).

What Wave 2 *does* depend on for build sequencing (not spec/cost approval): Wave 1's runtime
pieces (`.itp-portrait` slot, `dream.interpretations[personaKey]`, the TTS/caption pipeline,
`interp_voice_*` events) have to exist in code before Wave 2's video layer can attach to them.
Wave 1's own spec already reserved this slot — "architected as the future avatar/voice slot...
no redesign needed" when this wave ships.

## 2. The central tension, named explicitly

The inspiring reel (Jung/Freud, B&W, filmic, word-synced captions, exceptional save ratio) is
almost certainly full Veo-class video generation with native dialogue audio — every frame,
gesture, and lip movement generated together as one shot. Reproducing that per-interpretation
for a free, unlimited Chamber feature is worse than the tracker item's own conservative
estimate: Wave 1's reading system prompt targets 100-160 words (~40-70s of TTS audio at a
natural pace). At Kling AI Avatar v2 Standard's real, current pricing ($0.0562/sec), a single
lip-synced reading would cost $2.25-$3.93 — not "~$0.24+/8s." Against a free, unlimited
feature, that's an open-ended cost with no ceiling, independent of whether $2.81 is
individually affordable.

**Per-interpretation lip-synced video is a non-starter — structurally the wrong shape of cost
for a free, unlimited feature, full stop.**

Does non-lip-synced video + TTS + captions actually read as "cinematic," or as broken? This is
answerable via a well-proven precedent: MyHeritage's Deep Nostalgia animates a still photo
with realistic idle motion (blink, breathe, tilt) using pre-recorded gesture sequences,
**deliberately with no speech at all** — its own stated reasoning is to avoid the "deepfake"
read that comes with putting words in a still photo's mouth. The Ken Burns documentary
convention is the same idea even older: narration over a still/panning photo, zero lip
movement, never perceived as broken — captions/narration carry the content, the visual carries
mood. Wave 1's own word-synced captions (Whisper word-level alignment) already do exactly this
narrative work.

**Conclusion**: a closed-mouth, ambient-motion "listening" loop — not lip-synced, mouth at
rest — playing under live TTS + word-synced captions is not a compromise. It's a distinct,
independently-proven pattern that sidesteps the one thing that actually breaks the illusion: a
mouth visibly not matching specific words. A closed/resting mouth with breathing motion never
has that mismatch to notice.

## 3. Cost-sane architecture

Wave 1 already established this pattern for one clip: a single one-time, lip-synced **intro**
clip per persona (Kling AI Avatar v2 Standard, ~$0.45-0.56/persona, ~$3 total for 5 personas,
already founder-approved testing spend), reused every session.

Wave 2 extends the same pattern to two more fixed clip types:

| Clip | When it plays | Lip-synced? | Model | Length |
|---|---|---|---|---|
| Intro (Wave 1, reused) | Once per persona-selection commit | Yes — fixed line, matched | Kling AI Avatar v2 Standard | ~6-8s |
| **Listening loop (NEW)** | Loops in `.itp-portrait` for the full TTS duration | **No** — closed-mouth ambient motion | Kling 1.6 Standard image-to-video | ~5s, seamless loop |
| **Closing line (NEW)** | Once, after TTS finishes | Yes — fixed sign-off line | Kling AI Avatar v2 Standard | ~5-7s |

Runtime integration: intro plays on persona selection (unchanged) → chat proceeds (unchanged)
→ reading renders (unchanged) → the moment TTS starts, `.itp-portrait` swaps from static image
to the listening loop, looping silently for however long the reading takes (no new generation
regardless of length) → TTS finishes → closing line plays once → crossfades back to static
portrait. Pause/resume simply pauses/resumes the loop in lockstep — nothing to resync since
it's silent and generic.

**Zero new recurring cost.** Wave 2 never touches the TTS pipeline or the Whisper alignment
call. Every dollar is spent once, in a manual pre-production batch, before any user opens the
Chamber.

## 4. Real cost estimate

Using real, currently-quoted fal.ai pricing (Kling AI Avatar v2 Standard $0.0562/sec; Kling 1.6
Standard image-to-video $0.056/sec):

| Item | Duration | Cost/attempt | Attempts (planning) | Cost/persona | x5 personas |
|---|---|---|---|---|---|
| Intro (if regenerated in new style) | 7s | $0.39 | 2 | $0.79 | $3.93 |
| Listening loop (new) | 5s | $0.28 | 2 | $0.56 | $2.80 |
| Closing line (new) | 6s | $0.34 | 2 | $0.67 | $3.37 |
| **Total** | | | | | **~$10.10** |

Worst-case ceiling (occasional 3rd/4th attempts on personas whose art doesn't animate
cleanly): ~$20-25 total — still the same "normal testing budget" category as Wave 1's own $3
intro batch. If the existing Wave 1 intro clips don't need regenerating, subtract $3.93 —
total drops to ~$6.20 (worst case ~$12-15).

**Recurring per-session cost: effectively $0.00 incremental.** The only recurring cost in the
whole feature is Wave 1's own Kokoro TTS call (~$0.02/1k characters, i.e. ~$0.012-0.019 per
100-160-word reading) plus the Whisper realignment call — both already priced into Wave 1,
unchanged by Wave 2. There is no scenario where Wave 2's own cost scales with traffic — even
at 10,000 Chamber sessions, its marginal cost stays $0.

## 5. B&W filmic style + caption treatment

**Generation-prompt layer**: append a consistent style block to every clip's prompt —
desaturated/monochrome, visible fine film grain, high contrast (crushed blacks not muddy
gray), shallow depth of field, soft top-light, subtle vignette. Costs nothing extra to apply
via prompt.

**CSS safety net** (new `.itp-portrait--filmic` class): `filter: grayscale(1) contrast(1.12)
brightness(0.97)` plus a vignette overlay — guarantees a consistent B&W look regardless of any
drift in the model's own rendering, consistent with how this codebase already layers
overlay/filter treatments elsewhere.

**Grain**: a subtle looping film-grain overlay (tiled noise texture or a lightweight animated
WebP), generated once, reused everywhere.

**Captions**: reuse Wave 1's exact word-timing data, but re-skin the presentation for the
cinematic moment specifically — a bottom-third subtitle overlay directly on the video (white/
off-white text, soft black scrim behind the text band, current word in the persona's own
accent color, matching Wave 1's existing per-persona accent data) rather than in-card. No new
alignment engineering — same underlying `{ word, startMs, endMs }` data.

## 6. Two design directions — founder picks

Both share the §3-5 architecture exactly; they differ only in the source image fed to Kling.

**Direction A — "Same Character, Brought to Life"**: use the existing Wave 1 illustrated
portrait (already shipped everywhere else in the Chamber) as the sole source for all three
clip types. Precedent: Duolingo's Lily/Falstaff — one consistent stylized character reused
across every surface, never swapped for a "more realistic" version. Cheapest, lowest
production risk, fully visually consistent with the rest of the Chamber. Tradeoff: an
illustrated source will likely read as "a painting that gently moves" rather than the reel's
specific grainy-real-film-footage texture.

**Direction B — "Archival Portrait, Treatment-Only"**: generate one new still portrait per
persona (period-styled studio-photograph aesthetic) used ONLY as the video source; the
existing illustrated art stays everywhere else unchanged. Important constraint carried over
from a decision Wave 1 already made deliberately: personas are original fictional characters
"inspired by" real methods (e.g. "The Depth Analyst"), explicitly not depictions of the actual
historical people — any new portrait must hold that same line, a plausible period-styled
*original* character, not a photoreal likeness of real, identifiable historical figures (a
real brand/platform-disclosure consideration, not just a cost question). Precedent: the same
visual strategy the reel itself uses, and the broader "old photograph"/archival-photoreal
trend (Midjourney/Flux period portraits, TikTok's "history POV" genre). Tradeoff: closer to
the reel's specific magic, small additional one-time image-gen cost (well under $1 total), but
raises a real "two different looks for the same character" design-consistency question that
needs a deliberate answer.

**Recommendation, not a decision**: Direction A is cheaper, safer, and more brand-consistent;
Direction B is more faithful to what actually made the reference reel work. Genuine
taste/risk tradeoff for the founder to pick, not something to collapse to one option.

## 7. Product spec — flow, data, edge cases

Flow (Wave 2 steps marked NEW): persona intro (Wave 1) → chat (Wave 1) → reading renders
(Wave 1) → **[NEW]** on TTS start, portrait swaps to listening loop, loops silently for the
TTS duration, on-video captions render → **[NEW]** on TTS complete, closing line plays once,
crossfades back to static portrait. Pause/resume (Wave 1 mechanics) pauses/resumes the loop in
lockstep; closing line doesn't replay on a simple pause/resume, only once per completed
reading.

Edge cases: a failed loop/closing-clip load fails silently to the static portrait — reading
text, TTS, and captions continue exactly as Wave 1 already behaves without video (new
telemetry: `interp_voice_clip_load_failed { persona, clip }`). Autoplay-blocked webviews use
the same tap-to-play gate Wave 1 already has. A badly-rendered clip is caught in the one-time
batch-QC pass before checkin — never surfaces live, since nothing here generates per-session.

Data/API needs: `js/interpreter-personas.js` gets `loopClipUrl`/`closingClipUrl` fields
alongside Wave 1's `introClipUrl`; static assets under `assets/interpreters/{intro,loop,
closing}/`; no new Netlify function (purely a static-asset addition on Wave 1's runtime);
`docs/EVENT_TAXONOMY.md` gets `interp_voice_clip_load_failed`.

Explicitly out of scope this pass: per-interpretation lip-synced video (ruled out, §2); any
change to Wave 1's own TTS/caption/play-control mechanics; amplitude-reactive mouth movement
(would need new live audio-analysis engineering this codebase doesn't have — the closed-mouth
ambient loop achieves the same "feels alive" goal for zero of that complexity and zero
recurring cost); regenerating Wave 1's picker/chat-header portraits in the B&W style (stays as
Wave 1 ships it, unless the founder wants a larger, separate full-identity art pass).

## 8. Real risks (quality, not cost)

Cost is small, one-time, and already the same routine-spend category as Wave 1's own intro
batch. The real risks: (1) illustrated source art may not animate cleanly through a
lip-sync/avatar model tuned mostly on photoreal inputs — budget for retries, and this is the
real reason Direction A vs B is a real fork, not just aesthetic; (2) the "cinematic" feeling
depends on execution — the grain/contrast/vignette treatment and the ambient-motion direction
need an actual look-review pass on generated clips before locking in, not just architecture
sign-off; (3) the historical-figure-likeness boundary (§6, Direction B) needs to be a
deliberate constraint on generation prompts from the start, not an afterthought.

## 9. Final recommendation

Cost-sane, worth pursuing as scoped. The fixed-clip-library architecture is a natural, cheap
(~$6-25 one-time, ~$0 recurring) extension of a pattern Wave 1 already designed, priced, and
had approved for its intro clip — not marginal or borderline economics. Per-interpretation
lip-sync would have been a real, unbounded cost problem (verified at $2.25-3.93/reading); the
fixed-library approach avoids that entirely while still delivering a genuinely cinematic
effect grounded in a proven pattern (Deep Nostalgia-style ambient motion + word-synced
captions), not an invented compromise.

The two open questions worth the founder's attention are creative, not financial: (1) which
source-art direction (§6), and (2) whether Wave 1's existing intro clip gets regenerated in
the new B&W treatment (~$4 cost delta either way). Both are safe, fast, cheap decisions —
nothing here should hold up Wave 1's own, larger, still-pending decisions.

## References

- [Kling AI Avatar v2 Standard — fal.ai](https://fal.ai/models/fal-ai/kling-video/ai-avatar/v2/standard) — $0.0562/sec
- [Kling 1.6 Standard image-to-video — fal.ai](https://fal.ai/models/fal-ai/kling-video/v1.6/standard/image-to-video) — $0.056/sec
- [fal.ai's AI image-to-video tooling roundup](https://fal.ai/learn/tools/ai-image-to-video-generators)
- [fal.ai Kokoro TTS pricing](https://fal.ai/models/fal-ai/kokoro/american-english) — $0.02/1k characters
- [MyHeritage Deep Nostalgia](https://blog.myheritage.com/2021/02/new-animate-the-faces-in-your-family-photos/) ([independent confirmation of no-speech design intent](https://dataconomy.com/2024/07/10/how-to-use-myheritage-deep-nostalgia-ai/))
- [Spotify Enhanced Transcripts (word-level sync precedent)](https://creators.spotify.com/resources/grow/automated-transcripts-chapters)
- `docs/SPEAKING_SAGE_SPEC.md`, `docs/INTERPRETATION_WAVE1_SPEC.md`, `netlify/functions/interpret-dream.js`, `interp-mock-x7q4.html`, `home-mock-x7q4.html`
