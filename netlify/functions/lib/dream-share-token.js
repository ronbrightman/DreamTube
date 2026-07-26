// netlify/functions/lib/dream-share-token.js
//
// Single-use-to-mint, many-times-viewable share link for ONE already-real
// account's ALREADY-completed dream -- the missing piece the retention
// email (tracker.html's for-product-retention-email-send-user-th-eke9ra
// item) needs to link somewhere that actually renders for the recipient.
//
// WHY THIS EXISTS (the "one real open question" the tracker item flagged):
// explore.html?id=<dreamId> is this app's existing shareable-dream-link
// pattern (see explore.html's own getParam('id') handling), but it only
// ever scrolls to a card already present in DreamStore.getSharedFeed()'s
// result -- i.e. a dream that's been PUBLISHED to the shared feed
// (get-feed.js's "dreamtube-feed" Blobs store). A brand-new user's first
// completed dream is realistically still PRIVATE at the moment this email
// fires (result.html's own share flow requires publishing FIRST before it
// will even generate an explore.html link -- see that page's
// shareAfterPublish flow), and most users never publish at all. Gating
// this whole email on "only once published" would mean it almost never
// fires for the exact audience it exists to bring back -- so this file
// exists instead: a lightweight, account-scoped access token that lets
// get-shared-dream.js (and watch.html, the page it feeds) render this ONE
// specific dream for whoever holds the link, without requiring them to be
// logged in on that device, and without requiring the dream to ever touch
// the shared feed.
//
// Deliberately NOT the same mechanism as lib/pending-dream-token.js: that
// file authenticates a PENDING, pre-signup generation (no account exists
// yet, the token IS the only proof of ownership). This one is for an
// EXISTING account's OWN already-real dream -- there's a real account and
// a real (private, local-only) dream behind it already; this token is
// purely a viewing capability for people who don't have that account's
// session, not an identity/ownership proof. Same "generate random token,
// store in Blobs with a TTL, verify on read" shape as that file (and
// lib/magic-link.js before it) though, per this codebase's own established
// precedent for exactly this kind of link.
//
// Dreams have no independent server-side record at all when private (see
// js/store.js's header comment -- state.dreams is local-only unless
// published via publish-dream.js) -- so unlike pending-dream-token.js
// (which only stores an *id* and defers back to lib/pending-dreams.js's
// own record for the actual video/caption), this token record has to
// carry a full snapshot of what's needed to render the dream itself
// (caption/style/videoUrl/mediaType), supplied by the client at send time
// (see send-first-dream-email.js) -- there is nothing else to read it
// back from. This is the same "trust the client for CONTENT, never for
// IDENTITY" split publish-dream.js's own header comment already documents
// ("No ownership check... honest MVP scope, matches the rest of the app's
// documented no-real-backend-yet security model") -- the token is what's
// never client-forgeable (random 32-byte value, unguessable), not the
// dream data it points at.
//
// Backed by a single Netlify Blobs store ("dreamtube-dream-share-tokens"),
// one record per token: { dreamId, ownerHandle, caption, style, videoUrl,
// mediaType, createdAt, expiresAt }.

var { getStore, connectLambda } = require('@netlify/blobs');
var crypto = require('crypto');

var STORE_NAME = 'dreamtube-dream-share-tokens';
// Generous, not a security-sensitive short window -- this is the literal
// payoff of the retention email (the whole point is "come back and watch
// this whenever you see the email"), same reasoning and same 30-day
// figure lib/pending-dream-token.js already uses for its own emailed
// dream link.
var TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function store() {
  return getStore({ name: STORE_NAME });
}

/**
 * Generates + stores a single-use-to-mint (but freely re-viewable) share
 * token for `dream` ({ id, ownerHandle, caption, style, videoUrl,
 * mediaType }). Returns the raw token string.
 */
async function createToken(event, dream) {
  var token = crypto.randomBytes(32).toString('hex');
  connectLambda(event);
  await store().setJSON(token, {
    dreamId: dream.id,
    ownerHandle: dream.ownerHandle || null,
    caption: dream.caption || '',
    style: dream.style || null,
    videoUrl: dream.videoUrl || null,
    mediaType: dream.mediaType === 'image' ? 'image' : 'video',
    createdAt: Date.now(),
    expiresAt: Date.now() + TTL_MS
  });
  return token;
}

/** Builds the watch.html URL a share token resolves to, from the request's own Host header -- same `x-forwarded-host || host` pattern every other emailed-link function in this codebase uses (request-password-reset.js, lib/pending-dream-token.js). */
function buildUrl(event, dreamId, token) {
  var host = event.headers['x-forwarded-host'] || event.headers.host;
  return 'https://' + host + '/watch.html?id=' + encodeURIComponent(dreamId) + '&token=' + encodeURIComponent(token);
}

/**
 * Verifies a (dreamId, token) pair. Returns { ok:true, dream } or
 * { ok:false, error:'invalid_or_expired' }. Deliberately revisitable, like
 * lib/pending-dream-token.js's own claim link (`peek` defaults to true) --
 * someone opening the "your dream is ready" email again weeks later to
 * rewatch it should not find a dead link. The dreamId in the record must
 * match the one asked for (defense in depth, same shape as
 * lib/account-store.js's getByEmail mismatch check) -- a token is only
 * ever valid for the exact dream it was minted for.
 */
async function verifyToken(event, dreamId, token, peek) {
  if (!dreamId || !token) return { ok: false, error: 'invalid_or_expired' };
  connectLambda(event);
  var s = store();
  var record = await s.get(token, { type: 'json' });
  if (!record || record.expiresAt < Date.now() || record.dreamId !== dreamId) {
    if (record && peek === false) await s.delete(token);
    return { ok: false, error: 'invalid_or_expired' };
  }
  if (peek === false) await s.delete(token);
  return {
    ok: true,
    dream: {
      id: record.dreamId,
      ownerHandle: record.ownerHandle,
      caption: record.caption,
      style: record.style,
      videoUrl: record.videoUrl,
      mediaType: record.mediaType
    }
  };
}

module.exports = { STORE_NAME, TTL_MS, createToken, buildUrl, verifyToken };
