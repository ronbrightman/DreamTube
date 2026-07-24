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
// Idempotency: fal retries a webhook delivery (up to 10 times over ~2h)
// until it gets a 2xx back — this handler always returns 200 for any
// request whose pendingId resolves to a real record and whose signature
// verifies, whether or not it's a duplicate of a delivery already
// processed (checked via the record's own status — see below), so fal
// stops retrying promptly either way. A record already in 'notified' or
// 'failed' status is a known duplicate/resolved delivery and is a no-op.
// A record already 'claimed' (a real signup completed before this fired —
// see claim-pending-generation.js) still records the finished video for
// bookkeeping but deliberately skips sending the re-engagement email —
// the person already made it into the app on their own, texting/emailing
// them "come back" would be a confusing, unnecessary send.
//
// Known accepted race (same shape as every other Blobs-backed store in
// this codebase — see lib/account-store.js's header comment): two
// near-simultaneous webhook deliveries for the same pendingId, arriving
// before the first one's markNotified() write has landed, could both pass
// the "not already notified" check and both send the email. Narrow,
// low-likelihood (fal doesn't fire the SAME completion callback twice in
// quick succession under normal operation — retries only happen on a
// non-2xx response, and the first success returns 200 immediately), and
// bounded in impact (a duplicate "your dream is ready" email at worst),
// not worth the complexity of a real compare-and-swap this Blobs SDK
// doesn't expose anyway.
//
// Error codes (E1xx range — this file's own namespace):
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
    var record = await pendingDreams.get(event, pendingId);
    if (!record) {
      // Unknown/already-cleaned-up id — nothing to do, but still ack so
      // fal stops retrying a callback for a record that will never exist.
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    if (record.status === 'notified' || record.status === 'failed') {
      return { statusCode: 200, body: JSON.stringify({ ok: true, alreadyProcessed: true }) };
    }

    var isSuccess = body.status === 'OK' && body.payload && body.payload.video && body.payload.video.url;
    if (!isSuccess) {
      var reason = body.error || (body.payload_error ? 'payload_serialization_error: ' + body.payload_error : 'generation_failed');
      await pendingDreams.markFailed(event, pendingId, reason);
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    var videoUrl = body.payload.video.url;

    if (record.status === 'claimed') {
      // A real signup already completed for this pending dream (see
      // claim-pending-generation.js) — the person is already in the app;
      // record the finished video for bookkeeping but skip the
      // re-engagement send entirely (see header comment).
      await pendingDreams.update(event, pendingId, { videoUrl: videoUrl, readyAt: Date.now() });
      return { statusCode: 200, body: JSON.stringify({ ok: true, claimed: true }) };
    }

    var readyRecord = await pendingDreams.markReady(event, pendingId, videoUrl);
    await sendReadyEmail(event, readyRecord);
    await sendReadyWhatsapp(event, readyRecord);
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
