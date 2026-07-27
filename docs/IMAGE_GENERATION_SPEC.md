# Image Generation Spec — cheap image tier + image-first onboarding pivot

**Status:** design pass complete, both open decisions resolved by Ron (2026-07-24) — ready for build. Grounds every number in this codebase's real current state (read directly, not assumed) plus fal.ai's real, current published pricing (fetched 2026-07-24).

**Ron's decisions (2026-07-24), superseding the two open questions this spec originally posed:**

1. **Picker UI: Direction A (segmented toggle)** — see §9, resolved.
2. **Onboarding does NOT change** — `wizard.html`'s first-entry flow keeps auto-generating a free VIDEO exactly as it does today. The original "auto-image on first entry" pivot (§6 below) is **not being built** — image generation ships as a new, cheaper *option* available everywhere via the §5 picker (first-run included, once the wizard reaches `style.html`/an equivalent choice point — see §6-revised), but the wizard's automatic first-touch generation stays a video.
3. **Token economics, corrected** — Ron wants new users to still get a free video through the funnel, then be left with a balance of **190 tokens**, with the daily top-up reduced from 100/day to **10/day** (same existing countdown UI, just a smaller number). Working backward: video costs 100 tokens, 190 left afterward → **`INITIAL_GRANT` = 290** (290 − 100 = 190). `DAILY_GRANT_AMOUNT`: 100 → **10**. `GRANT_CEILING` (500) is unchanged — nothing suggested otherwise. See §2b-revised for the full table.

§2b and §6 below are the ORIGINAL design-pass proposal, kept for record/context; §2b-revised and §6-revised (added below each) are what's actually being built.

**Superseded note (tracker item `for-product-build-out-of-tokens-purchase-2y8hyw`, merged):** every `#modal-quota` reference below (§4 item 11, §5, §9) describes the insufficient-tokens UI as it existed at the time this spec was written. That flow has since been replaced by a real purchase sheet (`js/purchase-sheet.js`) — the mechanism this doc calls "existing `modal-quota` flow, unchanged" now means "the purchase sheet," not the old modal. Kept as-is below for historical record rather than rewritten line by line.

Companion signals: this repo's coordination channel is `tracker.html` (Netlify Blobs), not a separate signals repo — see `AGENT_POLICY.md`. The idea this spec implements is already logged there as `for-product-add-image-generation-option--fax6h8` (idea, medium priority, not done) — that item **is** the decision-made record for "which idea got picked"; no RICE score is attached to it in the tracker payload I read. A second decision-made-style tracker entry should be drafted once Ron actually picks one of the two directions below (draft included at the end of this doc) — not before, since I don't know which one he'll choose.

## 1. What exists today (read directly from the code, 2026-07-24)

| Thing | Real current value | Source |
|---|---|---|
| Video generation cost | 100 tokens flat (new gen, regen, edit — one gate) | `generate-video.js` E112, `entitlements.js` |
| Initial signup token grant | **200 tokens** | `entitlements.js:189` `INITIAL_GRANT = 200` |
| Daily free drip | +100 tokens / 24h, lazy-granted on read | `entitlements.js:190` `DAILY_GRANT_AMOUNT` |
| Grant ceiling | 500 tokens (daily drip stops above this) | `entitlements.js:191` `GRANT_CEILING` |
| Token pack pricing (not yet live) | 100 tokens/$1.99, 500 tokens/$8.95 | `shop.html` |
| Real fal.ai video cost | Veo 3.1 Fast ≈ $0.10–0.20/sec × 8s ≈ **$0.80–$1.60/video** | `generate-video.js` header comment |
| First-run auto-generation surface | `wizard.html` — pre-signup, chip-first, **auto-generates a VIDEO today** via `start-pending-generation.js` the instant email is captured (Step 7 of 8), in parallel with signup (Step 8) | confirmed by reading `wizard.html` + `start-pending-generation.js` |
| Video-to-image-to-video "gift" | `fal-ai/veo3.1/fast/image-to-video` (`FAL_MODEL_IMAGE_TO_VIDEO`) already exists in `generate-video.js:279`, **dormant/unused today**. Takes `image_url` (a hosted URL) + a text prompt, animates that exact image as the video's starting frame. Confirmed via fal's own API docs (2026-07-24): `image_url` is "URL of the input image to animate... 720p or higher... 16:9 or 9:16" | `generate-video.js`, fal.ai docs |
| Text-to-image model in this codebase | **None exists today** — confirmed by grep, this is the one genuinely new piece of infra | — |

### Which surface is "first entry"

Confirmed by reading `wizard.html`'s own header comment and `AGENT_POLICY.md`/tracker history: **`wizard.html` is the current pre-signup onboarding surface** (reachable from `index.html`'s "Get Started"), and it is the one that matters for this pivot. `start.html` is a separate, still-live external-growth-funnel handoff (`?resume=1`, screens live in `dreamtube-growth`), untouched by and out of scope for this build — same explicit carve-out `wizard.html`'s own header comment already states. `create.html` is the **already-logged-in** "New Dream" entry point (Build it / Write it / Record it), not a first-entry surface at all. So: **only `wizard.html` needs the auto-image pivot; `create.html`/`style.html` need the image-vs-video *picker* for return users (see §5); `start.html` is untouched.**

## 2. Real numbers for this feature

### 2a. The image model

**Recommended: `fal-ai/flux/dev`** (FLUX.1 [dev]), text-to-image.

- Real, current fal.ai pricing (fetched 2026-07-24, quoted verbatim off the model page): "$0.025 per megapixel, billed by rounding up to the nearest megapixel."
- Aspect ratio: use the `image_size: "portrait_16_9"` preset (fal's built-in enum) to match this app's existing 9:16 video aspect ratio (`generate-video.js` always sends `aspect_ratio: '9:16'`) — and to satisfy `fal-ai/veo3.1/fast/image-to-video`'s own input requirement ("720p or higher, 16:9 or 9:16"), since this same image is what later feeds the upsell. **Build must confirm at implementation time** that `portrait_16_9`'s actual returned pixel dimensions clear the 720p-equivalent short-side bar (~1–2 total megapixels expected); if they don't, pass explicit `{width, height}` instead (e.g. `{width: 1080, height: 1920}`).
- At 1–2 MP: ≈ $0.025–$0.05 per image — roughly 30–60× cheaper than a $0.80–1.60 video.
- Cheaper fallback, if Ron wants to shave cost further later: `fal-ai/flux/schnell`, $0.003/megapixel (≈ $0.006–$0.012/image), lower quality (1–4 inference steps vs. `dev`'s full quality). One-line model-id swap, no architecture change — flagged as a lever, not built now, since `dev`'s absolute cost is already negligible next to video.
- Output shape (confirmed via fal's schema docs): `{ images: [{ url, width, height, content_type }], ... }` — images are returned as a public, hosted URL, exactly like video results.
- **Retention**: fal retains generated files "for at least 7 days" by default (confirmed via fal's docs, 2026-07-24), configurable via an `X-Fal-Object-Lifecycle-Preference` header. This is long enough that no new storage/hosting mechanism is needed for pass 1 — the image URL fal returns is what gets stored as `dream.imageUrl` and is what gets fed straight into the image-to-video call later. Flagged explicitly in §7 (out of scope) if longer/indefinite retention (e.g. permanently published Explore images) is ever wanted.

### 2b. Token economics (the actual numbers to implement)

Current: video = 100 tokens, initial grant = 200 (covers 2 videos — exactly what Ron wants to stop). New:

| Constant | Old value | **New value** | File |
|---|---|---|---|
| `INITIAL_GRANT` | 200 | **20** | `netlify/functions/lib/entitlements.js:189` |
| `DAILY_GRANT_AMOUNT` | 100 | unchanged (100) | same file |
| `GRANT_CEILING` | 500 | unchanged (500) | same file |
| Video generation cost | 100 tokens | unchanged (100 tokens) | `generate-video.js` |
| **Image generation cost** | n/a | **10 tokens flat** (new constant, hardcoded in `generate-image.js`, matching this codebase's existing per-file-owns-its-own-cost-constant convention — `generate-video.js`/`start-pending-generation.js` both hardcode `100` inline rather than centralizing it) | `generate-image.js` (new) |

Check against Ron's own worked example (`image = 10 tokens, initial ~20 tokens`) maps exactly onto these real constants once `INITIAL_GRANT` is retuned:
- 20 tokens ÷ 10 tokens/image = exactly 2 free images.
- 20 tokens is less than the 100-token video cost, so a brand-new account cannot generate a video (or a 3rd image) from its initial grant alone — it must either wait 24h for the +100 daily drip, or (once live) buy a pack.
- This is a deliberate, explicit monetization change: the free ride on signup drops from "2 free videos worth ~$1.60–3.20 of real fal cost" to "2 free images worth ~$0.05–0.10 of real fal cost." This is exactly what Ron's tracker item asked for, not a judgment call being made here.
- "Turn this into a video" and any 2nd+ video always cost the same flat 100 tokens — no discount for having already paid for the image. Flagged as a possible future lever (e.g. 90 tokens as a loyalty nudge), not built now.

### 2b-revised — ACTUAL numbers to build (Ron's correction, 2026-07-24)

Supersedes §2b above. The wizard keeps giving new users a free video (not an image) on first entry — the free-tier tightening happens entirely through the initial grant + daily trickle, not through an onboarding media-type switch.

| Constant | Old value | **New value (build this)** | File |
|---|---|---|---|
| `INITIAL_GRANT` | 200 | **290** | `netlify/functions/lib/entitlements.js:189` |
| `DAILY_GRANT_AMOUNT` | 100 | **10** | same file |
| `GRANT_CEILING` | 500 | unchanged (500) | same file |
| Video generation cost | 100 tokens | unchanged (100 tokens) | `generate-video.js` |
| Image generation cost | n/a | **10 tokens flat** (unchanged from §2b) | `generate-image.js` (new) |

Check: a new signup gets 290 tokens, the wizard's free onboarding video costs 100, leaving exactly **190 tokens** — matches Ron's own number precisely. From there: another video (100) is still affordable (90 left), or up to 19 images (10 each), or a mix — same flexibility as today's model, just re-based on 290/10 instead of 200/100. The real tightening is the **daily trickle drop from 100/day to 10/day** — today a lapsed user re-fills to the 500 ceiling in 3 days; under the new numbers it takes ~21 days, making the free tier meaningfully less generous over time without changing the first-touch experience at all.

## 3. Data model changes

### `js/store.js` — dream record, draft, pendingJob

- **Dream record** gains two fields: `imageUrl` (nullable, default `null`) and `mediaType` (`'image'|'video'`, default `'video'` for every existing/legacy dream that has none — read as `dream.mediaType || 'video'` everywhere rather than migrating old records). A dream can have `imageUrl` only (not yet upgraded), or both `imageUrl` and `videoUrl` (after the upsell — the image is kept for provenance, `videoUrl` takes rendering priority everywhere `mediaType` becomes `'video'`).
- **Draft** (`getDraft()`/`setDraft()`/`clearDraft()`) gains `mediaType` (`'image'|'video'|null`). `clearDraft()`'s reset object adds `mediaType: null`.
- **pendingJob** gains `mediaType`, set everywhere `savePendingJob(...)` is called (inside `startGeneration` and `adoptPendingGeneration`).

### `netlify/functions/lib/pending-dreams.js`

Record shape gains `mediaType` (default `'video'` in `create()` if the caller doesn't pass one — fully backward compatible) and `imageUrl` (default `null`).

## 4. New / changed files — exact list

**New files:**

1. **`netlify/functions/generate-image.js`** — mirrors `generate-video.js`'s shape and guardrail order (Turnstile → per-IP/email rate limit → token gate → spend-guard circuit breaker), calling `fal-ai/flux/dev` instead. Exports `buildImagePrompt` (same enrichment as `buildPrompt` — style/camera/scenery/character text — minus the reference-photo pointer line, see the known limitation below), `callFalImage`, `FAL_MODEL_IMAGE_GEN = 'fal-ai/flux/dev'`, `falErrorMessage` (duplicated, matching this codebase's own "each function self-contained" convention already stated in `video-status.js`'s header comment). Token gate checks `balance < 10`, spends `10` on success. Own error-code namespace, next free hundred-range after `generate-video.js`'s E1xx:
   - `E401 method_not_allowed` · `E402 missing_api_key` · `E403 invalid_json` · `E404 caption_and_style_required` · `E405` fal rejected the submission · `E407` couldn't reach fal at all · `E409 rate_limited` · `E410 daily_spend_cap_exceeded` · `E412 insufficient_tokens` · `E413 turnstile_verification_failed`
   - `GENERATION_MOCK_MODE` supported identically (zero-cost mock path, same discipline as `generate-video.js` — see `docs/TESTING.md`).
2. **`netlify/functions/image-status.js`** — mirrors `video-status.js`'s `checkFalStatus`, reading `resultData.images[0].url` instead of `resultData.video.url`. Returns `{ done, imageUrl }` (not `videoUrl`). Own error range: `E501–E510` (same numbering pattern as `video-status.js`'s `E201–E211`, offset). Mock path returns a small stable public sample image URL after a short simulated delay (shorter than video's 20s `MOCK_DELAY_MS` — recommend ~5s, since real flux/dev completion is seconds, not minutes, and mock mode should still feel proportionate).

**Changed files:**

3. **`netlify/functions/lib/entitlements.js:189`** — `INITIAL_GRANT`: `200` → `20`. One-line change, see §2b for the full reasoning.
4. **`netlify/functions/lib/pending-dreams.js`** — add `mediaType`/`imageUrl` fields to the record shape (§3).
5. **`netlify/functions/start-pending-generation.js`** — accept optional `mediaType` (`'image'|'video'`, default `'video'` — fully backward compatible) in the POST body. When `'image'`: token-gate/spend against 10 instead of 100 (error text becomes "not enough tokens to generate an image"), call `genImage.buildImagePrompt`/`genImage.callFalImage` (required from the new `generate-image.js`, mirroring how this file already requires `genVideo`'s exports) instead of `genVideo`'s, and do not pass a `webhookUrl` to the fal submission — see the explicit scope cut below.
6. **`netlify/functions/generate-video.js`** — add an optional `sourceImageUrl` field to the POST body. When present, route to `callFalImageToVideo` (reactivating the dormant `FAL_MODEL_IMAGE_TO_VIDEO` path) instead of `callFal`/`callFalReferenceToVideo` — this is the "Turn this into a video" call. `callFalImageToVideo` needs updating to match the other two callers' signature (`prompt, imageUrl, falKey, duration, generateAudio, webhookUrl`, using `resolveDuration()` and the `generate_audio` param the other two already send, instead of its current hardcoded `duration: '8s'` and no audio param) — purely a consistency fix while reactivating it, no new behavior beyond that. New error code `E114`: fal rejected the image-to-video submission (do not reuse `E108`/`E111` — those are explicitly retired/renamed in this file's own doc comments and reusing them would confuse anyone grepping old support tickets).
7. **`js/store.js`** — `startGeneration` gains `opts.mediaType` (default `'video'`), branching: submission URL (`/.netlify/functions/generate-video` vs `/.netlify/functions/generate-image`), poll URL/field (`video-status.js`'s `videoUrl` vs `image-status.js`'s `imageUrl`), and skipping `probeVideoDuration` entirely for images (no duration concept applies). `finalizeDream` gains a `mediaType` param, sets `videoUrl` or `imageUrl` accordingly, always stamps `dream.mediaType`. New public method `generateImage(caption, style, opts)` — thin wrapper calling `startGeneration(caption, style, Object.assign({}, opts, { mediaType: 'image' }))`; `generateVideo` is unchanged (implicit `'video'`). `regenerateDream`, `adoptPendingGeneration`, `resumePendingJob` all forward `mediaType` through. New public method `turnImageIntoVideo(dreamId)` — see §6.
8. **`wizard.html`** — Step 7 (`renderContact`)'s fetch to `start-pending-generation.js` adds `mediaType: 'image'` (hardcoded — every wizard run is image-first now, this isn't a user choice at this point in the flow); the `DreamStore.setDraft(...)` call right after adds `mediaType: 'image'`; `renderSignup`'s `DreamStore.adoptPendingGeneration(pendingOperationName, pendingStartedAt, assembled.caption, chosenStyle)` call gets a 5th arg, `'image'`. Copy change at line 893 (§6).
9. **`processing.html`** — media-type-aware copy (title/subtitle/checklist captions) and dispatch (`generateImage` vs `generateVideo`, `regenerateDream` with `mediaType` forwarded) — see §5/§6 for exact copy. Fail-screen E-code match extends to recognize `E412` (image insufficient-tokens) alongside `E112` (video), routing both to "Get more tokens" → `shop.html`.
10. **`result.html`** — three-way media render (`videoUrl` → existing `<video>`; else `imageUrl` → new `<img>` in the same panel position; else existing gradient fallback), plus the new "Turn this into a video" CTA (§6) and its tap handler (routes through `processing.html`, reusing the exact existing "Generate Again" pattern — no new inline long-wait state needed).
11. **`style.html`** — the image-vs-video picker for return users (§5), placed directly above the existing "Generate Video" button, plus dynamic button label / `modal-quota` copy / token-threshold check.
12. **`explore.html` / `profile.html`** — feed-card media rendering becomes three-way (video → image → gradient, was two-way); tag-row's duration chip (`d.dur`) is only rendered when truthy (an image dream never sets `dur`, so this guards the existing unconditional render — `explore.html:173`, `profile.html:291`).
13. **`js/icons.js`** — add one new small inline SVG icon for "video"/"turn into video" (no existing icon fits; the codebase has no image/film/camera icon today, confirmed by grep) — a simple film-strip or play-in-a-frame icon, same 24×24/`currentColor` conventions as every other entry in this file.

## 5. Flow — the image-vs-video picker (return/non-first-run users)

**Where it lives:** `style.html`, directly above the existing `#generate-btn` (currently hardcoded "Generate Video"). This is the one canonical picker surface in the app — `create.html`'s three entry choices (Build it / Write it / Record it) and the wizard's own logged-in retrofit all funnel into `style.html` for the final style + media-type + Generate step, so this single change covers every return-user creation path. `result.html`'s "Generate Again" (Edit sheet) deliberately does not get its own picker — it regenerates in whatever `mediaType` the dream already has; changing media type mid-edit is treated as "start a fresh dream" instead (use "Make another dream" → `create.html`, out to `style.html`'s picker there). This is a stated scope simplification, not an oversight.

**Default:** "Video" pre-selected — existing users see zero behavior change unless they deliberately pick Image.

**Interaction (two directions — human picks, see §9):** either a two-pill segmented toggle or two full-width priced buttons; either way, selecting updates: the primary button's label ("Generate Video" / "Generate Image"), the token-threshold check (100 vs 10), and the `modal-quota` body copy.

**Copy (image selected):**
- Button: `Generate Image`
- `#modal-quota` body: `Generating an image costs 10 tokens. Free during beta — no card needed — you'll get 100 more automatically within 24 hours.`
- (Video-selected copy is the existing, unchanged text.)

**Edge cases:**
- Insufficient tokens for the selected type → existing `modal-quota` flow, unchanged mechanism, just the right copy/threshold for whichever type is selected.
- Network/submission failure → existing `processing.html` fail screen, unchanged mechanism (E-code driven).

## 6. Flow — onboarding pivot (`wizard.html`, first entry)

**Today:** Step 7 (contact capture) fires `start-pending-generation.js` requesting a video the instant email is captured, in parallel with Step 8 (signup); `processing.html` polls and redirects to `result.html`.

**New:** identical structure, image instead of video:

1. Steps 1–6 (Subject/Setting/Action/Mood/Style/optional free text) — unchanged, no copy or logic changes. Style still applies as a valid image-prompt modifier (`buildImagePrompt` reuses the same `STYLE_MODIFIERS` map).
2. Step 7 (contact capture) — unchanged UI, but the fetch to `start-pending-generation.js` now sends `mediaType: 'image'` (§4.8). Because flux/dev typically completes in low single-digit seconds (not the 1–6 minutes video needs), the generation is very likely already done, or finishing within a couple of seconds, by the time the user finishes typing a username/password on Step 8 — no user-perceived wait is expected in the common case.
3. Step 8 (signup) — copy change at line 893: `Free to start — 200 tokens on signup, no card needed.` → `Free to start — your first 2 dream images are on us, no card needed.` (framing in "images," not a raw token count the user has no context for yet). On success: `adoptPendingGeneration(..., 'image')`, redirect to `processing.html` — unchanged mechanism.
4. `processing.html` — reads `mediaType` off the pending job / draft:
   - **Title:** `Turning your dream<br>into a picture…`
   - **Subtitle:** `Image generation only takes a few seconds.`
   - **Checklist captions** (new `IMAGE_CAPTIONS` array, replacing `CAPTIONS` for this path): `['Painting the scene…', 'Rendering the light…', 'Adding detail…', 'Almost dreaming…']` — deliberately drops "Adding motion…" and "Composing the soundtrack…" (neither applies to a still image).
   - Calls `DreamStore.generateImage(...)` instead of `generateVideo(...)`.
   - Fail screen: unchanged mechanism, `E412` (image insufficient-tokens) added to the "route to shop.html" E-code match alongside `E112`.
5. `result.html` — renders the image (`<img>`, new element, same panel position as `result-video`); the "Turn this into a video" CTA appears automatically here since `dream.imageUrl` is set and `dream.videoUrl` is not — no separate onboarding-specific UI needed, this is the same CTA every image-type dream gets (see below). This is the upsell moment landing exactly where the founder's brief wants it: "right after an image is created."

**"Turn this into a video" — exact spec:**

- **Where:** `result.html`, directly below the caption/tag row, above the existing `action-row-compact` (Edit/Save/Publish/Delete) — the single most prominent action on the screen. Shown only when `dream.imageUrl && !dream.videoUrl`.
- **Copy:** `Turn this into a video` with a small cost pill next to it, `100 tokens` (same visual pattern as the existing `interp-cta-btn`'s `<span class="feed-tag">Private</span>` pill) — cost is visible before tapping, not a surprise.
- **Style:** `.btn.btn-warm.btn-block` — the same accent-warm class already used for `Publish`, i.e. this app's existing visual convention for "the one emphasized action on this screen."
- **Tap behavior:** checks the existing client-side `tokenStatus` pre-check (already fetched on this page for the Edit-sheet's own quota check); if < 100, opens the existing `#modal-quota` (its current copy, "Generating a video costs 100 tokens...", already reads correctly for this trigger, no change needed). If enough tokens: sets `DreamStore.setDraft({ caption: dream.caption, style: dream.style, sourceDreamId: dream.id, sourceImageUrl: dream.imageUrl, mediaType: 'video', restore: false })` and navigates to `processing.html` — exactly mirroring the existing "Generate Again" (`proceedWithGenerateAgain`) pattern, reusing the full-screen progress/fail-state machinery already built and tested rather than inventing a new inline long-wait spinner on `result.html`. Since `mediaType` is `'video'`, `processing.html` naturally renders the existing video copy/checklist — no special-casing needed there.
- **Server side:** `regenerateDream` forwards `opts.sourceImageUrl` into the `generate-video.js` call; that handler routes to the reactivated `callFalImageToVideo` (§4.6), passing `dream.imageUrl` (fal's own hosted URL from the original image generation) straight through as `image_url` — no re-hosting/new storage needed, per fal's ≥7-day retention (§2a).
- **On success:** `finalizeDream` is called with `sourceDreamId = dream.id`, `mediaType: 'video'` — upgrades the existing dream record in place (same id): `videoUrl` gets set, `imageUrl` is kept (provenance — not required for v1 UI, but free to keep), `mediaType` flips to `'video'`, so it renders as a normal video dream everywhere from then on.
- **Known limitation, flagged (not silently dropped):** if a user's "Me" character was set up via photo only (no text description) before ever reaching Step 7, the auto-generated first-run image cannot reflect their likeness — `flux/dev` is pure text-to-image, no photo-conditioning support, unlike the video path's `reference-to-video` model. `buildImagePrompt` therefore omits the "the dreamer appears as shown in reference photo" pointer line entirely for the image path (a pure text prompt referencing a photo the model never sees would just confuse it). The subsequent "Turn this into a video" call still correctly uses the real self-photo via `reference-to-video`'s own existing flow if the user has that character selected again on a later, separate video generation — but note that `sourceImageUrl`'s `callFalImageToVideo` path and the self-photo `reference-to-video` path are two different fal calls and mutually exclusive per request in this spec (a "turn this into a video" call is always the image-to-video path, never blended with a separate self-photo reference in the same call). If this gap proves to matter in practice (real users complaining their auto-image doesn't look like them), a later pass could investigate flux's image-conditioning variants (e.g. `flux-pro/kontext` or a redux/img2img flow) — explicitly out of scope for pass 1.

## 6-revised — ACTUAL onboarding flow to build (Ron's correction, 2026-07-24)

Supersedes §6 above. **`wizard.html`'s first-entry flow is NOT changed at all** — Step 7 keeps sending no `mediaType` (or an explicit `mediaType: 'video'`) to `start-pending-generation.js`, exactly as it does today; the copy at line 893 is untouched; `processing.html`/`result.html` render the wizard's output exactly as they do today. New users still get a real free video as their first-touch "wow" moment.

What's actually new for a first-time user: once they land on `result.html` with that free video, there is **no** "Turn this into a video" CTA (that only shows for `imageUrl && !videoUrl` dreams, and their dream already has a video) — nothing changes on their very first result screen. The image-generation feature becomes available to them the next time they create a *new* dream and reach `style.html`, where the §5 picker (segmented toggle, Video pre-selected) lets them choose Image for 10 tokens instead of Video for 100 — this is the only place `mediaType` becomes a real user choice anywhere in the app. §4's file list is unchanged except item 8 (`wizard.html`) is **dropped entirely** — no wizard.html changes ship in this build.

## 7. Explicitly out of scope for this pass

1. **Image storage/hosting beyond fal's own ≥7-day retention.** No Netlify Blobs re-hosting of generated images in pass 1 — flagged as its own future decision if longer-than-7-day persistence (e.g. permanently published Explore images, or a "turn into video weeks later" use case) is ever needed. If this becomes real, it's a small additive change mirroring `video-status.js`'s dormant `checkVeoStatus` Blobs-download pattern, not a redesign.
2. **The dream-webhook.js / pending-dreams re-engagement email/WhatsApp flow, for the image path.** `start-pending-generation.js`'s `mediaType: 'image'` branch deliberately does not pass a `webhookUrl` to the fal submission — `dream-webhook.js` is never invoked for images. Reasoning: that whole webhook + Resend email + WhatsApp machinery exists specifically to recover from a user abandoning the wizard during the 1–6 minutes a video takes; `flux/dev` typically finishes in low single-digit seconds, almost always faster than the realistic time a user takes to type a username and password on the very next screen. Building/wiring the full async-recovery path for a window that's this narrow is disproportionate. The pending-dreams record is still created (for email/WhatsApp durability, matching this flow's other retention purpose), it just never transitions past `'pending'` for image-mode records today — a documented, intentional dead end, not an oversight. If real usage data later shows meaningful image-generation abandonment, wiring images into the existing webhook path is a small, additive follow-up (add an image branch to `dream-webhook.js`'s success-payload check, alongside the existing `payload.video.url` check).
3. **A discounted "upgrade" price for turning an image into a video.** Flat 100 tokens, same as any other video, no loyalty/bundle discount — flagged as a possible future lever, not built now.
4. **A media-type picker on `result.html`'s "Generate Again" (Edit sheet).** Regenerating keeps the dream's existing `mediaType`; switching type is treated as starting a fresh dream via "Make another dream" instead.
5. **Photo-conditioned image generation** (the "Me + photo" limitation in §6) — flagged as a candidate follow-up, not attempted here.
6. **`flux/schnell` as the default model.** `flux/dev` is the pass-1 default for quality on this "wow" first-impression moment; `schnell` is documented as a one-line-swap cost lever if Ron wants to cut cost further later.

## 8. Confirmed by Ron (2026-07-24) — no longer open

- ~~`INITIAL_GRANT: 200 → 20`~~ — **superseded, see §2b-revised: `290`**, paired with `DAILY_GRANT_AMOUNT: 100 → 10`. Confirmed explicitly.
- ~~Which design direction (§9)~~ — **Direction A (segmented toggle), confirmed explicitly.**
- **`flux/dev` vs `flux/schnell`** as the default image model — still open, not asked. `dev` is recommended for quality on the "wow" first-image moment given both are negligible cost next to video; build proceeds with `dev` as the default, flag to Ron if a cheaper default is wanted later — this one lever doesn't block the build.

## 9. Design direction — the image-vs-video picker (`style.html`) — Direction A confirmed

Both directions share every backend/copy/token spec above; they differ only in the picker's interaction pattern on `style.html`. Both are grounded in real, current app patterns researched today (2026-07-24), not a from-memory guess.

### Direction A — Segmented toggle (state-then-commit)

A small two-pill segmented control, reusing this app's own existing component verbatim: the `.char-mode-row`/`.char-mode-btn` pattern already shipped twice in this codebase (`result.html`'s and `wizard.html`'s Describe/Upload-photo toggle for a "Me" character). New instance, same visual language, new class names (`.media-type-row`/`.media-type-btn`) to avoid cross-page coupling:

```
┌─────────────────────────────┐
│  [ Image ]   [ Video ● ]    │   ← segmented pill, Video pre-selected
├─────────────────────────────┤
│      Generate Video          │   ← single primary button, label/cost
└─────────────────────────────┘     react to the toggle
```

Tapping "Image" flips the toggle state, relabels the single button, and updates the token-cost copy beneath it — the button itself never changes position or count.

**Grounded in:** Higgsfield's "Photography Mode / Videography Mode" instant toggle (a current, named consumer AI-creation app pattern, confirmed via 2026 research) and the broader current pattern of a distinct "mode" selector (text-to-video / image-to-video / video-to-video) that most current AI video tools now surface as a toggle rather than separate screens. Also: this app's own established segmented-pill component, reused rather than reinvented.

**Tradeoff:** lower visual footprint, one extra tap to change state before the (unchanged-position) primary action — fits neatly into `style.html`'s already-dense layout without adding new vertical space for a second full CTA. Cost: the price difference is one small line of copy, not immediately as visually loud as two full options side by side — a rushed tap could miss which mode is active before hitting Generate. Pick this if minimizing layout disruption to an already-shipped, tested screen matters more than maximizing price visibility.

### Direction B — Two distinct priced buttons (no toggle state)

Instead of a toggle + one button, two full-width stacked buttons, each its own complete choice — no separate state to track, the tap is the choice:

```
┌─────────────────────────────┐
│   Generate Image             │
│   10 tokens                  │
├─────────────────────────────┤
│   Generate Video              │
│   100 tokens                 │
└─────────────────────────────┘
```

**Grounded in:** this app's own `token-pack-card` component (`shop.html` — two stacked cards, each showing an amount + a price + its own CTA), reused here as "which output" cards instead of "which pack to buy" cards — genuinely the closest existing internal precedent, not an imported pattern. Also matches how Freepik AI Suite and Leonardo.ai treat image and video as separate, differently-priced creation modes rather than one generator with a settings toggle (confirmed via 2026 research on both products' current create flows).

**Tradeoff:** price and choice are both fully visible with zero hidden state — no way to accidentally generate the wrong type. Cost: doubles the primary-CTA vertical space on a screen that's already reasonably full (style grid + advanced section above it), and is a net-new visual pattern for this specific screen (even though it borrows a component that already exists elsewhere in the app). Pick this if making the price tradeoff unmissable at the exact decision moment matters more than a compact footprint.

**Recommendation:** Direction A is the lower-risk pick for a first ship (smaller diff, reuses a component in the same context — a "which sub-mode" toggle — it's already used for), Direction B communicates the cost tradeoff more assertively at exactly the moment it matters most (which may matter more here than most features, since the entire feature's premise is "make the cost tradeoff felt"). Real tradeoff, not a false choice — Ron should pick.

## 10. Files read to ground this spec

`AGENT_POLICY.md`, `FOUNDER_PRINCIPLES.md`, `netlify/functions/generate-video.js`, `netlify/functions/lib/entitlements.js`, `netlify/functions/video-status.js`, `netlify/functions/start-pending-generation.js`, `netlify/functions/lib/pending-dreams.js`, `netlify/functions/dream-webhook.js`, `netlify/functions/claim-pending-generation.js`, `wizard.html`, `create.html`, `style.html`, `processing.html`, `result.html`, `shop.html`, `explore.html`, `profile.html`, `js/store.js`, `js/icons.js`, `docs/EVENT_TAXONOMY.md`.

---

*Design pass completed 2026-07-24. Backend/token-economy portion is buildable now; the `style.html` picker (§9) waits on Ron's direction pick.*
