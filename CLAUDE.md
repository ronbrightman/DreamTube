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
