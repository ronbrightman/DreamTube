# Signup Screen Redesign — CRO Fix for the Single Biggest Funnel Leak

Tracker: `for-product-signup-screen-the-single-big-bkwhbe` (priority:
high, founder-flagged — 98 → 36 users since 2026-07-23, -63%, while
every step after this one converts 97-100%).

## 0. Freshness check

Fetched directly from `raw.githubusercontent.com/ronbrightman/DreamTube/main/...`
(not a local checkout): `wizard.html`, `start.html`, `js/store.js`,
`netlify/functions/register-account.js`,
`docs/IDENTITY_RETENTION_PROJECT_SPEC.md`, `docs/EVENT_TAXONOMY.md`,
`css/styles.css`.

## 1. What's actually live today

DreamTube has **two separate, non-identical signup implementations**:

**Paid path (majority of traffic): quiz/hook screens in the separate
`dreamtube-growth` repo → hand off → `start.html`**, which renders the
tail: Advanced-Characters (conditional) → Screen 11 (2.2s auto-advancing
transition) → **Screen 13 (signup)** → Screen 14 (pricing). This is the
exact moment "right after a quiz/onboarding flow, at peak intent."

`start.html` Screen 13 already has a **live 50/50 A/B test**
(`signupVariant`, persisted in localStorage, registered to PostHog):

- **Variant A (control)** — email + password shown simultaneously.
- **Variant B** — same fields, email submitted first, password field
  DOM-swapped in afterward, same screen.
- Legal line: "By signing up, you agree to our Terms and Privacy
  Policy."
- On submit: validates email format + password presence →
  `checkEmailAvailable()` + `getOrStartPendingGeneration()` in parallel →
  `attemptSignup()` → `fireMetaConversion('CompleteRegistration',
  {email})` → advances to Screen 14.

**The 36/98 number is the blended result across both A and B — the
existing A/B test has not solved this; both variants still ask for a
password.**

**Organic path: `wizard.html` Step 8 of 8**, preceded by Step 7 which
already captures email. Step 8 then asks for email again (locked,
pre-filled) plus a brand-new username field plus a password field — no
A/B infrastructure at all, one more field than the paid path. Out of
scope for this pass (see §4), flagged as a fast follow-up.

`netlify/functions/register-account.js` currently *requires* `username`,
`password` (≥3 chars), `email` — password is a hard requirement
server-side today, not optional.

Analytics convention confirmed: Meta events PascalCase
(`CompleteRegistration`, `ReachedEmailEntry`), PostHog/`track()` events
snake_case (`signed_up`, `wizard_completed`). **No field-level events
(focus/blur/error/abandon) exist today** — this is the gap §7 fills.

## 2. The parked decision this makes urgent

From `docs/IDENTITY_RETENTION_PROJECT_SPEC.md`: Facebook Login is the
only social-login provider that works inside this traffic's dominant
environment (Google is hard-blocked in the FB/IG in-app webview via
`disallowed_useragent`), but Facebook Login needs Meta Business
Verification — a business-domain email (custom domain purchase) and a
registered business entity. Apple Sign-In (~$99/yr) mainly helps users
who leave the webview for Safari, a minority here. The spec's own prior
conclusion was to revisit "once there's real data on whether login
friction is still a meaningful drop-off point" — **that data now
exists: 36/98, -63%, only at this step.**

This is worth putting in front of the founder explicitly, with these
numbers attached — but it's his money/entity decision, not built here.
The recommendation below works fully without it.

## 3. Diagnosis (each grounded in research, not a guess)

1. **A password field, in the FB/IG in-app webview specifically, has
   none of the safety net that makes passwords tolerable elsewhere.**
   Conditional UI (passkey/password-manager autofill) doesn't work in
   embedded webviews — iCloud Keychain/Google Password Manager/1Password
   autofill does not fire here. Users hand-type a password on a phone
   keyboard, in an embedded browser, with no assist, at peak intent.
2. **Field count itself is a known conversion driver**, independent of
   password specifically (Baymard Institute: defer anything
   non-essential past account creation). `wizard.html`'s Step 8 asks for
   2 fields on top of an email already given once at Step 7.
3. **Deferring the password's on-screen position (what Variant B
   already does) is a smaller lever than removing the password
   requirement itself.** Passwordless patterns show an 8-15%
   conversion lift in cited industry research — a different, larger
   effect than sequencing, consistent with the blended 36/98 number
   showing the current split hasn't cracked this.
4. **The dominant modern reference pattern for this exact moment
   (post-quiz, mobile, peak intent) is email-first with the credential
   decision deferred past the value moment.** The New York Times
   registration flow leads with email, defers password creation past
   the value moment; Duolingo's onboarding follows the same underlying
   principle.
5. **A magic-link-only fix would be actively bad here specifically
   because of the in-app-webview context** — clicking an emailed link
   means switching to a mail app and back into a webview whose session
   state this app's own `FOUNDER_PRINCIPLES.md` already documents as
   fragile (wipes localStorage on webview close). An emailed 6-digit
   code, typed back into the same screen without leaving the app,
   avoids that failure mode while keeping the "no password" benefit.
   SMS OTP is already ruled out (Twilio A2P 10DLC blocked without a
   US/Canada EIN), so email is the only available channel for this
   pattern — matching the "email is crucial, not weak" retention
   principle already established for this app.

## 4. Product spec (build-ready)

**Scope: `start.html` Screen 13 only** (the screen the 36/98 number is
about). `wizard.html` Step 8 has an analogous problem, out of scope for
this pass, flagged as a fast follow-up once a direction is chosen.

### Flow

1. User arrives at Screen 13 from Screen 11 (unchanged).
2. Single field shown: email (direction-dependent what happens after).
3. User submits email → client-side format check only → request in
   flight.
4. Failure paths (both directions):
   - Invalid format → inline error, field keeps focus.
   - Email already has an account → "You've already got an account with
     this email," single tappable action to login (pre-filled email) —
     never a dead-end error.
   - Network/server failure → "Couldn't send that — check your
     connection and try again," button re-enabled.
   - Rate-limited → "Too many attempts — try again in a bit," never
     expose the internal error code.
5. On confirmed success: same downstream contract as today —
   `flushStagedCharactersToStore()`, claim/adopt pending generation,
   `fireMetaConversion('CompleteRegistration', {email})`, advance to
   Screen 14. Nothing about the post-signup contract changes.

### Data/API needs

- Reuse existing `checkEmailAvailable()` to short-circuit into the
  "already have an account" path first.
- **Direction A needs a new, modest backend capability**: a short-lived
  (10 min) 6-digit code per email, stored in Netlify Blobs (same
  bounded retry-and-verify pattern this codebase already uses
  everywhere), sent via Resend (already wired, no new vendor), verified
  on submit; on match, mint the account with a server-generated password
  (invisible, never displayed/asked for).
- **Direction B needs less**: `register-account.js` gets a
  `passwordless: true` mode where password is server-generated instead
  of client-supplied.
- No new field stored beyond what's stored today, beyond the OTP code
  itself (short-lived, never persisted past its 10-minute window).

### Explicitly out of scope

- `wizard.html` Step 8 (organic path) — flagged as a near-identical fast
  follow-up, not built here.
- Social login — see §6, additive and founder-money-gated.
- Anything upstream (Screens 1-11) or downstream (Screen 14).
- A full `login.html` redesign beyond the minimum passwordless path both
  directions need for a return visit.
- Retiring the existing A/B harness — recommend adding the new
  direction as a new arm (`'c'`/`'d'`) of the same `signupVariant`
  mechanism, for a clean before/after against the 36/98 baseline.

## 5. Two design directions (founder picks — mockup rendered)

Both keep the existing funnel visual language exactly as-is (`fn-*`
classes, Manrope, the same pill buttons/gradient/spinner). Divergence is
purely interaction pattern, not look.

### Direction A — Email + code, no password ever (recommended)

Screen 13a (email step): headline unchanged, reassurance updated to
"Free to start, no password needed — we'll email you a code to confirm
it's you," button "Send my code" → loading "Sending your code…"

Screen 13a′ (code step, in-place DOM swap, same pattern the existing
password-swap already uses): "Check your email" / "We sent a 6-digit
code to [email]." / numeric 6-digit field, auto-advances at 6 digits /
"Confirm and continue" → "Confirming…" / "Resend code" (disabled 30s
after send) + "Use a different email" (back to 13a, pre-filled).

**Tradeoff:** adds one sub-step and a short wait. In exchange, positively
confirms the email is real and reachable before account creation —
matters specifically because email is this app's documented day-2
return channel for its dominant (in-app-browser, localStorage-losing)
traffic; a silently-wrong email under Direction B would quietly break
that channel with no signal until a retention email bounces days later.

### Direction B — Single field, zero verification, instant continue

One screen, one field: "Free to start, no password, no card needed,"
button "Continue" → loading "Setting up your account…" → straight to
Screen 14, no second screen at all. Random password minted invisibly
server-side.

**Tradeoff:** strictly faster and simpler to build (no OTP pipeline).
Gives up the immediate "this email is real" confirmation — the first
place a bad email would surface is a bounced retention email days later.
Should pair with a visible "wrong email?" affordance on Screen 14/result
if chosen (noted as a required companion, not built in this pass).

### Recommendation

Direction A — the extra ~10 seconds is small next to the retention-
channel risk B accepts, and the research most specific to this app's
actual constraint (in-app webview, no password-manager autofill, no SMS
fallback) points at removing the password outright while still
confirming the email.

## 6. Social login — NOT built here, founder-money-gated

If/when the parked domain + business-entity decision is made, add as a
pure addition on top of whichever direction ships — a "Continue with
Facebook" button above the email field, email/code (or email/instant)
kept as the fallback, never removed. Facebook Login is the one that
actually helps this traffic's majority (Google is hard-blocked in the
FB/IG webview); it needs Meta Business Verification (custom domain +
business entity — a real founder decision, jurisdiction-dependent).
Apple Sign-In (~$99/yr) mainly helps the Safari-leaving minority.

**Stakes to weigh, with real numbers now attached**: this screen
converts 37% today. Every real product pattern found shows the
*credential type*, not just field sequencing, drives conversion — social
login remains a plausible *additional* lift on top of Direction A/B, if
the money/entity decision is made. The case against: A/B alone already
targets the root cause research says matters most, so the marginal lift
from social login is unproven until A or B has real data behind it.

## 7. Instrumentation (new micro-step events)

```
signup_email_field_focused      { screen: 13, variant }
signup_email_error_shown        { screen: 13, reason: invalid_format|already_registered|rate_limited|network }
signup_code_requested           { screen: 13 }                    // Direction A only
signup_code_field_focused       { screen: 13 }                    // Direction A only
signup_code_error_shown         { screen: 13, reason: wrong_code|expired }  // Direction A only
signup_code_resend_tapped       { screen: 13 }                    // Direction A only
signup_use_different_email_tapped { screen: 13 }                  // Direction A only
signup_abandoned                { screen: 13, step: email|code, ms_on_step }  // best-effort, fire-and-forget
```

Continue reusing `signed_up` as the completion event; extend the
existing `signupVariant` mechanism's value set rather than building a
parallel harness.

## 8. Build checklist

- `start.html` — Screen 13 redesign (Direction A or B), new arm of
  `signupVariant`
- New backend (Direction A): OTP generate/send/verify, Blobs-backed,
  Resend delivery
- `netlify/functions/register-account.js` — `passwordless` mode
- `login.html` — minimum passwordless return-path both directions need
- `test/` — coverage for the new flow, error paths, A/B arm registration

---

*Design pass 2026-07-30, for tracker item
for-product-signup-screen-the-single-big-bkwhbe. Research sources: Baymard
Institute field-count guidance, passwordless-conversion industry data
(Reforge/MojoAuth), NYT/Duolingo deferred-credential pattern, Corbado's
webview-autofill research. Two open founder decisions: §5's Direction A
vs B, and separately, whether to pursue the parked social-login money
decision (§6) given these new numbers.*
