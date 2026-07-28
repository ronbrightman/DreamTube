// test/geo.test.js
//
// Covers netlify/functions/lib/geo.js's resolveCountryCode in isolation —
// see generate-video-audio-toggle.test.js/start-pending-generation-audio-
// force.test.js for how this feeds resolveGenerationProfile's owner/IL
// audio-off forcing.

var test = require('node:test');
var assert = require('node:assert/strict');

var geo = require('../netlify/functions/lib/geo');

function geoHeaderFor(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}

test('resolveCountryCode decodes a real-shaped x-nf-geo header (base64 JSON) and returns country.code', function () {
  var event = { headers: { 'x-nf-geo': geoHeaderFor({ city: 'Tel Aviv', country: { code: 'IL', name: 'Israel' } }) } };
  assert.equal(geo.resolveCountryCode(event), 'IL');
});

test('resolveCountryCode is case-insensitive on the header name (Netlify/Node may normalize casing)', function () {
  var event = { headers: { 'X-Nf-Geo': geoHeaderFor({ country: { code: 'US' } }) } };
  assert.equal(geo.resolveCountryCode(event), 'US');
});

test('resolveCountryCode returns null when the header is entirely absent', function () {
  assert.equal(geo.resolveCountryCode({ headers: {} }), null);
  assert.equal(geo.resolveCountryCode({}), null);
  assert.equal(geo.resolveCountryCode(null), null);
});

test('resolveCountryCode returns null (fails open) for a header that is not valid base64/JSON, rather than throwing', function () {
  assert.equal(geo.resolveCountryCode({ headers: { 'x-nf-geo': 'not-base64-json!!!' } }), null);
});

test('resolveCountryCode returns null when the decoded JSON has no country field at all', function () {
  var event = { headers: { 'x-nf-geo': geoHeaderFor({ city: 'Nowhere' }) } };
  assert.equal(geo.resolveCountryCode(event), null);
});
