Frozen copy of the `brainstorming` skill from `obra/superpowers`
(`skills/brainstorming/`), MIT licensed, copyright Jesse Vincent 2025.
See LICENSE for the full text. Fetched verbatim on 2026-07-22:
`SKILL.md`, `visual-companion.md`, `spec-document-reviewer-prompt.md`,
`scripts/` (frame-template.html, helper.js, server.cjs, start-server.sh,
stop-server.sh).

**Adapted, not verbatim:** references to the original framework's
`writing-plans` skill (its mandatory next step after a spec is approved)
were replaced with a hand-off straight to this repo's own build process,
since `writing-plans` isn't part of this frozen copy and an
unresolvable forward-reference would leave the process incomplete. The
default spec-doc path was also changed from `docs/superpowers/specs/`
to `docs/specs/`, since only this one skill was copied, not the folder
convention of the rest of the framework.

**Deliberately not auto-invoked.** Unlike `systematic-debugging`, this
skill is NOT listed in `.claude/agents/build.md`'s `skills:` frontmatter
— it's available for explicit, on-request use only (invoke it by name
when a task genuinely warrants thinking it through before building),
not something build reaches for on every task. This matches the same
reasoning as leaving out the rest of the `superpowers` framework: the
full "brainstorm before anything, always" ceremony conflicts with
wanting quick fixes to stay quick.
