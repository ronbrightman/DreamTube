// netlify/functions/watermarked-video-file.mjs
//
// GET ?key=<dreamId> -> streams a watermarked video TWIN out of Netlify
// Blobs. The literal same pattern as video-file.mjs (see that file's own
// header comment for the full "why a streaming ESM function, why
// createRequire, why the three-way SDK-loading fallback, why redirect-
// first" reasoning — all identical here, duplicated rather than shared per
// this codebase's "each function self-contained" convention, same as
// image-file.mjs already does for the image store) — this is the THIRD
// copy of that same shape, now for lib/watermark-video.js's own
// "dreamtube-videos-watermarked" store (tracker item
// for-product-founder-ruling-08-07-every-u-g81h7v — watermark-on-download).
// If video-file.mjs's own pattern ever changes, update this file and
// image-file.mjs too.
//
// `key` here is a dream's own `id` (see lib/watermark-video.js's own
// header comment for why), not a fal requestId — same durableUrl() shape
// either way: /.netlify/functions/watermarked-video-file?key=<dreamId>.

import { createRequire } from 'module';
var require = createRequire(import.meta.url);
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
    var store = getStore('dreamtube-videos-watermarked');
    result = await store.getWithMetadata(key, { type: 'stream' });
  } catch (e) {
    console.error('watermarked-video-file: blobs read failed', e && e.name, e && e.message);
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

  // EMERGENCY SERVING POSTURE — same as video-file.mjs/image-file.mjs (see
  // video-file.mjs's own header comment, tracker cyp8np): redirect-first
  // whenever a sourceUrl exists; streaming is the fallback for
  // sourceUrl-less records only.
  if (metadata.sourceUrl) {
    return Response.redirect(metadata.sourceUrl, 302);
  }

  return new Response(result.data, {
    status: 200,
    headers: { 'Content-Type': contentType }
  });
};
