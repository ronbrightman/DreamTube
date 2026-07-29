// netlify/functions/delete-account.js
//
// POST { username, password } -> permanently deletes the caller's own
// account and every server-side trace of it this codebase actually
// controls. Built per tracker.html's confirm-account-deletion-flow item
// (Ron: "it doesnt exist and the first user support email actually
// requested this so please do build it") — before this file existed there
// was no account-deletion flow anywhere in the codebase at all (confirmed
// by a direct grep sweep), so the draft FAQ's "yes, you can delete your
// account" answer was false.
//
// AUTHENTICATION MODEL — same trust boundary as every other account-
// mutation endpoint in this codebase (see verify-password-reset.js/
// request-password-reset.js): there is no session/cookie/token concept
// anywhere in this app (js/store.js's own header comment: "no real backend
// yet"), so the only thing that can prove "this caller really is the
// account owner" for something this destructive is a REAL password
// re-check against the server-side account store, not a client-claimed
// username/email. This deliberately does NOT accept a bare
// { username, email } request the way publish-dream.js's honest "no real
// server-side auth" model does — a wrong password here permanently
// destroys real data (dreams, characters, token balance), so it needs the
// stronger bar every other password-gated endpoint already uses (account-
// login.js's verifyLogin), specifically to guard against someone else on a
// shared/already-logged-in device (profile.html renders Settings for
// whoever is currently signed in on THIS browser, with no re-auth prompt
// of its own) triggering a real account deletion with nothing but a stray
// tap. See profile.html's confirmation sheet for the client-side half of
// this (a real password re-entry field, not just a "yes, delete" tap).
//
// WHAT THIS ACTUALLY DELETES, and what it deliberately does NOT:
//
//   1. The account record itself (lib/account-store.js's "u:"/"e:" Blobs
//      keys) — accountStore.deleteAccount. Login for this username/email
//      fails immediately after (account-login.js has nothing left to find).
//
//   2. Every dream this account ever published, from the shared/public
//      Explore feed (the "dreamtube-feed" Blobs store's feed-index array
//      — see get-feed.js/publish-dream.js/unpublish-dream.js) — filtered
//      by ownerHandle, case-insensitively, since the display handle
//      (js/store.js's state.user.handle) can carry whatever casing the
//      user originally typed at signup while the account itself is keyed
//      by a normalized-lowercase username. A PRIVATE (never-published)
//      dream has no server-side footprint at all beyond this — it only
//      ever lived in the browser's own localStorage — so deleting the
//      account server-side plus the client wiping its local state (see
//      js/store.js's deleteAccount) together cover the full picture, same
//      division of labor unpublish-dream.js/deleteDream already use for
//      an individual dream.
//
//   3. Token ledger data — lib/entitlements.js's per-email balance record
//      (entitlements.deleteEntitlement), keyed by the SAME normalized
//      email account-store.js has on file for this username (not a
//      client-supplied email — using the server's own record avoids a
//      caller lying about which email's balance to wipe).
//
//   4. Character data (js/store.js's charactersByUser) — grepped for any
//      server-side mirror of this (lib/entitlements.js's record shape,
//      every other lib/*.js store in this codebase) and found none:
//      characters have only ever existed in the browser's own
//      localStorage, never synced server-side (see account-store.js's own
//      header comment: "does NOT sync dreams/characters/videos... stays
//      exactly as it is today"). Nothing for this endpoint to delete here
//      — js/store.js's deleteAccount wiping local state is the ENTIRE
//      story for characters, not a gap.
//
//   5. Every lib/account-auth-token.js token previously minted for this
//      username (tracker item for-product-public-feed-safety-in-app-re-
//      ppuw77, round-2 security review finding, fixed) —
//      accountAuthToken.invalidateTokensForUsername. Without this, a
//      genuinely exploitable identity-reuse gap existed: register a
//      desirable username, keep the token, delete the account, wait for a
//      DIFFERENT real person to register the SAME now-freed username (this
//      codebase's account-store.js has no cooldown on reusing a freed
//      username), and the old token would still verify — silently
//      granting the original holder read/write access to the NEW,
//      unrelated account's blocklist. See that lib's own
//      invalidateTokensForUsername doc comment for the full mechanism.
//
//   6. This account's entire server-side private-dream record (tracker
//      item for-product-build-p0-server-side-dream-p-zl3rb2, server-side
//      private dream persistence) — dreamStore.deleteAllPrivateDreams.
//      Without this, a deleted account's un-published dreams would linger
//      forever in lib/dream-store.js's per-username Blobs record —
//      harmless (nothing reads it once the account itself is gone, and
//      dream-sync.js's own auth-token verification means the freed
//      username can't be used to read it back without a brand-new account
//      re-registering that exact name and going through a fresh
//      login/signup of its own — see step 5's own invalidation above,
//      which independently blocks the old holder's stale token from ever
//      reaching it), but this matches the completeness bar already
//      applied to the token ledger and shared feed above. Placed LAST,
//      unlike step 5's authToken invalidation (which deliberately runs
//      right after step 1, per that step's own ordering rationale) —
//      dreamStore.deleteAllPrivateDreams never throws (it catches its own
//      Blobs errors internally, same plain-delete shape as
//      entitlements.js's deleteEntitlement), so there is no equivalent
//      "a later step's failure could skip this" risk to guard against by
//      moving it earlier.
//
//   NOT touched, and why (see this repo's own tracker/AGENT_POLICY.md
//   escalation policy for the reasoning behind leaving these as a
//   judgment call rather than guessing):
//
//   - Dodo Payments' own customer/payment-history record. This codebase
//     stores NO Dodo customer id anywhere — create-checkout-session-
//     dodo.js only ever sends `customer: { email }` to Dodo at checkout
//     time (Dodo resolves/creates its own customer object by email on its
//     side), and the only thing this codebase itself persists per purchase
//     is lib/entitlements.js's TOKEN_PURCHASES_STORE_NAME dedup marker,
//     keyed by Dodo's opaque payment_id (not by account/email), holding
//     nothing beyond { email, tokens, status, claimId, createdAt } — no
//     card data, no name/address (that PII lives entirely on Dodo's own
//     side). There is no cheap way to enumerate "every payment_id this
//     email ever produced" (no email -> payment_id index exists, Blobs has
//     no cheap scan — see get-feed.js's header comment on that same
//     limitation), and forgetAppliedTokenPack's own doc comment already
//     treats a lingering marker as harmless. Actually deleting/anonymizing
//     the real customer record on DODO'S side would require a live call
//     against Dodo's production API using this environment's real
//     DODO_API_KEY, against a real paying customer's real record — a
//     genuine vendor-side, possibly-irreversible action this repo's own
//     escalation policy reserves for explicit human sign-off, not
//     something to guess at from inside an autonomous build pass. Left
//     for the founder's own decision (see the build report this shipped
//     with) — most mainstream payment processors retain transaction
//     history regardless of an account-deletion request anyway, for
//     fraud/audit/legal reasons, so "DreamTube's own systems no longer
//     retain anything; billing history is retained by Dodo per standard
//     payment-processor practice" is a defensible default pending that
//     decision.
//
//   - Pending-dream / support-message records tied to this account's
//     email (lib/pending-dreams.js / lib/support-store.js). Pending-dream
//     records are a short-lived bookkeeping artifact of one specific
//     in-flight (or already-resolved) generation, not ongoing account
//     data — by the time an account exists to delete, any pending record
//     tied to its email has almost always already resolved to
//     claimed/notified/failed, and touching it here (versus leaving it to
//     age out functionally, since nothing ever reads a claimed/notified/
//     failed record again) risks corrupting dream-webhook.js's own
//     in-flight status-transition guarantees for zero real benefit.
//     Support messages are a business record of what was actually said to
//     the founder (the append-only "dreamtube-support-messages" store has
//     no per-item delete at all today, by design — see that file's header
//     comment) — the same way a real company doesn't retroactively delete
//     an already-sent support email from its own inbox just because the
//     sender later closed their account. Left untouched; flagged in the
//     build report rather than guessed at.
//
// Error codes (local to this function, same small-number-scheme reasoning
// as account-login.js/register-account.js):
//   E1 method_not_allowed
//   E2 invalid_json
//   E3 missing_fields        — username/password not both present
//   E4 not_found             — no account matches that username server-side
//   E5 incorrect_password    — account found, password didn't match it
//   E6 rate_limited          — MAX_DELETE_ACCOUNT_ATTEMPTS_PER_IP_PER_DAY or
//                               MAX_DELETE_ACCOUNT_ATTEMPTS_PER_IDENTIFIER_PER_DAY
//                               exceeded for today
//   E7 deletion_failed       — password verified, but something failed
//                               while actually deleting (Blobs error, etc.)
//
// Rate limiting: mirrors account-login.js's own two-bucket shape (per-IP
// AND per-identifier) exactly, for the exact same reason — this endpoint
// ALSO checks a caller-supplied password against a real account with
// otherwise zero throttling, so it's just as exposed to unlimited
// password-guessing as login is, just with a more destructive payoff if
// guessed correctly. Reuses the SAME canonical-account-resolution shape
// (resolve first, bucket on the canonical username so an attacker can't
// get two independent buckets by trying both the username and the email
// for one account) — see account-login.js's own header comment for the
// full reasoning, which applies here verbatim.

var accountStore = require('./lib/account-store');
var entitlements = require('./lib/entitlements');
var rateLimit = require('./lib/rate-limit');
var accountAuthToken = require('./lib/account-auth-token');
var dreamStore = require('./lib/dream-store');
var { connectLambda, getStore } = require('@netlify/blobs');

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

  var username = (payload.username || '').trim();
  var password = typeof payload.password === 'string' ? payload.password : '';
  if (!username || !password) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E3: missing_fields' }) };
  }

  var maxPerIpPerDay = parseInt(process.env.MAX_DELETE_ACCOUNT_ATTEMPTS_PER_IP_PER_DAY, 10);
  if (!maxPerIpPerDay || maxPerIpPerDay <= 0) maxPerIpPerDay = 100;
  var maxPerIdentifierPerDay = parseInt(process.env.MAX_DELETE_ACCOUNT_ATTEMPTS_PER_IDENTIFIER_PER_DAY, 10);
  if (!maxPerIdentifierPerDay || maxPerIdentifierPerDay <= 0) maxPerIdentifierPerDay = 30;

  var ip = rateLimit.clientIp(event);
  var ipLimit = await rateLimit.checkAndIncrement(event, 'delete-account-ip', ip, maxPerIpPerDay);
  if (!ipLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ ok: false, error: 'E6: rate_limited: too many attempts from this network today, try again tomorrow' }) };
  }
  var canonicalAccount = await accountStore.getByUsername(event, username);
  if (!canonicalAccount) canonicalAccount = await accountStore.getByEmail(event, username);
  var identifierKey = canonicalAccount ? canonicalAccount.username : username.toLowerCase();
  var identifierLimit = await rateLimit.checkAndIncrement(event, 'delete-account-identifier', identifierKey, maxPerIdentifierPerDay);
  if (!identifierLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ ok: false, error: 'E6: rate_limited: too many attempts for this account today, try again tomorrow' }) };
  }

  var result = await accountStore.verifyLogin(event, username, password, { record: canonicalAccount });
  if (!result.ok) {
    var code = result.error === 'incorrect_password' ? 'E5: incorrect_password' : 'E4: not_found';
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: code }) };
  }

  var account = result.record;

  try {
    // 1. The account record itself.
    await accountStore.deleteAccount(event, account.username);

    // 2. Invalidate every previously-minted authToken for this username —
    // see header comment (round-2 security review finding, fixed) —
    // deliberately right after the account record delete succeeds, not
    // last: a later step below throwing (entitlements/feed writes are
    // separate Blobs calls that can independently fail) must not leave a
    // deleted account's old tokens still valid just because this call
    // never got a chance to run (round-3 review finding).
    await accountAuthToken.invalidateTokensForUsername(event, account.username);

    // 3. Token ledger, keyed by this account's own on-file email (never a
    // client-supplied one — see header comment).
    if (account.email) {
      await entitlements.deleteEntitlement(event, account.email);
    }

    // 4. Every dream this account ever published, from the shared feed.
    // Same "whole-array read-modify-write, not a real database" tradeoff
    // get-feed.js/publish-dream.js/unpublish-dream.js already document and
    // accept — this is one more caller of that same shape, just filtering
    // by ownerHandle instead of by a single id. Matched case-insensitively:
    // account-store.js keys usernames normalized (trim+lowercase), but a
    // dream's ownerHandle (js/store.js's state.user.handle) can carry
    // whatever casing the user originally typed at signup.
    connectLambda(event);
    var feedStore = getStore('dreamtube-feed');
    var feed = (await feedStore.get('feed-index', { type: 'json' })) || [];
    var ownerHandleLower = '@' + account.username;
    var filtered = feed.filter(function (d) {
      return (d.ownerHandle || '').toLowerCase() !== ownerHandleLower;
    });
    if (filtered.length !== feed.length) {
      await feedStore.setJSON('feed-index', filtered);
    }

    // 6. This account's server-side private-dream record — see header
    // comment above.
    await dreamStore.deleteAllPrivateDreams(event, account.username);

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'E7: deletion_failed' + (e && e.message ? ': ' + e.message : '') }) };
  }
};
