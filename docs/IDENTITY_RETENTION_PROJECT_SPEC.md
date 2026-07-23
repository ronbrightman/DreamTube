# DreamTube — Identity & Retention Project: Spec (v2, decided plan)

Status: **planning only — nothing built yet.** For founder review before any
code is written. Originated from a marketing/growth finding (in-app-browser
retention leak on paid Meta traffic) plus explicit founder direction, not
from the research/evaluation RICE pipeline — no RICE score applies.

**This supersedes v1 of this spec.** v1's core mechanism (social login as the
fix) was wrong and the founder correctly caught it — see Section 0.5.
**Decided plan: email + SMS (Twilio) as the core fix.** Social login is
demoted to an optional convenience layer for later, not the centerpiece.

## 0. The problem

DreamTube runs paid Meta ad traffic into a marketing funnel that hands off
into this product. A large share of that traffic arrives inside Facebook/
Instagram's in-app browser (a webview) — and that webview **wipes local
storage the moment the user closes it.** DreamTube's entire identity model
today is `localStorage`-based, so those users lose their account/session the
instant they leave the in-app browser. Direct, quantifiable retention leak
on ad spend.

**The founder's stated goal**: "easily let users remember to log in the day
after and also remind them to do so." Not just "give them a way back if they
think of it" — a **proactive nudge** the day after signup, with a one-tap
way back in.

## 0.5 Why v1 was wrong, and the corrected mechanism

v1 proposed social login (Facebook first) as the fix, and described "day 2"
as: the user re-clicks the ad or reopens the app link, then taps "Continue
with Facebook" to get back in. **The founder correctly rejected this** —
that assumes the user does something ("re-click the ad") with no reason to
believe they actually would. The flaw: **social login only solves
re-authentication once someone is already back on the site. It does nothing
to bring them back to the site in the first place.** Those are two different
problems, and the whole project lives or dies on the second one.

**The only things that survive the in-app-browser wipe are identifiers
captured *off* the device during the session** — an email address or phone
number, stored server-side. Everything else (cookies, "logged into
Facebook," bookmarks, browser history) is either wiped or unreliable for
this cold-traffic profile. So the real mechanism is **capture-then-reach**:
grab a durable, reachable contact identifier before the user leaves, then
proactively message them on a channel that lives outside the webview.

This reordered the whole plan. After a second research pass (comparing
email, SMS, WhatsApp, and Messenger specifically for "send a day-1→day-2
reminder that actually works for this traffic"):

- **Messenger doesn't qualify at all** — sending a proactive Messenger
  message requires an opt-in token that can only come from a Messenger-
  native interaction (messaging the Page, clicking a *click-to-Messenger*
  ad). A normal web signup form can't produce one. Using it would mean
  changing the ad campaign type itself, not adding a channel — a separate,
  bigger strategic bet, correctly out of scope here.
- **WhatsApp is technically usable** (phone number + a consent checkbox on
  the signup form works, same as SMS) but loses on every practical axis for
  a US-leaning audience: ~4-5x the per-message cost, a heavier setup lift
  (a WhatsApp Business Account + template approval, both new-vendor/
  new-account decisions), and meaningfully lower US phone-number
  penetration than SMS.
- **SMS wins**: attaches to the existing web signup form with just a phone
  number + consent checkbox, near-universal US reach, the strongest
  evidence base for exactly this "24-36h reactivation nudge" use case, and
  the cleanest scheduling story (below).

**Decided: email (magic link) + SMS (Twilio), paired.** This is Phase 1 —
the actual fix, not a fallback.

## 1. What gets built (Phase 1 — the decided plan)

### 1.1 Capture at signup

Add to the signup flow: an optional phone number field with a clear,
unchecked-by-default consent checkbox — required disclosure per TCPA: that
they'll get automated texts (including a day-1 reminder), msg/data rates
apply, consent isn't a condition of using the product, and how to opt out
(reply STOP). Store the phone number + consent timestamp on the account
record (see 1.4). Email is already collected today — no new UI needed there.

### 1.2 Email magic link (the low-friction baseline)

A short-lived (10-15 min), single-use token emailed as a link — click it,
you're logged in, no password/social prompt at all. Standard, well-
established pattern (this codebase already sends real email via Resend for
password reset — the mechanism is nearly identical: generate a token, store
it in Blobs with a TTL, verify-and-consume on click).

- New function `request-magic-link.js` (parallel to
  `request-password-reset.js`): given an email, look up the account,
  generate a token, store it, email a link.
- New function `verify-magic-link.js`: given a token, verify + consume it,
  log the user in (mirrors `verify-password-reset.js`'s shape).
- Reuses the existing `dreamtube-accounts` store and Resend integration —
  no new vendor, no new cost.

### 1.3 SMS day-1→day-2 reminder (Twilio)

**The core new piece.** At signup (if a phone number + consent were given),
schedule a text for +24h: something like *"Come see your dream — [magic
link]"* (exact wording is a message-category decision, see 1.5). If the user
logs in before it fires, cancel it.

**Scheduling mechanic (concrete, no new backend infrastructure)**: Twilio's
Messages API supports native scheduling — create the message with
`ScheduleType=fixed` and `SendAt` = now + 24h. Twilio holds the timer;
DreamTube's backend stays stateless. At signup: one extra API call. At
login: one cancel API call (by the scheduled message's SID, stored on the
account record) if a pending reminder exists. No cron, no queue, no new
scheduled-function infrastructure — fits this codebase's existing
event-driven Netlify Functions model exactly.

- New function `schedule-reminder.js` — called from the signup path,
  schedules the Twilio SMS +24h out, stores the resulting message SID on
  the account record.
- Login path: if the account has a pending reminder SID, cancel it via
  Twilio's API, clear the field.
- The SMS body includes a magic-link URL, generated the same way as 1.2 —
  tapping the text logs them straight in, no separate app/password step.

### 1.4 Account record changes

Extend the existing `u:<username>` record in `account-store.js`:
```
{
  username, email, password,        // unchanged
  phone: "+1...",                    // new, optional
  phoneConsentAt: <timestamp>,       // new, required if phone is set
  pendingReminderSid: "<twilio sid>" // new, cleared on login or after send
}
```
No structural change to the store itself — same Blobs pattern, same
last-write-wins tradeoff already accepted and already fixed once (see the
outage note below). This is additive, not a rebuild.

### 1.5 Message wording is a real decision, not just copy

Under TCPA, a bare "here's the link to your account" reads as transactional
(lighter compliance bar); adding "your free tokens are waiting" or similar
promotional framing makes the whole message marketing, requiring the
consent checkbox described in 1.1 regardless (get the checkbox right either
way — cheap insurance). **Your call on tone**; either way, the checkbox and
disclosure language need to be in place before this ships.

## 2. What needs you specifically

**Decisions:**
1. Message wording/tone for the SMS reminder (transactional vs. promotional
   framing) — affects nothing structurally, just confirm before copy is
   written.

**Accounts to create:**
2. **Twilio account** (confirmed vendor) — sign-up + a phone number to send
   from.
3. **A2P 10DLC registration** under Twilio — one-time brand (~$4-50) +
   campaign (~$15 + a small monthly fee) registration. Needs a real
   business EIN and a live privacy-policy URL showing the SMS opt-in
   language. Takes about a week end to end; start this as soon as Twilio's
   set up, since it's a calendar cost independent of engineering.

**Costs to sign off:**
4. SMS: roughly $0.01-0.02/message including carrier surcharge. At 500
   signups/month with phone capture, that's a few dollars a month; at
   5,000/month, roughly $50-100/month. Trivial next to ad spend, but it's
   real recurring cost that scales with growth — worth being aware of, not
   a blocker.
5. 10DLC one-time registration fees (~$20-65 total).

## 3. Effort, honestly

| Piece | Engineering |
|---|---|
| Phone capture + consent UI on signup | ~0.5-1 day |
| Email magic link (request + verify functions) | ~1 day |
| SMS scheduling + cancel-on-login (Twilio integration) | ~1-2 days |
| Tests + review cycle (this codebase's usual multi-round pattern) | ~1-2 days |

**Roughly 4-6 days of engineering total.** The one real calendar dependency
is 10DLC registration (~1 week) — start it in parallel with the build, not
after, so it's not the thing everything waits on.

## 4. What's explicitly deferred (not part of Phase 1)

These were researched but are correctly not part of the decided plan right
now — kept here so the reasoning isn't lost, not as a commitment to build
them next:

- **Social login (Facebook/Apple/Google).** Still technically useful
  eventually — Facebook specifically is the only provider that works inside
  the in-app browser at all, since Google is hard-blocked there
  (`disallowed_useragent`) — but it's a re-authentication convenience layered
  on top of whatever *actually* brings someone back (email/SMS above), not
  a return mechanism itself. Revisit once Phase 1 is live and there's real
  data on whether login friction (vs. return-in-the-first-place) is still a
  meaningful drop-off point. If pursued later: Facebook needs Meta Business
  Verification (requires a business-domain email, not `@gmail.com` — worth
  checking whether the existing ads/Pixel Meta Business account already
  cleared this) + App Review (days-to-2-weeks); Apple needs Developer
  Program enrollment ($99/yr, 6-month client-secret rotation chore); Google
  is free and fast but has no value inside the in-app browser specifically.
- **PWA + Web Push.** iOS push requires the site to already be added to the
  home screen, and you can't even trigger that flow from inside the
  in-app browser (has to detour through "open in Safari" first) — weak as a
  primary mechanism for this exact cold-traffic profile. Worth doing
  eventually as a minor upsell for already-engaged users (the strongest use
  case being an event-driven "your dream is ready" push once someone's
  installed), not as part of the day-1→day-2 fix.
- **Meta retargeting via a Customer List custom audience** (built from
  captured emails/phones, not just pixel data) and **Messenger/WhatsApp**
  reactivation (the latter requiring a structurally different ad type,
  click-to-Messenger, not a bolt-on to the current funnel) — both real,
  both bigger strategic/marketing-side considerations belonging with the
  growth session, not the product build.

## 5. One important context note (from the earlier, incorrect v1 draft)

A server-side account store already exists and is live —
`netlify/functions/lib/account-store.js` + `register-account.js` +
`account-login.js`, shipped to fix "accounts only work on the device they
were created on." It survived a real production incident this same week (a
consistency-assumption bug broke every signup for part of a day during this
exact ad campaign, hotfixed same-day) — the fix reverted to the safe,
accepted last-write-wins pattern every other Blobs store in this codebase
already uses successfully (`entitlements.js`, `tracker-store.js`,
`paywall-settings.js`). The additions in Section 1.4 follow that same
accepted pattern — no new consistency risk introduced.

---

*Sources for the SMS-vs-WhatsApp-vs-Messenger comparison and the TCPA/10DLC
specifics were verified via live web search during the research pass behind
this decision — available on request if useful for your own review.*
