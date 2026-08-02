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
var { getStore } = require('@netlify/blobs');

var MAX_STREAMABLE_BYTES = 18 * 1024 * 1024;

export default async (req) => {
  var key = new URL(req.url).searchParams.get('key');
  if (!key) {
    return new Response(JSON.stringify({ error: 'key_required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  var store = getStore('dreamtube-images');
  var result = await store.getWithMetadata(key, { type: 'stream' });
  if (!result) {
    return new Response(JSON.stringify({ error: 'not_found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  var metadata = result.metadata || {};
  var contentType = metadata.contentType || 'image/jpeg';

  // Defense in depth — see header comment above.
  if (typeof metadata.byteLength === 'number' && metadata.byteLength > MAX_STREAMABLE_BYTES && metadata.sourceUrl) {
    return Response.redirect(metadata.sourceUrl, 302);
  }

  return new Response(result.data, {
    status: 200,
    headers: { 'Content-Type': contentType }
  });
};
