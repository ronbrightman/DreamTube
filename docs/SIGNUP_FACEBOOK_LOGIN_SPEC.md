# Signup Screen Redesign + Facebook Login — Build-Ready Spec

Combines tracker items `for-product-signup-screen-the-single-big-bkwhbe` (signup CRO)
and `for-product-priority-founder-2026-07-30--ruzc5u` (Facebook Login, founder priority)
into one coherent screen, per Manager's explicit instruction that these land together,
not as two competing changes.

Visual mockup (Direction X vs Y): see the artifact link in the tracker comment for this item.

---

## 0. What's actually there today (current-state findings)

**Screen 13 in `start.html`** is the signup screen the CRO item's -63% number is about. It
already runs a live 50/50 A/B test (`SIGNUP_VARIANT_KEY = 'dreamtube_signup_variant'`,
`start.html:360-365`):
- **Variant A** (`renderScreen13`, `start.html:1286-1355`): email + password shown
  together, one screen.
- **Variant B** (`renderScreen13EmailFirst`, `start.html:1563-1686`): email only first,
  password revealed in-place after a valid email is entered (no navigation), plus a real
  (never-fake) social-proof strip (`dreamsThisMonthCount`, `start.html:377-386`) and "Free
  to start, no card needed" reassurance copy.

Both variants share one submit path (`wireScreen13Fields`, `start.html:1373-1533`): client
format-check -> `checkEmailAvailable()` (`check-email.js`, early "already have an account"
bailout) -> `attemptSignup()` (`start.html:1243-1285`) -> `DreamStore.signup()`
(`js/store.js:1907-1958`) -> `register-account.js` -> `account-store.js`. There's also a
real, in-parallel "generate during signup" kickoff (`getOrStartPendingGeneration`, fired
alongside `attemptSignup`, not after it).

**Zero social-login scaffolding exists anywhere** — confirmed by grep across the repo (no
`FB.login`, no `fbAsyncInit`, no OAuth code, no social button markup). This is genuinely
greenfield.

**Account model** (`js/store.js` + `netlify/functions/lib/account-store.js`): one Blobs
store (`dreamtube-accounts`), two key shapes — `u:<username>` -> `{username, email,
password, updatedAt}`, and `e:<normalized email>` -> `<username>` (a secondary index so
login/reset-by-email doesn't need a scan). `createAccount` rejects on username OR email
collision (E7/E8). **Password is not required to be non-null everywhere** —
`commitTransferredSession` (`js/store.js:1850-1868`) already materializes a local account
record with `password: null` for a session established without ever having a password on
hand. This is the exact shape an FB-only account needs, and it's already an accepted
pattern in this codebase, not a new one.

**The session-transfer-token mechanism** (`netlify/functions/lib/session-transfer-token.js`,
`create-session-transfer.js`, `verify-session-transfer.js`, consumed client-side via
`DreamStore.consumeSessionTransferTokenFromUrlSync()`, `js/store.js:3441+`) already solves
"hand a real logged-in session across a page-navigation boundary via a single-use,
short-TTL, Blobs-backed token in a URL param (`?bt=`)" — built originally for the FB/IG
in-app-browser "open in real browser" escape hatch. **This is the exact mechanism the FB
OAuth redirect-back needs**, and should be reused verbatim rather than inventing a second
one. It's currently wired only on `processing.html`/`result.html` — `start.html` needs the
same call added to its boot sequence.

**The feature-flag precedent** to copy is `js/turnstile-config.js`'s `TURNSTILE_SITE_KEY` /
`js/analytics-config.js`'s `POSTHOG_KEY`/`META_PIXEL_ID`: a placeholder string, checked at
every call site, that makes the whole feature a no-op (no script load, no button render, no
network call) until a human drops in a real value. Same shape, reused for Facebook.

---

## 1. Research (current, real, cited)

**Why Facebook, not Google, in this specific webview**: Google actively blocks OAuth from
embedded webviews. Since July 2023, Google's OAuth 2.0 policy rejects sign-in attempts from
an embedded/WebView user agent (`disallowed_useragent`), requiring an OS-level Custom Tab
instead ([Google Developers Blog](https://developers.googleblog.com/upcoming-security-changes-to-googles-oauth-20-authorization-endpoint-in-embedded-webviews/),
[Auth0](https://auth0.com/blog/google-blocks-oauth-requests-from-embedded-browsers/)).
Facebook's own in-app browser (where DreamTube's paid traffic almost entirely lands) is
exactly this kind of embedded WebView — for third-party providers, social login commonly
fails hardest in that context ([Corbado](https://www.corbado.com/blog/social-login-conversion-rate);
[in-app browser conversion writeups](https://www.inappredirect.com/blogs/how-to-bypass-facebook-s-in-app-browser-for-higher-conversions-and-roas-with-in-app-redirect)).
Facebook Login is the one provider that doesn't hit this wall specifically *because* the
webview it needs to work inside is Facebook's own.

**Redirect flow, not the popup-based JS SDK**: mobile/in-app-browser contexts should use
the **redirect flow** — popups are unreliable/blocked in embedded WebViews
([manual OAuth flow docs](https://developers.facebook.com/documentation/facebook-login/guides/advanced/manual-flow)).
**Recommendation: build the manual/server-side OAuth redirect flow, not the client-side
Facebook JS SDK.** No third-party FB script loads on every pageview, matching this
codebase's existing "nothing loaded until it's real" pattern (Turnstile/PostHog/Pixel).

**Dominant consumer pattern for quiz-funnel apps with heavy paid-social traffic**: Cal AI's
post-quiz signup screen — prominent, full-width social buttons at top, plain email
affordance beneath, visually secondary
([Mobbin](https://mobbin.com/explore/flows/579da5dd-453a-4e7c-9c11-d20708a4db82),
[Figma breakdown](https://www.figma.com/community/file/1540803063078176882/cal-ais-onboarding-broken-down)).

**Facebook's brand policy is a hard constraint**: Meta requires the approved Facebook-blue
(`#1877F2`) button, the "f" logo mark, and approved copy ("Continue with Facebook") used
as-is — no reskinning to match app palette. This means the FB button cannot take
DreamTube's pastel gradient pill treatment the rest of `start.html` uses.

---

## 2. The unified screen — user flow

### 2.1 Happy path — Facebook, brand-new user

1. Visitor taps **"Continue with Facebook"** on screen 13 (flag ON).
2. Before navigating: persist `staged` (in-memory character data) to localStorage under a
   scoped key; build a `state` param (nonce + resume params); store the nonce in a
   short-lived first-party cookie for CSRF verification.
3. Full-page-navigate (not popup) to Facebook's OAuth dialog with `scope=email`.
4. Facebook redirects back to `netlify/functions/facebook-oauth-callback.js` (new) with
   `?code=...&state=...`.
5. Callback: verifies state/nonce, exchanges `code` for a token server-to-server, calls
   `graph.facebook.com/me?fields=id,name,email`. Identity resolution (§3) finds no
   existing account -> creates one (username derived from email local-part via the
   existing `deriveUsernameBase` collision-retry logic, `password: null`, `fbUserId`
   stored). Mints a session-transfer-token (reused verbatim), 302s back to
   `start.html?resume=1&bt=<token>&...`.
6. `start.html` reloads; boot sequence calls (new call site)
   `DreamStore.consumeSessionTransferTokenFromUrlSync()` -> `commitTransferredSession`.
   Restores `staged` from localStorage, clears it immediately.
7. Screen-13 renderer checks `getCurrentUser()` before rendering either variant — if
   already signed in, skips screen 13 entirely: flushes staged characters, fires
   generate-during-signup now that email is known, fires `CompleteRegistration`, advances
   to screen 14.

### 2.2 Happy path — Facebook, email matches an existing account

Same through step 5, except identity resolution finds an existing account by email ->
treated as a **login**: upserts `fbUserId` onto the existing record (one-time), mints the
token for that account. Never creates a duplicate. Counted as a login for funnel-conversion
measurement, not a new signup.

### 2.3 Manual email signup — unchanged

FB button sits alongside the existing email flow; doesn't alter validation, submission, or
`signupAttemptToken` guard logic at all.

### 2.4 Error / edge states

| Case | Behavior |
|---|---|
| Flag OFF | Button absent from DOM entirely, not hidden. Screen behaves exactly as today. |
| No email from Facebook | Never silently creates an email-less account. Redirects back with a signed marker to render one minimal extra field asking for email, then completes creation. |
| Token exchange / `/me` call fails | Inline error on screen 13 ("Something went wrong... try again, or continue with email below") — email/password fields remain usable as fallback. |
| CSRF state mismatch | Same as above — fails closed. |
| Mid-manual-signup + taps Facebook | Must invalidate any in-flight manual `attemptSignup()` (bump token + `invalidatePendingSignup()`) before navigating, same discipline as the existing Change-email link. |
| Callback endpoint abuse | Per-IP rate limit, same shape as `register-account.js`'s `MAX_REGISTRATIONS_PER_IP_PER_DAY`. |
| Round-trip loading state | Brief "Signing you in..." using the existing `.fn-spin` treatment while token-consume + staged-restore runs. |

### 2.5 Non-obvious requirement: `staged` characters must survive the redirect

A full-page redirect to facebook.com and back loses all in-memory JS state unless
re-derived. Most params round-trip fine via the `state` param, but `staged` (in-memory
character data including base64 photos, `start.html:533`) exists only in memory because
it's arbitrarily large. **Must** persist to localStorage before the redirect and restore +
clear on return — real, required work, not deferrable, since most visitors reaching screen
13 have already been through the characters screen.

Also: factor a shared `completeSignupAndAdvance(email)` continuation both the manual path
and the FB-return path call, rather than duplicating the flush-characters /
kick-off-generation / fire-CompleteRegistration / advance-to-14 sequence a second time.

### 2.6 Analytics fidelity

Tag the FB-return reload distinctly (`resumed_from_facebook_redirect: true`) so PostHog
funnels don't double-count a single visitor's screen-13 impression.

---

## 3. Account-linking / identity-resolution spec

Facebook's Graph API `/me` call only ever returns a **confirmed** email — there's no
separate verified flag to check; absence means "no email available," never "unverified."

**New account-store field**: optional `fbUserId` on account records, plus a new secondary
index `f:<fbUserId>` -> `<username>`, mirroring the existing `e:<email>` pattern.

**Resolution algorithm** per successful callback:
1. Look up `f:<fbUserId>`. Found -> login to that account. Done.
2. Else, if a verified email was returned: look up `getByEmail(email)`.
   - Found -> **login**, not creation. Upsert `fbUserId` onto that record. Never a
     duplicate.
   - Not found -> **new account**: derive username via the existing collision-retry logic,
     create `{username, email, password: null, fbUserId, updatedAt}`, write `u:`/`e:`/`f:`
     keys.
3. Else (no email at all) -> the "needs email" edge case in §2.4; defer creation until
   supplied, then run step 2's "not found" branch.

The email index is the single source of truth for "does this person already have an
account" regardless of which door they came through — Facebook login only ever *adds* an
`fbUserId` to whatever the email index already resolves to.

A `password: null` account is not a new risk to reason through from scratch — it's the
exact shape `commitTransferredSession` already produces and this codebase already treats as
a legitimate degrade. One accepted v1 gap: an FB-only account can't do a manual password
login on `login.html` yet (no password to check) — out of scope for this pass, but the
record shape should make adding "set your first password" later a non-migration.

---

## 4. Feature-flag mechanism

New `js/facebook-config.js` (mirrors `js/turnstile-config.js`):
```js
var FACEBOOK_APP_ID = 'REPLACE_WITH_REAL_FACEBOOK_APP_ID';
```
Every button-render site checks `FACEBOOK_APP_ID !== 'REPLACE_WITH_REAL_FACEBOOK_APP_ID'`
first — placeholder still there means the button markup is never written into the DOM at
all.

Server (`facebook-oauth-callback.js`) reads `process.env.FACEBOOK_APP_ID`/
`FACEBOOK_APP_SECRET`; fails closed if unset (defense-in-depth — unreachable in practice
without the client flag already being on).

**Everything else — button, redirect flow, callback function, token exchange, identity
resolution, account linking, `staged`-persistence, shared completion function — should be
built and merged now**, per the tracker item's own "do not wait for Meta approval"
instruction. Only dropping in a real `FACEBOOK_APP_ID`/`FACEBOOK_APP_SECRET` (Manager's
separate Meta Business Verification track) is blocked.

---

## 5. Data/API needs (summary)

- New Blobs field `fbUserId` + `f:<fbUserId>` index on `dreamtube-accounts` — additive, no
  migration.
- New function `facebook-oauth-callback.js` (GET, code/state exchange, identity resolution,
  session-transfer-token mint, redirect).
- New env vars `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`, optionally
  `MAX_FACEBOOK_CALLBACKS_PER_IP_PER_DAY`.
- New client file `js/facebook-config.js`.
- `start.html`: FB button markup on both variants; new
  `consumeSessionTransferTokenFromUrlSync()` boot call; `staged` persist/restore pair;
  shared `completeSignupAndAdvance(email)`; skip-screen-13-if-signed-in check.
- Worth factoring: `deriveUsernameBase`'s collision-retry logic is already duplicated
  between `start.html`/`wizard.html`; the new server-side FB path needs it a third time —
  move to a shared `lib/derive-username.js` instead of copying again.
- Accepted tradeoff: the FB path's real billed `getOrStartPendingGeneration(email)` call
  can only fire once the round-trip returns (email not known until then), unlike the manual
  path's "fire in parallel with the click" optimization.

## Out of scope for this pass

- Google and Apple login (explicitly phased later).
- Password-reset / "add a password" flow for FB-only accounts.
- Cross-device sync beyond what already exists for any account.
- Actually creating the Meta app / Business Verification — Manager's separate track.
- Turnstile/bot-abuse gating on the FB callback beyond the per-IP rate limit.

---

## 6. Two design directions — founder must pick between X and Y

Both assume the FB button is added identically to both existing A/B variants (same
relative position, top of whichever step shows the email field) so the in-flight CRO
experiment stays apples-to-apples. In both, the FB button itself stays Meta-brand-compliant
regardless of surrounding layout.

### Direction X — "Social-primary" (recommended)

Precedent: Cal AI's post-quiz screen (social prominent, email demoted to a secondary
"Create account" link beneath a divider).

Feature-flag OFF: the FB block + divider are simply absent — email form renders exactly as
today, no visual gap.

**Tradeoff**: maximizes the specific advantage the founder's own reasoning is built on
(near-one-tap in the exact webview almost all paid traffic already sits in) — but the cost
is visual: email, which does 100% of the actual work until FB approval lands, is demoted to
secondary position for however long that takes.

### Direction Y — "Email stays the hero, Facebook rides alongside it"

Precedent: a flat stack of equally-weighted options (Robinhood/Cash App-style) — no single
option visually dominant.

**Tradeoff**: lower risk — today's screen with one additive button, nothing restructured,
so it can't regress the in-flight CRO experiment's read-out even in spirit, and isolates
FB's own lift as a cleanly measurable before/after. Cost: doesn't fully exploit the
"near one-tap, exactly this webview" case the founder's priority reasoning leans on.

**Recommendation: Direction X.** The founder's own stated reasoning for prioritizing
Facebook first is a claim about where the conversion win actually lives — Direction X
commits to that win instead of hedging it. Since the flag stays off until Meta approval
regardless, there's no real near-term cost to committing to this layout now.

---

## 7. Implementation status (branch `build-facebook-login-mechanics`)

Everything in §2-§5 is **built**, using **Direction Y's minimal placement as a
deliberate interim default** — the founder's X-vs-Y decision (§6) is still open and is
NOT pre-empted by this build. The button's DOM position, its visual treatment (all of
which lives in `js/facebook-config.js`'s `facebookButtonHtml`), its click handler, and
every piece of backend logic are fully decoupled, so switching to Direction X later is a
CSS/markup-only follow-up: move the button, add the divider, demote the email form. No
backend, flow, or state logic would need to change.

What shipped:

| Piece | File |
|---|---|
| Feature flag (placeholder App ID) + OAuth URL/state/cookie helpers + brand-compliant button markup | `js/facebook-config.js` |
| `fbUserId` field + `f:<fbUserId>` index, `getByFacebookUserId`, `linkFacebookUserId`, index cleanup on delete | `netlify/functions/lib/account-store.js` |
| OAuth callback: CSRF check, server-to-server token exchange, `/me`, identity resolution, session-transfer mint, redirect, per-IP rate limit | `netlify/functions/facebook-oauth-callback.js` |
| "Needs email" marker (Blobs-backed, single-use, 15-min TTL — same primitive as `session-transfer-token.js`) | `netlify/functions/lib/facebook-identity-token.js` |
| "Needs email" completion (create-only, never links an unverified email — see that file's security note) | `netlify/functions/facebook-complete-signup.js` |
| Shared server-side username derivation + collision retry | `netlify/functions/lib/derive-username.js` |
| Button on both A/B variants, click handler, `staged` persist/restore, `?bt=` consume, skip-screen-13, shared `completeSignupAndAdvance`, "Signing you in…" state, inline error states, `resumed_from_facebook_redirect` tagging | `start.html` |
| Coverage: identity resolution (all branches), CSRF/fail-closed paths, account-takeover shapes, flag on/off, `staged` round trip, skip-13, manual-signup regression | `test/facebook-oauth-callback.test.js`, `test/account-store-facebook.test.js`, `test/facebook-login-signup-behavioral.test.js` |

Still blocked on the Meta Business Verification track (Manager's), and **only** this:
dropping a real value into `FACEBOOK_APP_ID` (`js/facebook-config.js`) and setting
`FACEBOOK_APP_ID`/`FACEBOOK_APP_SECRET` as Netlify environment variables. Until then the
button is absent from the DOM and the callback fails closed — the feature is completely
inert, with zero effect on the live signup screen.

One deliberate deviation from the letter of §3, worth flagging: step 3's completion path
(`facebook-complete-signup.js`) runs step 2's **"not found" branch only**, exactly as §3
words it — it will never *link* a Facebook identity onto an existing account via the
supplied email. That email is typed by the user, not vouched for by Facebook, so linking
on it would be a plain account-takeover vector. An already-registered address is refused
with a "sign in instead" message plus an escape hatch back to ordinary email signup.

---

**Relevant files grounded against**: `start.html` (screen 13, both variants, boot sequence,
staging), `js/store.js` (`signup`, `commitTransferredSession`,
`consumeSessionTransferTokenFromUrlSync`), `js/turnstile-config.js`,
`js/analytics-config.js`, `netlify/functions/register-account.js`,
`netlify/functions/lib/account-store.js`, `netlify/functions/lib/session-transfer-token.js`,
`netlify/functions/create-session-transfer.js`, `netlify/functions/lib/meta-capi.js`.
