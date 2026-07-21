// test/helpers/static-server.js
//
// Minimal static file server for test/ui-behavioral.test.js. This repo is
// a static multi-page site with no bundler/dev-server of its own (see
// CLAUDE.md) — exercising a real page over http:// (rather than file://,
// which breaks fetch()-based calls like DreamStore.getSharedFeed, since
// fetch() on file:// has no origin to resolve a relative URL against)
// needs *something* serving the repo root. No new dependency: just
// node:http + node:fs, scoped to the handful of MIME types this app
// actually uses.
//
// This deliberately does NOT serve netlify/functions/* — those are real
// Netlify Functions with no local runtime available here. Tests that need
// DreamStore.getSharedFeed()'s underlying fetch('/.netlify/functions/get-feed')
// to resolve/fail in a controlled way use Playwright's page.route() to
// intercept it instead (see ui-behavioral.test.js).

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
  '.webmanifest': 'application/manifest+json'
};

/** Starts a static file server for the repo root. Resolves to { url, close }. */
function start() {
  return new Promise(function (resolve, reject) {
    var server = http.createServer(function (req, res) {
      var urlPath = decodeURIComponent(req.url.split('?')[0]);
      if (urlPath === '/') urlPath = '/index.html';
      var filePath = path.normalize(path.join(ROOT, urlPath));
      // Never serve anything outside the repo root (defends against a
      // "../../" style path in the request even though nothing in these
      // tests sends one).
      if (filePath.indexOf(ROOT) !== 0) {
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
