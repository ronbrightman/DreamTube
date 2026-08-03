// netlify/functions/lib/postpack-caption.js
//
// Pure caption/hashtag builder for the Instagram/TikTok "post pack" MVP
// (tracker item for-product-instagram-tiktok-auto-postin-cahr76). No I/O,
// no randomness — a deterministic function of one feed record, so it's
// trivially unit-testable and so re-running the assembly job never
// produces a different caption for the same dream.
//
// CAPTION shape: the dream's own text (a published feed record's
// `caption` field IS its storyText — see admin-media-library-data.js's own
// header comment: "A FEED (published) record never carries a separate
// storyText field to begin with ... its `caption` already equals its
// storyText per finalizeDream's own guarantee"), then its style, then an
// @-credit to the publishing user's handle, per this feature's own spec
// line ("a ready-to-post caption built from the dream's own excerpt/
// storyText + its style + an @-credit to the publishing user's handle").
// Deliberately NOT using `promptText` (the engineered generation prompt) —
// same "never surface the engineered prompt as if it were what the user
// wrote" rule admin-media-library-data.js's own storyText fallback
// already documents; a feed record doesn't carry promptText on the wire at
// all (see publish-dream.js's own payload shape), so there's nothing to
// mistakenly reach for here anyway.
//
// HASHTAGS: a small, sensible, per-style tag list (NOT ML-driven, per this
// feature's own explicit "nothing fancy" constraint) plus a short set of
// generic app/brand tags, deduped, in a stable order. Four style keys
// mirror this app's own STYLE_GRADIENTS in js/store.js (Cartoon/Cinematic/
// Anime/Realistic) — the only styles this app currently generates dreams
// in; an unrecognized/missing style (a legacy record, or a future style
// this list hasn't been updated for yet) falls back to the generic set
// alone rather than guessing or throwing.

var GENERIC_HASHTAGS = ['#DreamTube', '#AIDreams', '#DreamJournal', '#AIVideo'];

var STYLE_HASHTAGS = {
  Cartoon: ['#CartoonDreams', '#AnimatedDream', '#DreamAnimation'],
  Cinematic: ['#CinematicDream', '#DreamCore', '#FilmicAI'],
  Anime: ['#AnimeDream', '#AnimeAI', '#DreamAnime'],
  Realistic: ['#RealisticAI', '#HyperrealDream', '#AIRealism']
};

// Generous but bounded — a sensible v1 hashtag set per this feature's spec
// ("nothing fancy or ML-driven"), not a real content-strategy ceiling.
var MAX_HASHTAGS = 8;

function stripAt(handle) {
  var s = (typeof handle === 'string' ? handle : '').trim();
  return s.charAt(0) === '@' ? s.slice(1) : s;
}

/**
 * Builds the ready-to-post caption text for one published feed record.
 * Returns a plain multi-line string (no markdown/HTML — a caption box a
 * human copies verbatim into Instagram/TikTok's own composer).
 */
function buildCaption(record) {
  var text = (record && typeof record.caption === 'string' ? record.caption.trim() : '') || 'A dream, brought to life.';
  var style = (record && record.style) || null;
  var handle = stripAt(record && record.ownerHandle);

  var lines = [text];
  var meta = style ? style + ' dream, made with DreamTube' : 'Made with DreamTube';
  lines.push('');
  lines.push(meta);
  if (handle) lines.push('🎥 by @' + handle);
  return lines.join('\n');
}

/**
 * Builds the suggested hashtag set for one dream's style. Returns an
 * array of '#Tag' strings, generic tags first then style-specific ones,
 * deduped, capped at MAX_HASHTAGS.
 */
function buildHashtags(style) {
  var styleTags = STYLE_HASHTAGS[style] || [];
  var combined = GENERIC_HASHTAGS.concat(styleTags);
  var seen = {};
  var out = [];
  for (var i = 0; i < combined.length && out.length < MAX_HASHTAGS; i++) {
    var tag = combined[i];
    if (seen[tag]) continue;
    seen[tag] = true;
    out.push(tag);
  }
  return out;
}

module.exports = {
  GENERIC_HASHTAGS: GENERIC_HASHTAGS,
  STYLE_HASHTAGS: STYLE_HASHTAGS,
  buildCaption: buildCaption,
  buildHashtags: buildHashtags
};
