---
name: "promote"
description: "Graduate a proven pattern from loop memory into CLAUDE.md, .claude/rules/, or the specific frozen skill file (research, evaluation, design, build, review, marketing) it's actually about — committed via the guarded script. Use when a memory-review candidate should become a permanent, enforced change."
---

# promote — Graduate Learnings into Real Files

Moves a candidate identified by `memory-review` into one of four targets,
then commits it through `scripts/self_improve_commit.sh` so it's a
visible, single-purpose git commit — never a silent in-place edit.

**Hard rule, restated: `AGENT_POLICY.md` is never a target.** It isn't in
the table below on purpose. If a candidate seems to call for a change
there, stop, don't edit it, and say so in your summary instead — the
founder makes that change themselves when they want it.

## Step 1: Confirm the pattern and its scope

Read the candidate from `memory-review`'s output (or from `MEMORY.md`
directly if invoked standalone). Confirm which of the four target types
fits, using the tag from `remember` as a starting point but checking the
actual content — a `[research]` entry might really be about
`competitive-teardown` specifically, not `product-manager-toolkit`.

## Step 2: Pick the target

| Tag / scope | Target file | Repo to commit in |
|---|---|---|
| `[research]` | Whichever of `~/.claude/skills/{product-manager-toolkit,competitive-teardown,product-discovery,product-analytics}/SKILL.md` the entry is actually about | Both (see below) |
| `[evaluation]` | Same four as above, most often `product-manager-toolkit` (RICE) | Both |
| `[design]` | `~/.claude/skills/{frontend-design,ui-ux-pro-max,web-design-guidelines}/SKILL.md` | Both |
| `[marketing]` | `~/.claude/skills/{marketing-ideas,marketing-strategy-pmm,marketing-context,launch-strategy,competitor-alternatives,pricing-strategy}/SKILL.md` | Both |
| `[build]` | `.claude/skills/superpowers/skills/<relevant sub-skill>/SKILL.md`, or `.claude/agents/build.md` if it's about build's own conduct rather than a specific superpowers sub-skill | `/home/user/DreamTube` only |
| `[review]` | `.claude/skills/skill-security-auditor/SKILL.md`, or `.claude/agents/review.md` | `/home/user/DreamTube` only |
| `[general]`, project-wide | `CLAUDE.md` | `/home/user/DreamTube` only |
| `[general]`, scoped to specific files/paths | `.claude/rules/<topic>.md` (create with YAML `paths:` frontmatter if new) | `/home/user/DreamTube` only |

"Both" means: edit the live copy at `~/.claude/skills/<name>/` (what
Claude Code actually loads) AND the identical file at
`/workspace/agent-library/plugins/product-agents/skills/<name>/` (the
portable, git-tracked source), then run the commit script **only** in
`/workspace/agent-library` — the live copy under `~/.claude` isn't a git
repo, there's nothing to commit there, it just needs to match.

## Step 3: Distill into the target file's existing voice

Match how that specific file already writes things — most of these
skill files use imperative, terse instructions, not narrative. Look at
neighboring content in the same file for the pattern before writing.

**Before** (memory entry — descriptive):
> [evaluation] Founder wants engineering effort weighted ~50% of normal, personal/founder time weighted normally — check product-manager-toolkit's rice_prioritizer.py stays consistent with evaluation.md.

**After** (an addition to `product-manager-toolkit/SKILL.md` or a code
comment in `rice_prioritizer.py`, matching that file's existing
"Local customization" note style — see that file for the pattern already
established there).

Keep additions short — a line or a small paragraph, not a rewrite of the
whole file. Insert into the most relevant existing section rather than
always appending at the end.

## Step 4: Write the file(s)

Use `Edit` (or `Write` only if creating a new `.claude/rules/*.md`) on
the target path(s) from Step 2.

## Step 5: Commit through the guarded script — never any other way

```bash
# Project-level target (build/review/CLAUDE.md/rules):
.claude/skills/self-improving-agent/scripts/self_improve_commit.sh \
  /home/user/DreamTube \
  "<skill/file>: <what changed, one line>" \
  <path/to/edited/file>

# Portable target (research/evaluation/design/marketing):
.claude/skills/self-improving-agent/scripts/self_improve_commit.sh \
  /workspace/agent-library \
  "<skill>: <what changed, one line>" \
  plugins/product-agents/skills/<name>/SKILL.md
```

If the script exits non-zero, **stop** — don't retry with a different
file list to work around a block, don't attempt the commit any other
way. A non-zero exit here means the guard caught something; report it
plainly instead.

Example commit messages (short, specific, not "updated skill"):
- `product-manager-toolkit: note founder wants weighting changes flagged explicitly in output`
- `superpowers/systematic-debugging: add DreamTube's Blobs-consistency gotcha as a named example`
- `CLAUDE.md: record founder's standing preference for cheap-first generation testing`

## Step 6: Clean up the memory entry

Remove the promoted entry from `MEMORY.md` (it's no longer just a note —
it's now enforced). This file isn't git-tracked, so this is a plain edit,
no commit needed for it.

## Step 7: Confirm

```
✅ Promoted: {{one-line description}}

Target: {{file path}}
Commit: {{repo}} — {{commit hash}} "{{message}}"
Memory entry removed.
```

## Promotion Decision Guide

### Promote when:
- The pattern recurred, or was stated as an explicit standing rule.
- It's a correction the founder would be annoyed to have to repeat.
- It prevents a recurring mistake in how one of the six agents/skills
  behaves.

### Don't promote when:
- It's a one-time, session-specific detail with no future relevance.
- It might change soon (e.g. a preference stated as provisional).
- It's already covered by the target file's current content.
- It's actually about `AGENT_POLICY.md` — flag it to the founder instead,
  don't promote it anywhere as a workaround.
