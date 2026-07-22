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
//   priority: "high"|"medium"|"low", done: boolean }
//
// update-tracker-item.js only ever patches `priority`/`done` on an existing
// item — id/category/title/detail are seed-authored-or-added content, not
// something that endpoint's PATCH-style write lets anyone mutate.
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
    title: 'Decide: refund tokens if generation fails after submission?',
    detail: 'RESOLVED: auto-refund once per day per user on a post-submission generation failure (E205/E208 etc.); beyond that daily auto-refund, direct the user to request a manual refund via the support form. See idea-auto-refund-policy for the implementation, which depends on idea-support-contact-form existing for the manual fallback path.'
  },
  {
    id: 'env-vars-confirm',
    category: 'task',
    priority: 'high',
    done: false,
    title: 'Confirm required env vars are actually set in the live Netlify environment',
    detail: 'Can\'t be verified from the repo alone. Check: OWNER_EMAIL, MAX_GENERATIONS_PER_IP_PER_DAY, DAILY_SPEND_CAP_USD, MAX_TOKEN_GRANTS_PER_IP_PER_DAY. Without OWNER_EMAIL set, admin.html\'s toggle and any future owner bypass don\'t work for the founder specifically.'
  },
  {
    id: 'agent-skill-duplication',
    category: 'task',
    priority: 'high',
    done: false,
    title: 'Resolve duplicate agent/skill registration (research/evaluation/design/marketing + all 13 frozen marketplace skills)',
    detail: "Each of the four portable agents, and all 13 frozen reference skills, are currently registered twice: once as a raw local copy (~/.claude/agents/, ~/.claude/skills/) and once via the installed product-agents marketplace plugin. This is exactly the kind of routing ambiguity that risks Claude picking the wrong/stale copy, and it already caused one real instance of drift this session. The raw copies were a deliberate \"frozen, stable\" design choice, so the fix isn't simply deleting them — needs a decision on which mechanism is canonical, then cleanup."
  },
  {
    id: 'dodo-merge-decision',
    category: 'task',
    priority: 'medium',
    done: false,
    title: 'Decide: merge the dormant Dodo Payments backend branch now?',
    detail: 'claude/dodo-payments-backend is fully built and tested (checkout session + webhook, 25 passing tests) but was never merged. It stays fully inert either way — no real Dodo credentials exist yet — but merging now is a housekeeping call, not a functional one. It\'s no longer required for launch given the token-economy pivot, but will be needed once real token purchases go live in shop.html (whichever provider ends up chosen).'
  },
  {
    id: 'payment-provider-final',
    category: 'task',
    priority: 'medium',
    done: false,
    title: 'Pick a final payment provider for real token purchases',
    detail: "Dodo underwriting approval is pending (the founder's own step, in progress). If it falls through: Paddle has a documented, specific AI-content-category risk for exactly what DreamTube generates (AI video that can plausibly include human likenesses); 2Checkout/Verifone is the most individual-seller-friendly alternative researched so far, unconfirmed on AI-content risk. BlueSnap and Xsolla were checked and don't beat this shortlist (BlueSnap keeps DreamTube as merchant of record instead of Dodo/Paddle's model; Xsolla is gaming-commerce-specific, off-category). \"Shop\" was mentioned as a possible provider to check but never clarified — could be Shopify Payments, which requires an actual Shopify store and likely doesn't fit."
  },
  {
    id: 'wire-real-shop-checkout',
    category: 'task',
    priority: 'medium',
    done: false,
    title: "Wire shop.html's token packs to a real checkout once a provider is approved",
    detail: 'Both pack buttons (100 tokens/$1.99, 500 tokens/$8.95) are currently disabled "Coming soon" with no backend call at all. Once a provider is picked and approved, this needs a real one-time-purchase checkout flow (likely adapting create-checkout-session-dodo.js\'s plumbing, built for subscriptions, to a one-time token-pack purchase instead).'
  },
  {
    id: 'add-turnstile',
    category: 'task',
    priority: 'medium',
    done: false,
    title: 'Add Cloudflare Turnstile before generation-triggering screens',
    detail: "Free, low-effort (~half a day), stops naive scripted/bot abuse. Doesn't stop a determined attacker on its own, but the anti-abuse research done for this project recommended it as a cheap baseline layer worth having regardless of the token-economy safeguards already in place. Not yet built."
  },
  {
    id: 'tighten-descriptions',
    category: 'task',
    priority: 'medium',
    done: false,
    title: 'Tighten a few overlapping/stale agent and skill descriptions',
    detail: 'research\'s description shares an overlapping trigger phrase with marketing\'s ("brainstorm ... marketing/growth ideas") — before/after text already drafted, not yet applied. pricing-strategy\'s skill description references two skills ("product-strategist", "customer-success-manager") that don\'t exist in this narrower bundle — leftover from the original 47-skill upstream source. Minor: marketing-strategy-pmm and launch-strategy both claim "launch plans"/"launch strategy" as a trigger.'
  },
  {
    id: 'prompt-marketing-audit',
    category: 'task',
    priority: 'medium',
    done: false,
    title: 'Ask the marketing session to run the same agent/skill description audit on dreamtube-growth',
    detail: "dreamtube-growth wasn't touched during the description audit done here since it's out of scope for this session — but the same duplicate-registration risk (raw copy + plugin) may exist there too for its own six project-scoped agents."
  },
  {
    id: 'delete-stale-branch',
    category: 'task',
    priority: 'low',
    done: false,
    title: 'Delete the redundant feature/quota-credits-system branch on GitHub',
    detail: "Superseded by work merged through a different branch; content is fully preserved elsewhere. Deleting it was blocked once already by a permission prompt — needs the founder's own go-ahead or direct action."
  },
  {
    id: 'idea-weekly-recap',
    category: 'idea',
    priority: 'medium',
    done: false,
    title: 'Weekly Dream Recap email',
    detail: "Resend (the transactional email provider already wired in) can send, but there's no server-side data model linking an email address to a user's weekly activity yet — dreams currently live only in localStorage. Ranked #8 in the last evaluation pass (Priority Score 0.052) — real but not urgent; Resend's free tier's 100/day cap (not just its monthly cap) is a real near-term scaling consideration once built."
  },
  {
    id: 'idea-remix-style',
    category: 'idea',
    priority: 'medium',
    done: false,
    title: "Remix a public dream's style",
    detail: "Needs a real schema extension — camera/scenery fields aren't currently persisted on a finished dream record, only during the creation flow. Ranked #6 in the last evaluation pass (Priority Score 0.076), the highest-ranked idea not yet built."
  },
  {
    id: 'idea-referral-credit',
    category: 'idea',
    priority: 'medium',
    done: false,
    title: 'Referral credit (bonus tokens for inviting someone)',
    detail: "entitlements.js's token ledger could support this directly, but it needs anti-abuse design first — current accounts have no real identity verification (plaintext local accounts), so a naive referral loop is trivially exploitable for free tokens. Ranked #7 in the last evaluation pass (Priority Score 0.060)."
  },
  {
    id: 'idea-unified-me-identity',
    category: 'idea',
    priority: 'medium',
    done: false,
    title: 'Unify profile identity with the "Me" character, editable from both places, plus auto-detect self-references in dream text',
    detail: 'Right now the "Me" character (the isSelf-flagged entry in Advanced > Characters, with its own name/description/photo, defined in js/store.js\'s character model) and the profile page\'s identity (currently just a handle, no editable photo/name) are two separate things. Idea: unify them into one entity — editing name/photo on profile.html updates the same underlying "Me" character used in the creation flow, and editing "Me" from Advanced > Characters updates the profile too, bidirectionally, reusing the character-editing UI/logic that already exists rather than building two separate edit flows. Second part: when a user writes "I", "me", or their own first/last/full name directly in the dream text (create.html\'s #dream-text), auto-detect that self-reference and offer/auto-attach the "Me" character to the generation, instead of requiring them to separately add it via Advanced every time.'
  },
  {
    id: 'idea-notify-likes',
    category: 'idea',
    priority: 'low',
    done: false,
    title: 'Notify creators when their dream is liked or remixed',
    detail: 'Likes are currently fully anonymous (no per-liker identity tracked) and published dreams carry no email, so the plumbing to know *who* to notify doesn\'t exist yet. Recommended in the last evaluation pass to merge into the Weekly Recap idea rather than build as a separate real-time notification feature (which would need new infrastructure — service worker, push subscriptions). Ranked #9 (Priority Score 0.032).'
  },
  {
    id: 'idea-friend-cameos',
    category: 'idea',
    priority: 'low',
    done: false,
    title: "Friend Cameos (use a friend's photo as a character)",
    detail: 'Explicitly flagged as needing a trust & safety review before any design work starts — this reverses a deliberate existing safety boundary in js/store.js\'s saveCharacter(), which today restricts photo uploads to "self" characters only, with code comments explicitly framing that as a safety boundary, not just a UI gap. Ranked #10 (lowest of the buildable ideas) in the last evaluation pass, driven mainly by this real consent/likeness risk.'
  },
  {
    id: 'idea-fingerprint-email-verify',
    category: 'idea',
    priority: 'low',
    done: false,
    title: 'Device fingerprinting + email verification fused early in signup',
    detail: "The strongest anti-abuse layer identified in the pre-payment-generation research, deliberately deferred — it's real build effort plus at least one new vendor account (a human-approval decision on its own), and wasn't judged worth it before the product has real usage data justifying the investment."
  },
  {
    id: 'idea-generate-before-paywall',
    category: 'idea',
    priority: 'low',
    done: false,
    title: '"Generate during the funnel, reveal at the end" / "email me my dream if I don\'t convert"',
    detail: "Both researched as marketing/conversion mechanics. Explicitly recommended against for now: both mean incurring real generation cost before any identity signal exists that early in the funnel, which was judged too risky without a much heavier anti-abuse stack in place first. Worth revisiting only once the guardrails above mature."
  },
  {
    id: 'idea-auto-refund-policy',
    category: 'idea',
    priority: 'medium',
    done: false,
    title: 'Auto-refund tokens once/day per user on failed generation, else manual support refund',
    detail: 'Decided policy for the "token-refund-gap" question above: automatically refund the 100 tokens once per day per user when a generation fails after submission (E205/E208 etc.), and for any additional failures beyond that daily auto-refund, direct the user to request a manual refund via the support contact form (see idea-support-contact-form). Needs a way to track "already auto-refunded today" per user — likely mirrors the existing lazy daily-check pattern already used for the token grant in entitlements.js — and the support form to exist first for the manual fallback path to actually go anywhere.'
  },
  {
    id: 'idea-support-contact-form',
    category: 'idea',
    priority: 'medium',
    done: false,
    title: 'Support contact form in Settings, emailing the founder with user context',
    detail: "A text field in Settings that sends a message to the founder's email, automatically including: username, email, number of videos created, days since signup, and total amount paid (once real payments exist). Needs a transactional email send (Resend is already wired into this codebase for other purposes) and pulling together account stats that aren't all in one place today. Also the fallback path idea-auto-refund-policy depends on."
  },
  {
    id: 'idea-faq-section',
    category: 'idea',
    priority: 'low',
    done: false,
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
    title: 'Confirm whether account deletion actually exists before publishing the FAQ answer',
    detail: 'The draft FAQ (idea-faq-section) answers "can I delete my account?" with "yes," but this doesn\'t appear to be a real, built flow yet — flagged when the FAQ draft was written. Confirm it exists (and works) before publishing that answer, or build it, or change the answer to be accurate.'
  },
  {
    id: 'confirm-fal-credit-balance',
    category: 'task',
    priority: 'medium',
    done: false,
    title: "Check fal.ai account's real credit balance and auto-lock threshold before real ad spend",
    detail: "fal.ai bills on prepaid credits with an automatic account lock once the balance drops below a threshold — this is DreamTube's actual worst-case cost ceiling today, more fundamental than any of the app's own rate limits (E109/E110/E112). Flagged during the launch-safeguards discussion and never confirmed: what the current loaded balance and lock threshold actually are, especially before pointing real Meta ad traffic at the funnel."
  },
  {
    id: 'decide-blobs-lazy-seed-race',
    category: 'task',
    priority: 'low',
    done: false,
    title: 'Decide: accept or fix the lazy-seed race shared by entitlements.js/paywall-settings.js/tracker-store.js',
    detail: "Review found this while checking tracker-page: the 'materialize a default on first read' pattern used in three separate lib files has no atomic/conditional-write primitive available in the installed @netlify/blobs SDK, so a genuinely concurrent first-ever read+write can race and one write can silently clobber the other. Low real-world likelihood so far (single-owner tools, low write frequency) — decide whether to just document this explicitly in each file (cheaper) or build a real fix (a separately-checked 'seeded' marker key) before a fourth place reuses the same pattern for something with higher write concurrency."
  },
  {
    id: 'tracker-needs-real-add-delete',
    category: 'task',
    priority: 'medium',
    done: false,
    title: "Give tracker.html real add/delete endpoints instead of source-edited seed data",
    detail: "Right now every new tracker item (including this one) is added by editing SEED_ITEMS in the repo and pushing to main — which only has any effect on the LIVE page before its very first real read; tracker-store.js's lazy-seed only ever fires once, so once the live Blobs store has actually been seeded, further edits to SEED_ITEMS in source do nothing at all. Standing instruction now is to keep adding flagged items here and deleting resolved ones going forward, so this needs real owner-gated add-item/delete-item endpoints (matching update-tracker-item.js's existing owner-check pattern) rather than continuing to rely on source edits, which will silently stop working the moment the page is first visited live."
  },
  {
    id: 'accounts-dont-sync-across-devices',
    category: 'task',
    priority: 'high',
    done: false,
    title: 'IN PROGRESS: server-side account/password check, so login + forgot-password work across devices',
    detail: "DECIDED: build the scoped fix now — move just the account check (username/email/password match) to a small server-side Blobs store, reusing the same lightweight keyed-lookup pattern already used by entitlements.js/paywall-settings.js/tracker-store.js (no sessions, no hashing infra, no new auth framework). This fixes login and forgot-password from any device. It deliberately does NOT sync dreams/characters themselves — see sync-private-dreams-videos-later for that, explicitly deferred and scoped separately. Being built now; mark done once merged."
  },
  {
    id: 'sync-private-dreams-videos-later',
    category: 'task',
    priority: 'low',
    done: false,
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

/**
 * Returns the full items array, seeding+persisting SEED_ITEMS on the very
 * first call in a fresh environment (no "items" key written yet). Every
 * later call — from either function — reads back whatever's actually
 * persisted (the seed, plus any priority/done edits since), never
 * re-seeds over real edits. `event` is the calling function's Lambda
 * event, passed through to connectLambda so this works from any Netlify
 * Function.
 */
async function getItems(event) {
  connectLambda(event);
  var items = await store().get(KEY, { type: 'json' });
  if (!items) {
    items = SEED_ITEMS;
    await store().setJSON(KEY, items);
  }
  return items;
}

/**
 * Patches one item's `priority`/`done` by id and persists the full list.
 * `patch` may set either or both fields — callers validate/coerce values
 * before calling this (see update-tracker-item.js). Returns the updated
 * item, or `null` if no item with that id exists (store is left
 * untouched in that case — never partially written).
 */
async function updateItem(event, id, patch) {
  var items = await getItems(event);
  var idx = -1;
  for (var i = 0; i < items.length; i++) {
    if (items[i].id === id) { idx = i; break; }
  }
  if (idx === -1) return null;

  var updated = Object.assign({}, items[idx], patch);
  items = items.slice();
  items[idx] = updated;

  connectLambda(event);
  await store().setJSON(KEY, items);
  return updated;
}

/**
 * Appends a brand-new item built from `patch` ({ category, title, detail,
 * priority }) — shape/value validation is the caller's job (see
 * add-tracker-item.js), this trusts what it's given. Generates the id
 * server-side (see generateId above) and always starts the item at
 * done: false, comment: ''. Returns the created item. A pure append —
 * never reorders or otherwise touches any existing item.
 */
async function addItem(event, patch) {
  var items = await getItems(event);
  var created = {
    id: generateId(items, patch.title),
    category: patch.category,
    title: patch.title,
    detail: patch.detail,
    priority: patch.priority,
    done: false,
    comment: ''
  };
  items = items.concat([created]);

  connectLambda(event);
  await store().setJSON(KEY, items);
  return created;
}

/**
 * Removes one item by id and persists the resulting list. Returns `true`
 * if an item was actually found and removed, `false` if no item with
 * that id existed (store is left untouched in that case — never
 * partially written, same not-found handling as updateItem above).
 */
async function deleteItem(event, id) {
  var items = await getItems(event);
  var idx = -1;
  for (var i = 0; i < items.length; i++) {
    if (items[i].id === id) { idx = i; break; }
  }
  if (idx === -1) return false;

  items = items.slice(0, idx).concat(items.slice(idx + 1));

  connectLambda(event);
  await store().setJSON(KEY, items);
  return true;
}

module.exports = { STORE_NAME, KEY, SEED_ITEMS, getItems, updateItem, addItem, deleteItem };
