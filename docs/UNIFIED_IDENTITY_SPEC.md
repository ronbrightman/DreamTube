# Unified Identity Spec — "Me" character ⇄ profile identity, and self-reference auto-attach

**Status: MAJOR FINDING — both Part 1 and Part 2 are already fully implemented and live on `main`**, verified by direct code read (2026-07-24), not by trusting the tracker item's own framing of the problem. This doc documents the AS-BUILT implementation to the same precision `docs/IMAGE_GENERATION_SPEC.md` uses, checks it line-by-line against tracker item `idea-unified-me-identity`'s original ask, and isolates the one genuine open UX decision that's left — everything else here is "here's what exists," not "here's what to build."

Independently re-verified by the orchestrating session (2026-07-24): confirmed `create.html:753,783,797,1382` contain the described `FIRST_PERSON_RE`/`autoSelectSelfIfMentioned` logic, confirmed `profile.html:217,239,516,533` contain the described bidirectional identity sheet writing through `DreamStore.saveCharacter({isSelf:true,...})`, and ran `test/profile-me-character-behavioral.test.js` directly — 6/6 passing, covering both the bidirectional sync and the self-reference auto-attach (including the "common word matching part of the Me character's name auto-attaches once, never duplicates, never attaches without a Me character" case).

Tracker item `idea-unified-me-identity` (fetched 2026-07-24) was marked **"In progress" / "design phase underway"** — that status was stale relative to the code.

## 1. What exists today (read directly from the code, 2026-07-24)

| Thing | Real current state | Source |
|---|---|---|
| "Me" character data model | Unchanged — `state.charactersByUser[username]`, one entry per user with `isSelf: true`, same shape as any other character (`{id, name, isSelf, description, photoDataUrl?}`) | `js/store.js:114`, `saveCharacter` doc comment at `js/store.js:1231-1255` |
| Profile identity is a real field? | **No — and this is the correct call, not a gap.** `profile.html` has no separate name/photo field at all. Its avatar and display name are a *derived view* over `DreamStore.getCharacters().filter(isSelf)[0]` | `profile.html:329-346` |
| Profile edit sheet | `#sheet-identity-overlay` — full name + describe/photo toggle, writes via `DreamStore.saveCharacter({isSelf:true,...})` — the exact same call `create.html`'s character sheet makes | `profile.html:207-243, 512-580` |
| Advanced &gt; Characters "Me" edit (post-signup) | `create.html`'s `#sheet-character-overlay` in "self" mode — same `char-mode-row`/photo-upload/describe pattern, same `DreamStore.saveCharacter` call | `create.html:183-211, 443-560` |
| Pre-signup "Me" setup (wizard/start funnels) | Staged locally (`saveCharacter` requires a logged-in account, which doesn't exist yet mid-funnel), then flushed into the real `DreamStore.saveCharacter` once signup completes | `start.html:480-512`, `wizard.html` equivalent |
| Cross-device sync | **None — client-side/per-browser only, by explicit, already-accepted design.** `netlify/functions/lib/account-store.js` only moved the *account* (username/email/password) check server-side; its own header comment states it "does NOT sync dreams/characters/videos... that's a separate, bigger, deliberately deferred project" | `netlify/functions/lib/account-store.js:16-20` |
| Self-reference auto-attach in dream text | Live: typing "I"/"me"/the user's own first/last/full name into `#dream-text` (or a voice transcript) silently adds the Me character to `draft.characterIds` | `create.html:748-798` |
| Where it fires | `#dream-text`'s `input` listener (Write flow) **and** the Record flow's transcription success handler — broader than the original ask's literal "`#dream-text`" scope, in a good way | `create.html:795-798` (text), `create.html:1367-1382` (voice transcript) |
| Where it does NOT fire | Build-it flow (`#create-build`) — deliberately, since that flow is 100% chip/subject-selection based (`subjectKey: 'me'` when the user explicitly picks the Me chip), never free text — no gap here | `create.html:1221-1243` |

## 2. Part 1 — bidirectional identity unification: AS-BUILT

### 2a. Data model decision (already made, and correct)

**No new field, no pointer field.** Profile display name/avatar are **not** a separate stored value that has to be kept in sync with the Me character — `profile.html` simply reads `DreamStore.getCharacters().filter(c => c.isSelf)[0]` fresh on every render (`profile.html:329-331`) and falls back to `user.handle` / a placeholder when no Me character exists yet (`profile.html:336-345`).

This is the right call for this codebase:
- Zero drift risk — two stored copies of "your name" would eventually disagree, and this is a static multi-page app with no shared in-memory state to keep them consistent live.
- Matches the existing "characters are per-user, not per-page" model — `myCharacterList()` (`js/store.js:284-289`) is already the single source of truth every page reads through `DreamStore.getCharacters()`.
- Storage stays exactly where `account-store.js`'s own header comment says it deliberately still is: client-side, `localStorage`-only, not synced across devices — a real, already-flagged, already-separately-tracked limitation, not something this feature needs to fix.

### 2b. `profile.html` — exact UI (as built)

- **Avatar** (`#profile-avatar`, `profile.html:77`) — `me.photoDataUrl` as an `<img>`, or a placeholder if no photo is set.
- **Display name** (`#profile-handle`, `profile.html:80`) — `me.name` if set, else `user.handle` (the login username, prefixed `@`).
- **Tap target** — both the avatar ring and the name open the same `#sheet-identity-overlay` edit sheet.
- **Edit sheet fields**: name input, a Describe/Upload-photo `char-mode-row` toggle, a description textarea, and a photo picker with the same 768px/0.82-quality downscale-before-store step `create.html`'s own character sheet uses (duplicated per-page — this codebase's established convention, since it's a bundler-free, no-shared-module static site).
- **Save** (`#identity-save-btn`) calls `DreamStore.saveCharacter({ id: me?.id, isSelf: true, name, description, photoDataUrl })` — literally the same call `create.html`'s self-mode character sheet makes. This is the actual mechanism that makes the two "the same entity, not two synced copies" — there is exactly one write path (`saveCharacter`), two UI entry points onto it.
- **Describe mode with real text** calls `netlify/functions/generate-avatar.js` to turn the typed description into a real avatar image before saving, with a race-guarded loading state (`identitySheetToken`, mirroring `create.html`'s own `charSheetToken` pattern) so a cancelled/reopened sheet can't have a stale generation silently overwrite newer state.
- **Validation**: unchanged from `saveCharacter`'s own rule — a self character needs a description OR a photo.
- **On success**: `renderIdentity()` re-runs (updates the avatar/name immediately) and a toast reads "Profile updated".

### 2c. Advanced &gt; Characters — exact UI (as built)

- `create.html`'s existing "Add yourself" chip (shown only when no self character exists yet) / the self character's own chip (once it exists) both open `#sheet-character-overlay` in `'self'` mode.
- Same fields, same toggle, same `saveCharacter({isSelf:true,...})` write path as §2b — reuses the character-editing logic at the data level (one shared save function); the sheet markup is duplicated per-page, this codebase's stated convention for a static multi-page site with no shared-component system.
- **Propagation**: because this is a real multi-page site (full page loads, not an SPA), "editing from one page updates the other" happens the normal way — the next page load reads current `localStorage` state and shows the latest edit. No live cross-tab push, an accepted limitation everywhere in this app, not specific to this feature.

### 2d. Checklist against the original ask

| Ask | Status |
|---|---|
| "editing name/photo on profile.html updates the same underlying 'Me' character used in the creation flow" | ✅ Done — writes through `DreamStore.saveCharacter({isSelf:true,...})`, the exact function every generation call resolves characters from |
| "editing 'Me' from Advanced &gt; Characters updates the profile too, bidirectionally" | ✅ Done — same write path, and `profile.html:332` always reads current state fresh |
| "reusing the character-editing UI/logic that already exists" | ✅ Done at the logic layer (one `saveCharacter` call for both entry points); markup duplicated per-page by this codebase's explicit no-shared-components convention |

## 3. Part 2 — self-reference auto-detection: AS-BUILT

### 3a. The exact heuristic (already implemented)

```js
// create.html:753
var FIRST_PERSON_RE = /\b(i|me)\b/i;

// create.html:774-781 — whole-word/whole-phrase match on the Me
// character's name: the full name, plus each individual space-separated
// part, so "Sarah Chen" matches on "Sarah", "Chen", or "Sarah Chen".
function buildNameRegex(name) { /* ... */ }

// create.html:783-793
function autoSelectSelfIfMentioned(captionText) {
  var self = DreamStore.getCharacters().filter(c => c.isSelf)[0];
  if (!self) return;
  var nameRe = buildNameRegex(self.name);
  var mentioned = FIRST_PERSON_RE.test(captionText) || (nameRe && nameRe.test(captionText));
  if (!mentioned) return;
  var selectedIds = DreamStore.getDraft().characterIds || [];
  if (selectedIds.indexOf(self.id) !== -1) return;
  DreamStore.setDraft({ characterIds: selectedIds.concat([self.id]) });
  renderCharacterChips();
}
```

Matches the ask's own scope exactly — "I", "me", or the user's name — not the broader "I/me/my/myself" framing sometimes used loosely; broadening is a separate future lever, not decided here (see §4).

### 3b. Where it fires (broader than the literal ask, correctly)

- `#dream-text`'s `input` listener, on every keystroke.
- The Record flow's transcription success handler, against the returned transcript — a spoken "I was flying..." dream gets the same treatment as a typed one.
- Correctly does not fire in the Build-it flow (chip-based subject picker only, no free text).

### 3c. Checklist against the original ask — and the one real open UX question

| Ask | Status |
|---|---|
| Detect "I", "me", first/last/full name | ✅ Done, exact regex above |
| Auto-attach instead of requiring separate manual add | ✅ Done — auto-attach is silent (no confirmation prompt) |

**The one real, open decision:** the auto-attach chip feedback lives inside `create.html`'s Advanced accordion, which is **collapsed by default**. So for most users who never tap "Advanced," typing "I flew over the ocean" silently changes what gets sent to the video model (the Me character's description/photo enters the prompt) with zero on-screen acknowledgment. `create.html` also has no `#toast` element today (unlike `profile.html`/`result.html`).

Two real directions:

**Direction A — Keep it exactly as shipped (fully silent).** Zero additional build cost. Lowest friction, matches the feature's existing "not a security boundary" framing. Risk: a user who never opens Advanced has no way to know their likeness is being included, and no way to undo it short of discovering the Advanced section exists.

**Direction B — Add a one-time, dismissible acknowledgment toast the first time it triggers per draft.** Reuses `.toast`/`.toast.show` (already global CSS, no new styling needed); adds a `showToast()` helper matching `profile.html`'s own; copy: **"Added your Me character since you mentioned yourself"**; fires once per draft (an in-memory flag, not persisted, so a fresh draft re-arms it). Grounded in current UX precedent (Google Photos' face-tagging confirmation as the closest named analog; 2026 UX-trend research explicitly warns against silent adaptive changes without a visible "why" label).

A second, separate question: today, nothing happens when self-reference is detected but no Me character exists yet (`if (!self) return;`) — whether to add a nudge to create one is a genuinely separate scope decision from A/B above, not bundled in, not built here.

**Recommendation:** Direction B is the lower-risk pick for user trust at negligible build cost, but this is a call for Ron, not decided here.

## 4. Explicitly out of scope for this pass

1. Cross-device sync of the Me character/profile identity — already a separately tracked, deliberately deferred limitation.
2. The "nudge to create a Me character when self-reference is detected but none exists" enhancement — named, not built.
3. Any change to `start.html`/`wizard.html`'s pre-signup character staging — already correctly unified, no gap found.
4. Any change to the Build-it flow — not applicable (no free text).
5. Broadening the regex to include "my"/"myself" — the ask's literal wording is what's shipped; broadening is a real but separate future lever (more false-positive risk), flagged not decided.

## 5. Files read to ground this spec

`AGENT_POLICY.md`, `FOUNDER_PRINCIPLES.md`, `docs/IMAGE_GENERATION_SPEC.md`, `js/store.js`, `profile.html`, `create.html`, `start.html`, `wizard.html`, `netlify/functions/lib/account-store.js`, `css/styles.css`, `test/profile-me-character-behavioral.test.js` (independently run, 6/6 passing).

---

*Design pass completed 2026-07-24; independently code-verified and test-run by the orchestrating session the same day.*
