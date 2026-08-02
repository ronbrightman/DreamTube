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

  var store = getStore('dreamtube-images');
  var result = await store.getWithMetadata(key, { type: 'stream' });
  if (!result) {
    return new Response(JSON.stringify({ error: 'not_found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  var contentType = (result.metadata && result.metadata.contentType) || 'image/jpeg';
  return new Response(result.data, {
    status: 200,
    headers: { 'Content-Type': contentType }
  });
};
