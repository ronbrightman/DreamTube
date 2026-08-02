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
//
// SIZE GUARD (added 2026-08-02, tracker item
// for-product-urgent-founder-repro-on-drea-uq3a36): Netlify's own docs
// (https://docs.netlify.com/build/functions/api/, "Streaming responses")
// state "Streaming functions have a 60-second execution limit and a 20 MB
// response size limit" — this function IS exactly that kind of function, so
// attempting to stream anything bigger 502s with an opaque
// "error decoding lambda response: unexpected end of JSON input" (Netlify's
// own Lambda-response-streaming adapter breaking on an oversized body, not
// a bug in the Blobs call itself — its shape is correct against the
// installed SDK's own types in both the 8.x and 10.x majors). The real fix
// is upstream, in lib/media-rehost.js: it now gates on the same
// MAX_STREAMABLE_BYTES ceiling and never hands out a durable url for
// anything over it in the first place. What's below is a SECOND, defensive
// layer for anything that reaches this store oversized anyway (a future
// regression in that gate, a mis-set threshold, or any other path that
// ever writes into this store without going through rehostBestEffort):
// redirect to the ORIGINAL fal url recorded in metadata.sourceUrl at write
// time, rather than attempting (and failing) to stream. Duplicated as a
// literal, not required from lib/media-rehost.js, matching this codebase's
// "each function self-contained" convention (see that module's own header
// comment) — if it ever changes, update both.
import { createRequire } from 'module';
var require = createRequire(import.meta.url);
// Bulletproof SDK loading (2026-08-02 night, tracker cyp8np): production
// 502s persisted through BOTH the 8.x require and the blobs10 alias with
// the crash upstream of handler logic -- i.e., the require itself dies at
// module load in the deployed bundle (the bundler does not ship
// createRequire'd deps for this function style the way the test runner
// resolves them). Three-way fallback: the aliased CJS require (what the
// test suite's require-cache mock patches), the plain CJS require, and
// finally a dynamic ESM import (statically analyzable literal -- the
// bundler ships @netlify/blobs' ESM entry for it, and it self-configures
// in this runtime). First one that loads wins; the handler try/catch
// below surfaces anything that still fails as a visible 500.
var getStoreImpl = null;
async function loadGetStore() {
  if (getStoreImpl) return getStoreImpl;
  try { getStoreImpl = require('blobs10').getStore; return getStoreImpl; } catch (e) {}
  try { getStoreImpl = require('@netlify/blobs').getStore; return getStoreImpl; } catch (e) {}
  var mod = await import('@netlify/blobs');
  getStoreImpl = mod.getStore;
  return getStoreImpl;
}

var MAX_STREAMABLE_BYTES = 18 * 1024 * 1024;

export default async (req) => {
  var key = new URL(req.url).searchParams.get('key');
  if (!key) {
    return new Response(JSON.stringify({ error: 'key_required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  var result;
  try {
    var getStore = await loadGetStore();
    var store = getStore('dreamtube-videos');
    result = await store.getWithMetadata(key, { type: 'stream' });
  } catch (e) {
    console.error('video-file: blobs read failed', e && e.name, e && e.message);
    return new Response(JSON.stringify({ error: 'store_unavailable' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  if (!result) {
    return new Response(JSON.stringify({ error: 'not_found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  var metadata = result.metadata || {};
  var contentType = metadata.contentType || 'video/mp4';

  // EMERGENCY SERVING POSTURE (2026-08-02 night, tracker
  // for-product-urgent-reopen-video-repair-p-cyp8np): streaming through
  // this function 502s in production for ALL sizes, not just over-ceiling
  // ones — founder-verified on a freshly generated few-MB clip after the
  // size gate shipped, and reproducible on every own-storage feed url. The
  // durable copy stays in Blobs, but until streaming is demonstrably fixed
  // AND pinned by a prod-smoke check that fetches a real stored video,
  // serving REDIRECTS to the original fal url (protected from expiry by
  // FAL_NO_EXPIRY_HEADER since a098b14) whenever one was recorded at write
  // time. Streaming below is now the fallback for sourceUrl-less records
  // only.
  if (metadata.sourceUrl) {
    return Response.redirect(metadata.sourceUrl, 302);
  }

  return new Response(result.data, {
    status: 200,
    headers: { 'Content-Type': contentType }
  });
};
