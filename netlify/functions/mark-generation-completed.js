// netlify/functions/mark-generation-completed.js
//
// POST { operationName } -> independently RE-VERIFIES that this
// server-issued job actually completed, and only then durably records
// "this operation just finished generating" -- replacing the old
// sessionStorage `dreamtube_just_generated_id` marker processing.html
// used to set right before redirecting to result.html (tracker.html's
// result-htmls-firstvideocreated-still-dep-qfg48t item, founder-approved
// 2026-07-27 -- "make the carrier durable"). See
// netlify/functions/lib/generation-completion-store.js's header comment
// for the full design (why keyed by operationName, not dreamId) and
// docs/EVENT_TAXONOMY.md for how this fits into FirstVideoCreated's
// two-guard picture. Paired with consume-generation-marker.js, called
// from result.html at render time.
//
// SECURITY (review finding, fixed 2026-07-27): the original version of
// this endpoint accepted a bare client-supplied `dreamId` with NO
// verification at all that a real generation had actually just
// completed. Since dream ids are client-invented and already public
// elsewhere in this app (explore.html/profile.html/watch.html links --
// profile.html's own dreams grid is the ORDINARY way a user revisits
// their own past dream), that meant any unauthenticated caller who
// merely knew/guessed a real dreamId could plant a marker for it, and the
// victim's own next ordinary revisit of their own old dream would
// silently consume it -- forging a FirstVideoCreated fire (Meta Pixel +
// CAPI + PostHog) for an account that never actually just generated
// anything. This is now closed two ways at once: (1) the accepted
// identifier is `operationName`, the server-issued job id from
// generate-video.js/generate-image.js, never client-invented and never
// exposed in any UI/URL anywhere in this app (see
// generation-completion-store.js's header comment for why that alone
// already prevents targeting a specific victim); and (2)
// `verifyOperationCompleted` below independently re-confirms, against
// fal's own status endpoint (or the mock path's embedded-timestamp
// check), that the claimed operationName genuinely reached a completed
// state -- a bare, unverified claim writes NOTHING.
//
// Called from js/store.js's DreamStore.markGenerationJustCompleted(operationName)
// -- fire-and-forget, best-effort, and must never throw or block the
// redirect it runs right before (same discipline as every other
// analytics-adjacent call in this codebase). Always 200s, even when
// verification fails or a field is missing, since this is purely
// best-effort bookkeeping -- a caller that gets a non-2xx here has
// nothing useful to do about it anyway, and a distinguishable response
// for "unverified" vs "verified" would just hand a prober a free oracle.
//
// SERVER-VERIFIED "GENERATION JUST COMPLETED" CHOKE POINT: this is THE
// genuine, singular, server-verified "generation just completed" choke
// point for every generation path this app has that ends with the browser
// landing on processing.html -- fresh video, regenerate, reference-to-video,
// image-to-video, and image generation for an already-signed-in account
// (generate-video.js/generate-image.js's own recordJobOwnerBestEffort call
// at submission time), AND the dream-builder wizard's pre-signup "generate
// during signup" funnel path (start-pending-generation.js) once its
// generation is claimed by a real signup and the SAME browser continues on
// to processing.html exactly like the normal path -- see that file's own
// recordJobOwnerBestEffort for why it now also writes to this same
// lib/job-owners.js store at its own submission time. There is genuinely no
// real fal WEBHOOK for any of the signed-in-generation paths --
// dream-webhook.js is fal's only actual webhook target in this app, and it's
// wired ONLY to the funnel's own pre-signup ABANDONED-dream flow (see
// generate-video.js's own withWebhook comment). So this client-polled-then-
// server-re-verified endpoint IS the closest thing to a real completion
// signal this app has for every one of these paths.
//
// COMPLETION SIDE-EFFECTS: once `verified` is true below, this fires two
// independent, best-effort completion side-effects, each resolving WHO owns
// `operationName` via lib/job-owners.js (recorded at SUBMISSION time, never
// anything this request itself claims), each in its own try/catch so a
// failure in one never affects the completion marker or the other:
//   - the video-ready web push (maybeSendVideoReadyPush), and
//   - the "unwatched dream" retention-nudge ENQUEUE (maybeEnqueueUnwatchedNudge),
//     which send-unwatched-dream-nudges.js's scheduled scan later drains into
//     the single "your dream is ready to watch" email this app sends a
//     signed-up user (founder decision 2026-08-11: the separate first-dream
//     email was retired entirely; the nudge now covers EVERY unwatched dream,
//     including a user's first).
// Neither needs a password or any client-claimed identity -- ownership is
// proven purely by knowing operationName (server-issued, unguessable,
// independently re-verified as genuinely completed above) plus the
// submission-time job-owners binding. Neither ever turns into a
// distinguishable response (see the E-code list below): a real completion
// marker write always succeeds or fails on its own terms, independent of
// whatever happens to these bonus steps.
//
// Rate limiting: same reasoning as track-conversion.js -- a public,
// unauthenticated endpoint, so a per-IP daily cap guards against someone
// scripting pointless requests. Not the actual security boundary (that's
// verifyOperationCompleted below) -- just cheap hygiene consistent with
// this codebase's other public endpoints.
//
// Error codes (local to this small function):
//   E1 method_not_allowed
//   E2 invalid_json
//   E3 missing_operation_name
//   E4 rate_limited

var generationCompletionStore = require('./lib/generation-completion-store');
var jobOwners = require('./lib/job-owners');
var accountStore = require('./lib/account-store');
var unwatchedDreamNudgeStore = require('./lib/unwatched-dream-nudge-store');
var rateLimit = require('./lib/rate-limit');
var pendingDreams = require('./lib/pending-dreams');
var pushDedupStore = require('./lib/push-dedup-store');
var pushSender = require('./lib/push-sender');
var posthogCapture = require('./lib/posthog-capture');

var FAL_API_BASE = 'https://queue.fal.run';

// A genuine mock-mode completion is only ever observed as "done" by
// video-status.js/image-status.js once at least their own MOCK_DELAY_MS
// has elapsed since the operationName's embedded start timestamp (20s for
// video, 5s for image -- see either file's own MOCK_DELAY_MS). This
// function doesn't know which mediaType a given operationName was for, so
// it uses the SHORTER (image's) threshold as a conservative floor: any
// genuine completion will have already cleared it by the time the client
// gets here (finalizeDream only runs after the client's own poll already
// saw done:true), while a freshly-fabricated "mock:<Date.now()>:..." string
// (an attacker's forged operationName, minted the instant before calling
// this endpoint) will not.
var MOCK_MIN_ELAPSED_MS = 5000;

/** Same "owner/alias, not the full model id" extraction as video-status.js's/image-status.js's own falAppBase -- fal's status endpoint 405s on the full model id. Duplicated rather than shared, matching this codebase's "each function self-contained" convention (see image-status.js's own header comment on duplicating from video-status.js for the same reason). */
function falAppBase(model) {
  var parts = model.split('/');
  return parts[0] + '/' + parts[1];
}

/**
 * Independently re-verifies (never trusts the client's bare claim) that
 * `operationName` genuinely reached a completed state, consulting the
 * exact same status source video-status.js/image-status.js already
 * check: fal's own queue status endpoint for a real "fal:" job, or the
 * embedded-timestamp elapsed check for a "mock:" one (see those files'
 * own header comments and generate-video.js's/generate-image.js's
 * GENERATION_MOCK_MODE doc blocks). Deliberately a LIGHTER check than
 * either status function's own full logic -- this only needs "did fal
 * actually mark this COMPLETED", never the actual video/image URL, so it
 * skips the result-fetch/error-humanization machinery those files need
 * for their own different job (telling the user what went wrong).
 *
 * Fails CLOSED: an unrecognized operationName shape, a missing FAL_KEY, a
 * non-OK/non-JSON response, or fal reporting anything other than
 * COMPLETED (IN_QUEUE/IN_PROGRESS/an error status) all resolve false. A
 * false negative here just means a legitimate completion's marker doesn't
 * get written this time (an honest degrade, same class as every other
 * best-effort gap in this feature) -- never a false positive, which is
 * the property this function exists to guarantee.
 */
async function verifyOperationCompleted(operationName) {
  if (typeof operationName !== 'string' || !operationName) return false;

  if (operationName.indexOf('mock:') === 0) {
    var startedAt = parseInt(operationName.split(':')[1], 10);
    if (!isFinite(startedAt)) return false;
    return (Date.now() - startedAt) >= MOCK_MIN_ELAPSED_MS;
  }

  if (operationName.indexOf('fal:') === 0) {
    var falKey = process.env.FAL_KEY;
    if (!falKey) return false;
    var parts = operationName.split(':');
    var model = parts[1];
    var requestId = parts[2];
    if (!model || !requestId) return false;
    try {
      var res = await fetch(FAL_API_BASE + '/' + falAppBase(model) + '/requests/' + requestId + '/status', {
        headers: { 'Authorization': 'Key ' + falKey }
      });
      if (!res.ok) return false;
      var data = await res.json();
      return !!(data && data.status === 'COMPLETED');
    } catch (e) {
      return false;
    }
  }

  // Neither a recognized "fal:" nor "mock:" shape (e.g. the unused Veo
  // fallback path's raw operation names, or a fabricated value) -- fail
  // closed rather than guessing.
  return false;
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

  var operationName = (payload && payload.operationName) || '';
  if (!operationName || typeof operationName !== 'string') {
    return { statusCode: 400, body: JSON.stringify({ error: 'E3: missing_operation_name' }) };
  }

  var maxPerDay = parseInt(process.env.MAX_GENERATION_MARKERS_PER_IP_PER_DAY, 10);
  if (!maxPerDay || maxPerDay <= 0) maxPerDay = 200;
  var ip = rateLimit.clientIp(event);
  var ipLimit = await rateLimit.checkAndIncrement(event, 'generation-marker-mark', ip, maxPerDay);
  if (!ipLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ error: 'E4: rate_limited' }) };
  }

  try {
    var verified = await verifyOperationCompleted(operationName);
    if (verified) {
      await generationCompletionStore.markCompleted(event, operationName);
      // video-ready push (tracker item for-product-build-stage-0-pwa-web-
      // push-f-jbutt5, part 4) -- its own try/catch, same reasoning as the
      // email step above: a push failure must never affect the completion
      // marker, and the two channels are DELIBERATELY independent (see
      // maybeSendVideoReadyPush's own doc comment on why this can fire
      // for the SAME completion the email above just fired for, or
      // skipped, and that's the intended "second, independent channel"
      // behavior, not a bug).
      try {
        await maybeSendVideoReadyPush(event, operationName);
      } catch (pushErr) {
        console.error('mark-generation-completed: video-ready push step failed (non-fatal)', pushErr);
      }
      // "Unwatched dream" retention nudge (founder-approved retention plan,
      // piece 1) — its own try/catch, same "must never affect the completion
      // marker" discipline as the two steps above. Enqueues a pending nudge;
      // send-unwatched-dream-nudges.js's scheduled scan decides, ~7-10 min
      // later, whether the user actually watched it (suppress) or not (send).
      // See maybeEnqueueUnwatchedNudge's own doc comment for how it stays
      // non-overlapping with the pre-signup ready email. This nudge is the
      // single "your dream is ready to watch" email a signed-up user now gets
      // (founder decision 2026-08-11 retired the separate first-dream email).
      try {
        await maybeEnqueueUnwatchedNudge(event, operationName);
      } catch (nudgeErr) {
        console.error('mark-generation-completed: unwatched-dream nudge enqueue step failed (non-fatal)', nudgeErr);
      }
    }
    // An operationName that doesn't verify is a silent no-op -- see header
    // comment on why this never surfaces as a distinguishable response.
  } catch (e) {
    // Best-effort -- never let this surface as a failure to the caller. A
    // failure here just means this specific completion's FirstVideoCreated
    // fire may be missed, the same honest degrade the old sessionStorage
    // marker already accepted when storage was disabled.
    console.error('mark-generation-completed: unexpected error', e);
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};

/**
 * Enqueues a pending "unwatched dream" retention nudge (founder-approved
 * retention plan, piece 1) for THIS just-verified video completion, if it
 * belongs to a real registered account. send-unwatched-dream-nudges.js's
 * scheduled scan is what actually decides, ~7-10 min later, whether the user
 * watched it (a server-side viewed marker exists -> suppress) or not (send
 * a warm nudge embedding their own dream text + the real thumbnail). See
 * that file's header comment for the full mechanism.
 *
 * Deliberately its own function — "each completion side-effect is its own
 * independent, best-effort branch", the same shape as maybeSendVideoReadyPush,
 * resolving identity via lib/job-owners.js's submission-time operationName ->
 * owner binding. Every branch is a silent no-op (never an error, never a
 * distinguishable HTTP response), same posture as this function's siblings.
 *
 * NO-OVERLAP GUARANTEE, the enqueue-side half (the sender owns the other
 * half — see lib/unwatched-dream-nudge-sender.js's header comment). Since the
 * separate first-dream email was retired (founder decision 2026-08-11), the
 * ONLY other "your dream is ready" send left is dream-webhook.js's pre-signup
 * abandonment email, and this nudge is the sole "your dream is ready to watch"
 * email a signed-up user gets — first dream or later:
 *   - PRE-SIGNUP ready email (dream-webhook.js): excluded here. A funnel-
 *     started job carries a `pendingId`; if its pending-dreams `readyAt` is
 *     set, that pre-signup email already sent (or committed to sending), so
 *     this does NOT enqueue a nudge for the same dream. The `readyAt`
 *     (not `status`) field is the right one to check: it's written atomically
 *     the instant dream-webhook.js's markReady succeeds and is never cleared
 *     by a later markClaimed transition. getWithReadyRetry (below) mirrors
 *     lib/blobs-retry.js's bounded-real-delay re-read to narrow the
 *     eventual-consistency window where a genuinely separate read here could
 *     still see a stale `readyAt: undefined` while dream-webhook.js's own send
 *     decision already went ahead (see that function's own doc comment for the
 *     accepted-residual honesty).
 *   - Non-registered / pre-signup visitors: excluded, because a nudge only
 *     enqueues for a job whose owner email resolves to a real account
 *     (accountStore.getByEmail). A pre-signup visitor has no account, so
 *     never gets this signed-up-users-only nudge.
 *
 * Video-only scope: an unrecorded/unrecognized mediaType (a job predating this
 * field, or a write that failed) fails CLOSED here, never assumed to be
 * 'video' — see lib/job-owners.js's header comment on why mediaType can't be
 * derived from operationName alone (mock-mode operationNames are identical
 * strings for both kinds).
 */
async function maybeEnqueueUnwatchedNudge(event, operationName) {
  var ownerRecord = await jobOwners.getJobOwnerRecordWithRetry(event, operationName);
  if (!ownerRecord || !ownerRecord.email) {
    await reportEnqueueDecision(operationName, { skipped: 'no_owner' });
    return;
  }
  if (ownerRecord.mediaType !== 'video') {
    await reportEnqueueDecision(ownerRecord.email, { skipped: 'not_video' });
    return;
  }

  // Pre-signup ready-email overlap: skip a funnel-started dream whose
  // abandonment email already sent (readyAt set). See this function's own
  // doc comment for the full guard/reasoning.
  if (ownerRecord.pendingId) {
    var pendingRecord = await pendingDreams.getWithReadyRetry(event, ownerRecord.pendingId);
    if (pendingRecord && pendingRecord.readyAt) {
      await reportEnqueueDecision(ownerRecord.email, { skipped: 'ready_email_overlap' });
      return;
    }
  }

  var account = await accountStore.getByEmail(event, ownerRecord.email);
  if (!account || !account.username) {
    await reportEnqueueDecision(ownerRecord.email, { skipped: 'no_account' });
    return;
  }

  // Idempotent + best-effort — a duplicate call for the SAME operationName
  // is a harmless no-op against the already-ticking window (onlyIfNew CAS),
  // and a failed enqueue is a silent miss for this one nudge (no failure
  // ever surfaces to the caller), same posture as this function's siblings.
  var enqueue = await unwatchedDreamNudgeStore.markPending(event, operationName, account.username, account.email);
  if (enqueue && enqueue.ok) {
    await reportEnqueueDecision(account.username, enqueue.alreadyPending ? { enqueued: true, already_pending: true } : { enqueued: true });
  } else {
    await reportEnqueueDecision(account.username, { skipped: 'enqueue_failed' });
  }
}

/**
 * Durable enqueue-DECISION telemetry (added for the "unwatched nudge went
 * silently dead" root-cause fix — this path fired ZERO sends AND zero skips
 * for 7+ days with no signal at all at the decision point, so there was no
 * way to tell an empty queue from a starved sender from a broken guard).
 * Fires 'unwatched_dream_nudge_enqueue_decision' with { enqueued:true } on a
 * real enqueue, or { skipped:<reason> } for every early-exit guard above
 * ('no_owner' | 'not_video' | 'ready_email_overlap' | 'no_account' |
 * 'enqueue_failed'), so the morning report can WATCH this path and it can
 * never silently die unnoticed again. Best-effort — never throws, never
 * affects the enqueue outcome, same posture as every other analytics-
 * adjacent call in this handler (a distinct_id is always passed: the
 * account username / owner email when known, else the operationName, so the
 * event always has a stable key even in the no-owner branch).
 */
async function reportEnqueueDecision(distinctId, outcome) {
  try {
    await posthogCapture.captureEvent({
      event: 'unwatched_dream_nudge_enqueue_decision',
      distinct_id: distinctId || 'unknown',
      properties: outcome || {}
    });
  } catch (e) { /* analytics must never break the app */ }
}

/**
 * video-ready web push (tracker item for-product-build-stage-0-pwa-web-
 * push-f-jbutt5, part 4) -- fires from the exact same server-verified
 * "a generation just completed" choke point as maybeEnqueueUnwatchedNudge
 * above, resolving the job's owner the identical way (lib/job-owners.js's
 * submission-time binding), but is DELIBERATELY its own independent function
 * with its OWN dedup marker (lib/push-dedup-store.js, keyed by THIS
 * operationName -- see that file's header comment): this push is meant to
 * fire for the specific dream someone is actively waiting on right now
 * ("get notified when your dream is ready" -- every dream, not just an
 * account's first).
 *
 * COORDINATION WITH THE EMAIL CHANNEL (this feature's own explicit ask --
 * "be deliberate about... how do these two channels coordinate", not just
 * fire both blindly): the two channels are independent BY DESIGN, not
 * accidentally uncoordinated -- someone who has both the retention nudge AND
 * a push subscription got voluntarily opted into both channels (the nudge is
 * enqueued for every real account's unwatched dream; push only ever fires for
 * an account that separately, explicitly granted Notification permission --
 * see js/push-subscribe.js), so both landing for the same completion is the
 * intended "second, independent channel" outcome the tracker item asks
 * for, not a double-ping to suppress. What WOULD be a genuine double-ping
 * this still guards against: firing the SAME push twice for the SAME
 * completion (a retried mark-generation-completed call, or two browser
 * tabs racing) -- that's exactly what push-dedup-store's per-operationName
 * marker exists to prevent, independent of anything the email side does.
 *
 * Every branch below is a silent no-op (never an error, never a
 * distinguishable HTTP response) -- same "this is best-effort bookkeeping,
 * not a user-facing contract" posture as maybeEnqueueUnwatchedNudge above:
 * no owner record, non-video media type, no registered account, no
 * push subscription on file, or an already-claimed dedup marker for this
 * exact operationName all mean simply "no push this time."
 */
async function maybeSendVideoReadyPush(event, operationName) {
  var ownerRecord = await jobOwners.getJobOwnerRecord(event, operationName);
  if (!ownerRecord || !ownerRecord.email) return;

  // Same video-only scope as the retention nudge (an unrecorded/unrecognized
  // mediaType fails CLOSED, never assumed to be 'video') -- matches this
  // feature's own "video-ready" naming; an image generation's completion
  // isn't covered by this push type.
  if (ownerRecord.mediaType !== 'video') return;

  var account = await accountStore.getByEmail(event, ownerRecord.email);
  if (!account || !account.username) return;

  var dedupKey = 'video-ready:' + operationName;
  var claim = await pushDedupStore.markSentOnce(event, dedupKey);
  if (!claim.ok) return; // already sent for this exact completion, or the dedup store failed closed -- either way, don't send

  await pushSender.sendToUser(event, account.username, {
    title: 'Your dream is ready',
    body: 'Tap to watch what you just created.',
    url: './profile.html',
    type: pushSender.PUSH_TYPES.VIDEO_READY
  });
}

// Exposed for direct unit testing of the verification logic in isolation
// (test/generation-completion-marker.test.js) -- not used by any other
// production caller.
exports.verifyOperationCompleted = verifyOperationCompleted;
// Exposed for direct unit testing (test/video-ready-push.test.js) -- not
// used by any other production caller.
exports.maybeSendVideoReadyPush = maybeSendVideoReadyPush;
