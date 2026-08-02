// netlify/functions/admin-diagnose-dream-edit.js
//
// READ-ONLY diagnostic for tracker item
// for-product-escalation-founder-still-rep-7xo3cm: the founder, after the
// two-concurrent-resumers fix (commit b71dca3) shipped, still reports
// "I keep seeing the pre-edit video and text" when editing a dream. That
// item's own explicit instruction is "do not close on theory" -- this
// exists to answer, with real data, the exact question needed before any
// further code change is even worth making: does the SERVER-SIDE copy of
// the edited dream (netlify/functions/lib/dream-store.js, the private-
// dream-sync store built for tracker item
// for-product-build-p0-server-side-dream-p-zl3rb2) already hold the
// correct, post-edit content, or does IT ALSO show the stale pre-edit
// content?
//
//   - If the server record is ALREADY correct (new caption/videoUrl,
//     current updatedAt, an editHistory entry) but the founder's device
//     still shows the old one, the bug is client-side render/cache, not a
//     lost write -- js/store.js's reconcilePrivateDreamsFromServer or the
//     room/home render path reading a stale in-memory reference.
//   - If the server record is ALSO stale, the write itself never landed
//     (or landed then got clobbered) -- the persistence-reconcile clobber
//     hypothesis that item's own detail names, or a genuinely separate
//     bug in finalizeDream/syncPrivateDreamBestEffort.
//   - editHistory (js/store.js's own finalizeDream stamps one entry per
//     edit-delta submission, deltaLength+timestamp+modelUsed only -- see
//     that function's doc comment) is the single most telling field here:
//     zero entries on a dream the founder insists he edited multiple times
//     means the edit never even reached this store at all.
//
// A pure GET/report, no writes of any kind -- same shape as this
// codebase's other read-only diagnostic, admin-diagnose-rename-
// conflict.js (whose own header comment's "WHAT THIS CAN AND CANNOT SEE"
// section is now STALE on the private-dreams point specifically -- it
// says private dreams are "never synced server-side... invisible to this
// or any server-side diagnostic," which was true when THAT file was
// written but stopped being true the moment zl3rb2 shipped this very
// store this file reads from. Not fixed here -- out of scope for a
// diagnostic tool that doesn't touch that file at all; worth a follow-up
// tracker note, not a silent edit of an unrelated admin tool's header).
//
// Reads whichever account authenticates -- no hardcoded target username
// (unlike admin-restore-founder-email.js/admin-diagnose-rename-
// conflict.js, both of which repair/compare a SPECIFIC other account).
// This diagnostic only ever reports the CALLER's own dream-sync record,
// so there is no second-account information-disclosure surface to guard
// against in the first place -- the auth check below exists purely to
// keep this a founder-only tool (no PUBLIC surface should ever let a
// random visitor see private-dream content, even their own, through a
// side channel like this), not to protect one specific username.
//
// AUTH: same bar as every sibling admin-*.js data-read/repair tool in
// this codebase -- real, server-verified password (lib/account-store.js's
// verifyLogin) against an account whose OWN on-file email matches
// OWNER_EMAIL. Duplicated inline rather than shared, matching this
// codebase's explicit small-self-contained-admin-function precedent (see
// admin-diagnose-rename-conflict.js's own header comment for the "why").
//
// RATE LIMITING: same two-bucket (per-IP + per-identifier) shape as every
// sibling admin tool, for the identical reason -- this performs a real
// password check.
//
// Request: POST { usernameOrEmail, password }
// Response: 200 { ok:true, username, email, dreamCount, dreams:[ {
//   id, mediaType, storyText (truncated to 120 chars),
//   videoUrl, imageUrl, sourceOperationName, updatedAt, updatedAtIso,
//   editHistory
// }, ... ] } -- dreams sorted newest-updatedAt-first, so the most recently
//   edited dream (the one most likely to be the founder's live repro
//   target) is always first.
//
// Error codes (same small-number scheme as every sibling admin-*.js file):
//   E1 method_not_allowed
//   E2 missing_owner_email
//   E3 invalid_json
//   E4 missing_fields
//   E5 forbidden
//   E6 rate_limited

var accountStore = require('./lib/account-store');
var dreamStore = require('./lib/dream-store');
var { normalizeEmail } = require('./lib/entitlements');
var rateLimit = require('./lib/rate-limit');

/** Real, server-verified credential check + owner-email confirmation -- duplicated from admin-diagnose-rename-conflict.js's own copy, see header comment. */
async function verifyOwnerCredentials(event, usernameOrEmail, password) {
  var ownerEmail = normalizeEmail(process.env.OWNER_EMAIL);
  if (!ownerEmail) return { ok: false, error: 'owner_not_configured' };

  var loginCheck = await accountStore.verifyLogin(event, usernameOrEmail, password);
  if (!loginCheck.ok) return { ok: false, error: loginCheck.error };

  if (normalizeEmail(loginCheck.record.email) !== ownerEmail) {
    return { ok: false, error: 'not_owner' };
  }
  return { ok: true, record: loginCheck.record };
}

function summarizeDream(d) {
  var story = typeof d.storyText === 'string' ? d.storyText : (typeof d.caption === 'string' ? d.caption : '');
  return {
    id: d.id,
    mediaType: d.mediaType || 'video',
    storyText: story.length > 120 ? story.slice(0, 120) + '…' : story,
    videoUrl: d.videoUrl || null,
    imageUrl: d.imageUrl || null,
    sourceOperationName: d.sourceOperationName || null,
    updatedAt: d.updatedAt || null,
    updatedAtIso: d.updatedAt ? new Date(d.updatedAt).toISOString() : null,
    editHistory: Array.isArray(d.editHistory) ? d.editHistory : []
  };
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'E1: method_not_allowed' }) };
  }

  var ownerEmail = normalizeEmail(process.env.OWNER_EMAIL);
  if (!ownerEmail) {
    return { statusCode: 500, body: JSON.stringify({ error: 'E2: missing_owner_email' }) };
  }

  var payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E3: invalid_json' }) };
  }

  var usernameOrEmail = typeof payload.usernameOrEmail === 'string' ? payload.usernameOrEmail.trim() : '';
  var password = typeof payload.password === 'string' ? payload.password : '';
  if (!usernameOrEmail || !password) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'E4: missing_fields' }) };
  }

  // Same two-bucket rate limiting as every sibling admin tool.
  var maxPerIpPerDay = parseInt(process.env.MAX_ADMIN_DIAGNOSE_DREAM_EDIT_PER_IP_PER_DAY, 10);
  if (!maxPerIpPerDay || maxPerIpPerDay <= 0) maxPerIpPerDay = 20;
  var maxPerIdentifierPerDay = parseInt(process.env.MAX_ADMIN_DIAGNOSE_DREAM_EDIT_PER_IDENTIFIER_PER_DAY, 10);
  if (!maxPerIdentifierPerDay || maxPerIdentifierPerDay <= 0) maxPerIdentifierPerDay = 10;

  var ip = rateLimit.clientIp(event);
  var ipLimit = await rateLimit.checkAndIncrement(event, 'admin-diagnose-dream-edit-ip', ip, maxPerIpPerDay);
  if (!ipLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ ok: false, error: 'E6: rate_limited: too many attempts from this network today, try again tomorrow' }) };
  }

  var canonicalAccount = await accountStore.getByUsername(event, usernameOrEmail);
  if (!canonicalAccount) canonicalAccount = await accountStore.getByEmail(event, usernameOrEmail);
  var identifierKey = canonicalAccount ? canonicalAccount.username : usernameOrEmail.toLowerCase();
  var identifierLimit = await rateLimit.checkAndIncrement(event, 'admin-diagnose-dream-edit-identifier', identifierKey, maxPerIdentifierPerDay);
  if (!identifierLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ ok: false, error: 'E6: rate_limited: too many attempts for this account today, try again tomorrow' }) };
  }

  var auth = await verifyOwnerCredentials(event, usernameOrEmail, password);
  if (!auth.ok) {
    return { statusCode: 403, body: JSON.stringify({ ok: false, error: 'E5: forbidden' }) };
  }

  var dreams = await dreamStore.getPrivateDreams(event, auth.record.username);
  var summarized = dreams.map(summarizeDream).sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });

  return {
    statusCode: 200,
    body: JSON.stringify({
      ok: true,
      username: auth.record.username,
      email: auth.record.email,
      dreamCount: summarized.length,
      dreams: summarized
    })
  };
};
