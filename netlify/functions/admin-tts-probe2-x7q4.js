// netlify/functions/admin-tts-probe2-x7q4.js
//
// TEMPORARY generic TTS latency probe #2 (Manager, 2026-08-04): kokoro's
// fal capacity (queue AND sync) degrades unpredictably at busy hours —
// founder hit 18s+ again after the sync-first fix measured 1.4-5.3s in
// the morning. This probe times ANY fal model via the synchronous
// endpoint so we can pick a replacement voice engine with a genuinely
// fast lane (tracker cbdj3d). Owner-gated; DELETE after the route
// decision (same lifecycle as the deleted admin-tts-probe-x7q4.js).
//
//   POST { email, model, body } -> 200 { ms, status, ok, resultKeys, audioUrl?, detail? }

var OWNER_EMAIL = 'ronbrightman@gmail.com';

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: '{"error":"method_not_allowed"}' };
  var falKey = process.env.FAL_KEY;
  if (!falKey) return { statusCode: 500, body: '{"error":"missing_api_key"}' };
  var payload;
  try { payload = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 400, body: '{"error":"invalid_json"}' }; }
  if (payload.email !== OWNER_EMAIL) return { statusCode: 403, body: '{"error":"forbidden"}' };
  if (!payload.model || !payload.body) return { statusCode: 400, body: '{"error":"model_and_body_required"}' };

  var t0 = Date.now();
  var out = { ms: null, status: null, ok: false, resultKeys: null, audioUrl: null, detail: null };
  try {
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, 20000);
    var res = await fetch('https://fal.run/' + payload.model, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Key ' + falKey },
      body: JSON.stringify(payload.body),
      signal: ctl.signal
    });
    clearTimeout(timer);
    out.ms = Date.now() - t0;
    out.status = res.status;
    var data = await res.json();
    out.resultKeys = data && typeof data === 'object' ? Object.keys(data) : null;
    out.audioUrl = (data && data.audio && data.audio.url) || (data && data.audio_url) || null;
    out.ok = res.ok && !!out.audioUrl;
    if (!res.ok) out.detail = (data && (data.detail || data.error)) || null;
  } catch (e) {
    out.ms = Date.now() - t0;
    out.detail = 'fetch_error: ' + (e && e.message);
  }
  return { statusCode: 200, body: JSON.stringify(out) };
};
