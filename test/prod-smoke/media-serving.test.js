// test/prod-smoke/media-serving.test.js
//
// See test/prod-smoke/README.md for the full picture. This one file is
// narrower than its siblings: a plain HTTP check (no browser needed) that
// video-file.mjs/image-file.mjs — the currently-deployed functions — are
// actually serving real stored media, catching a regression class no other
// test in this repo can: test/media-file-functions.test.js mocks
// @netlify/blobs entirely (see that file's own header comment on why —
// mock-blobs.js hands back a raw ArrayBuffer, never a real stream), so it
// cannot see a real deploy-time failure like the one this check exists
// because of.
//
// WHY THIS EXISTS (tracker item for-product-add-a-prod-smoke-assertion-f-
// bqt2sh, a direct follow-up to for-product-urgent-reopen-video-repair-p-
// cyp8np): on 2026-08-02, video-file.mjs/image-file.mjs crashed at MODULE
// LOAD in the deployed bundle (a createRequire'd @netlify/blobs import that
// never resolved in production for this function style) — dead since the
// own-storage cutover, invisible to the mocked unit suite, and only ever
// caught by the founder hitting real black screens. Fixed on main (commits
// 8432c16/615fe16/35dd517: redirect-first serving posture + a three-way
// SDK loader). This check is the daily guard against that regression class
// recurring silently.
//
// FIXTURE KEY: a real, permanently-stored founder dream's video —
// 019fc2e9-2f8d-7dc0-8ce7-7efd3acf0d2f — independently verified reachable
// (200, video/mp4) against real production at the time this test was
// written (2026-08-02 22:10 UTC, `curl -sI
// https://dreamtube1.netlify.app/.netlify/functions/video-file?key=...`).
// Picked over uploading a fresh fixture because (a) it needs no write
// access / no fal spend to establish, matching this suite's zero-cost
// posture (see README.md's "Safety" section), and (b) it's the exact
// record the founder himself confirmed playing when cyp8np closed — testing
// the real regression's own real evidence, not a synthetic stand-in. Risk:
// if this specific dream is ever deleted (account deletion, content
// moderation), this check starts failing not because serving broke but
// because the fixture is gone — if that happens, replace
// MEDIA_SMOKE_VIDEO_KEY with another real key from a durable published
// dream (any own-storage feed item's videoUrl `?key=` param) rather than
// treating a stale-fixture failure as a live incident.
//
// IMAGE COVERAGE — deliberately partial: no equivalently-verified real
// image key was available to hardcode at the time this was written (no
// prior tracker discussion named one, and this sandbox has no owner
// credentials to look one up via admin-media-library-data.js). Rather than
// guess or fabricate one, the image assertion is opt-in via the
// MEDIA_SMOKE_IMAGE_KEY env var and SKIPS with a clear reason when unset —
// an honest gap, not a silently-passing check. Whoever has owner access can
// supply a real key once (any published image dream's imageUrl `?key=`
// param) to close this gap permanently; see README.md for how env vars
// reach this suite.

var test = require('node:test');
var assert = require('node:assert/strict');
var config = require('./helpers/config');

var MEDIA_SMOKE_VIDEO_KEY = '019fc2e9-2f8d-7dc0-8ce7-7efd3acf0d2f';

test('video-file.mjs serves a real stored video: 200 + video content-type, not a 502/500', async function () {
  var res = await fetch(config.origin + '/.netlify/functions/video-file?key=' + encodeURIComponent(MEDIA_SMOKE_VIDEO_KEY), { redirect: 'manual' });
  // Either a direct 200 stream, or the emergency redirect-first posture's
  // 302 to the original fal source url (see video-file.mjs's own header
  // comment) — both are a WORKING serving path. What must never happen
  // again is a 502/500/opaque failure.
  assert.ok(res.status === 200 || res.status === 302, 'expected 200 (streamed) or 302 (redirect-first posture), got ' + res.status);
  if (res.status === 200) {
    assert.match(res.headers.get('content-type') || '', /^video\//, 'a 200 response must actually be video content, not an error JSON body mislabeled 200');
  } else {
    var location = res.headers.get('location');
    assert.ok(location && /^https:\/\//.test(location), 'a 302 must redirect to a real absolute url, got ' + location);
  }
});

test('image-file.mjs serves a real stored image: 200 + image content-type, not a 502/500', { skip: !process.env.MEDIA_SMOKE_IMAGE_KEY ? 'MEDIA_SMOKE_IMAGE_KEY not set -- see this file\'s own header comment on why image coverage is opt-in' : false }, async function () {
  var res = await fetch(config.origin + '/.netlify/functions/image-file?key=' + encodeURIComponent(process.env.MEDIA_SMOKE_IMAGE_KEY), { redirect: 'manual' });
  assert.ok(res.status === 200 || res.status === 302, 'expected 200 (streamed) or 302 (redirect-first posture), got ' + res.status);
  if (res.status === 200) {
    assert.match(res.headers.get('content-type') || '', /^image\//, 'a 200 response must actually be image content, not an error JSON body mislabeled 200');
  } else {
    var location = res.headers.get('location');
    assert.ok(location && /^https:\/\//.test(location), 'a 302 must redirect to a real absolute url, got ' + location);
  }
});

test('video-file.mjs still returns a clean 404 (not a 502) for a genuinely unknown key -- proves the function itself is alive, not just accidentally redirecting everything', async function () {
  var res = await fetch(config.origin + '/.netlify/functions/video-file?key=prod-smoke-deliberately-nonexistent-key-' + Date.now());
  assert.equal(res.status, 404);
});
