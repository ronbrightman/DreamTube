// netlify/functions/generate-interp-audio.js
//
// Speaking Sage — Option D (docs/SPEAKING_SAGE_SPEC.md, tracker item
// for-product-build-speaking-sage-wave-fou-8uobuh, founder GO on "Option D"
// 2026-08-02/08-03). Per-reading voice track for the Interpreter's Chamber:
//
//   POST { dreamId, personaKey, text } -> 200 { operationName } (queue fallback)
//                                       -> 200 { done:true, audioUrl, captions… } (sync tiers)
//
// `text` is the ALREADY-GENERATED reading (interpret-dream.js's own
// mode:"reading" output, already validated/safety-checked there) — this
// function narrates it, it never generates new copy of its own (spec §9:
// "TTS narrates what was already checked; it doesn't introduce new copy").
// `dreamId` is accepted but NOT used to look anything up server-side (this
// function has no access to js/store.js's localStorage-only dream records
// — the client already resolved the persona/text before calling this); it
// is passed through purely so a future server-side persistence layer has
// it available, and so this function's request shape matches every other
// dreamId-carrying call in this codebase. See interp-audio-status.js for
// the submit-then-poll pattern the LEGACY queue tier kicks off (Netlify's
// own function timeout means that path must never block on the model call
// itself — same reasoning as transcribe-audio.js's own header comment).
//
// ── Voice vendor: THREE-TIER FALLBACK CHAIN (founder decision 2026-08-04,
//    tracker item for-product-founder-decision-08-04-switc-cqveik,
//    "much better" — listened to real ElevenLabs vs kokoro samples) ──
//
//   Tier 1 — ElevenLabs Turbo v2.5 sync (PRIMARY, new this change):
//     fal.run/fal-ai/elevenlabs/tts/turbo-v2.5, reached through the SAME
//     fal.ai infrastructure this file already used for kokoro (same
//     FAL_KEY, same fal.run sync base — a model swap, not a new vendor
//     integration). Request: { text, voice: persona.voiceId,
//     timestamps: true }. Measured 1257/1350/1321ms wall-clock (founder
//     probe, 2026-08-04, 13:00-13:30 IDT) — the exact hours kokoro's own
//     sync call was measured taking 18s+ under load, i.e. materially
//     faster AND more reliable under load, not just founder preference.
//     Response: { audio: { url }, timestamps: [...] } — confirmed against
//     fal's own live OpenAPI schema for this endpoint, fetched at build
//     time 2026-08-04 (`voice` catalog confirmed to include 'Brian';
//     `timestamps` must be explicitly requested — false by default). The
//     PER-ITEM shape of `timestamps` is NOT published in that schema (typed
//     only as an untyped array, described as "for each word") and this
//     sandbox has no FAL_KEY to observe a real response — parseElevenLabsCaptions
//     below is therefore DEFENSIVE, not confirmed: it tries several
//     plausible field-name conventions and degrades to sentence-level
//     captions (same E508 contract as the kokoro tier) if the shape
//     doesn't match well enough to trust. FLAGGED for a human with real
//     FAL_KEY access to verify against one real call — see this branch's
//     own build report. Captions come BUILT IN to this response — there is
//     NO whisper leg on this tier at all (simpler, faster, removes a whole
//     class of failure). Reading pace: the founder's approved sample used
//     ElevenLabs' DEFAULT speed/stability (no override sent) — this is a
//     deliberate choice to match what he actually heard, not an oversight;
//     see SYNC_ELEVENLABS_BUDGET_MS's own comment for the "verify against
//     the 0.9 kokoro feel" open item.
//
//   Tier 2 — kokoro sync (FALLBACK, the EXISTING sync-first path,
//     unchanged in mechanism): fal.run/<FAL_MODEL>, voice
//     persona.kokoroVoiceId, speed READING_SPEED, own whisper-based
//     word-caption pass (unaffected by the tier-1 change — this is the
//     SAME caption path that existed before this vendor switch, only its
//     position in the chain moved from "the only sync tier" to "the
//     fallback sync tier"). Engages only when tier 1 fails to return a
//     usable audio.url (http error, timeout, thrown network error, or
//     persona.kokoroVoiceId missing entirely — defensive, should never
//     happen for a real persona that ships voice at all).
//
//   Tier 3 — kokoro queue (LEGACY FALLBACK, wholly unchanged): the
//     original queue.fal.run submit-then-poll path, polled by
//     interp-audio-status.js exactly as before. Engages only when BOTH
//     sync tiers fail.
//
// So a bad ElevenLabs day degrades to kokoro (sync, then queue) rather
// than breaking the reading entirely — cost is founder-accepted
// (~$0.08/reading ElevenLabs vs $0.016 kokoro) by choosing this vendor,
// not a gate this file re-litigates.
//
// Only a persona actually carrying a `voiceId` can reach this function at
// all; every other personaKey is rejected with E505 (unknown_persona),
// same as if the persona didn't exist — js/interpret-experience.js never
// calls this for a persona with no voiceId, so this is defense-in-depth,
// not the only guard. Originally this meant ONLY `talmudic`/The Sage
// (scope item 4 of the original build, "sage persona first"); as of
// 2026-08-04 (tracker for-product-founder-spec-08-04-chamber-m-zf5ufo,
// part 3 — INTERIM VOICES) ALL FIVE personas carry a `voiceId` (the other
// four temporarily borrowing the Sage's own `am_onyx` casting verbatim —
// see js/interpreter-personas.js's own header note), so in practice every
// real persona reaches this function today; the E505 branch remains live
// defense-in-depth for any future persona added before it has real voice
// casting, not dead code.
//
// Rate-limited under its OWN scope ("interp-audio-ip"), separate from
// interpret-ip (interpret-dream.js's text-generation bucket) — spec §7:
// "so a heavy day of text readings doesn't starve audio, and vice versa."
//
// Error codes (E5xx — following the E1xx/E2xx/E3xx/E4xx convention already
// used by generate-video.js/video-status.js/interpret-dream.js):
//   E501 method_not_allowed        — wrong HTTP verb
//   E502 missing_api_key           — FAL_KEY not configured (mock mode exempt, see below)
//   E503 invalid_json              — request body wasn't valid JSON
//   E504 text_required             — `text` missing/empty after trim
//   E505 unknown_persona           — personaKey missing, not a real persona key, or that
//                                     persona has no voiceId configured yet (spec: "tolerate
//                                     a missing asset, never block" — same as portraits)
//   E506 tts_request_failed        — every tier failed (ElevenLabs, kokoro sync, kokoro queue
//                                     all rejected/errored), or the queue submission itself
//                                     failed/errored
//   E507 rate_limited              — MAX_INTERP_AUDIO_PER_IP_PER_DAY exceeded for today
//   E508 caption_alignment_failed  — a tier's audio succeeded but its own caption mechanism
//                                     didn't (ElevenLabs: malformed/missing `timestamps`; kokoro:
//                                     whisper word-alignment failed, timed out, was skipped
//                                     because the TTS leg already ate the wall clock, or returned
//                                     no usable chunks) -- NOT an error response on its own,
//                                     degrades captionsLevel to 'sentence' inside an otherwise-200
//                                     done:true response (see below)
//
// Mock mode (GENERATION_MOCK_MODE==="true", AGENT_POLICY.md's "keep
// generation-testing cost low" rule + docs/TESTING.md): skips the real
// fal.ai call entirely — same "true" (exact string) convention as
// generate-video.js, same reasoning (this is a dev/test-only escape
// hatch, never for production). Every guardrail above the mock branch
// (validation, rate limit) still runs unchanged. Returns a fake
// "mock:<startedAtMs>:<id>" operationName in the same shape the real path
// returns; interp-audio-status.js recognizes this prefix and resolves it
// to a real, small, stable sample audio clip after a short simulated
// delay, so the rest of the flow (polling, caption rendering, playback)
// gets exercised end-to-end at zero fal.ai cost.

var crypto = require('crypto');
var InterpreterPersonas = require('../../js/interpreter-personas');
var InterpAudioStatus = require('./interp-audio-status');
var rateLimit = require('./lib/rate-limit');

var FAL_API_BASE = 'https://queue.fal.run';
var FAL_SYNC_BASE = 'https://fal.run'; // synchronous execution — no scheduler, measured 1.3-1.4s for kokoro (probe 2026-08-04), 1.2-1.4s for ElevenLabs (probe 2026-08-04, same hours kokoro was measured taking 18s+ under load)
var FAL_MODEL_ELEVENLABS = process.env.FAL_MODEL_INTERP_TTS_ELEVENLABS || 'fal-ai/elevenlabs/tts/turbo-v2.5'; // PRIMARY tier, tracker cqveik
var FAL_MODEL = process.env.FAL_MODEL_INTERP_TTS || 'fal-ai/kokoro/american-english'; // FALLBACK tier only, as of the ElevenLabs switch — was the sole model before
var FAL_MODEL_WHISPER = 'fal-ai/whisper'; // kokoro fallback tier's OWN caption path only — interp-audio-status.js aligns captions with this same model for the kokoro QUEUE tier too. NOT used anywhere on the ElevenLabs tier — its captions come built into its own response (see parseElevenLabsCaptions below), by design (tracker cqveik: "DELETE the whisper leg entirely" for that tier specifically).
var SYNC_ELEVENLABS_BUDGET_MS = 5000; // PRIMARY tier — measured 1257/1350/1321ms wall-clock even under the load that broke kokoro (probe 2026-08-04), so ~4x that as a budget is generous headroom without risking this file's own execution ceiling if ElevenLabs has a genuinely bad day; a slow/hung ElevenLabs call should fail fast into the kokoro fallback tiers rather than eat most of the function's budget on a vendor that's supposed to be the fast one.
var SYNC_TTS_BUDGET_MS = 18000;    // real readings are 500-900 chars -> sync TTS can take 10-15s (founder hit the 12s abort on his first real-length reading, 08-04). NOTE (review round 1 of tracker cbdj3d's remaining-polish item, 2026-08-04): the "26s Netlify ceiling" this value was originally sized against has no cited source, and this codebase's OWN transcribe-audio.js documents an empirically-tested (real production 504s hit) 10s function timeout on this plan -- an unresolved conflict. NOT reverting this value though: unlike that speculative polish attempt, THIS number has real production evidence behind it -- the founder has since walked a full-length reading live and confirmed it working (board notes 2026-08-04: "reading voice fixed at root -- 5.3s measured live for a full-length reading", "Sage founder-confirmed working"). If the true ceiling ever turns out to be materially under 18s, that would show up as raw 502/504s in the outcome= logging below rather than this function's own graceful fallback -- worth watching, not yet observed. UNCHANGED by the ElevenLabs switch, but now stacks BEHIND SYNC_ELEVENLABS_BUDGET_MS in the worst case (both vendors failing) — a real, larger worst-case total than before this change, flagged here rather than silently accepted; not yet observed in practice since kokoro alone rarely fails outright.
var SYNC_WHISPER_BUDGET_MS = 3500; // kokoro fallback tier's OWN caption path only, unaffected by the ElevenLabs switch — captions only, a blown budget degrades to sentence-level, never delays the voice (was 8000; live check 08-04 showed whisper eating the whole budget while the founder waits — the voice's own start time outranks word-level captions)
var READING_SPEED = 0.9; // DEFAULT reading pace for both TTS tiers (founder-adjusted 08-04 "slightly too slow at 0.8", then 08-09 sent to ElevenLabs too after Jung's real reading read "too fast" at the old default 1.0). A persona may OVERRIDE it with its own `readingSpeed` (js/interpreter-personas.js) so its reading matches its own intro pace — e.g. Gestalt/Opa Johann reads at 1.1 (0.9 was too slow for that already-slow voice), while Jung/Freud stay at this 0.9 default. Applied per-persona at both the ElevenLabs and kokoro request builders below.

/** Fake but obviously-non-real operationName for GENERATION_MOCK_MODE — see doc block above and generate-video.js's own mockOperationName for the identical convention. */
function mockOperationName() {
  return 'mock:' + Date.now() + ':' + crypto.randomUUID();
}

/**
 * Parses fal-ai/elevenlabs/tts/turbo-v2.5's `timestamps` output field
 * (only present when the request sends `timestamps: true`) into this
 * codebase's existing `{ word, startMs, endMs }` caption shape — the SAME
 * shape InterpAudioStatus.parseWordChunks already produces for the kokoro+
 * whisper fallback tier, so both tiers feed the client one contract
 * regardless of which vendor produced it.
 *
 * INFERRED, NOT CONFIRMED against a real response (flagged plainly here
 * and in this branch's own build report/commit): fal's live OpenAPI schema
 * for this endpoint (fetched 2026-08-04) types `timestamps` only as an
 * untyped array with the description "Timestamps for each word in the
 * generated speech" — it does not publish per-item field names anywhere
 * reachable from this sandbox, and this sandbox has no FAL_KEY to make a
 * real call and observe one. (ElevenLabs' OWN native API — fal wraps
 * ElevenLabs rather than building a model from scratch — returns
 * CHARACTER-level alignment under a differently-shaped `alignment` object;
 * fal's own schema explicitly describes ITS `timestamps` output as
 * word-level and array-shaped instead, so this is presumably a transformed
 * shape, not a passthrough of ElevenLabs' native one — one more reason not
 * to assume a single guessed shape is correct.) Given that, this tries
 * several plausible, commonly-used field-name conventions for a per-word
 * timestamp object (including this codebase's OWN existing whisper-chunk
 * convention, in case fal mirrors it) rather than committing to one guess,
 * and only trusts the result if MOST items parsed cleanly — a low parse
 * rate means the guessed shape is probably wrong, not that a few words are
 * oddly formatted, so it degrades to sentence-level rather than ship a
 * half-correct caption track. A human with real FAL_KEY access should call
 * this endpoint once with `timestamps:true` and confirm/correct this
 * against the real response.
 *
 * Returns null (never []) on anything not confidently parseable — the
 * caller treats null exactly like a missing/failed caption pass, same
 * E508 degrade-to-sentence contract the kokoro tier already uses.
 */
function parseElevenLabsCaptions(rawTimestamps) {
  if (!Array.isArray(rawTimestamps) || !rawTimestamps.length) return null;

  function firstNumber(obj, keys) {
    for (var i = 0; i < keys.length; i++) {
      var v = obj[keys[i]];
      if (typeof v === 'number' && isFinite(v)) return v;
    }
    return null;
  }
  function firstString(obj, keys) {
    for (var i = 0; i < keys.length; i++) {
      var v = obj[keys[i]];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return null;
  }

  // REAL SHAPE, verified against a live call (Manager, 2026-08-05, real
  // FAL_KEY — closing this file's own "FLAGGED for a human with real
  // FAL_KEY access" item): fal's ElevenLabs turbo-v2.5 `timestamps` is an
  // array of CHARACTER-level segments, each
  //   { characters: [" ", "C", "o", ...],
  //     character_start_times_seconds: [...], character_end_times_seconds: [...] }
  // — not word items at all, which is exactly why the defensive word-shape
  // guesses below produced E508 sentence-degrades on the deploy preview.
  // Reconstruct words: accumulate non-space characters, word start = its
  // first char's start, word end = its last char's end. The word-shape loop
  // below stays as a fallback in case fal ever changes to word items.
  var charCaptions = [];
  var sawCharShape = false;
  for (var s = 0; s < rawTimestamps.length; s++) {
    var seg = rawTimestamps[s];
    if (!seg || !Array.isArray(seg.characters) ||
        !Array.isArray(seg.character_start_times_seconds) ||
        !Array.isArray(seg.character_end_times_seconds) ||
        seg.characters.length !== seg.character_start_times_seconds.length ||
        seg.characters.length !== seg.character_end_times_seconds.length) continue;
    sawCharShape = true;
    var buf = '', bufStart = null, bufEnd = null;
    for (var c = 0; c <= seg.characters.length; c++) {
      var ch = c < seg.characters.length ? seg.characters[c] : ' ';
      var isBreak = /\s/.test(ch);
      if (!isBreak) {
        if (buf === '') bufStart = seg.character_start_times_seconds[c];
        buf += ch;
        bufEnd = seg.character_end_times_seconds[c];
      } else if (buf !== '') {
        if (typeof bufStart === 'number' && typeof bufEnd === 'number' && bufEnd >= bufStart) {
          charCaptions.push({ word: buf, startMs: Math.round(bufStart * 1000), endMs: Math.round(bufEnd * 1000) });
        }
        buf = ''; bufStart = null; bufEnd = null;
      }
    }
  }
  if (sawCharShape) return charCaptions.length ? charCaptions : null;

  var captions = [];
  var attempted = 0;
  for (var i = 0; i < rawTimestamps.length; i++) {
    var item = rawTimestamps[i];
    if (!item || typeof item !== 'object') continue;
    attempted += 1;

    var word = firstString(item, ['word', 'text', 'token']);
    var startSec = firstNumber(item, ['start', 'start_time', 'startTime', 'start_seconds']);
    var endSec = firstNumber(item, ['end', 'end_time', 'endTime', 'end_seconds']);

    // This codebase's OWN existing whisper-chunk convention
    // (InterpAudioStatus.parseWordChunks: { text, timestamp: [startSec,
    // endSec] }) — tried as a fallback shape in case fal mirrors it here
    // too, since fal already uses that exact convention elsewhere in this
    // same file's other tier.
    if ((startSec === null || endSec === null) && Array.isArray(item.timestamp) && item.timestamp.length === 2) {
      startSec = typeof item.timestamp[0] === 'number' ? item.timestamp[0] : null;
      endSec = typeof item.timestamp[1] === 'number' ? item.timestamp[1] : null;
    }

    if (!word || startSec === null || endSec === null || endSec < startSec) continue;
    captions.push({ word: word, startMs: Math.round(startSec * 1000), endMs: Math.round(endSec * 1000) });
  }

  // Require most items to have parsed cleanly — a low hit rate means the
  // guessed shape is wrong, not that a few entries are malformed.
  if (!attempted || captions.length < attempted * 0.8) return null;
  return captions.length ? captions : null;
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'E501: method_not_allowed' }) };
  }

  var mockMode = process.env.GENERATION_MOCK_MODE === 'true';

  var falKey = process.env.FAL_KEY;
  if (!mockMode && !falKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'E502: missing_api_key' }) };
  }

  var payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E503: invalid_json' }) };
  }

  var text = (payload.text || '').trim();
  if (!text) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E504: text_required' }) };
  }

  var persona = InterpreterPersonas.get(payload.personaKey);
  if (!persona || !persona.voiceId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E505: unknown_persona' }) };
  }

  var maxPerDay = parseInt(process.env.MAX_INTERP_AUDIO_PER_IP_PER_DAY, 10);
  if (!maxPerDay || maxPerDay <= 0) maxPerDay = 40;

  var ip = rateLimit.clientIp(event);
  var ipLimit = await rateLimit.checkAndIncrement(event, 'interp-audio-ip', ip, maxPerDay);
  if (!ipLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ error: 'E507: rate_limited: too many readings from this network today, try again tomorrow' }) };
  }

  if (mockMode) {
    return { statusCode: 200, body: JSON.stringify({ operationName: mockOperationName() }) };
  }

  var authHeaders = { 'Content-Type': 'application/json', 'Authorization': 'Key ' + falKey };

  // ── Tier 1: ElevenLabs sync (PRIMARY, founder decision 2026-08-04,
  //    tracker cqveik) — see this file's header comment block for the
  //    full three-tier fallback-chain rationale. ──
  var handlerT0 = Date.now();
  var elAudioUrl = null;
  var elCaptions = null;
  var elCtl = new AbortController();
  var elTimer = setTimeout(function () { elCtl.abort(); }, SYNC_ELEVENLABS_BUDGET_MS);
  try {
    // speed: READING_SPEED (0.9) — the founder-tuned reading pace. Sent to the
    // ElevenLabs tier too now (founder 2026-08-09: the default-1.0 ElevenLabs
    // reading ran "too fast"), so both TTS tiers read at the same 0.9 pace and
    // the reading matches the ~0.9 intro. turbo-v2.5 honors `speed` (0.7-1.2);
    // 0.9 verified slower without hurting the ~1.4s gen latency (probe 08-09).
    var elBody = JSON.stringify({ text: text, voice: persona.voiceId, timestamps: true, speed: persona.readingSpeed || READING_SPEED });
    var elRes = await fetch(FAL_SYNC_BASE + '/' + FAL_MODEL_ELEVENLABS, { method: 'POST', headers: authHeaders, body: elBody, signal: elCtl.signal });
    var elData = await elRes.json();
    if (elRes.ok && elData && elData.audio && elData.audio.url) {
      elAudioUrl = elData.audio.url;
      elCaptions = parseElevenLabsCaptions(elData.timestamps);
    }
  } catch (e) { /* fall through to the kokoro fallback tiers below */
  } finally {
    clearTimeout(elTimer); // same "clear it even on a throw/abort" fix documented on the kokoro timer below
  }
  var elElapsedMs = Date.now() - handlerT0;

  if (elAudioUrl) {
    var elOutcome = elCaptions ? 'elevenlabs_word_captions' : 'elevenlabs_sentence_degraded';
    console.log('generate-interp-audio: outcome=' + elOutcome + ' ttsMs=' + elElapsedMs + ' textLen=' + text.length);
    return {
      statusCode: 200,
      body: JSON.stringify(elCaptions ? {
        done: true,
        audioUrl: elAudioUrl,
        audioDurationMs: elCaptions[elCaptions.length - 1].endMs,
        captions: elCaptions,
        captionsLevel: 'word'
      } : {
        done: true,
        audioUrl: elAudioUrl,
        audioDurationMs: null,
        captions: [],
        captionsLevel: 'sentence',
        degradedReason: 'E508: caption_alignment_failed'
      })
    };
  }

  console.log('generate-interp-audio: outcome=elevenlabs_failed_falling_back_to_kokoro ttsMs=' + elElapsedMs + ' textLen=' + text.length);

  if (!persona.kokoroVoiceId) {
    // Defensive only — every persona that ships voice at all is expected
    // to carry both fields (see js/interpreter-personas.js). A persona
    // missing this would otherwise send `voice: undefined` to kokoro,
    // which is worse than a clean failure.
    return { statusCode: 502, body: JSON.stringify({ error: 'E506: tts_request_failed: elevenlabs_failed_and_no_kokoro_fallback_voice_configured' }) };
  }

  // ── Tier 2: kokoro sync (FALLBACK — the ORIGINAL sync-first path,
  //    mechanism unchanged by the ElevenLabs switch, tracker cbdj3d). ──
  // The queue path measured 30s–35min of pure scheduler wait for a ~1.5s
  // TTS job (probe: sync fal.run answered in 1317/1427ms wall-clock).
  // So: call the SYNCHRONOUS endpoint and hand the client a finished
  // result in one round trip — { done:true, audioUrl, captions… } — and
  // only fall back to the legacy queue submit (the { operationName }
  // shape interp-audio-status.js polls) if sync fails or times out.
  // Whisper word-alignment runs sync too, on a tight budget: captions are
  // an enhancement, never worth delaying the voice for (spec §4's own
  // degrade-to-sentence rule) — a blown whisper budget ships the audio
  // with captionsLevel:'sentence' immediately.
  var kokoroT0 = Date.now(); // own baseline, not handlerT0 — this tier's own budget/skip logic below reasons about ITS OWN elapsed time, not the time already spent on the ElevenLabs attempt above
  var ttsBody = JSON.stringify({ prompt: text, voice: persona.kokoroVoiceId, speed: persona.readingSpeed || READING_SPEED });

  var syncAudioUrl = null;
  var ttsCtl = new AbortController();
  var ttsTimer = setTimeout(function () { ttsCtl.abort(); }, SYNC_TTS_BUDGET_MS);
  try {
    var syncRes = await fetch(FAL_SYNC_BASE + '/' + FAL_MODEL, { method: 'POST', headers: authHeaders, body: ttsBody, signal: ttsCtl.signal });
    var syncData = await syncRes.json();
    if (syncRes.ok && syncData && syncData.audio && syncData.audio.url) {
      syncAudioUrl = syncData.audio.url;
    }
  } catch (e) { /* fall through to the queue path */
  } finally {
    // Bug fix (review round 1 of tracker cbdj3d's remaining-polish item):
    // clearTimeout used to sit AFTER the awaited fetch/json() calls, so a
    // thrown fetch (network error, or the abort itself) skipped it
    // entirely, leaving this timer armed for the full budget even though
    // the request had already failed and moved on -- harmless in
    // production (an abandoned AbortController's abort() is a no-op) but
    // it kept the function's event loop alive needlessly, and made every
    // failure-path test in this file take the full budget's worth of real
    // wall-clock time to finish. Same fix applied to the whisper timer
    // below.
    clearTimeout(ttsTimer);
  }
  var ttsElapsedMs = Date.now() - kokoroT0;

  if (syncAudioUrl) {
    var captions = null;
    // Skip whisper entirely when a long TTS already ate most of the wall
    // clock -- word-level captions are an enhancement, never worth risking
    // the function's own execution budget for.
    var whisperBudget = ttsElapsedMs > 11000 ? 0 : SYNC_WHISPER_BUDGET_MS;
    if (whisperBudget) {
      var wCtl = new AbortController();
      var wTimer = setTimeout(function () { wCtl.abort(); }, whisperBudget);
      try {
        var wRes = await fetch(FAL_SYNC_BASE + '/' + FAL_MODEL_WHISPER, {
          method: 'POST', headers: authHeaders,
          body: JSON.stringify({ audio_url: syncAudioUrl, task: 'transcribe', chunk_level: 'word' }),
          signal: wCtl.signal
        });
        var wData = await wRes.json();
        if (wRes.ok) captions = InterpAudioStatus.parseWordChunks(wData);
      } catch (e) { /* sentence-level fallback below */
      } finally {
        clearTimeout(wTimer); // same fix as the TTS timer above
      }
    }

    // Instrumentation (tracker cbdj3d remaining-polish item: "instrument
    // the sync-vs-fallback ratio") -- one summary line per request logging
    // which outcome branch was actually taken and how long the sync TTS
    // leg took (kokoro tier's OWN elapsed time, not counting the earlier
    // ElevenLabs attempt — see elElapsedMs above for that), so a real
    // production log scan can answer "is the current budget actually
    // enough for our longest readings, and is the real function-timeout
    // ceiling ever actually being hit" empirically instead of guessing
    // (see SYNC_TTS_BUDGET_MS's own comment above for the unresolved
    // question this data feeds into).
    var outcome = captions ? 'kokoro_sync_word_captions' : (whisperBudget ? 'kokoro_sync_sentence_degraded' : 'kokoro_sync_whisper_skipped_budget_spent');
    console.log('generate-interp-audio: outcome=' + outcome + ' ttsMs=' + ttsElapsedMs + ' textLen=' + text.length);

    return {
      statusCode: 200,
      body: JSON.stringify(captions ? {
        done: true,
        audioUrl: syncAudioUrl,
        audioDurationMs: captions[captions.length - 1].endMs,
        captions: captions,
        captionsLevel: 'word'
      } : {
        done: true,
        audioUrl: syncAudioUrl,
        audioDurationMs: null,
        captions: [],
        captionsLevel: 'sentence',
        degradedReason: 'E508: caption_alignment_failed'
      })
    };
  }

  console.log('generate-interp-audio: outcome=kokoro_queue_fallback ttsMs=' + ttsElapsedMs + ' textLen=' + text.length);

  // Tier 3: legacy kokoro queue fallback — unchanged contract, polled by interp-audio-status.js.
  try {
    var res = await fetch(FAL_API_BASE + '/' + FAL_MODEL, { method: 'POST', headers: authHeaders, body: ttsBody });
    var data = await res.json();

    if (!res.ok) {
      var message = (data && (data.detail || data.error)) || 'tts_request_failed';
      return { statusCode: res.status, body: JSON.stringify({ error: 'E506: tts_request_failed: ' + (typeof message === 'string' ? message : JSON.stringify(message)) }) };
    }

    return { statusCode: 200, body: JSON.stringify({ operationName: 'fal:' + FAL_MODEL + ':' + data.request_id }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'E506: tts_request_failed' + (e && e.message ? ' (' + e.message + ')' : '') }) };
  }
};

// Exported for test/generate-interp-audio.test.js's own assertions (same
// "export an internal for testability" precedent as generate-video.js's
// FAL_MODEL/buildPrompt exports).
exports.FAL_MODEL = FAL_MODEL; // kokoro — fallback tier
exports.FAL_MODEL_ELEVENLABS = FAL_MODEL_ELEVENLABS; // primary tier
exports.READING_SPEED = READING_SPEED; // kokoro fallback tier only
exports.parseElevenLabsCaptions = parseElevenLabsCaptions;
