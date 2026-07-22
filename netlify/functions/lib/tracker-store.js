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
// item — id/category/title/detail are seed-authored content, not something
// the UI lets anyone mutate (see that function's own doc comment for why).

var { getStore, connectLambda } = require('@netlify/blobs');

var STORE_NAME = 'dreamtube-tracker';
var KEY = 'items';

// Seed content is exact, founder-approved copy — see the tracker-page build
// task this was written for. Do not paraphrase/trim when editing; add new
// items instead of rewriting these if the content ever needs to change.
var SEED_ITEMS = [
  {
    id: 'owner-token-bypass',
    category: 'task',
    priority: 'high',
    done: false,
    title: 'Decide: owner bypass for the token gate (E112)?',
    detail: 'The old subscription paywall exempted OWNER_EMAIL from its entitlement check. The new token-economy gate (E112) has no owner bypass at all — the founder\'s own account is subject to the same 200-signup + 100/day limit as any user. Decide whether to restore an owner exemption for E112 specifically (E109/E110 rate-limit and spend-cap protections would still apply to the owner either way, matching how the old bypass worked).'
  },
  {
    id: 'token-refund-gap',
    category: 'task',
    priority: 'high',
    done: false,
    title: 'Decide: refund tokens if generation fails after submission?',
    detail: 'Tokens are spent the moment fal.ai accepts a generation submission (a 200 response), not when the video actually finishes. If the job later fails during polling (video-status.js\'s E205/E208 etc.), there\'s currently no refund — a user can lose 100 tokens for a video that never rendered. This matches the old quota system\'s identical behavior, so it isn\'t a new regression, but tokens are a harder, more consequential cap now. Decide: leave as-is (and document it explicitly), or add a refund-on-terminal-failure path.'
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
    id: 'agent-policy-explicit-naming',
    category: 'task',
    priority: 'medium',
    done: false,
    title: 'Add an explicit agent-naming convention to AGENT_POLICY.md for the core pipeline',
    detail: 'The research → evaluation → design → build → review pipeline is currently only documented in prose in AGENT_POLICY.md\'s Workflow section — nothing scripts or enforces the sequence, and nothing currently tells whoever\'s driving the pipeline to name each agent explicitly rather than relying on auto-routing. Recommended: add a short section spelling out the exact agent names/invocation convention to use per stage, especially once item "agent-skill-duplication" above is resolved.'
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
  }
];

function store() {
  return getStore({ name: STORE_NAME });
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

module.exports = { STORE_NAME, KEY, SEED_ITEMS, getItems, updateItem };
