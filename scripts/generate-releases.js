#!/usr/bin/env node
// scripts/generate-releases.js — (re)generates RELEASES.md from git history.
//
// Tracker item for-product-release-visibility-founder-a-8hx5cz, part 2:
// "RELEASES.md auto-appended per merge to main (timestamp, sha, one-line
// summary) via the existing build step — no gates, no ceremony."
//
// HONEST TRADEOFF, READ BEFORE CHANGING HOW THIS RUNS:
// This is deliberately NOT wired into Netlify's build (generate-version.js
// is). Netlify's build environment has no credentials to push a commit
// back to this repo (no GITHUB_TOKEN or equivalent configured, and adding
// one would be a new credential — an auth-sensitive change this task's
// own scope explicitly excludes and AGENT_POLICY.md gates behind human
// approval). A build step that silently tries and fails to persist
// RELEASES.md would look automated while never actually working in
// production — exactly what this task asked NOT to build. This repo also
// has no CI (no .github/workflows, no git hooks, no husky — checked
// before writing this) to hang a "runs after merge" step off of.
//
// So instead this is a REGENERATE-ON-DEMAND script: it doesn't append,
// it rebuilds RELEASES.md from scratch from `git log` every time it's
// run, so it's always consistent with actual history no matter how long
// it's been since it was last run (append-only would drift/duplicate if
// ever skipped). Run it:
//   - manually: `npm run release-notes`
//   - or periodically by whoever is driving merges to main (a human, or
//     the orchestrating session per AGENT_POLICY.md's merge step) —
//     cheap enough to run after any batch of merges.
// This is the most honest option of the three the task laid out: it
// never claims to be "automatic" when nothing would actually trigger it
// in Netlify's real, credential-less build sandbox.
//
// WHAT COUNTS AS "one line per merge" HERE — this repo's actual git
// history (checked via `git log main --merges` before writing this) does
// NOT use GitHub-style "Merge pull request #N" commits on main; branches
// merge `origin/main` INTO themselves to stay current, and land on main
// via fast-forward, so nearly every commit reachable from main already
// represents one landed change (deploy-triggering, since this repo
// deploys on every push to main). Trying to detect "true" merge commits
// specifically would under-count real releases. So this script lists one
// line per commit on main — each one is a real deploy in this repo's
// actual workflow — rather than a synthetic merge-commit filter that
// doesn't match how merges actually happen here.

var fs = require('fs');
var path = require('path');
var { execSync } = require('child_process');

var REPO_ROOT = path.join(__dirname, '..');
var OUT_PATH = path.join(REPO_ROOT, 'RELEASES.md');
var SEP = '\x1f'; // unit separator, won't collide with commit message text
var LINE_SEP = '\x1e';

function run(cmd) {
  return execSync(cmd, { cwd: REPO_ROOT, encoding: 'utf8' });
}

function main() {
  var format = ['%H', '%cI', '%s'].join(SEP);
  var raw;
  try {
    raw = run('git log main --pretty=format:"' + format + LINE_SEP + '"');
  } catch (err) {
    console.error('[generate-releases] Could not read git log for main: ' + err.message);
    process.exitCode = 1;
    return;
  }

  var entries = raw.split(LINE_SEP).map(function (chunk) {
    return chunk.replace(/^\n/, '').trim();
  }).filter(Boolean);

  var lines = [
    '# Releases',
    '',
    '_Regenerated from `git log main` — do not hand-edit, run `npm run release-notes`',
    'instead (see scripts/generate-releases.js for why this is regenerate-on-demand',
    'rather than auto-appended at build time). One line per commit on main; this',
    'repo deploys on every push to main, so each line below is a real deploy._',
    ''
  ];

  entries.forEach(function (entry) {
    var parts = entry.split(SEP);
    if (parts.length < 3) return;
    var sha = parts[0];
    var date = parts[1];
    var subject = parts.slice(2).join(SEP);
    lines.push('- `' + sha.slice(0, 7) + '` ' + date + ' — ' + subject);
  });

  fs.writeFileSync(OUT_PATH, lines.join('\n') + '\n');
  console.log('[generate-releases] wrote ' + OUT_PATH + ' (' + entries.length + ' entries)');
}

main();
