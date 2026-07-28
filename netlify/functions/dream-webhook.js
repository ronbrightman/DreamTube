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
// already reads off fal's plain result-fetch endpoint for this exact
// model family (fal-ai/veo3.1/fast and its reference-to-video variant).
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

var RESEND_API_BASE = 'https://api.resend.com/emails';
var FROM_ADDRESS = 'DreamTube <onboarding@resend.dev>';

/**
 * Sends the "your dream is ready" email via Resend, with a claim link back
 * to claim-dream.html (see lib/pending-dream-token.js — the same
 * generate-token/store-in-Blobs/verify-and-consume mechanism as
 * lib/magic-link.js, reused here for a pending dream rather than an
 * account, per this task's own instruction). Best-effort: never throws,
 * mirrors request-password-reset.js's/request-magic-link.js's own
 * "log and move on" send-failure handling — a broken email send must
 * never turn into a 5xx that makes fal retry the whole webhook.
 */
async function sendReadyEmail(event, record) {
  var resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    console.log('dream-webhook: RESEND_API_KEY not configured — skipping the "your dream is ready" email for pending id ' + record.id);
    return;
  }
  try {
    var token = await pendingDreamToken.createToken(event, record.id);
    var url = pendingDreamToken.buildUrl(event, record.id, token);
    var res = await fetch(RESEND_API_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + resendKey },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: [record.email],
        subject: 'Your dream is ready to watch',
        html: '<p>The dream you started building is ready.</p>' +
          '<p><a href="' + url + '">Tap here to watch it</a> and save it to your DreamTube account.</p>' +
          '<p>If you didn\'t start building a dream on DreamTube, you can safely ignore this email.</p>'
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

    var videoUrl = body.payload.video.url;

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
        await pendingDreams.update(event, pendingId, { videoUrl: videoUrl });
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

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    console.error('dream-webhook: unexpected error', e);
    // Still ack with 200 rather than let fal retry indefinitely over an
    // internal error it can't do anything about — best-effort delivery,
    // same philosophy as every other notification path in this codebase.
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'internal_error' }) };
  }
};
