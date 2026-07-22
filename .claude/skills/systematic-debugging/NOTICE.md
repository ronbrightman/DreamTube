Frozen copy of the `systematic-debugging` skill from `obra/superpowers`
(`skills/systematic-debugging/`), MIT licensed, copyright Jesse Vincent
2025. See LICENSE for the full text. Fetched verbatim on 2026-07-22:
`SKILL.md`, `root-cause-tracing.md`, `defense-in-depth.md`,
`condition-based-waiting.md`, `condition-based-waiting-example.ts`,
`find-polluter.sh`.

Not copied: `test-academic.md`, `test-pressure-1/2/3.md`,
`CREATION-LOG.md` — internal authoring notes for the skill itself, not
referenced by `SKILL.md` and not needed to use it.

**Adapted, not verbatim:** two references to sibling skills that aren't
part of this frozen copy (`superpowers:test-driven-development`,
`superpowers:verification-before-completion`) were replaced with
repo-neutral guidance, since those skills don't exist here and an
unresolvable skill reference would just be confusing.

This project deliberately did NOT freeze-copy the rest of the
`superpowers` framework (planning, TDD, code-review, git-worktree, and
subagent-dispatch skills, plus the `using-superpowers` dispatcher that
auto-selects among all of them). That full-framework ceremony was judged
redundant with this repo's own research → evaluation → design → build →
review pipeline and branch discipline (see `AGENT_POLICY.md`), and it's
designed to insert itself into every task — which conflicts with wanting
quick fixes to actually be quick. This skill is scoped in narrowly for
its root-cause-first debugging discipline specifically, and is listed in
`.claude/agents/build.md`'s `skills:` frontmatter so it's available on
every build run.
