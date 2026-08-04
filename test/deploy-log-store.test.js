// test/deploy-log-store.test.js
//
// Covers netlify/functions/lib/deploy-log-store.js in isolation — tracker
// item for-product-surface-deploys-day-as-a-vis-xld1vk. Run with:
// node --test test/
//
// Two halves, matching the file's own two very different call contexts:
//   1. recordBuildTimeDeploy (BUILD-time write) — real @netlify/blobs
//      manual-credentials mode, so this is exercised against the SAME
//      mock-blobs fake every other lib/*.js test in this suite uses
//      (fakeGetStore ignores extra siteID/token fields, so this needs no
//      special mock support — see that helper's own header comment) —
//      proving the right key shape/record is written given fake env vars,
//      and every no-op branch (missing DEPLOY_ID, missing credentials,
//      a real write failure) returns the documented `reason` without
//      throwing.
//   2. countDeploysForDate (REQUEST-time read) — the normal
//      connectLambda(event) pattern, proving the count is scoped
//      correctly to one UTC date's prefix and never leaks another date's
//      entries in (or a totally different key shape some other store
//      might use, in principle, since this store is dedicated).

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var deployLogStore = require('../netlify/functions/lib/deploy-log-store');

test.beforeEach(function () {
  mockBlobs.reset();
});

// ----- utcDateStr / keyFor (pure helpers) -----

test('utcDateStr formats as YYYY-MM-DD in UTC', function () {
  var d = new Date('2026-08-04T23:59:59.000Z');
  assert.equal(deployLogStore.utcDateStr(d), '2026-08-04');
});

test('utcDateStr defaults to "now" when called with no argument', function () {
  var result = deployLogStore.utcDateStr();
  assert.match(result, /^\d{4}-\d{2}-\d{2}$/);
});

test('keyFor builds the documented deploy-log/<date>/<deployId> shape', function () {
  assert.equal(deployLogStore.keyFor('2026-08-04', 'dep-abc123'), 'deploy-log/2026-08-04/dep-abc123');
});

// ----- resolveBuildCredentials (which of the two build-time credential routes wins) -----

/** Encodes a NETLIFY_BLOBS_CONTEXT value the same way the real SDK does (base64 of JSON). */
function encodeBlobsContext(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}

test('resolveBuildCredentials returns null when neither route is available -- the expected common case today', function () {
  assert.equal(deployLogStore.resolveBuildCredentials({}), null);
  assert.equal(deployLogStore.resolveBuildCredentials({ SITE_ID: 'site1' }), null);
  assert.equal(deployLogStore.resolveBuildCredentials({ NETLIFY_BLOBS_BUILD_TOKEN: 'tok' }), null);
});

test('resolveBuildCredentials uses the explicit NETLIFY_BLOBS_BUILD_TOKEN + SITE_ID route when present', function () {
  var creds = deployLogStore.resolveBuildCredentials({ SITE_ID: 'site1', NETLIFY_BLOBS_BUILD_TOKEN: 'tok' });
  assert.deepEqual(creds, { source: 'build_token', siteID: 'site1', token: 'tok' });
});

test('resolveBuildCredentials falls back to an ambient NETLIFY_BLOBS_CONTEXT, passing its URLs straight through', function () {
  var creds = deployLogStore.resolveBuildCredentials({
    NETLIFY_BLOBS_CONTEXT: encodeBlobsContext({
      siteID: 'ctx-site',
      token: 'ctx-token',
      apiURL: 'https://api.netlify.example',
      edgeURL: 'https://edge.netlify.example'
    })
  });
  assert.equal(creds.source, 'ambient_context');
  assert.equal(creds.siteID, 'ctx-site');
  assert.equal(creds.token, 'ctx-token');
  assert.equal(creds.apiURL, 'https://api.netlify.example');
  assert.equal(creds.edgeURL, 'https://edge.netlify.example');
});

test('resolveBuildCredentials prefers the explicit token route over an ambient context when BOTH are present', function () {
  var creds = deployLogStore.resolveBuildCredentials({
    SITE_ID: 'site1',
    NETLIFY_BLOBS_BUILD_TOKEN: 'tok',
    NETLIFY_BLOBS_CONTEXT: encodeBlobsContext({ siteID: 'ctx-site', token: 'ctx-token' })
  });
  assert.equal(creds.source, 'build_token');
  assert.equal(creds.siteID, 'site1');
  assert.equal(creds.token, 'tok');
});

test('resolveBuildCredentials treats a malformed or incomplete NETLIFY_BLOBS_CONTEXT as simply absent, never throwing', function () {
  assert.equal(deployLogStore.resolveBuildCredentials({ NETLIFY_BLOBS_CONTEXT: 'not-base64-json!!!' }), null);
  assert.equal(deployLogStore.resolveBuildCredentials({ NETLIFY_BLOBS_CONTEXT: encodeBlobsContext({ siteID: 'only-site' }) }), null);
  assert.equal(deployLogStore.resolveBuildCredentials({ NETLIFY_BLOBS_CONTEXT: encodeBlobsContext({ token: 'only-token' }) }), null);
  assert.equal(deployLogStore.resolveBuildCredentials({ NETLIFY_BLOBS_CONTEXT: encodeBlobsContext(null) }), null);
});

// ----- recordBuildTimeDeploy (BUILD-time write) -----

test('recordBuildTimeDeploy no-ops with reason no_deploy_id when DEPLOY_ID is absent (not a real Netlify build env)', async function () {
  var result = await deployLogStore.recordBuildTimeDeploy({ SITE_ID: 'site1', NETLIFY_BLOBS_BUILD_TOKEN: 'tok' });
  assert.equal(result.written, false);
  assert.equal(result.reason, 'no_deploy_id');
});

test('recordBuildTimeDeploy no-ops with reason no_blobs_credentials when SITE_ID/token are both missing -- the expected common case until the token env var is added', async function () {
  var result = await deployLogStore.recordBuildTimeDeploy({ DEPLOY_ID: 'dep-1' });
  assert.equal(result.written, false);
  assert.equal(result.reason, 'no_blobs_credentials');
});

test('recordBuildTimeDeploy no-ops when SITE_ID is present but the token is missing', async function () {
  var result = await deployLogStore.recordBuildTimeDeploy({ DEPLOY_ID: 'dep-1', SITE_ID: 'site1' });
  assert.equal(result.written, false);
  assert.equal(result.reason, 'no_blobs_credentials');
});

test('recordBuildTimeDeploy no-ops when the token is present but SITE_ID is missing', async function () {
  var result = await deployLogStore.recordBuildTimeDeploy({ DEPLOY_ID: 'dep-1', NETLIFY_BLOBS_BUILD_TOKEN: 'tok' });
  assert.equal(result.written, false);
  assert.equal(result.reason, 'no_blobs_credentials');
});

test('recordBuildTimeDeploy writes the record under deploy-log/<today>/<DEPLOY_ID> when both credentials are present', async function () {
  var env = {
    DEPLOY_ID: 'dep-real-123',
    SITE_ID: 'site-abc',
    NETLIFY_BLOBS_BUILD_TOKEN: 'a-real-token',
    COMMIT_REF: 'deadbeef1234567890abcdef1234567890abcdef',
    BRANCH: 'main',
    CONTEXT: 'production'
  };
  var result = await deployLogStore.recordBuildTimeDeploy(env);
  assert.equal(result.written, true);
  assert.equal(result.reason, null);

  var today = deployLogStore.utcDateStr();
  assert.equal(result.key, 'deploy-log/' + today + '/dep-real-123');
  assert.equal(result.credentialSource, 'build_token');

  var { getStore } = require('@netlify/blobs');
  var persisted = await getStore({ name: deployLogStore.STORE_NAME }).get(result.key, { type: 'json' });
  assert.equal(persisted.deployId, 'dep-real-123');
  assert.equal(persisted.commitSha, env.COMMIT_REF);
  assert.equal(persisted.branch, 'main');
  assert.equal(persisted.context, 'production');
  assert.equal(typeof persisted.timestamp, 'string');
  assert.ok(!isNaN(Date.parse(persisted.timestamp)), 'timestamp must be a real parseable ISO string');
});

test('recordBuildTimeDeploy defaults commitSha/branch/context to null when those env vars are absent (present, but a minimal env)', async function () {
  var env = { DEPLOY_ID: 'dep-minimal', SITE_ID: 'site-abc', NETLIFY_BLOBS_BUILD_TOKEN: 'tok' };
  var result = await deployLogStore.recordBuildTimeDeploy(env);
  assert.equal(result.written, true);

  var { getStore } = require('@netlify/blobs');
  var persisted = await getStore({ name: deployLogStore.STORE_NAME }).get(result.key, { type: 'json' });
  assert.equal(persisted.commitSha, null);
  assert.equal(persisted.branch, null);
  assert.equal(persisted.context, null);
});

test('recordBuildTimeDeploy also writes via an ambient NETLIFY_BLOBS_CONTEXT when no explicit build token is configured', async function () {
  var env = {
    DEPLOY_ID: 'dep-ambient',
    NETLIFY_BLOBS_CONTEXT: encodeBlobsContext({ siteID: 'ctx-site', token: 'ctx-token' })
  };
  var result = await deployLogStore.recordBuildTimeDeploy(env);
  assert.equal(result.written, true);
  assert.equal(result.credentialSource, 'ambient_context');

  var count = await deployLogStore.countDeploysForDate(fakeEvent({}), deployLogStore.utcDateStr());
  assert.equal(count, 1);
});

test('recordBuildTimeDeploy is a pure CREATE, never a read-modify-write -- two DIFFERENT DEPLOY_IDs on the same UTC day never collide, both land as distinct keys', async function () {
  var baseEnv = { SITE_ID: 'site-abc', NETLIFY_BLOBS_BUILD_TOKEN: 'tok' };
  var r1 = await deployLogStore.recordBuildTimeDeploy(Object.assign({}, baseEnv, { DEPLOY_ID: 'dep-a' }));
  var r2 = await deployLogStore.recordBuildTimeDeploy(Object.assign({}, baseEnv, { DEPLOY_ID: 'dep-b' }));
  assert.equal(r1.written, true);
  assert.equal(r2.written, true);
  assert.notEqual(r1.key, r2.key);

  var count = await deployLogStore.countDeploysForDate(fakeEvent({}), deployLogStore.utcDateStr());
  assert.equal(count, 2);
});

test('recordBuildTimeDeploy never throws and reports reason write_failed when the underlying Blobs write itself fails', async function () {
  mockBlobs.setWriteOverride(deployLogStore.STORE_NAME, function () { return new Error('simulated storage-layer fault'); });
  var result = await deployLogStore.recordBuildTimeDeploy({ DEPLOY_ID: 'dep-1', SITE_ID: 'site1', NETLIFY_BLOBS_BUILD_TOKEN: 'tok' });
  assert.equal(result.written, false);
  assert.equal(result.reason, 'write_failed');
  assert.match(result.error, /simulated storage-layer fault/);
  mockBlobs.clearWriteOverride(deployLogStore.STORE_NAME);
});

test('recordBuildTimeDeploy defaults env to process.env when called with no argument, and does not throw', async function () {
  var savedDeployId = process.env.DEPLOY_ID;
  delete process.env.DEPLOY_ID; // this test process is not a real Netlify build
  try {
    var result = await deployLogStore.recordBuildTimeDeploy();
    assert.equal(result.written, false);
    assert.equal(result.reason, 'no_deploy_id');
  } finally {
    if (savedDeployId === undefined) delete process.env.DEPLOY_ID;
    else process.env.DEPLOY_ID = savedDeployId;
  }
});

// ----- countDeploysForDate (REQUEST-time read) -----

test('countDeploysForDate is 0 for a date with no recorded deploys', async function () {
  var count = await deployLogStore.countDeploysForDate(fakeEvent({}), '2026-01-01');
  assert.equal(count, 0);
});

test('countDeploysForDate only counts entries under the requested date\'s prefix -- a different date\'s entries never leak in', async function () {
  var { getStore, connectLambda } = require('@netlify/blobs');
  connectLambda(fakeEvent({}));
  var store = getStore({ name: deployLogStore.STORE_NAME });
  await store.setJSON(deployLogStore.keyFor('2026-08-04', 'dep-1'), { deployId: 'dep-1' });
  await store.setJSON(deployLogStore.keyFor('2026-08-04', 'dep-2'), { deployId: 'dep-2' });
  await store.setJSON(deployLogStore.keyFor('2026-08-04', 'dep-3'), { deployId: 'dep-3' });
  await store.setJSON(deployLogStore.keyFor('2026-08-03', 'dep-yesterday'), { deployId: 'dep-yesterday' });

  var todayCount = await deployLogStore.countDeploysForDate(fakeEvent({}), '2026-08-04');
  var yesterdayCount = await deployLogStore.countDeploysForDate(fakeEvent({}), '2026-08-03');
  assert.equal(todayCount, 3);
  assert.equal(yesterdayCount, 1);
});

test('countDeploysForDate reflects a real recordBuildTimeDeploy write end-to-end (write path -> read path, same store)', async function () {
  var env = { DEPLOY_ID: 'dep-e2e', SITE_ID: 'site-abc', NETLIFY_BLOBS_BUILD_TOKEN: 'tok' };
  var writeResult = await deployLogStore.recordBuildTimeDeploy(env);
  assert.equal(writeResult.written, true);

  var count = await deployLogStore.countDeploysForDate(fakeEvent({}), deployLogStore.utcDateStr());
  assert.equal(count, 1);
});
