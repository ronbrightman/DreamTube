// test/verification-email-welcome.test.js
//
// Covers the WARM WELCOME addition to the transactional signup verification
// email (founder-approved 2026-08-12: add a short, warm product-intro welcome
// to the SAME email that already carries the 6-digit code + verify link — not
// a separate email). The email stays PRIMARILY TRANSACTIONAL: the code + link
// remain the most prominent thing at the top so deliverability isn't hurt; the
// welcome is a light, tasteful addition below.
//
// Asserts, against lib/verification-email-sender.js's exported buildHtml:
//   - the 6-digit code is still present AND still rendered prominently (the
//     large 32px style), and is still the FIRST content in the email;
//   - the verify link is still present;
//   - the "already signed in" transactional line is preserved;
//   - the welcome block is present (greeting + what DreamTube is + a gentle
//     nudge to make a first dream) and sits AFTER the code (never above it);
//   - the welcome copy adds NO digits that could be mistaken for the code by
//     the code-extraction the other tests rely on.
// Run with: node --test test/

var test = require('node:test');
var assert = require('node:assert/strict');

var sender = require('../netlify/functions/lib/verification-email-sender');

var CODE = '482913';
var VERIFY_URL = 'https://dreamtube.life/.netlify/functions/verify-email-link?token=abc.def';

test('buildHtml keeps the code prominent AND present as the first content', function () {
  var html = sender.buildHtml(CODE, VERIFY_URL);
  assert.ok(html.indexOf(CODE) !== -1, 'the 6-digit code is present');
  // The code still rides the large 32px prominence style, unchanged.
  assert.match(html, /font-size:32px;[^>]*>[\s]*482913/, 'the code is still rendered in the large 32px prominent style');
  // The code-extraction the other tests rely on (first 6-digit run) still lands
  // on the real code — the welcome copy introduces no competing digits.
  assert.equal(/(\d{6})/.exec(html)[1], CODE, 'the first 6-digit run in the email is the real code');
});

test('buildHtml still carries the verify link and the transactional "already signed in" line', function () {
  var html = sender.buildHtml(CODE, VERIFY_URL);
  assert.ok(html.indexOf(VERIFY_URL) !== -1, 'the verify-email-link is preserved');
  assert.match(html, /verify instantly/i, 'the verify-link label is preserved');
  assert.match(html, /already signed in/i, 'the transactional confirmation line is preserved');
});

test('buildHtml adds a warm welcome block AFTER the code (transactional stays first)', function () {
  var html = sender.buildHtml(CODE, VERIFY_URL);
  assert.match(html, /Welcome to DreamTube/, 'a warm greeting is present');
  assert.match(html, /dreams into short AI videos/i, 'says what DreamTube is (dreams -> short AI videos)');
  assert.match(html, /see what they might mean/i, 'names the meaning angle');
  assert.match(html, /describe a dream/i, 'a gentle nudge toward making a first dream');

  // Prominence guarantee: the code must appear BEFORE the welcome greeting, so
  // the transactional payload is never visually outranked by the promo copy.
  assert.ok(html.indexOf(CODE) < html.indexOf('Welcome to DreamTube'),
    'the code comes first; the welcome sits below it');
});
