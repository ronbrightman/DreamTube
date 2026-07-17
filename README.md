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
| `home.html` | Home (YouTube-style feed + bottom nav) |
| `profile.html` | Profile (your own dreams + Create) |
| `create.html` | Create (Write / Record / Review sub-states) |
| `style.html` | Choose a style |
| `processing.html` | Generating… (real async call, shows a failure state on genuine generation errors) |
| `result.html?id=…` | Result (Edit/Change Style sheets, Publish) |
| `explore.html?id=…` | Explore (vertical scroll-snap feed) |

Navigation between pages is real browser navigation — back/forward buttons work, every URL is shareable/bookmarkable, and each page can be understood and debugged on its own.

## How state works now

There's no in-memory JavaScript state that would get wiped by a page load anymore (that was the point of a real multi-page site). Instead, `js/store.js` persists a small JSON blob to `localStorage` — think of it as a fake local database standing in for a real backend. It survives navigation and page refreshes; it resets if you clear your browser's site data, and it's specific to whichever device/browser you're using (nothing is synced anywhere, on purpose — there's no real backend yet).

## What's real vs. mocked

**Real:**
- Actual multi-page navigation with real URLs.
- A login gate — visiting any protected page without being "logged in" bounces you to `login.html`.
- Real username/password accounts: `signup()`/`login()` in `store.js` validate username length, reject duplicate usernames, and check exact password matches — not a "any password works" mock. Credentials are still stored in plaintext in `localStorage` since there's no real backend yet.
- Real video generation via fal.ai (`fal-ai/wan/v2.2-5b/text-to-video`), called through Netlify Functions. Failures shown on Processing are genuine generation errors from fal.ai, not a simulated rate.
- Real audio recording (`MediaRecorder`/`getUserMedia`) and real transcription via fal.ai's Whisper model (`transcribe-audio.js`) — Record actually captures and transcribes your voice.
- Editing a dream's text/style and regenerating actually updates that dream in the shared store.
- Publishing actually flips a flag; the dream then genuinely shows up in Home/Explore because they read from the same store.
- Likes persist and update live.
- A failed generation carries your dream text back into Create instead of losing it.
- Explore's style tags and usernames are clickable and filter the feed.
- A generation job in flight survives navigation/refresh and resumes polling instead of being lost.

**Mocked (no real backend to connect to):**
- No real user-facing video files management — fal.ai hosts finished clips on its own CDN URL.
- No real OAuth — only the username/password form logs you in.
- "Database" is `localStorage`, not a server — private per browser, not a real multi-user backend.

## Connecting a real backend later

`js/store.js` is the seam. Each method's comment states the REST endpoint it should become (e.g. `generateVideo()` → `POST /api/dreams/generate`). Replace the body of each function with a real `fetch()` call returning the same shape, and none of the HTML pages need to change. Suggested order: real auth → real dreams API/DB → real generation pipeline (with Processing polling a job status instead of a fixed local delay) → real audio capture + transcription → real session/auth cookies instead of localStorage.

## File structure

```
index.html         Welcome
login.html          Login / Sign up
home.html            Home feed
profile.html          Profile
create.html            Create (write/record/review)
style.html               Choose a style
processing.html            Generating (+ failure state)
result.html                  Result (edit/style sheets, publish)
explore.html                   Vertical feed
css/styles.css                   all styling
js/store.js                        localStorage-backed data layer (the backend seam)
manifest.json                        basic PWA manifest
```

## Known gaps (by design, not bugs)

See `dreamtube-build-spec.md` from the design phase for the full list — no unpublish/delete, unlimited generation (no usage limits in MVP by decision), no empty/cold-start screen states, no style preview before generating.
