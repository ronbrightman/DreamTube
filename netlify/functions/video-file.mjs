// netlify/functions/video-file.mjs
//
// GET ?key=<blob key> -> streams a stored video out of Netlify Blobs.
// Written as a modern streaming function (ESM, Response-based) rather than
// the classic exports.handler format, since only streaming responses can
// exceed the ~6MB synchronous payload limit that broke the old approach
// of returning video bytes directly from video-status.js.

import { getStore } from '@netlify/blobs';

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
