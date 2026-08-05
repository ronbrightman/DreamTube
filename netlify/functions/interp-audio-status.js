// netlify/functions/interp-audio-status.js
//
// GET ?name=<operationName> -> polls generate-interp-audio.js's submitted
// job to completion, THEN internally chains a word-level caption-alignment
// pass before ever reporting `done` — see docs/SPEAKING_SAGE_SPEC.md §4 for
// the full mechanism this implements and why.
//
//   -> 200 { status: 'processing'[, operationName] }
//   -> 200 { status: 'done', audioUrl, audioDurationMs, captions, captionsLevel }
//   -> 200 { status: 'failed', error }
//
// CAPTION-TIMING MECHANISM — a documented, deliberate deviation from the
// literal Option D tracker text: the founder's approved recipe describes
// caption cues mapped via ffmpeg's `silencedetect` filter ("Manager
// scratchpad has the method"). This sandbox/repo has no `ffmpeg` binary
// and no ffmpeg-wrapping npm dependency (`package.json` carries none, and
// Netlify Functions here bundle no such binary) — adding one would be a
// new, unreviewed runtime dependency for a single feature, not "reusing
// infrastructure this codebase already has," which both this task's own
// instruction and this codebase's `AGENT_POLICY.md` favor. Instead this
// reuses a mechanism ALREADY LIVE in this exact codebase:
// transcribe-audio.js's fal-ai/whisper call, at `chunk_level: 'word'`
// instead of that file's `'none'` — the same vendor/model this repo
// already pays for and has working integration code for, returning real
// per-word timestamps aligned to the ACTUAL rendered audio (not the
// source text — TTS pacing isn't perfectly predictable from text alone).
// This was independently spec'd in detail by the design pass that preceded
// Option D (docs/SPEAKING_SAGE_SPEC.md §4, its own "no ffmpeg on this
// endpoint's schema" finding) and is objectively a strictly BETTER signal
// than pause-boundary silence detection (genuine per-word sync, not
// per-sentence), so this build reuses it rather than block the whole
// feature on standing up ffmpeg somewhere it doesn't exist. Flagged
// plainly here (and in this branch's own PR description) as a deliberate
// substitution, not a silent shortcut.
//
// Two-stage chain, ONE operationName the client ever has to manage across
// polls (spec §7: "the client only ever sees one poll cycle to manage, not
// two separate jobs") — encoded as a state-carrying string rather than any
// server-side memory (Netlify Functions give no same-instance guarantee
// across polls, same reasoning as video-status.js's own mock-mode comment):
//   Stage 1: "fal:<ttsModel>:<ttsRequestId>"                        (from generate-interp-audio.js)
//   Stage 2: "falw:<urlencoded audioUrl>:<whisperRequestId>"        (this file mints it, once, the poll TTS completes)
// A `processing` response carries whichever operationName the CLIENT
// should poll with next — js/store.js's poll wrapper re-reads it every
// cycle, so this file never needs to remember which stage a given job is
// in between requests.
//
// AUDIO DURATION — Kokoro's own response schema (confirmed via fal's model
// docs) has no documented duration field, so `audioDurationMs` returned
// here is a best-effort estimate only (the last word's `endMs`, when the
// word-level pass succeeds; `null` on the sentence-level fallback, since
// there's nothing to estimate from). The real, authoritative duration used
// for playback/looping decisions is read client-side off the actual
// `<audio>` element's `loadedmetadata` event (js/interpret-experience.js) —
// same "probe the real asset, don't trust a guessed field" precedent
// js/store.js's own `probeVideoDuration` already established for video.
//
// CAPTION FALLBACK — if the whisper alignment pass fails, times out, or
// returns no usable word chunks, this resolves `done` anyway with
// `captionsLevel: 'sentence'` and an EMPTY `captions` array — a real
// degrade path, not silently broken captions (spec §4). The actual
// sentence-cue SCHEDULE is computed client-side, once the real audio
// duration is known (js/interpret-experience.js's
// `computeSentenceFallbackCaptions`), rather than guessed here against an
// unconfirmed server-side duration.
//
// Mock mode (GENERATION_MOCK_MODE==="true"): resolves a "mock:" operation
// name to a small, stable, real, publicly-hosted sample MP3 (same
// "standard HTML5 tutorial sample" convention video-status.js's own
// MOCK_SAMPLE_VIDEO_URL uses) after a short simulated delay, with a fixed
// small set of canned word-level captions (unrelated to the actual
// reading text, same as the mock video's content being unrelated to the
// prompt — a test fixture, never shown to a real user) — see docs/TESTING.md.
//
// WHISPER SUBMISSION IS IDEMPOTENT, KEYED ON THE TTS REQUEST (tracker.html's
// for-product-whisper-runaway-5-000-whispe-szk33s item — a real production
// cost leak: ~4,200-5,200 fal-ai/whisper units/day against ~1-2 actual
// readings/day, confirmed by reading this exact code path). Stage 1 used to
// call submitWhisperAlignment() UNCONDITIONALLY every time it found the TTS
// job COMPLETED — and since checkFalStatus reports COMPLETED forever once
// true, ANY poll re-hitting Stage 1 after completion (client latency
// swapping to the new "falw:" operationName, overlapping poll requests, a
// retry, two tabs on the same reading) submitted ANOTHER real whisper job.
// This file is fully stateless across polls by design (see the two-stage
// comment above) — the fix adds the one piece of real server-side state
// this specific step needs: lib/whisper-alignment-store.js, a Blobs-backed
// CAS claim keyed on `ttsModel:ttsRequestId`. See that file's own header
// comment for the full mechanism and why the residual concurrent-claim race
// this codebase usually just documents-and-accepts (lib/blobs-retry.js's
// posture) is instead fully CLOSED here via a real compare-and-swap write.

var whisperAlignmentStore = require('./lib/whisper-alignment-store');

var FAL_API_BASE = 'https://queue.fal.run';
var FAL_MODEL_WHISPER = 'fal-ai/whisper';

var MOCK_SAMPLE_AUDIO_URL = 'https://www.w3schools.com/html/horse.mp3';
var MOCK_DELAY_MS = 4000; // short — this is a ~$0.02 voice-only clip, not a multi-minute video render
var MOCK_CAPTIONS = [
  { word: 'This', startMs: 0, endMs: 220 },
  { word: 'is', startMs: 220, endMs: 360 },
  { word: 'a', startMs: 360, endMs: 440 },
  { word: 'mock', startMs: 440, endMs: 780 },
  { word: 'reading.', startMs: 780, endMs: 1300 }
];

/** Parses a fetch Response as JSON, tolerating an empty/non-JSON body — same helper transcribe-status.js already established. */
async function parseJsonSafe(res) {
  var text = await res.text();
  try {
    return { ok: true, data: text ? JSON.parse(text) : {} };
  } catch (e) {
    return { ok: false, rawText: text };
  }
}

function falAppBase(model) {
  var parts = model.split('/');
  return parts[0] + '/' + parts[1];
}

async function checkFalStatus(model, requestId, falKey) {
  var appBase = falAppBase(model);
  var statusRes = await fetch(FAL_API_BASE + '/' + appBase + '/requests/' + requestId + '/status', {
    headers: { 'Authorization': 'Key ' + falKey }
  });
  var parsed = await parseJsonSafe(statusRes);
  if (!parsed.ok) return { ok: false, statusCode: statusRes.status, error: 'status_check_failed: non-JSON response (http ' + statusRes.status + '): ' + parsed.rawText.slice(0, 300) };
  if (!statusRes.ok) return { ok: false, statusCode: statusRes.status, error: (parsed.data && parsed.data.detail) || 'status_check_failed' };
  return { ok: true, status: parsed.data.status };
}

async function fetchFalResult(model, requestId, falKey) {
  var appBase = falAppBase(model);
  var resultRes = await fetch(FAL_API_BASE + '/' + appBase + '/requests/' + requestId, {
    headers: { 'Authorization': 'Key ' + falKey }
  });
  var parsed = await parseJsonSafe(resultRes);
  if (!parsed.ok) return { ok: false, error: 'result_fetch_failed: non-JSON response (http ' + resultRes.status + '): ' + parsed.rawText.slice(0, 300) };
  if (!resultRes.ok) return { ok: false, error: 'result_fetch_failed' };
  return { ok: true, data: parsed.data };
}

/** Submits the word-level Whisper alignment pass against the already-generated TTS audio — same fal-ai/whisper endpoint transcribe-audio.js already calls, `chunk_level:'word'` instead of `'none'`, `audio_url` a real https URL (not a data URI — fal's audio_url param accepts either). */
async function submitWhisperAlignment(audioUrl, falKey) {
  var res = await fetch(FAL_API_BASE + '/' + FAL_MODEL_WHISPER, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Key ' + falKey
    },
    body: JSON.stringify({
      audio_url: audioUrl,
      task: 'transcribe',
      chunk_level: 'word'
    })
  });
  var data = await res.json();
  if (!res.ok) return { ok: false };
  return { ok: true, requestId: data.request_id };
}

/** Parses fal-ai/whisper's chunk_level:'word' result shape (`chunks: [{ text, timestamp: [startSec, endSec] }, ...]`, confirmed against fal's own model docs) into this feature's `{ word, startMs, endMs }` caption shape. Returns null (never []) if the shape is missing/empty/malformed — the caller treats null as "alignment produced nothing usable," triggering the sentence-level fallback (spec §4), same as a hard failure would. */
function parseWordChunks(resultData) {
  var chunks = resultData && Array.isArray(resultData.chunks) ? resultData.chunks : null;
  if (!chunks || !chunks.length) return null;
  var captions = [];
  for (var i = 0; i < chunks.length; i++) {
    var c = chunks[i];
    var word = c && typeof c.text === 'string' ? c.text.trim() : '';
    var ts = c && Array.isArray(c.timestamp) ? c.timestamp : null;
    if (!word || !ts || typeof ts[0] !== 'number' || typeof ts[1] !== 'number') continue;
    captions.push({ word: word, startMs: Math.round(ts[0] * 1000), endMs: Math.round(ts[1] * 1000) });
  }
  return captions.length ? captions : null;
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'method_not_allowed' }) };
  }

  var name = (event.queryStringParameters || {}).name;
  if (!name) {
    return { statusCode: 400, body: JSON.stringify({ error: 'name_required' }) };
  }

  if (name.indexOf('mock:') === 0) {
    var startedAt = parseInt(name.split(':')[1], 10) || 0;
    if (Date.now() - startedAt < MOCK_DELAY_MS) {
      return { statusCode: 200, body: JSON.stringify({ status: 'processing' }) };
    }
    return {
      statusCode: 200,
      body: JSON.stringify({
        status: 'done',
        audioUrl: MOCK_SAMPLE_AUDIO_URL,
        audioDurationMs: MOCK_CAPTIONS[MOCK_CAPTIONS.length - 1].endMs,
        captions: MOCK_CAPTIONS,
        captionsLevel: 'word'
      })
    };
  }

  var falKey = process.env.FAL_KEY;
  if (!falKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'missing_api_key' }) };
  }

  try {
    if (name.indexOf('falw:') === 0) {
      // Stage 2 — polling the whisper alignment job. Format:
      // "falw:<urlencoded audioUrl>:<whisperRequestId>".
      var parts2 = name.split(':');
      var audioUrlFromName = decodeURIComponent(parts2[1]);
      var whisperRequestId = parts2.slice(2).join(':');

      var wStatus = await checkFalStatus(FAL_MODEL_WHISPER, whisperRequestId, falKey);
      if (!wStatus.ok) {
        // Can't even check status — a real infra error, but non-fatal to
        // the overall reading per spec §4: degrade to sentence-level
        // rather than fail the whole voice feature over a caption-only
        // problem.
        return { statusCode: 200, body: JSON.stringify({ status: 'done', audioUrl: audioUrlFromName, audioDurationMs: null, captions: [], captionsLevel: 'sentence', degradedReason: 'E508: caption_alignment_failed' }) };
      }
      if (wStatus.status === 'IN_QUEUE' || wStatus.status === 'IN_PROGRESS') {
        return { statusCode: 200, body: JSON.stringify({ status: 'processing', operationName: name }) };
      }
      if (wStatus.status !== 'COMPLETED') {
        return { statusCode: 200, body: JSON.stringify({ status: 'done', audioUrl: audioUrlFromName, audioDurationMs: null, captions: [], captionsLevel: 'sentence', degradedReason: 'E508: caption_alignment_failed' }) };
      }

      var wResult = await fetchFalResult(FAL_MODEL_WHISPER, whisperRequestId, falKey);
      var captions = wResult.ok ? parseWordChunks(wResult.data) : null;
      if (!captions) {
        return { statusCode: 200, body: JSON.stringify({ status: 'done', audioUrl: audioUrlFromName, audioDurationMs: null, captions: [], captionsLevel: 'sentence', degradedReason: 'E508: caption_alignment_failed' }) };
      }
      return {
        statusCode: 200,
        body: JSON.stringify({
          status: 'done',
          audioUrl: audioUrlFromName,
          audioDurationMs: captions[captions.length - 1].endMs,
          captions: captions,
          captionsLevel: 'word'
        })
      };
    }

    // Stage 1 — polling the Kokoro TTS job itself. Format: "fal:<model>:<requestId>".
    if (name.indexOf('fal:') !== 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'name_required' }) };
    }
    var parts1 = name.split(':');
    var ttsModel = parts1[1];
    var ttsRequestId = parts1.slice(2).join(':');

    var tStatus = await checkFalStatus(ttsModel, ttsRequestId, falKey);
    if (!tStatus.ok) {
      return { statusCode: tStatus.statusCode || 500, body: JSON.stringify({ error: tStatus.error }) };
    }
    if (tStatus.status === 'IN_QUEUE' || tStatus.status === 'IN_PROGRESS') {
      return { statusCode: 200, body: JSON.stringify({ status: 'processing', operationName: name }) };
    }
    if (tStatus.status !== 'COMPLETED') {
      return { statusCode: 200, body: JSON.stringify({ status: 'failed', error: 'E506: tts_request_failed: ' + tStatus.status }) };
    }

    var tResult = await fetchFalResult(ttsModel, ttsRequestId, falKey);
    if (!tResult.ok) {
      return { statusCode: 200, body: JSON.stringify({ status: 'failed', error: 'E506: tts_request_failed: ' + tResult.error }) };
    }
    var audioUrl = tResult.data && tResult.data.audio && tResult.data.audio.url;
    if (!audioUrl) {
      return { statusCode: 200, body: JSON.stringify({ status: 'failed', error: 'E506: tts_request_failed: no_audio_in_response' }) };
    }

    // IDEMPOTENT whisper submission (tracker.html's
    // for-product-whisper-runaway-5-000-whispe-szk33s item — see this
    // file's own header comment for the full mechanism). Check FIRST
    // whether a whisper submission already exists for this exact TTS
    // request, before ever attempting a new one — this is the hot path for
    // every stale/overlapping/retried poll that reaches Stage 1 after the
    // TTS job has already completed once.
    var existingWhisper = await whisperAlignmentStore.get(event, ttsModel, ttsRequestId);
    if (existingWhisper && existingWhisper.whisperRequestId) {
      // Already submitted (by this poll or a concurrent one) — reuse it,
      // no new fal-ai/whisper job.
      return {
        statusCode: 200,
        body: JSON.stringify({
          status: 'processing',
          operationName: 'falw:' + encodeURIComponent(existingWhisper.audioUrl) + ':' + existingWhisper.whisperRequestId
        })
      };
    }
    if (existingWhisper && !existingWhisper.whisperRequestId) {
      // Someone else (a concurrent poll) is mid-submission right now —
      // don't submit, don't even attempt the claim (it would lose anyway).
      // Keep the client on the OLD "fal:" operationName; the next poll
      // will see either the finished submission above or a released claim
      // to retry, at zero additional whisper cost either way.
      return { statusCode: 200, body: JSON.stringify({ status: 'processing', operationName: name }) };
    }

    // No record at all — attempt to atomically claim the right to submit.
    var claimResult = await whisperAlignmentStore.claim(event, ttsModel, ttsRequestId, audioUrl);
    if (!claimResult.claimed) {
      // Lost the race (a genuinely concurrent poll claimed it a moment
      // ago) or the claim write itself failed closed — either way, do NOT
      // submit. If the loser already has a finished record, reuse it;
      // otherwise fall back to re-polling Stage 1 with the old name.
      if (claimResult.record && claimResult.record.whisperRequestId) {
        return {
          statusCode: 200,
          body: JSON.stringify({
            status: 'processing',
            operationName: 'falw:' + encodeURIComponent(claimResult.record.audioUrl) + ':' + claimResult.record.whisperRequestId
          })
        };
      }
      return { statusCode: 200, body: JSON.stringify({ status: 'processing', operationName: name }) };
    }

    // Won the claim — we are the ONLY caller allowed to submit for this
    // TTS request. Non-fatal if this fails to even submit: the reading
    // still has real audio, it just degrades to sentence-level captions
    // (spec §4) rather than failing the whole reading over a caption-only
    // problem — but release the claim first, so a genuinely fresh future
    // attempt (a retry from a NEW poll) isn't permanently blocked by this
    // one failed attempt.
    var submitted = await submitWhisperAlignment(audioUrl, falKey);
    if (!submitted.ok) {
      await whisperAlignmentStore.releaseClaim(event, ttsModel, ttsRequestId);
      return { statusCode: 200, body: JSON.stringify({ status: 'done', audioUrl: audioUrl, audioDurationMs: null, captions: [], captionsLevel: 'sentence', degradedReason: 'E508: caption_alignment_failed' }) };
    }

    await whisperAlignmentStore.recordSubmitted(event, ttsModel, ttsRequestId, audioUrl, submitted.requestId);

    return {
      statusCode: 200,
      body: JSON.stringify({
        status: 'processing',
        operationName: 'falw:' + encodeURIComponent(audioUrl) + ':' + submitted.requestId
      })
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'status_check_failed: ' + (e && e.message) }) };
  }
};

exports.parseWordChunks = parseWordChunks;
exports.MOCK_SAMPLE_AUDIO_URL = MOCK_SAMPLE_AUDIO_URL;
