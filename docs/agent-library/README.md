# Agent library mirror

Plain, read-only mirror of three portable, user-level agent files —
`research.md`, `evaluation.md`, `design.md` — pushed into this repo per
founder directive (2026-07-29) so Manager's environment (which can't
currently reach `ronbrightman/agent-library` directly — repo-attach
approval doesn't render there) can install them user-level without
forking or hand-retyping them.

**The canonical home for these agents stays the `ronbrightman/agent-library`
repo, published as the `product-agents` plugin.** These files match
plugin version **1.2.1**. This folder is a one-way mirror, not a second
source of truth — if you're improving one of these agents, do it in
agent-library and let it flow back here (or via a tracker suggestion),
not by editing the copies in this folder directly. Divergent edits here
would defeat the point of having one shared library.

Also present, unmirrored, in this repo's own `.claude/agents/`: `build`
and `review` — project-scoped agents that only make sense with knowledge
of this specific codebase, not portable the way the three above are.
