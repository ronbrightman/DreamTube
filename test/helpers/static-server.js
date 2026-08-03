// test/helpers/static-server.js
//
// Minimal static file server shared by this repo's browser-driven tests
// (test/ui-behavioral.test.js, test/meta-capi-behavioral.test.js). This
// repo is a static multi-page site with no bundler/dev-server of its own
// (see CLAUDE.md) — exercising a real page over http:// (rather than
// file://, which breaks fetch()-based calls like DreamStore.getSharedFeed,
// since fetch() on file:// has no origin to resolve a relative URL
// against) needs *something* serving the repo root. No new dependency:
// just node:http + node:fs, scoped to the handful of MIME types this app
// actually uses.
//
// This deliberately does NOT serve netlify/functions/* — those are real
// Netlify Functions with no local runtime available here. Tests that need
// a function endpoint (e.g. get-feed, track-conversion) to resolve/fail in
// a controlled way use Playwright's page.route() to intercept it instead.

var http = require('node:http');
var fs = require('node:fs');
var path = require('node:path');

var ROOT = path.join(__dirname, '..', '..');

var MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  // .mp3/.mp4 (tracker item for-product-build-speaking-sage-wave-fou-8uobuh)
  // — real audio/video content-types so test/interp-voice-behavioral.
  // test.js's Chromium run actually decodes the intro's silent visual
  // (assets/interpreters/intro/sage-intro-reference.mp4) and the mocked
  // reading audio (sage-voice-x7q4.mp3), same reasoning as the .wav entry
  // just below (which covers the intro's own real paired voice track,
  // sage-intro-voice.wav).
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  // .wav (tracker item for-product-build-founder-approved-08-03-jlkjy9) —
  // assets/music-beds/*.wav, served with a real audio content-type so a
  // real <audio> element (Chromium, in the behavioral tests that exercise
  // it) actually decodes/plays it rather than treating an
  // application/octet-stream fallback as an unplayable download.
  '.wav': 'audio/wav'
};

/**
 * Starts a static file server. Resolves to { url, close }.
 *
 * `options.root` (added for test/pwa-sw-update-behavioral.test.js's real
 * on-disk-deploy-simulation test) overrides the served directory —
 * defaults to this repo's own root, unchanged for every other caller.
 * Every file is read fresh off disk per-request (no caching layer here),
 * which is exactly what lets that test simulate a real deploy by simply
 * overwriting a file's bytes in a temp directory between requests.
 */
function start(options) {
  var root = (options && options.root) || ROOT;
  return new Promise(function (resolve, reject) {
    var server = http.createServer(function (req, res) {
      var urlPath = decodeURIComponent(req.url.split('?')[0]);
      if (urlPath === '/') urlPath = '/index.html';
      var filePath = path.normalize(path.join(root, urlPath));
      // Never serve anything outside the served root (defends against a
      // "../../" style path in the request even though nothing in these
      // tests sends one).
      if (filePath.indexOf(root) !== 0) {
        res.writeHead(403);
        res.end();
        return;
      }
      fs.readFile(filePath, function (err, data) {
        if (err) {
          res.writeHead(404);
          res.end('not found: ' + urlPath);
          return;
        }
        var ext = path.extname(filePath);
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', function () {
      var port = server.address().port;
      resolve({
        url: 'http://127.0.0.1:' + port,
        close: function () {
          return new Promise(function (r) { server.close(r); });
        }
      });
    });
  });
}

module.exports = { start: start };
