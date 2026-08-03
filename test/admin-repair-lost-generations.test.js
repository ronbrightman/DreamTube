// test/admin-repair-lost-generations.test.js
//
// Covers netlify/functions/admin-repair-lost-generations.js — the
// owner-only repair tool built for tracker item
// for-product-p0-data-loss-founder-repro-0-6bzvv1 (see that file's own
// header comment for the full reasoning). Same test conventions as
// test/admin-repair-oversized-media.test.js, this tool's closest
// precedent (real fal status+result mock sequence, real media-fetch mock
// for the rehost step).

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
  return '10.77.4.' + ipCounter;
}

test.beforeEach(function () {
  mockBlobs.reset();
  delete require.cache[require.resolve('../netlify/functions/admin-repair-lost-generations')];
  delete require.cache[require.resolve('../netlify/functions/lib/account-store')];
  delete require.cache[require.resolve('../netlify/functions/lib/dream-store')];
  delete require.cache[require.resolve('../netlify/functions/lib/job-owners')];
  delete require.cache[require.resolve('../netlify/functions/lib/media-rehost')];
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

async function seedJobOwner(event, operationName, email, mediaType) {
  var jobOwners = require('../netlify/functions/lib/job-owners');
  await jobOwners.recordJobOwner(event, operationName, email, mediaType);
}

async function seedPrivateDream(username, dream) {
  var dreamStore = require('../netlify/functions/lib/dream-store');
  return dreamStore.upsertPrivateDream({}, username, dream);
}

function repairRequest(overrides) {
  return { method: 'POST', ip: nextIp(), body: Object.assign({ usernameOrEmail: OWNER_EMAIL, password: OWNER_PASSWORD }, overrides || {}) };
}

function realMediaFetch(bytes, contentType) {
  return {
    ok: true, status: 200,
    headers: { get: function (n) { return n.toLowerCase() === 'content-type' ? (contentType || null) : null; } },
    arrayBuffer: async function () { return bytes; }
  };
}

// Same two-endpoint fal sequence as admin-repair-oversized-media.test.js's
// own falFetchMock (status then result) — duplicated rather than shared,
// matching this repo's own per-test-file convention.
function falFetchMock(falQueue) {
  var calls = [];
  return {
    calls: calls,
    fetch: async function (url) {
      calls.push(url);
      var isStatusCall = url.indexOf('/status') !== -1;
      var entry = falQueue.shift();
      if (!entry) throw new Error('unexpected extra fal fetch: ' + url);
      if (entry.httpStatus === 404) {
        return { ok: false, status: 404, text: async function () { return ''; } };
      }
      return {
        ok: true, status: 200,
        text: async function () { return JSON.stringify(isStatusCall ? entry.status : entry.result); }
      };
    }
  };
}

test('recovers a genuinely lost generation: writes a real dream record with the fresh fal media, honestly labeled', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, FAL_KEY: 'test-fal-key' }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    await seedAccount(event, 'founderrepro', 'founder-repro@example.com');
    await seedJobOwner(event, 'fal:fal-ai/veo3.1:ziv-dancing-req', 'founder-repro@example.com', 'video');

    var fal = falFetchMock([
      { status: { status: 'COMPLETED' } },
      { result: { video: { url: 'https://fal.media/files/ziv-dancing.mp4' } } }
    ]);
    var freshBytes = new ArrayBuffer(8);
    global.fetch = async function (url, opts) {
      if (typeof url === 'string' && url.indexOf('queue.fal.run') !== -1) return fal.fetch(url, opts);
      return realMediaFetch(freshBytes, 'video/mp4');
    };

    var handler = require('../netlify/functions/admin-repair-lost-generations').handler;
    var res = await handler(fakeEvent(repairRequest({
      targetUsername: 'founderrepro', operationName: 'fal:fal-ai/veo3.1:ziv-dancing-req',
      captionOverride: 'Ziv is dancing', styleOverride: 'Realistic'
    })));
    assert.equal(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.outcome, 'recovered');
    assert.equal(body.mediaType, 'video');
    assert.ok(body.dreamId);

    var dreamStore = require('../netlify/functions/lib/dream-store');
    var dreams = await dreamStore.getPrivateDreams(event, 'founderrepro');
    assert.equal(dreams.length, 1);
    var d = dreams[0];
    assert.equal(d.caption, 'Ziv is dancing');
    assert.equal(d.style, 'Realistic');
    assert.equal(d.sourceOperationName, 'fal:fal-ai/veo3.1:ziv-dancing-req');
    assert.equal(d.mediaType, 'video');
    assert.ok(d.videoUrl);
    assert.ok(d.recoveredAt, 'must be honestly labeled as a recovered record, not indistinguishable from an ordinary generation');
    assert.equal(d.recoveredVia, 'admin-repair-lost-generations');
  });
});

test('without a captionOverride, the recovered dream gets a clearly-labeled placeholder caption, never a fabricated one', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, FAL_KEY: 'test-fal-key' }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    await seedAccount(event, 'nocaption', 'nocaption@example.com');
    await seedJobOwner(event, 'fal:fal-ai/veo3.1:no-caption-req', 'nocaption@example.com', 'video');

    var fal = falFetchMock([
      { status: { status: 'COMPLETED' } },
      { result: { video: { url: 'https://fal.media/files/x.mp4' } } }
    ]);
    global.fetch = async function (url) {
      if (typeof url === 'string' && url.indexOf('queue.fal.run') !== -1) return fal.fetch(url);
      return realMediaFetch(new ArrayBuffer(4), 'video/mp4');
    };

    var handler = require('../netlify/functions/admin-repair-lost-generations').handler;
    var res = await handler(fakeEvent(repairRequest({ targetUsername: 'nocaption', operationName: 'fal:fal-ai/veo3.1:no-caption-req' })));
    var body = JSON.parse(res.body);
    assert.equal(body.outcome, 'recovered');
    assert.match(body.captionUsed, /original description was not stored server-side/);
  });
});

test('dryRun performs the fal lookup but writes nothing', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, FAL_KEY: 'test-fal-key' }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    await seedAccount(event, 'dryrunuser', 'dryrun@example.com');
    await seedJobOwner(event, 'fal:fal-ai/veo3.1:dry-run-req', 'dryrun@example.com', 'video');

    var fal = falFetchMock([
      { status: { status: 'COMPLETED' } },
      { result: { video: { url: 'https://fal.media/files/dry.mp4' } } }
    ]);
    global.fetch = async function (url) {
      if (typeof url === 'string' && url.indexOf('queue.fal.run') !== -1) return fal.fetch(url);
      throw new Error('dryRun must never fetch/rehost the actual media bytes');
    };

    var handler = require('../netlify/functions/admin-repair-lost-generations').handler;
    var res = await handler(fakeEvent(repairRequest({ targetUsername: 'dryrunuser', operationName: 'fal:fal-ai/veo3.1:dry-run-req', dryRun: true })));
    var body = JSON.parse(res.body);
    assert.equal(body.outcome, 'would_recover');
    assert.equal(body.url, 'https://fal.media/files/dry.mp4');

    var dreamStore = require('../netlify/functions/lib/dream-store');
    var dreams = await dreamStore.getPrivateDreams(event, 'dryrunuser');
    assert.equal(dreams.length, 0, 'dryRun must never actually write a dream record');
  });
});

test('fal no longer having the result is reported as failed/fal_result_gone, not a crash', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, FAL_KEY: 'test-fal-key' }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    await seedAccount(event, 'goneuser', 'gone@example.com');
    await seedJobOwner(event, 'fal:fal-ai/veo3.1:gone-req', 'gone@example.com', 'video');

    global.fetch = async function (url) {
      if (typeof url === 'string' && url.indexOf('queue.fal.run') !== -1) {
        return { ok: false, status: 404, text: async function () { return ''; } };
      }
      throw new Error('must not fetch media bytes when fal has nothing');
    };

    var handler = require('../netlify/functions/admin-repair-lost-generations').handler;
    var res = await handler(fakeEvent(repairRequest({ targetUsername: 'goneuser', operationName: 'fal:fal-ai/veo3.1:gone-req' })));
    var body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.outcome, 'failed');
    assert.equal(body.reason, 'fal_result_gone');
  });
});

test('already-recovered (a dream already carries this operationName) refuses to write a duplicate', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, FAL_KEY: 'test-fal-key' }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    await seedAccount(event, 'dupeuser', 'dupe@example.com');
    await seedJobOwner(event, 'fal:fal-ai/veo3.1:dupe-req', 'dupe@example.com', 'video');
    await seedPrivateDream('dupeuser', {
      id: 'already-there', ownerHandle: '@dupeuser', caption: 'x', style: 'y',
      videoUrl: 'https://x/v.mp4', mediaType: 'video', sourceOperationName: 'fal:fal-ai/veo3.1:dupe-req'
    });

    global.fetch = async function () { throw new Error('must not call fal at all when already recovered'); };

    var handler = require('../netlify/functions/admin-repair-lost-generations').handler;
    var res = await handler(fakeEvent(repairRequest({ targetUsername: 'dupeuser', operationName: 'fal:fal-ai/veo3.1:dupe-req' })));
    var body = JSON.parse(res.body);
    assert.equal(body.outcome, 'already_recovered');
    assert.equal(body.dreamId, 'already-there');
  });
});

test('a job-owner record belonging to a DIFFERENT account is refused as account_mismatch, not silently attributed', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, FAL_KEY: 'test-fal-key' }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    await seedAccount(event, 'ownerofjob', 'realowner@example.com');
    await seedAccount(event, 'notowner', 'notowner@example.com');
    await seedJobOwner(event, 'fal:fal-ai/veo3.1:owned-req', 'realowner@example.com', 'video');

    global.fetch = async function () { throw new Error('must not call fal for a mismatched account'); };

    var handler = require('../netlify/functions/admin-repair-lost-generations').handler;
    var res = await handler(fakeEvent(repairRequest({ targetUsername: 'notowner', operationName: 'fal:fal-ai/veo3.1:owned-req' })));
    var body = JSON.parse(res.body);
    assert.equal(body.outcome, 'account_mismatch');
  });
});

test('no job-owner record at all (never submitted through the real flow, or predates the store) is reported plainly', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, FAL_KEY: 'test-fal-key' }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    await seedAccount(event, 'norecord', 'norecord@example.com');

    global.fetch = async function () { throw new Error('must not call fal with no job-owner record'); };

    var handler = require('../netlify/functions/admin-repair-lost-generations').handler;
    var res = await handler(fakeEvent(repairRequest({ targetUsername: 'norecord', operationName: 'fal:fal-ai/veo3.1:never-existed' })));
    var body = JSON.parse(res.body);
    assert.equal(body.outcome, 'no_job_owner_record');
  });
});

test('an unparseable operationName is rejected (E10)', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    await seedAccount(event, 'baduser', 'bad@example.com');

    var handler = require('../netlify/functions/admin-repair-lost-generations').handler;
    var res = await handler(fakeEvent(repairRequest({ targetUsername: 'baduser', operationName: 'not-a-real-shape' })));
    assert.equal(res.statusCode, 400);
    var body = JSON.parse(res.body);
    assert.equal(body.error, 'E10: invalid_operation_name');
  });
});

test('an unknown targetUsername is rejected (E9)', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);

    var handler = require('../netlify/functions/admin-repair-lost-generations').handler;
    var res = await handler(fakeEvent(repairRequest({ targetUsername: 'nobodyhere', operationName: 'fal:model:req' })));
    assert.equal(res.statusCode, 400);
    var body = JSON.parse(res.body);
    assert.equal(body.error, 'E9: target_account_not_found');
  });
});

test('rejects a non-owner password (E5)', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    await require('../netlify/functions/lib/account-store').createAccount(event, { username: 'someoneelse', password: 'irrelevantpw1', email: 'not-owner@example.com' });

    var handler = require('../netlify/functions/admin-repair-lost-generations').handler;
    var res = await handler(fakeEvent(repairRequest({ usernameOrEmail: 'not-owner@example.com', password: 'irrelevantpw1', targetUsername: 'ronbrightman', operationName: 'fal:model:req' })));
    assert.equal(res.statusCode, 403);
    var body = JSON.parse(res.body);
    assert.equal(body.error, 'E5: forbidden');
  });
});

test('is rejected with 500 when OWNER_EMAIL is not configured, before any credential check', function () {
  return withEnv({ OWNER_EMAIL: undefined }, async function () {
    var handler = require('../netlify/functions/admin-repair-lost-generations').handler;
    var res = await handler(fakeEvent(repairRequest({ targetUsername: 'x', operationName: 'fal:model:req' })));
    assert.equal(res.statusCode, 500);
    var body = JSON.parse(res.body);
    assert.equal(body.error, 'E2: missing_owner_email');
  });
});

test('POST exceeding MAX_ADMIN_REPAIR_LOST_GENERATIONS_PER_IP_PER_DAY is rejected with 429 E6', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, MAX_ADMIN_REPAIR_LOST_GENERATIONS_PER_IP_PER_DAY: '1' }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    var handler = require('../netlify/functions/admin-repair-lost-generations').handler;

    var ip = nextIp();
    var req1 = { method: 'POST', ip: ip, body: { usernameOrEmail: OWNER_EMAIL, password: OWNER_PASSWORD, targetUsername: 'x', operationName: 'fal:model:req' } };
    var req2 = { method: 'POST', ip: ip, body: { usernameOrEmail: OWNER_EMAIL, password: OWNER_PASSWORD, targetUsername: 'x', operationName: 'fal:model:req' } };
    await handler(fakeEvent(req1));
    var res2 = await handler(fakeEvent(req2));
    assert.equal(res2.statusCode, 429);
    var body = JSON.parse(res2.body);
    assert.equal(body.error.indexOf('E6:'), 0);
  });
});
