// test/comments.test.js
//
// Covers Social Layer v2 slice 2's backend surface ("comments" —
// docs/SOCIAL_LAYER_V2_DESIGN.md, tracker item
// for-product-build-social-layer-v2-direct-34047c):
//   - lib/comment-store.js (append/delete idempotency)
//   - lib/feed-comment-count.js (denormalized counter, likes-counter shape)
//   - get-comments.js (public read)
//   - add-comment.js (auth-gated write, validation, rate limiting)
//   - delete-comment.js (auth-gated delete, permission model)
//   - get-profile.js's commentCounts now being filled in (slice-1 seam)
//   - report-dream.js's additive comment target type
// Mirrors test/sync-profile.test.js's/test/get-profile.test.js's/
// test/report-dream.test.js's own conventions.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var { getStore } = require('@netlify/blobs');
var accountAuthToken = require('../netlify/functions/lib/account-auth-token');
var commentStore = require('../netlify/functions/lib/comment-store');
var feedCommentCount = require('../netlify/functions/lib/feed-comment-count');

test.beforeEach(function () {
  mockBlobs.reset();
});

function seedFeed(dreams) {
  return getStore('dreamtube-feed').setJSON('feed-index', dreams);
}

function makeDream(overrides) {
  return Object.assign({
    id: 'd1', ownerHandle: '@luna', caption: 'A dream', style: 'Cinematic',
    videoUrl: 'https://x/v.mp4', imageUrl: null, mediaType: 'video',
    avatar: null, likes: 2, publishedAt: 1000
  }, overrides || {});
}

/** Mints a real authToken for `username`, then builds a POST event carrying it -- mirrors sync-profile.test.js's own postEvent helper. */
async function postEventFor(username, body) {
  var token = await accountAuthToken.mintToken(fakeEvent({ method: 'POST' }), username);
  return fakeEvent({ method: 'POST', body: Object.assign({ authToken: token }, body) });
}

// ===== get-comments.js =====

test('get-comments: wrong method -> 405', async function () {
  var handler = require('../netlify/functions/get-comments').handler;
  var res = await handler(fakeEvent({ method: 'POST' }));
  assert.equal(res.statusCode, 405);
});

test('get-comments: missing dreamId -> 400 E2', async function () {
  var handler = require('../netlify/functions/get-comments').handler;
  var res = await handler(fakeEvent({ method: 'GET', query: {} }));
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, 'E2: dream_id_required');
});

test('get-comments: a dream with no comments yet returns an empty array, not an error', async function () {
  var handler = require('../netlify/functions/get-comments').handler;
  var res = await handler(fakeEvent({ method: 'GET', query: { dreamId: 'd1' } }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body).comments, []);
});

test('get-comments: returns newest-first, reversing the store\'s own append order', async function () {
  await commentStore.addComment(fakeEvent({ method: 'POST' }), 'd1', { id: 'c1', handle: '@a', text: 'first', createdAt: '2026-01-01T00:00:00.000Z' });
  await commentStore.addComment(fakeEvent({ method: 'POST' }), 'd1', { id: 'c2', handle: '@b', text: 'second', createdAt: '2026-01-02T00:00:00.000Z' });
  var handler = require('../netlify/functions/get-comments').handler;
  var res = await handler(fakeEvent({ method: 'GET', query: { dreamId: 'd1' } }));
  var body = JSON.parse(res.body);
  assert.deepEqual(body.comments.map(function (c) { return c.id; }), ['c2', 'c1']);
});

test('get-comments: CORS headers present on GET and OPTIONS', async function () {
  var handler = require('../netlify/functions/get-comments').handler;
  var optRes = await handler(fakeEvent({ method: 'OPTIONS' }));
  assert.equal(optRes.statusCode, 204);
  assert.equal(optRes.headers['Access-Control-Allow-Origin'], '*');
  var getRes = await handler(fakeEvent({ method: 'GET', query: { dreamId: 'd1' } }));
  assert.equal(getRes.headers['Access-Control-Allow-Origin'], '*');
});

// ===== add-comment.js =====

test('add-comment: wrong method -> 405', async function () {
  var handler = require('../netlify/functions/add-comment').handler;
  var res = await handler(fakeEvent({ method: 'GET' }));
  assert.equal(res.statusCode, 405);
});

test('add-comment: invalid JSON -> 400 E2', async function () {
  var handler = require('../netlify/functions/add-comment').handler;
  var res = await handler(fakeEvent({ method: 'POST', body: 'not json' }));
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, 'E2: invalid_json');
});

test('add-comment: missing dreamId -> 400 E3', async function () {
  var handler = require('../netlify/functions/add-comment').handler;
  var res = await handler(fakeEvent({ method: 'POST', body: { handle: '@x', authToken: 't', text: 'hi' } }));
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, 'E3: dream_id_required');
});

test('add-comment: missing handle -> 400 E4', async function () {
  var handler = require('../netlify/functions/add-comment').handler;
  var res = await handler(fakeEvent({ method: 'POST', body: { dreamId: 'd1', authToken: 't', text: 'hi' } }));
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, 'E4: handle_required');
});

test('add-comment: missing authToken -> 400 E5', async function () {
  var handler = require('../netlify/functions/add-comment').handler;
  var res = await handler(fakeEvent({ method: 'POST', body: { dreamId: 'd1', handle: '@x', text: 'hi' } }));
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, 'E5: auth_token_required');
});

test('add-comment: empty/whitespace-only text -> 400 E6, before ever touching the token', async function () {
  var handler = require('../netlify/functions/add-comment').handler;
  var res = await handler(fakeEvent({ method: 'POST', body: { dreamId: 'd1', handle: '@x', authToken: 'bogus', text: '   ' } }));
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, 'E6: comment_required');
});

test('add-comment: over 300 chars (server-side cap, independent of any client-side counter) -> 400 E7', async function () {
  var handler = require('../netlify/functions/add-comment').handler;
  var longText = 'a'.repeat(301);
  var res = await handler(fakeEvent({ method: 'POST', body: { dreamId: 'd1', handle: '@x', authToken: 'bogus', text: longText } }));
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, 'E7: comment_too_long');
});

test('add-comment: exactly 300 chars is accepted (boundary)', async function () {
  var handler = require('../netlify/functions/add-comment').handler;
  var text300 = 'a'.repeat(300);
  var res = await handler(await postEventFor('luna', { dreamId: 'd1', handle: '@luna', text: text300 }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.comment.text.length, 300);
});

test('add-comment: invalid/expired token -> 200 ok:false E8 (business outcome, not a 4xx)', async function () {
  var handler = require('../netlify/functions/add-comment').handler;
  var res = await handler(fakeEvent({ method: 'POST', body: { dreamId: 'd1', handle: '@x', authToken: 'not-a-real-token', text: 'hi' } }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.equal(body.error, 'E8: invalid_or_expired_token');
});

test('SECURITY: add-comment: a verified token for one username cannot post as a DIFFERENT handle -> 403 E9, and nothing is written', async function () {
  var handler = require('../netlify/functions/add-comment').handler;
  var attackerToken = await accountAuthToken.mintToken(fakeEvent({ method: 'POST' }), 'attacker');
  var res = await handler(fakeEvent({
    method: 'POST',
    body: { dreamId: 'd1', handle: '@victim', authToken: attackerToken, text: 'forged comment' }
  }));
  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res.body).error, 'E9: owner_mismatch');
  var comments = await commentStore.getComments(fakeEvent({ method: 'GET' }), 'd1');
  assert.equal(comments.length, 0, "the attacker's forged request must not have written a comment");
});

test('add-comment: a full, valid post is persisted, returned, and denormalizes commentCount onto the feed record', async function () {
  await seedFeed([makeDream({ id: 'd1' })]);
  var handler = require('../netlify/functions/add-comment').handler;
  var res = await handler(await postEventFor('luna', { dreamId: 'd1', handle: '@Luna', text: 'What a dream!' }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.comment.handle, '@Luna', 'the client-supplied real-cased handle should be preserved, same reasoning as sync-profile.js');
  assert.equal(body.comment.text, 'What a dream!');
  assert.ok(body.comment.id);
  assert.ok(body.comment.createdAt);
  assert.equal(body.commentCount, 1);

  var stored = await commentStore.getComments(fakeEvent({ method: 'GET' }), 'd1');
  assert.equal(stored.length, 1);
  assert.equal(stored[0].id, body.comment.id);
});

test('add-comment: dream not found in the feed -- comment is still stored, commentCount is null (best-effort denormalization, not a failure)', async function () {
  var handler = require('../netlify/functions/add-comment').handler;
  var res = await handler(await postEventFor('luna', { dreamId: 'does-not-exist', handle: '@luna', text: 'orphan comment' }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.commentCount, null);
  var stored = await commentStore.getComments(fakeEvent({ method: 'GET' }), 'does-not-exist');
  assert.equal(stored.length, 1, 'the comment itself must still be stored even when the denormalized count has nowhere to land');
});

test('add-comment: rate limiting -- MAX_COMMENTS_PER_ACCOUNT_PER_DAY rejects further posts with 429/E10 once exceeded', async function () {
  await seedFeed([makeDream({ id: 'd1' })]);
  process.env.MAX_COMMENTS_PER_ACCOUNT_PER_DAY = '2';
  try {
    delete require.cache[require.resolve('../netlify/functions/add-comment')];
    var handler = require('../netlify/functions/add-comment').handler;
    var token = await accountAuthToken.mintToken(fakeEvent({ method: 'POST' }), 'ratetest');
    function post(text) {
      return handler(fakeEvent({ method: 'POST', body: { dreamId: 'd1', handle: '@ratetest', authToken: token, text: text } }));
    }
    var first = await post('one');
    assert.equal(first.statusCode, 200);
    var second = await post('two');
    assert.equal(second.statusCode, 200);
    var third = await post('three');
    assert.equal(third.statusCode, 429);
    assert.equal(JSON.parse(third.body).error, 'E10: rate_limited');
  } finally {
    delete process.env.MAX_COMMENTS_PER_ACCOUNT_PER_DAY;
    delete require.cache[require.resolve('../netlify/functions/add-comment')];
  }
});

// ===== XSS negative-proof (server side -- the client-side esc() coverage
// lives in test/comment-sheet-behavioral.test.js) =====

test('add-comment: a comment containing a <script> tag is stored VERBATIM (unescaped) -- escaping is the RENDER-side responsibility (js/comment-sheet.js), never the storage layer', async function () {
  await seedFeed([makeDream({ id: 'd1' })]);
  var handler = require('../netlify/functions/add-comment').handler;
  var malicious = 'nice dream <script>window.__xss=1</script>';
  var res = await handler(await postEventFor('luna', { dreamId: 'd1', handle: '@luna', text: malicious }));
  var body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.comment.text, malicious, 'storage must preserve the exact bytes -- corrupting/stripping them server-side would be its own bug, separate from the render-side XSS guard');
});

// ===== delete-comment.js =====

test('delete-comment: wrong method -> 405', async function () {
  var handler = require('../netlify/functions/delete-comment').handler;
  var res = await handler(fakeEvent({ method: 'GET' }));
  assert.equal(res.statusCode, 405);
});

test('delete-comment: missing dreamId/commentId/authToken -> 400 E3/E4/E5 respectively', async function () {
  var handler = require('../netlify/functions/delete-comment').handler;
  var noDream = await handler(fakeEvent({ method: 'POST', body: { commentId: 'c1', authToken: 't' } }));
  assert.equal(JSON.parse(noDream.body).error, 'E3: dream_id_required');
  var noComment = await handler(fakeEvent({ method: 'POST', body: { dreamId: 'd1', authToken: 't' } }));
  assert.equal(JSON.parse(noComment.body).error, 'E4: comment_id_required');
  var noToken = await handler(fakeEvent({ method: 'POST', body: { dreamId: 'd1', commentId: 'c1' } }));
  assert.equal(JSON.parse(noToken.body).error, 'E5: auth_token_required');
});

test('delete-comment: invalid/expired token -> 200 ok:false E6', async function () {
  var handler = require('../netlify/functions/delete-comment').handler;
  var res = await handler(fakeEvent({ method: 'POST', body: { dreamId: 'd1', commentId: 'c1', authToken: 'nope' } }));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).error, 'E6: invalid_or_expired_token');
});

test('delete-comment: nonexistent commentId -> 404 E7', async function () {
  var handler = require('../netlify/functions/delete-comment').handler;
  var token = await accountAuthToken.mintToken(fakeEvent({ method: 'POST' }), 'luna');
  var res = await handler(fakeEvent({ method: 'POST', body: { dreamId: 'd1', commentId: 'no-such-comment', authToken: token } }));
  assert.equal(res.statusCode, 404);
  assert.equal(JSON.parse(res.body).error, 'E7: comment_not_found');
});

test('PERMISSION: delete-comment: the commenter can delete their own comment', async function () {
  await seedFeed([makeDream({ id: 'd1', ownerHandle: '@dreamowner' })]);
  await commentStore.addComment(fakeEvent({ method: 'POST' }), 'd1', { id: 'c1', handle: '@commenter', text: 'hi', createdAt: new Date().toISOString() });
  await feedCommentCount.adjustCommentCount(fakeEvent({ method: 'POST' }), 'd1', 1);

  var handler = require('../netlify/functions/delete-comment').handler;
  var token = await accountAuthToken.mintToken(fakeEvent({ method: 'POST' }), 'commenter');
  var res = await handler(fakeEvent({ method: 'POST', body: { dreamId: 'd1', commentId: 'c1', authToken: token } }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.commentCount, 0);
  var remaining = await commentStore.getComments(fakeEvent({ method: 'GET' }), 'd1');
  assert.equal(remaining.length, 0);
});

test('PERMISSION: delete-comment: the DREAM OWNER can delete someone else\'s comment on their own dream', async function () {
  await seedFeed([makeDream({ id: 'd1', ownerHandle: '@dreamowner' })]);
  await commentStore.addComment(fakeEvent({ method: 'POST' }), 'd1', { id: 'c1', handle: '@somebody-else', text: 'rude comment', createdAt: new Date().toISOString() });

  var handler = require('../netlify/functions/delete-comment').handler;
  var token = await accountAuthToken.mintToken(fakeEvent({ method: 'POST' }), 'dreamowner');
  var res = await handler(fakeEvent({ method: 'POST', body: { dreamId: 'd1', commentId: 'c1', authToken: token } }));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).ok, true);
});

test('PERMISSION: delete-comment: a random third party (neither commenter nor dream owner) is forbidden, and nothing is deleted', async function () {
  await seedFeed([makeDream({ id: 'd1', ownerHandle: '@dreamowner' })]);
  await commentStore.addComment(fakeEvent({ method: 'POST' }), 'd1', { id: 'c1', handle: '@commenter', text: 'hi', createdAt: new Date().toISOString() });

  var handler = require('../netlify/functions/delete-comment').handler;
  var token = await accountAuthToken.mintToken(fakeEvent({ method: 'POST' }), 'randomstranger');
  var res = await handler(fakeEvent({ method: 'POST', body: { dreamId: 'd1', commentId: 'c1', authToken: token } }));
  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res.body).error, 'E8: forbidden');
  var remaining = await commentStore.getComments(fakeEvent({ method: 'GET' }), 'd1');
  assert.equal(remaining.length, 1, "a forbidden delete attempt must not remove the comment");
});

test('delete-comment: the commenter can still delete their own comment even when the dream itself is no longer on the feed', async function () {
  // No seedFeed call -- dream genuinely absent from the shared feed.
  await commentStore.addComment(fakeEvent({ method: 'POST' }), 'gone-dream', { id: 'c1', handle: '@commenter', text: 'hi', createdAt: new Date().toISOString() });
  var handler = require('../netlify/functions/delete-comment').handler;
  var token = await accountAuthToken.mintToken(fakeEvent({ method: 'POST' }), 'commenter');
  var res = await handler(fakeEvent({ method: 'POST', body: { dreamId: 'gone-dream', commentId: 'c1', authToken: token } }));
  assert.equal(res.statusCode, 200);
  var body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.commentCount, null, "no feed record to denormalize a count onto -- see lib/feed-comment-count.js's own NOT-FOUND behavior");
});

// ===== lib/comment-store.js: idempotency =====

test('lib/comment-store.js addComment: calling it twice with the SAME entry id never duplicates the comment', async function () {
  var event = fakeEvent({ method: 'GET' });
  var entry = { id: 'fixed-id-123', handle: '@a', text: 'hi', createdAt: new Date().toISOString() };
  await commentStore.addComment(event, 'd1', entry);
  await commentStore.addComment(event, 'd1', entry);
  var comments = await commentStore.getComments(event, 'd1');
  assert.equal(comments.filter(function (c) { return c.id === 'fixed-id-123'; }).length, 1);
});

test('lib/comment-store.js deleteComment: removing an already-absent id is a no-op, not an error', async function () {
  var event = fakeEvent({ method: 'GET' });
  var result = await commentStore.deleteComment(event, 'd1', 'never-existed');
  assert.deepEqual(result, []);
});

// ===== lib/feed-comment-count.js =====

test('lib/feed-comment-count.js adjustCommentCount: increments/decrements, floors at 0, returns null for an unknown dream', async function () {
  await seedFeed([makeDream({ id: 'd1' })]);
  var event = fakeEvent({ method: 'POST' });
  var afterInc = await feedCommentCount.adjustCommentCount(event, 'd1', 1);
  assert.equal(afterInc, 1);
  var afterInc2 = await feedCommentCount.adjustCommentCount(event, 'd1', 1);
  assert.equal(afterInc2, 2);
  var afterDec = await feedCommentCount.adjustCommentCount(event, 'd1', -1);
  assert.equal(afterDec, 1);
  var floored = await feedCommentCount.adjustCommentCount(event, 'd1', -5);
  assert.equal(floored, 0, 'must floor at 0, never go negative');
  var missing = await feedCommentCount.adjustCommentCount(event, 'no-such-dream', 1);
  assert.equal(missing, null);
});

// ===== get-profile.js: commentCounts now filled in (slice-1 seam) =====

test('get-profile.js: commentCounts is now filled in from each dream\'s own denormalized commentCount', async function () {
  await seedFeed([
    makeDream({ id: 'd1', ownerHandle: '@luna', commentCount: 3 }),
    makeDream({ id: 'd2', ownerHandle: '@luna' }) // no commentCount field at all -- must read as 0, not undefined/missing
  ]);
  var handler = require('../netlify/functions/get-profile').handler;
  var res = await handler(fakeEvent({ method: 'GET', query: { handle: 'luna' } }));
  var body = JSON.parse(res.body);
  assert.deepEqual(body.commentCounts, { d1: 3, d2: 0 });
});

// ===== report-dream.js: additive comment target type =====

test('report-dream: targetType defaults to \'dream\' -- every pre-existing caller (no targetType in its payload) is completely unaffected', async function () {
  var handler = require('../netlify/functions/report-dream').handler;
  var moderationStore = require('../netlify/functions/lib/moderation-store');
  var res = await handler(fakeEvent({ method: 'POST', ip: '9.9.9.1', body: { dreamId: 'd1' } }));
  assert.equal(res.statusCode, 200);
  var reports = await moderationStore.getReports(fakeEvent({ method: 'GET' }));
  assert.equal(reports[0].targetType, 'dream');
  assert.equal(reports[0].commentId, null);
});

test('report-dream: targetType:\'comment\' requires commentId -> 400 E6 when missing', async function () {
  var handler = require('../netlify/functions/report-dream').handler;
  var res = await handler(fakeEvent({ method: 'POST', ip: '9.9.9.2', body: { dreamId: 'd1', targetType: 'comment' } }));
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, 'E6: comment_id_required');
});

test('report-dream: a valid comment report is stored with its own snapshot fields', async function () {
  var handler = require('../netlify/functions/report-dream').handler;
  var moderationStore = require('../netlify/functions/lib/moderation-store');
  var res = await handler(fakeEvent({
    method: 'POST', ip: '9.9.9.3',
    body: {
      dreamId: 'd1', dreamOwnerHandle: '@luna', targetType: 'comment',
      commentId: 'c1', commentText: 'a rude comment', commentAuthorHandle: '@rude-user',
      reporterHandle: '@reporter'
    }
  }));
  assert.equal(res.statusCode, 200);
  var reports = await moderationStore.getReports(fakeEvent({ method: 'GET' }));
  assert.equal(reports[0].targetType, 'comment');
  assert.equal(reports[0].commentId, 'c1');
  assert.equal(reports[0].commentText, 'a rude comment');
  assert.equal(reports[0].commentAuthorHandle, '@rude-user');
});
