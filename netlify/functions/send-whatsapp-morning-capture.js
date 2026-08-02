// netlify/functions/send-whatsapp-morning-capture.js
//
// The WhatsApp channel for the Morning Capture Ritual (morning-mock-
// x7q4.html's Tab A "Quiet Knock" — the founder-approved capture-first
// direction, Tab C's WhatsApp-channel variant) — tracker item for-product-
// build-whatsapp-morning-captu-skez3n, steps 3-4. Sends the daily "Good
// morning {{1}} — what did you dream? It's already fading. Tap below and
// just speak it." template message (Speak / No-recall buttons, per the
// founder-drafted copy in that tracker item) to every account that has
// opted in via profile.html's Settings sheet (save-whatsapp-number.js /
// lib/account-store.js's whatsappNumber field).
//
// A SECOND, SEPARATE WhatsApp integration — deliberately, not a
// consolidation of the existing one: lib/whatsapp-client.js already wraps
// the Cloud API, but for a genuinely different feature (dream-webhook.js's
// one-shot abandoned-cart re-engagement send, a plain free-form TEXT
// message to pending-dreams.js's `whatsapp` field, itself unreachable
// today — wizard.html's capture UI for that field is PARKED, see this
// file's own account-store.js header comment). This is a recurring DAILY
// message to an explicit, standing account-level opt-in, sent as an
// approved message TEMPLATE (required by WhatsApp's 24-hour customer-
// service-window rule for the first message to someone who hasn't
// messaged the business number first — see lib/whatsapp-client.js's own
// TODO for the same rule, never actually wired around there either).
// Reusing that file's isConfigured()/sendMessage() shape here would either
// widen its env-var contract to mean two different things
// (WHATSAPP_BUSINESS_PHONE_ID for an abandoned-cart text vs. a phone
// number id for a template send) or bolt a second, incompatible message
// TYPE onto a function whose whole existing contract is "plain text" — a
// real, deliberate split, not an oversight; see account-store.js's own
// header comment on the two `whatsapp`/`whatsappNumber` fields for the
// account-schema half of this same reasoning.
//
// ENV VARS (all three required — see isConfigured() below; this function
// is a soft-fail no-op until every one of them is set):
//   WHATSAPP_ACCESS_TOKEN — already set in Netlify (a temporary, 24h
//     token as of this build; the code doesn't know or care whether it's
//     temporary or permanent — swapping to a permanent system-user token
//     is a human, Meta-Business-Settings step, tracked separately, NOT
//     done by this code). Same env var name lib/whatsapp-client.js also
//     reads — both integrations share ONE real Meta Business app/token,
//     they just each have their OWN phone-number-id/message-shape.
//   WHATSAPP_PHONE_NUMBER_ID — the Cloud API "Phone number ID" for the
//     founder's WhatsApp Business number (1022231790969271 as of this
//     build) — a NEW env var this file introduces, deliberately NOT
//     reusing lib/whatsapp-client.js's WHATSAPP_BUSINESS_PHONE_ID name
//     (same real number, but keeping the two integrations' env vars
//     separate avoids one accidentally being configured/broken by a
//     change meant for the other).
//   WHATSAPP_TEMPLATE_NAME_MORNING_CAPTURE — the Meta-approved template's
//     name. Not knowable yet (template approval is a pending, external,
//     human/Meta-review-queue step, explicitly NOT this code's job — see
//     this file's own tracker item) — reading it from an env var, exactly
//     like create-checkout-session-dodo.js reads DODO_PRODUCT_PACK_* (see
//     that file's own header comment), means flipping this on later is
//     just setting one Netlify env var, no code/deploy needed. The
//     template's actual approved component structure may differ from the
//     drafted copy above — sendMorningCaptureMessage below passes through
//     a generic `{ firstName }` -> body {{1}} mapping rather than
//     hardcoding any more specific assumption about the final shape.
//
// SOFT-FAIL CONTRACT: sendMorningCaptureMessage NEVER throws. Every
// failure mode (unset config, a Graph API error, a network failure)
// resolves to { ok:false, reason }, logged via console.error where it's a
// genuine failure (never for the expected "not configured yet" state,
// which logs at console.log instead) — this mirrors this codebase's other
// "never break anything else for a background/best-effort messaging
// concern" postures (lib/media-rehost.js, lib/first-dream-email-store.js's
// markSentOnce — see that file's own header comment) and specifically
// lib/whatsapp-client.js's OWN identical "isConfigured() gate, never
// throws" shape, just for a template send instead of a plain-text one.
//
// DEDUP: reuses lib/push-dedup-store.js — see that file's own header
// comment for the full "why a generic, caller-owns-key-semantics store"
// reasoning, and specifically its note that a NEW key scope needs a fresh,
// clearly-different key shape from the two existing ones (the retention
// email's once-EVER-per-account marker, the video-ready push's once-PER-
// EVENT marker). This message is a recurring DAILY send, so its own key —
// 'whatsapp-morning-capture:' + username + ':' + <today's UTC date,
// YYYY-MM-DD> — is scoped PER CALENDAR DAY, not per-account-forever
// (send-daily-claim-pushes.js's own 'daily-claim-available:' key is the
// closest existing precedent: a key that changes on its own natural
// cadence rather than firing once ever). A fresh key every UTC day means
// this job can safely re-scan every opted-in account on every run without
// ever double-sending for the same day, and naturally sends again the
// next day with no separate "reset" step needed.
//
// SCHEDULING: this repo's SECOND scheduled Netlify Function (see
// send-daily-claim-pushes.js's own header comment for the first, and its
// "why declared both in netlify.toml AND via this file's own inline
// schedule() wrapper" belt-and-suspenders reasoning, which applies here
// identically). Fires once daily at a single fixed UTC hour (13:00 UTC —
// see SCHEDULE_CRON below) — a KNOWN SIMPLIFICATION: this codebase has no
// per-user timezone on file anywhere (js/store.js's account model never
// captured one), so there is no way yet to fire this at each user's own
// local "morning". A single fixed UTC time is a reasonable placeholder
// (roughly morning across US timezones, the app's primary audience today)
// but not a real per-user morning trigger; a follow-up once real usage
// data or a captured timezone exists would move this to a per-user send
// window, same spirit as send-daily-claim-pushes.js's own documented
// "fine at current scale" tradeoff.
//
// THIRD, INDEPENDENT CHANNEL, NOT A DISPATCH HUB: there is no existing
// server-side "morning ritual" dispatch mechanism in this codebase to plug
// into — morning-mock-x7q4.html is a static founder-review mock only (see
// its own header comment), and grepping this repo for "morning ritual" /
// "retention sprint" server-side code (as this build's own tracker item
// asks) turns up no scheduled email/push morning-capture sender yet
// either. So this file doesn't wire into anything that already exists —
// it correctly IS the first scheduled sender for this ritual, built to
// slot in as one of N independent channels exactly the way
// lib/push-dedup-store.js's own header comment describes push/email
// coordinating today: each channel decides independently whether to fire
// (its own opt-in check: `record.whatsappNumber` here) and marks its own,
// separately-scoped dedup marker (this file's own
// 'whatsapp-morning-capture:' key prefix, never shared with a future
// email/push morning-capture sender's own key). A future email or push
// morning-capture channel is a straightforward sibling scheduled function
// following this exact same shape, not a change to this file.

var { schedule } = require('@netlify/functions');
var { getStore, connectLambda } = require('@netlify/blobs');
var accountStore = require('./lib/account-store');
var pushDedupStore = require('./lib/push-dedup-store');

var GRAPH_API_BASE = 'https://graph.facebook.com/v20.0';

// 13:00 UTC daily -- see this file's own SCHEDULING header note.
var SCHEDULE_CRON = '0 13 * * *';

function looksUnset(value) {
  return typeof value !== 'string' || !value.trim();
}

/**
 * True only once every env var this sender needs is actually set — see
 * this file's own ENV VARS header comment. Deliberately checks all three
 * independently rather than short-circuiting on the first missing one, so
 * a caller/test can tell exactly which piece is still missing if it wants
 * to (sendMorningCaptureMessage below does inspect each one individually
 * for that reason, even though this helper collapses them to one
 * boolean).
 */
function isConfigured() {
  return !looksUnset(process.env.WHATSAPP_ACCESS_TOKEN) &&
    !looksUnset(process.env.WHATSAPP_PHONE_NUMBER_ID) &&
    !looksUnset(process.env.WHATSAPP_TEMPLATE_NAME_MORNING_CAPTURE);
}

/**
 * Sends the morning-capture template message to `to` (must already be
 * E.164 — see account-store.js's normalizeWhatsappNumber; this function
 * does not re-validate). `firstName` is mapped into the template's body
 * {{1}} variable; falls back to "there" when empty/not a string so a real
 * send is never missing a variable value.
 *
 * NEVER THROWS — see this file's own SOFT-FAIL CONTRACT header comment.
 * Resolves to one of:
 *   { ok:false, reason:'no_recipient' }     — no `to` given.
 *   { ok:false, reason:'not_configured' }   — one or more of
 *     WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID /
 *     WHATSAPP_TEMPLATE_NAME_MORNING_CAPTURE isn't set yet. Logged at
 *     console.log (expected state, not an error) until the founder
 *     finishes the two external Meta steps this build deliberately does
 *     NOT attempt (permanent token, approved template).
 *   { ok:false, reason:'graph_api_error', status } — the Graph API call
 *     itself returned a non-2xx (invalid/expired token, template not yet
 *     approved, rate limit, etc.). Logged at console.error.
 *   { ok:false, reason:'unexpected_error' } — the fetch itself threw
 *     (network failure, etc). Logged at console.error.
 *   { ok:true, messageId }                  — sent for real.
 */
async function sendMorningCaptureMessage(to, firstName) {
  if (!to) return { ok: false, reason: 'no_recipient' };

  var token = process.env.WHATSAPP_ACCESS_TOKEN;
  var phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  var templateName = process.env.WHATSAPP_TEMPLATE_NAME_MORNING_CAPTURE;

  if (looksUnset(token) || looksUnset(phoneNumberId) || looksUnset(templateName)) {
    console.log('send-whatsapp-morning-capture: not configured yet (need WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, and WHATSAPP_TEMPLATE_NAME_MORNING_CAPTURE all set) -- skipping send. Expected until the founder finishes the two external Meta steps (permanent system-user token, an approved message template) this build deliberately leaves for a human.');
    return { ok: false, reason: 'not_configured' };
  }

  var name = (typeof firstName === 'string' && firstName.trim()) ? firstName.trim() : 'there';

  try {
    var res = await fetch(GRAPH_API_BASE + '/' + phoneNumberId + '/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: to,
        type: 'template',
        template: {
          name: templateName,
          language: { code: 'en_US' },
          // Generic body-variable passthrough (see this file's own ENV
          // VARS comment on WHATSAPP_TEMPLATE_NAME_MORNING_CAPTURE) --
          // maps `firstName` into the template's own {{1}}, without
          // assuming anything more specific about the final approved
          // template's component structure (button components, if the
          // approved template has any, need no `components` entry here at
          // all -- WhatsApp only requires an entry for a component that
          // carries a dynamic {{n}} variable).
          components: [
            { type: 'body', parameters: [{ type: 'text', text: name }] }
          ]
        }
      })
    });
    var data = null;
    try { data = await res.json(); } catch (parseErr) { data = null; }
    if (!res.ok) {
      console.error('send-whatsapp-morning-capture: Graph API error', res.status, data);
      return { ok: false, reason: 'graph_api_error', status: res.status };
    }
    var messageId = data && data.messages && data.messages[0] && data.messages[0].id;
    return { ok: true, messageId: messageId || null };
  } catch (e) {
    console.error('send-whatsapp-morning-capture: unexpected error calling the Graph API', e);
    return { ok: false, reason: 'unexpected_error' };
  }
}

/**
 * Scans every account record for an opted-in `whatsappNumber` and sends
 * today's morning-capture message to each one not already dedup-marked
 * for today. Exposed separately from `exports.handler` so
 * test/send-whatsapp-morning-capture.test.js can call it directly with a
 * mocked event/stores, same convention as send-daily-claim-pushes.js's own
 * scanAndSend/exports.handler split.
 *
 * O(n) full-store scan over lib/account-store.js's own "dreamtube-
 * accounts" Blobs store, filtered to "u:"-prefixed keys (the real account
 * records — "e:"/"f:" are that store's own secondary indexes, never
 * accounts themselves; see account-store.js's header comment). Same
 * accepted "fine at current scale, would need a real index once this store
 * holds many thousands of records" tradeoff send-daily-claim-pushes.js's
 * own header comment documents for its identical scan shape.
 */
async function scanAndSend(event) {
  connectLambda(event);
  var store = getStore({ name: accountStore.STORE_NAME });
  var listResult = await store.list({ prefix: 'u:' });

  var today = new Date().toISOString().slice(0, 10); // UTC calendar day, e.g. "2026-08-02"
  var scanned = 0;
  var sent = 0;
  var skipped = 0;

  for (var i = 0; i < listResult.blobs.length; i++) {
    var key = listResult.blobs[i].key;
    // Defensive re-check even with the {prefix:'u:'} list() option above --
    // never trust a list() result to have actually been filtered (this
    // repo's own test/helpers/mock-blobs.js fake, for one, ignores
    // `prefix` and returns every key in the store unfiltered).
    if (key.indexOf('u:') !== 0) continue;
    scanned++;

    var record;
    try {
      connectLambda(event);
      record = await store.get(key, { type: 'json' });
    } catch (e) {
      console.error('send-whatsapp-morning-capture: read failed for a scanned account record', e);
      continue;
    }
    if (!record || !record.whatsappNumber) continue; // not opted in

    var dedupKey = 'whatsapp-morning-capture:' + record.username + ':' + today;
    var claim = await pushDedupStore.markSentOnce(event, dedupKey);
    if (!claim.ok) { skipped++; continue; } // already sent today, or the CAS write couldn't confirm the claim -- fail closed, same discipline every other pushDedupStore caller follows

    var result = await sendMorningCaptureMessage(record.whatsappNumber, record.username);
    if (result.ok) sent++;
  }

  return { scanned: scanned, sent: sent, skipped: skipped };
}

exports.handler = schedule(SCHEDULE_CRON, async function (event) {
  try {
    var result = await scanAndSend(event);
    console.log('send-whatsapp-morning-capture: scanned ' + result.scanned + ' opted-in-eligible account(s), sent ' + result.sent + ', skipped ' + result.skipped + ' (already sent today, or config not set)');
  } catch (e) {
    // Best-effort, same "never let this surface as a hard failure" posture
    // as send-daily-claim-pushes.js's own top-level catch -- a failed scan
    // just means today's WhatsApp batch doesn't go out; tomorrow's
    // scheduled run tries again.
    console.error('send-whatsapp-morning-capture: unexpected error', e);
  }
  return { statusCode: 200 };
});

// Exposed for direct unit testing (test/send-whatsapp-morning-capture.test.js).
exports.scanAndSend = scanAndSend;
exports.sendMorningCaptureMessage = sendMorningCaptureMessage;
exports.isConfigured = isConfigured;
exports.SCHEDULE_CRON = SCHEDULE_CRON;
