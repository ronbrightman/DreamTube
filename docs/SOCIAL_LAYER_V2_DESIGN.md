# Social Layer v2 — Product Spec + Two Directions (Manager design agent, 2026-08-03 night)

Builds on docs/SOCIAL_LAYER_V2_RESEARCH.md (its verdicts are constraints here).
Founder picks a direction from the mock pages (mock-profile-a-x7q4.html /
mock-profile-b-x7q4.html) before build starts.

## URL scheme
- Public profile: u.html?handle=<username> (no login gate, like explore.html).
- Share URL: /.netlify/functions/share-profile?handle=X — og-tags + human redirect,
  mirroring share-dream.js. This URL is the acquisition object.
- profile.html stays the owner-private page.

## Data / API (all with blobs-retry.js bounded retry)
- Store dreamtube-profiles: key lowercased username -> { handle, displayName,
  avatarDataUrl (Me-photo re-downscaled 256px JPEG via resizeImageFile), bio <=150
  chars (IG parity, dir=auto, plain text), updatedAt }. Written by token-gated
  sync-profile.js (on Edit-profile save and first publish); read by public
  get-profile.js: GET ?handle=X -> { profile, dreams (feed filtered by ownerHandle,
  newest first), publishedCount, commentCounts }.
- Store dreamtube-comments: key dreamId -> [{ id, handle, text, createdAt }].
  get-comments.js (public GET), add-comment.js (POST, auth token, trim, cap 300
  server-side, rate-limited), delete-comment.js (POST, auth; commenter==caller OR
  dream owner==caller). Denormalize commentCount onto feed record (same accepted
  RMW race as likes — document identically).
  Report: extend report-dream.js/moderation-store.js with comment target type.
  Block: client hides comments from getBlockedHandles() (explore.html pattern).
- Store dreamtube-follows: key following:<username> -> { handles, updatedAt }
  (private, auth-gated read get-following.js); key counts:<username> ->
  { followers } via follow-user.js toggle — owner-only read, NEVER public at MVP.
  Explore "Following" chip: fetch own list once, filter client-side.

## States
A. Visitor logged-in: Follow (btn-primary) -> optimistic flip to Following
   (outline) with rollback toast (explore like-handler pattern); tap Following
   unfollows, no confirm. No follow button on self.
B. Visitor signed-out: everything readable; Follow/composer/like open the existing
   #modal-signup-nudge with next= back to the profile. Persistent bottom CTA bar
   replacing nav: "Dreams, turned into videos. Create yours free" ->
   login.html?mode=signup&next=... (TikTok web precedent).
C. Owner toggle: segmented tiles on .char-mode-row/.char-mode-btn language.
   PRIVATE = profile.html unchanged. PUBLIC = navigates to u.html?handle=<me> —
   literally the visitor page; when viewer==handle it adds the toggle, big Share
   button, and counts. Private view shows "N published" (server truth) AND
   "M created on this device" (exact label — honest device-local).
D. Empty/loading/error: skeleton header; "This dreamer hasn't set up their profile
   yet"; zero-dreams copy per viewer/owner; fetch-failure retry pattern; comments
   empty "No thoughts yet — be the first."; post-failure optimistic rollback+toast.
E. Comment sheet (shared js/comment-sheet.js, both directions): existing
   .sheet-overlay/.sheet + SheetDismiss. Title "Comments · N", flat list newest
   first: 28px avatar, tappable @handle -> their u.html, relative time, text
   (esc(), dir=auto). Composer pinned at sheet bottom, grows to 3 lines, counter
   at 250/300, Post disabled when empty. Signed-out: composer row = "Log in to
   comment". Per-comment overflow: Delete (own, or any on own dream), Report,
   Block. Also mount behind a comment icon in explore.html's action rail
   (open decision #3).
F. Share: navigator.share -> clipboard fallback -> unsupported message — reuse
   share-sheet.js chooseLink ladder with a profile payload. share-profile.js og:
   title "@handle's dreams on DreamTube", desc "N dreams, turned into video.
   Watch them — or create your own.", image = avatar (branded card = decision #2).
G. Interpretations: never on u.html. Owner-public-preview only, muted line under
   counts: "Your interpretations stay private to you. They're never shown here."
   Visual seam: reserved slot under each caption for the later opt-in release
   ("Shared by @handle" label) — layout decision only, no code at MVP.

## Build order (three mergeable slices)
1. Profile shell (store+sync+get+u.html+toggle+share+og endpoint+bio field).
2. Comments (stores/functions + comment-sheet.js + moderation extensions).
3. Follow (functions + button states + Explore chip + owner private counts).

## Out of scope
Threaded comments, comment likes, public follower counts, dedicated following
feed, notifications (seam only), interpretation opt-in (seam only), QR, /u/handle
vanity redirect (later netlify.toml line).

## QA checklist for build
Mobile-webview viewport end-to-end; >=44px tap targets (comment overflow needs
padding); dir=auto on bio/comments/composer; esc() every user string — comments
are the first hostile-UGC text surface, XSS review mandatory; per-instance token
guard on optimistic follow/comment (documented recurring bug class); sheet
max-height scroll, no nested scroll traps.

## Direction A — "Faithful Instagram"
Avatar left (76px gradient ring) / single stat right ("12 dreams published");
bio block; action row; segmented toggle; 3-col 3:4 grid, 2px gaps, muted autoplay
(vcardVideoObserver); tile -> full-screen viewer (reuse .feed-card: video, scrim,
caption, like/comment/share rail) -> comment sheet. Tradeoff: maximum familiarity,
scales at 20+ dreams; but captions/comments two taps deep, and at 1-3 dreams the
grid broadcasts emptiness (anti-social-proof).

## Direction B — "Dream Journal Feed" (RECOMMENDED)
Centered identity block (existing .profile-head), bio, counts line; toggle; big
Share button; full-width 9:14 cards per dream: muted autoplay video, action row
(heart / comment-count / share), caption 3-line clamp, reserved interpretation
seam, top-2 comment preview lines, "View all N", "Add a thought…" teaser -> same
sheet. Tradeoff: looks full and personal at exactly today's content volume (one
dream fills the first viewport), zero taps to social proof, founder's verbatim
mental model, reuses most existing components; long scroll at 20+ dreams — at
that point graduate to grid-above-feed (Direction A becomes the later chapter).
Per-card video mounting needs explore-style windowing from day one.

## Recommendation
Direction B now, for content-shape honesty; A is the natural later evolution.

## Open decisions for the founder
1. Interpretation per-dream opt-in timing (rec: later, additive).
2. Share-link og-image: bare avatar vs branded card (rec: branded, fast-follow).
3. Comments on Explore rail too at MVP (rec: yes — one component, one QA pass).
4. Direction A vs B (the mock pages).
