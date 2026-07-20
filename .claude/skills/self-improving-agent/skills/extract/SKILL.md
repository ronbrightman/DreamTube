---
name: "extract"
description: "Turn a proven pattern or debugging solution into a standalone reusable skill, when it doesn't belong inside one of the six existing frozen skill files. Use when a solution is broadly useful beyond DreamTube, or when the user asks to package a recurring solution into a new skill."
---

# extract — Create New Skills from Patterns

Most learnings from this project belong inside one of the six existing
frozen skills (use `promote/SKILL.md` for those). Use `extract` only
when a pattern is genuinely a new, standalone capability — not a
correction to how research/evaluation/design/build/review/marketing
already behave.

## When to Extract (vs. Promote)

| Signal | Use |
|---|---|
| Corrects/refines how one of the six existing skills should behave | `promote` |
| A genuinely new, reusable capability not covered by any of the six | `extract` |
| Would be useful in a project that isn't DreamTube at all | `extract` |
| Non-obvious, took real debugging effort to discover, broadly applicable | `extract` |

## Workflow

### Step 1: Identify the pattern

Read from `memory-review`'s candidates, or the user's direct description.

### Step 2: Determine scope and name

Ask (max 2 questions) only if genuinely unclear. Naming rules (unchanged
from upstream):

- Lowercase, hyphens between words, 2-4 words.
- **Reserved fragments — must NOT appear in the name:** `claude`,
  `anthropic`. For skills about Claude Code itself, use `cc-` instead
  (`cc-settings`, not `claude-code-settings`).

### Step 3: Decide where the new skill lives

- Useful specifically to one of the six existing agents' job → put it in
  that agent's tier: user-level (`~/.claude/skills/`) for
  research/evaluation/design/marketing, project-level
  (`.claude/skills/`) for build/review — and add it to that agent's
  `skills:` frontmatter.
- Genuinely general-purpose, not really any of the above → project-level
  `.claude/skills/` is still the right default here (DreamTube-specific
  origin), unless the user explicitly asks for it to be portable, in
  which case treat it like the other four portable skills (both
  `~/.claude/skills/` and the `agent-library` repo).

### Step 4: Create the skill files

```
<skill-name>/
├── SKILL.md            # Frontmatter + content, matching this repo's
│                        # existing NOTICE.md/LICENSE convention if the
│                        # source material came from a frozen third-party
│                        # skill; plain if it's purely DreamTube-derived.
└── reference/           # (optional) supporting docs, only if genuinely needed
```

Keep it proportionate — a two-paragraph learning doesn't need a
reference/ folder.

### Step 5: Quality gates

- [ ] Valid YAML frontmatter with `name` and `description`
- [ ] `name` matches the folder name, no reserved fragments
- [ ] Description includes "Use when:" trigger conditions
- [ ] Self-contained — makes sense without this session's context
- [ ] No hardcoded secrets, paths outside this repo's own conventions

### Step 6: Commit through the guarded script

```bash
.claude/skills/self-improving-agent/scripts/self_improve_commit.sh \
  <repo-dir> \
  "add <skill-name> skill: <one-line reason>" \
  <path/to/new/skill/files...>
```

Same rule as `promote`: never any other commit path, never includes
`AGENT_POLICY.md`, non-zero exit means stop and report, not retry.

### Step 7: Report

```
✅ Skill extracted: {{skill-name}}
Location: {{path}} ({{tier}})
Wired into: {{agent}}.md's skills: frontmatter (if applicable)
Commit: {{repo}} — {{hash}} "{{message}}"
```

## Tips

- This should be rare relative to `promote` — most real learnings are
  refinements to the six skills that already exist, not brand-new
  capabilities.
- Extract patterns that would genuinely save time in a *different*
  context, not just document what happened once here.
