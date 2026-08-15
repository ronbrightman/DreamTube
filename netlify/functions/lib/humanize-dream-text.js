// netlify/functions/lib/humanize-dream-text.js
//
// SERVER MIRROR of js/wizard-chips.js's WizardChips.humanizeDreamText (founder-directed
// 2026-08-15). Node functions can't <script>-load the browser wizard-chips module, so
// this is the byte-for-byte-EQUIVALENT (not byte-identical — different module wrapper)
// copy for server use: the interpretation endpoint and the "your dream is ready" /
// unwatched-dream / interpretation retention email senders all read a dream's stored
// caption/storyText, which for a FUNNEL-built dream is the engineered fal prompt
// ("Medium tracking shot of …, dreamy surreal mood, hazy ethereal light, Cinematic
// style, dreamlike."). That text is right for promptText -> generate-video.js, but must
// never be shown to a human or fed to the interpretation LLM.
//
// This strips the same two engineered wrappers the client function does:
//   (a) the leading camera-shot phrase ("… shot of" / "… angle of"), and
//   (b) the trailing ", <mood> mood, <lighting>, <style> style, dreamlike." boilerplate,
// preserving any free-typed text after "dreamlike.".
//
// Pure and IDEMPOTENT: a no-op on already-clean text (a real free-typed sentence, or the
// deterministic human story), running twice equals running once, empty/null/non-string
// in -> '' out.
//
// KEEP IN SYNC with js/wizard-chips.js's humanizeDreamText — the two regexes/tidy below
// are intentionally identical to that function's body. NEVER call this on promptText /
// the text sent to generate-video.js / fal.

'use strict';

function humanizeDreamText(text) {
  if (typeof text !== 'string') return '';
  var s = text.trim();
  if (!s) return '';

  // (a) Leading camera phrase — the five known inferCamera outputs, then a generic
  // "<words> shot of" / "<words> angle of" fallback; the char class excludes commas so
  // it can never reach across into the first real content clause.
  s = s.replace(
    /^(?:aerial wide shot|first-person POV shot|intimate close-up shot|medium tracking shot|sweeping crane shot|[A-Za-z][\w'\- ]*?(?:shot|angle)) of\s+/i,
    ''
  );

  // (b) Trailing engineered boilerplate: an optional "<mood> mood," clause (the leading
  // mood-adjective alternation handles the "…, Dreamy, surreal mood, …" two-clause
  // variant without swallowing a one-word action/place clause like "…, exploring, …"),
  // the always-present lighting clause (any clause containing "light"), an optional
  // "<style> style," clause, then the terminal "dreamlike.". Free text after
  // "dreamlike." is preserved as its own sentence.
  s = s.replace(
    /,\s*(?:(?:(?:dreamy|surreal|peaceful|joyful|mysterious|tense|epic|awe-inspiring),\s*)?[^,]*\bmood\b[^,]*,\s*)?[^,]*light[^,]*,\s*(?:[^,]*\bstyle\b[^,]*,\s*)?dreamlike\.?([\s\S]*)$/i,
    function (_m, tail) {
      tail = (tail || '').trim();
      return tail ? '. ' + tail : '';
    }
  );

  return s.replace(/\s+/g, ' ').replace(/\s+([,.])/g, '$1').replace(/,\s*$/, '').trim();
}

module.exports = { humanizeDreamText: humanizeDreamText };
