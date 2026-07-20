# Agent Policy — DreamTube Product-Improvement Workflow

This repo uses a six-agent pipeline for ongoing product improvement:
**research → evaluation → design → build → review**, plus a standing
**ab-test-creator** agent that closes the loop on live experiments after
launch. This document is the single source of truth for (1) what that
pipeline looks like end to end, and (2) exactly when a human has to
approve something versus when an agent can just proceed on its own.
`CLAUDE.md` points here so every agent picks this up automatically at
the start of a session in this repo.

## The six agents

| Agent | Scope | Location | Job |
|---|---|---|---|
| research | user-level (portable) | `~/.claude/agents/research.md` | Generates and researches feature/marketing ideas |
| evaluation | user-level (portable) | `~/.claude/agents/evaluation.md` | Scores and ranks ideas using RICE |
| design | user-level (portable) | `~/.claude/agents/design.md` | Turns an approved idea into a spec + UX options |
| build | **project-level** | `.claude/agents/build.md` | Implements an approved idea + design, on a branch |
| review | **project-level** | `.claude/agents/review.md` | Independently checks build's finished work |
| ab-test-creator | **project-level** | `.claude/agents/ab-test-creator.md` | Reads concluded PostHog experiments, builds the next challenger variant on a branch |

research, evaluation, and design are generic and portable — they aren't
DreamTube-specific, are available in any project, and are distributed
via the `agent-library` Claude Code plugin marketplace (see below) so
they're easy to bring into a new environment. `build` and `review` are
both tied to this repo specifically: doing either job well requires
knowing this codebase's actual structure and conventions (its account-
scoping gotchas, its error-code scheme, its testing patterns), not
generic engineering knowledge.

## Getting research / evaluation / design in a new environment

These three are published as a plugin in the `agent-library` GitHub
repo (`ronbrightman/agent-library`), structured as a proper Claude Code
plugin marketplace. In any new environment:

```
claude plugin marketplace add ronbrightman/agent-library
claude plugin install product-agents@agent-library
```

That's it — no manual file copying. See that repo's README for details.

## Workflow

Run manually, on demand — there is no scheduled or automatic triggering
of this pipeline (yet).

1. **research** generates feature/marketing ideas.
2. **evaluation** scores and ranks them (RICE-based — see its own instructions).
3. **Human reviews the ranked list and picks what to pursue.** ← approval gate
4. **design** produces a product spec plus 1-2 visual/UX directions for the chosen idea.
5. **Human approves a design direction.** ← approval gate
6. **build** implements the approved idea + design on a feature branch, autonomously.
7. **review** independently checks build's finished work.
8. If review fails it, build fixes the flagged issues and resubmits; review re-checks.
   Repeat until review passes. **This build ↔ review loop is fully autonomous —
   no human needed in between.**
9. **Human approves the final merge to `main` / anything going live.** ← approval gate

## Post-launch: the ab-test-creator loop

Once the onboarding funnel is live and PostHog experiments are running,
`ab-test-creator` closes a separate, ongoing loop: check whether a live
experiment has concluded with a declared winner, and if so, build the
next challenger variant to test against it, on a branch, grounded in the
onboarding-funnel research doc's already-identified A/B candidates.

**Currently requires per-variant human approval before anything it builds
goes live** — the founder has said they may grant it standing autonomy
later, but hasn't yet. Don't treat a later invocation as blanket
permission unless it explicitly says so. This isn't scheduled/automatic
yet either — it needs a live PostHog account with real experiment data
before a recurring check is worth running at all.

## Never spend real generation cost on testing

By default `generate-video.js` has no cheap path — every call that reaches
fal.ai is a real, full-price fal.ai Veo 3.1 Fast generation (~$0.80-1.60/
call at the hardcoded 8s duration). This was hit for real during this
pipeline's own work: verifying a production fix required one real paid
call, and repeat testing (human and agent) across a session adds up fast
against a personal fal.ai balance.

**No agent (build, review, ab-test-creator, or the orchestrating session
itself) may trigger a real call to `generate-video.js` — on production or
locally with real `FAL_KEY` credentials — for testing or verification
purposes, without explicit human confirmation first.** A free, zero-cost
mock/stub generation mode now exists for exactly this — see
`GENERATION_MOCK_MODE` and `docs/TESTING.md` — and should be the default for
all routine flow/UI/integration testing; no approval is needed to use it,
since it never touches fal.ai at all. If a change genuinely can't be
verified without a real generation (e.g. confirming fal.ai's actual API
contract hasn't changed), stop and ask before spending the money — don't
assume it's fine because it's "just verification." Once approved,
`GENERATION_TEST_DURATION` (also documented in `docs/TESTING.md`) lets that
approved real call run at the shortest duration fal actually supports
(4s) rather than the full 8s, cutting the approved spend roughly in half —
it is not a substitute for asking first, only a way to reduce the cost of
a real call that's already been approved.

## Escalation policy — when a human has to approve something

Everything else in the pipeline runs without stopping to ask. These five
things always require explicit human approval, no exceptions, regardless
of which agent hits them:

- **(a) Choosing a design or creative direction** — design proposes
  options; a human picks between them.
- **(b) Choosing between service/vendor providers** — e.g. which email
  provider, which analytics tool, which payment processor. Present the
  tradeoffs; don't decide unilaterally.
- **(c) Creating any account or signing up for any service** — flag the
  need and stop; don't assume it'll get handled later.
- **(d) Anything flagged as a security or meaningful cost risk** — e.g. a
  change touching auth/secrets, a new recurring paid API dependency,
  anything that could expose user data or spend real money at scale.
- **(e) Merging any branch into `main`, or anything going live** — build
  and review never merge. That is always the last, human-triggered step.

**Implementation itself does not require approval** as long as it stays
confined to a feature branch and is reversible — writing code, running
it, testing it, committing it, pushing it to a branch. build and review
cycle autonomously without pausing for a human in between.

## For agents reading this

If you're research, evaluation, design, or review and you're running
inside a project that has this file: follow it. If you're running in a
project that doesn't have an `AGENT_POLICY.md`, apply the same
principles by default — implementation can proceed autonomously on a
branch; anything irreversible, costly, or requiring an external
account/decision needs a human, even without a written policy telling
you so.

If you're build: this file is always at the repo root next to you.
Read it before you start every run.
