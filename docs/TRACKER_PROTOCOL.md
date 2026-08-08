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

## 5. Founder-gated work is flagged, or it does not exist (added 2026-08-07, founder escalation)

The moment any work becomes gated on the founder — a preview PR awaiting
his go, a decision, an account/key only he holds — its owner files (or
updates) a tracker item with `waitingFor: "ron"`, a title starting
`[for ron]`, and a `detail` that is DIRECTLY ACTIONABLE: the preview
link, the exact steps, and the exact reply that unblocks it ("reply
'comments go'"). For preview PRs this happens AT PR-OPEN TIME, not at
review time. The founder Board renders every such flag LIVE (no Manager
edit involved), so an unflagged founder-gated item is invisible to the
founder BY CONSTRUCTION — three finished PRs sat unseen for a day
because this depended on hand-curation; it no longer does. Clear the
flag the moment the founder answers (stale flags destroy the signal).

## 6. [for ron] items are written in founder language (added 2026-08-07, founder complaint)

The founder read his live queue and could not understand half of it —
worker-facing walls of text ("very long and complex... I have no idea
what this means"). Standing rule: an item flagged `waitingFor: "ron"`
has a `detail` of AT MOST ~3 plain sentences: what this is, what's on
the line, and the ONE action/decision asked of him (with the exact
reply that unblocks). All engineering context, history, and caveats go
in COMMENTS, never the detail — the founder Board renders the detail
verbatim. If you can't state the ask in 3 plain sentences, the item is
not ready to be flagged to him.

## 7. Approved designs travel as artifacts, never as descriptions (added 2026-08-08, founder escalation)

The funnel restyle shipped looking materially different from the mock the
founder approved through seven rounds — because the spec crossed the
repo boundary as a POINTER ("adopt the visual language, see the live
wizard") while the approved mock file itself had been deleted as cleanup,
and no one compared the built screens to the mock before the founder saw
them. Standing rules:

1. **Founder-approved mocks are permanent reference artifacts.** They are
   never deleted; they live in `design-reference/` in the repo that owns
   the approval (the Layout-B wizard mock is there now). A cleanup pass
   may remove a mock from user-facing paths, never from the repo.
2. **Cross-repo design work links the artifact + its behavior list.** Any
   item asking another session to replicate an approved design MUST link
   the mock file and enumerate its interaction behaviors (auto-advance
   rules, conditional reveals, one-screen constraints, etc.). "Same look
   as X" is not a spec.
3. **Side-by-side before ship, no exceptions.** Whoever replicates an
   approved design — in any repo, under any deploy policy, even with a
   founder "ship it" — produces a same-viewport side-by-side (approved
   mock vs built screens) and checks every listed behavior BEFORE the
   founder can encounter it live. The coordinator (Manager) owns
   verifying conformance when the work crosses sessions.
