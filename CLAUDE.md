# DreamTube

Static multi-page site (no build step, no ES modules) + Netlify Functions
backend, using fal.ai (Veo 3.1) for AI video generation, `js/store.js` as
a localStorage-backed fake client-side "backend" for auth/state, and
Netlify Blobs for the real cross-browser shared feed. See `README.md`
for the fuller technical rundown.

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
4. Current founder-priority order on next wake: mood-music candidate
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
