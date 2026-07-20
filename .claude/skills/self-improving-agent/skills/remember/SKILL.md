---
name: "remember"
description: "Capture knowledge into this project's loop-maintained memory — either explicitly from a direct instruction, or automatically by scanning recent session transcripts. Use when a discovery is too important to rely on catching later, or as the first step of a reflection pass."
---

# remember — Capture Knowledge

Two modes. Native Claude Code auto-memory is OFF in this account, so
neither mode relies on it — both write directly to this loop's own
memory file at `~/.claude/projects/-home-user-DreamTube/memory/MEMORY.md`.

## Mode 1: Explicit (`/si:remember <text>`, or asked directly)

Same as the stock skill: parse what/why/scope from the user's input,
check for a near-duplicate already in the file, then append one concise
line. No git commit needed for this file specifically — it's working
memory, not a project deliverable, so it isn't tracked by either repo's
git (nothing to commit for a memory-only append).

```markdown
- {{concise fact or pattern}}
```

If the file is over 180 lines, say so and suggest a `memory-review` pass.

## Mode 2: Automatic transcript scan (used by the reflection pass)

This is the substitute for native auto-memory's job — since nothing
captures corrections/preferences automatically here, this mode does it
on demand instead of relying on it happening silently in the background.

### Step 1: Find transcripts since the last capture

```bash
TRANSCRIPT_DIR="$HOME/.claude/projects/-home-user-DreamTube"
MEMORY_DIR="$TRANSCRIPT_DIR/memory"
mkdir -p "$MEMORY_DIR"
LAST_RUN_MARKER="$MEMORY_DIR/.last_capture_at"
# Transcripts modified since the marker (or all of them, first run ever)
if [ -f "$LAST_RUN_MARKER" ]; then
  find "$TRANSCRIPT_DIR" -maxdepth 1 -name '*.jsonl' -newer "$LAST_RUN_MARKER"
else
  find "$TRANSCRIPT_DIR" -maxdepth 1 -name '*.jsonl'
fi
```

### Step 2: Read and extract, don't transcribe

Read the transcript(s) found. You're looking for a narrow, high-signal
set of things — not a running summary of everything that happened:

- **Explicit corrections** — the founder said something was wrong, or
  redid a decision an agent made (e.g. "no, I don't want you to ask me
  every time", "relax the constraints", a rejected idea with a stated
  reason).
- **Stated preferences** — a rule the founder gave that should hold
  going forward (a weighting change, a tone/format preference, a
  standing instruction).
- **Recurring friction** — the same kind of mistake, question, or
  workaround showing up more than once across sessions.
- **Explicitly declared learnings** — anything the founder said to
  remember, or any place a subagent's own summary called out a
  correction it received.

Skip: routine task completion, one-off implementation detail with no
future relevance, anything already reflected in a skill file or
CLAUDE.md, anything you're not confident actually recurred or matters
beyond this one session.

### Step 3: Write concise entries

One line per finding, same format as Mode 1, appended to `MEMORY.md`.
Tag which of the six frozen skills (if any) each entry is *about* —
this is what lets `promote` route it correctly later:

```markdown
- [evaluation] Founder wants engineering effort weighted ~50% of normal RICE effort weighting, personal/founder time weighted normally — already partially reflected in evaluation.md's Priority Score, check product-manager-toolkit's rice_prioritizer.py stays consistent.
- [general] Founder dictates by voice often; garbled transcription is common — confirm ambiguous instructions rather than guessing silently.
```

Untagged entries (`[general]`) are candidates for CLAUDE.md/rules
instead of a specific skill.

### Step 4: Update the marker, report

```bash
touch "$MEMORY_DIR/.last_capture_at"
```

Report: how many transcripts scanned, how many entries added, current
`MEMORY.md` line count. This step never touches git — nothing here is
committed until `memory-review`/`promote` actually graduates something.

## What NOT to capture

- Anything that looks like a credential, token, or secret — never write
  these to a memory file, skip the entry entirely and don't quote the
  surrounding text either.
- Anything about `AGENT_POLICY.md` itself beyond noting neutrally that a
  correction happened near it — never draft proposed wording for that
  file here or anywhere in this loop.
