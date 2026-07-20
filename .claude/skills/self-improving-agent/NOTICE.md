Frozen copy adapted from `alirezarezvani/claude-skills`
(engineering-team/self-improving-agent/), MIT licensed. See LICENSE for
the full text. Fetched 2026-07-20 (README.md, and skills/{self-improving-agent,
memory-review,memory-status,promote,extract,remember}/SKILL.md).

**This is a substantially adapted copy, not a verbatim freeze**, for two
reasons documented in full in this folder's own SKILL.md:

1. Native Claude Code auto-memory is off in this account
   (`tengu_session_memory: false`), so the sub-skills that assumed
   MEMORY.md would populate itself now do their own capture from session
   transcripts instead.
2. `promote`/`extract` are rewired to target this project's six specific
   frozen skill files (research/evaluation/design/build/review/marketing)
   as a first-class destination, not just CLAUDE.md/.claude/rules/ — and
   `AGENT_POLICY.md` is explicitly and permanently excluded as a target,
   enforced in `scripts/self_improve_commit.sh` (code-level, not just a
   written instruction).

Not copied from upstream: the `error-capture` PostToolUse hook and the
`memory-analyst`/`skill-extractor` subagents (the adapted skill files
here fold their responsibilities into the sub-skills directly instead of
spawning separate agents, to keep this simpler to audit).
