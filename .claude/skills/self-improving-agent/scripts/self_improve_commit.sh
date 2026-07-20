#!/usr/bin/env bash
# Hard technical guard + commit wrapper for the self-improving-agent loop.
#
# This is the ONLY sanctioned way the self-improving-agent skill (or
# anything spawned by it) commits a change. It is not a suggestion the
# model can talk itself out of — it is a real, code-level check that
# refuses to run if AGENT_POLICY.md is anywhere in the change, no matter
# what the calling prompt says.
#
# Usage:
#   self_improve_commit.sh <repo-dir> <commit-message> <file1> [file2 ...]
#
# - <repo-dir>: absolute path to the git repo to commit in (this project
#   uses two: /home/user/DreamTube for project-level skills/CLAUDE.md/
#   rules, and /workspace/agent-library for the portable research/
#   evaluation/design/marketing skills).
# - <commit-message>: one short line. Gets a standard trailer appended
#   so these commits are easy to find/filter in `git log` later.
# - <file...>: exact paths (relative to repo-dir) to stage. Never stages
#   anything else — no `git add -A`, no globbing beyond what's listed.
#
# Exit codes: 0 = committed. 1 = blocked (forbidden file). 2 = usage/other error.

set -euo pipefail

if [ "$#" -lt 3 ]; then
  echo "Usage: $0 <repo-dir> <commit-message> <file1> [file2 ...]" >&2
  exit 2
fi

REPO_DIR="$1"; shift
COMMIT_MSG="$1"; shift
FILES=("$@")

# ---- Hard exclusion: AGENT_POLICY.md, anywhere, any case, any path ----
# Checked against the literal file list this script was asked to stage —
# not against "does the diff look risky", not against a prompt's own
# judgment. A case-insensitive basename match, so AGENT_POLICY.md,
# agent_policy.md, path/to/AGENT_POLICY.md etc. are all caught.
for f in "${FILES[@]}"; do
  base=$(basename "$f")
  lower=$(echo "$base" | tr '[:upper:]' '[:lower:]')
  if [ "$lower" = "agent_policy.md" ]; then
    echo "BLOCKED: self-improving-agent may never write to AGENT_POLICY.md ($f)." >&2
    echo "This file only changes when the founder explicitly asks for a change." >&2
    exit 1
  fi
done

cd "$REPO_DIR"

# Belt-and-braces: also refuse if AGENT_POLICY.md shows up as a
# currently-modified/staged file in this repo at all, even if it wasn't
# passed explicitly — covers a caller that staged it another way before
# invoking this script.
if git status --porcelain -- AGENT_POLICY.md 2>/dev/null | grep -q .; then
  echo "BLOCKED: AGENT_POLICY.md has pending changes in $REPO_DIR — refusing to commit anything until that's resolved outside this script." >&2
  exit 1
fi

git add -- "${FILES[@]}"

# Re-check what actually got staged, not just what we were told to
# stage — catches a symlink or a path that resolves somewhere unexpected.
if git diff --cached --name-only | grep -qi 'agent_policy\.md$'; then
  echo "BLOCKED: staged changes include AGENT_POLICY.md after add — aborting, unstaging." >&2
  git reset -- AGENT_POLICY.md >/dev/null 2>&1 || true
  exit 1
fi

if git diff --cached --quiet; then
  echo "Nothing to commit (no actual changes in: ${FILES[*]})."
  exit 0
fi

git commit -m "${COMMIT_MSG}

self-improving-agent: automated skill-learning commit" >/dev/null

echo "Committed in $REPO_DIR: $(git log -1 --oneline)"
