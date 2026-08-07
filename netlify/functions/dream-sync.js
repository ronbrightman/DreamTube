// netlify/functions/dream-sync.js
//
// GET  ?authToken=...                                       -> { ok:true, dreams:[...] } | { ok:false, error }
// POST { authToken, action:'upsert', dream }                -> { ok:true }              | { ok:false, error }
// POST { authToken, action:'delete', dreamId }               -> { ok:true }              | { ok:false, error }
//
// The server-side half of tracker item
// for-product-build-p0-server-side-dream-p-zl3rb2 (server-side private
// dream persistence) — see lib/dream-store.js's own header comment for the
// full storage design/reasoning and why PUBLISHED dreams are deliberately
// out of scope here (their durable copy already lives in the shared
// feed-index instead).
//
// SECURITY: same identity-binding bar as block-user.js (see
// lib/account-auth-token.js's own header comment — dream-sync.js is that
// module's second consumer) — the acting account is resolved from a
// VERIFIED authToken (lib/account-auth-token.js, minted only at a real
// server-side login/signup success), never from a bare client-supplied
// username.
// A private dream store is at LEAST as sensitive as a blocklist: unlike
// save-push-subscription.js's bare-username trust (whose worst case is
// only a misdirected push notification), a bare username here would let
// anyone who knows/guesses a victim's account username read their private
// (never-published, by definition not meant for anyone else) dream
// content, or overwrite/delete it. `username`/`ownerHandle` are never
// accepted as trusted input — GET/POST both derive the acting account
// 100% from authToken server-side.
//
// FIELD WHITELIST on POST upsert: only the fields js/store.js's own dream
// object shape actually needs to survive a round trip are read off the
// client-supplied `dream` — anything else the client sends is silently
// dropped. `ownerHandle` is resolved server-side (see resolveOwnerHandle
// below) so it can only ever be the verified account's OWN handle (its
// display casing is allowed to survive the round trip, but a different
// account's handle can never be claimed) — one account can never plant a
// dream that claims to belong to another account's handle in its own
// private-dream record. `isPublished` is likewise never trusted from the
// client and is always stored as `false` — this store exists ONLY for
// private dreams (see header comment above); a client that wants a dream
// removed here because it just got published calls the `delete` action
// instead (see js/store.js's publishDream).
//
// Error codes (local to this function, same small-number-scheme reasoning
// as block-user.js/admin-paywall-toggle.js):
//   E1 method_not_allowed       — verb other than GET/POST
//   E2 invalid_json             — POST body wasn't valid JSON
//   E3 auth_token_required      — `authToken` missing/blank (GET query
//                                   param or POST body field)
//   E4 invalid_or_expired_token — authToken didn't verify (unknown,
//                                   expired, or never issued) — same "200,
//                                   ok:false, treat as a normal business
//                                   outcome" shape this codebase already
//                                   uses for token verification elsewhere
//                                   (get-shared-dream.js/
//                                   verify-session-transfer.js), not a
//                                   4xx/5xx
//   E5 invalid_action           — POST `action` isn't "upsert" or "delete"
//   E6 dream_required           — action:"upsert" with no dream object (or
//                                   one missing a string `id`)
//   E7 dream_id_required        — action:"delete" with no `dreamId`
//   E8 sync_write_failed        — the underlying Blobs write genuinely
//                                   failed (every lib/blobs-retry.js
//                                   attempt's verify failed) — a real,
//                                   if rare, 500; the client's own local
//                                   state is completely unaffected either
//                                   way (see js/store.js's fire-and-forget
//                                   call sites, which never surface this
//                                   to the user)

var accountAuthToken = require('./lib/account-auth-token');
var dreamStore = require('./lib/dream-store');

// Every field this endpoint will persist off a client-supplied `dream` on
// upsert — see header comment's FIELD WHITELIST paragraph. Deliberately
// mirrors js/store.js's own dream object shape (see that file's
// finalizeDream/saveClaimedDream) rather than inventing a new one.
var DREAM_FIELDS = [
  'caption', 'promptText', 'storyText', 'style', 'mediaType',
  'videoUrl', 'imageUrl', 'dur', 'sourceOperationName',
  'interpretationText', 'interpretationAt', 'updatedAt',
  // mood (tracker item for-product-founder-08-04-evening-music--jfjco0) —
  // the dream-builder wizard's Mood step answer, which js/music-bed.js keys
  // the ambient music bed off. Without it in this list the field is silently
  // dropped on upsert, so a dream RESTORED onto a new device (or after a
  // reinstall) would come back moodless and quietly fall back to its
  // visual-style bed — the same dream sounding different on two devices.
  // This only affects restore, never destroys an existing local value:
  // reconcilePrivateDreamsFromServer merges with Object.assign, which does
  // not delete keys the server copy simply doesn't carry.
  // Deliberately NOT validated against the known-mood list here, unlike
  // publish-dream.js (which writes into a world-readable SHARED blob): this
  // is the owner's own private record, stored as-is alongside caption/
  // storyText, and the only reader of the value — js/music-bed.js's
  // urlForMood — already fails closed on anything that isn't one of the six
  // real mood keys.
  'mood'
];

/**
 * Resolves the ownerHandle to actually store: prefers the client's own
 * `rawDream.ownerHandle` (so a user's own chosen display CASING —
 * e.g. "@RonBrightman" vs. the token's normalized-lowercase
 * "ronbrightman" — survives the round trip, matching js/store.js's exact
 * `d.ownerHandle === state.user.handle` string comparison every reader in
 * that file already relies on), but ONLY when it case-insensitively
 * resolves to the SAME account the token verified — i.e. the client can
 * pick how its OWN handle is cased, never claim a different account's
 * handle. Falls back to the token's own '@'+username otherwise (a client
 * sending no ownerHandle at all, or one that doesn't match, silently gets
 * corrected to its real identity rather than rejected outright — same
 * "trust the client for content, never for identity" split
 * publish-dream.js's own header comment documents elsewhere).
 */
function resolveOwnerHandle(rawDream, verifiedUsername) {
  var claimed = (typeof rawDream.ownerHandle === 'string' && rawDream.ownerHandle) ? rawDream.ownerHandle : null;
  if (claimed) {
    var claimedKey = claimed.replace(/^@/, '').trim().toLowerCase();
    if (claimedKey === verifiedUsername) return claimed;
  }
  return '@' + verifiedUsername;
}

function sanitizeDream(rawDream, verifiedUsername) {
  // likes/likedByMe are ALWAYS forced to their private-dream defaults
  // (never read from the client) — same reasoning as isPublished below:
  // a dream only ever lives in this store while it's NOT on the shared
  // feed (see this file's header comment), and js/store.js's own
  // finalizeDream/saveClaimedDream always start a brand-new dream at
  // likes:0/likedByMe:false too — so this is restating this store's own
  // existing invariant, not inventing a new one. Explicitly present (not
  // just omitted) so a dream RESTORED onto a device that never had it
  // locally (the actual webview-wipe-recovery case this whole feature
  // exists for) round-trips through profile.html's `formatCount(d.likes)`
  // card render without ever seeing `undefined`.
  var out = { id: rawDream.id, ownerHandle: resolveOwnerHandle(rawDream, verifiedUsername), isPublished: false, likes: 0, likedByMe: false };
  DREAM_FIELDS.forEach(function (field) {
    if (rawDream[field] !== undefined) out[field] = rawDream[field];
  });
  if (typeof out.updatedAt !== 'number') out.updatedAt = Date.now();
  return out;
}

exports.handler = async function (event) {
  if (event.httpMethod === 'GET') {
    var queryToken = ((event.queryStringParameters && event.queryStringParameters.authToken) || '').trim();
    if (!queryToken) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'E3: auth_token_required' }) };
    }
    var getAuth = await accountAuthToken.verifyToken(event, queryToken);
    if (!getAuth.ok) {
      return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'E4: invalid_or_expired_token' }) };
    }
    var dreams = await dreamStore.getPrivateDreams(event, getAuth.username);
    return { statusCode: 200, body: JSON.stringify({ ok: true, dreams: dreams }) };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ ok: false, error: 'E1: method_not_allowed' }) };
  }

  var payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'E2: invalid_json' }) };
  }

  var authToken = (payload.authToken || '').trim();
  if (!authToken) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'E3: auth_token_required' }) };
  }

  var action = payload.action;
  if (action !== 'upsert' && action !== 'delete') {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'E5: invalid_action' }) };
  }

  if (action === 'upsert') {
    if (!payload.dream || typeof payload.dream !== 'object' || typeof payload.dream.id !== 'string' || !payload.dream.id) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'E6: dream_required' }) };
    }
  } else {
    var dreamId = (payload.dreamId || '').trim();
    if (!dreamId) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'E7: dream_id_required' }) };
    }
  }

  var auth = await accountAuthToken.verifyToken(event, authToken);
  if (!auth.ok) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'E4: invalid_or_expired_token' }) };
  }

  var result;
  if (action === 'upsert') {
    var sanitized = sanitizeDream(payload.dream, auth.username);
    result = await dreamStore.upsertPrivateDream(event, auth.username, sanitized);
  } else {
    result = await dreamStore.removePrivateDream(event, auth.username, (payload.dreamId || '').trim());
  }

  if (!result.ok) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'E8: sync_write_failed' }) };
  }
  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
