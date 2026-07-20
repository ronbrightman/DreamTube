---
name: superpowers
description: Composable development-methodology skills — brainstorming, planning, TDD, systematic debugging, code review, git worktrees, subagent-driven development. Use for any non-trivial implementation task in this repo, before writing code.
---

# Superpowers (frozen copy)

This is a frozen, project-level copy of Jesse Vincent's `superpowers`
framework (`obra/superpowers`, MIT licensed — see `LICENSE`), for use by
DreamTube's `build` agent. It bundles 14 composable process skills under
`skills/`:

- `using-superpowers` — the entry point; read this first, it explains how
  and when to invoke the others.
- `brainstorming`, `writing-plans`, `executing-plans` — planning a feature
  before touching code.
- `test-driven-development`, `systematic-debugging`,
  `verification-before-completion` — the actual build/fix loop.
- `requesting-code-review`, `receiving-code-review` — the build ↔ review
  handoff, which in this repo maps onto the build/review agent loop
  described in `AGENT_POLICY.md`.
- `using-git-worktrees`, `finishing-a-development-branch` — branch
  hygiene.
- `dispatching-parallel-agents`, `subagent-driven-development` — for
  splitting work across subagents.
- `writing-skills` — for authoring new skills, not usually needed here.

**Read `skills/using-superpowers/SKILL.md` first** — it's the dispatcher
that tells you which of the others actually applies to what you're
doing, rather than loading all 14 up front.

**Frozen on 2026-07-20.** These are static copies, not a live plugin —
edit them directly in this repo if DreamTube's `build` agent needs a
convention to diverge from upstream.
