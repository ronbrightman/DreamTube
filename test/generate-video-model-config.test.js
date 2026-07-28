// test/generate-video-model-config.test.js
//
// Covers tracker item for-product-switch-default-video-model-t-lqxafa
// (founder decision 2026-07-28, after a real 2-round visual eval): the
// standard text-to-video model id is now env-configurable
// (FAL_MODEL_TEXT_TO_VIDEO), defaulting to fal-ai/veo3.1/lite, so a revert
// to Fast is a pure env-var flip + redeploy — never a code change. The
// reference-to-video (self-photo) and image-to-video ("turn this into a
// video") paths are deliberately NOT part of this switch (no Lite
// reference-to-video variant exists in fal's catalog yet, and a Lite
// image-to-video switch is an explicit separate follow-up) — both stay
// pinned to their /fast variants.
//
// FAL_MODEL is read from process.env at module-load time (a plain top-level
// `var`, not re-read per request), so exercising the env-var override
// requires setting it BEFORE this file's own require() below — this only
// works because node's test runner gives each test *file* passed on the
// command line its own process, so this file's env var never leaks into
// (or gets clobbered by) any other test file's module cache.

var test = require('node:test');
var assert = require('node:assert/strict');

test('FAL_MODEL_TEXT_TO_VIDEO unset: FAL_MODEL defaults to fal-ai/veo3.1/lite', function () {
  delete process.env.FAL_MODEL_TEXT_TO_VIDEO;
  delete require.cache[require.resolve('../netlify/functions/generate-video')];
  var genVideo = require('../netlify/functions/generate-video');
  assert.equal(genVideo.FAL_MODEL, 'fal-ai/veo3.1/lite');
});

test('FAL_MODEL_TEXT_TO_VIDEO set: overrides the default — a revert to Fast is a pure env flip, no code change', function () {
  process.env.FAL_MODEL_TEXT_TO_VIDEO = 'fal-ai/veo3.1/fast';
  delete require.cache[require.resolve('../netlify/functions/generate-video')];
  var genVideo = require('../netlify/functions/generate-video');
  assert.equal(genVideo.FAL_MODEL, 'fal-ai/veo3.1/fast');
  delete process.env.FAL_MODEL_TEXT_TO_VIDEO;
  delete require.cache[require.resolve('../netlify/functions/generate-video')];
});

test('FAL_MODEL_TEXT_TO_VIDEO set to an arbitrary value: passed through as-is (no validation against a fixed allowlist)', function () {
  process.env.FAL_MODEL_TEXT_TO_VIDEO = 'fal-ai/veo3.1/some-future-variant';
  delete require.cache[require.resolve('../netlify/functions/generate-video')];
  var genVideo = require('../netlify/functions/generate-video');
  assert.equal(genVideo.FAL_MODEL, 'fal-ai/veo3.1/some-future-variant');
  delete process.env.FAL_MODEL_TEXT_TO_VIDEO;
  delete require.cache[require.resolve('../netlify/functions/generate-video')];
});

// ----- Scope: only the standard text-to-video model moved — confirms the
// switch didn't also silently touch the two paths tracker item
// for-product-switch-default-video-model-t-lqxafa explicitly says must stay
// on Fast (no Lite reference-to-video variant exists yet; Lite image-to-
// video is a separate follow-up). -----

test('FAL_MODEL_REFERENCE_TO_VIDEO (the self-photo path) stays pinned to the Fast variant, unaffected by FAL_MODEL_TEXT_TO_VIDEO', function () {
  process.env.FAL_MODEL_TEXT_TO_VIDEO = 'fal-ai/veo3.1/lite';
  delete require.cache[require.resolve('../netlify/functions/generate-video')];
  var genVideo = require('../netlify/functions/generate-video');
  assert.equal(genVideo.FAL_MODEL_REFERENCE_TO_VIDEO, 'fal-ai/veo3.1/fast/reference-to-video');
  delete process.env.FAL_MODEL_TEXT_TO_VIDEO;
  delete require.cache[require.resolve('../netlify/functions/generate-video')];
});

test('FAL_MODEL_IMAGE_TO_VIDEO (the "turn image into video" upsell) stays pinned to the Fast variant, unaffected by FAL_MODEL_TEXT_TO_VIDEO', function () {
  process.env.FAL_MODEL_TEXT_TO_VIDEO = 'fal-ai/veo3.1/lite';
  delete require.cache[require.resolve('../netlify/functions/generate-video')];
  var genVideo = require('../netlify/functions/generate-video');
  assert.equal(genVideo.FAL_MODEL_IMAGE_TO_VIDEO, 'fal-ai/veo3.1/fast/image-to-video');
  delete process.env.FAL_MODEL_TEXT_TO_VIDEO;
  delete require.cache[require.resolve('../netlify/functions/generate-video')];
});
