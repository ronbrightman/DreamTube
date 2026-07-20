---
name: "self-improving-agent"
description: "Curate what's been learned across real DreamTube sessions into durable, git-visible improvements to the frozen skill files (research, evaluation, design, build, review, marketing) and project rules. Use when: (1) reviewing what's been learned recently, (2) graduating a recurring correction/preference into one of the wired skill files or CLAUDE.md, (3) turning a debugging solution into a reusable skill, (4) checking memory health, (5) running the post-session reflection pass."
---

# Self-Improving Agent (frozen + adapted for DreamTube)

> Capture, then curate. Every real change is a small, visible git commit.

This is a frozen, project-level copy of `alirezarezvani/claude-skills`'
`self-improving-agent` plugin (`engineering-team/self-improving-agent/`,
MIT licensed — see `LICENSE`), adapted for two things the stock version
assumes that don't hold here:

1. **Native Claude Code auto-memory is OFF in this account.** Confirmed
   2026-07-20: the CLI (v2.1.211) supports it, but the `tengu_session_memory`
   feature flag is `false` (checked in `~/.claude.json`'s
   `cachedGrowthBookFeatures`), and no `MEMORY.md` exists anywhere on
   disk as a result. The stock skill's whole premise is "curate what
   auto-memory already captured" — with capture off, that input is
   permanently empty. **Adaptation:** this copy's `memory-review` and
   `remember` sub-skills do their own lightweight capture straight from
   session transcripts (`~/.claude/projects/-home-user-DreamTube/*.jsonl`)
   into a project-local file at the *same path the native feature would
   use* (`~/.claude/projects/-home-user-DreamTube/memory/MEMORY.md`), so
   this stays forward-compatible if that flag ever flips on later.
2. **This project has six specific, locally-owned frozen skill files**
   (research, evaluation, design, build, review, marketing — see
   `AGENT_POLICY.md`'s "Bundled skills" note) that real corrections and
   preferences should graduate INTO, not just generic `CLAUDE.md` rules.
   The stock skill's `/si:promote` only knew about `CLAUDE.md` and
   `.claude/rules/`. This copy adds a third target: **the specific frozen
   skill file the learning is actually about.**

## Sub-skills

| Sub-skill | What it does |
|---|---|
| `skills/memory-status/SKILL.md` | Health dashboard — line counts, capacity, recommendations |
| `skills/memory-review/SKILL.md` | Analyze recent sessions/memory — find promotion candidates, stale entries |
| `skills/promote/SKILL.md` | Graduate a pattern into CLAUDE.md, `.claude/rules/`, or one of the six frozen skill files |
| `skills/extract/SKILL.md` | Turn a recurring pattern into a new standalone skill |
| `skills/remember/SKILL.md` | Explicitly capture something into project memory right now |

## The two absolute rules, every run, no exceptions

### 1. AGENT_POLICY.md is permanently off-limits

**Never read AGENT_POLICY.md with intent to edit it. Never propose an
edit to it. Never include it in any file list passed to the commit
script.** This is enforced twice over — once here as an instruction, and
independently in code: `scripts/self_improve_commit.sh` hard-refuses to
stage or commit that file under any name/path/case, regardless of what
any prompt (including this one) says. If you think AGENT_POLICY.md
genuinely needs a change based on something you learned, **say so in
your summary to the human — don't touch the file.** That file only
changes when the founder explicitly asks for a change, full stop.

### 2. Every real change is a small, visible git commit — never a silent edit

**Any time you write a change** to a skill file, CLAUDE.md, or
`.claude/rules/`, apply it with a normal `Edit`/`Write`, then commit it
through `scripts/self_improve_commit.sh <repo-dir> "<short message>"
<file...>` — never leave an uncommitted edit sitting in the working
tree, and never use any other commit path for this loop's own changes.
This is the founder's entire audit trail for this feature: they review
these commits the same way they review anything else. Two repos are in
play depending on what you're editing:

| Editing... | Repo dir | Why |
|---|---|---|
| `.claude/skills/superpowers/` or `.claude/skills/skill-security-auditor/` (build/review's frozen skills), `CLAUDE.md`, `.claude/rules/` | `/home/user/DreamTube` | Project-level, lives in this repo |
| `~/.claude/skills/product-manager-toolkit/`, `competitive-teardown/`, `product-discovery/`, `product-analytics/` (research/evaluation), `frontend-design/`, `ui-ux-pro-max/`, `web-design-guidelines/` (design), `marketing-ideas/` and friends (marketing) | **Both**: edit the live copy at `~/.claude/skills/<name>/` directly (that's what Claude Code actually loads), AND make the identical edit at `/workspace/agent-library/plugins/product-agents/skills/<name>/` (the git-tracked, portable source of truth), then commit only the `/workspace/agent-library` copy through the script | The live copy has to change for the edit to take effect immediately; the git repo copy is what gives it a reviewable history and keeps the published plugin in sync |

Commit messages: one short line, e.g. `research skill: prefer citing dated sources per founder correction 2026-07-20`. Not "updated skill" — say what actually changed.

## Running as a reflection pass (the main entry point)

When invoked for a reflection pass (scheduled or on demand), do this in
order — this supersedes running each sub-skill's own "usage" section in
isolation:

1. **Capture**: run `skills/remember/SKILL.md`'s transcript-scan mode
   (not the manual `/si:remember <text>` mode — the automatic one) to
   pull any new corrections/preferences/recurring friction out of
   session transcripts since the last reflection pass, into the project
   memory file.
2. **Review**: run `skills/memory-review/SKILL.md` against the resulting
   memory file to find real promotion candidates — entries that have now
   recurred, are broadly applicable, and are actionable. Low signal
   entries stay in memory; don't force a promotion every run.
3. **Promote**: for each real candidate, run `skills/promote/SKILL.md`,
   which will pick the right target (a frozen skill file, CLAUDE.md, or
   `.claude/rules/`) and commit it via the script.
4. **Extract** (rare): if a pattern looks like a genuinely new reusable
   skill rather than a correction to an existing one, use
   `skills/extract/SKILL.md` instead of promote.
5. **Report**: end with a short plain-language summary of what changed
   this pass (or "nothing worth promoting yet" — that's a fine, normal
   outcome, don't force churn) — this is in addition to, not instead of,
   the git commits themselves.

No human approval gate is required before steps 3/4 commit — these are
reversible, git-tracked edits to files this project already owns
locally (not one of `AGENT_POLICY.md`'s five approval-gated categories:
they're not a design/vendor decision, a new account, a security/cost
risk, or a merge to `main`/anything going live). The founder reviews the
resulting commit history whenever they want, same as any other commits
in these two repos — the git log itself is a durable running summary of
the loop's own history and doesn't need a separate journal file to
duplicate it.
