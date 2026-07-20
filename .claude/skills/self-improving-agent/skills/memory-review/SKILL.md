---
name: "memory-review"
description: "Analyze this project's loop-maintained memory for promotion candidates, stale entries, and consolidation opportunities across the six frozen skill files and CLAUDE.md/rules. Use when asked what's been learned and what should be promoted or pruned, or as step 2 of a reflection pass."
---

# memory-review — Analyze Captured Learnings

Audits the memory file this loop maintains (see `remember/SKILL.md`) and
produces promotion candidates specifically routed toward this project's
six frozen skill files, `CLAUDE.md`, or `.claude/rules/`.

**AGENT_POLICY.md is out of scope for this step entirely — don't open
it as part of this review.** It isn't a promotion target and reviewing
it isn't needed to do this job; leaving it untouched, including unread,
is the simplest way to guarantee it stays that way.

## Usage

```
memory-review                    # Full review
memory-review --quick            # Summary only (counts + top 3 candidates)
memory-review --candidates       # Show only promotion candidates
```

## What It Does

### Step 1: Read the memory file

```bash
MEMORY_DIR="$HOME/.claude/projects/-home-user-DreamTube/memory"
cat "$MEMORY_DIR/MEMORY.md" 2>/dev/null || echo "(empty — nothing captured yet, run remember's automatic mode first)"
```

### Step 2: Group entries by target

Each entry from `remember` is tagged `[research]`, `[evaluation]`,
`[design]`, `[build]`, `[review]`, `[marketing]`, or `[general]` (see
that skill's Step 3). Group by tag first — this is the main difference
from the stock skill, which only distinguished "promote to CLAUDE.md" vs
"promote to rules/".

### Step 3: Evaluate each group for promotion

An entry (or a cluster of related entries) is a real candidate when ALL
of these hold:

1. **Recurred or is clearly durable** — appeared more than once, or is
   an explicit, unambiguous standing instruction from a single strong
   correction (not every correction needs to repeat 3x if it was stated
   as a rule the first time — e.g. "no, don't ask me every time" is a
   rule immediately, not a pattern to wait and watch).
2. **Actionable** — can be written as a concrete instruction, not vague
   sentiment.
3. **Not already reflected** — check the target file (the relevant
   frozen skill's `SKILL.md`, or `CLAUDE.md`) doesn't already say this.
4. **Correctly scoped** — a `[research]`-tagged entry belongs in
   `~/.claude/skills/product-manager-toolkit/` (or whichever of the four
   research/evaluation skills it's actually about — check content, not
   just the tag), not in `CLAUDE.md`; a `[general]` entry belongs in
   `CLAUDE.md` or `.claude/rules/`, not in a skill file.

### Step 4: Check for staleness

- References a file/feature that no longer exists in this codebase
  (verify with `Glob`/`Grep`).
- Contradicts current `CLAUDE.md` or a skill file's current content
  (flag as a conflict, don't silently drop it — a human should see the
  contradiction).

### Step 5: Report

```
📊 Loop Memory Review

Memory Health:
  MEMORY.md:        {{lines}}/200 lines
  Untagged/general: {{count}}

🎯 Promotion Candidates ({{count}}):
  1. [research] "{{pattern}}" — seen {{n}}x
     → Target: ~/.claude/skills/product-manager-toolkit/SKILL.md
  2. [general] "{{pattern}}"
     → Target: CLAUDE.md
  ...

🗑️ Stale Entries ({{count}}):
  1. "{{entry}}" — {{reason}}

⚠️ Conflicts ({{count}}):
  1. "{{entry}}" contradicts {{file}}: {{detail}}

💡 Recommendations:
  - {{actionable suggestion, e.g. "run promote on candidate #1"}}
```

## When to Use

- As step 2 of a scheduled reflection pass (see parent `SKILL.md`).
- After a session with a notable correction or a repeated question.
- When `memory-status` shows the memory file is getting full.

## Tips

- Don't force a promotion every pass — "nothing new worth promoting" is
  a normal, healthy outcome, not a failure to find something.
- A single unambiguous rule from one strong correction can be promoted
  immediately; don't wait for artificial repetition on those.
