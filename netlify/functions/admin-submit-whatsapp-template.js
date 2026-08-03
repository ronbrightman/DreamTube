// netlify/functions/admin-submit-whatsapp-template.js
//
// ONE-OFF, deliberately-triggered admin tool: submits the Morning Capture
// Ritual's WhatsApp message template (tracker item for-product-build-
// whatsapp-morning-captu-skez3n, step 1 of the template-submission +
// sender-wiring follow-up round) to Meta's Graph API for approval —
// POST /{waba_id}/message_templates. This does NOT run automatically —
// no schedule() wrapper, no netlify.toml [functions.*] entry, unlike this
// codebase's actual scheduled senders (send-daily-claim-pushes.js,
// send-whatsapp-morning-capture.js). Submitting a template is a rare,
// deliberate action (Meta's review can take up to ~24h, and a rejected or
// miscategorized template can't be silently retried without risking a
// second rejection), so this only ever runs when a human or the
// coordinating session explicitly calls it.
//
// TEMPLATE CONTENT IS HARDCODED, NOT CLIENT-SUPPLIED — same one-off-tool
// reasoning as admin-restore-founder-email.js's RESTORE_USERNAME constant
// (see that file's own header comment): this isn't a general "submit any
// template" tool, it exists to submit exactly the one template the
// founder already drafted in this build's own tracker item. The template
// NAME falls back to WHATSAPP_TEMPLATE_NAME_MORNING_CAPTURE — the SAME env
// var send-whatsapp-morning-capture.js already reads to know which
// approved name to send against — so a rename never needs two separate
// edits, but the body copy, buttons, language, and category are fixed
// here on purpose and never taken from the request.
//
// CATEGORY: MARKETING, not UTILITY. Meta's own template-category
// guidelines reserve UTILITY for messages tied to a specific transaction,
// account update, or user-initiated action (an order confirmation, an
// appointment reminder, a password-reset code). This message is the
// opposite of that: an unprompted, recurring daily invite to engage
// ("what did you dream?") with no per-user transactional trigger behind
// it — squarely Meta's own definition of a MARKETING template. Submitting
// a recurring engagement nudge as UTILITY risks an outright rejection
// (miscategorization is one of Meta's most common auto-rejection reasons,
// not just a slower review), so this is deliberately not left as a
// guessable/overridable request parameter.
//
// AUTH: same lighter "trust the client-supplied email, checked against
// OWNER_EMAIL" tier as admin-paywall-toggle.js/owner-topup-tokens.js, NOT
// admin-restore-founder-email.js's heavier real-password check. This
// endpoint never touches any real user's account data or money — it only
// submits one fixed, founder-drafted template to Meta using this server's
// OWN WHATSAPP_ACCESS_TOKEN (never a client-supplied credential) — so the
// same "don't let a random caller flip a switch that isn't theirs to
// flip" bar every other flag/self-top-up endpoint in this codebase
// already uses is the proportionate one here too.
//
// Request:
//   GET  [no params] -> non-mutating preview: the exact template payload
//     this tool would submit, plus whether WHATSAPP_ACCESS_TOKEN/
//     WHATSAPP_WABA_ID are both configured yet. No auth required — nothing
//     secret in the response (never includes the access token itself),
//     matching admin-paywall-toggle.js's own "GET is a harmless read"
//     precedent.
//   POST { email } -> submits the template for real via the Graph API.
//     `email` must (normalized) match OWNER_EMAIL.
//
// Response:
//   GET  200 { ok:true, configured, missing: string[], wouldSubmit }
//   POST 200 { ok:true, templateId, status, category } -- Meta's own
//     response to a successful submission; `status` is typically
//     "PENDING" until Meta finishes reviewing it.
//
// Error codes (local to this function, same small-number-scheme reasoning
// as every sibling admin-*.js file in this codebase):
//   E1 method_not_allowed  -- verb other than GET/POST
//   E2 missing_owner_email -- OWNER_EMAIL not configured in this environment
//   E3 invalid_json        -- POST body wasn't valid JSON
//   E4 forbidden           -- POST body's `email` (normalized) didn't match
//                              OWNER_EMAIL (normalized)
//   E5 not_configured      -- WHATSAPP_ACCESS_TOKEN and/or WHATSAPP_WABA_ID
//                              isn't set yet -- POST only; GET reports this
//                              via `configured:false`/`missing` instead of
//                              erroring, since GET never attempts the call
//   E6 graph_api_error     -- the Graph API call itself returned a non-2xx
//                              (e.g. bad token, malformed component, a
//                              template with this name already exists)
//   E7 unexpected_error    -- the fetch itself threw (network failure, etc)
//
// WABA ID: this build's WhatsApp Business Account is 1261409435841617 (per
// this tool's own tracker item) -- read from WHATSAPP_WABA_ID at call time,
// same "read the real external id from env, never hardcode it into code"
// convention send-whatsapp-morning-capture.js already set for
// WHATSAPP_PHONE_NUMBER_ID (see that file's own ENV VARS header comment)
// -- deliberately a DIFFERENT env var than that one, since a WABA id and a
// phone-number id are two distinct Graph API resource ids that happen to
// both live under the same real Meta Business app.
//
// NETWORK-ACCESS HONESTY NOTE: this sandbox likely has no real egress to
// graph.facebook.com. This file is verified against test/admin-submit-
// whatsapp-template.test.js's mocked global.fetch (asserting the exact
// request shape against Meta's own documented POST /{waba_id}/
// message_templates contract), never against a real submission. Actually
// submitting the template for real is a manual step for Manager/Ron --
// see this tracker item's own handoff notes for the exact curl/invocation.

var { normalizeEmail } = require('./lib/entitlements');

var GRAPH_API_BASE = 'https://graph.facebook.com/v20.0';

var TEMPLATE_LANGUAGE = 'en_US';
var TEMPLATE_CATEGORY = 'MARKETING'; // see header comment's CATEGORY section for why not UTILITY

/** The template's registered name -- falls back to a fixed default so this tool always has something to submit even before the env var is set; see header comment. */
function templateName() {
  var envName = process.env.WHATSAPP_TEMPLATE_NAME_MORNING_CAPTURE;
  return (typeof envName === 'string' && envName.trim()) ? envName.trim() : 'morning_capture_v1';
}

/**
 * The exact template-creation payload this tool submits to Meta -- a pure
 * function of env (template name only), never of anything client-supplied,
 * so the GET preview and the real POST are always the literal same
 * payload, byte for byte. Shape matches Meta's own documented Message
 * Templates create request: `name`, `language` (a plain string, not an
 * object), `category`, and a `components` array -- one BODY component
 * carrying the {{1}} variable text, one BUTTONS component with two
 * QUICK_REPLY buttons (per the founder-drafted copy this tracker item
 * specifies verbatim).
 */
function buildTemplatePayload() {
  return {
    name: templateName(),
    language: TEMPLATE_LANGUAGE,
    category: TEMPLATE_CATEGORY,
    components: [
      {
        type: 'BODY',
        text: 'Good morning {{1}} — what did you dream? It\'s already fading. Tap below and just speak it.'
      },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'QUICK_REPLY', text: 'Speak' },
          { type: 'QUICK_REPLY', text: 'No recall' }
        ]
      }
    ]
  };
}

function looksUnset(value) {
  return typeof value !== 'string' || !value.trim();
}

/** Which of the two env vars this tool needs are still unset -- exposed separately from isConfigured() so GET's preview can report exactly what's missing, not just a bare boolean. */
function missingConfig() {
  var missing = [];
  if (looksUnset(process.env.WHATSAPP_ACCESS_TOKEN)) missing.push('WHATSAPP_ACCESS_TOKEN');
  if (looksUnset(process.env.WHATSAPP_WABA_ID)) missing.push('WHATSAPP_WABA_ID');
  return missing;
}

function isConfigured() {
  return missingConfig().length === 0;
}

/**
 * Real Graph API call. Callers MUST check isConfigured() first (mirrors
 * send-whatsapp-morning-capture.js's own isConfigured gate shape) -- unlike
 * that file's soft-fail contract, this is a deliberately-triggered one-off
 * action rather than a background scheduled job, so a real failure here
 * surfaces as a real non-2xx response instead of a silent skip.
 *
 * NEVER THROWS -- resolves to one of:
 *   { ok:true, templateId, status, category }
 *   { ok:false, reason:'graph_api_error', status, data }
 *   { ok:false, reason:'unexpected_error' }
 */
async function submitTemplate() {
  var token = process.env.WHATSAPP_ACCESS_TOKEN;
  var wabaId = process.env.WHATSAPP_WABA_ID;
  var payload = buildTemplatePayload();

  var res;
  try {
    res = await fetch(GRAPH_API_BASE + '/' + wabaId + '/message_templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    console.error('admin-submit-whatsapp-template: unexpected error calling the Graph API', e);
    return { ok: false, reason: 'unexpected_error' };
  }

  var data = null;
  try { data = await res.json(); } catch (parseErr) { data = null; }

  if (!res.ok) {
    console.error('admin-submit-whatsapp-template: Graph API error', res.status, data);
    return { ok: false, reason: 'graph_api_error', status: res.status, data: data };
  }

  return {
    ok: true,
    templateId: (data && data.id) || null,
    status: (data && data.status) || null,
    category: (data && data.category) || null
  };
}

exports.handler = async function (event) {
  var method = event.httpMethod;
  if (method !== 'GET' && method !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ ok: false, error: 'E1: method_not_allowed' }) };
  }

  var ownerEmail = normalizeEmail(process.env.OWNER_EMAIL);
  if (!ownerEmail) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'E2: missing_owner_email' }) };
  }

  if (method === 'GET') {
    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        configured: isConfigured(),
        missing: missingConfig(),
        wouldSubmit: buildTemplatePayload()
      })
    };
  }

  var payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'E3: invalid_json' }) };
  }

  var callerEmail = normalizeEmail(payload && payload.email);
  if (!callerEmail || callerEmail !== ownerEmail) {
    return { statusCode: 403, body: JSON.stringify({ ok: false, error: 'E4: forbidden' }) };
  }

  if (!isConfigured()) {
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, error: 'E5: not_configured', missing: missingConfig() })
    };
  }

  var result = await submitTemplate();
  if (!result.ok && result.reason === 'graph_api_error') {
    return { statusCode: 502, body: JSON.stringify({ ok: false, error: 'E6: graph_api_error', status: result.status, data: result.data }) };
  }
  if (!result.ok) {
    return { statusCode: 502, body: JSON.stringify({ ok: false, error: 'E7: unexpected_error' }) };
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, templateId: result.templateId, status: result.status, category: result.category })
  };
};

// Exposed for direct unit testing (test/admin-submit-whatsapp-template.test.js).
exports.buildTemplatePayload = buildTemplatePayload;
exports.templateName = templateName;
exports.isConfigured = isConfigured;
exports.missingConfig = missingConfig;
exports.submitTemplate = submitTemplate;
