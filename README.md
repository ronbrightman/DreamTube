# DreamTube — Web App (Multi-Page v2)

A real, working DreamTube web app rebuilt as a **true multi-page site**: every screen is its own `.html` file with normal browser navigation (real `<a href>` links, real page loads). No single-page-app framework, no ES modules, no build step.

This replaces the earlier single-page-app version. If that one didn't load for you, it was almost certainly because it used `<script type="module">`, which browsers refuse to load over `file://` — double-clicking `index.html` looked like nothing worked. This version uses plain `<script>` tags everywhere, so **it works even opened directly from disk**, in addition to being deployable as a real website.

## Open it right now (no server needed)

Just double-click `index.html`. That's it — every page uses plain scripts, so `file://` works fine.

## Deploy it for real

Still just static files — drop the whole folder on any static host:
- **Netlify Drop** (fastest): go to app.netlify.com/drop, drag the folder in, get a live URL instantly.
- **GitHub Pages**: push the folder to a repo, enable Pages.
- **Vercel / any static host / S3**: upload as-is.

No build command, no environment variables, no server required.

## Pages

| File | Screen |
|---|---|
| `index.html` | Welcome |
| `login.html` | Login / Sign up |
| `explore.html?id=…` | Explore (vertical scroll-snap feed) — the main landing/browsing tab |
| `profile.html` | Profile (your own dreams + Create) |
| `create.html` | Create (Write / Record / Review sub-states) |
| `style.html` | Choose a style |
| `processing.html` | Generating… (real async call, shows a failure state on genuine generation errors) |
| `result.html?id=…` | Result (Edit/Change Style sheets, Publish) |

`home.html` (the old YouTube-style feed) has been retired — nothing in the live app links to it anymore, but the file is still present on disk. Bottom nav is now just Explore / + Create / Profile.

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
explore.html         Vertical feed — main landing/browsing tab
profile.html          Profile
create.html            Create (write/record/review)
style.html               Choose a style
processing.html            Generating (+ failure state)
result.html                  Result (edit/style sheets, publish)
css/styles.css                 all styling
js/store.js                      localStorage-backed data layer (the backend seam)
manifest.json                      basic PWA manifest

home.html (retired, unreferenced — kept on disk, not linked from anywhere live)
```

## Known gaps (by design, not bugs)

See `dreamtube-build-spec.md` from the design phase for the full list — no unpublish/delete, unlimited generation (no usage limits in MVP by decision), no empty/cold-start screen states, no style preview before generating.
