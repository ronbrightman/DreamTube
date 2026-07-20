---
name: "memory-status"
description: "Memory health dashboard showing line counts, topic files, capacity, stale entries, and recommendations for this project. Use when asked how full or healthy the self-improvement memory is."
---

# memory-status — Memory Health Dashboard

Quick overview of this project's memory state, adapted for the fact that
native Claude Code auto-memory is OFF here (`tengu_session_memory: false`
— see the parent `SKILL.md`). "MEMORY.md" below refers to the file this
loop itself maintains at the same path native auto-memory would use, not
something Claude Code wrote automatically.

## What It Reports

### Step 1: Locate the memory file

```bash
MEMORY_DIR="$HOME/.claude/projects/-home-user-DreamTube/memory"
mkdir -p "$MEMORY_DIR"   # safe to create — this loop owns this path
wc -l "$MEMORY_DIR/MEMORY.md" 2>/dev/null || echo "0 (doesn't exist yet — nothing captured so far)"
ls "$MEMORY_DIR/"*.md 2>/dev/null | grep -v MEMORY.md   # topic overflow files, if any
```

### Step 2: Analyze capacity

| Metric | Healthy | Warning | Critical |
|--------|---------|---------|----------|
| MEMORY.md lines | < 120 | 120-180 | > 180 |
| Topic files | 0-3 | 4-6 | > 6 |
| Stale entries | 0 | 1-3 | > 3 |

### Step 3: Also report on the six wired skill files

Since this loop's real destination for most promotions is one of the six
frozen skills, also report how much each has grown from this loop
specifically (not from the original frozen-copy content) — a skill file
that's absorbed 15 loop-driven edits since it was frozen is worth a
second look for consolidation, same as a crowded MEMORY.md:

```bash
cd /home/user/DreamTube
git log --oneline --grep="self-improving-agent: automated skill-learning commit" -- .claude/skills/superpowers .claude/skills/skill-security-auditor CLAUDE.md .claude/rules 2>/dev/null | wc -l
cd /workspace/agent-library
git log --oneline --grep="self-improving-agent: automated skill-learning commit" -- plugins/product-agents/skills 2>/dev/null | wc -l
```

### Step 4: Output

```
📊 Memory Status (DreamTube — auto-memory OFF, loop-maintained memory)

  Loop-maintained MEMORY.md:
    Lines:        {{n}}/200 ({{bar}}) {{emoji}}
    Topic files:  {{count}} ({{names}})

  Loop commits so far:
    DreamTube repo:      {{n}} (build/review skills, CLAUDE.md, rules)
    agent-library repo:  {{n}} (research/evaluation/design/marketing skills)

  Health:
    Capacity:     {{healthy/warning/critical}}
    Stale refs:   {{count}} (files/patterns no longer relevant)

  {{if recommendations}}
  💡 Recommendations:
    - {{recommendation}}
  {{endif}}
```

### Brief mode

`memory-status --brief` → `📊 Memory: {{n}}/200 lines | {{loop commits}} loop commits | {{status_emoji}} {{status_word}}`

## Interpretation

- **Green (< 60%)**: plenty of room, loop is working normally.
- **Yellow (60-90%)**: run `memory-review` to promote or clean up.
- **Red (> 90%)**: run `memory-review` now — new captures may start
  crowding out useful older ones.
