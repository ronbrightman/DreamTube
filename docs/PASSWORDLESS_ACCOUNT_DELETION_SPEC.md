# Passwordless account deletion — spec

Tracker item: `for-product-passwordless-accounts-have-n-hu1sd0`.

**STATUS: spec only, not approved for build.** This touches an auth-
sensitive path (`delete-account.js`'s authentication surface) — per
`AGENT_POLICY.md`'s escalation policy, category (d), it requires
explicit sign-off from Ron before any implementation starts. See
"Open questions for Ron" at the end — nothing below should be built
until those are answered.

## The problem

Every account created via `register-account-passwordless.js` (all
signups since `wizard-funnel-signup-unify` merged 2026-08-05, plus every
Facebook-Login account, which has always had `password: null`) has no
way to satisfy `delete-account.js`'s only ownership proof: a real
password match (`account.password !== password` in
`lib/account-store.js`'s `verifyLogin`). For a `password: null` record,
literally any non-empty password string returns `E5: incorrect_password`
— account deletion is unconditionally broken for these accounts today.
This also blocks `test/prod-smoke/session.test.js`'s self-cleanup of its
passwordless probe account (see `cleanupProbeAccount`'s KNOWN GAP
comment, and `docs/TEST_REGISTRY.md`'s "Account deletion" row).

## Decided design

Extend `delete-account.js` with a second, additive authentication
method — an emailed 6-digit code — for accounts that have no password
(`account.password === null`). Password-based accounts are completely
unaffected: their existing `{ username, password }` call shape keeps
working exactly as it does today, byte-for-byte.

This reuses this codebase's own already-shipped "prove you control this
inbox" mechanism (`lib/email-verification-store.js` +
`lib/account-auth-token.js`, built for passwordless signup) rather than
inventing a new one — same hashed/attempt-limited/TTL'd code shape,
same authToken-based identity resolution `verify-email-code.js`/
`resend-verification-code.js` already use. It does NOT literally share
the signup-verification Blobs store (see "Why a separate store, not the
same one" below) — that's the one genuinely new piece of storage; the
*pattern* is 100% reused.

### Why a separate store, not the same one

`lib/email-verification-store.js` mints a code **and** a click-through
link together, and either one completes verification (`verify-email-
link.js`). That's safe for email-ownership verification (worst case if
a corporate link-scanner/Gmail image-proxy auto-GETs the link: an
account gets marked verified — harmless). It is **not** safe for
deletion: a passive GET from a mail-client link scanner must never be
able to trigger a destructive action. So the new deletion-code store is
**code-only, no link token, ever** — a deliberate, named divergence
from the signup-verification pattern, not an oversight.

Keeping it a separate store (not layering deletion onto the existing
`"u:<username>"` record) also avoids a real UX/security mixing concern:
a user could have a live pending signup-verification code *and* be
mid-deletion at the same time, and the two must never be able to
satisfy each other — a lower-stakes "confirm my email" code should
never double as a "yes, destroy this account" credential.

## Flow

### For an account that already has a password (unchanged)

Exactly today's flow: Settings → Danger zone → Delete account → modal
→ type password → Delete permanently → `POST delete-account
{ username, password }`.

### For a passwordless account (new)

1. Settings → Danger zone → Delete account.
2. Client checks whether the signed-in account has a password (new
   `DreamStore.getAccountHasPassword()` — see "Client changes" below).
   If false, show the code-based confirmation flow instead of the
   password modal.
3. **Step 1 — request the code.** Same consequences copy as today's
   modal (dreams, characters, token balance, billing-record note) plus
   one added line: "Since your account doesn't use a password, we'll
   email a code to confirm it's really you." Button: "Send code to my
   email." Calls `POST request-account-deletion-code { authToken }`.
4. **Step 2 — enter the code.** A 6-digit code field appears (same
   `inputmode="numeric" maxlength="6"` input as `js/email-verify-
   sheet.js`). "Delete permanently" stays disabled until 6 digits are
   entered. A "Resend code" link is available, cooldown-limited.
5. On submit: `POST delete-account { method: "email_code", authToken,
   code }`. On success: identical to today — `account-deleted-overlay`,
   local state wiped, redirect to `index.html` after 1.8s.
6. On failure: inline error, same collapsed-message convention
   `verify-email-code.js`/`login-with-email-code.js` already use (wrong
   code / expired / no pending record are all one generic "That code
   isn't right — try again or resend" message; a distinct message only
   for "too many attempts, request a new code").

### Edge / error states

- **No email on file** (shouldn't happen — every account has one at
  creation): `request-account-deletion-code` returns a clear error;
  client shows "Contact support" fallback (existing support-compose
  panel is already on this page).
- **authToken missing/expired** (signed out, or 90-day TTL lapsed):
  neither new endpoint works. Client shows "Please sign in again" —
  same posture the rest of Settings already has for a stale session.
- **Network failure at any step**: identical wording to today's
  `deleteAccount`'s catch branch ("Couldn't reach the server — check
  your connection and try again"), never silently treated as success.
- **Stale in-flight request after Cancel/reopen**: reuse the existing
  `deleteAccountToken` generation-guard idiom already in `profile.html`
  for exactly this class of bug (a late-arriving response for an
  abandoned attempt must never clobber a fresh one).
- **A password-holding account somehow sends `method: "email_code"`**:
  server rejects (`E13: account_has_password`) — this path is
  exclusively for `password === null` accounts. Not reachable from the
  UI (client only offers this branch to passwordless accounts) but
  enforced server-side too, so it can never become a weaker alternate
  deletion route for password accounts.

## API shapes

### `POST /.netlify/functions/request-account-deletion-code` (new)

```
Request:  { authToken }
Response: 200 { ok:true }
          200 { ok:false, error:'E3: auth_token_required' }
          200 { ok:false, error:'E4: invalid_or_expired_token' }
          200 { ok:false, error:'E6: account_has_password' }
          429 { ok:false, error:'E7: rate_limited' }
```

- Identity resolved from `authToken` only (`account-auth-token.js`'s
  `verifyToken`) — never a bare client-claimed username, same reason
  `resend-verification-code.js` already gives (this triggers a real
  outbound email).
- Refuses (`E6`) if the resolved account's `password !== null` — see
  above.
- Mints a fresh code via the new `lib/account-deletion-code-store.js`
  (overwrites any previous pending deletion code for this account —
  same "one live record, most recent wins" shape as `email-
  verification-store.js`) and sends it via the new `lib/deletion-code-
  email-sender.js`.
- Rate limits: new dedicated buckets (own env vars, own budget — same
  "don't share/starve a different action's budget" reasoning `resend-
  verification-code.js`'s own header comment gives), per-IP AND
  per-identifier, mirroring `delete-account.js`'s existing two-bucket
  shape: `MAX_DELETION_CODE_REQUESTS_PER_IP_PER_DAY` (default 20),
  `MAX_DELETION_CODE_REQUESTS_PER_IDENTIFIER_PER_DAY` (default 5 —
  legitimate use is a handful of sends in one sitting, never more).

### `POST /.netlify/functions/delete-account` (modified, additive)

```
Request (unchanged): { username, password }
Request (new):        { method:"email_code", authToken, code }
Response: unchanged 200/429 shapes for the password path.
          New for the code path:
          200 { ok:false, error:'E8: auth_token_required' }
          200 { ok:false, error:'E9: invalid_or_expired_token' }
          200 { ok:false, error:'E10: code_required' }
          200 { ok:false, error:'E11: invalid_code' }
          200 { ok:false, error:'E12: too_many_attempts' }
          200 { ok:false, error:'E13: account_has_password' }
          429 { ok:false, error:'E6: rate_limited' } (own dedicated
               bucket — see below)
          200 { ok:true } — identical success shape either method.
```

- Payload without an explicit `method` and with `password` present is
  treated as `method:"password"` (today's exact behavior) — fully
  backward compatible with the current client and with `test/prod-
  smoke/session.test.js`'s existing password-path call, no coordinated
  simultaneous deploy required.
- `method:"email_code"` branch: resolve identity via `authToken`
  (`account-auth-token.verifyToken`) → look up the account
  → reject (`E13`) if it has a real password → verify `code` against
  `lib/account-deletion-code-store.js` → on success, run the exact same
  deletion sequence (steps 1–6) the file already implements, refactored
  into one shared internal function both branches call. **No change**
  to what gets deleted or in what order.
- Rate limiting: own dedicated buckets (`delete-account-code-ip`/
  `delete-account-code-identifier`), same conservative defaults as the
  existing password buckets (100/day IP, 30/day identifier) — this is
  on top of, not instead of, the deletion-code store's own
  attempt-cap (below).

### `lib/account-deletion-code-store.js` (new)

Mirrors `lib/email-verification-store.js`'s shape exactly (sha256-
hashed code at rest, `crypto.randomInt` zero-padded 6-digit code,
constant-time compare, attempt-limited, one record per username,
overwritten on resend) with two deliberate differences:
- **No link token** — code-only (see "Why a separate store" above).
- **`TTL_MS = 15 * 60 * 1000`** (15 minutes), not 7 days — deletion is
  a single-sitting flow, not something deferred to a natural later
  moment the way signup verification is.
- `MAX_CODE_ATTEMPTS = 6` (vs. the signup store's 8) — slightly
  tighter, given the higher stakes and that legitimate use is
  essentially always a single correct entry.
- Blobs store name: `dreamtube-account-deletion-codes`.

### `lib/deletion-code-email-sender.js` (new)

Structurally mirrors `lib/verification-email-sender.js` (same
`RESEND_API_BASE`/`FROM_ADDRESS`/fire-and-forget/never-throws
contract), with different copy and **no "click to verify instantly"
link** — the code is the only path. Draft copy (subject to Ron's
review — see open questions):

> Subject: Confirm deleting your DreamTube account
>
> Your confirmation code: **482103**
>
> Enter this in DreamTube to permanently delete your account. This
> code expires in 15 minutes.
>
> If you didn't request this, ignore this email — nothing has been
> deleted and your account is safe.

## Client changes (`js/store.js` / `profile.html`)

- `DreamStore.getAccountHasPassword()` — new getter, mirrors
  `getAccountEmailVerified()`'s existing shape. Reads
  `state.accounts[normalizedUsernameKey].password !== null`, defaulting
  to `true` (password-based) when the local record is missing/unknown
  — **fails safe to today's exact behavior** rather than silently
  offering the new branch when the client genuinely doesn't know.
  (`state.accounts[key].password` is already reliably set to `null` at
  every point a passwordless session is established — passwordless
  signup, and email-code login on a new device — confirmed by reading
  `commitLocalPasswordlessSignup`/the `login-with-email-code` local
  commit path.)
- `DreamStore.requestAccountDeletionCode()` — thin wrapper around the
  new endpoint, same promise/error-mapping shape as
  `resendVerificationCode()`.
- `DreamStore.deleteAccount(...)` — extended to accept either a
  password (unchanged call shape) or a code, and to build the right
  request payload. Exact function signature is a build-time call
  (e.g. an options object) — not pinned here.
- `profile.html`: Danger-zone row behavior unchanged. The modal it
  opens branches on `getAccountHasPassword()`. See "Design directions"
  for the two concrete layout options for the passwordless branch.

## Security considerations

- **Rate limiting**: two independent layers — per-IP/per-identifier
  daily caps on *requesting* a code (new endpoint) and on *submitting*
  a deletion attempt (`delete-account.js`'s new bucket), plus the
  store's own hard per-record attempt cap (6 wrong guesses, independent
  of the daily window). Mirrors `delete-account.js`'s own existing
  reasoning for why login/deletion endpoints need throttling beyond a
  code's own entropy.
- **Code expiry**: 15 minutes (see open questions — Ron's call to
  confirm).
- **No way to delete someone else's account**: identity for both new
  endpoints is resolved from `authToken` (a real, previously-minted,
  non-forgeable session proof), never a bare client-claimed
  username/email — same discipline `block-user.js`/`publish-dream.js`
  already established. The code itself is a *second* factor on top of
  that authToken, not a replacement for it — an attacker would need
  both a live authToken for the victim's account (i.e., already
  controls a signed-in session on the victim's device) **and** access
  to the victim's real email inbox to complete a deletion. This is at
  least as strong as the "shared already-logged-in device" threat model
  `delete-account.js`'s own header comment names for the password path
  — arguably stronger, since a live email inbox is less likely to be
  accessible to a casual "stray tap" attacker on a shared device than a
  password might be.
- **No implicit link-click deletion**, deliberately (see above) — the
  single largest deviation from the pattern this reuses, and the reason
  it isn't just "point at the existing store."
- **Scope-limited to `password === null` accounts only**, enforced
  server-side (`E13`/`E6`) even though the client never offers this
  path to a password-holding account — defense in depth, and prevents
  this from quietly becoming a second, weaker deletion route for
  accounts that already have a strong one.
- **Side effect worth naming**: this also fixes deletion for
  Facebook-Login-only accounts (`account-store.js`'s header comment
  confirms these also carry `password: null`), which have the exact
  same `E5: incorrect_password` bug today, undocumented until now. Not
  a scope expansion — it's the same `password === null` gate,
  correctly applied.

## Unblocking `test/prod-smoke` cleanup

The probe account uses a synthetic `@example.com` email (`test/prod-
smoke/helpers/config.js`) that receives no real mail — a real emailed
code is fundamentally unreachable by an automated test the same way a
real user would use it. Rather than leaving this gap open or building a
parallel "test-mode" deletion endpoint, `request-account-deletion-code`
gets one narrow, defense-in-depth escape hatch:

If **both** of the following hold, the response additionally includes
the raw code (`{ ok:true, debugCode }`) instead of only sending it by
email:
1. The caller sends a shared-secret header matching the **already-
   provisioned** `SMOKE_STATUS_REPORT_TOKEN` env var (reused, not a new
   secret Ron has to go set up — it already exists for `report-smoke-
   status.js`'s own shared-secret-gated convention, same "trusted
   automation caller" purpose).
2. The resolved account's own on-file email domain is exactly
   `example.com` (case-insensitive) — the same convention `js/
   store.js`'s `isTestOrInternalIdentity()` and `lib/test-identity.js`
   already use to recognize test/internal identities.

Both conditions must hold — a leaked secret alone can't extract a real
user's code (their email domain will never be `example.com`), and a
guessed/known test domain alone can't extract anything without the
secret. `session.test.js`'s `cleanupProbeAccount` then becomes: request
the code with that header → read `debugCode` straight from the JSON
response (no inbox needed) → `delete-account` with
`{ method:"email_code", authToken, code: debugCode }`. This closes the
KNOWN GAP for real, with a provable mechanism, not a manual workaround.

**Follow-up for whoever builds this**: update `docs/TEST_REGISTRY.md`'s
"Account deletion" row — the current "Gaps" cell should note the
passwordless-cleanup path is closed, and `session.test.js`'s own KNOWN
GAP comment block should be removed/rewritten once this ships, per
`AGENT_POLICY.md`'s "Definition of done: build" rule (a behavioral
change isn't done until the registry reflects it).

## Design directions (UX layer only — human picks one)

Both directions keep the exact same Step-1/Step-2 flow, consequences
copy, and error handling above — they differ only in *where* the
code-entry UI lives.

### Direction A — extend the existing delete-confirmation modal (two-step reveal)

The current `#modal-delete-account` gains a second internal state
(same idiom `js/email-verify-sheet.js` already uses internally — a
`#...-form`/`#...-done`-style toggle, just with three states instead of
two: consequences+send-code / enter-code / — no separate "done" state
needed since success already routes to the existing
`account-deleted-overlay`). Tapping "Send code to my email" swaps the
modal's body from the consequences list to the 6-digit input, in place,
no navigation, no new overlay element.

- **Grounded in**: this app's own existing `modal-delete-account` —
  the smallest possible diff, reusing 100% of the current DOM/CSS
  classes (`modal-overlay`/`modal-card`/`modal-row`), just conditionally
  swapping inner content. Also matches the general "restate the
  consequences, then escalate the confirmation mechanism in place"
  pattern most current destructive-action flows use (Slack's own
  in-dialog 2FA-code step for a workspace-destroying action follows
  the same "same dialog, escalating step" shape).
- **Tradeoff**: fastest to build, zero new component, most visually
  consistent with what's already shipped. Slightly more cramped on a
  small mobile viewport once the input/error/resend row is added on
  top of the existing consequences list and button row — the modal
  gets taller than today's.

### Direction B — reuse `js/email-verify-sheet.js`'s pattern as a dedicated bottom sheet

The code-entry step becomes its own bottom sheet (same `sheet-overlay`/
`sheet`/`sheet-handle` component family as `email-verify-sheet.js`,
`report-sheet.js`, `share-sheet.js`, `purchase-sheet.js` — this app's
own established sheet convention), opened after the existing modal's
Step 1 closes. Nearly identical markup/behavior to `email-verify-
sheet.js` itself (same numeric input styling, same resend-link idiom,
same per-instance generation-token guard against stale async
callbacks) — literally the same component shape, re-skinned for
"Delete permanently" instead of "Verify."

- **Grounded in**: DreamTube's own already-shipped, already-tested
  `email-verify-sheet.js` — this is the single most directly relevant
  "real current pattern" available, since it's the exact same
  interaction (type a mailed 6-digit code, resend option) this app
  already designed and shipped for a different purpose. Reusing it
  matches `FOUNDER_PRINCIPLES.md`'s standing rule to copy proven
  solutions rather than invent, applied here to the app's own prior
  work rather than an external app.
- **Tradeoff**: a second sheet component to open/close, more moving
  parts (modal closes → sheet opens) than Direction A's in-place swap,
  and a small UX inconsistency risk (why does deletion use a sheet when
  every other confirmation in this codebase uses a modal?) unless the
  sheet's danger styling (red accents, "Delete permanently" button)
  makes it unmistakably distinct rather than looking like an ordinary
  sheet. In exchange: more breathing room on mobile, and a component
  that's already been through one full round of real-world UX
  iteration (resend cooldown wording, error copy) that Direction A
  would otherwise redo from scratch inside a cramped modal.

**Recommendation, not a decision**: Direction A for the smaller diff
and tighter visual consistency with the *existing* delete-confirmation
modal specifically (this is a completion of that same flow, not a new
flow); Direction B if a taller/roomier destructive-action UI matters
more than component-count. Ron picks — this is category (a) in
`AGENT_POLICY.md`'s escalation policy.

## Out of scope (this pass)

- Retrofitting email-code as an *additional* factor for password-based
  accounts (flagged below — Ron's call).
- Any "add a password to my passwordless account" feature — unrelated,
  doesn't exist today, not needed to fix this gap.
- Any change to `email-verification-store.js`'s existing 7-day signup-
  verification flow or its implicit link-click behavior.
- Any change to what `delete-account.js` actually deletes (its
  existing 6-step sequence, and its existing deliberate NOT-touched
  list — Dodo payment history, pending-dream/support records) — this
  spec only changes *how ownership is proven*, never *what happens
  once it's proven*.
- Dodo/payment-history handling — unchanged, already a separate,
  previously-flagged founder decision.

## Open questions for Ron (blocking build)

1. **Code expiry duration** — 15 minutes proposed. Fine, or prefer
   something else (e.g. matching a more familiar OTP window like 10 or
   30 minutes)?
2. **Should password-based accounts also get an email-code step**, for
   consistency, on top of their existing password check? Recommend
   **no** for this pass (smallest safe diff, and this population is
   shrinking — every new signup is passwordless as of 2026-08-05) — but
   this is explicitly your call, not a default I should assume.
3. **Copy/wording** — the modal text, email subject/body, and error
   messages above are drafts. Per `FOUNDER_PRINCIPLES.md`'s standing
   rule, nothing ships without you actually seeing the real UI, not
   just this prose.
4. **Which design direction** — A (extend the existing modal) or B
   (reuse `email-verify-sheet.js` as a dedicated sheet). My lean is A;
   yours is the decision that counts.
5. **The `SMOKE_STATUS_REPORT_TOKEN`-gated debug-code escape hatch for
   prod-smoke** (see "Unblocking test/prod-smoke cleanup") is itself a
   new branch on the deletion-authentication surface, even though it's
   scoped to already-known-throwaway `@example.com` identities behind
   an existing secret — flagging it explicitly rather than treating it
   as a lower-stakes side note, since it's still new code on an
   auth-sensitive path and should get the same sign-off as the rest of
   this spec, not a quieter nod-through.

Once these are answered, `build` can implement this on its own branch,
`review` checks it, and `docs/TEST_REGISTRY.md` gets updated per the
"Unblocking test/prod-smoke cleanup" section above — same autonomous
build↔review loop as any other approved spec, per `AGENT_POLICY.md`.
