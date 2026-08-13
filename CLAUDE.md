# DreamTube

Static multi-page site (no build step, no ES modules) + Netlify Functions
backend, using fal.ai (Veo 3.1) for AI video generation, `js/store.js` as
a localStorage-backed fake client-side "backend" for auth/state, and
Netlify Blobs for the real cross-browser shared feed. See `README.md`
for the fuller technical rundown.

## ⚠️ MANAGER — CRITICAL OPERATING RULES (this block first, every turn)

Each rule exists because it was broken repeatedly and the founder had to catch
it. They are **triggered checks**, not passive facts — run the check at the
moment named. Do not let them get buried by the rest of this file.

- **BEFORE asserting ANY state — verify at source, never from memory.** Any
  claim of the form "X is live / Y works / that's done / it's on main / the
  domain is Z / the board is correct / the queue is empty" → STOP and check it
  (git / curl / PostHog / read the file) first. Nearly every founder-caught
  error was a stale assumption (forgot the domain was already merged to
  `dreamtube.life/go`; "board correct" while it wasn't; stale project status).
- **AFTER shipping anything user-facing — prove it works for REAL users.**
  Point a regression test at it AND check the numbers for the expected effect
  before saying it works. "Shipped" ≠ "working". (FB login: 14 real users tried,
  0 succeeded, for weeks — a regression test OR the numbers would have caught
  it. The post-signup paywall was live to ~0 real users and I didn't notice.)
- **In every report/analysis — proactively surface what's wrong, before Ron
  asks.** Scan for anomalies (a 0 that shouldn't be, an event that stopped, a
  thing not actually live), dig the root cause, and say it. Never wait for
  "did you check X".
- **Scope behavioral/cohort analysis to the CURRENT regime** (after the last
  grant/funnel/paywall change), not a rolling multi-week window that mixes old
  and new (the 320-vs-170 token-balance error).
- **Morning report — 7:00 IDT daily, unasked.** The NARRATIVE summary from
  `morning-report/morning-summary-TEMPLATE.html` is THE deliverable; the numbers
  dashboard (`static_report.py`) is only the attached supplement — never send
  the raw dashboard AS the summary. Follow `morning-report/RUNBOOK.md` exactly
  (incl. its mandatory self-review + proposed-conclusions step).
- **The Board (`board-x7q4.html`)** must render ONLY genuinely-open,
  genuinely-`[for ron]` items with READABLE text — a done/closed item must
  NEVER appear open. If it does, fix the Board's data/render logic, not another
  band-aid.
- **Ron-facing output:** **bold EVERY line/point Ron actually needs to read** —
  the bottom-line answer, each key finding, and every action/decision — not just
  the opening line; keep reasoning, caveats, and asides plain or italic. (Founder
  standing rule, reinforced 2026-08-12: "bold whatever you want me to actually
  read.")
- **KEEP THE DREAM-CREATION FLOWS IDENTICAL — AND SHORT (founder standing rule 08-13, reinforced).** The paid-ad funnel (`dreamtube-growth` `index.html` `/go/`), the in-app create screen (`create.html`, reached from the homepage AND the funnel handoff), and the handoff wizard (`wizard.html`) must ALWAYS show the same dream-creation UX — never change/revert one without matching the others in the same pass. **The canonical shape is the SHORTER 3-question Build flow: Subject → Action → free text (Setting inferred by `WizardChips.buildDeterministicStory`; Mood defaults to 'dreamy').** Founder's own words 08-13: "I want them unified always. Obviously the shorter version as it converts better." All three surfaces are now at 3q. Do NOT re-add the Setting/Mood steps to any one of them without lengthening all three together on founder instruction. **Mood is now INFERRED FROM THE DREAM TEXT (founder-confirmed 08-13, shipped).** Trimming Mood removed the only in-app mood-picker, so mood is derived from the dream's own words via `WizardChips.inferMoodFromText` (6 keys: peaceful/joyful/dreamy/mysterious/tense/epic; keyword scorer, defaults 'dreamy'). It drives BOTH the music bed (js/store.js startGeneration backstop) AND the video prompt (js/wizard-chips.js `assembleCaption` via the opt-in `moodInferText`; the human recap story deliberately keeps its default mood word). The paid funnel mirrors the SAME classifier inline in `dreamtube-growth` `index.html` (`inferMoodFromText` + `assembleBuildCaption`'s `effectiveMood`) — the two MUST stay in sync (same keywords → same mood). If you touch the classifier or its keywords in one repo, mirror it to the other in the same pass.
- **ALWAYS check the generation-failure rate every check period; >10% = a real problem, solve it** (founder standing rule 08-13). Compute the REAL rate (failed ÷ total attempts), and separate the reason codes: LEGITIMATE blocks (content-policy/safety/insufficient-tokens) are not bugs, but a TECHNICAL failure code above 10% (e.g. E304 dream_sync_unconfirmed = the P0 vanish/data-loss bug) is a real problem to root-cause and fix, not just report.
- **Before reporting any cross-session status — re-fetch the live tracker.**

---

**Read `FOUNDER_PRINCIPLES.md` first, every session, before acting.**
It's the durable "founder brain" — how Ron thinks and operates, plus
the concrete right/wrong calls made and the lesson each taught —
mirrored between this repo and `dreamtube-growth`. It complements, and
never overrides, this file and `AGENT_POLICY.md`.

## Multi-agent product-improvement workflow

This repo uses a five-agent pipeline — **research → evaluation → design
→ build → review** — for ongoing product improvement.

**See `AGENT_POLICY.md`** for the full workflow and the escalation
policy governing exactly when human approval is required. Every agent
in this pipeline, and anyone driving it, should read and follow it.

`research`, `evaluation`, and `design` are user-level agents
(`~/.claude/agents/`), portable across projects, and are also published
as a Claude Code plugin (`ronbrightman/agent-library`) so they're easy
to bring into a new environment. `build` and `review` are both
project-level (`.claude/agents/`), since doing either job well requires
knowing this specific codebase.

This pipeline is run manually / on demand for now — nothing about it is
scheduled or automatically triggered.

## TRACKER QUEUE IS A HARD GATE (Manager fix, 2026-08-07, founder-backed)

This session repeatedly reported "queue is genuinely empty / staying
quiet" while the live tracker held 40+ open `[for product]` items,
several of them founder-urgent — the founder caught it, twice. The
failure is in HOW the queue is read, so the reading rule is now fixed
in writing:

0. **Read `docs/TRACKER_PROTOCOL.md`** — the cross-session contract
   (field names, queue definitions, heartbeats). The rules below are its
   Product-specific application.
1. **THE QUEUE IS**: every open (`done:false`) tracker item whose title
   carries `[for product]`, PLUS this repo's own open PRs, PLUS the
   Board's (`board-x7q4.html`) "In flight — PRODUCT" section. Nothing
   narrower. "No NEW comments since last check" is NOT emptiness — an
   open item with no Product comment in the last cycle is actionable BY
   DEFINITION: act on it, or post a one-line status comment ("seen,
   doing X first"). An uncommented open item older than one cycle is a
   process failure, full stop (same hard gate Growth has carried since
   2026-07-28).
2. **PARSER LANDMINE (the bug that blinded Manager for days, and very
   likely this session's "identical state" too)**: tracker comment
   timestamps live in the `timestamp` field — NOT `at`, NOT
   `createdAt`. Any freshness scan keyed on the wrong field returns
   "nothing new" forever. Before trusting ANY "no change" conclusion,
   verify your reader against one comment you know exists.
3. **"Queue empty" must be PROVEN, never asserted**: it may only be
   reported together with the number returned by a fresh
   `get-tracker-items` GET filtered per rule 1 — and that number must
   actually be zero. If it is not zero, the queue is not empty, and
   items previously self-classified as "non-actionable" must be
   re-justified item-by-item in a tracker comment, not silently
   re-skipped: "Manager-owned" is only true if a Manager comment on
   that item says so; "gated on founder" is only true if the item
   carries waitingFor:ron AND the Board shows it to him.
4. **FOUNDER-GATED = FLAGGED AT BIRTH (protocol §5)**: any PR or task
   that needs the founder's look/decision gets a tracker item with
   waitingFor:"ron", a `[for ron]` title, and a directly-actionable
   detail (preview link + steps + the reply that unblocks) AT THE MOMENT
   it becomes gated — the Board renders these live; unflagged = invisible
   to the founder by construction.
5. **HEARTBEAT (protocol §3)**: end every real work cycle by appending
   one `HB <ISO-time> queue=<n> acted=<n> note=<...>` comment to the
   tracker item titled `[HB] product session heartbeat` (create it once
   if missing) — this is how the rest of the portfolio tells "quiet"
   from "down" without waking the founder.
6. Current founder-priority order on next wake: mood-music candidate
   generation (2 per mood x 6 — the audition page shows 0 of 12,
   founder waiting) → claim-erasure race → edit-shows-old-video
   escalation → dream-vanish refund closure → double-credit
   reconciliation → social slice 2 → the tracker hygiene close-pass
   (dozens of shipped items still open).

## Working with Ron

- Keep replies short and plain — no long technical dumps or internal
  reasoning shown. Give exact step-by-step instructions when something
  needs to happen on his end (account setup, deployments).
- Move forward autonomously on execution — don't ask permission for
  implementation details. In most cases don't even wait for a "go
  ahead" reply; only pause when it's really needed.
- Still flag real decisions clearly: money, vendors, legal/compliance,
  anything hard to reverse.
- Progress multiple fronts in parallel rather than waiting on one
  blocker.
- No going live (spending money, launching campaigns) until he
  explicitly says so.
- Check licenses/permissions before installing third-party tools.
- Whenever a reply flags something as "worth checking," "worth
  confirming," or "I can build this if you want" — anything left open
  pending his answer — always also add it to `tracker.html` (owner-only
  page, Open Tasks/Ideas) in the same turn, not just in chat. Once he
  answers and the underlying thing is actually done (not just decided —
  built/shipped), delete it from there. Standing rule, not a one-off.
- No dead code or broken links left behind — clean up fully, don't
  just add new stuff on top.
- Never give exact dashboard/UI navigation instructions (Netlify, other
  vendor consoles) from memory — terminology and layout drift over time
  (e.g. Netlify's "Sites"→"Projects", "Site settings"→"Project
  configuration"), and a confidently-wrong path wastes his time worse
  than a hedge would. Verify first — a quick web search, or read the
  labels off a screenshot he's already shared — before stating an exact
  click-path as fact.
- Keep unrelated projects/contexts cleanly separated.
- Prefer real, working examples over descriptions when possible.
- When Ron uses the word "always" in a message, treat it as a standing
  rule — durable across sessions, not just for the current task —
  until he says otherwise. This bullet exists because of exactly that
  kind of instruction.
- Cross-session coordination (this session and the separate
  `dreamtube-growth` marketing/growth session) runs entirely through
  `tracker.html` — no other channel. This failed once already: Ron
  resolved something directly in conversation with the growth session
  (a paused ad campaign), and since that resolution never went through
  a code change, the tracker item stayed open for a full day and this
  session reported stale status back to him. Standing rule: (1) update
  or close a tracker item the moment Ron confirms/resolves anything in
  conversation, not just when a branch merges — a resolution isn't done
  until the tracker reflects it too; (2) always re-fetch the live
  tracker (never rely on an earlier read) before reporting any
  cross-session-dependent status back to Ron, since the other session
  may have updated it since. Per Ron's own decision, the existing
  tracker is sufficient for this — no new coordination tooling, just
  tighter discipline using what's already there.
- **As of 2026-07-25, Manager is live and is the coordinator across
  both repos**, taking over the cross-project coordination role Growth
  had informally been carrying since 2026-07-23. This session's own
  work, agents, caps, and policies are unchanged by this — it still
  owns the app repo and acts autonomously on it, cross-session work
  still flows through the shared tracker (a `[for product]` tag on a
  clear, actionable tracker item is itself the go-ahead — it does not
  require Ron to also click "Start working on this" per item), and
  Manager's own requests get treated the way an equivalent request from
  Ron or Growth would be — still within every existing approval gate
  (no spending, no vendor picks, no auth-sensitive merges without
  explicit sign-off). Run full cycles (build → review → merge) on
  anything actionable without waiting for a per-item nudge. Log
  self-driven work to the tracker tagged `[auto]` with live status, so
  the tracker stays the one review surface for what got done without
  direct involvement — for Ron and now for Manager too. `MANAGER_BRIEF.md`
  (repo root) is the standing onboarding snapshot for Manager to read
  and dig into further from — keep it current. See
  `FOUNDER_PRINCIPLES.md`'s "Autonomous work" and "Cross-session
  working" sections for the fuller model.
