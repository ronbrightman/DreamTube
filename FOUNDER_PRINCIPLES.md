# Founder Principles — how Ron thinks + what we've learned

**Read this at the start of every session, before acting.** This is the
durable "founder brain": Ron's entrepreneurial decision-thinking (solo
founder, former CEO of a gaming startup) plus the concrete right/wrong
calls we've made and the lesson each taught. It exists so a fresh session
starts already knowing how Ron operates and doesn't re-learn the same
lessons the hard way. It is mirrored in the product repo
(`ronbrightman/dreamtube`) — keep the two copies in sync (see "Cross-session"
below). Append here whenever a real, recurring lesson emerges; keep it
tight (curate, don't dump).

> This complements, and never overrides, `AGENT_POLICY.md` and `CLAUDE.md`.

---

## How Ron operates (the meta)

- **He makes the judgment calls; the agent does the building and grinding.**
  Founder-only: money, vendors, legal/compliance, opening accounts, pasting
  keys, design/product *vision*, and "does this match what I want" gut-checks.
  Everything else — analyze, decide, build, test, deploy, coordinate — is the
  agent's to drive. Don't pull him in step-by-step; surface decisions in
  batches. The stated goal: prove a single founder + Claude Code can run
  product + marketing + a self-improving loop.
- **Move fast, but notice when you're rushing and deliberately tone down.**
  Ron will say when to slow down; respect it. Rushing produced most of our
  wrong calls.
- **Reversibility is a first-class value.** Park, don't delete ("leave them
  for later to consider"). Prefer changes that are one step to undo.
- **"always" = a durable standing rule** across sessions until he says
  otherwise. Encode those immediately.
- **Vocabulary:** when Ron writes **"final" he almost always means "funnel."**

## Marketing & campaign management

- **Don't thrash a learning-phase campaign for small/short problems.**
  Pausing or budget-editing disrupts delivery/learning; for a quick fix that's
  only leaking a few dollars, fix it while it runs. Reserve pausing for large
  spend exposure or a prolonged outage. (Learned: I paused + dropped budget +
  resumed to save ~$2 on a ~10-min fix — three learning-disrupting edits for
  nothing.)
- **Budget is the lever for spend control** — not targeting, not the
  optimization event.
- **Broad targeting + strong creative** on a fresh account (Andromeda-era).
  Narrowing targeting early raises costs and slows learning; the creative is
  the targeting.
- **Optimize for a QUALITY event, never Landing-Page-Views.** LPV tells Meta
  "find the cheapest people who'll load the page" → low-intent, high-bounce
  taps. Optimize for real engagement/conversion (quiz-started, signup, first
  video). (Learned: LPV optimization produced 95% screen-1 bounce, median
  5-second sessions — accidental taps, not visitors.)
- **High CTR can be a trap.** Reels/Stories generate accidental swipe-taps.
  Judge on downstream engagement and dwell time, not CTR alone.
- **Get real traffic flowing early, even imperfect** — real users surface
  bugs and truths no amount of internal testing will.
- **Move the ad account into a Business early** and set up a durable
  system-user token. The personal-ad-account knot + expiring Explorer tokens
  cost us many rounds and blocked pixel-linking.

## Tracking, measurement & optimization (marketing-owned)

- **Never judge on contaminated data.** Segment out: the founder's own test
  sessions (exclude by geo — he's in Israel), pre-fix windows, and known-bug
  days. Look at post-change, real-user, US-only cuts.
- **Diagnose with the right metric, not the convenient one:** funnel-through
  (PostHog by session) over Meta clicks; **max-step-reached** to locate the
  drop-off screen; **dwell-time buckets** to tell accidental taps from real
  bounces. These three cracked the "why won't they convert" question.
- **Verify what's actually deployed on `origin/main`** before assuming a
  branch's state. (Learned: I assumed my branch had the fix; main was ahead —
  wrong diagnosis followed.)
- **Event plumbing must line up:** the ad-account pixel must match the pixel
  the app fires to; `FirstVideoCreated` is a *custom* event (shows under
  Custom Events, not standard); a conversion event can't be optimized until
  it's a real, firing, ad-account-linked pixel event with volume (~50/wk).

## Product & user flow

- **Get users to value FAST.** A 10-step funnel before the app is too long.
  Keep only what feeds the outcome (dream text + style); park the rest.
- **Lead cold traffic with the hook (the visual), not an explainer.** An
  explainer as screen 1 bounced 98%+; the hook does too if the *traffic* is
  low-intent, so also fix the traffic (above).
- **In beta: free, no card, free tokens** — kill payment anxiety. The goal is
  trials + bug-surfacing, not revenue yet. Say it plainly on the funnel.
- **Image-first cheap onboarding, upsell to video.** On first run, generate an
  *image* (cheap), and tune the initial token grant so ~2 images are free but
  a video (or more images) needs a purchase — cheap first "wow," upgrade
  moment exactly where intent peaks.
- **Retention must survive the Facebook in-app browser**, which wipes
  localStorage when the webview closes — the real problem is getting the user
  back on **day 2**. Two different jobs: (a) **social login
  (Google/Apple/Facebook)** = frictionless signup + persistent identity, and
  an easy way to capture the user's email; but it does NOT bring anyone back
  on its own. (b) The day-1→day-2 **return channel is email + SMS** —
  DECIDED in the product session. So **email is crucial here, not weak**: it's
  the outbound way to re-reach a user whose session is gone. **Update
  2026-07-23: Twilio SMS (A2P 10DLC) is blocked for a non-US/Canada solo
  founder without an EIN — do NOT fudge a personal/invalid tax ID to bypass a
  carrier check (rejection/ban risk). Lean on EMAIL (Resend, already wired) +
  WhatsApp (a WhatsApp Business asset already exists, far more
  international-friendly) + web push; revisit SMS only with a real registered
  entity.** (Meta-lesson:
  this decision was logged on the shared tracker by the product session and
  growth missed it by not skimming first — the exact sync gap the
  improvement-cycle closes. Always reconcile with the tracker/other repo
  before asserting a cross-session fact.)
- **Paid traffic is mobile, mostly the FB/IG in-app webview**, which is
  media-constrained. **Smoke-test the real funnel on a real phone in the
  in-app browser before pointing paid traffic at it** (DM yourself the link in
  Messenger/IG — that's the only faithful test; a UA override isn't enough).

## Creative

- Founder devises creative directions but reviews everything before upload.
- Expect many iteration rounds (legibility, seams, camera angle, skin tone,
  CTAs, audio). Reuse the locked footage; re-caption cheaply rather than
  regenerating.
- Prefer **footage-only Veo + ffmpeg captions + a music bed** over relying on
  AI-rendered text/audio (unreliable).
- Frame dreams as **visualized, never interpreted/therapeutic** (compliance:
  avoids reclassifying the ad account into restricted health advertising).

## Design & engineering process

- **Reuse proven components** over reinventing (e.g. the small-thumbnail video
  carousel from the processing page beat two rounds of a custom lazy slider).
- **Light media over heavy on mobile** — small thumbnails, poster-first,
  `preload="none"`, one video at a time; never block the flow on video.
- **Deploy-by-default, but reversible and surgical** — ship one file, verify
  it's live, keep the change easy to revert. Build → mobile-test (Playwright)
  → deploy → real-device retest.
- No dead code or broken links; parked code is clearly labeled, not orphaned.

## Product session's additions (engineering lessons)

- **Netlify Blobs has no compare-and-swap and no read-your-own-write-back
  guarantee.** A "verify what we just wrote by reading it back" check
  passes every test against the in-memory mock (perfect, synchronous
  consistency) and then breaks EVERY real write in production — a read
  right after a write isn't guaranteed to see it yet. This caused a full
  signup outage once already, and a second, narrower version of the same
  root cause (a stale, unhealed email index with no atomic guard) locked
  a real account out of both signup and login later the same week. Every
  Blobs-backed store that reads-mutates-writes should get the same
  bounded retry-and-verify pattern from day one, not added reactively
  after a real incident.
- **Watch for "an async callback's side effects aren't scoped to what
  triggered it."** This exact bug class (a stale resize/save/fetch
  resolving after the user's already moved on, silently overwriting
  newer state) has recurred across multiple unrelated features — check
  for it explicitly (a per-instance token/sequence guard) on every new
  async or optimistic-UI control, not just the one the current bug
  report names.
- **A plugin's version number is the only signal Claude Code's cache
  uses to refetch.** Real content changes that land without a version
  bump get silently stuck — a fresh environment installing the plugin
  gets stale content indefinitely, no error. Bump the version whenever
  real content changes, every time.
- **Two background build/review agents sharing one working directory
  can clobber each other's uncommitted state** (a branch switch from one
  stomping the other's in-progress edits). Dispatch to an isolated git
  worktree whenever more than one agent might touch the repo
  concurrently.

## Model selection (founder delegated this call 2026-07-23)

Default to the **cheapest model that does the job well**; reserve the strong
model for where quality genuinely pays off. Bias autonomous/background tasks
toward cheaper models (cost over speed — they run in the background).
- **Lead / main session (this one): Opus** — strategy, coordination, founder
  conversation, judgment calls. Highest leverage; keep quality high.
- **Autonomous subagents — default Sonnet** (the workhorse: build, review,
  research, creative orchestration) — strong quality at a fraction of Opus
  cost/time.
- **Haiku** for clearly mechanical/light autonomous work: data pulls,
  monitoring, status checks, triage, simple edits, tracker housekeeping.
- **Opus** only for subagents doing genuinely hard reasoning: novel design,
  security/compliance/high-stakes review, thorny strategy.
- Rule of thumb: **mechanical → Haiku; substantive build/verify/research →
  Sonnet; hard-reasoning or high-stakes → Opus.** Set the model EXPLICITLY on
  each Agent/workflow spawn — don't let background tasks silently inherit Opus.

## Business logic / monetization

- **Token economy** is the gating + monetization mechanism; tune grants to
  manufacture upgrade moments (see image-first above).
- Hard-paywall funnel model long-term; **free during beta** for now.
- Keep internal strategy docs out of the public site (they're 404'd in
  `netlify.toml`) — add new internal docs to that list.

## Cross-session working (growth ⇄ product)

- The **shared tracker** (`dreamtube1.netlify.app/tracker.html`, owner-gated
  API) is the live channel. Log anything open — including anything you're
  waiting on Ron for — the same turn. Tag items **`[for product]` /
  `[for growth]`** so each session acts on the other's on its next skim.
- **Don't clobber the other repo.** The app repo is the product session's;
  fetch `origin/main` and check before touching shared surfaces (tagline,
  tracking, CAPI, handoff contract).
- **This file is mirrored in both repos.** When either session graduates a new
  principle, update its copy AND post a `[for product]`/`[for growth]` tracker
  note so the other mirrors it.

## Autonomous work & the founder's review surface

The agent now runs full cycles on its own — ideation, research, evaluation,
building, implementing, testing, measuring, optimizing. So the founder can see
and react to that work in one place: **log self-driven work to the shared
tracker, titled with an `[auto]` tag, and keep its status current** (e.g.
`done` toggled, or a status note in the item). That makes the tracker the
founder's single review surface for "what did the agent do on its own." Also
**run these self-working cycles on the existing tracker backlog**, not just new
work — pick up open items you can own and move them. **Trigger phrase: when Ron
writes "check tracker", immediately GET the tracker and act on his latest
comments / `[auto]` feedback / new items** — his manual nudge for the async
review surface (the tracker doesn't push notifications; it's a mailbox you check).

## Improvement cycle (cadence)

Run the reflection pass **after each significant change — especially ones that
touch both sessions — and preferably when idle so it never blocks active
work** (not on a rigid clock). Each pass: (1) skim the tracker + the other
session's recent `[for X]` notes, (2) graduate any new recurring lesson into
this file / CLAUDE.md, (3) pick the single highest-leverage next fix from the
data, (4) coordinate on the tracker if it spans both repos. Founder steers
priorities; sessions execute and keep this brain current.

---

*Seeded 2026-07-23 from the first end-to-end launch session. Curate forward.*
