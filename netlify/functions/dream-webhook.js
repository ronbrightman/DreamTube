// netlify/functions/dream-webhook.js
//
// GET/POST target for fal.ai's queue webhook callback
// (https://docs.fal.ai/model-endpoints/webhooks) — the event-driven
// mechanism behind the dream-builder wizard's abandoned-dream
// re-engagement (see start-pending-generation.js, which submits the fal
// job with `?fal_webhook=` pointing HERE plus `?pendingId=<id>` so this
// handler can correlate the callback back to lib/pending-dreams.js's
// record with no server-side memory needed between the two calls —
// Netlify Functions give no guarantee two related invocations land on the
// same instance).
//
// WHY A WEBHOOK, NOT A SCHEDULED FUNCTION: this codebase deliberately has
// no cron/scheduled-function infrastructure (see
// netlify/functions/lib/entitlements.js's own note, and
// docs/IDENTITY_RETENTION_PROJECT_SPEC.md Section 1.3's identical "no
// cron, no queue" reasoning for the now-abandoned Twilio SMS reminder).
// If nobody's browser tab is left open polling video-status.js (the
// abandoned-at-signup case this whole feature exists for), NOTHING would
// ever learn the generation finished without some other event-driven
// signal — fal's own webhook support on the queue API is exactly that
// signal, and fits this codebase's existing all-event-driven-Netlify-
// Functions shape (same category as stripe-webhook.js) rather than
// introducing the cron pattern this codebase has consistently avoided.
//
// Payload shapes (per fal's docs, confirmed 2026-07-24):
//   success: { request_id, gateway_request_id, status:"OK", payload:{...} }
//   error:   { request_id, gateway_request_id, status:"ERROR", error, payload:{...} }
//   payload-serialization error: { ..., status:"OK", payload:null, payload_error }
// `payload.video.url` is the same shape video-status.js's checkFalStatus
// already reads off fal's plain result-fetch endpoint for every video model
// this app uses — the fal-ai/veo3.1 family AND fal.ai's Vidu Q1
// reference-to-video (the default Me-photo model as of founder decision
// 2026-08-09, which the pre-signup path here can now submit): all of them
// return the finished video at payload.video.url, so this handler is
// model-agnostic and needs no per-model branching.
//
// SECURITY: every request here MUST have its ED25519 signature verified
// (see lib/fal-webhook-verify.js) before anything in the payload is
// trusted — this is an unauthenticated public URL by construction (fal
// has no way to attach a bearer token/API key of ours), so signature
// verification against fal's own published JWKS is the only thing
// standing between this endpoint and someone forging a fake "your dream
// is ready" completion for an arbitrary pendingId.
//
// Idempotency AND the "don't send to someone who just claimed it" gate are
// the SAME mechanism now, deliberately: this handler never makes a plain
// read-then-decide check against the record's status (a fal generation
// takes 1-6 minutes per this codebase's own documented Veo range — plenty
// of time for a real signup to complete in between a plain read and
// whatever this handler does next). Instead it goes straight to
// pendingDreams.markReady(), a guarded, verify-after-write transition (see
// lib/pending-dreams.js's own CONCURRENT-WRITE RACE comment for the full
// incident this fixes and the entitlements.js/tracker-store.js precedent
// it adapts) — the email is only ever sent when that transition itself
// reports `ok: true`, i.e. THIS call's write is the one that actually won,
// never based on a status value read moments (or minutes) earlier. A
// duplicate fal redelivery (up to 10 times over ~2h) for an
// already-'notified'/'failed' record, or one that arrives after a real
// claim already landed, both correctly fail that same guarded transition
// and skip the send — see markReady's own doc comment for exactly which
// prior statuses are eligible.
//
// Residual race (same posture entitlements.js's creditTokenPackOnce fix
// documents, not eliminated down to zero): two verify-reads could in
// principle each observe their own write as still current under
// sufficiently pathological Blobs propagation timing. This is a
// categorically narrower window than the bug it replaces (a plain,
// unguarded read-then-act with no re-verification at all) — see
// lib/pending-dreams.js's header comment and
// test/pending-dreams.test.js's/test/dream-webhook.test.js's concurrency
// tests for the actual coverage.
//
// Error codes — this file's own small per-file namespace (bare E1-E4, not
// a padded "E1xx" range — matching this codebase's smaller per-file
// error-code files like request-magic-link.js/verify-magic-link.js, not
// the zero-padded per-hundred convention generate-video.js/interpret-dream.js
// use):
//   E1 method_not_allowed
//   E2 pending_id_required
//   E3 invalid_signature
//   E4 invalid_json_payload

var falWebhookVerify = require('./lib/fal-webhook-verify');
var pendingDreams = require('./lib/pending-dreams');
var pendingDreamToken = require('./lib/pending-dream-token');
var whatsappClient = require('./lib/whatsapp-client');
var mediaRehost = require('./lib/media-rehost');
var emailSuppressionStore = require('./lib/email-suppression-store');
var unsubscribeToken = require('./lib/unsubscribe-token');
var emailLayout = require('./lib/email-layout');
var accountStore = require('./lib/account-store');
var dreamStore = require('./lib/dream-store');
var pendingDreamRecovery = require('./lib/pending-dream-recovery');
var markGenerationCompleted = require('./mark-generation-completed');

var RESEND_API_BASE = 'https://api.resend.com/emails';
var FROM_ADDRESS = 'DreamTube <dreams@dreamtube.life>';

/**
 * Sends the "your dream is ready" email via Resend, with a claim link back
 * to claim-dream.html (see lib/pending-dream-token.js — the same
 * generate-token/store-in-Blobs/verify-and-consume mechanism as
 * lib/magic-link.js, reused here for a pending dream rather than an
 * account, per this task's own instruction). Best-effort: never throws,
 * mirrors request-password-reset.js's/request-magic-link.js's own
 * "log and move on" send-failure handling — a broken email send must
 * never turn into a 5xx that makes fal retry the whole webhook.
 *
 * SUPPRESSION + DESIGN (tracker item
 * for-product-email-redesign-unsubscribe-l-16ysmp): this is one of the
 * two retention/marketing sends in scope for that item ("first-dream,
 * dream-ready, win-back, future") — a re-engagement email to a pre-signup
 * visitor, not a transactional receipt, so it must honor
 * lib/email-suppression-store.js and carry a real unsubscribe link, same
 * as lib/first-dream-email-sender.js's own sendIfEligible. Checked here
 * (never suppressing the WHOLE webhook — WhatsApp/bookkeeping below still
 * run regardless) rather than inside pendingDreams.markReady, since the
 * suppression list is keyed by email, not by pending-dream record.
 */
async function sendReadyEmail(event, record) {
  var resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    console.log('dream-webhook: RESEND_API_KEY not configured — skipping the "your dream is ready" email for pending id ' + record.id);
    return;
  }
  var suppressed = await emailSuppressionStore.isSuppressed(event, record.email);
  if (suppressed) {
    console.log('dream-webhook: ' + record.email + ' has unsubscribed -- skipping the "your dream is ready" email for pending id ' + record.id);
    return;
  }
  try {
    var token = await pendingDreamToken.createToken(event, record.id);
    var url = pendingDreamToken.buildUrl(event, record.id, token);
    var inner = (
      '<p style="font-size:16px;line-height:1.5;color:' + emailLayout.COLORS.textPrimary + ';margin:0 0 18px;">The dream you started building is ready to watch.</p>' +
      '<p style="margin:0 0 16px;">' + emailLayout.ctaButton(url, 'Watch my dream') + '</p>' +
      '<p style="color:' + emailLayout.COLORS.textMuted + ';font-size:13px;margin:0;">Tap the button to watch it and save it to your DreamTube account. If you didn\'t start building a dream on DreamTube, you can safely ignore this email.</p>'
    );
    var html = emailLayout.renderShell({
      event: event,
      previewText: 'The dream you started building is ready to watch.',
      bodyHtml: inner,
      unsubscribeUrl: unsubscribeToken.buildUnsubscribeUrl(event, record.email)
    });
    var res = await fetch(RESEND_API_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + resendKey },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: [record.email],
        subject: 'Your dream is ready to watch',
        html: html
      })
    });
    if (!res.ok) console.error('dream-webhook: Resend rejected the send', res.status);
  } catch (e) {
    console.error('dream-webhook: email send failed (non-fatal)', e);
  }
}

/** Best-effort WhatsApp leg — see lib/whatsapp-client.js's header for why this is a config-gated stub today (no real WhatsApp Business Cloud API wiring/approved template yet). Never throws. */
async function sendReadyWhatsapp(event, record) {
  if (!record.whatsapp) return;
  try {
    var token = await pendingDreamToken.createToken(event, record.id);
    var url = pendingDreamToken.buildUrl(event, record.id, token);
    await whatsappClient.sendMessage(record.whatsapp, 'Your dream is ready to watch: ' + url);
  } catch (e) {
    console.error('dream-webhook: whatsapp send failed (non-fatal)', e);
  }
}

/**
 * SERVER-SIDE DURABLE PERSIST — the fix for E304 dream_sync_unconfirmed / the
 * P0 "vanish" (a finished, already-billed video silently disappearing from a
 * user's journal). The completed video reaches the DURABLE private-dream
 * journal (lib/dream-store.js) today only via the CLIENT's own dream-sync
 * (js/store.js attemptPrivateDreamSync). For DreamTube's biggest cohort —
 * FB/IG in-app-webview users whose localStorage is wiped between sessions — a
 * client that closes or is wiped before that sync confirms strands the video
 * in pending-dreams, never attached to the account. This closes the gap at
 * the SERVER: the moment a funnel generation completes AND its email resolves
 * to a real account, we persist the dream into that account's durable store
 * ourselves, so reconcilePrivateDreamsFromServer pulls it back on the user's
 * next load regardless of what the wiped client did.
 *
 * We have everything needed right here: the pending-dreams `record` carries
 * caption/storyText/style/mediaType/operationName/createdAt, and `videoUrl` is
 * the just-completed video. The owner is resolved from the record's own email
 * (accountStore.getByEmail) — an account this email hasn't registered yet
 * (a genuinely pre-signup, not-yet-claimed visitor) is simply skipped: there
 * is no durable username to key by until they sign up, and the client path
 * still backstops that case (the "your dream is ready" claim email brings
 * them back). Dedup is by sourceOperationName (dreamStore.backfillServerDream
 * is insert-if-absent and never downgrades a richer client copy) — see
 * dream-store.js's DEDUP-BY-OPERATION block for the full convergence design.
 *
 * BEST-EFFORT, never throws: a failure here must never break the webhook's own
 * markReady/markNotified/response — the client sync path stays the fast path
 * and still backstops. Same "log and move on" discipline as sendReadyEmail.
 */
async function persistDurableDreamForOwner(event, record, videoUrl) {
  try {
    if (!record || !record.email) return;
    var operationName = record.operationName;
    if (!operationName) {
      // No operation to key/dedup on (shouldn't happen for a real
      // webhook-completed video — start-pending-generation always stamps
      // one). Skip rather than risk an un-dedup-able server record.
      console.log('dream-webhook: skipping durable persist — no operationName on pending id ' + record.id);
      return;
    }
    if (!videoUrl) return;

    var account = await accountStore.getByEmail(event, record.email);
    if (!account || !account.username) {
      // A genuinely pre-signup / not-yet-claimed visitor — nothing to attach
      // to a durable account yet. The re-engagement claim email is the path
      // that recovers this dream once they actually sign up.
      console.log('dream-webhook: no account yet for pending id ' + record.id + ' — durable persist skipped (client/claim path backstops)');
      return;
    }

    // Exactly the durable private-dream field shape dream-sync.js's own
    // sanitizeDream produces — built by the SHARED
    // pending-dream-recovery.buildDurableDreamFromPendingRecord so this
    // completion-time persist and the cross-device by-email finalization
    // backfill (lib/pending-dream-recovery.js) can never drift. Canonical
    // account handle; reconcilePrivateDreamsFromServer re-stamps ownerHandle
    // to the session's own handle on ingest (every dream dream-sync returns
    // belongs to the verified caller), so this restores correctly even when
    // the user logged back in with different casing.
    var dream = pendingDreamRecovery.buildDurableDreamFromPendingRecord(record, account.username, videoUrl);

    var persisted = await dreamStore.backfillServerDream(event, account.username, dream);
    if (persisted && persisted.ok) {
      console.log('dream-webhook: durable dream persist ' + (persisted.inserted ? 'inserted' : 'already-existed') + ' for pending id ' + record.id + ' operationName=' + operationName);
    } else {
      console.error('dream-webhook: durable dream persist write failed for pending id ' + record.id + ' — client sync path still backstops');
    }
  } catch (e) {
    console.error('dream-webhook: durable dream persist failed (non-fatal)', e);
  }
}

/**
 * SERVER-SIDE RECOVERY-EMAIL ENQUEUE (the second half of the E304 / vanish
 * recovery, founder-approved scope extension). Persisting the dream server-side
 * (above) makes the finished video safe; this makes the user actually LEARN it's
 * ready — the "unwatched dream" nudge email, whose link opens the user's REAL
 * browser (not the FB/IG in-app webview), where the durably-saved video plays.
 *
 * The bug: mark-generation-completed.js's maybeEnqueueUnwatchedNudge — the only
 * thing that enqueues that email — is triggered ONLY client-side (home.html's
 * markGenerationJustCompleted POSTs mark-generation-completed). An FB/IG-webview
 * user who leaves before home.html loads never fires it, so for the biggest
 * cohort the recovery email barely sends. This fires the SAME enqueue from the
 * webhook (fal's own completion), which needs no surviving client.
 *
 * Called ONLY from the already-'claimed' branch (a signed-up user), because that
 * is exactly the gap: a claimed record never sends the pre-signup abandonment
 * email AND never stamps readyAt, so maybeEnqueueUnwatchedNudge's own readyAt
 * overlap guard correctly lets the recovery nudge through here. In the markReady-
 * won branch the abandonment email IS the recovery email (and readyAt is set,
 * which the guard would honor), so no nudge is needed there — and not calling it
 * there avoids racing that branch's own just-issued markReady write.
 *
 * Convergence to exactly ONE nudge is guaranteed by the store, not re-invented:
 * unwatchedDreamNudgeStore.markPending is an onlyIfNew CAS keyed by
 * operationName, so this server-side enqueue and any later client-side
 * mark-generation-completed for the SAME generation collapse to a single nudge —
 * the same operationName-based convergence the durable-dream dedup uses.
 *
 * Best-effort, never throws — mirrors mark-generation-completed.js's own handler,
 * which wraps this exact call in try/catch for the same reason.
 */
async function enqueueRecoveryNudge(event, operationName) {
  if (!operationName) return;
  try {
    // `recovery: true` — this enqueue fires because the CLIENT never marked the
    // completion (a webview leaver), so the recovery email should send promptly:
    // it flags the queue record for the SHORTER pre-send delay in
    // send-unwatched-dream-nudges.js. The send-time watched/active guard is
    // unchanged (a shorter delay only decides how soon we CHECK-and-send).
    await markGenerationCompleted.maybeEnqueueUnwatchedNudge(event, operationName, { recovery: true });
  } catch (e) {
    console.error('dream-webhook: recovery-nudge enqueue failed (non-fatal)', e);
  }
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'E1: method_not_allowed' }) };
  }

  var pendingId = (event.queryStringParameters || {}).pendingId;
  if (!pendingId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E2: pending_id_required' }) };
  }

  var jwks;
  try {
    jwks = await falWebhookVerify.fetchJwks();
  } catch (e) {
    console.error('dream-webhook: fetching fal JWKS failed', e);
    // Fail closed — no way to verify, so no way to trust this request.
    return { statusCode: 503, body: JSON.stringify({ error: 'E3: invalid_signature: jwks_unavailable' }) };
  }

  var verifyResult = falWebhookVerify.verifySignature(event.headers, event.body, jwks);
  if (!verifyResult.ok) {
    return { statusCode: 401, body: JSON.stringify({ error: 'E3: invalid_signature: ' + verifyResult.error }) };
  }

  var body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E4: invalid_json_payload' }) };
  }

  try {
    var isSuccess = body.status === 'OK' && body.payload && body.payload.video && body.payload.video.url;

    if (!isSuccess) {
      var reason = body.error || (body.payload_error ? 'payload_serialization_error: ' + body.payload_error : 'generation_failed');
      await pendingDreams.markFailed(event, pendingId, reason);
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    var rawVideoUrl = body.payload.video.url;

    // Best-effort re-host into our own Blobs storage (lib/media-rehost.js
    // — tracker item for-product-owner-media-library-page-fou-1fwxaw's
    // corrected scope) — this webhook is a GENUINELY SEPARATE completion
    // path from video-status.js's checkFalStatus (see that file's own
    // header comment: this is fal's only real webhook target in this app,
    // wired only to the funnel's pre-signup abandoned-dream flow, and
    // hands back a raw fal video URL directly in the payload, never
    // touching video-status.js at all) — so it must call this same
    // re-host step independently, keyed by the SAME requestId shape
    // video-status.js uses (fal's own request_id, unique per job), so a
    // dream that happens to complete through both a webhook AND a client
    // poll (shouldn't normally happen for this path, but see this file's
    // own idempotency notes elsewhere) can never double-store. Never
    // throws, never blocks the webhook ack on failure — see that module's
    // own header comment.
    var rehost = await mediaRehost.rehostBestEffort(event, 'video', rawVideoUrl, body.request_id);
    var videoUrl = rehost.ok ? rehost.url : rawVideoUrl;

    // The ONLY safe gate for "is it OK to send the re-engagement email" —
    // see the header comment and lib/pending-dreams.js's own doc comment
    // on markReady/tryTransition for why this must be a guarded,
    // verify-after-write transition rather than a status value read
    // separately (a claim can land any time in a 1-6 minute window).
    var transition = await pendingDreams.markReady(event, pendingId, videoUrl);

    if (!transition.ok) {
      if (!transition.record) {
        // Unknown/already-cleaned-up id — nothing to do, but still ack so
        // fal stops retrying a callback for a record that will never exist.
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
      }
      if (transition.record.status === 'claimed') {
        // A real signup already completed for this pending dream (see
        // claim-pending-generation.js) — the person is already in the
        // app; record the finished video for bookkeeping (this is a
        // plain, non-side-effect-gating patch, safe as a blind update —
        // see lib/pending-dreams.js's own doc comment on `update`) but
        // skip the re-engagement send entirely.
        //
        // readyAt is deliberately NOT stamped here (review-round-2 fix,
        // tracker.html's for-product-bug-founder-affects-all-funn-0efe7t —
        // see mark-generation-completed.js's own doc comment on why): this
        // branch never sends an email, and readyAt's WHOLE meaning to that
        // reader is "the abandonment email path actually sent (or
        // genuinely committed to sending)". This is also the LIKELY
        // TYPICAL ordering for a normal funnel completion (claim fires the
        // instant signup succeeds, almost always well before Veo's 1-6
        // minute generation finishes) — stamping readyAt here used to
        // make mark-generation-completed.js's automatic retention email
        // incorrectly skip for most ordinary completions, regressing
        // toward the original "no email ever" bug.
        var claimedRecord = await pendingDreams.update(event, pendingId, { videoUrl: videoUrl });
        // The user already signed up (that's what 'claimed' means), so their
        // email resolves to a real account — persist the finished video into
        // their durable journal server-side, the exact vanish this fix
        // targets (a converting funnel user whose client sync never confirmed
        // before a webview wipe). Best-effort, never blocks the ack.
        await persistDurableDreamForOwner(event, claimedRecord || transition.record, videoUrl);
        // ...and enqueue the "your dream is ready" recovery email server-side.
        // This branch (claimed, no abandonment email, no readyAt) is the exact
        // gap where a webview user who left before home.html fired
        // mark-generation-completed would otherwise get NO email at all. The
        // durable persist saves the video; this email is how they learn it's
        // ready and open it in their real browser. See enqueueRecoveryNudge.
        await enqueueRecoveryNudge(event, (claimedRecord && claimedRecord.operationName) || (transition.record && transition.record.operationName));
        return { statusCode: 200, body: JSON.stringify({ ok: true, claimed: true }) };
      }
      // 'notified' or 'failed' — an already-fully-processed, harmless
      // duplicate delivery.
      return { statusCode: 200, body: JSON.stringify({ ok: true, alreadyProcessed: true }) };
    }

    // transition.ok === true: THIS call's write is the one that actually
    // won the race — safe to send. See markReady's own doc comment.
    await sendReadyEmail(event, transition.record);
    await sendReadyWhatsapp(event, transition.record);
    // Allowed to fail (ok: false) harmlessly if a claim landed in the
    // narrow window since markReady's own verify — see markNotified's
    // own doc comment for why that's fine (the email decision was
    // already correctly made above; this is bookkeeping only).
    await pendingDreams.markNotified(event, pendingId);

    // Durable server-side persist (best-effort) — if this abandoned-dream
    // visitor has ALREADY registered under this email (e.g. signed up, then
    // abandoned before their client confirmed the sync), attach the finished
    // video to their durable journal now. A genuinely pre-signup visitor with
    // no account yet is skipped inside (the claim email recovers that case).
    await persistDurableDreamForOwner(event, transition.record, videoUrl);

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    console.error('dream-webhook: unexpected error', e);
    // Still ack with 200 rather than let fal retry indefinitely over an
    // internal error it can't do anything about — best-effort delivery,
    // same philosophy as every other notification path in this codebase.
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'internal_error' }) };
  }
};
