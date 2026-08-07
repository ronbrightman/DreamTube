// test/helpers/cross-origin-video-server.js
//
// Minimal standalone video server for
// test/result-thumbnail-crossorigin-capture-behavioral.test.js. Deliberately
// NOT the shared static-server.js helper: that server always runs on the
// SAME origin as the page under test, and this test needs a genuinely
// different origin (different port on 127.0.0.1 already counts as
// cross-origin per the same-origin policy) with CONTROLLABLE CORS headers,
// to reproduce/verify the exact browser mechanics behind tracker item
// for-product-p1-regression-evidence-found-7lbwkx (see result.html's
// thumbnail-capture IIFE for the full root-cause writeup).
//
// Serves ONE real, on-disk video file: test/fixtures/thumbnail-capture-video.webm
// (VP8/WebM, not the repo's usual mp4 assets — see
// test/fixtures/generate-thumbnail-capture-video.md for exactly why: this
// sandbox's headless Chromium build has no H.264 decoder at all, so an mp4
// never actually decodes here and would prove nothing) with a real
// video/webm content-type and real Range/206 support, since some browsers
// rely on Range requests to actually start decoding a <video> element's
// frames rather than just downloading the whole file up front.
//
// `options.cors` (boolean) controls whether responses carry
// `Access-Control-Allow-Origin: *` — the whole point of this test fixture
// is exercising BOTH the "CDN sends no CORS headers" case (must stay a
// silent no-op, same as before the fix) and the "CDN cooperates" case
// (must now actually succeed) against the exact same real video bytes.

var http = require('node:http');
var fs = require('node:fs');

function start(options) {
  var cors = !!(options && options.cors);
  var filePath = (options && options.filePath) || require('node:path').join(
    __dirname, '..', 'fixtures', 'thumbnail-capture-video.webm'
  );

  return new Promise(function (resolve, reject) {
    var server = http.createServer(function (req, res) {
      fs.stat(filePath, function (statErr, stat) {
        if (statErr) {
          res.writeHead(404);
          res.end('not found');
          return;
        }
        var headers = { 'Content-Type': 'video/webm', 'Accept-Ranges': 'bytes' };
        if (cors) headers['Access-Control-Allow-Origin'] = '*';

        var range = req.headers.range;
        if (range) {
          var m = /bytes=(\d+)-(\d*)/.exec(range);
          var start = m ? parseInt(m[1], 10) : 0;
          var end = (m && m[2]) ? parseInt(m[2], 10) : stat.size - 1;
          if (end >= stat.size) end = stat.size - 1;
          headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + stat.size;
          headers['Content-Length'] = String(end - start + 1);
          res.writeHead(206, headers);
          fs.createReadStream(filePath, { start: start, end: end }).pipe(res);
          return;
        }
        headers['Content-Length'] = String(stat.size);
        res.writeHead(200, headers);
        fs.createReadStream(filePath).pipe(res);
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', function () {
      var port = server.address().port;
      resolve({
        url: 'http://127.0.0.1:' + port + '/video.webm',
        close: function () {
          return new Promise(function (r) { server.close(r); });
        }
      });
    });
  });
}

module.exports = { start: start };
