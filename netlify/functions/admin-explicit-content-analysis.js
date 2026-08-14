// netlify/functions/admin-explicit-content-analysis.js
//
// GET ?email=...[&days=14] -> aggregate moderation ANALYSIS over historical
// dream content (founder-requested 2026-08-14): "look for sexual content in
// ALL users because we only started to block it lately, so also do before
// that." Content blocking (the E116 gate in generate-video.js/
// generate-image.js) only started recently, so a block-event scan in PostHog
// misses every explicit attempt made BEFORE the gate existed. The dream TEXT
// the user actually wrote is not in PostHog at all (never sent — privacy) —
// it lives only in the durable dream stores. This endpoint reads that stored
// text server-side and classifies it, so the founder can see how much sexual
// content real users have created across the WHOLE history, not just since
// blocking began.
//
// WHAT IT READS: exactly the two real stores admin-media-library-data.js /
// admin-backfill-media-rehost.js sweep — lib/dream-store.js's
// "dreamtube-private-dreams" (every account's private dreams, keyed by
// username) and the shared "dreamtube-feed" (published dreams, keyed by
// ownerHandle). Same unpaginated full-store scan + same "fine at this app's
// current real scale" tradeoff those siblings already accept (see
// admin-media-library-data.js's own SCOPE/SCALE header note).
//
// HOW IT CLASSIFIES: each dream's human-written text (storyText || caption —
// the SAME fallback admin-media-library-data.js uses; promptText, the
// engineered generation prompt, is deliberately never read) is run through
// lib/content-classifier.js's OWN matchesExplicitKeyword — the exact
// keyword fast-path the live E116 gate uses to hard-block a generation. So
// "explicit" here means precisely "text the app now blocks", making the
// historical count directly comparable to what the gate does going forward.
// This is a KEYWORD scan, not the full LLM classifier: it is free and
// instant across hundreds of dreams (an LLM call per dream would be slow and
// costly and risk the function timeout), at the cost of under-counting
// euphemistic/cleverly-worded explicit text the LLM tier would still catch.
// It never OVER-counts: a keyword hit is the same signal that hard-blocks a
// real generation. Reported honestly as a floor, not an exact total.
//
// WHAT IT RETURNS: aggregates only — never the raw dream text. Per-user rows
// carry the owner username, their total dream count in-window, how many were
// explicit, and the first/last explicit timestamps. This deliberately keeps
// the response one step less sensitive than admin-media-library-data.js
// (which returns media URLs + the raw storyText and is therefore
// real-password-gated): because no raw explicit content leaves the server
// here, it is gated with the SAME owner-email bar as get-moderation-log.js /
// get-moderation-reports.js (normalizeEmail(OWNER_EMAIL) vs a client-supplied
// ?email=) rather than the heavier real-password check. The per-user username
// is needed so the founder (and an offline PostHog join) can attribute
// explicit-content creation back to the acquiring ad creative.
//
// Error codes (local, same small-number scheme as get-moderation-log.js):
//   E1 method_not_allowed  — verb other than GET
//   E2 missing_owner_email — OWNER_EMAIL not configured
//   E3 forbidden           — ?email= (normalized) didn't match OWNER_EMAIL

var { getStore, connectLambda } = require('@netlify/blobs');
var { normalizeEmail } = require('./lib/entitlements');
var dreamStore = require('./lib/dream-store');
var contentClassifier = require('./lib/content-classifier');

var FEED_STORE_NAME = 'dreamtube-feed';
var FEED_KEY = 'feed-index';

var DEFAULT_DAYS = 14;
var MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The human-written text of a dream — storyText, falling back to caption for a pre-split/feed record (identical fallback to admin-media-library-data.js; promptText is deliberately NOT read). */
function dreamText(record) {
  return record && (record.storyText || record.caption || '') || '';
}

/** Best createdAt for a record, mirroring admin-media-library-data.js's fallbacks: private prefers createdAt then updatedAt; feed prefers createdAt then publishedAt. Returns epoch millis or null. */
function recordMillis(record) {
  var v = record && (record.createdAt || record.updatedAt || record.publishedAt);
  if (v == null) return null;
  var n = typeof v === 'number' ? v : Date.parse(v);
  return isNaN(n) ? null : n;
}

/** Normalizes an owner identifier to the private-dream store's key convention (lowercase, no leading @) so a feed ownerHandle "@Name" and a private-store username "name" aggregate under one user. */
function normalizeUser(u) {
  return (typeof u === 'string' ? u : '').trim().replace(/^@/, '').toLowerCase();
}

/**
 * Accumulates one dream into the per-user map when it falls inside the window.
 * A record with no resolvable timestamp is still counted (its user is real and
 * the content exists) but contributes no first/last-explicit bound.
 */
function accumulate(perUser, user, record, cutoffMillis) {
  var millis = recordMillis(record);
  if (millis != null && millis < cutoffMillis) return; // outside window
  var key = normalizeUser(user);
  if (!key) return;
  var row = perUser[key];
  if (!row) {
    row = perUser[key] = { user: key, total: 0, explicit: 0, firstExplicitAt: null, lastExplicitAt: null };
  }
  row.total++;
  if (contentClassifier.matchesExplicitKeyword(dreamText(record))) {
    row.explicit++;
    if (millis != null) {
      if (row.firstExplicitAt == null || millis < row.firstExplicitAt) row.firstExplicitAt = millis;
      if (row.lastExplicitAt == null || millis > row.lastExplicitAt) row.lastExplicitAt = millis;
    }
  }
}

/** Scans every account's private dreams (same list()-based enumeration as admin-media-library-data.js's collectPrivateItems). */
async function scanPrivate(event, perUser, cutoffMillis) {
  connectLambda(event);
  var store = getStore({ name: dreamStore.STORE_NAME });
  var listResult = await store.list();
  var blobs = (listResult && listResult.blobs) || [];
  for (var i = 0; i < blobs.length; i++) {
    var username = blobs[i].key;
    var dreams = await dreamStore.getPrivateDreams(event, username);
    for (var d = 0; d < dreams.length; d++) {
      accumulate(perUser, username, dreams[d], cutoffMillis);
    }
  }
}

/** Scans the shared published feed (same single-read as admin-media-library-data.js's collectFeedItems). */
async function scanFeed(event, perUser, cutoffMillis) {
  connectLambda(event);
  var store = getStore({ name: FEED_STORE_NAME });
  var feed = (await store.get(FEED_KEY, { type: 'json' })) || [];
  for (var i = 0; i < feed.length; i++) {
    accumulate(perUser, feed[i] && feed[i].ownerHandle, feed[i], cutoffMillis);
  }
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'E1: method_not_allowed' }) };
  }

  var ownerEmail = normalizeEmail(process.env.OWNER_EMAIL);
  if (!ownerEmail) {
    return { statusCode: 500, body: JSON.stringify({ error: 'E2: missing_owner_email' }) };
  }

  var params = event.queryStringParameters || {};
  var queryEmail = normalizeEmail(params.email || '');
  if (!queryEmail || queryEmail !== ownerEmail) {
    return { statusCode: 403, body: JSON.stringify({ error: 'E3: forbidden' }) };
  }

  var days = parseInt(params.days, 10);
  if (!days || days <= 0) days = DEFAULT_DAYS;
  var cutoffMillis = Date.now() - days * MS_PER_DAY;

  var perUser = {};
  // Feed first (cheap single read), then the per-account private sweep.
  await scanFeed(event, perUser, cutoffMillis);
  await scanPrivate(event, perUser, cutoffMillis);

  var rows = Object.keys(perUser).map(function (k) { return perUser[k]; });
  // Explicit-first, then by total — the founder scans the worst offenders first.
  rows.sort(function (a, b) { return (b.explicit - a.explicit) || (b.total - a.total); });

  var totalDreams = 0, explicitDreams = 0, explicitUsers = 0;
  for (var i = 0; i < rows.length; i++) {
    totalDreams += rows[i].total;
    explicitDreams += rows[i].explicit;
    if (rows[i].explicit > 0) explicitUsers++;
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      windowDays: days,
      classifier: 'matchesExplicitKeyword (E116 keyword fast-path; keyword-only, a floor not an exact total)',
      totalUsers: rows.length,
      totalDreams: totalDreams,
      explicitDreams: explicitDreams,
      explicitUsers: explicitUsers,
      perUser: rows
    })
  };
};
