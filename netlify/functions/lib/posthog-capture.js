// netlify/functions/lib/posthog-capture.js
//
// Server-side PostHog event capture — the missing server-side half of this
// codebase's PostHog wiring. Before this file, PostHog was fired
// client-only, everywhere, via each page's own local `track()` helper
// calling window.posthog.capture() (see docs/EVENT_TAXONOMY.md). That's a
// real gap for anything whose true source of truth is a server event (a
// webhook, a Netlify Function) rather than a browser page load — see
// dodo-webhook.js's Purchase fire, the first caller of this helper, for
// exactly why (misses reloads, cross-device returns, and closed tabs the
// client-side purchase_completed event can never see).
//
// No PostHog server SDK (posthog-node) is installed — this codebase has no
// build step / npm bundling story for a heavier server SDK beyond what's
// already a plain require()-able dependency (see CLAUDE.md), so this is
// instead a thin, dependency-free POST straight to PostHog's public HTTP
// "capture" endpoint (https://posthog.com/docs/api/capture), which is all
// posthog-node itself does under the hood anyway for a single event.
//
// POSTHOG_KEY/POSTHOG_HOST are require()'d from js/analytics-config.js —
// the same single source of truth the client-side <script> snippet on
// every page already reads, and the exact precedent
// netlify/functions/lib/meta-capi.js already set for META_PIXEL_ID (see
// that file's header comment for the full "why one place, not two"
// reasoning, and analytics-config.js's own comment on the UMD-lite
// module.exports guard that makes this require() safe under Node without
// changing how that file behaves as a plain <script> global in the
// browser). Neither value is secret — PostHog's "project API key" is
// designed to be public/embeddable (see https://posthog.com/docs/api) —
// so, like META_PIXEL_ID, there's no concern about this constant being
// require()-able server-side.
//
// distinct_id discipline: this MUST match whatever the client uses, so a
// server-fired event ties to the same PostHog person as that user's
// browser session. The client identifies via
// window.posthog.identify(usernameOrEmail) with the account's raw username
// (no leading '@' — see js/store.js's identifyForAnalytics, called at
// every signup/login site with `username`, never `state.user.handle`).
// Every caller of captureEvent() below must resolve and pass that same raw
// username as distinct_id — resolving it from an email via
// lib/account-store.js's getByEmail when only an email is on hand (e.g.
// dodo-webhook.js, which only ever hears a Payment's email, never a
// username) — never a bare email or an '@'-prefixed handle.
//
// $insert_id: PostHog's own documented event-deduplication mechanism
// (https://posthog.com/docs/data/deduplication) — passing the same
// properties.$insert_id twice within its dedup window collapses to one
// counted event. This is PostHog's equivalent of Meta's Pixel+CAPI
// event_id dedup (see lib/meta-capi.js's header comment) — callers that
// need to dedupe a server-side fire against an existing (or potential)
// client-side fire of the same real-world event should set
// properties.$insert_id to that shared event_id.
//
// Fire-and-forget discipline, same as every other analytics call in this
// codebase ("analytics must never break the app"): every failure mode here
// — missing/placeholder key, a non-2xx response, the fetch itself
// rejecting — is caught and returned as { ok: false, error }, never thrown.
// Callers still choose not to `await` this (or to await but ignore the
// result) when the calling request's own success must never depend on
// PostHog being reachable — see dodo-webhook.js for the pattern.

// ── TEST-ENVIRONMENT GUARD (tracker.html's
//    for-product-bug-founder-affects-all-funn-0efe7t item, round 4) ──
//
// POSTHOG_KEY below is require()'d from a CHECKED-IN file, not read from an
// environment variable (see the header comment above for why that was a
// deliberate choice). The unintended consequence: this module fires REAL
// events into the founder's REAL production PostHog project from ANY
// process that require()s it and has network access — including a plain
// local `npm test` run. That is not hypothetical. Measured on this branch,
// before this guard, every single `npm test` run POSTed 10 real events to
// us.i.posthog.com:
//   - 5 x first_dream_email_skipped { reason:'no_job_owner_record',
//     auto:true, distinct_id:'unknown' }, from
//     test/generation-completion-marker.test.js driving the real
//     mark-generation-completed handler with no job-owners record seeded;
//   - 5 x push_sent to the fixture usernames alice/frank/grace/henry, from
//     test/send-daily-claim-pushes.test.js (which mocks web-push, but had
//     nothing mocking this).
//
// Those two signatures are EXACTLY the production "anomalies" that drove
// three rounds of misdiagnosis on this tracker item: the reported
// "machine-generated skip storm — 1,002 first_dream_email_skipped events in
// metronomic 5-10/min bursts, something is hammering
// mark-generation-completed", the founder-QA trace's "two bursts of ~5 rapid
// no_job_owner_record events, distinct_id=unknown", and "395 push_sent in
// 16h to 4 test-fixture accounts (alice/frank/grace/henry) — dedup store not
// working". None of those were production traffic. They were this repo's own
// test suite, run over and over by the build/review rounds themselves, and
// they are indistinguishable in PostHog from real user events.
//
// So this is not merely tidiness — analytics contamination is a correctness
// bug in the one instrument this feature is being debugged with. Guarded
// here, in the one module every server-side fire goes through, rather than
// only in the two offending test files (those are fixed too, but a
// per-test-file fix silently rots the moment someone adds a new test that
// exercises a new server path — the recurring "new store forgets the shared
// pattern" shape this codebase has already been bitten by, see
// lib/blobs-retry.js's header comment).
//
// Deliberately FAIL-SAFE for production: the guard only ever triggers on a
// positive, unambiguous signal that this is a local test process. There is
// no signal a deployed Netlify Function could plausibly present:
//   - NODE_TEST_CONTEXT is set (to 'child-v8'/'child-tap') by Node's own
//     `node --test` runner in the child process it runs each test file in —
//     verified directly against this repo's `npm test` invocation. Nothing
//     sets it in a Lambda runtime.
//   - process.argv[1] ending in `.test.js` catches running a single test
//     file directly (`node test/foo.test.js`), which the runner var misses.
//   - DREAMTUBE_DISABLE_SERVER_ANALYTICS=1 is an explicit manual override
//     for any other non-production context (a scratch script, a staging
//     replay) where firing real events would pollute the same project.
// Absent all three, behavior is byte-for-byte what it was before, so a real
// deploy cannot accidentally silence itself. The inverse design (fire ONLY
// when some NETLIFY/AWS_LAMBDA_* var is present) was rejected for exactly
// that reason: getting that variable wrong would silently kill ALL
// server-side analytics in production, an invisible, far worse failure than
// the one being fixed, and it can't be verified from this sandbox.
//
// DREAMTUBE_ALLOW_SERVER_ANALYTICS=1 forces fires back on even under the
// above, for the one legitimate case: a deliberate staged/end-to-end run
// that genuinely wants to see its events land in PostHog.
function isNonProductionRun() {
  if (process.env.DREAMTUBE_ALLOW_SERVER_ANALYTICS === '1') return false;
  if (process.env.DREAMTUBE_DISABLE_SERVER_ANALYTICS === '1') return true;
  if (process.env.NODE_TEST_CONTEXT) return true;
  var entry = process.argv && process.argv[1];
  if (typeof entry === 'string' && /\.test\.js$/.test(entry)) return true;
  return false;
}

// Suppression below is deliberately scoped to "a test process that is about
// to make a genuinely REAL outbound request", not "a test process" flatly.
// Several tests in this suite legitimately assert that a given event fires,
// and they do it the way this codebase has always done it: by replacing
// global.fetch with a recording double and inspecting what it received (see
// test/automatic-first-dream-email.test.js, test/dodo-webhook.test.js,
// test/video-status-refund.test.js, test/image-status-refund.test.js,
// test/video-ready-push.test.js). Those tests are not the problem — nothing
// leaves the process — and they must keep working. The leak was always the
// opposite case: a server path firing analytics while global.fetch is still
// the REAL one, so the request genuinely goes out.
//
// Those two cases are told apart by an explicit marker the recording double
// sets on itself (`fetch.__dreamtubeTestDouble = true`), rather than by
// comparing against whatever `globalThis.fetch` happened to be when this
// module first loaded. That comparison was tried first and is genuinely
// unsound: several test files install their double BEFORE the require() that
// first pulls this module in, so the "native" reference captured here would
// be the double itself, and every fire would then be wrongly suppressed.
// Load order is not something a shared lib can reason about.
//
// The marker is fail-safe in the direction that matters: FORGETTING it means
// a fire is suppressed, and the forgetful test's own assertion fails loudly
// and locally. There is no way to forget it into a silent production-data
// leak, which is the failure this whole guard exists to make impossible.
var TEST_DOUBLE_MARKER = '__dreamtubeTestDouble';

/** True when firing right now would put a real request on the wire from a non-production process. */
function wouldEscapeToRealNetwork() {
  if (!isNonProductionRun()) return false;
  var f = typeof globalThis !== 'undefined' ? globalThis.fetch : undefined;
  return !(f && f[TEST_DOUBLE_MARKER] === true);
}

var POSTHOG_KEY = require('../../../js/analytics-config').POSTHOG_KEY;
var POSTHOG_HOST = require('../../../js/analytics-config').POSTHOG_HOST;

/**
 * Captures one PostHog event server-side via PostHog's public HTTP capture
 * API. `params`:
 *   event        (required) — event name, e.g. 'purchase_completed'
 *   distinct_id  (required) — MUST match the client's posthog.identify()
 *                 value (the account's raw username) — see header comment
 *   properties   (optional object) — event properties, passed through as-is
 *                 (set $insert_id here for dedup against a paired
 *                 client-side fire — see header comment)
 *   timestamp    (optional) — epoch ms or anything `new Date()` accepts;
 *                 defaults to now
 * Returns a Promise of { ok: true } or { ok: false, error }. Never rejects.
 */
async function captureEvent(params) {
  params = params || {};

  if (!POSTHOG_KEY) {
    return { ok: false, error: 'missing_posthog_key' };
  }
  // See "TEST-ENVIRONMENT GUARD" above. Returned as a normal { ok:false,
  // error } value, exactly like every other non-fire branch here, so no
  // caller's control flow changes — every one of them already treats this
  // as fire-and-forget/best-effort.
  if (wouldEscapeToRealNetwork()) {
    return { ok: false, error: 'suppressed_non_production_run' };
  }
  if (!params.event || !params.distinct_id) {
    return { ok: false, error: 'event_and_distinct_id_required' };
  }

  var body = {
    api_key: POSTHOG_KEY,
    event: params.event,
    distinct_id: params.distinct_id,
    properties: params.properties || {},
    timestamp: new Date(params.timestamp || Date.now()).toISOString()
  };

  try {
    var res = await fetch(POSTHOG_HOST + '/capture/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      var text = '';
      try { text = await res.text(); } catch (e2) { /* best-effort detail only */ }
      return { ok: false, error: 'posthog_request_failed: ' + res.status + (text ? ' ' + text : '') };
    }

    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'posthog_network_failure' + (e && e.message ? ': ' + e.message : '') };
  }
}

// isNonProductionRun/wouldEscapeToRealNetwork are exported purely so
// test/server-analytics-containment.test.js can assert the guard's own signal
// handling directly, rather than only observing its effect through a spy.
module.exports = {
  captureEvent: captureEvent,
  isNonProductionRun: isNonProductionRun,
  wouldEscapeToRealNetwork: wouldEscapeToRealNetwork
};
