# DreamTube — Web App (Multi-Page v2)

> **⏸️ Project paused (2026-08-20).** The app stays live; ads are off. The
> **knowledge harvest** — operating system, playbooks, the honest retrospective,
> the project-agnostic *Agent Field Guide*, cost inventory, and pause checklist —
> lives in the **Manager repo** (`ronbrightman/manager`), start at its
> [`README`](https://github.com/ronbrightman/manager#-knowledge-harvest--start-here-for-the-next-project)
> / [`harvest/`](https://github.com/ronbrightman/manager/tree/main/harvest).

A real, working DreamTube web app rebuilt as a **true multi-page site**: every screen is its own `.html` file with normal browser navigation (real `<a href>` links, real page loads). No single-page-app framework, no ES modules, no build step.

This replaces the earlier single-page-app version. If that one didn't load for you, it was almost certainly because it used `<script type="module">`, which browsers refuse to load over `file://` — double-clicking `index.html` looked like nothing worked. This version uses plain `<script>` tags everywhere, so **it works even opened directly from disk**, in addition to being deployable as a real website.

## Open it right now (no server needed)

Just double-click `index.html`. That's it — every page uses plain scripts, so `file://` works fine.

## Deploy it for real

Still just static files — drop the whole folder on any static host:
- **Netlify Drop** (fastest): go to app.netlify.com/drop, drag the folder in, get a live URL instantly.
- **GitHub Pages**: push the folder to a repo, enable Pages.
- **Vercel / any static host / S3**: upload as-is.

No build command, no environment variables, no server required — the pages themselves are still just static files however you host them. (This repo's own real Netlify deploy, connected via `netlify.toml`, does run one tiny build command now — see "Release visibility & rollback" below for what it does and why; it doesn't change anything about how the site works or how you'd deploy a plain copy of this folder elsewhere.)

## Pages

| File | Screen |
|---|---|
| `index.html` | Welcome |
| `login.html` | Login / Sign up |
| `home.html` | Home — the logged-in landing page (Today/This Week/My Dreams/Chamber/Vault cards; see tracker item for-product-build-homepage-wave-1-the-ri-xr8mir) |
| `explore.html?id=…` | Explore (vertical scroll-snap feed) — one tap away from Home's bottom nav |
| `profile.html` | Profile (your own dreams + Create) |
| `create.html` | Create (Write / Record / Review sub-states) |
| `style.html` | Choose a style |
| `processing.html` | Generating… (real async call, shows a failure state on genuine generation errors) |
| `result.html?id=…` | Result (Edit/Change Style sheets, Publish) |

`home.html` was retired for a while (an old YouTube-style feed, unlinked from the live app) and has since been REVIVED as the new logged-in landing page — see the tracker item above for the full rebuild. Bottom nav is Home / Explore / + Create / Profile everywhere, and every page with one (`home.html`, `explore.html`, `profile.html`, `result.html`) now renders the SAME "Bar A" night-dock bar through one shared renderer (`js/bottom-nav.js`, same self-contained-module pattern as `js/purchase-sheet.js`) — a translucent, blurred bar overlaid on the bottom of `#app` (content scrolls/plays behind it), with the signed-in account's own avatar standing in for the Profile tab's icon. This started as two competing systems (profile.html's own bespoke `.night-dock`, everyone else's older in-flow `.bottom-nav`) and was unified per the founder's own words, 2026-07-31: "the bottom nav bar is not the same across screens... make it like it is in the profile screen" (tracker item for-product-urgent-founder-roll-the-new--8pyek3, which also folded in `result.html`'s stranding hotfix — that screen had no bottom nav at all).

Navigation between pages is real browser navigation — back/forward buttons work, every URL is shareable/bookmarkable, and each page can be understood and debugged on its own.

## How state works now

There's no in-memory JavaScript state that would get wiped by a page load anymore (that was the point of a real multi-page site). Instead, `js/store.js` persists a small JSON blob to `localStorage` — think of it as a fake local database standing in for a real backend. It survives navigation and page refreshes; it resets if you clear your browser's site data, and it's specific to whichever device/browser you're using. Dreams/characters are deliberately not synced anywhere (no real backend for those yet) — but the account check itself (signup/login/forgot-password) now also goes through a real server-side store (`netlify/functions/lib/account-store.js`), so an account works from any device, even though what it contains locally (dreams, characters) doesn't follow it there. See that file's header comment for the full story.

## What's real vs. mocked

**Real:**
- Actual multi-page navigation with real URLs.
- A login gate — visiting any protected page without being "logged in" bounces you to `login.html`.
- Real username/password accounts: `signup()`/`login()` in `store.js` validate username length, reject duplicate usernames/emails, and check exact password matches — not a "any password works" mock. The account check itself is real and server-side now (`register-account.js`/`account-login.js`, backed by Netlify Blobs), so it works from any device; a local `localStorage` mirror is still kept too, for the dream/character logic that stays local-only. Credentials are still stored in plaintext (locally and server-side) since there's no real hashing infra yet — an accepted tradeoff, not a regression from before this existed.
- Real video generation via fal.ai (`fal-ai/wan/v2.2-5b/text-to-video`), called through Netlify Functions. Failures shown on Processing are genuine generation errors from fal.ai, not a simulated rate.
- Real audio recording (`MediaRecorder`/`getUserMedia`) and real transcription via fal.ai's Whisper model (`transcribe-audio.js`) — Record actually captures and transcribes your voice.
- Editing a dream's text/style and regenerating actually updates that dream in the shared store.
- Publishing actually flips a flag; the dream then genuinely shows up in Explore because it reads from the same shared feed store.
- Likes persist and update live.
- A failed generation carries your dream text back into Create instead of losing it.
- Explore's style tags and usernames are clickable and filter the feed.
- A generation job in flight survives navigation/refresh and resumes polling instead of being lost.

**Mocked (no real backend to connect to):**
- No real user-facing video files management — fal.ai hosts finished clips on its own CDN URL.
- No real OAuth — only the username/password form logs you in.
- Dreams/characters live only in `localStorage`, private per browser — not a real multi-user backend, and not synced across devices (a deliberate, separate, deferred project). Accounts are the one exception — see "Real" above.

## Connecting a real backend later

`js/store.js` is the seam. Each method's comment states the REST endpoint it should become (e.g. `generateVideo()` → `POST /api/dreams/generate`). Replace the body of each function with a real `fetch()` call returning the same shape, and none of the HTML pages need to change. Suggested order: real auth → real dreams API/DB → real generation pipeline (with Processing polling a job status instead of a fixed local delay) → real audio capture + transcription → real session/auth cookies instead of localStorage.

## File structure

```
index.html         Welcome
login.html          Login / Sign up
home.html            Home — the logged-in landing page (Today/This Week/My Dreams/Chamber/Vault)
explore.html         Vertical feed — one tap away from Home's bottom nav
profile.html          Profile
create.html            Create (write/record/review)
style.html               Choose a style
processing.html            Generating (+ failure state)
result.html                  Result (edit/style sheets, publish)
css/styles.css                 all styling
js/store.js                      localStorage-backed data layer (the backend seam)
manifest.json                      basic PWA manifest
```

## Release visibility & rollback

Founder-approved lightweight versioning (tracker item
`for-product-release-visibility-founder-a-8hx5cz`) — the goal is
answering "what's currently live, and can I get back to the last one"
without slowing down how often this repo ships.

### `version.json`

Served at the site root (`/version.json`), stamped fresh on every real
Netlify build by `scripts/generate-version.js` (wired in via
`netlify.toml`'s `[build] command`). Shape:

```json
{
  "version": "v2026.08.01-a1b2c3d",
  "commitSha": "a1b2c3d4e5f6...",
  "shortMessage": "First line of the deployed commit's message",
  "timestamp": "2026-08-01T21:33:23.545Z",
  "branch": "main",
  "context": "production",
  "deployId": "…"
}
```

A copy is committed to the repo as a placeholder (`"version": "unbuilt"`)
so the file always exists, including when this site is opened straight
from disk (no build step ran) — every real Netlify deploy overwrites it
with the real values above.

**`version` field, and why it isn't `v<date>.<n>`:** the ideal scheme
(`v2026.08.01.3` — "the 3rd deploy today") needs a persistent counter
across builds, and Netlify's build environment is stateless — nothing
survives between builds except what's in git or pulled from an external
store. This repo has already been burned by exactly the failure mode a
Blobs-backed counter would introduce (Netlify Blobs has no compare-and-
swap / read-your-own-write guarantee — see `FOUNDER_PRINCIPLES.md`'s
engineering-lessons section), so two near-simultaneous deploys could
race and silently produce a wrong "nth deploy" number. Rather than fake
a counter that isn't reliably real, `version` is `v<YYYY.MM.DD>-<short
sha>` — still unique per build and sortable by date, just honest about
what it's counting. Full reasoning is in `scripts/generate-version.js`'s
header comment.

Surfaced subtly in `admin.html` (owner-only tools) as a small text line
— the instant answer to "is my device on the latest version," useful
whenever a deploy looks like it hasn't landed yet.

### `RELEASES.md`

One line per commit on `main` (timestamp, short SHA, commit subject).
**Regenerated on demand, not auto-appended at build time** — run
`npm run release-notes` (`scripts/generate-releases.js`) after merging
to `main`. See that script's header comment for the honest reasoning:
Netlify's build sandbox has no credentials to push a commit back to this
repo, and this repo has no CI/git-hooks to hang an "after merge" step
off, so anything claiming to run automatically inside the build would
silently never actually persist in production. Regenerating on demand
from `git log` instead means the file is always exactly reconstructable
and never drifts or duplicates, however long it's been since it was last
run.

### Milestone tags

Ad-hoc merges to `main` do **not** get git tags — this stays fast and
ceremony-free, matching "deploy-on-merge" as the normal flow. For an
actual milestone worth marking permanently, tag it by hand:

```
git tag v1.0 <sha>
git push origin v1.0
```

This is a process note, not tooling — no automation creates these tags.

### Rolling back a bad deploy

Netlify keeps every deploy as an immutable, individually-restorable
version — this is the actual safety net `version.json`/`RELEASES.md`
above are meant to make more *discoverable*, not replace. Per Netlify's
own current docs (verified live, not from memory, per this repo's
standing rule on dashboard instructions):

- Every deploy Netlify makes is versioned and can be previewed from its
  own unique deploy URL, browsable from the site's deploy history in the
  Netlify UI.
- Rolling back means publishing a previously-made deploy again — this
  republishes that exact already-built version instantly, with no new
  build running.
- If the site auto-publishes on every push to `main` (the setup here),
  a rollback stays live only until the next push-triggered deploy
  publishes over it — Netlify calls out "locked deploys" as the way to
  hold a specific deploy live and prevent that automatic override, if a
  rollback needs to stick around.

Exact menu/button labels aren't reproduced here since Netlify's own UI
terminology drifts over time (see `CLAUDE.md`'s standing rule) — use the
site's own deploy history in the Netlify dashboard, find the deploy you
want, and use its "publish this deploy" action.

## Known gaps (by design, not bugs)

See `dreamtube-build-spec.md` from the design phase for the full list — no unpublish/delete, unlimited generation (no usage limits in MVP by decision), no empty/cold-start screen states, no style preview before generating.
