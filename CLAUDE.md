# DreamTube

Static multi-page site (no build step, no ES modules) + Netlify Functions
backend, using fal.ai (Veo 3.1) for AI video generation, `js/store.js` as
a localStorage-backed fake client-side "backend" for auth/state, and
Netlify Blobs for the real cross-browser shared feed. See `README.md`
for the fuller technical rundown.

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
- Keep unrelated projects/contexts cleanly separated.
- Prefer real, working examples over descriptions when possible.
- When Ron uses the word "always" in a message, treat it as a standing
  rule — durable across sessions, not just for the current task —
  until he says otherwise. This bullet exists because of exactly that
  kind of instruction.
