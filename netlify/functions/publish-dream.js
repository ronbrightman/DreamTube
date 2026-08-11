// netlify/functions/publish-dream.js
//
// POST { id, ownerHandle, caption, style, dur, videoUrl, imageUrl, mediaType,
//        avatar, channelLicenseGrantedAt, channelLicenseRevokedAt,
//        okToFeatureOnChannels, mood, authToken }
// (`mood` is new as of tracker item for-product-founder-08-04-evening-
// music--jfjco0 — the dream-builder wizard's Mood step answer, carried into
// the shared record purely so explore.html can pick a mood-keyed ambient
// music bed for the card (js/music-bed.js's urlForDream). Optional and
// non-load-bearing: absent/unknown stores as null, and null simply means
// that card falls back to its visual-style bed exactly as every card does
// today. Validated against a fixed key list below rather than stored
// verbatim — this value is written into a world-readable shared blob and
// then read straight back out into an asset path, so an unbounded string
// has no business in it.)
// (musicBedOn removed from this payload/record shape as of tracker item
// for-product-build-founder-approved-08-03-jlkjy9's 2026-08-03 founder
// simplification — "no user choice," music is always on. js/music-bed.js's
// eligible() computes bed eligibility purely from a dream's own
// videoUrl/style, so the field no longer means anything and is no longer
// read or written here.)
// -> upserts a dream into the shared feed-index blob (see get-feed.js).
// Called both when a dream is first published, and again if an
// already-published dream is later edited/regenerated (store.js's
// finalizeDream re-syncs so the shared copy doesn't go stale) — same
// upsert either way, keyed on id.
//
// videoUrl/imageUrl/mediaType (added for the image-generation feature — see
// docs/IMAGE_GENERATION_SPEC.md): a dream needs EITHER a videoUrl or an
// imageUrl to publish, not both — the old `!videoUrl` requirement below
// used to hard-block an image-type dream from ever reaching the shared
// feed at all (silently, since js/store.js's syncPublishedDreamToFeed is
// fire-and-forget). mediaType is passed through mostly for forward
// compatibility/debugging — get-feed.js's own consumers (explore.html/
// profile.html) render off videoUrl/imageUrl presence directly, the same
// three-way fallback pattern used everywhere else in this codebase, not
// off this field.
//
// channelLicenseGrantedAt/channelLicenseRevokedAt/okToFeatureOnChannels
// (tracker item for-product-terms-republish-license-per--fhpcxk): the
// republish-license consent state for terms.html's "Your content" clause,
// carried into this SHARED record — not just js/store.js's local copy —
// since a real, cross-device future auto-posting engine (NOT built here)
// could only ever read curation eligibility from here. `channelLicenseGrantedAt`
// null/absent means this dream was published before the clause shipped and
// has no license at all yet (deliberately never backfilled — see
// js/store.js's publishDream comment); `channelLicenseRevokedAt` is the
// same "concrete state a later 'remove existing social posts on request'
// pass would read" js/store.js's unpublishDream/deleteDream comments
// describe; `okToFeatureOnChannels` defaults true (on) when omitted,
// matching the zero-click default-on opt-out toggle.
//
// SECURITY (fixed after review — tracker item
// publish-dream-js-trusts-client-supplied--lkppcu): this file used to
// upsert a shared feed record straight from a bare client-supplied
// `ownerHandle`, with no identity check at all. That was honest MVP scope
// while the shared record only carried display fields (caption/style
// forgery here is just vandalism, and a dream's public `id` already has no
// real secrecy — anyone can see it via Explore). It stopped being honest
// scope the moment channelLicenseGrantedAt/channelLicenseRevokedAt/
// okToFeatureOnChannels started carrying real legal consent state: since
// `id` is public, anyone could forge a raw POST here and silently flip a
// real owner's republish-license consent, with nothing server-side to
// notice or stop it.
//
// createdAt (tracker item for-product-media-library-stamp-durable--u4oju3):
// until this fix the shared feed record carried no createdAt at all, only
// publishedAt — the owner media-library page (admin-media-library-data.js)
// had to approximate "when was this made" with publishedAt, which can be
// well after the dream was actually generated if it sat unpublished for a
// while. Now stamped durably at the moment a record is FIRST created in
// this feed (idx === -1): prefers the client's own real generation-time
// dream.createdAt (js/store.js's syncPublishedDreamToFeed) when it sends
// one, falling back to Date.now() only when it doesn't (an older client, or
// a dream that predates the createdAt field client-side) — the same
// "Date.now() at record-creation-time" fallback publishedAt already uses,
// so this is never a regression from today's behavior, only ever an
// improvement when a real value is available. On every SUBSEQUENT
// republish/edit of the SAME id (idx !== -1) the value is preserved
// immutably, exactly like publishedAt already is — a dream's "when was it
// actually made" must never move just because its caption/style changed —
// with one deliberate exception: a record that predates this fix and has
// no createdAt of its own yet opportunistically backfills from whatever the
// client sends THIS time (a real, cheap, safe backfill — the owning
// account's own client is the one place that still has the true value),
// falling back further to that record's own publishedAt (preserving
// exactly what admin-media-library-data.js already approximated before
// this fix) if the client doesn't send one either.
//
// avatar (tracker item for-product-ui-founder-directed-2026-07--djgjn0):
// a small avatar thumbnail (see js/store.js's syncPublishedDreamToFeed —
// resized client-side to a low-quality, ~48px JPEG data URL, "few KB" per
// that item) carried alongside the rest of the record so OTHER visitors'
// devices have something real to render for Explore's feed-user-row
// circle, not just the always-empty div this fixes. This is the one field
// on this endpoint that's genuinely attacker-controllable free-form data
// (everything else is short strings/URLs/booleans) — validated the same
// rigor as this file's other hardening (see validateAvatar below): must be
// a real small image data URL or absent, never trusted blindly. Rejected
// (E7) rather than silently dropped, matching this file's existing
// reject-don't-silently-degrade posture for a request that fails its own
// stated shape (see E3/E6) — a legitimate client (js/store.js) never sends
// anything else, so this only ever fires against a forged/malformed
// request.
//
// Fixed the same way block-user.js was (lib/account-auth-token.js's
// verifyToken — see that file's own header comment for why this
// mechanism, and not a wider auth rewrite, is the right scope here): a
// verified `authToken` is now required, and the token's own verified
// username is treated as the one true identity for this request.
//
// DESIGN CHOICE — reject-on-mismatch, not silent-overwrite: the client
// still sends `ownerHandle` (unchanged payload shape, so js/store.js keeps
// its existing upsert-by-id call shape), but this handler now REQUIRES it
// to match the verified token's username and REJECTS (E6) the whole
// request if it doesn't, rather than silently substituting the verified
// username and proceeding. The alternative (always trust the token's
// username, ignore the client's ownerHandle field entirely) was
// deliberately not taken: js/store.js's backfillSharedFeed loops over
// EVERY dream in state.dreams, which is one array shared across every
// account that has ever signed into a given browser (see CLAUDE.md) —
// it's shaped to sync each dream under ITS OWN recorded ownerHandle, not
// whoever happens to be signed in when the backfill runs. Silently
// substituting the token's username there would misattribute a different,
// previously-used account's already-published dream to whoever is
// currently signed in, in the SHARED public feed. Rejecting the mismatch
// instead means that one narrow backfill case just honestly fails to sync
// (that dream was already published under its real owner's own session at
// some point, which is the path that actually matters) rather than
// corrupting a record's ownership — same "honest degrade, never a silent
// wrong answer" posture the rest of this file's fire-and-forget callers
// already rely on.
//
// Error codes (local to this function, same small-number-scheme reasoning
// as block-user.js/admin-paywall-toggle.js):
//   E1 method_not_allowed       — verb other than POST
//   E2 invalid_json             — POST body wasn't valid JSON
//   E3 missing_fields           — id/ownerHandle/caption/style, or neither
//                                   videoUrl nor imageUrl, present
//   E4 auth_token_required      — `authToken` missing/blank
//   E5 invalid_or_expired_token — authToken didn't verify (unknown,
//                                   expired, or never issued) — same "200,
//                                   ok:false, business outcome" shape
//                                   block-user.js's own E6 uses, not a
//                                   4xx/5xx (mirrors that file's reasoning:
//                                   a stale/expired token on an otherwise
//                                   fire-and-forget sync is an expected,
//                                   routine outcome for js/store.js to
//                                   quietly swallow, not a client bug)
//   E6 owner_mismatch           — the verified token's username doesn't
//                                   match the request's own claimed
//                                   ownerHandle — the actual forged-request
//                                   case this fix closes. A real 4xx, not
//                                   the E5 "business as usual" shape —
//                                   this is a rejected identity claim, not
//                                   a routine expired-token retry.
//   E7 invalid_avatar           — `avatar` present but not a small,
//                                   correctly-typed image data URL (wrong
//                                   type, malformed, or over
//                                   AVATAR_MAX_BYTES decoded size)
//   E9 content_policy_blocked   — OUTPUT-SIDE defense-in-depth (founder-
//                                   directed 2026-08-08, lib/content-classifier.js):
//                                   before a dream reaches the world-readable
//                                   shared feed, its caption is re-classified and
//                                   an EXPLICIT result blocks the publish, so
//                                   nothing borderline the model DID produce can
//                                   leak outward to other users. Explicit-only —
//                                   the romantic allowance and the named-person
//                                   NCII threshold are generation-time concerns;
//                                   this is purely a public-leak backstop. Same
//                                   200/ok:false "routine business outcome" shape
//                                   as E5/E8 (js/store.js's syncPublishedDreamToFeed
//                                   is fire-and-forget): the dream stays published
//                                   in the owner's own private/local view, it just
//                                   never reaches the shared cross-account feed.
//                                   FAILS OPEN on a classifier error/timeout — a
//                                   classifier outage must not block every publish;
//                                   the generation-time gate is the primary defense.
//                                   Private dreams are never touched by this — only
//                                   this outward-facing publish path calls it.
//   E8 email_not_verified       — the verified token's own account has
//                                   `emailVerified === false` (tracker item
//                                   for-product-build-passwordless-signup-
//                                   fo-at2fko's gate list — see
//                                   lib/account-store.js's own GATE LIST
//                                   header comment for the full "why
//                                   publish specifically"). Same 200/
//                                   ok:false "business outcome" shape as E5
//                                   — js/store.js's syncPublishedDreamToFeed
//                                   call site is fire-and-forget today (see
//                                   that function's own doc comment), so
//                                   this degrades exactly like every other
//                                   failure mode there: the dream stays
//                                   published in the account's own local/
//                                   private view, it just doesn't reach the
//                                   shared cross-account feed yet.

var { connectLambda, getStore } = require('@netlify/blobs');
var accountAuthToken = require('./lib/account-auth-token');
var accountStore = require('./lib/account-store');
var contentClassifier = require('./lib/content-classifier');

function stripAt(handle) {
  var s = (typeof handle === 'string' ? handle : '').trim();
  return s.charAt(0) === '@' ? s.slice(1) : s;
}

// Generous cap given js/store.js's own thumbnail target of ~1-3KB at
// 48px/0.55-quality JPEG (see syncPublishedDreamToFeed) -- 20KB decoded
// leaves real headroom for a legitimate client without letting a forged
// request smuggle a full-size photo into the shared feed-index blob that
// every visitor's device downloads whole (see get-feed.js).
// The six real mood keys the dream-builder wizard can produce
// (js/wizard-chips.js's MOOD_CHIPS, minus 'other' — that chip is free text
// and has no fixed music bed). Kept in lockstep with js/music-bed.js's own
// MOOD_KEYS; test/mood-music-bed-behavioral.test.js asserts all three lists
// still agree, so they can't silently drift apart.
var KNOWN_MOODS = ['peaceful', 'joyful', 'dreamy', 'mysterious', 'tense', 'epic'];

var AVATAR_MAX_BYTES = 20 * 1024;
var AVATAR_DATA_URL_RE = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/;

/**
 * Validates an `avatar` payload field. Returns { ok:true, value } — value
 * is the original data URL string, or null if the field was omitted/empty
 * (a dream published with no Me photo set, or before this feature shipped
 * — see explore.html's avatarFallback-driven rendering for how that's
 * handled) — or { ok:false } if `avatar` was present but isn't a small,
 * correctly-typed image data URL.
 */
function validateAvatar(avatar) {
  if (avatar === undefined || avatar === null || avatar === '') return { ok: true, value: null };
  if (typeof avatar !== 'string') return { ok: false };
  var match = AVATAR_DATA_URL_RE.exec(avatar);
  if (!match) return { ok: false };
  var approxBytes = Math.floor(match[2].length * 3 / 4);
  if (approxBytes > AVATAR_MAX_BYTES) return { ok: false };
  return { ok: true, value: avatar };
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'E1: method_not_allowed' }) };
  }

  var payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E2: invalid_json' }) };
  }

  var id = payload.id;
  var ownerHandle = payload.ownerHandle;
  var caption = payload.caption;
  var style = payload.style;
  var dur = payload.dur;
  var videoUrl = payload.videoUrl || null;
  var imageUrl = payload.imageUrl || null;
  var mediaType = payload.mediaType === 'image' ? 'image' : 'video';
  // See this file's header comment — null/absent means "not licensed,
  // published before the clause shipped," not a value to paper over with
  // a default. okToFeatureOnChannels DOES default true/on (unset === on).
  var channelLicenseGrantedAt = payload.channelLicenseGrantedAt || null;
  var channelLicenseRevokedAt = payload.channelLicenseRevokedAt || null;
  var okToFeatureOnChannels = payload.okToFeatureOnChannels !== false;
  // See this file's header comment. Fails closed to null for anything not
  // in this exact list — a free-text "+ Something else" mood, a future key
  // this deploy doesn't know, or any other value a caller might send.
  var mood = KNOWN_MOODS.indexOf(payload.mood) === -1 ? null : payload.mood;
  var authToken = (payload.authToken || '').trim();
  // See this file's header comment ("createdAt" paragraph). Only a real
  // finite number is trusted — anything else (missing, a string, NaN) is
  // treated as "the client didn't send one," never stored as a bad value.
  var clientCreatedAt = (typeof payload.createdAt === 'number' && isFinite(payload.createdAt)) ? payload.createdAt : null;

  if (!id || !ownerHandle || !caption || !style || (!videoUrl && !imageUrl)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E3: missing_fields' }) };
  }
  if (!authToken) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E4: auth_token_required' }) };
  }

  var avatarCheck = validateAvatar(payload.avatar);
  if (!avatarCheck.ok) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E7: invalid_avatar' }) };
  }
  var avatar = avatarCheck.value;

  var auth = await accountAuthToken.verifyToken(event, authToken);
  if (!auth.ok) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'E5: invalid_or_expired_token' }) };
  }

  // See this file's own "DESIGN CHOICE — reject-on-mismatch" header
  // comment for why this rejects rather than silently substituting
  // auth.username here.
  if (stripAt(ownerHandle).toLowerCase() !== auth.username.toLowerCase()) {
    return { statusCode: 403, body: JSON.stringify({ error: 'E6: owner_mismatch' }) };
  }

  // Gate list, item 2 — see this file's own E8 doc comment above and
  // account-store.js's GATE LIST header comment. `=== false` specifically,
  // never `!record.emailVerified` — an account this field predates, or
  // whose record somehow can't be read, must never be blocked from
  // publishing over it (under-gate, never over-gate).
  var account = await accountStore.getByUsername(event, auth.username);
  if (account && account.emailVerified === false) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'E8: email_not_verified' }) };
  }

  // E9 — output-side explicit re-check (see this file's own E9 doc comment
  // and lib/content-classifier.js). Re-classifies the caption before it
  // reaches the world-readable shared feed; an explicit result blocks the
  // publish so borderline content the model did manage to produce can't leak
  // outward. Fails OPEN on a classifier error (the generation-time gate is
  // the primary defense). Uses the existing FAL_KEY, same as every other
  // classifier call — absent key simply fails open here. Same 200/ok:false
  // fire-and-forget-friendly shape as E5/E8.
  var recheck = await contentClassifier.evaluateExplicitRecheck({ text: caption, falKey: process.env.FAL_KEY });
  if (!recheck.allowed) {
    console.log('publish-dream: content_recheck_blocked reason=' + recheck.reason + ' id=' + id);
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'E9: content_policy_blocked: ' + recheck.message }) };
  }

  try {
    connectLambda(event);
    var store = getStore('dreamtube-feed');
    var feed = (await store.get('feed-index', { type: 'json' })) || [];
    var idx = feed.findIndex(function (d) { return d.id === id; });

    var record = {
      id: id, ownerHandle: ownerHandle, caption: caption, style: style, dur: dur,
      videoUrl: videoUrl, imageUrl: imageUrl, mediaType: mediaType,
      avatar: avatar,
      likes: idx === -1 ? 0 : (feed[idx].likes || 0),
      publishedAt: idx === -1 ? Date.now() : feed[idx].publishedAt,
      // See this file's header comment ("createdAt" paragraph) for the full
      // "stamp at first-create, preserve immutably after, opportunistically
      // backfill a pre-fix record" reasoning.
      createdAt: idx === -1
        ? (clientCreatedAt || Date.now())
        : (feed[idx].createdAt || clientCreatedAt || feed[idx].publishedAt || Date.now()),
      channelLicenseGrantedAt: channelLicenseGrantedAt,
      channelLicenseRevokedAt: channelLicenseRevokedAt,
      okToFeatureOnChannels: okToFeatureOnChannels,
      mood: mood
    };

    if (idx === -1) feed.unshift(record); else feed[idx] = record;
    await store.setJSON('feed-index', feed);

    return { statusCode: 200, body: JSON.stringify({ ok: true, dream: record }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'publish_failed: ' + (e && e.message) }) };
  }
};
