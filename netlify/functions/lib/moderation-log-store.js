// netlify/functions/lib/moderation-log-store.js
//
// Backing store for the MODERATION LOG (founder-approved 2026-08-14): when a
// generation is REFUSED by the content filter, the blocked prompt text is
// stored server-side so the founder can review what users are actually trying
// to generate (explicit/sensitive content). Before this, only the reason code
// reached PostHog — the blocked TEXT was captured nowhere. Read back via the
// owner-gated get-moderation-log.js / moderation-log-x7q4.html.
//
// DISTINCT from lib/moderation-store.js (the user-*reported*-content queue
// behind report-dream.js) — that store holds reports a real user filed about
// someone else's published dream; THIS store holds the prompt text OUR OWN
// content filter refused to generate. Different source, different shape,
// different lifecycle — a dedicated store, same "small single-purpose store"
// convention lib/moderation-store.js / lib/support-store.js already follow.
//
// SHAPE (mirrors the shape/retention discipline of lib/deploy-log-store.js —
// one pure-CREATE Netlify Blobs key per record, never a read-modify-write, so
// two concurrent content blocks each write their own distinct key with nothing
// to clobber and no CAS needed). Each record:
//   { ts (ISO), reason (e.g. 'E116' | 'content_policy_violation'),
//     promptText (the caption/dream text that was blocked),
//     mediaType ('video' | 'image'),
//     user (owner username or email if resolvable, else 'anonymous'/null),
//     source (properties.source if available, else null),
//     operationName (if available, else null) }
//
// KEY: `moderation-log/<zero-padded-epoch-millis>-<rand>`. The epoch-millis
// prefix is zero-padded to a fixed width so a plain lexicographic key sort ==
// chronological order (same "sortable key" trick that lets a list() answer
// "newest first" without reading every record's body first). The millis come
// from the record's own `ts` when present (so age-based pruning reflects when
// the block actually happened, not when this ran), else "now". A short random
// suffix guarantees uniqueness when two blocks land in the same millisecond.
// Epoch millis (not the ISO string) are used for the sort prefix deliberately:
// no ':' or other characters that could be awkward in a blob key.
//
// RETENTION (bounded — this deliberately stores explicit/sensitive user
// content, so it must never grow without limit): pruned best-effort on every
// append to keep at most ~500 records AND drop anything older than 30 days.
// Best-effort means a prune failure never affects the append that triggered it
// (and never affects the block response the user gets — see the capture hooks
// in generate-video.js / generate-image.js, each of which wraps append() in
// its own try/catch). A pure list()+delete() of over-cap / over-age keys, no
// read-modify-write of a shared blob, so it races safely the same way the
// write side does.
//
// Uses `@netlify/blobs` (the same client lib/deploy-log-store.js uses) — a
// plain append/list log needs no compare-and-swap primitive, unlike the
// once-ever send guards that reach for `blobs10` (see
// lib/unwatched-dream-nudge-store.js).

var { getStore, connectLambda } = require('@netlify/blobs');
var crypto = require('crypto');

var STORE_NAME = 'dreamtube-moderation-log';
var KEY_PREFIX = 'moderation-log/';

// Retention bounds — see this file's header comment.
var MAX_RECORDS = 500;
var MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Defensive cap on the stored prompt text — the caption is already bounded
// upstream, but this store must never persist an unbounded blob of raw user
// content regardless of caller (same "cap something reasonable" spirit as
// add-tracker-item.js's title/detail caps).
var MAX_PROMPT_TEXT_LENGTH = 8000;

// Fixed key-prefix width: current epoch millis is 13 digits and stays 13
// until well beyond year 5000, so padding to 15 keeps every key the same
// length -> lexicographic sort == numeric (chronological) sort.
var KEY_MILLIS_WIDTH = 15;

function store() {
  return getStore({ name: STORE_NAME });
}

function padMillis(millis) {
  var s = String(millis);
  while (s.length < KEY_MILLIS_WIDTH) s = '0' + s;
  return s;
}

/** The sortable, unique key a given (millis, rand) always maps to. Exported so tests can seed pre-existing (e.g. deliberately-old) records at a known key. */
function keyFor(millis, rand) {
  return KEY_PREFIX + padMillis(millis) + '-' + rand;
}

/** Extracts the epoch-millis embedded in a key's sort prefix (NaN-safe). */
function millisFromKey(key) {
  var body = key.slice(KEY_PREFIX.length);
  var dash = body.indexOf('-');
  var numeric = dash === -1 ? body : body.slice(0, dash);
  var millis = parseInt(numeric, 10);
  return isNaN(millis) ? 0 : millis;
}

/**
 * Normalizes a caller-supplied record into the exact stored shape — every
 * field defaulted so a partial/odd record from a best-effort capture hook can
 * never write a malformed blob. `ts` defaults to now; `promptText` is coerced
 * to a (capped) string; the rest default to null.
 */
function normalizeRecord(record, nowMillis) {
  record = record || {};
  var ts = typeof record.ts === 'string' && record.ts ? record.ts : new Date(nowMillis).toISOString();
  var promptText = record.promptText == null ? null : String(record.promptText);
  if (promptText != null && promptText.length > MAX_PROMPT_TEXT_LENGTH) {
    promptText = promptText.slice(0, MAX_PROMPT_TEXT_LENGTH);
  }
  return {
    ts: ts,
    reason: record.reason == null ? null : String(record.reason),
    promptText: promptText,
    mediaType: record.mediaType == null ? null : String(record.mediaType),
    user: record.user == null ? null : String(record.user),
    source: record.source == null ? null : String(record.source),
    operationName: record.operationName == null ? null : String(record.operationName)
  };
}

/**
 * Appends one moderation record (a blocked-generation attempt). Pure CREATE of
 * a single unique key — never a read-modify-write (see this file's header
 * comment). After the write, best-effort-prunes the store back within its
 * retention bounds; a prune failure is swallowed (logged only) so it can never
 * affect this append. The setJSON write itself can throw (the caller — a
 * best-effort capture hook — is expected to wrap this whole call in try/catch).
 * Returns the normalized record as stored.
 */
async function append(event, record) {
  var now = Date.now();
  var normalized = normalizeRecord(record, now);

  // Key millis come from the record's own ts when it's a real parseable time,
  // so age-based pruning reflects when the block happened, not when we ran.
  var keyMillis = Date.parse(normalized.ts);
  if (isNaN(keyMillis)) keyMillis = now;

  connectLambda(event);
  var key = keyFor(keyMillis, crypto.randomUUID().slice(0, 8));
  await store().setJSON(key, normalized);

  try {
    await prune(event, now);
  } catch (e) {
    console.error('moderation-log-store: best-effort prune failed (append itself still succeeded)', e);
  }

  return normalized;
}

/**
 * Deletes any records beyond the newest MAX_RECORDS, plus any older than
 * MAX_AGE_MS. LIST + per-key DELETE only — never a read-modify-write of a
 * shared blob — so it races safely against concurrent appends. Best-effort per
 * delete: a single failed delete is a harmless leftover a later prune re-checks.
 */
async function prune(event, nowMillis) {
  connectLambda(event);
  var listResult = await store().list({ prefix: KEY_PREFIX });
  var blobs = (listResult && listResult.blobs) || [];

  var entries = blobs.map(function (b) {
    return { key: b.key, millis: millisFromKey(b.key) };
  });
  // Newest first.
  entries.sort(function (a, b) { return b.millis - a.millis; });

  var cutoff = nowMillis - MAX_AGE_MS;
  var toDelete = [];
  for (var i = 0; i < entries.length; i++) {
    if (i >= MAX_RECORDS || entries[i].millis < cutoff) {
      toDelete.push(entries[i].key);
    }
  }

  for (var j = 0; j < toDelete.length; j++) {
    try {
      connectLambda(event);
      await store().delete(toDelete[j]);
    } catch (e) {
      console.error('moderation-log-store: failed to prune ' + toDelete[j] + ' -- a later prune will re-check it', e);
    }
  }
}

/**
 * Returns the most recent moderation records, NEWEST FIRST, up to `limit`
 * (default MAX_RECORDS). Sorts keys by their embedded millis (so ordering is
 * correct whether the backend lists lexicographically or in insertion order),
 * takes the newest `limit`, then reads only those record bodies.
 */
async function list(event, opts) {
  opts = opts || {};
  var limit = typeof opts.limit === 'number' && opts.limit > 0 ? Math.floor(opts.limit) : MAX_RECORDS;

  connectLambda(event);
  var listResult = await store().list({ prefix: KEY_PREFIX });
  var blobs = (listResult && listResult.blobs) || [];

  var entries = blobs.map(function (b) {
    return { key: b.key, millis: millisFromKey(b.key) };
  });
  entries.sort(function (a, b) { return b.millis - a.millis; }); // newest first
  var top = entries.slice(0, limit);

  var records = [];
  for (var i = 0; i < top.length; i++) {
    connectLambda(event);
    var rec = await store().get(top[i].key, { type: 'json' });
    if (rec) records.push(rec);
  }

  // Stable secondary sort by ts (the sort above is on the key prefix, which
  // is derived from ts — this just guarantees the returned array is ordered by
  // the field the reader actually sees, even if a record's ts was ever set
  // independently of its key).
  records.sort(function (a, b) {
    return new Date(b.ts || 0) - new Date(a.ts || 0);
  });

  return records;
}

module.exports = {
  STORE_NAME, KEY_PREFIX, MAX_RECORDS, MAX_AGE_MS, MAX_PROMPT_TEXT_LENGTH,
  keyFor, millisFromKey, normalizeRecord,
  append, list, prune
};
