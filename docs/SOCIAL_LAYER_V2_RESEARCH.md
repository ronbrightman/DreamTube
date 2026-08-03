# Social Layer v2 — Research Findings (Manager research agent, 2026-08-03 night)

Founder spec (verbatim intent, 08-03 ~23:40): social layer v2 — people can COMMENT
and FOLLOW. Profile page like an Instagram public profile: avatar top-left, bio text
below, then videos each with its text below and comments below that. Two segmented
toggle tiles: PUBLIC / PRIVATE feed, owner picks the view. Public view: big
share-this-profile button + count of dreams PUBLISHED. Private view: also count of
dreams CREATED. Open founder question: interpretations on public profiles —
public / private / per-user choice?

Architecture facts this leans on: feed = one JSON blob (feed-index, whole-array RMW,
no CAS); verified server-side auth tokens exist (lib/account-auth-token.js) and
already gate publish-dream/block-user; report/block/moderation basics exist
(report-dream.js, get-moderation-reports.js, block-user.js + lib/block-store.js);
interpretations are per-persona local-only, never in the publish payload; avatars
exist (generate-avatar.js); only published dreams exist server-side.

## 1. Follow + comments in early consumer AI-content apps
- Sora (OpenAI): TikTok-style AI feed — like, flat comment, remix, follow.
- Civitai: follow + emoji reactions + flat comments; reactions carry engagement.
- Dream apps' norm is ANONYMOUS sharing (Dream Decoder, Temenos) — DreamTube's
  handle-attributed feed is already more social than category norm.
- Poparazzi (#1 App Store) shipped NO comments/follower counts; BeReal keeps
  comments flat with reactions carrying load.
=> Flat comments only; account-gated writes, login-free reads; NO public follower
counts at MVP ("0 followers" = anti-social-proof); cheapest follow feed effect =
"Following" filter chip on Explore (extends existing username filter).

## 2. Public profile as growth surface
- IG/TikTok/YouTube converge: identity block -> counts -> actions -> content;
  Share-profile is first-class (QR flows exist for exactly this).
- Web-only advantage: shared profile link opens instantly anywhere — a true
  landing page. Profile-share is an unincentivized referral loop (sidesteps the
  deferred referral-abuse problem).
- Hard prerequisite: URL-addressable, logged-out-viewable profile (u.html?handle=X).
  Today profile.html is private-only.

## 3. Interpretation visibility — RECOMMENDATION: private-only at MVP
Per-dream owner OPT-IN as a later additive release. Not public-by-default, not
choice-at-MVP. Reasons: (1) Venmo lesson — the default IS the policy; intimate AI
readings ≈ Strava heart-rate (artifact public, analysis private); (2) existing
promise "Private to you. Never shown on Explore" must not be quietly weakened;
(3) growth-side compliance: public interpretations push the ad-facing product
toward restricted-health framing Meta ads must avoid; (4) zero-work option —
interpretations never leave localStorage today.

## 4. Moderation minimums (Apple UGC 1.2 as the bar)
Report on every item (extend report-dream with commentId), delete-own, DREAM OWNER
deletes any comment on their own dream (IG/YouTube pattern — distributes moderation),
block already works (extend client filter to comments), length cap ~300 chars,
per-account rate limit (lib/rate-limit.js), founder reads the existing report queue.

## 5. Data structures + MVP line
- Comments: new Blobs store keyed PER DREAM (not in feed-index) with bounded
  retry (blobs-retry.js); denormalized commentCount on feed record (likes-grade trust).
- Follow: per-follower record (block-store.js mirror); follower reverse index can
  slip to v2.1 since no public counts.
- Public profile: u.html?handle=X rendering get-feed filtered by ownerHandle +
  small profiles store {handle, avatar, bio} + token-gated save.
- "Dreams created" only exists in localStorage -> label device-local honestly.
- Owner PUBLIC toggle = same code path as visitor view (IG preview semantic).

MVP order: (1) profile shell + share, (2) flat comments, (3) follow + Explore chip.
Defer: threading, comment likes, public follower counts, dedicated following feed,
interpretation opt-in, notifications (leave seam), anonymity mode.
