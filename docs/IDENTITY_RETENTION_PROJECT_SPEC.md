# DreamTube — Identity & Retention Project: Full Spec

Status: **planning only — nothing built yet.** For founder review before any
code is written. Originated from a marketing/growth finding (in-app-browser
retention leak on paid Meta traffic) plus explicit founder direction, not
from the research/evaluation RICE pipeline — there is no RICE score for this.

## 0. The problem, and the mechanism that fixes it

DreamTube runs paid Meta ad traffic into a marketing funnel that hands off
into this product. A large share of that traffic arrives inside Facebook/
Instagram's in-app browser (a webview) — and that webview **wipes local
storage the moment the user closes it** (backs out to the Facebook/Instagram
feed). DreamTube's entire identity model today is `localStorage`-based, so
every one of those users loses their account/session the instant they leave
the in-app browser. This is a direct, quantifiable retention leak on ad spend.

**How the fix actually works, concretely (day 1 → day 2):**

- **Day 1** (inside the in-app browser): user signs up via "Continue with
  Facebook." We verify that assertion server-side and create an account
  record **on our server** (Netlify Blobs), not in that browser. We also
  drop a local "you're logged in" marker so today's session works instantly,
  same as now.
- They close the app. That browser instance is wiped — local marker gone.
- **Day 2**: brand-new browser instance, zero memory of yesterday. But the
  user is almost always still logged into *Facebook itself* — a separate
  thing Facebook remembers, unrelated to our wiped storage. They tap
  "Continue with Facebook" again (often just a confirmation tap, sometimes
  not even that). We verify it server-side, get the same Facebook ID back,
  look up the **server-side** account record — found, because it never
  lived in the wiped browser. They're back in: same handle, same token
  balance, same published/shared dreams.
- **What they don't get back automatically**: private (unpublished) dreams/
  characters from day 1 — those still live only in that wiped browser.
  Recovering those is the separate, already-deferred
  `sync-private-dreams-videos-later` project, deliberately out of scope here.

Design goal: **frictionless one-tap re-acquisition of a persistent server
identity** — not "survive the wipe" (nothing can survive it locally), and
not "recover everything" (private dreams are a separate project).

## 0.5 Correction to an earlier draft of this spec

An earlier pass of this research incorrectly assumed no server-side account
store exists yet. **That's wrong — it already exists and is live.**
`netlify/functions/lib/account-store.js` + `register-account.js` +
`account-login.js` ship on `main` today, built to fix "accounts only work on
the device they were created on." It survived a real production incident
(a consistency-assumption bug broke every signup for part of a day during
this exact ad campaign) and was hotfixed the same day. This project **extends
that existing store**, it does not rebuild one from scratch — meaningfully
less Phase-0 work and no repeat of that outage's risk profile, since the
fix already reverted to the safe, accepted last-write-wins pattern every
other store in this codebase uses (`entitlements.js`, `tracker-store.js`,
`paywall-settings.js`).

**Current shape** (`account-store.js`, verified by direct read):
- Blobs store `dreamtube-accounts`, keyed `u:<normalized username>` →
  `{username, email, password (plaintext), updatedAt}`, with a secondary
  index `e:<normalized email>` → username.
- Passwords are plaintext today (a known, already-documented, pre-backend
  limitation) — see Section 4 for why this must change before this project
  ships.
- No `providers` field yet — this is the one real addition needed.

**The existing asset that makes this cheap:** `entitlements.js` (token
balances, Stripe fields) is *already* keyed by normalized email, and its own
header comment explicitly anticipated this project:

> "keying entitlements on email lets Apple/Google Sign-In be added later
> purely additively (resolve to an email, hit this same lookup), with no
> migration of paid entitlements or token balances."

So a social-login user who resolves to an existing email **automatically
inherits their token balance already**, zero migration needed.

## 1. Architecture: extending the existing account store

Add a `providers` field to the existing `u:<username>` record:

```
{
  username, email, password,       // unchanged, existing fields
  providers: {                     // NEW
    facebook: "<fb-user-id>",
    google:   "<google-sub>",
    apple:    "<apple-sub>"
  },
  updatedAt
}
```

**New function**: `auth-social.js` — receives a provider assertion (an OAuth
`code`, or a Google/Apple `id_token` JWT), verifies it **server-side**
(validate JWT signature against the provider's public keys; check
`aud`/`iss`/`exp`/`nonce`), resolves to `{email, providerSub}`, then:
- If `e:<email>` already exists → link this provider onto that existing
  account (add to `providers`), log in as that account.
- Else → create a new account: generate a username (from display
  name/email local-part, collision-suffixed), store `providers.<x> =
  providerSub`, no password.

**Can a user have both password and social login?** Yes — one account
record, optional `password`, one or more `providers` entries. Email is the
join key: "Continue with Google" using an email that already has a password
account links to it rather than erroring, since a provider-verified email is
the same person.

**Real tensions to design around, not hand-wave:**

1. **Private dreams/characters still don't sync** (Section 0). State this
   limitation to users honestly wherever "your account" language appears
   post-login.
2. **Apple's "Hide My Email"** returns a per-app relay address
   (`…@privaterelay.appleid.com`), not the real email. If the same person
   also used Google (real email), email-as-join-key sees two different
   people. No clean fix — store `providers.apple` regardless and accept
   some users will end up with two linked-but-separate records unless they
   manually link.
3. **Username generation** for social-only signups — auto-generate,
   collision-suffix, let them edit later (existing profile-identity editing
   from the recent profile/Me-character work already covers "edit your
   name" — reuse it).
4. **Password storage must move to hashed** (bcrypt/scrypt) before this
   ships — plaintext was an accepted pre-backend limitation, not something
   to carry into a system now also handling federated identity. Small,
   contained change to `account-store.js`'s write/verify paths.

## 2. Provider-by-provider scope

**The single fact that reorders everything:** Google OAuth is **blocked
inside embedded webviews** (`403: disallowed_useragent`), confirmed via
Google's own developer blog, true since 2021, no in-webview workaround.
Facebook Login works natively inside the FB/IG in-app browser — it's Meta's
own environment. Since the entire retention leak lives in that exact
webview, **Google has zero value for the traffic this project targets** —
only Facebook works in-context. This is why Facebook-first isn't just
"matches the ad source," it's technically required.

### 2a. Facebook — build first

- **Flow**: OAuth 2.0 authorization-code (redirect) — button → redirect to
  Facebook → redirect back to a Valid OAuth Redirect URI → a Netlify
  Function exchanges the code (App ID + App Secret, server-side) → resolves
  `{email, fb-user-id}`.
- **You need to**: create/reuse a Meta app at developers.facebook.com, add
  the Facebook Login product, set Valid OAuth Redirect URIs, get App ID +
  App Secret, add a Privacy Policy URL and a Data Deletion callback.
- **`email`/`public_profile`** work at Standard Access automatically, but
  public (non-tester) use needs **Advanced Access**, which requires **App
  Review + Business Verification**.
- **Two real friction points**:
  1. Business Verification requires a **business-domain email** —
     `@gmail.com` is not accepted. Worth checking now whether your existing
     Meta ads/Pixel business account already cleared this — if so, this
     blocker may already be resolved.
  2. App Review for Facebook Login is one of the lighter reviews but still
     needs a usage description, screencast, privacy policy, and a working
     test path. Turnaround: days to ~2 weeks.
- **Cost**: free.

### 2b. Apple — build second

- **Cost: $99/year, Apple Developer Program** (confirmed current pricing —
  the $299 tier is the unrelated Enterprise program). Real, recurring,
  needs your explicit sign-off.
- No App Store app required for web Sign in with Apple — configure a
  **Services ID** (becomes the web OAuth `client_id`), an App ID, and a
  **Sign in with Apple private key (.p8)**.
- **Flow**: Apple posts back to your Return URL as an HTML form POST
  (`response_mode=form_post`) — needs a Netlify Function to receive and
  verify the `id_token` JWT.
- **Two ongoing gotchas**: (1) the web client secret is a JWT signed with
  the `.p8` key and **must be regenerated at most every 6 months** — an
  ongoing chore, not one-time setup; (2) Apple only returns the user's name
  on **first** authorization — persist it then or it's gone for good.
- **You need to**: enroll in the Developer Program (24–48h+, occasionally
  longer for identity checks), create App ID + Services ID + Sign in with
  Apple key, register the web domain + Return URL.
- No lengthy app-review process for web sign-in specifically — the delay
  here is enrollment, not review.

### 2c. Google — build third

- **Cost**: free. **Value for this specific project is limited** — see the
  in-webview block above. Real value is for users already in a real browser
  or the installed PWA, which is a smaller slice of the exact traffic this
  project targets.
- **Flow**: Google Identity Services returns an `id_token` (JWT) client-side
  → POST to a Netlify Function → verify against Google's public keys. No
  client-secret exchange needed for identity-only use.
- **You need to**: Google Cloud project → OAuth consent screen → OAuth
  Client ID (Web application) → Authorized JavaScript origins + redirect
  URIs. No lengthy verification needed for basic `openid`/`email`/`profile`
  scopes — fastest of the three to stand up, roughly hours.

## 3. PWA + Web Push (separate, later phase)

**PWA baseline**: `manifest.json` exists but is minimal (one icon). Needs
192×192 + 512×512 + a maskable icon + `apple-touch-icon`. No service worker
exists anywhere in the repo today — needed for offline shell and (Android)
push. Android/Chrome can prompt install via `beforeinstallprompt`; **iOS has
no such event** — the realistic path there is in-app-browser → "Open in
Safari" → manual Add to Home Screen, real friction, be honest about
conversion.

**Web Push reality (2026, verified)**: **iOS push only works for a PWA
that's already been added to the home screen** (since iOS 16.4) — an open
tab, including the in-app browser, has no push access at all. This means
push has a chicken-and-egg problem for exactly the users this project cares
about: they can't receive push until they've already escaped the in-app
browser and installed the PWA. Real channel, but **downstream of login**,
not a substitute for it — correctly a later phase.

**Needs its own backend piece**: a Netlify Function + Blobs store
(`dreamtube-push-subscriptions`) to persist subscriptions and send. No
scheduled/cron functions exist or should be added (per `AGENT_POLICY.md`) —
which actually points at the best first use case anyway: **event-driven**,
not a cron blast.

**Strongest first use case: "Your dream is ready."** Fired from the
generation-completion path. Today's `fireNotification()` in `home.html` only
works if the tab is still open — push reaches the user after they've
already left, which is exactly the gap worth closing first. "Come back and
make another" / daily prompts are weaker and spam-prone — defer those.

**Vendor decision needed**: self-hosted web-push (VAPID) — free, no third
party, fits the existing Blobs/Functions pattern, but you own subscription
storage + Safari/APNs edge cases — vs. a managed provider like OneSignal
(free tier, handles the cross-platform complexity, faster to ship, adds a
dependency). Your call.

## 4. SMS (explicit fallback, kept short)

Third-priority per your own direction — scope as OTP/account-recovery
fallback, not a coequal channel.

- **2026 provider landscape**: Twilio remains the default
  (~$0.0083/SMS US + carrier fees + ~$0.05/verification via Twilio Verify).
  Telnyx/Plivo run ~25–40% cheaper at list. US delivery requires **A2P 10DLC
  registration** ($4–$50 + per-campaign fees + a per-message carrier
  surcharge averaging ~$0.0033).
- **Why this is different from the OAuth providers**: every message is
  **recurring, usage-scaling spend** — the only channel in this project
  whose cost grows with success, not a one-time setup.
- **Recommendation**: defer until data shows social + push leave a real
  recovery gap. If pursued, a Verify-style API absorbs OTP + 10DLC
  complexity better than raw SMS sends. 10DLC vetting itself takes days to
  weeks — a calendar cost independent of engineering.

## 5. Phasing, with reasoning

- **Phase 0 — extend the account store.** Add `providers` + move passwords
  to hashed storage. Small now that it's an extension, not a rebuild.
- **Phase 1 — Facebook Login.** Only provider that works inside the exact
  webview where the leak happens; matches the traffic source directly.
  Long pole is external (App Review + Business Verification) — start that
  clock immediately, in parallel with Phase 0 engineering.
- **Phase 2 — Apple + Google.** Apple for iOS/credibility ($99/yr + the
  6-month secret rotation chore). Google for Android/desktop reach (free,
  fast, but no value inside the in-app browser). Grouped because each is
  incremental once Phase 0/1 exist.
- **Phase 3 — PWA hardening + Web Push.** Distinct stack, its own testing
  burden (real iOS device add-to-home-screen testing), gated on a vendor
  choice. Downstream of login, not a replacement for it.
- **Phase 4 — SMS fallback.** Only if data shows a real remaining gap after
  Phases 1–3. Ongoing per-message spend + 10DLC.

**One-line logic**: fix the login that works where the problem actually
lives (Facebook, Phase 1) on the foundation that already exists (Phase 0),
then widen reach (Phase 2), then add a re-engagement channel (Phase 3), then
a paid fallback only if still needed (Phase 4).

## 6. What needs you specifically (consolidated)

**Decisions:**
1. Approve the phase order (Facebook-first).
2. Push vendor: self-hosted web-push vs. OneSignal (or similar).
3. Whether to pursue SMS at all right now (Phase 4).

**Accounts/verification to start:**
4. Meta app for Facebook Login — and check whether your existing ads/Pixel
   Meta Business account already cleared Business Verification.
5. A business-domain email/entity for Meta Business Verification if not
   already covered — `@gmail.com` won't work. Likely the single biggest
   blocker; worth checking first.
6. Apple Developer Program enrollment — **$99/year**, real recurring cost.
7. Google Cloud project + OAuth consent screen (free, ~hours of setup).
8. A2P 10DLC registration — only if Phase 4 (SMS) proceeds.

**Costs to sign off:**
9. Apple Developer Program: $99/yr.
10. Web Push: free (self-hosted) or free-tier (OneSignal) — confirm tier
    limits once a provider's picked.
11. SMS (if pursued): recurring, usage-scaling, ~$0.008–0.05/message +
    10DLC surcharges.

**Start these clocks now, independent of engineering:**
12. Meta App Review + Business Verification — days to ~2 weeks.
13. Apple enrollment — 24–48h+.
14. A2P 10DLC (only if Phase 4 proceeds) — days to weeks.

## 7. Effort, honestly

| Phase | Engineering | Notes |
|---|---|---|
| 0 — extend account store | ~1–2 days | Small now that it's additive, not a rebuild |
| 1 — Facebook Login | ~3–5 days | External review is the real blocker, not code |
| 2 — Apple + Google | ~4–7 days combined | Apple's form-POST + JWT-secret rotation is the fiddly part |
| 3 — PWA + Web Push | ~1–2 weeks | Service worker + subscription backend + real-iOS-device testing tax |
| 4 — SMS | ~2–3 days | Low eng effort; the recurring cost is the real consideration |

**Total: a few weeks of engineering spread across phases.** The honest
headline: **the long poles are calendar, not code** — Meta review, Apple
enrollment, and (if pursued) 10DLC all run on external clocks independent of
engineering time. Starting those in parallel with Phase 0 keeps them from
becoming the thing everything else waits on.

## 8. Login-screen design direction (narrow — the real decisions are above)

Provider button branding (Apple/Google/Meta) is largely **mandated** by each
platform's own guidelines, gating their own review — not a free design
choice. Two real options for `login.html`/`start.html`:

- **Direction A — social-first.** `Continue with Facebook` at top (only one
  that works in-context), then Apple, then Google; email/password demoted to
  a small "or use email" link. Matches the technical reality in Section 2;
  the pattern most Meta-funnel consumer apps already use.
- **Direction B — email-primary.** Keep today's username/password form as
  the hero, add social buttons below as a "faster ways to continue"
  cluster. Protects the existing flow's prominence, but suppresses social
  adoption exactly where it matters most — undercuts this project's own
  goal.

Recommendation: **Direction A**, for this traffic. Final call is yours.

---

*Prepared by the design agent's research pass, corrected against the actual
current `main` branch state before this document was finalized. Sources for
all vendor-specific facts (Apple pricing, Google's webview block, Meta
Business Verification requirements, PWA push limitations, SMS provider
landscape) were verified via live web search, not assumed from training
data — available on request if useful for your own review.*
