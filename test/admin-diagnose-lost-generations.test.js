// test/admin-diagnose-lost-generations.test.js
//
// Covers netlify/functions/admin-diagnose-lost-generations.js — the
// READ-ONLY diagnostic built for tracker item
// for-product-p0-data-loss-founder-repro-0-6bzvv1 (see that file's own
// header comment for the full reasoning). Same test conventions as
// test/admin-repair-oversized-media.test.js / test/admin-diagnose-
// account-duplicates.test.js.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');

var OWNER_EMAIL = 'founder@dreamtube.example';
var OWNER_PASSWORD = 'realfounderpw1';

function withEnv(vars, fn) {
  var previous = {};
  Object.keys(vars).forEach(function (k) { previous[k] = process.env[k]; });
  Object.keys(vars).forEach(function (k) {
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  });
  return Promise.resolve()
    .then(fn)
    .finally(function () {
      Object.keys(previous).forEach(function (k) {
        if (previous[k] === undefined) delete process.env[k];
        else process.env[k] = previous[k];
      });
    });
}

var ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return '10.66.4.' + ipCounter;
}

test.beforeEach(function () {
  mockBlobs.reset();
  delete require.cache[require.resolve('../netlify/functions/admin-diagnose-lost-generations')];
  delete require.cache[require.resolve('../netlify/functions/lib/account-store')];
  delete require.cache[require.resolve('../netlify/functions/lib/dream-store')];
  delete require.cache[require.resolve('../netlify/functions/lib/job-owners')];
  delete require.cache[require.resolve('../netlify/functions/lib/entitlements')];
});

async function seedOwnerAccount(event) {
  var accountStore = require('../netlify/functions/lib/account-store');
  return accountStore.createAccount(event, { username: 'ronbrightman', password: OWNER_PASSWORD, email: OWNER_EMAIL });
}

async function seedAccount(event, username, email) {
  var accountStore = require('../netlify/functions/lib/account-store');
  return accountStore.createAccount(event, { username: username, password: 'somepassword1', email: email });
}

async function seedJobOwner(event, operationName, email, mediaType, createdAt) {
  var jobOwners = require('../netlify/functions/lib/job-owners');
  await jobOwners.recordJobOwner(event, operationName, email, mediaType);
  if (createdAt !== undefined) {
    // recordJobOwner always stamps Date.now() -- overwrite createdAt
    // directly for deterministic window tests.
    var { getStore } = require('@netlify/blobs');
    var record = await getStore({ name: jobOwners.STORE_NAME }).get(operationName, { type: 'json' });
    record.createdAt = createdAt;
    await getStore({ name: jobOwners.STORE_NAME }).setJSON(operationName, record);
  }
}

async function seedPrivateDream(username, dream) {
  var dreamStore = require('../netlify/functions/lib/dream-store');
  return dreamStore.upsertPrivateDream({}, username, dream);
}

function diagnoseRequest(overrides) {
  return { method: 'POST', ip: nextIp(), body: Object.assign({ usernameOrEmail: OWNER_EMAIL, password: OWNER_PASSWORD }, overrides || {}) };
}

test('mode:account -- a job-owner record with a matching dream is reported hasDream:true', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    await seedAccount(event, 'dreamer1', 'dreamer1@example.com');
    await seedJobOwner(event, 'fal:model:req-has-dream', 'dreamer1@example.com', 'video');
    await seedPrivateDream('dreamer1', {
      id: 'dream-1', ownerHandle: '@dreamer1', caption: 'a dream', style: 'Cartoon',
      videoUrl: 'https://x/v.mp4', mediaType: 'video', sourceOperationName: 'fal:model:req-has-dream'
    });

    var handler = require('../netlify/functions/admin-diagnose-lost-generations').handler;
    var res = await handler(fakeEvent(diagnoseRequest({ mode: 'account', targetUsername: 'dreamer1' })));
    assert.equal(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.found, true);
    assert.equal(body.jobs.length, 1);
    assert.equal(body.jobs[0].hasDream, true);
    assert.equal(body.jobs[0].dreamId, 'dream-1');
  });
});

test('mode:account -- a job-owner record with NO matching dream is reported hasDream:false (the exact "Ziv is dancing" shape)', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    await seedAccount(event, 'ronbrightman2', 'founder-repro@example.com');
    await seedJobOwner(event, 'fal:fal-ai/veo3.1:ziv-dancing-req', 'founder-repro@example.com', 'video');
    // Some OTHER, unrelated dream exists for this account -- proves the
    // diagnostic isn't just reporting "account has zero dreams", it's
    // matching by operationName specifically.
    await seedPrivateDream('ronbrightman2', {
      id: 'dream-other', ownerHandle: '@ronbrightman2', caption: 'a different dream', style: 'Cartoon',
      videoUrl: 'https://x/other.mp4', mediaType: 'video', sourceOperationName: 'fal:model:some-other-req'
    });

    var handler = require('../netlify/functions/admin-diagnose-lost-generations').handler;
    var res = await handler(fakeEvent(diagnoseRequest({ mode: 'account', targetUsername: 'ronbrightman2' })));
    var body = JSON.parse(res.body);
    assert.equal(body.jobs.length, 1);
    assert.equal(body.jobs[0].operationName, 'fal:fal-ai/veo3.1:ziv-dancing-req');
    assert.equal(body.jobs[0].hasDream, false, 'a real, charged job with no matching dream must be flagged, not silently skipped');
    assert.equal(body.jobs[0].dreamId, null);
  });
});

test('mode:account -- an unknown targetUsername reports found:false rather than throwing', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);

    var handler = require('../netlify/functions/admin-diagnose-lost-generations').handler;
    var res = await handler(fakeEvent(diagnoseRequest({ mode: 'account', targetUsername: 'nobodyhere' })));
    assert.equal(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.equal(body.found, false);
    assert.deepEqual(body.jobs, []);
  });
});

test('mode:account -- a job-owner record belonging to a DIFFERENT account\'s email is never attributed to the requested account', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    await seedAccount(event, 'accounta', 'a@example.com');
    await seedAccount(event, 'accountb', 'b@example.com');
    await seedJobOwner(event, 'fal:model:req-b-only', 'b@example.com', 'video');

    var handler = require('../netlify/functions/admin-diagnose-lost-generations').handler;
    var res = await handler(fakeEvent(diagnoseRequest({ mode: 'account', targetUsername: 'accounta' })));
    var body = JSON.parse(res.body);
    assert.deepEqual(body.jobs, [], 'account A must not see account B\'s job');
  });
});

test('mode:sweep -- tallies lostJobs/accountsAffected across multiple accounts, ignores jobs before sinceTimestamp', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    await seedAccount(event, 'sweepuser1', 'sweep1@example.com');
    await seedAccount(event, 'sweepuser2', 'sweep2@example.com');

    var now = Date.now();
    var yesterday = now - 24 * 60 * 60 * 1000;
    var lastWeek = now - 7 * 24 * 60 * 60 * 1000;

    // sweepuser1: one lost job inside the window.
    await seedJobOwner(event, 'fal:model:s1-lost', 'sweep1@example.com', 'video', now - 60000);
    // sweepuser1: one FOUND job inside the window (has a dream).
    await seedJobOwner(event, 'fal:model:s1-found', 'sweep1@example.com', 'video', now - 30000);
    await seedPrivateDream('sweepuser1', {
      id: 'dream-found', ownerHandle: '@sweepuser1', caption: 'x', style: 'y',
      videoUrl: 'https://x/v.mp4', mediaType: 'video', sourceOperationName: 'fal:model:s1-found'
    });
    // sweepuser2: one lost job inside the window.
    await seedJobOwner(event, 'fal:model:s2-lost', 'sweep2@example.com', 'video', now - 45000);
    // sweepuser1: one lost job BEFORE the window -- must be excluded entirely.
    await seedJobOwner(event, 'fal:model:s1-too-old', 'sweep1@example.com', 'video', lastWeek);

    var handler = require('../netlify/functions/admin-diagnose-lost-generations').handler;
    var res = await handler(fakeEvent(diagnoseRequest({ mode: 'sweep', sinceTimestamp: yesterday, limit: 100 })));
    assert.equal(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.jobsInWindow, 3, 'the too-old job must be excluded from the window count');
    assert.equal(body.lostJobs, 2, 's1-lost and s2-lost, not s1-found');
    assert.equal(body.accountsAffected, 2);
    assert.equal(body.done, true);
  });
});

test('mode:sweep -- a job-owner record whose email resolves to no known account is reported as accountsUnresolved, never silently counted as lost/affected', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    var now = Date.now();
    await seedJobOwner(event, 'fal:model:orphaned', 'deleted-account@example.com', 'video', now - 1000);

    var handler = require('../netlify/functions/admin-diagnose-lost-generations').handler;
    var res = await handler(fakeEvent(diagnoseRequest({ mode: 'sweep', sinceTimestamp: now - 60000 })));
    var body = JSON.parse(res.body);
    assert.equal(body.accountsUnresolved, 1);
    assert.equal(body.accountsAffected, 0);
    assert.equal(body.lostJobs, 0);
  });
});

test('mode:sweep -- paginates via cursor/nextCursor rather than scanning everything in one call', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    await seedAccount(event, 'pageduser', 'paged@example.com');
    var now = Date.now();
    for (var i = 0; i < 5; i++) {
      await seedJobOwner(event, 'fal:model:page-job-' + i, 'paged@example.com', 'video', now - i * 1000);
    }

    var handler = require('../netlify/functions/admin-diagnose-lost-generations').handler;
    var res1 = await handler(fakeEvent(diagnoseRequest({ mode: 'sweep', sinceTimestamp: now - 60000, limit: 3 })));
    var body1 = JSON.parse(res1.body);
    assert.equal(body1.done, false);
    assert.ok(body1.nextCursor);
    assert.ok(body1.jobsInWindow <= 3);

    var res2 = await handler(fakeEvent(diagnoseRequest({ mode: 'sweep', sinceTimestamp: now - 60000, limit: 3, cursor: body1.nextCursor })));
    var body2 = JSON.parse(res2.body);
    assert.equal(body2.done, true);
    assert.equal(body1.jobsInWindow + body2.jobsInWindow, 5, 'every seeded job must be seen exactly once across both pages');
  });
});

test('rejects a non-owner password (E5)', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    await require('../netlify/functions/lib/account-store').createAccount(event, { username: 'someoneelse', password: 'irrelevantpw1', email: 'not-owner@example.com' });

    var handler = require('../netlify/functions/admin-diagnose-lost-generations').handler;
    var res = await handler(fakeEvent(diagnoseRequest({ usernameOrEmail: 'not-owner@example.com', password: 'irrelevantpw1', mode: 'account', targetUsername: 'ronbrightman' })));
    assert.equal(res.statusCode, 403);
    var body = JSON.parse(res.body);
    assert.equal(body.error, 'E5: forbidden');
  });
});

test('mode:sweep without sinceTimestamp is rejected (E9) -- no unbounded all-time sweep by design', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);

    var handler = require('../netlify/functions/admin-diagnose-lost-generations').handler;
    var res = await handler(fakeEvent(diagnoseRequest({ mode: 'sweep' })));
    assert.equal(res.statusCode, 400);
    var body = JSON.parse(res.body);
    assert.equal(body.error, 'E9: missing_since_timestamp');
  });
});

test('an invalid mode is rejected (E7)', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);

    var handler = require('../netlify/functions/admin-diagnose-lost-generations').handler;
    var res = await handler(fakeEvent(diagnoseRequest({ mode: 'nonsense' })));
    assert.equal(res.statusCode, 400);
    var body = JSON.parse(res.body);
    assert.equal(body.error, 'E7: invalid_mode');
  });
});
