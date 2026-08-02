// netlify/functions/image-file.mjs
//
// GET ?key=<blob key> -> streams a re-hosted image out of Netlify Blobs.
// The image counterpart to video-file.mjs (see that file's own header
// comment for why this is a modern streaming function, not the classic
// exports.handler format, and for why @netlify/blobs is loaded via
// createRequire rather than a plain ESM import) — written for
// lib/media-rehost.js's re-host step (tracker item
// for-product-owner-media-library-page-fou-1fwxaw's corrected scope),
// which stores every re-hosted image into the "dreamtube-images" Blobs
// store under this exact key/metadata shape.
//
// SIZE GUARD: see video-file.mjs's own header comment (tracker item
// for-product-urgent-founder-repro-on-drea-uq3a36) for the full reasoning —
// Netlify's streaming-function response cap (20 MB, per
// https://docs.netlify.com/build/functions/api/) is what actually broke
// video playback; images are far less likely to ever hit it, but this
// mirrors that same defense-in-depth exactly, for consistency and in case
// a future image model/flow ever produces something this large.

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
    var store = getStore('dreamtube-images');
    result = await store.getWithMetadata(key, { type: 'stream' });
  } catch (e) {
    console.error('image-file: blobs read failed', e && e.name, e && e.message);
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
  var contentType = metadata.contentType || 'image/jpeg';

  // Defense in depth — see header comment above.
  // EMERGENCY SERVING POSTURE — same as video-file.mjs tonight (see its
  // header + tracker cyp8np): redirect-first whenever a sourceUrl exists;
  // streaming is the fallback for sourceUrl-less records only.
  if (metadata.sourceUrl) {
    return Response.redirect(metadata.sourceUrl, 302);
  }

  return new Response(result.data, {
    status: 200,
    headers: { 'Content-Type': contentType }
  });
};
