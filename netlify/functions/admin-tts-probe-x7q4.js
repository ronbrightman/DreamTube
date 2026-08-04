// netlify/functions/admin-tts-probe-x7q4.js
//
// TEMPORARY one-shot latency probe (Manager, 2026-08-04): measures fal
// kokoro TTS via the SYNCHRONOUS endpoint (fal.run) vs the queue
// (queue.fal.run), with the server's FAL_KEY, to decide the fix for the
// founder-reported ~30s reading-voice delay (tracker
// for-product-p1-bug-founder-repro-sage-re-cbdj3d). DELETE after the
// route decision lands (no-dead-code rule). Owner-gated like
// owner-topup-tokens.js.
//
//   POST { email, text? } -> 200 { syncMs, syncOk, queueSubmitMs, queueTotalMs, queueOk }
//
// The function itself has a ~26s Netlify execution ceiling, so the queue
// leg gives up (queueOk:false, queueTotalMs:null) past ~20s — which is
// itself the answer that the queue is unusable for interactive TTS.

var FAL_MODEL = 'fal-ai/kokoro/american-english';
var OWNER_EMAIL = 'ronbrightman@gmail.com';

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: '{"error":"method_not_allowed"}' };
  var falKey = process.env.FAL_KEY;
  if (!falKey) return { statusCode: 500, body: '{"error":"missing_api_key"}' };
  var payload;
  try { payload = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 400, body: '{"error":"invalid_json"}' }; }
  if (payload.email !== OWNER_EMAIL) return { statusCode: 403, body: '{"error":"forbidden"}' };

  var text = payload.text || 'Ah, the desert and the oasis. A hopeful sign that you are closer to what you seek than you know.';
  var body = JSON.stringify({ prompt: text, voice: 'am_onyx', speed: 0.8 });
  var headers = { 'Content-Type': 'application/json', 'Authorization': 'Key ' + falKey };
  var out = { syncMs: null, syncOk: false, syncAudio: null, queueSubmitMs: null, queueTotalMs: null, queueOk: false };

  // Leg 1: synchronous fal.run
  var t0 = Date.now();
  try {
    var syncRes = await fetch('https://fal.run/' + FAL_MODEL, { method: 'POST', headers: headers, body: body });
    var syncData = await syncRes.json();
    out.syncMs = Date.now() - t0;
    out.syncOk = !!(syncRes.ok && syncData && syncData.audio && syncData.audio.url);
    out.syncAudio = out.syncOk ? syncData.audio.url : (syncData && (syncData.detail || syncData.error)) || null;
  } catch (e) {
    out.syncMs = Date.now() - t0;
    out.syncAudio = 'sync_error: ' + (e && e.message);
  }

  // Leg 2: queue submit + poll (bounded)
  var t1 = Date.now();
  try {
    var subRes = await fetch('https://queue.fal.run/' + FAL_MODEL, { method: 'POST', headers: headers, body: body });
    var subData = await subRes.json();
    out.queueSubmitMs = Date.now() - t1;
    if (subRes.ok && subData.request_id) {
      var deadline = Date.now() + 18000;
      while (Date.now() < deadline) {
        var stRes = await fetch('https://queue.fal.run/fal-ai/kokoro/requests/' + subData.request_id + '/status', { headers: { 'Authorization': 'Key ' + falKey } });
        var st = await stRes.json();
        if (st.status === 'COMPLETED') { out.queueOk = true; out.queueTotalMs = Date.now() - t1; break; }
        await new Promise(function (r) { setTimeout(r, 1000); });
      }
    }
  } catch (e) { /* reported as queueOk:false */ }

  return { statusCode: 200, body: JSON.stringify(out) };
};
