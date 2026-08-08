# Scheduler wake-up anchor

This file exists only to explain [PR #`[scheduler]` Wake-up anchor — keep open,
never merge](../../pull/new/scheduler-anchor) and its companion workflow,
`.github/workflows/scheduler-ping.yml`.

**Why this exists** (tracker item `for-product-p1-your-work-loop-died-overn-jzru7c`,
founder-flagged, mirrors the identical fix already proven in the Manager repo —
see `ronbrightman/manager` PR #1 and its own `scheduler-ping.yml`): every
scheduling mechanism inside this Claude session — `CronCreate` jobs, and any
in-memory chain of `send_later`/Routine self-reschedules — is either
explicitly session-only (gone the instant the session ends) or, even where
nominally durable, has no way to *prove itself alive* from the outside. If the
whole self-rearming chain silently stops (a bad turn, a container recycle, a
missed re-arm), nothing notices until a human happens to check the transcript.

GitHub's own scheduled Actions run on GitHub's infrastructure, independent of
anything on our side. Each scheduled run posts one comment on the pinned
`[scheduler]` PR; this session is subscribed to that PR's activity via
`subscribe_pr_activity`, so the comment arrives as a real webhook event and
wakes the session even after a full restart — no session-side memory required.

**The PR itself must stay open and must never be merged or closed** — closing
it silences the scheduler. If it's ever closed by accident: reopen it, or open
a fresh PR whose title starts with `[scheduler]` (the workflow finds it by
that title prefix, not by PR number).

**On every wake from a ping** (or any other trigger): if `CronList`/the
session's own `send_later` state is empty, re-arm the regular work-loop cycle
FIRST, then do real work second — an empty scheduler state after a ping is
exactly the failure mode this anchor exists to catch.
