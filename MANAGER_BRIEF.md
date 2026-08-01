# Manager Brief — DreamTube product session

Onboarding doc for **Manager**, the new cross-project coordination
entity (introduced 2026-07-25) overseeing this session and the
separate `dreamtube-growth` marketing session. High-level by design —
read `FOUNDER_PRINCIPLES.md` and `AGENT_POLICY.md` (this repo) for the
full operating model; `tracker.html` (live, `dreamtube1.netlify.app`)
for current line-by-line status. This doc is a snapshot, not a
replacement for either — keep it current as things change, the same
discipline as `FOUNDER_PRINCIPLES.md`.

## What DreamTube is

A consumer app: describe or record a dream, get it turned into a short
AI video (fal.ai / Veo 3.1). Static multi-page site (no build step, no
ES modules) + Netlify Functions backend. `js/store.js` is a
localStorage-backed fake client-side "backend" for most state;
Netlify Blobs backs the real cross-device pieces (accounts,
entitlements, the shared public feed, the tracker itself). Two
repos: this one (`ronbrightman/DreamTube`, the app, product-owned) and
`dreamtube-growth` (the pre-signup marketing funnel + ad management,
growth-owned).

## How this session operates

- **Autonomous, tracker-driven.** A recurring Routine (hourly self-check
  + a 30-minutes-offset backlog-crunch pass) fetches the live tracker,
  works anything `[for product]`-tagged or already started, drives it
  through an established **build → review → merge** pipeline (dispatch
  background agents, independently verify tests myself before and
  after every merge — never trust a subagent's self-reported pass
  count), and logs status back to the tracker tagged `[auto]`.
- **Approval gates respected, not just noted:** no spending, no vendor
  picks, no auth-sensitive merges, no self-generated new ideas
  self-executed (propose-and-wait) — all without waiting to be told
  each time.
- **Cross-session coordination runs entirely through the shared
  tracker** — `[for product]`/`[for growth]` tags, no other channel.
  `FOUNDER_PRINCIPLES.md` is mirrored between both repos and updated
  whenever either session graduates a new standing rule from something
  Ron actually said.

## What's built and live (main branch, all tested)

- **Monetization:** pivoted from subscription/quota to a one-time
  token ledger. 320-token signup grant (raised from 220, 2026-08-01,
  founder-directed, tracker xostu6). Daily free tokens are now an
  ACTIVE claim (2026-07-28 daily-claim switch, no more automatic drip/
  ceiling): 100 tokens on an account's very first-ever claim, 20 on
  every claim after that. Dodo Payments is the chosen, live payment
  provider — checkout + webhook + idempotent crediting all merged and
  tested. Pack enrichment (2026-07-28, founder-approved, same prices):
  200 tokens/$2.99, 600 tokens/$7.99, 1400 tokens/$14.99 (doubled from
  the original 100/300/700 lineup after the veo3.1/lite cost cut below
  — internal pack100/pack300/pack700 identifiers and Dodo product env
  vars kept their original names, only the credited amount changed)
  plus a one-time +50% first-purchase bonus. A standard video
  generation now defaults to fal-ai/veo3.1/lite (~80% cheaper than the
  prior Fast default, env-configurable revert); reference-to-video
  (Me-photo) and image-to-video stay on Fast. **The store went LIVE
  with real money 2026-07-27** — Dodo is processing real charges.
  Still needs **Ron's own** action to rename the 3 Dodo dashboard
  products to match the new doubled pack amounts (founder action, not
  something this session can do).
- **Shop palette A/B test:** the token shop's red/hot visual palette
  (founder feedback) was redesigned into two calmer directions, shipped
  as a live 50/50 in-product A/B test (not a founder pick-one) with a
  real Purchase conversion event feeding PostHog so it can actually be
  scored by variant, not just exposure.
- **Accounts:** real server-side accounts (was previously
  localStorage/per-browser only) — login, signup, forgot-password all
  work cross-device now.
- **Retention:** an abandoned-dream re-engagement flow (email +
  WhatsApp) that emails/texts a finished dream's link back to whoever
  bailed mid-funnel. The originally-planned Twilio SMS leg was found to
  be blocked/unworkable and was formally abandoned in favor of this.
- **Funnel ⇄ app handoff:** the growth funnel's Build/Write/Record
  wizard hands off into this app's `start.html`; PostHog identity
  (`distinct_id`) now links across the handoff so growth can see one
  joined funnel instead of two disconnected anonymous sessions
  (app side shipped; growth needs to append the param on their end —
  logged `[for growth]`).
- **Owner tooling:** `tracker.html` itself has grown substantially this
  cycle — start/done/review workflow, append-only comment threads
  (Ron's voice vs. Claude's, never clobbering each other), a
  `waitingFor` field (Product/Growth/Ron/none) with a colored
  at-a-glance badge so Ron can tell who owes what without reading every
  thread, and a text-to-speech "read aloud" button (title + detail +
  latest comment) so long threads don't have to be read.
- Assorted shipped fixes: a privacy-browser autofill-probe bug that was
  corrupting signup usernames (client- and server-side rejection now in
  place); a CSS bug that let several pages scroll past their real
  content; various stale-copy/hardcoded-number fixes after constants
  changed elsewhere.
- **Test suite:** 673 tests across 52 files, run before and after every
  merge. One test (`shop-palette-variant-behavioral.test.js`) is
  known-flaky under full-parallel-suite load only (never in isolation)
  — logged as a low-priority cleanup, not a real bug.

## Known open issues / gaps

- **No self-serve username-change feature.** The autofill-probe fix
  stops new corruption but can't retroactively fix an account already
  affected (this may include Ron's own) — flagged, needs his call on
  whether to build a rename feature or do a manual fix.
- `profile.html`'s token-balance chip has the same red/hot
  scope-creep issue the shop redesign fixed on the shop page —
  identified, not yet fixed (separate, smaller follow-up).
- The flaky test above.
- Recurring engineering-process notes worth knowing (documented on the
  tracker, not urgent): build agents have occasionally committed
  directly in the shared main working directory instead of an isolated
  git worktree (caught and corrected each time, no data lost); review
  agents sometimes need a worktree explicitly prepared for them since
  they're deliberately read-only/no-Bash by design.

## Key standing decisions worth knowing

- Dodo Payments is the payment provider (decided, live pending Ron's
  own setup).
- Freemium token model, not subscription.
- Substantial new user-facing UI must go through research → design →
  build (small additions to existing flows are exempt, straight to
  build).
- Any tracker thread left waiting on Ron's input must end with a plain
  summary of what's on the line and what he needs to do — not another
  status update he has to piece together from history (his own
  standing rule, 2026-07-25).
- Growth had been informally acting as cross-project coordinator; that
  role is now Manager's, effective this update. No other change to how
  this session works.
