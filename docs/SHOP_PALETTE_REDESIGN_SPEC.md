# Shop Palette & Visual Redesign Spec — calming the token shop's red/hot look

**Status:** design pass complete — two directions proposed below, pending founder
pick per `AGENT_POLICY.md`'s escalation policy ("choosing a design or creative
direction" always requires human approval). Not yet built.

**Trigger:** explicit founder feedback from a real mobile test — the shop's
current visual palette (a red-gradient "1600" token count, red card borders,
red/orange accents) reads as loud/urgent rather than calm and trustworthy.
Founder wants it to resemble how comparable, established consumer products
present token/credit shops.

Companion coordination: this repo's live coordination channel is
`tracker.html` (Netlify Blobs), not a signals repo — the old
`ronbrightman/dreamtube-signals` repo is archived per `AGENT_POLICY.md`
(2026-07-23). The live tracker was checked before writing this — nothing open
specifically flags red/palette work; the only directly relevant item is
`for-product-dodo-payments-live-integrate-0exz5r` (Dodo live, awaiting
founder env setup), which is why this spec treats the purchase flow as real,
not a placeholder. This task came from direct founder feedback on a mobile
test, not from the research→evaluation ranked-list pipeline, so there's no
RICE score / "idea chosen from a ranked list" decision-made entry to draft
for it. Once Ron picks Direction A or B, that choice gets logged as a tracker
item (`[auto] Shop redesign: Direction <A|B> chosen (palette)`, priority
medium, detail referencing this spec + his stated reason) before build picks
it up.

## 1. What exists today (read directly from the code, 2026-07-24)

| Thing | Real current state | Source |
|---|---|---|
| Purchase flow | **Live**, not placeholder — both packs call `create-checkout-session-dodo.js`, redirect to real Dodo Checkout | `shop.html` |
| Token packs | 100 tokens/$1.99, 500 tokens/$8.95 (500 badged "10% off") | `shop.html` |
| Where the red/hot look actually comes from | `--gradient-ig: linear-gradient(135deg,#833AB4,#FD1D1D,#FCB045)` — documented in `css/styles.css`'s own header comment as reserved for **exactly two places app-wide** (the bottom-nav "+" create button, the avatar ring on Profile) — but `shop.html` uses it in 4 more spots, and `profile.html`'s `.token-chip` in a 5th | `css/styles.css:14-21`, `.token-balance-card`/`.token-balance-amt`/`.token-pack-badge` (579-592), `.token-pack-card.best{border-color:#FD1D1D}` (586) |
| App's dark theme tokens | `--void:#000`, `--surface:#1a1a1a`, `--surface-alt:#242424`, `--text-primary:#fff`, `--text-muted:#999`, `--text-faint:#666`, `--border:rgba(255,255,255,.08)`, `--border-strong:rgba(255,255,255,.16)`, `--danger:#FF3040` (like-heart + real errors only) | `css/styles.css:1-31` |
| "Light dawn theme" | Page-scoped to `index.html`'s Welcome screen + `start.html`'s marketing-funnel handoff only, deliberately not the app's general theme — explicitly ruled out as a source for shop | `index.html:19-48` |
| Existing "restrained color" convention | Advanced/character-chip screens (already redesigned per founder feedback) deliberately moved *away* from heavy fills toward `--surface`/`--border` (not `--surface-alt`/`--border-strong`) specifically because the heavier version "read as heavy" — the same instinct applies here | `css/styles.css:294-344` |
| Existing "big number" pattern elsewhere in the app | `.rec-timer{font-size:34px; font-weight:700}` — plain white bold, no gradient/color treatment, on the Record screen | `css/styles.css:265` |

## 2. Real comparable-product research grounding

- **Duolingo's Gem Shop** — Feather Green is the core brand color; Sky Blue
  (`#1cb0f6`) is reserved for secondary interactive elements (buttons,
  links, currency CTAs); rounded pill buttons with a solid darker-shade
  "shadow" for depth; no red-urgency treatment anywhere in the shop chrome.
  Duolingo's own 2026 shop redesign is credited with a real, measured
  revenue lift — calm and legible outperformed loud.
- **AI-tool credit pages (ElevenLabs, Runway, OpenAI Business credits)** —
  balance is shown as a plain, neutral numeral (no special gradient/glow
  treatment on the number itself); the only accent color appears on the
  primary "buy"/"add credits" action, not on the balance display or the
  cards around it.
- **Mobile-game currency shops generally** — a "best value" tag is
  conventionally gold, green, or blue, not red; red/urgency treatment is
  reserved for time-limited sale banners, not the shop's core currency
  chrome — using it for "best value" (a permanent, not urgent, label) is a
  mismatch DreamTube's current shop is making.
- **General checkout/fintech convention** (Stripe, PayPal, Coinbase, Cash
  App, Robinhood) — purchase flows anchor on blue/green as the "trust"
  color; red is reserved strictly for destructive/error states, matching
  exactly how DreamTube's own `--danger` token is already used everywhere
  *except* the shop page.

## 3. New palette — extend, don't replace, the existing token system

Two new semantic CSS custom properties, added to `:root` in
`css/styles.css` alongside the existing system (not a parallel palette):

```css
/* Direction A */
--accent-trust: #6C8CFF;              /* calm periwinkle-blue */
--accent-trust-soft: rgba(108,140,255,.12);

/* Direction B */
--accent-value: #D9A653;              /* muted warm gold */
--accent-value-soft: rgba(217,166,83,.12);
```

Both read comfortably against `--void`/`--surface` (dark backgrounds) at
badge/border/large-text sizes; verify at build time with a contrast checker
for any small-text use specifically (badges use white text on a solid fill,
which sidesteps this).

**Untouched, on purpose:** `--danger`, `--gradient-ig`, `--void`, `--surface`,
`--surface-alt`, `--border`, `--border-strong`, `--text-*`, `--radius-*`,
`--font-*`. They're all used correctly everywhere else in the app; this is a
scoped fix, not a system rewrite.

## 4. Two directions

### Direction A — "Quiet ledger" (single trust-blue accent)

Grounded in: Duolingo's Sky Blue secondary-accent convention plus the
ElevenLabs/Runway/OpenAI pattern of a plain, unadorned balance numeral. This
is the safer, more conservative option — it makes the shop look and feel
like the rest of DreamTube's already-restrained dark UI, with one small,
deliberate accent used only where something is actually actionable.

- **Balance card** (`.token-balance-card`): drop the `--gradient-ig` 2px
  border entirely; use a plain `1px solid var(--border-strong)` card, same
  as every other card in the app (`.token-pack-card`, `.adv-section`, etc.)
- **Balance number** (`.token-balance-amt`): plain `color:var(--text-primary)`
  bold white, no gradient text-fill — matches `.rec-timer`'s existing
  big-number pattern elsewhere in the app. "1600" now just reads as a large
  white number, calm and legible.
- **"Best value" pack** (`.token-pack-card.best`): border becomes
  `var(--accent-trust)` instead of `#FD1D1D`; badge (`.token-pack-badge`)
  becomes a solid `var(--accent-trust)` fill with white text instead of the
  IG gradient chip.
- Buy buttons, card radius/spacing/shape: unchanged (`.btn-secondary`,
  `.token-pack-card`'s existing padding/radius).

```
+------------------------------+
|  <-        Token shop        |
+------------------------------+
| v Free during beta - no card |
|                               |
|      +-----------------+     |
|      |      1600       |     |  <- plain white bold
|      |  tokens available|     |
|      |  Next 10 free...  |    |
|      +-----------------+     |
|                               |
|  TOKEN PACKS (OPTIONAL)      |
|  +---------------------+     |
|  | 100 tokens   $1.99   |    |
|  | Enough for 1 more gen|    |
|  | [ Buy ]              |    |
|  +---------------------+     |
|  +- 10% off ----------+      |  <- blue badge, not IG gradient
|  | 500 tokens   $8.95   |    |  <- blue border, not #FD1D1D
|  | Enough for 5 more gens|   |
|  | [ Buy ]              |    |
|  +---------------------+     |
| Free tokens are capped...    |
+------------------------------+
```

### Direction B — "Premium currency" (warm muted gold accent)

Grounded in: mobile-game currency-shop convention where a "best value" tag
uses a gold/premium treatment (distinct from the app's own hot IG gradient,
and distinct from red-urgency sale tags) — signals "this is the good deal"
without borrowing the social-gradient's hot-pink midpoint. Slightly warmer
and more "this is a currency, treat it like one" than Direction A.

- Same structural changes as Direction A (drop gradient border on balance
  card, plain white balance numeral, plain-bordered pack cards).
- **"Best value" pack**: border and badge use `var(--accent-value)` (muted
  gold) instead of blue — reads closer to "premium pack," slightly more
  distinct from the rest of the app's monochrome UI without re-introducing
  heat.
- Everything else identical to Direction A.

### Tradeoff

Direction A blends the shop almost invisibly into the rest of DreamTube's
existing restrained dark UI — lowest risk, most consistent, but the "best
value" pack is slightly less visually distinct since blue is close in
temperature to the app's neutral grays.

Direction B makes the "best value" pack pop a bit more (gold reads as
"special" more readily than blue against near-black), which may convert
slightly better on the exact thing DreamTube wants to nudge people toward,
at the cost of introducing a second new hue into a codebase that currently
guards its accent-color budget carefully (the existing "exactly two places"
rule for `--gradient-ig`). Direction A stays truer to that existing
restraint; Direction B spends a little more of it.

Recommendation: Direction A, given the app's own stated color discipline —
but this is exactly the kind of call reserved for Ron, not for an agent.

## 5. Copy/hierarchy changes needed

- `.token-balance-amt`: styling only — the number itself ("1600"), position,
  and the "tokens available"/countdown sublines all stay exactly as-is. No
  new copy needed either direction.
- Badge copy ("10% off") stays as-is in both directions — only its color
  changes.
- No wording changes anywhere in `shop.html`'s copy — this is a visual pass,
  not a copy pass.

## 6. Explicitly stays the same (no UX overhaul)

- Page structure/order top to bottom: back button → beta banner → balance
  card → "Token packs" section label → two pack cards → footnote. Unchanged.
- Beta banner copy/behavior ("Free during beta — no card needed").
- The entire purchase flow: `purchasePack()`, Dodo checkout redirect,
  `?checkout=success|cancelled` return handling, balance polling, toasts,
  disabled-button-during-redirect state, the "add an email first" gate.
  None of this is touched — this spec is CSS-only.
- `.btn-secondary` styling on Buy buttons, card radius (`--radius-md`),
  padding, spacing between cards.
- Loading state (button → "Redirecting…", disabled) and error state
  (toast: "Checkout isn't available right now — try again soon", button
  re-enabled) — both already correct, both untouched.

## 7. Explicitly out of scope for this pass

- `profile.html`'s `.token-chip` has the identical `--gradient-ig`
  scope-creep issue (same hot pink/red-dominant gradient on a token
  balance). Real, but a separate surface the founder didn't flag — worth a
  small follow-up tracker item, not bundled into this pass.
- Adding a dedicated token/coin icon next to the balance number — no such
  icon exists in `js/icons.js` today; a nice-to-have, not required to solve
  the "looks hot/red" complaint.
- Any reconsideration of `--gradient-ig`'s "exactly two places" rule
  app-wide — flagged as the actual root cause, not re-litigated here.
- Pricing, token economics, or purchase-flow UX changes — none proposed or
  needed.

## 8. Files read to ground this spec

`shop.html`, `css/styles.css` (full token block plus all `.token-balance-*`/
`.token-pack-*`/`.adv-*`/`.char-chip*` rules), `profile.html` (`.token-chip`
usage), `index.html` (dawn-theme scoping comment), `AGENT_POLICY.md`,
`FOUNDER_PRINCIPLES.md`, `docs/IMAGE_GENERATION_SPEC.md`/
`docs/UNIFIED_IDENTITY_SPEC.md` (format convention), plus the live
`tracker.html` backend (`get-tracker-items`).
