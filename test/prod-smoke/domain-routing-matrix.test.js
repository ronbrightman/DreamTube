// test/prod-smoke/domain-routing-matrix.test.js
//
// Reliability net, piece 3 ("routing matrix") — tracker item
// for-product-reliability-net-spec-v1-smok-x1o5zc. See
// docs/DOMAIN_ROUTING_MATRIX.md for the full write-up (what's verified,
// how it relates to docs/DOMAIN_MIGRATION_CUTOVER_CHECKLIST.md). This
// file is the CI-catchable regression pin for that doc — a plain HTTP
// check (no browser needed, same shape as media-serving.test.js), always
// against BOTH real production hosts by name, regardless of whatever
// `--origin`/`PROD_SMOKE_ORIGIN` this suite's run was pointed at (this is
// deliberately NOT config.js's single resolved `origin` — the whole point
// of this file is the RELATIONSHIP between the two real domains, not
// "whichever one origin resolution picked").
//
// WHY THIS MATTERS: docs/DOMAIN_ROUTING_MATRIX.md documents that BOTH
// dreamtube1.netlify.app and dreamtube.life are genuinely live production
// surfaces today, serving the same deploy, with dreamtube.life as the
// canonical/primary host (Netlify stamps a `Link: rel="canonical"` header
// on the netlify.app alias's own responses pointing at dreamtube.life,
// and does NOT stamp that header on dreamtube.life's own responses). Two
// real founder-reported bugs already came from exactly this class of
// regression (for-product-urgent-founder-repro-on-drea-uq3a36,
// for-product-urgent-founder-repro-index-g-c6boa9, both 2026-08-02) — a
// routing/origin difference nobody had a routine check for. This test IS
// that routine check.

var test = require('node:test');
var assert = require('node:assert/strict');

var NETLIFY_APP_HOST = 'https://dreamtube1.netlify.app';
var LIFE_HOST = 'https://dreamtube.life';

test('both real production hosts serve a real 200 for home.html', async function () {
  var netlifyAppRes = await fetch(NETLIFY_APP_HOST + '/home.html');
  var lifeRes = await fetch(LIFE_HOST + '/home.html');
  assert.equal(netlifyAppRes.status, 200, 'dreamtube1.netlify.app/home.html must be a live 200');
  assert.equal(lifeRes.status, 200, 'dreamtube.life/home.html must be a live 200');
});

test('dreamtube1.netlify.app marks itself as an alias of dreamtube.life via the canonical Link header', async function () {
  var res = await fetch(NETLIFY_APP_HOST + '/home.html');
  var link = res.headers.get('link') || '';
  assert.match(link, /rel="canonical"/, 'expected a rel="canonical" Link header on the netlify.app alias');
  assert.match(link, /dreamtube\.life\/home\.html/, 'the canonical Link header must point at dreamtube.life for the SAME path, got: ' + link);
});

test('dreamtube.life does NOT carry a canonical Link header pointing elsewhere -- confirms IT is the canonical host, not the alias', async function () {
  var res = await fetch(LIFE_HOST + '/home.html');
  var link = res.headers.get('link');
  assert.ok(!link || link.indexOf('rel="canonical"') === -1, 'dreamtube.life should be the canonical host itself, not carry a canonical pointer to somewhere else; got Link: ' + link);
});

test('www.dreamtube.life redirects to the bare dreamtube.life apex', async function () {
  var res = await fetch('https://www.dreamtube.life/', { redirect: 'manual' });
  assert.ok(res.status >= 300 && res.status < 400, 'expected a redirect status, got ' + res.status);
  var location = res.headers.get('location') || '';
  assert.match(location, /^https:\/\/dreamtube\.life\//, 'www must redirect to the bare apex domain, got: ' + location);
});

test('a core function endpoint (get-feed) is equally live on both hosts, not just the primary one', async function () {
  var netlifyAppRes = await fetch(NETLIFY_APP_HOST + '/.netlify/functions/get-feed');
  var lifeRes = await fetch(LIFE_HOST + '/.netlify/functions/get-feed');
  assert.equal(netlifyAppRes.status, 200, 'get-feed must be live on dreamtube1.netlify.app');
  assert.equal(lifeRes.status, 200, 'get-feed must be live on dreamtube.life');

  var netlifyAppBody = await netlifyAppRes.json();
  var lifeBody = await lifeRes.json();
  assert.ok(Array.isArray(netlifyAppBody.feed), 'dreamtube1.netlify.app get-feed must return a real feed array');
  assert.ok(Array.isArray(lifeBody.feed), 'dreamtube.life get-feed must return a real feed array');
});
