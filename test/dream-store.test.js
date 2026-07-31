// test/dream-store.test.js
//
// Covers netlify/functions/lib/dream-store.js in isolation — the
// per-account, Blobs-backed PRIVATE dream store for tracker item
// for-product-build-p0-server-side-dream-p-zl3rb2. Same conventions as
// test/push-subscription-store.test.js (basic CRUD) and
// test/blobs-retry.test.js (the guarded read-mutate-write-verify race
// coverage this file's own header comment calls MANDATORY). Run with:
// node --test test/

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var dreamStore = require('../netlify/functions/lib/dream-store');

test.beforeEach(function () {
  mockBlobs.reset();
});

function dream(id, extra) {
  return Object.assign({
    id: id, ownerHandle: '@alice', caption: 'a dream', promptText: 'a dream',
    storyText: 'a dream', style: 'Cartoon', mediaType: 'video',
    videoUrl: 'https://x/v.mp4', imageUrl: null, dur: '0:08',
    isPublished: false, updatedAt: Date.now()
  }, extra || {});
}

// ===== basic CRUD =====

test('getPrivateDreams returns [] for an account that never synced', async function () {
  var dreams = await dreamStore.getPrivateDreams(fakeEvent({}), 'nosuchaccount');
  assert.deepEqual(dreams, []);
});

test('upsertPrivateDream persists a dream retrievable by getPrivateDreams', async function () {
  var event = fakeEvent({});
  var result = await dreamStore.upsertPrivateDream(event, 'alice', dream('d1'));
  assert.equal(result.ok, true);

  var dreams = await dreamStore.getPrivateDreams(event, 'alice');
  assert.equal(dreams.length, 1);
  assert.equal(dreams[0].id, 'd1');
  assert.equal(dreams[0].caption, 'a dream');
});

test('username is normalized (case/whitespace) between write and read', async function () {
  var event = fakeEvent({});
  await dreamStore.upsertPrivateDream(event, '  Alice  ', dream('d1'));
  var dreams = await dreamStore.getPrivateDreams(event, 'alice');
  assert.equal(dreams.length, 1);
});

test('upserting the SAME dream id replaces it in place, not a duplicate entry', async function () {
  var event = fakeEvent({});
  await dreamStore.upsertPrivateDream(event, 'alice', dream('d1', { caption: 'first version' }));
  await dreamStore.upsertPrivateDream(event, 'alice', dream('d1', { caption: 'edited version' }));

  var dreams = await dreamStore.getPrivateDreams(event, 'alice');
  assert.equal(dreams.length, 1);
  assert.equal(dreams[0].caption, 'edited version');
});

test('a second, DIFFERENT dream id for the same account is a second entry', async function () {
  var event = fakeEvent({});
  await dreamStore.upsertPrivateDream(event, 'alice', dream('d1'));
  await dreamStore.upsertPrivateDream(event, 'alice', dream('d2'));

  var dreams = await dreamStore.getPrivateDreams(event, 'alice');
  assert.equal(dreams.length, 2);
});

test('two different accounts\' private dreams are stored completely separately', async function () {
  var event = fakeEvent({});
  await dreamStore.upsertPrivateDream(event, 'alice', dream('d1'));
  await dreamStore.upsertPrivateDream(event, 'bob', dream('d1', { ownerHandle: '@bob', caption: 'bobs dream' }));

  var aliceDreams = await dreamStore.getPrivateDreams(event, 'alice');
  var bobDreams = await dreamStore.getPrivateDreams(event, 'bob');
  assert.equal(aliceDreams.length, 1);
  assert.equal(bobDreams.length, 1);
  assert.equal(aliceDreams[0].caption, 'a dream');
  assert.equal(bobDreams[0].caption, 'bobs dream');
});

test('upsertPrivateDream rejects a dream with no id, or an invalid username', async function () {
  var event = fakeEvent({});
  var noId = await dreamStore.upsertPrivateDream(event, 'alice', { caption: 'no id' });
  assert.equal(noId.ok, false);
  assert.equal(noId.error, 'invalid_dream');

  var noUsername = await dreamStore.upsertPrivateDream(event, '', dream('d1'));
  assert.equal(noUsername.ok, false);
  assert.equal(noUsername.error, 'invalid_username');
});

test('removePrivateDream removes exactly the matching dream, leaving others intact', async function () {
  var event = fakeEvent({});
  await dreamStore.upsertPrivateDream(event, 'alice', dream('d1'));
  await dreamStore.upsertPrivateDream(event, 'alice', dream('d2'));

  var result = await dreamStore.removePrivateDream(event, 'alice', 'd1');
  assert.equal(result.ok, true);
  assert.equal(result.removed, true);

  var dreams = await dreamStore.getPrivateDreams(event, 'alice');
  assert.equal(dreams.length, 1);
  assert.equal(dreams[0].id, 'd2');
});

test('removePrivateDream on a non-existent dream id is a harmless, idempotent no-op (ok:true, removed:false)', async function () {
  var event = fakeEvent({});
  await dreamStore.upsertPrivateDream(event, 'alice', dream('d1'));
  var result = await dreamStore.removePrivateDream(event, 'alice', 'never-existed');
  assert.equal(result.ok, true);
  assert.equal(result.removed, false);

  var dreams = await dreamStore.getPrivateDreams(event, 'alice');
  assert.equal(dreams.length, 1, 'the real dream must be untouched');
});

test('deleteAllPrivateDreams wipes the whole per-account record, and is a safe no-op for an account with none', async function () {
  var event = fakeEvent({});
  await dreamStore.upsertPrivateDream(event, 'alice', dream('d1'));
  await dreamStore.upsertPrivateDream(event, 'alice', dream('d2'));

  var result = await dreamStore.deleteAllPrivateDreams(event, 'alice');
  assert.equal(result.ok, true);
  assert.deepEqual(await dreamStore.getPrivateDreams(event, 'alice'), []);

  var noop = await dreamStore.deleteAllPrivateDreams(event, 'never-had-any');
  assert.equal(noop.ok, true);
});

// ===== the MANDATORY blobs-retry read-mutate-write-verify guard =====
// (tracker item's own explicit call-out — "same read-mutate-write class
// that caused the signup outage")

test('CONCURRENCY: two concurrent upserts of DIFFERENT dreams for the SAME account both survive (no lost update)', async function () {
  var event = fakeEvent({});
  await Promise.all([
    dreamStore.upsertPrivateDream(event, 'alice', dream('d1')),
    dreamStore.upsertPrivateDream(event, 'alice', dream('d2'))
  ]);

  var dreams = await dreamStore.getPrivateDreams(event, 'alice');
  var ids = dreams.map(function (d) { return d.id; }).sort();
  assert.deepEqual(ids, ['d1', 'd2'], 'a naive unguarded read-then-write would have silently dropped whichever wrote second');
});

test('CONCURRENCY: a concurrent upsert (new dream) racing a delete (of a DIFFERENT, pre-existing dream) both survive correctly', async function () {
  var event = fakeEvent({});
  await dreamStore.upsertPrivateDream(event, 'alice', dream('existing'));

  await Promise.all([
    dreamStore.upsertPrivateDream(event, 'alice', dream('brand-new')),
    dreamStore.removePrivateDream(event, 'alice', 'existing')
  ]);

  var dreams = await dreamStore.getPrivateDreams(event, 'alice');
  var ids = dreams.map(function (d) { return d.id; });
  assert.ok(ids.indexOf('brand-new') !== -1, 'the concurrent upsert must not be lost');
  assert.ok(ids.indexOf('existing') === -1, 'the concurrent delete must not be lost/reverted');
});

test('a stale verify-read (our own just-written data not yet visible) retries and still lands correctly, without double-applying', async function () {
  var event = fakeEvent({});
  await dreamStore.upsertPrivateDream(event, 'alice', dream('d1', { caption: 'v1' }));

  // Force ONE false-negative verify read on the next write, simulating
  // eventual-consistency lag — same technique test/blobs-retry.test.js's
  // own "retries with a FRESH read/mutate each time" test uses.
  var readCount = 0;
  mockBlobs.setReadOverride(dreamStore.STORE_NAME, function (key) {
    if (key !== 'alice') return null;
    readCount++;
    // Let the FIRST read (the retry loop's own initial `read`) through as
    // real data, but force the SECOND read (the post-write verify) to look
    // stale (return the pre-write value) exactly once.
    if (readCount === 2) {
      return { value: { username: 'alice', dreams: [dream('d1', { caption: 'v1' })], updatedAt: 0 } };
    }
    return null; // fall through to the real stored value
  });

  try {
    var result = await dreamStore.upsertPrivateDream(event, 'alice', dream('d1', { caption: 'v2' }));
    assert.equal(result.ok, true, 'must succeed after retrying past the one false-negative verify');
  } finally {
    mockBlobs.clearReadOverride(dreamStore.STORE_NAME);
  }

  var dreams = await dreamStore.getPrivateDreams(event, 'alice');
  assert.equal(dreams.length, 1, 'must not have double-added the dream on retry');
  assert.equal(dreams[0].caption, 'v2', 'the real, latest write must be what is actually persisted');
});

test('MAX_DREAMS_PER_ACCOUNT caps the array — the just-upserted dream is never the one evicted', async function () {
  var event = fakeEvent({});
  var cap = dreamStore.MAX_DREAMS_PER_ACCOUNT;
  // Seed the store directly at (cap - 1) so this test doesn't need to make
  // `cap` real upsertPrivateDream calls (slow) — mockBlobs.seed writes the
  // exact same record shape upsertPrivateDream itself would.
  var seeded = [];
  for (var i = 0; i < cap - 1; i++) seeded.push(dream('seed-' + i));
  mockBlobs.seed(dreamStore.STORE_NAME, 'alice', { username: 'alice', dreams: seeded, updatedAt: Date.now() });

  await dreamStore.upsertPrivateDream(event, 'alice', dream('one-more'));
  var dreams = await dreamStore.getPrivateDreams(event, 'alice');
  assert.equal(dreams.length, cap);
  assert.ok(dreams.some(function (d) { return d.id === 'one-more'; }), 'the just-upserted dream must survive the cap trim');

  await dreamStore.upsertPrivateDream(event, 'alice', dream('over-the-cap'));
  var dreamsAfterOverflow = await dreamStore.getPrivateDreams(event, 'alice');
  assert.equal(dreamsAfterOverflow.length, cap, 'must stay capped, never grow past it');
  assert.ok(dreamsAfterOverflow.some(function (d) { return d.id === 'over-the-cap'; }), 'the just-upserted dream must still survive even when the cap is genuinely exceeded');
});
