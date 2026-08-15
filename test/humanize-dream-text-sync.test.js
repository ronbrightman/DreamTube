// test/humanize-dream-text-sync.test.js
//
// Guards the server mirror netlify/functions/lib/humanize-dream-text.js against
// drift from the canonical client implementation js/wizard-chips.js's
// WizardChips.humanizeDreamText (founder-directed 2026-08-15). The two are
// deliberately separate modules (browser <script> vs. Node require), so they
// can't be byte-identical — but they MUST produce identical output for every
// input, or a funnel dream's engineered prompt would be humanized on the client
// but leak in server-rendered emails / the interpretation prompt (or vice
// versa). This is the equivalence net for that split.

var test = require('node:test');
var assert = require('node:assert/strict');

var clientHumanize = require('../js/wizard-chips').humanizeDreamText;
var serverHumanize = require('../netlify/functions/lib/humanize-dream-text').humanizeDreamText;

var CASES = [
  'Medium tracking shot of an animal or creature, watching something magical unfold, in a dreamlike place, Dreamy, surreal mood, hazy ethereal light, Realistic style, dreamlike.',
  'aerial wide shot of a stranger, flying through an open sky, joyful mood, bright daylight, Anime style, dreamlike.',
  'first-person POV shot of me, running, chasing and being chased through an urban setting, tense mood, harsh high-contrast light, Cinematic style, dreamlike.',
  'intimate close-up shot of a stranger, sitting in a calm, still moment, peaceful mood, soft warm light, Realistic style, dreamlike.',
  'sweeping crane shot of an animal or creature, exploring, epic awe-inspiring mood, golden-hour rim light, Cartoon style, dreamlike.',
  'medium tracking shot of the dream, exploring, dreamy surreal mood, hazy ethereal light, dreamlike.',
  'medium tracking shot of a stranger, exploring, hazy ethereal light, Cinematic style, dreamlike.',
  'medium tracking shot of a stranger, exploring, dreamy surreal mood, hazy ethereal light, Cinematic style, dreamlike. The sea was made of glass.',
  'medium tracking shot of an animal or creature, witnessing something magical happen in a surreal, otherworldly place, dreamy surreal mood, hazy ethereal light, Cinematic style, dreamlike.',
  'Low angle of a giant creature, exploring, hazy ethereal light, dreamlike.',
  'I was flying through an open sky, feeling free and weightless.',
  'I was an animal or creature, watching something magical happen somewhere surreal and otherworldly, feeling dreamy and surreal.',
  '', '   ', null, undefined, 0, {}, []
];

test('server mirror humanize-dream-text.js produces identical output to the client WizardChips.humanizeDreamText for every case', function () {
  CASES.forEach(function (c) {
    assert.equal(
      serverHumanize(c),
      clientHumanize(c),
      'server/client mismatch for input: ' + JSON.stringify(c)
    );
  });
});

test('server mirror strips the founder\'s exact example to the human core', function () {
  assert.equal(
    serverHumanize('Medium tracking shot of an animal or creature, watching something magical unfold, in a dreamlike place, Dreamy, surreal mood, hazy ethereal light, Realistic style, dreamlike.'),
    'an animal or creature, watching something magical unfold, in a dreamlike place'
  );
});

test('server mirror is idempotent and no-op on already-clean text', function () {
  var clean = 'I was flying through an open sky, feeling free and weightless.';
  assert.equal(serverHumanize(clean), clean);
  var once = serverHumanize('aerial wide shot of a stranger, flying through an open sky, joyful mood, bright daylight, Anime style, dreamlike.');
  assert.equal(serverHumanize(once), once);
});
