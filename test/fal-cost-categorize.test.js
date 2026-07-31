// test/fal-cost-categorize.test.js
//
// Covers netlify/functions/lib/fal-cost-categorize.js's pure
// endpoint_id -> category classifier — tracker item for-product-real-
// per-job-fal-cost-loggin-360bxy.

var test = require('node:test');
var assert = require('node:assert/strict');

var { categorizeEndpoint, CATEGORIES } = require('../netlify/functions/lib/fal-cost-categorize');

test('categorizeEndpoint: every known app-video endpoint classifies as app-video', function () {
  assert.equal(categorizeEndpoint('fal-ai/veo3.1/lite'), CATEGORIES.APP_VIDEO);
  assert.equal(categorizeEndpoint('fal-ai/veo3.1/fast/reference-to-video'), CATEGORIES.APP_VIDEO);
  assert.equal(categorizeEndpoint('fal-ai/veo3.1/fast/image-to-video'), CATEGORIES.APP_VIDEO);
  assert.equal(categorizeEndpoint('fal-ai/wan/v2.2-5b/text-to-video'), CATEGORIES.APP_VIDEO);
});

test('categorizeEndpoint: every known app-image endpoint classifies as app-image', function () {
  assert.equal(categorizeEndpoint('fal-ai/flux/dev'), CATEGORIES.APP_IMAGE);
  assert.equal(categorizeEndpoint('fal-ai/flux/schnell'), CATEGORIES.APP_IMAGE);
});

test('categorizeEndpoint: the app\'s non-video/non-image fal calls (LLM, Whisper) classify as app-other, not creative', function () {
  assert.equal(categorizeEndpoint('fal-ai/whisper'), CATEGORIES.APP_OTHER);
  assert.equal(categorizeEndpoint('fal-ai/openrouter/router/openai/v1/chat/completions'), CATEGORIES.APP_OTHER);
});

test('categorizeEndpoint: an endpoint this app never calls classifies as creative (elimination-based split)', function () {
  assert.equal(categorizeEndpoint('fal-ai/kling-video/v2/master/text-to-video'), CATEGORIES.CREATIVE);
  assert.equal(categorizeEndpoint('fal-ai/ideogram/v2'), CATEGORIES.CREATIVE);
});

test('categorizeEndpoint: falsy/malformed endpoint_id fails toward creative rather than dropping the cost silently', function () {
  assert.equal(categorizeEndpoint(undefined), CATEGORIES.CREATIVE);
  assert.equal(categorizeEndpoint(null), CATEGORIES.CREATIVE);
  assert.equal(categorizeEndpoint(''), CATEGORIES.CREATIVE);
  assert.equal(categorizeEndpoint(42), CATEGORIES.CREATIVE);
});

test('categorizeEndpoint: prefix matching does not false-positive on an unrelated endpoint sharing a short substring', function () {
  // Not 'fal-ai/flux/...' or 'fal-ai/veo3.1...' or 'fal-ai/wan/...' or the
  // app-other prefixes -- must fall through to creative, not accidentally
  // match via a loose substring check.
  assert.equal(categorizeEndpoint('fal-ai/fluxion/text-to-image'), CATEGORIES.CREATIVE);
  assert.equal(categorizeEndpoint('fal-ai/veo2/text-to-video'), CATEGORIES.CREATIVE);
});
