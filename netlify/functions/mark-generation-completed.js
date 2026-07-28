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
// AUTOMATIC FIRST-DREAM RETENTION EMAIL (added 2026-07-27, tracker.html's
// for-product-activate-automatic-retention-4n74rw item, founder-approved
// -- "start sending... AUTOMATICALLY... do not wait for manual
// triggering"): this is THE genuine, singular, server-verified
// "generation just completed" choke point for every generation path this
// app has that ends with the browser landing on processing.html --
// fresh video, regenerate, reference-to-video, image-to-video, and image
// generation for an already-signed-in account (generate-video.js/
// generate-image.js's own recordJobOwnerBestEffort call at submission
// time), AND the dream-builder wizard's pre-signup "generate during
// signup" funnel path (start-pending-generation.js) once its generation
// is claimed by a real signup and the SAME browser continues on to
// processing.html exactly like the normal path -- see that file's own
// recordJobOwnerBestEffort (added for tracker.html's
// for-product-bug-founder-affects-all-funn-0efe7t fix, 2026-07-28) for why
// it now also writes to this same lib/job-owners.js store at its own
// submission time, rather than only the two signed-in-generation files
// above. (CORRECTED 2026-07-28 -- this paragraph used to describe the
// funnel path as covered ONLY by dream-webhook.js's separate webhook
// below, which was true for the *abandoned* case but silently implied the
// *completed* funnel case had no job-owners record at all and therefore
// no automatic email either -- that was the actual bug, not a documented
// design choice; see start-pending-generation.js's own header comment for
// the full root-cause writeup.) There is genuinely no real fal WEBHOOK for
// any of the signed-in-generation paths -- dream-webhook.js is fal's only
// actual webhook target in this app, and it's wired ONLY to the funnel's
// own pre-signup ABANDONED-dream flow (see generate-video.js's own
// withWebhook comment). Keeping a completed funnel user from getting
// BOTH emails is a two-sided guarantee, not just dream-webhook.js's own
// half: its "already-claimed skips the send" handling covers a claim
// landing BEFORE the webhook; maybeSendAutomaticFirstDreamEmail's own
// pendingId/readyAt check below (review-round-1 fix, 2026-07-28) covers
// the OPPOSITE, fully-sequential ordering -- the webhook fully notifying
// (abandonment email already sent) BEFORE the user's own claim -- which
// is easily reachable in normal usage, not a rare race, since Veo takes
// 1-6 minutes and pending-dreams.js's markClaimed is explicitly allowed
// to succeed from 'notified'. So this client-polled-then-server-
// re-verified endpoint IS the closest thing to a real completion signal
// this app has for every one of these paths, exactly the choke point the
// tracker item asked to trace and confirm before wiring into.
//
// Once `verified` is true below, this independently resolves WHO owns
// `operationName` via lib/job-owners.js's getJobOwnerRecord (recorded at
// SUBMISSION time, never anything this request itself claims) and, for a
// real registered account whose recorded mediaType is 'video' (matching
// the retention email's own long-established video-only scope --
// see send-first-dream-email.js's header comment; an unrecorded/unknown
// mediaType fails closed here, never assumed to be video), calls the
// exact same guarded lib/first-dream-email-sender.js core
// send-first-dream-email.js itself calls. This needs NO password and NO
// client-claimed identity at all -- ownership is proven purely by
// knowing operationName (server-issued, unguessable, independently
// re-verified as genuinely completed above) plus the submission-time
// job-owners binding, a strictly STRONGER identity proof than the
// password re-check the client-triggered endpoint needs, not a weaker
// one. Awaited (not fire-and-forget) so this function's own invocation
// doesn't return before the send genuinely completes or fails -- same
// "await the notification best-effort, inside a try/catch, before
// returning" discipline dream-webhook.js's own sendReadyEmail already
// uses for its webhook handler. Never turns into a distinguishable
// response either way (see the E-code list below): a real completion
// marker write always succeeds or fails on its own terms, independent of
// whatever happens to this bonus email step.
//
// Rate limiting: same reasoning as track-conversion.js -- a public,
// unauthenticated endpoint, so a per-IP daily cap guards against someone
// scripting pointless requests. Not the actual security boundary (that's
// verifyOperationCompleted below) -- just cheap hygiene consistent with
// this codebase's other public endpoints. The retention-email send this
// endpoint may now also trigger needs no SEPARATE rate limit of its own:
// it can fire at most once per real account ever (lib/first-dream-email-
// store.js's atomic guard), so this endpoint's existing per-IP cap on
// mark ATTEMPTS already bounds it.
//
// Error codes (local to this small function):
//   E1 method_not_allowed
//   E2 invalid_json
//   E3 missing_operation_name
//   E4 rate_limited

var generationCompletionStore = require('./lib/generation-completion-store');
var jobOwners = require('./lib/job-owners');
var accountStore = require('./lib/account-store');
var firstDreamEmailSender = require('./lib/first-dream-email-sender');
var rateLimit = require('./lib/rate-limit');
var posthogCapture = require('./lib/posthog-capture');
var pendingDreams = require('./lib/pending-dreams');

/**
 * Best-effort 'first_dream_email_skipped' fire for maybeSendAutomaticFirst
 * DreamEmail's own early-return branches (see that function's doc comment)
 * -- distinct from, and fired BEFORE ever reaching, lib/first-dream-email-
 * sender.js's own identically-named event/reportSkip, since these three
 * branches return before that shared core is ever called at all. Same
 * distinct_id-fallback precedent as that file's reportSkip (and
 * video-status.js's refundAndReport before it): falls back to whatever
 * identifying string is on hand, since a resolved account (and its raw
 * username -- the real posthog.identify() convention) doesn't exist yet at
 * this point for two of these three branches.
 */
async function reportAutoSkip(emailOrNull, reason) {
  try {
    await posthogCapture.captureEvent({
      event: 'first_dream_email_skipped',
      distinct_id: emailOrNull || 'unknown',
      properties: { reason: reason, auto: true }
    });
  } catch (e) { /* analytics must never break the app */ }
}

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
      // Best-effort, awaited (see header comment on why) -- a failure
      // anywhere in here must never affect the completion marker just
      // written above, which is why it's wrapped in its own try/catch
      // rather than sharing the outer one's fate.
      try {
        await maybeSendAutomaticFirstDreamEmail(event, operationName);
      } catch (emailErr) {
        console.error('mark-generation-completed: automatic first-dream email step failed (non-fatal)', emailErr);
      }
    }
    // An operationName that doesn't verify is a silent no-op -- see header
    // comment on why this never surfaces as a distinguishable response.
  } catch (e) {
    // Best-effort, same philosophy as send-first-dream-email.js -- never
    // let this surface as a failure to the caller. A failure here just
    // means this specific completion's FirstVideoCreated fire may be
    // missed, the same honest degrade the old sessionStorage marker
    // already accepted when storage was disabled.
    console.error('mark-generation-completed: unexpected error', e);
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};

/**
 * Resolves `operationName`'s real owner (lib/job-owners.js, recorded at
 * submission time) and, if it's a real registered account whose recorded
 * mediaType is 'video', fires the guarded first-dream retention-email
 * send -- see this file's own "AUTOMATIC FIRST-DREAM RETENTION EMAIL"
 * header comment for the full reasoning. Every branch below is a plain,
 * silent no-op (never an error, never a distinguishable response) -- see
 * that same header comment for why: a job-owners record missing/failed to
 * write, an email that doesn't resolve to a real account (a local-only
 * legacy account never backfilled server-side, see
 * js/store.js's backfillAccountServerSide), or a non-video mediaType (or
 * one recorded before this field existed) all mean simply "no automatic
 * email this time," not a failure worth surfacing anywhere.
 *
 * Caption/style are deliberately NOT passed through here (see
 * lib/first-dream-email-sender.js's own header comment) -- this choke
 * point only ever independently re-verifies a job's completion STATUS,
 * never fetches its full result payload, so there is nothing to
 * personalize with without accepting new client-trusted input at exactly
 * the one place in this feature that currently needs none at all.
 *
 * SILENT-SKIP TELEMETRY (tracker.html's for-product-bug-founder-affects-
 * all-funn-0efe7t item, gap #6): each of these no-op branches now ALSO
 * fires 'first_dream_email_skipped' server-side (lib/posthog-capture.js —
 * same helper/pattern dodo-webhook.js's/video-status.js's own server-side
 * fires already use) before returning, so a silent no-op is at least
 * visible in PostHog instead of only ever a console.log line nobody's
 * watching in production. Still never a distinguishable HTTP response —
 * see this file's own top-level header comment on why that stays true —
 * this is observability, not a behavior/contract change.
 *
 * DOUBLE-SEND FIX (review round 1, 2026-07-28, same tracker item): the
 * root-cause fix that made this function ever resolve an owner for a
 * funnel-started job at all (start-pending-generation.js now recording
 * one, see lib/job-owners.js's own header comment) opened a NEW gap for
 * the funnel path specifically -- dream-webhook.js's SEPARATE abandonment
 * "your dream is ready" email can have already sent for this exact dream
 * BEFORE the user ever finishes signup (fully sequential, not just a
 * race: Veo takes 1-6 minutes, plenty of time for the webhook to reach
 * 'ready'/'notified' while the user is still mid-wizard; pending-dreams.js's
 * own markClaimed is explicitly allowed to succeed from 'notified' --
 * "claiming after the re-engagement email already fully went out is still
 * meaningful bookkeeping"). If the automatic retention email fired
 * unconditionally after that, the same address gets two emails for one
 * dream, violating the founder's "exactly one, never two" decision.
 *
 * Closed via `ownerRecord.pendingId` (only ever present for a funnel-
 * started job -- see lib/job-owners.js's own header comment): looks the
 * pending-dreams record back up and skips the automatic send if its
 * `readyAt` is set. `readyAt` (not `status`) is the right field to check
 * here: it's written atomically the INSTANT dream-webhook.js's markReady
 * succeeds, before the abandonment email's own Resend network round trip
 * even starts (so this also closes the narrower window where the webhook
 * has committed to sending but hasn't finished sending yet), and --
 * unlike `status` -- it is NEVER cleared by a later markClaimed
 * transition (pending-dreams.js's tryTransition only overwrites the
 * fields its own patch supplies, so `readyAt` survives the record's
 * status moving on from 'ready'/'notified' to 'claimed'). A record with
 * no `pendingId` (every normal signed-in generate-video.js/generate-
 * image.js job) or one whose pending-dreams record was never marked ready
 * skips this check entirely and behaves exactly as before.
 */
async function maybeSendAutomaticFirstDreamEmail(event, operationName) {
  var ownerRecord = await jobOwners.getJobOwnerRecord(event, operationName);
  if (!ownerRecord || !ownerRecord.email) {
    // No recorded owner -- nothing to do (see header comment). No
    // resolvable identity at all here, so distinct_id falls back to
    // 'unknown' (see reportAutoSkip below) -- same as the automatic path's
    // shared reportSkip in lib/first-dream-email-sender.js.
    await reportAutoSkip(null, 'no_job_owner_record');
    return;
  }

  // Video-only scope, matching send-first-dream-email.js's own documented
  // scope decision -- an unrecorded/unrecognized mediaType (a job
  // predating this field, or a write that failed) fails CLOSED here
  // (no auto-send), never assumed to be 'video'. See lib/job-owners.js's
  // header comment on why mediaType can't be derived from operationName
  // alone (mock-mode operationNames are identical strings for both kinds).
  if (ownerRecord.mediaType !== 'video') {
    await reportAutoSkip(ownerRecord.email, 'non_video_media_type');
    return;
  }

  // See "DOUBLE-SEND FIX" above -- only ever populated for a funnel-
  // started job (start-pending-generation.js), so this is a pure no-op
  // (the pending-dreams lookup is skipped entirely) for the primary
  // signed-in generation path.
  if (ownerRecord.pendingId) {
    var pendingRecord = await pendingDreams.get(event, ownerRecord.pendingId);
    if (pendingRecord && pendingRecord.readyAt) {
      await reportAutoSkip(ownerRecord.email, 'abandonment_email_already_sent');
      return;
    }
  }

  var account = await accountStore.getByEmail(event, ownerRecord.email);
  if (!account || !account.username) {
    // No real registered account behind this email -- nothing safe to
    // send to (a local-only legacy account never backfilled server-side).
    await reportAutoSkip(ownerRecord.email, 'no_matching_account');
    return;
  }

  await firstDreamEmailSender.sendIfEligible(event, {
    username: account.username,
    email: account.email,
    dreamId: null,
    auto: true
  });
}

// Exposed for direct unit testing of the verification logic in isolation
// (test/generation-completion-marker.test.js) -- not used by any other
// production caller.
exports.verifyOperationCompleted = verifyOperationCompleted;
