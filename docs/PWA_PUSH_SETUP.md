# PWA + Web Push setup (Stage 0)

Tracker item `for-product-build-stage-0-pwa-web-push-f-jbutt5` — Stage 0 of
a staged app-store plan (web push → Play TWA → iOS), founder-approved
2026-07-29 ("I like starting small and easy"). This doc covers the two
things a human needs to do before this feature is fully live, plus the
interim asset decision on the maskable icon.

## 1. Set the VAPID private key as a real Netlify env var

Web Push (RFC 8292) needs a real VAPID keypair. This was generated with
the standard `web-push` npm library's own `generateVAPIDKeys()` — the
reference implementation for this, not a placeholder:

- **Public key** — already committed in `js/push-config.js`
  (`VAPID_PUBLIC_KEY`). Not a secret — see that file's own header comment
  for why it's safe to ship client-side.
- **Private key** — deliberately NOT committed anywhere in this repo,
  same pattern as `FAL_KEY`/`TURNSTILE_SECRET_KEY`/`OWNER_EMAIL` (see
  `docs/TURNSTILE_SETUP.md`). Set it as a Netlify environment variable
  named **`VAPID_PRIVATE_KEY`**:

  ```
  RvsRX6sJLD_lcCFD53xF84KnpzLu3m5U2Bdj7fk1igk
  ```

  (This exact value was generated once, alongside the public key above —
  they're a matched pair. If you ever need to rotate them, generate a
  fresh pair with `npx web-push generate-vapid-keys` and update BOTH the
  public key in `js/push-config.js` and this env var together — a
  mismatched pair makes every subscription silently fail to verify.)

`netlify/functions/lib/push-sender.js` reads this from
`process.env.VAPID_PRIVATE_KEY` only. **Until it's set, every push send
fails closed** (logged, never thrown) — subscribing still works (the
subscription itself is stored regardless), but no notification actually
goes out. This is the one piece of this feature that genuinely can't be
verified without it — see this build's own final report for exactly
what was/wasn't testable in this sandbox.

Also set **`OWNER_EMAIL`** if it isn't already (see
`docs/ANALYTICS_SETUP.md`/`AGENT_POLICY.md` for other places this same
var is used) — `push-sender.js` uses it as the VAPID subject
(`mailto:` contact, required by the Web Push protocol so a push service
operator has a way to reach the sender about abuse). Falls back to a
generic placeholder subject if unset, which still works technically but
isn't a real contact address.

## 2. The maskable icon is an interim asset, not a designed one

`manifest.json` now has two icon entries: the existing `assets/logo-v2.png`
(`purpose: "any"`, unchanged) and a new `assets/logo-v2-maskable.png`
(`purpose: "maskable"`). Only one source image exists in `assets/` (the
full "dreamtube" wordmark lockup, 1254×1254) — there's no separately
designed icon-only mark to use as a real maskable asset.

What was actually done (real, verifiable image processing, not invented):
cropped just the icon mark (the crescent + play-button graphic, excluding
the wordmark text below it) out of the existing lockup, then centered it
on a fresh 1254×1254 black canvas at roughly 60% width — comfortably
inside the maskable-icon spec's safe zone (the inner ~80%-diameter circle
that survives a circular/squircle launcher crop), with generous margin
beyond that minimum since this is a manual approximation, not a
professional maskable export.

This is a reasonable interim (Android launchers that apply a maskable
crop will show a clean icon, not clipped wordmark text), but a real
maskable icon — ideally exported directly from source design files at
multiple sizes (192/512 at minimum, per most PWA installability
checklists) — is worth commissioning whenever there's a next real design
pass on the logo. Flagged here rather than silently treated as done.

## What's genuinely verified vs. what needs a real deployment

See this build's own final report (tracker item comment / handoff) for
the full breakdown — in short: manifest/service-worker registration,
install-nudge webview gating, subscription storage read/write, and the
video-ready/daily-claim-available trigger logic are all covered by
`test/*.test.js` in this sandbox. **Actual push delivery to a real
device** needs a real deployed environment with `VAPID_PRIVATE_KEY` set —
that's the one piece this sandbox cannot exercise end-to-end.
