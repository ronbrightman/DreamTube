// test/admin-restore-founder-email.test.js
//
// Covers netlify/functions/admin-restore-founder-email.js: the one-off
// repair endpoint for tracker item for-product-bug-founder-account-u-
// ronbri-0gwe1m (u:ronbrightman's email reported blank in Settings) — see
// that file's own extensive header comment for the full investigation
// trail and the field-preserving/non-circular-auth reasoning this
// exercises. Same test conventions as test/admin-consolidate-accounts.js's
// historical test (git history bec452c) / test/account-store.test.js. Run
// with: node --test test/

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');

var OWNER_EMAIL = 'ronbrightman@example.com';
var RON = 'ronbrightman';
var RON_PASSWORD = 'realfounderpw1';

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

test.beforeEach(function () {
  mockBlobs.reset();
  delete require.cache[require.resolve('../netlify/functions/admin-restore-founder-email')];
  delete require.cache[require.resolve('../netlify/functions/lib/account-store')];
  delete require.cache[require.resolve('../netlify/functions/lib/entitlements')];
});

var ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return '10.9.2.' + ipCounter;
}

async function seedRonAccount(event, overrides) {
  var accountStore = require('../netlify/functions/lib/account-store');
  var body = Object.assign({ username: RON, password: RON_PASSWORD, email: '' }, overrides || {});
  // createAccount normalizes/records whatever email is passed (including
  // '', simulating the reported blank-email bug) -- account-store.js's own
  // createAccount never rejects an empty email, it's a purely optional
  // field there.
  return accountStore.createAccount(event, body);
}

function call(method, params) {
  var handler = require('../netlify/functions/admin-restore-founder-email').handler;
  if (method === 'GET') {
    return handler(fakeEvent({ method: 'GET', ip: nextIp(), query: params }));
  }
  return handler(fakeEvent({ method: 'POST', ip: nextIp(), body: params }));
}

// ===== the actual repair =====

test('POST restores a blank email to OWNER_EMAIL, preserving every other pre-existing field on the record', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedRonAccount(event, { email: '', fbUserId: undefined });
    // Seed an extra, unrelated field directly (the way a prior one-off
    // tool -- e.g. the historical admin-consolidate-accounts.js --
    // would have stamped consolidatedFrom/previousEmail onto the record)
    // to prove this restore never drops fields it doesn't own.
    var accountStore = require('../netlify/functions/lib/account-store');
    var { getStore } = require('@netlify/blobs');
    var existing = await accountStore.getByUsername(event, RON);
    await getStore({ name: accountStore.STORE_NAME }).setJSON('u:' + RON, Object.assign({}, existing, {
      consolidatedFrom: '__probe_throwaway_user__',
      consolidatedAt: 12345
    }));

    var res = await call('POST', { usernameOrEmail: RON, password: RON_PASSWORD });
    assert.equal(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.status, 'restored');
    assert.equal(body.account.username, RON);
    assert.equal(body.account.email, OWNER_EMAIL);
    assert.equal(body.previousEmail, '');

    var finalRecord = await accountStore.getByUsername(event, RON);
    assert.equal(finalRecord.email, OWNER_EMAIL);
    assert.equal(finalRecord.password, RON_PASSWORD, 'password must survive untouched');
    assert.equal(finalRecord.consolidatedFrom, '__probe_throwaway_user__', 'unrelated pre-existing field must survive untouched');
    assert.equal(finalRecord.consolidatedAt, 12345, 'unrelated pre-existing field must survive untouched');

    // The "e:" index must now resolve OWNER_EMAIL to the repaired account.
    var byEmail = await accountStore.getByEmail(event, OWNER_EMAIL);
    assert.ok(byEmail);
    assert.equal(byEmail.username, RON);
  });
});

test('POST is idempotent: a second call after a successful restore is a no-op reporting already_correct', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedRonAccount(event, { email: '' });

    var first = await call('POST', { usernameOrEmail: RON, password: RON_PASSWORD });
    assert.equal(JSON.parse(first.body).status, 'restored');

    var second = await call('POST', { usernameOrEmail: RON, password: RON_PASSWORD });
    var secondBody = JSON.parse(second.body);
    assert.equal(secondBody.ok, true);
    assert.equal(secondBody.status, 'already_correct');
    assert.equal(secondBody.account.email, OWNER_EMAIL);
  });
});

test('POST also repairs a WRONG (non-blank) email, not just a literally empty one', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedRonAccount(event, { email: 'ronb.rightman@gmail.com' });

    var res = await call('POST', { usernameOrEmail: RON, password: RON_PASSWORD });
    var body = JSON.parse(res.body);
    assert.equal(body.status, 'restored');
    assert.equal(body.previousEmail, 'ronb.rightman@gmail.com');
    assert.equal(body.account.email, OWNER_EMAIL);
  });
});

// ===== GET: read-only preview, never mutates =====

test('GET reports the current state without writing anything', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedRonAccount(event, { email: '' });

    var res = await call('GET', { usernameOrEmail: RON, password: RON_PASSWORD });
    var body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.status, 'would_restore');
    assert.equal(body.account.email, '', 'GET must report the real current (broken) email');

    var accountStore = require('../netlify/functions/lib/account-store');
    var stillBroken = await accountStore.getByUsername(event, RON);
    assert.equal(stillBroken.email, '', 'GET must never write anything');
  });
});

test('GET on an already-correct account reports already_correct', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedRonAccount(event, { email: OWNER_EMAIL });

    var res = await call('GET', { usernameOrEmail: RON, password: RON_PASSWORD });
    var body = JSON.parse(res.body);
    assert.equal(body.status, 'already_correct');
  });
});

// ===== auth: must work EVEN THOUGH the account's own email is broken =====

test('auth succeeds by username + password even when the account email is blank (the exact bug this tool exists to fix) -- proves the auth check is non-circular', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedRonAccount(event, { email: '' });

    var res = await call('POST', { usernameOrEmail: RON, password: RON_PASSWORD });
    assert.equal(res.statusCode, 200, 'must not be locked out just because the account\'s own email is the very thing that is broken');
    assert.equal(JSON.parse(res.body).ok, true);
  });
});

test('rejects the wrong password with E5, even though the username resolves', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedRonAccount(event, { email: '' });

    var res = await call('POST', { usernameOrEmail: RON, password: 'totally-wrong' });
    assert.equal(res.statusCode, 403);
    assert.equal(JSON.parse(res.body).error, 'E5: forbidden');
  });
});

test('rejects credentials for a DIFFERENT real account, even a valid one, since only RESTORE_USERNAME is in scope', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var accountStore = require('../netlify/functions/lib/account-store');
    var event = fakeEvent({ method: 'POST' });
    await seedRonAccount(event, { email: '' });
    await accountStore.createAccount(event, { username: 'someone-else', password: 'someoneelsepw1', email: 'someone-else@example.com' });

    var res = await call('POST', { usernameOrEmail: 'someone-else', password: 'someoneelsepw1' });
    assert.equal(res.statusCode, 403);
    assert.equal(JSON.parse(res.body).error, 'E5: forbidden');
  });
});

// ===== refusals =====

test('refuses with E5 (not a distinct code) when u:ronbrightman does not exist at all -- auth itself cannot succeed with no account to check the password against', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var res = await call('POST', { usernameOrEmail: RON, password: RON_PASSWORD });
    assert.equal(res.statusCode, 403);
    assert.equal(JSON.parse(res.body).error, 'E5: forbidden');
  });
});

test('rejects a non-POST/GET method', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var handler = require('../netlify/functions/admin-restore-founder-email').handler;
    var res = await handler(fakeEvent({ method: 'DELETE', ip: nextIp() }));
    assert.equal(res.statusCode, 405);
  });
});

test('500s cleanly when OWNER_EMAIL is not configured', function () {
  return withEnv({ OWNER_EMAIL: undefined }, async function () {
    var res = await call('POST', { usernameOrEmail: RON, password: RON_PASSWORD });
    assert.equal(res.statusCode, 500);
    assert.equal(JSON.parse(res.body).error, 'E2: missing_owner_email');
  });
});

test('400s on missing fields', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL }, async function () {
    var res = await call('POST', { usernameOrEmail: RON });
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error, 'E4: missing_fields');
  });
});

// ===== rate limiting =====

test('rate-limits repeated attempts per identifier', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, MAX_ADMIN_RESTORE_FOUNDER_EMAIL_PER_IDENTIFIER_PER_DAY: '2' }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedRonAccount(event, { email: '' });

    var handler = require('../netlify/functions/admin-restore-founder-email').handler;
    var sameIp = nextIp();
    var attempt = function () {
      return handler(fakeEvent({ method: 'POST', ip: sameIp, body: { usernameOrEmail: RON, password: 'wrong-pw' } }));
    };
    await attempt();
    await attempt();
    var third = await attempt();
    assert.equal(third.statusCode, 429);
    assert.match(JSON.parse(third.body).error, /E6: rate_limited/);
  });
});
