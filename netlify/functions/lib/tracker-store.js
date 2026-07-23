// netlify/functions/lib/tracker-store.js
//
// Backing store for tracker.html — DreamTube's owner-only "everything still
// open" list (open tasks + ideas), so the founder has one place to see
// what's outstanding instead of it being scattered across conversation
// history. Not a Netlify Function itself — a plain module the two tracker
// functions (get-tracker-items.js, update-tracker-item.js) both require(),
// matching this codebase's existing "self-contained function, shared bits
// in a plain require()" pattern (see paywall-settings.js, entitlements.js).
//
// Backed by a single Netlify Blobs store ("dreamtube-tracker"), ONE KEY
// ("items") whose value is the full items array — same small-record
// singleton-key pattern as paywall-settings.js, just a list instead of a
// single boolean. Uses Blobs' default eventual consistency (not strong) —
// same reasoning as paywall-settings.js/entitlements.js: strong consistency
// threw BlobsConsistencyError unconditionally in this deploy environment.
// This is an internal single-owner tool with low write frequency, so
// eventual consistency's edge-propagation delay (up to ~60s) is a
// non-issue here in practice.
//
// Seeding: on the very first read in a fresh environment (no "items" key
// written yet), getItems() seeds the store with SEED_ITEMS below and
// persists that seed immediately, so every later call (including from
// update-tracker-item.js) reads the persisted, possibly-edited list
// instead of re-seeding over real edits. This mirrors entitlements.js's
// "materialize on first read" pattern for a never-before-seen email.
//
// Item shape: { id, category: "task"|"idea", title, detail,
//   priority: "high"|"medium"|"low", done: boolean,
//   comments: [{ id, author: "ron"|"claude", text, timestamp }],
//   createdAt: string|null, doneAt: string|null, startedAt: string|null }
//
// update-tracker-item.js only ever patches `priority`/`done`/`started`
// (a one-way "start working on this" signal — see updateItem's own doc
// comment) and appends one new entry to `comments` on an existing item —
// id/category/title/detail are seed-authored-or-added content, not
// something that endpoint's PATCH-style write lets anyone mutate (see
// that function's own doc comment for why).
//
// `comments` used to be a single overwritable `comment: string` field — a
// free-text note the founder left for whoever maintains this tracker's
// content to read and act on later. That was replaced with an
// append-only list of attributed entries (this file's SCHEMA CHANGE
// comment above updateItem explains why and how existing data migrates)
// so a note from Ron and a note from whoever's driving a build/review
// session never clobber each other — tracker.html now offers two
// separate compose areas per item ("Your comment" / "Claude's comment"),
// both going through this same owner-gated endpoint (only the owner's
// own browser session can even load tracker.html's content at all — see
// that file's own doc comment), `author` just self-labeling which voice
// a given entry represents. It's an empty array for every seed item —
// nothing seeds a comment.
//
// `createdAt`/`doneAt`/`startedAt` are all `null` for every seed item —
// there's no real historical timestamp to backfill for content that
// predates this field existing at all, and a fabricated one would be
// actively misleading (see tracker.html for how a `null` renders: the
// timestamp line is simply omitted rather than showing a fake date).
// New items created through add-tracker-item.js do get a real `createdAt`
// going forward (see addItem below); `doneAt`/`startedAt` are set the
// moment an item actually transitions to done/started, for items both
// old and new (see updateItem below).
//
// New items are no longer only added by hand-editing SEED_ITEMS above and
// pushing to main — that only ever affected a fresh environment's very
// first read (getItems()'s seed-once behavior below means a source edit
// silently does nothing at all once the live store has been seeded once).
// add-tracker-item.js/delete-tracker-item.js are the real, owner-gated
// add/remove path now, backed by addItem()/deleteItem() below — SEED_ITEMS
// still exists and is still what a brand-new environment seeds from, this
// is purely additive on top of it.

var { getStore, connectLambda } = require('@netlify/blobs');

var STORE_NAME = 'dreamtube-tracker';
var KEY = 'items';

// Seed content is exact, founder-approved copy — see the tracker-page build
// task this was written for. Do not paraphrase/trim when editing; add new
// items instead of rewriting these if the content ever needs to change.
var SEED_ITEMS = [
  {
    id: 'token-refund-gap',
    category: 'task',
    priority: 'high',
    done: true,
    comments: [],
    createdAt: null,
    doneAt: null,
    startedAt: null,
    title: 'Decide: refund tokens if generation fails after submission?',
    detail: 'RESOLVED: auto-refund once per day per user on a post-submission generation failure (E205/E208 etc.); beyond that daily auto-refund, direct the user to request a manual refund via the support form. See idea-auto-refund-policy for the implementation, which depends on idea-support-contact-form existing for the manual fallback path.'
  },
  {
    id: 'env-vars-confirm',
    category: 'task',
    priority: 'high',
    done: false,
    comments: [],
    createdAt: null,
    doneAt: null,
    startedAt: null,
    title: 'Confirm required env vars are actually set in the live Netlify environment',
    detail: 'Can\'t be verified from the repo alone. Check: OWNER_EMAIL, MAX_GENERATIONS_PER_IP_PER_DAY, DAILY_SPEND_CAP_USD, MAX_TOKEN_GRANTS_PER_IP_PER_DAY. Without OWNER_EMAIL set, admin.html\'s toggle and any future owner bypass don\'t work for the founder specifically.'
  },
  {
    id: 'agent-skill-duplication',
    category: 'task',
    priority: 'high',
    done: false,
    comments: [],
    createdAt: null,
    doneAt: null,
    startedAt: null,
    title: 'Resolve duplicate agent/skill registration (research/evaluation/design/marketing + all 13 frozen marketplace skills)',
    detail: "Each of the four portable agents, and all 13 frozen reference skills, are currently registered twice: once as a raw local copy (~/.claude/agents/, ~/.claude/skills/) and once via the installed product-agents marketplace plugin. This is exactly the kind of routing ambiguity that risks Claude picking the wrong/stale copy, and it already caused one real instance of drift this session. The raw copies were a deliberate \"frozen, stable\" design choice, so the fix isn't simply deleting them — needs a decision on which mechanism is canonical, then cleanup."
  },
  {
    id: 'dodo-merge-decision',
    category: 'task',
    priority: 'medium',
    done: false,
    comments: [],
    createdAt: null,
    doneAt: null,
    startedAt: null,
    title: 'Decide: merge the dormant Dodo Payments backend branch now?',
    detail: 'claude/dodo-payments-backend is fully built and tested (checkout session + webhook, 25 passing tests) but was never merged. It stays fully inert either way — no real Dodo credentials exist yet — but merging now is a housekeeping call, not a functional one. It\'s no longer required for launch given the token-economy pivot, but will be needed once real token purchases go live in shop.html (whichever provider ends up chosen).'
  },
  {
    id: 'payment-provider-final',
    category: 'task',
    priority: 'medium',
    done: false,
    comments: [],
    createdAt: null,
    doneAt: null,
    startedAt: null,
    title: 'Pick a final payment provider for real token purchases',
    detail: "Dodo underwriting approval is pending (the founder's own step, in progress). If it falls through: Paddle has a documented, specific AI-content-category risk for exactly what DreamTube generates (AI video that can plausibly include human likenesses); 2Checkout/Verifone is the most individual-seller-friendly alternative researched so far, unconfirmed on AI-content risk. BlueSnap and Xsolla were checked and don't beat this shortlist (BlueSnap keeps DreamTube as merchant of record instead of Dodo/Paddle's model; Xsolla is gaming-commerce-specific, off-category). \"Shop\" was mentioned as a possible provider to check but never clarified — could be Shopify Payments, which requires an actual Shopify store and likely doesn't fit."
  },
  {
    id: 'wire-real-shop-checkout',
    category: 'task',
    priority: 'medium',
    done: false,
    comments: [],
    createdAt: null,
    doneAt: null,
    startedAt: null,
    title: "Wire shop.html's token packs to a real checkout once a provider is approved",
    detail: 'Both pack buttons (100 tokens/$1.99, 500 tokens/$8.95) are currently disabled "Coming soon" with no backend call at all. Once a provider is picked and approved, this needs a real one-time-purchase checkout flow (likely adapting create-checkout-session-dodo.js\'s plumbing, built for subscriptions, to a one-time token-pack purchase instead).'
  },
  {
    id: 'tighten-descriptions',
    category: 'task',
    priority: 'medium',
    done: false,
    comments: [],
    createdAt: null,
    doneAt: null,
    startedAt: null,
    title: 'Tighten a few overlapping/stale agent and skill descriptions',
    detail: 'research\'s description shares an overlapping trigger phrase with marketing\'s ("brainstorm ... marketing/growth ideas") — before/after text already drafted, not yet applied. pricing-strategy\'s skill description references two skills ("product-strategist", "customer-success-manager") that don\'t exist in this narrower bundle — leftover from the original 47-skill upstream source. Minor: marketing-strategy-pmm and launch-strategy both claim "launch plans"/"launch strategy" as a trigger.'
  },
  {
    id: 'prompt-marketing-audit',
    category: 'task',
    priority: 'medium',
    done: false,
    comments: [],
    createdAt: null,
    doneAt: null,
    startedAt: null,
    title: 'Ask the marketing session to run the same agent/skill description audit on dreamtube-growth',
    detail: "dreamtube-growth wasn't touched during the description audit done here since it's out of scope for this session — but the same duplicate-registration risk (raw copy + plugin) may exist there too for its own six project-scoped agents."
  },
  {
    id: 'delete-stale-branch',
    category: 'task',
    priority: 'low',
    done: false,
    comments: [],
    createdAt: null,
    doneAt: null,
    startedAt: null,
    title: 'Delete the redundant feature/quota-credits-system branch on GitHub',
    detail: "Superseded by work merged through a different branch; content is fully preserved elsewhere. Deleting it was blocked once already by a permission prompt — needs the founder's own go-ahead or direct action."
  },
  {
    id: 'idea-weekly-recap',
    category: 'idea',
    priority: 'medium',
    done: false,
    comments: [],
    createdAt: null,
    doneAt: null,
    startedAt: null,
    title: 'Weekly Dream Recap email',
    detail: "Resend (the transactional email provider already wired in) can send, but there's no server-side data model linking an email address to a user's weekly activity yet — dreams currently live only in localStorage. Ranked #8 in the last evaluation pass (Priority Score 0.052) — real but not urgent; Resend's free tier's 100/day cap (not just its monthly cap) is a real near-term scaling consideration once built."
  },
  {
    id: 'idea-remix-style',
    category: 'idea',
    priority: 'medium',
    done: false,
    comments: [],
    createdAt: null,
    doneAt: null,
    startedAt: null,
    title: "Remix a public dream's style",
    detail: "Needs a real schema extension — camera/scenery fields aren't currently persisted on a finished dream record, only during the creation flow. Ranked #6 in the last evaluation pass (Priority Score 0.076), the highest-ranked idea not yet built."
  },
  {
    id: 'idea-referral-credit',
    category: 'idea',
    priority: 'medium',
    done: false,
    comments: [],
    createdAt: null,
    doneAt: null,
    startedAt: null,
    title: 'Referral credit (bonus tokens for inviting someone)',
    detail: "entitlements.js's token ledger could support this directly, but it needs anti-abuse design first — current accounts have no real identity verification (plaintext local accounts), so a naive referral loop is trivially exploitable for free tokens. Ranked #7 in the last evaluation pass (Priority Score 0.060)."
  },
  {
    id: 'idea-unified-me-identity',
    category: 'idea',
    priority: 'medium',
    done: false,
    comments: [],
    createdAt: null,
    doneAt: null,
    startedAt: null,
    title: 'Unify profile identity with the "Me" character, editable from both places, plus auto-detect self-references in dream text',
    detail: 'Right now the "Me" character (the isSelf-flagged entry in Advanced > Characters, with its own name/description/photo, defined in js/store.js\'s character model) and the profile page\'s identity (currently just a handle, no editable photo/name) are two separate things. Idea: unify them into one entity — editing name/photo on profile.html updates the same underlying "Me" character used in the creation flow, and editing "Me" from Advanced > Characters updates the profile too, bidirectionally, reusing the character-editing UI/logic that already exists rather than building two separate edit flows. Second part: when a user writes "I", "me", or their own first/last/full name directly in the dream text (create.html\'s #dream-text), auto-detect that self-reference and offer/auto-attach the "Me" character to the generation, instead of requiring them to separately add it via Advanced every time.'
  },
  {
    id: 'idea-notify-likes',
    category: 'idea',
    priority: 'low',
    done: false,
    comments: [],
    createdAt: null,
    doneAt: null,
    startedAt: null,
    title: 'Notify creators when their dream is liked or remixed',
    detail: 'Likes are currently fully anonymous (no per-liker identity tracked) and published dreams carry no email, so the plumbing to know *who* to notify doesn\'t exist yet. Recommended in the last evaluation pass to merge into the Weekly Recap idea rather than build as a separate real-time notification feature (which would need new infrastructure — service worker, push subscriptions). Ranked #9 (Priority Score 0.032).'
  },
  {
    id: 'idea-friend-cameos',
    category: 'idea',
    priority: 'low',
    done: false,
    comments: [],
    createdAt: null,
    doneAt: null,
    startedAt: null,
    title: "Friend Cameos (use a friend's photo as a character)",
    detail: 'Explicitly flagged as needing a trust & safety review before any design work starts — this reverses a deliberate existing safety boundary in js/store.js\'s saveCharacter(), which today restricts photo uploads to "self" characters only, with code comments explicitly framing that as a safety boundary, not just a UI gap. Ranked #10 (lowest of the buildable ideas) in the last evaluation pass, driven mainly by this real consent/likeness risk.'
  },
  {
    id: 'idea-fingerprint-email-verify',
    category: 'idea',
    priority: 'low',
    done: false,
    comments: [],
    createdAt: null,
    doneAt: null,
    startedAt: null,
    title: 'Device fingerprinting + email verification fused early in signup',
    detail: "The strongest anti-abuse layer identified in the pre-payment-generation research, deliberately deferred — it's real build effort plus at least one new vendor account (a human-approval decision on its own), and wasn't judged worth it before the product has real usage data justifying the investment."
  },
  {
    id: 'idea-generate-before-paywall',
    category: 'idea',
    priority: 'low',
    done: false,
    comments: [],
    createdAt: null,
    doneAt: null,
    startedAt: null,
    title: '"Generate during the funnel, reveal at the end" / "email me my dream if I don\'t convert"',
    detail: "Both researched as marketing/conversion mechanics. Explicitly recommended against for now: both mean incurring real generation cost before any identity signal exists that early in the funnel, which was judged too risky without a much heavier anti-abuse stack in place first. Worth revisiting only once the guardrails above mature."
  },
  {
    id: 'idea-auto-refund-policy',
    category: 'idea',
    priority: 'medium',
    done: false,
    comments: [],
    createdAt: null,
    doneAt: null,
    startedAt: null,
    title: 'Auto-refund tokens once/day per user on failed generation, else manual support refund',
    detail: 'Decided policy for the "token-refund-gap" question above: automatically refund the 100 tokens once per day per user when a generation fails after submission (E205/E208 etc.), and for any additional failures beyond that daily auto-refund, direct the user to request a manual refund via the support contact form (see idea-support-contact-form). Needs a way to track "already auto-refunded today" per user — likely mirrors the existing lazy daily-check pattern already used for the token grant in entitlements.js — and the support form to exist first for the manual fallback path to actually go anywhere.'
  },
  {
    id: 'idea-support-contact-form',
    category: 'idea',
    priority: 'medium',
    done: false,
    comments: [],
    createdAt: null,
    doneAt: null,
    startedAt: null,
    title: 'Support contact form in Settings, emailing the founder with user context',
    detail: "A text field in Settings that sends a message to the founder's email, automatically including: username, email, number of videos created, days since signup, and total amount paid (once real payments exist). Needs a transactional email send (Resend is already wired into this codebase for other purposes) and pulling together account stats that aren't all in one place today. Also the fallback path idea-auto-refund-policy depends on."
  },
  {
    id: 'idea-faq-section',
    category: 'idea',
    priority: 'low',
    done: false,
    comments: [],
    createdAt: null,
    doneAt: null,
    startedAt: null,
    title: 'FAQ section in Settings',
    detail: "A static FAQ section/page in Settings. Draft Q&A below — edit before publishing, and confirm the account-deletion answer (flagged) before it goes live.\n\n" +
      "Q: What is DreamTube?\n" +
      "A: Type or record a description of a dream, and DreamTube turns it into a short AI-generated video.\n\n" +
      "Q: How do tokens work?\n" +
      "A: Every generation — a new dream, an edit, or a regenerate — costs 100 tokens. You start with 200 free, plus 100 more every day automatically. Need more than that? Token packs are coming soon in the Shop.\n\n" +
      "Q: My generation failed. Do I get my tokens back?\n" +
      "A: Yes, once per day automatically. If it happens again the same day, contact support below and we'll sort it out manually.\n\n" +
      "Q: How long does a video take to generate?\n" +
      "A: Usually under a minute or two — you'll see progress on screen while it renders.\n\n" +
      "Q: Can I edit a dream after it's made?\n" +
      "A: Yes — change the text or style and regenerate. Each regenerate costs another 100 tokens, same as a new dream.\n\n" +
      "Q: What's \"Advanced\"?\n" +
      "A: Optional extras before you generate: add characters (including yourself, via photo or description), pick a camera angle, and set the time/place of the scene.\n\n" +
      "Q: Can I use my own photo?\n" +
      "A: Yes, for yourself specifically. Photos of other people aren't supported yet, for safety reasons.\n\n" +
      "Q: Is my dream public or private?\n" +
      "A: Private by default. You choose if and when to publish a dream to Explore, where other users can see it.\n\n" +
      "Q: Can I delete a dream, or my account?\n" +
      "A: You can delete any dream you've created any time. [FLAGGED: account-deletion flow doesn't appear to exist yet — confirm/build before publishing this answer.]\n\n" +
      "Q: Something's wrong / I have another question\n" +
      "A: Use the contact form below — we read every message."
  },
  {
    id: 'confirm-account-deletion-flow',
    category: 'task',
    priority: 'medium',
    done: false,
    comments: [],
    createdAt: null,
    doneAt: null,
    startedAt: null,
    title: 'Confirm whether account deletion actually exists before publishing the FAQ answer',
    detail: 'The draft FAQ (idea-faq-section) answers "can I delete my account?" with "yes," but this doesn\'t appear to be a real, built flow yet — flagged when the FAQ draft was written. Confirm it exists (and works) before publishing that answer, or build it, or change the answer to be accurate.'
  },
  {
    id: 'confirm-fal-credit-balance',
    category: 'task',
    priority: 'medium',
    done: false,
    comments: [],
    createdAt: null,
    doneAt: null,
    startedAt: null,
    title: "Check fal.ai account's real credit balance and auto-lock threshold before real ad spend",
    detail: "fal.ai bills on prepaid credits with an automatic account lock once the balance drops below a threshold — this is DreamTube's actual worst-case cost ceiling today, more fundamental than any of the app's own rate limits (E109/E110/E112). Flagged during the launch-safeguards discussion and never confirmed: what the current loaded balance and lock threshold actually are, especially before pointing real Meta ad traffic at the funnel."
  },
  {
    id: 'decide-blobs-lazy-seed-race',
    category: 'task',
    priority: 'low',
    done: false,
    comments: [],
    createdAt: null,
    doneAt: null,
    startedAt: null,
    title: 'Decide: accept or fix the lazy-seed race shared by entitlements.js/paywall-settings.js/tracker-store.js',
    detail: "Review found this while checking tracker-page: the 'materialize a default on first read' pattern used in three separate lib files has no atomic/conditional-write primitive available in the installed @netlify/blobs SDK, so a genuinely concurrent first-ever read+write can race and one write can silently clobber the other. Low real-world likelihood so far (single-owner tools, low write frequency) — decide whether to just document this explicitly in each file (cheaper) or build a real fix (a separately-checked 'seeded' marker key) before a fourth place reuses the same pattern for something with higher write concurrency."
  },
  {
    id: 'tracker-store-concurrent-write-race',
    category: 'task',
    priority: 'medium',
    done: false,
    comments: [],
    createdAt: null,
    doneAt: null,
    startedAt: null,
    title: 'Accept or further harden the tracker Blobs store\'s concurrent-write race in addItem/deleteItem',
    detail: "Flagged in review of the add/delete-endpoints branch: addItem/deleteItem do a read-full-list -> mutate -> write cycle, and the installed @netlify/blobs SDK (8.2.0) exposes no compare-and-swap/conditional write (set/setJSON take only a metadata option) — two genuinely concurrent callers (this page's own JS, and dreamtube-growth writing directly via these same two endpoints, which is exactly what this branch was built to allow) can each read the same base list and the second write silently clobbers the first, no error to either side. Worse version of decide-blobs-lazy-seed-race above (that one's a one-time low-frequency bootstrap race; this is the steady-state write path with a second real concurrent writer by design). Mitigation shipped alongside this item: a bounded read-mutate-write-then-verify retry loop in tracker-store.js (see its own CONCURRENT-WRITE RACE comment above addItem/deleteItem) that narrows but does not eliminate the window. Revisit if item loss/duplication is ever actually observed in practice, or before a third concurrent writer gets added on top of these two."
  },
  {
    id: 'tracker-needs-real-add-delete',
    category: 'task',
    priority: 'medium',
    done: false,
    comments: [],
    createdAt: null,
    doneAt: null,
    startedAt: null,
    title: "Give tracker.html real add/delete endpoints instead of source-edited seed data",
    detail: "Right now every new tracker item (including this one) is added by editing SEED_ITEMS in the repo and pushing to main — which only has any effect on the LIVE page before its very first real read; tracker-store.js's lazy-seed only ever fires once, so once the live Blobs store has actually been seeded, further edits to SEED_ITEMS in source do nothing at all. Standing instruction now is to keep adding flagged items here and deleting resolved ones going forward, so this needs real owner-gated add-item/delete-item endpoints (matching update-tracker-item.js's existing owner-check pattern) rather than continuing to rely on source edits, which will silently stop working the moment the page is first visited live."
  },
  {
    id: 'accounts-dont-sync-across-devices',
    category: 'task',
    priority: 'high',
    done: false,
    comments: [],
    createdAt: null,
    doneAt: null,
    startedAt: null,
    title: 'IN PROGRESS: server-side account/password check, so login + forgot-password work across devices',
    detail: "DECIDED: build the scoped fix now — move just the account check (username/email/password match) to a small server-side Blobs store, reusing the same lightweight keyed-lookup pattern already used by entitlements.js/paywall-settings.js/tracker-store.js (no sessions, no hashing infra, no new auth framework). This fixes login and forgot-password from any device. It deliberately does NOT sync dreams/characters themselves — see sync-private-dreams-videos-later for that, explicitly deferred and scoped separately. Being built now; mark done once merged."
  },
  {
    id: 'sync-private-dreams-videos-later',
    category: 'task',
    priority: 'low',
    done: false,
    comments: [],
    createdAt: null,
    doneAt: null,
    startedAt: null,
    title: 'Later: sync private dreams/characters/videos across devices (deferred)',
    detail: "Bigger, separate project from the login fix above — deliberately deferred, not being built now. Real dependency: this cannot ship before (or without) the server-side account/password fix above, since syncing private data keyed by email without real password verification would let anyone who knows/guesses an email pull down that account's private dreams — a real security hole, worse than today's device-only status quo. Also a real new cost line to weigh, not just engineering: unclear whether generated videos are already stored durably anywhere, or only cached transiently during generation — if the latter, this means paying to store every user's private videos indefinitely, an ongoing cost that scales with usage, worth its own explicit sign-off before building. Founder's call: no need to migrate already-created dreams/videos when this eventually gets built — the product is still private/pre-launch, so starting the sync from whenever it ships (not backfilling everything that came before) is fine."
  }
];

function store() {
  return getStore({ name: STORE_NAME });
}

/**
 * Slugifies a title into a URL/JS-identifier-safe base — lowercased,
 * every run of non [a-z0-9] characters collapsed to a single hyphen,
 * leading/trailing hyphens trimmed, capped at 40 characters so a very
 * long title doesn't produce an unwieldy id. Falls back to "item" if
 * that leaves nothing (e.g. a title that's entirely punctuation/emoji).
 * Only ever used as the human-readable prefix of generateId()'s output
 * below, never as an id on its own — it isn't unique by itself.
 */
function slugify(title) {
  var slug = String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug.slice(0, 40) || 'item';
}

/**
 * Generates a new item id: "<slugified-title>-<6-char-random-suffix>",
 * retried on the astronomically unlikely chance it collides with an id
 * already in `items`. Never trusts a client-supplied id (see
 * add-tracker-item.js's own doc comment for why) — this is the only way
 * a new item's id comes into existence.
 */
function generateId(items, title) {
  var base = slugify(title);
  var id;
  do {
    id = base + '-' + Math.random().toString(36).slice(2, 8);
  } while (items.some(function (item) { return item.id === id; }));
  return id;
}

// ---------------------------------------------------------------------
// SCHEMA CHANGE — comment (string) -> comments (array), plus createdAt/
// doneAt/startedAt
//
// Before this build, an item's one owner-writable free-text field was a
// single overwritable `comment: string` — already live on `main` (an
// earlier branch shipped it), so a real, already-deployed environment's
// Blobs store may genuinely contain items shaped the old way, with
// real Ron-authored text in `comment` worth preserving, not discarding.
//
// migrateItem() below normalizes any one item to the current shape:
//   - a non-empty legacy `comment` becomes a single `comments` entry
//     (author: 'ron' — the old field was owner-write-only, so any
//     pre-existing value can only ever have been written by the founder
//     himself; timestamp: null, since the old shape never recorded when
//     a comment was written and fabricating one would be actively
//     misleading — same reasoning as createdAt below).
//   - a missing/non-array `comments` becomes `[]` (or the migrated
//     legacy comment above).
//   - the legacy `comment` key itself is always dropped once migrated —
//     this repo's stated preference is a clean cutover (drop + migrate)
//     over indefinitely carrying both shapes.
//   - missing createdAt/doneAt/startedAt all default to `null` — no
//     fabricated history for content that predates these fields.
//
// getItems() below runs every item it reads through this and re-persists
// once if anything actually needed migrating, so it's a one-time cost
// per item (the same "materialize on first read" spirit as this file's
// own seeding step), not a per-request tax forever.
// ---------------------------------------------------------------------

function migrateItem(item) {
  var changed = false;
  var next = item;

  if (!Array.isArray(next.comments)) {
    var comments = [];
    if (next.comment) {
      comments.push({ id: 'legacy-' + next.id, author: 'ron', text: next.comment, timestamp: null });
    }
    next = Object.assign({}, next, { comments: comments });
    changed = true;
  }
  if (Object.prototype.hasOwnProperty.call(next, 'comment')) {
    next = Object.assign({}, next);
    delete next.comment;
    changed = true;
  }
  ['createdAt', 'doneAt', 'startedAt'].forEach(function (key) {
    if (!Object.prototype.hasOwnProperty.call(next, key)) {
      next = Object.assign({}, next);
      next[key] = null;
      changed = true;
    }
  });

  return { item: next, changed: changed };
}

/**
 * Returns the full items array, seeding+persisting SEED_ITEMS on the very
 * first call in a fresh environment (no "items" key written yet). Every
 * later call — from either function — reads back whatever's actually
 * persisted (the seed, plus any priority/done/comment edits since), never
 * re-seeds over real edits. `event` is the calling function's Lambda
 * event, passed through to connectLambda so this works from any Netlify
 * Function.
 *
 * Also runs every item through migrateItem() (see the SCHEMA CHANGE
 * comment above) and re-persists once if anything needed migrating, so
 * an environment that was already live before this build's schema change
 * self-heals to the new shape on its very next read rather than needing
 * a one-off manual migration script.
 */
async function getItems(event) {
  connectLambda(event);
  var items = await store().get(KEY, { type: 'json' });
  if (!items) {
    items = SEED_ITEMS;
    await store().setJSON(KEY, items);
    return items;
  }

  var anyChanged = false;
  var migrated = items.map(function (item) {
    var result = migrateItem(item);
    if (result.changed) anyChanged = true;
    return result.item;
  });
  if (anyChanged) {
    connectLambda(event);
    await store().setJSON(KEY, migrated);
  }
  return migrated;
}

/**
 * Patches one item's owner-writable fields by id and persists the full
 * list — see update-tracker-item.js for the full accepted request shape.
 * `patch` may include any subset of:
 *   priority: "high"|"medium"|"low" — replaces it directly.
 *   done: boolean — also derives `doneAt`: set to the current server
 *     time the moment `done` actually transitions false -> true, reset
 *     to `null` the moment it goes back to false. A `done: true` patch
 *     against an item that's already done is a no-op on `doneAt` — it
 *     keeps whatever it was already set to, rather than bumping it to a
 *     newer timestamp every time the same already-done item is touched.
 *   started: true — a one-way "start working on this" signal (see
 *     tracker.html's start button). Sets `startedAt` to the current
 *     server time the first time this fires; on an item that already has
 *     a `startedAt`, this is a no-op — there's no "un-start" exposed by
 *     this endpoint at all.
 *   newComment: { id, author, text, timestamp } — a single already-built
 *     comment entry (id/author/timestamp assigned by
 *     update-tracker-item.js) APPENDED to the item's `comments` array,
 *     never replacing it — see this file's SCHEMA CHANGE comment above
 *     getItems() for why `comment` (a single overwritable string) became
 *     this. Appending means two comments arriving for the same item at
 *     genuinely the same time (Ron's own note and a note from whoever's
 *     driving a build/review session) both survive rather than one
 *     clobbering the other, and it composes cleanly with the retry loop
 *     below: each retry re-reads and re-appends onto whatever's freshest,
 *     so a comment is never lost even if another writer's change lands
 *     in between attempts.
 *
 * Every derived field above (doneAt/startedAt/comments) is (re)computed
 * fresh from whatever `items[idx]` the CURRENT retry attempt's read
 * actually shows, never from a value captured once outside the retry
 * loop — so a retry triggered by a false-negative verify (see
 * writeItemsWithRetry's own comment: our own just-written data not yet
 * visible to an eventually consistent read, not necessarily a real
 * clobber) re-derives against the freshest already-applied state instead
 * of blindly reapplying a stale computation — e.g. it won't stomp an
 * already-set doneAt with a newer timestamp just because this call's own
 * patch.done is still `true` on a second attempt, and it won't append
 * the same comment twice (comments are compared by their pre-assigned
 * `id`, so a retry against a read that already shows our own prior
 * attempt's append is recognized and left alone — see the mutate
 * function below).
 *
 * Returns the updated item, or `null` if no item with that id exists at
 * the time of the first read.
 *
 * Goes through writeItemsWithRetry below — see the CONCURRENT-WRITE RACE
 * comment for what this does and doesn't protect against. Before an
 * earlier fix, updateItem did a single read -> mutate -> write with no
 * retry/verify at all (unlike addItem/deleteItem), and this was
 * confirmed live: a `done: true` update was silently reverted by a
 * concurrent write from another caller.
 */
async function updateItem(event, id, patch) {
  var updated = null;
  await writeItemsWithRetry(
    event,
    function (items) {
      var idx = -1;
      for (var i = 0; i < items.length; i++) {
        if (items[i].id === id) { idx = i; break; }
      }
      if (idx === -1) { updated = null; return items; }

      var current = items[idx];
      var next = Object.assign({}, current);

      if (Object.prototype.hasOwnProperty.call(patch, 'priority')) {
        next.priority = patch.priority;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'done')) {
        next.done = patch.done;
        if (patch.done && !current.done) {
          next.doneAt = new Date().toISOString();
        } else if (!patch.done) {
          next.doneAt = null;
        }
        // patch.done === true && current.done === true: already done —
        // leave the existing doneAt exactly as-is (idempotent no-op, and
        // also what makes a retry against an already-applied state safe).
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'started') && patch.started && !current.startedAt) {
        next.startedAt = new Date().toISOString();
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'newComment')) {
        var existingComments = current.comments || [];
        var alreadyThere = existingComments.some(function (c) { return c.id === patch.newComment.id; });
        next.comments = alreadyThere ? existingComments : existingComments.concat([patch.newComment]);
      }

      updated = next;
      var result = items.slice();
      result[idx] = next;
      return result;
    },
    function (items) {
      if (updated === null) return true;
      var found = items.filter(function (item) { return item.id === id; })[0];
      if (!found) return false;
      // Compares against `updated` — the exact object THIS attempt's
      // mutate() computed — rather than re-deriving an expected shape from
      // `patch` alone. Before this fix, the done branch asserted
      // `typeof found.doneAt === 'string'` any time patch.done was true,
      // which is only true for a REAL false->true transition; a
      // done:true patch against an item that was already done with a
      // legacy doneAt of `null` (reachable via direct API calls, not
      // through this page's own UI, which only ever toggles to the
      // opposite state) is a no-op that correctly leaves doneAt as
      // `null` — see the mutate function above — so the old check spuriously
      // failed verify on every attempt for that case, wasting all
      // MAX_WRITE_ATTEMPTS retries before falling open to the (already
      // correct) result. Comparing directly against `updated.doneAt`
      // makes verify agree with whatever mutate() actually decided,
      // instead of asserting an invariant that doesn't hold for
      // already-done legacy items.
      if (Object.prototype.hasOwnProperty.call(patch, 'priority') && found.priority !== updated.priority) return false;
      if (Object.prototype.hasOwnProperty.call(patch, 'done')) {
        if (found.done !== updated.done) return false;
        if (found.doneAt !== updated.doneAt) return false;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'started') && patch.started) {
        if (found.startedAt !== updated.startedAt) return false;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'newComment')) {
        // Deliberately NOT compared against updated.comments as a whole —
        // a concurrent caller's own append landing between our write and
        // this verify-read is expected and fine (that's the whole point
        // of appending rather than overwriting); this only needs to
        // confirm OUR entry (by its pre-assigned id) made it in.
        var hasNewComment = (found.comments || []).some(function (c) { return c.id === patch.newComment.id; });
        if (!hasNewComment) return false;
      }
      return true;
    }
  );
  return updated;
}

// ---------------------------------------------------------------------
// CONCURRENT-WRITE RACE — addItem()/deleteItem()/updateItem() below
//
// All three do a read-the-full-array -> mutate -> setJSON-the-full-array-back
// cycle. The installed @netlify/blobs SDK (8.2.0 as of this writing — see
// node_modules/@netlify/blobs/dist/main.d.ts) has no compare-and-swap or
// conditional-write primitive: `set`/`setJSON` accept only a `metadata`
// option, and `getWithMetadata`'s `etag` option is a *read*-side
// If-None-Match hint (skip re-fetching unchanged data), not something a
// write can be conditioned on. So two genuinely concurrent callers — this
// page's own JS via add-tracker-item.js/delete-tracker-item.js, and
// dreamtube-growth calling those same two endpoints directly, which is
// exactly what this add/delete-endpoints branch was built to allow — can
// each read the same base array, and the second setJSON silently
// clobbers the first caller's add/delete, with no error to either side.
//
// This is a worse version of the lazy-seed race already tracked as the
// decide-blobs-lazy-seed-race item in SEED_ITEMS below: that one is a
// one-time bootstrap race in a low-frequency single-owner tool; this is
// the steady-state write path with a second real concurrent writer by
// design (see the tracker-store-concurrent-write-race item below, added
// alongside this fix).
//
// Mitigation actually in place: writeItemsWithRetry() immediately below
// does a bounded (MAX_WRITE_ATTEMPTS) read -> mutate -> write ->
// read-back-and-verify loop, retrying against a freshly-read base
// whenever the verify read doesn't show the expected end state (i.e.
// something else won the race). This NARROWS the race window — a clobber
// landing between our write and our own verify-read gets caught and
// retried against the newer state — but does NOT ELIMINATE it: the
// verify read itself only ever uses this store's eventual consistency
// (strong consistency throws BlobsConsistencyError unconditionally in
// this deploy environment, same reasoning as the rest of this file), so
// it can lag behind the very write it's checking regardless of any other
// writer, and a clobber landing in the gap between our verify-read
// succeeding and us actually returning is still possible in principle.
// Bounded (not infinite) retries were chosen so a genuinely stuck store,
// or a still-propagating eventually-consistent read, fails open (falls
// through and returns the last attempt's result anyway) rather than
// hanging the request indefinitely.
// ---------------------------------------------------------------------

var MAX_WRITE_ATTEMPTS = 3;

/**
 * Shared read -> mutate -> write -> verify retry loop for addItem/
 * deleteItem/updateItem. See the CONCURRENT-WRITE RACE comment above for
 * exactly what this does and doesn't protect against.
 *
 * `mutate(items)` takes the latest full array and returns the full new
 * array to persist. It's called again from scratch (against a fresh
 * read) on every retry, so it must be idempotent against its own target
 * end state — safe to call against an array where that end state is
 * already present (a retry can be triggered by a false-negative verify,
 * e.g. our own just-written data not yet visible to an eventually
 * consistent read, not just a real clobber) — so it must not double-add
 * or otherwise misbehave if called again after already "succeeding".
 *
 * `verify(items)` is checked against a fresh read taken right after the
 * write; if it returns false the whole cycle (fresh read, mutate, write)
 * retries, up to MAX_WRITE_ATTEMPTS times total.
 *
 * Returns whatever was persisted on the attempt whose verify passed, or
 * — if every attempt's verify failed — the last attempt's array anyway
 * (see the comment above for why this fails open instead of throwing).
 */
async function writeItemsWithRetry(event, mutate, verify) {
  var result = null;
  for (var attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
    var items = await getItems(event);
    var mutated = mutate(items);
    result = mutated;

    connectLambda(event);
    await store().setJSON(KEY, mutated);

    connectLambda(event);
    var verifyItems = await store().get(KEY, { type: 'json' });
    if (verify(verifyItems || [])) return mutated;
  }
  return result;
}

/**
 * Appends a brand-new item built from `patch` ({ category, title, detail,
 * priority }) — shape/value validation is the caller's job (see
 * add-tracker-item.js), this trusts what it's given. Generates the id
 * server-side (see generateId above, from a first, non-retried read —
 * good enough since this only needs to be unique against whatever set of
 * ids the id-collision check inside generateId actually saw, not a
 * perfectly current one) and always starts the item at done: false,
 * comments: [], doneAt: null, startedAt: null. Unlike SEED_ITEMS'
 * fallback `createdAt: null` (no real history to record for
 * pre-existing content), a brand-new item created through this path
 * DOES get a real `createdAt` — the current server time at creation —
 * since there's no reason not to record it going forward. Returns the
 * created item. A pure append — never reorders or otherwise touches any
 * existing item. Goes through writeItemsWithRetry above — see the
 * CONCURRENT-WRITE RACE comment above that for what is and isn't
 * protected against.
 */
async function addItem(event, patch) {
  var initialItems = await getItems(event);
  var created = {
    id: generateId(initialItems, patch.title),
    category: patch.category,
    title: patch.title,
    detail: patch.detail,
    priority: patch.priority,
    done: false,
    comments: [],
    createdAt: new Date().toISOString(),
    doneAt: null,
    startedAt: null
  };

  await writeItemsWithRetry(
    event,
    function (items) {
      var alreadyPresent = items.some(function (item) { return item.id === created.id; });
      return alreadyPresent ? items : items.concat([created]);
    },
    function (items) { return items.some(function (item) { return item.id === created.id; }); }
  );

  return created;
}

/**
 * Removes one item by id and persists the resulting list. Returns `true`
 * if an item was actually found and removed at the time this was called,
 * `false` if no item with that id existed then (store is left untouched
 * in that case — never partially written, same not-found handling as
 * updateItem above). Goes through writeItemsWithRetry above — see the
 * CONCURRENT-WRITE RACE comment above that for what is and isn't
 * protected against.
 */
async function deleteItem(event, id) {
  var initialItems = await getItems(event);
  var existed = initialItems.some(function (item) { return item.id === id; });
  if (!existed) return false;

  await writeItemsWithRetry(
    event,
    function (items) { return items.filter(function (item) { return item.id !== id; }); },
    function (items) { return !items.some(function (item) { return item.id === id; }); }
  );

  return true;
}

module.exports = { STORE_NAME, KEY, SEED_ITEMS, getItems, updateItem, addItem, deleteItem };
