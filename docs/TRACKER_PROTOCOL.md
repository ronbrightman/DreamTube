# TRACKER PROTOCOL v1 — the one reading/writing contract for every session

Written by Manager, 2026-08-07, founder-directed ("too many communication
issues — find long lasting"), after one week produced THREE independent
reader bugs across sessions (Manager's dead freshness scans, Product's
"queue is genuinely empty" loop, duplicate work from an unannounced
takeover). The tracker is the right channel; every failure was in
reading it. This file is the contract. Product's and Growth's CLAUDE.md
both point here; change it only with a `[for product]`+`[for growth]`
announcement item.

## 1. Field names (the landmine that caused two of the three bugs)

- Item times: `createdAt`, `doneAt`, `startedAt`, `reviewedAt` (ISO strings).
- **Comment times: `timestamp`** — since 2026-08-07 the read endpoint also
  serves aliases `at` and `createdAt` on every comment (same value), so
  any of the three works. Writers still write only `timestamp`.
- Comment author: `author` ("ron" | "claude"). `commentAuthor` is the
  WRITE-side request field (update-tracker-item), not a stored field.
- Item body text: `detail` (not `description`).

**Parser self-test (mandatory before trusting any "no activity"
conclusion):** fetch the items, find one comment you know exists (the
decisions-log item always has recent ones), and assert your code
extracts a non-null time from it. A scan that returns "nothing new" for
days is guilty until proven innocent.

## 2. Queue definitions (what "my queue" means, per session)

- **Product**: every open (`done:false`) item titled `[for product]` +
  this repo's open PRs + the Board's "In flight — PRODUCT" section.
- **Growth**: every open item titled `[for growth]` (its CLAUDE.md
  hard-gate wording governs).
- **Manager**: `[for manager]` items (including the GROWTH DECISIONS LOG,
  which is a standing feed addressed to Manager) + everything the Board
  tracks.

"No NEW comments" is never emptiness. An open queue item with no
comment from its owner in the last cycle is actionable BY DEFINITION:
act, or post a one-line status. "Queue empty" may only be reported
together with the fresh fetched count, and that count must be zero.

## 3. Heartbeats (distinguishing "down" from "quiet" forever)

Each session, at the end of every real work cycle, appends ONE comment
to its own heartbeat item (create it if missing; title exactly):

- `[HB] product session heartbeat`
- `[HB] growth session heartbeat`
- `[HB] manager session heartbeat`

Comment format (one line): `HB <ISO-time-UTC> queue=<open count per §2>
acted=<items acted on this cycle> note=<≤10 words>`

Rules: reading a heartbeat costs one GET — check the counterpart's
heartbeat BEFORE ever reporting them silent/stalled to the founder. No
heartbeat for >12h = genuinely down (billing/session death — tell the
founder WITH that evidence). Heartbeat present but its `queue=` count
contradicts its behavior = reader bug on THEIR side — point them at §1's
self-test. Heartbeats are droppable noise otherwise: never act on them
as tasks, never let them page the founder.

## 4. Standing channels that already work (read these, don't duplicate them)

- Growth → Manager: GROWTH DECISIONS LOG item (`[for manager]`, 2h checks
  + `[NIGHTLY]` spend/CPS lines) and the standing spend item.
- Manager → founder: the Board (`board-x7q4.html`) — anything waiting on
  Ron MUST appear there with inline do-steps the same wake it's flagged.
- Takeovers: whoever takes over work routed to another session comments
  the takeover ON THAT ITEM within the hour (who, what exactly, what
  remains for the original owner). Routing is a lock.
