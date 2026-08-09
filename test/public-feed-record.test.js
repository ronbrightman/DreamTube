// test/public-feed-record.test.js
//
// Unit coverage for netlify/functions/lib/public-feed-record.js — the
// convention-based (leading-underscore) internal-field stripper wired
// into get-feed.js/get-profile.js. See that file's own header comment for
// the shared helper's full design reasoning; test/get-feed.test.js and
// test/get-profile.test.js cover it at the endpoint level.

var test = require('node:test');
var assert = require('node:assert/strict');

var publicFeedRecord = require('../netlify/functions/lib/public-feed-record');

test('toPublicFeedRecord strips every top-level key starting with "_", keeps everything else', function () {
  var out = publicFeedRecord.toPublicFeedRecord({
    id: 'd1', likes: 3, _lastLikeOp: 'abc', _lostLikeRepairs: ['r1'], _lastCommentCountOp: 'def'
  });
  assert.deepEqual(out, { id: 'd1', likes: 3 });
});

test('toPublicFeedRecord strips a hypothetical FUTURE internal marker automatically, as long as it follows the underscore convention', function () {
  var out = publicFeedRecord.toPublicFeedRecord({ id: 'd1', _brandNewInternalMarker: 'zzz' });
  assert.deepEqual(out, { id: 'd1' });
});

test('toPublicFeedRecord does not mutate the original object', function () {
  var original = { id: 'd1', _lastLikeOp: 'abc' };
  publicFeedRecord.toPublicFeedRecord(original);
  assert.equal(original._lastLikeOp, 'abc', 'the input record must be left untouched (shallow copy, not in-place strip)');
});

test('toPublicFeedRecord passes non-object input through unchanged', function () {
  assert.equal(publicFeedRecord.toPublicFeedRecord(null), null);
  assert.equal(publicFeedRecord.toPublicFeedRecord(undefined), undefined);
});

test('toPublicFeedRecords maps over an array', function () {
  var out = publicFeedRecord.toPublicFeedRecords([
    { id: 'd1', _lastLikeOp: 'abc' },
    { id: 'd2', _lostLikeRepairs: ['r1'] }
  ]);
  assert.deepEqual(out, [{ id: 'd1' }, { id: 'd2' }]);
});

test('toPublicFeedRecords returns [] for non-array input', function () {
  assert.deepEqual(publicFeedRecord.toPublicFeedRecords(null), []);
  assert.deepEqual(publicFeedRecord.toPublicFeedRecords(undefined), []);
});
