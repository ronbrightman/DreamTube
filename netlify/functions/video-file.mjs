// netlify/functions/video-file.mjs
//
// GET ?key=<blob key> -> streams a stored video out of Netlify Blobs.
// Written as a modern streaming function (ESM, Response-based) rather than
// the classic exports.handler format, since only streaming responses can
// exceed the ~6MB synchronous payload limit that broke the old approach
// of returning video bytes directly from video-status.js.
//
// @netlify/blobs is loaded via createRequire (CommonJS), not a plain ESM
// `import`, even though this file is itself ESM (Netlify's own requirement
// for a streaming function) — deliberately: this codebase's dominant
// convention is require()'d, self-contained functions (see CLAUDE.md), and
// @netlify/blobs' own package.json exports a genuinely SEPARATE physical
// file for its "import" condition (dist/main.js) vs. its "require"
// condition (dist/main.cjs) — two different module instances Node's own
// loader would otherwise never unify. test/helpers/mock-blobs.js's
// require.cache-swap technique (used by every other Blobs-backed function
// in this codebase's test suite) only ever patches the CJS entry, so a
// plain ESM `import` here would silently bypass it entirely in tests
// (confirmed while adding test/media-file-functions.test.js — a real
// MissingBlobsEnvironmentError from the genuine, unmocked package). Same
// getStore function either way at runtime; this just keeps it on the one
// module identity the rest of the app's mocking already covers.
import { createRequire } from 'module';
var require = createRequire(import.meta.url);
var { getStore } = require('@netlify/blobs');

export default async (req) => {
  var key = new URL(req.url).searchParams.get('key');
  if (!key) {
    return new Response(JSON.stringify({ error: 'key_required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  var store = getStore('dreamtube-videos');
  var result = await store.getWithMetadata(key, { type: 'stream' });
  if (!result) {
    return new Response(JSON.stringify({ error: 'not_found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  var contentType = (result.metadata && result.metadata.contentType) || 'video/mp4';
  return new Response(result.data, {
    status: 200,
    headers: { 'Content-Type': contentType }
  });
};
