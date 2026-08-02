// test/account-store-facebook.test.js
//
// Covers the Facebook Login additions to
// netlify/functions/lib/account-store.js — the optional `fbUserId` field
// and the new "f:<fbUserId>" secondary index — plus
// netlify/functions/lib/derive-username.js, the shared server-side
// username-derivation helper the Facebook account-creation path uses
// (docs/SIGNUP_FACEBOOK_LOGIN_SPEC.md §3/§5).
//
// Deliberately a separate file from test/account-store.test.js rather
// than an addition to it: everything here is about ONE new index and its
// invariants, and keeping it separate makes it obvious at a glance that
// the pre-existing account-store coverage was not modified to accommodate
// this feature (a regression in the existing signup path is the single
// highest-impact thing this change could break).
//
// Same conventions as test/account-store.test.js: mock-blobs, fakeEvent.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');

test.beforeEach(function () {
  mockBlobs.reset();
  delete require.cache[require.resolve('../netlify/functions/lib/account-store')];
  delete require.cache[require.resolve('../netlify/functions/lib/derive-username')];
  delete require.cache[require.resolve('../netlify/functions/register-account')];
});

function evt() {
  return fakeEvent({ method: 'POST' });
}

// ===== the fbUserId field / "f:" index =====

test('account-store: an account created WITHOUT fbUserId has exactly the record shape it always had — no new key, no f: index', async function () {
  var accountStore = require('../netlify/functions/lib/account-store');
  var event = evt();
  var created = await accountStore.createAccount(event, { username: 'plainuser', password: 'plainpassword', email: 'plain@example.com' });
  assert.equal(created.ok, true);
  // `emailVerified` (tracker item for-product-build-passwordless-signup-fo-
  // at2fko) is now always present on a freshly-created record — defaults to
  // `true` for any caller (like this one) that doesn't pass it explicitly,
  // see account-store.js's own GATE LIST header comment for why.
  assert.deepEqual(Object.keys(created.record).sort(), ['email', 'emailVerified', 'password', 'updatedAt', 'username']);
  assert.equal(Object.prototype.hasOwnProperty.call(created.record, 'fbUserId'), false);
  assert.equal(await accountStore.getByFacebookUserId(event, '123'), null);
});

test('account-store: createAccount with fbUserId stores it and makes the account resolvable through the f: index', async function () {
  var accountStore = require('../netlify/functions/lib/account-store');
  var event = evt();
  var created = await accountStore.createAccount(event, { username: 'fbuser', password: null, email: 'fbuser@example.com', fbUserId: '424242' });
  assert.equal(created.ok, true);
  assert.equal(created.record.fbUserId, '424242');
  assert.equal(created.record.password, null);

  var found = await accountStore.getByFacebookUserId(event, '424242');
  assert.equal(found.username, 'fbuser');
  // Both other lookups still work identically.
  assert.equal((await accountStore.getByEmail(event, 'fbuser@example.com')).username, 'fbuser');
  assert.equal((await accountStore.getByUsername(event, 'fbuser')).fbUserId, '424242');
});

test('account-store: getByFacebookUserId refuses a stale index entry whose record no longer claims that id (same defense-in-depth as getByEmail)', async function () {
  var accountStore = require('../netlify/functions/lib/account-store');
  var event = evt();
  await accountStore.createAccount(event, { username: 'driftuser', password: null, email: 'drift@example.com', fbUserId: '515151' });

  // Simulate the non-atomic-write drift the store's header comment
  // documents: an "f:" entry pointing at a record that doesn't claim it.
  mockBlobs.seed(accountStore.STORE_NAME, 'f:999999', 'driftuser');
  assert.equal(await accountStore.getByFacebookUserId(event, '999999'), null);

  // And an index pointing at a record that no longer exists at all.
  mockBlobs.seed(accountStore.STORE_NAME, 'f:888888', 'ghostuser');
  assert.equal(await accountStore.getByFacebookUserId(event, '888888'), null);
});

test('account-store: a Facebook id that is not purely digits is refused rather than turned into a key (no cross-prefix key shaping)', async function () {
  var accountStore = require('../netlify/functions/lib/account-store');
  var event = evt();
  assert.equal(accountStore.normalizeFacebookUserId('12:34'), '');
  assert.equal(accountStore.normalizeFacebookUserId('u:someone'), '');
  assert.equal(accountStore.normalizeFacebookUserId(''), '');
  assert.equal(accountStore.normalizeFacebookUserId(null), '');
  assert.equal(accountStore.normalizeFacebookUserId(4242), '4242', 'a numeric id is coerced, not rejected');

  var created = await accountStore.createAccount(event, { username: 'weirdid', password: null, email: 'weirdid@example.com', fbUserId: 'e:victim@example.com' });
  assert.equal(created.ok, true);
  assert.equal(Object.prototype.hasOwnProperty.call(created.record, 'fbUserId'), false, 'an unusable id is dropped, never keyed');
  assert.equal(await accountStore.getByFacebookUserId(event, 'e:victim@example.com'), null);
});

test('account-store: linkFacebookUserId upserts onto an existing account without touching its password or email', async function () {
  var accountStore = require('../netlify/functions/lib/account-store');
  var event = evt();
  await accountStore.createAccount(event, { username: 'linkme', password: 'originalpassword', email: 'linkme@example.com' });

  var linked = await accountStore.linkFacebookUserId(event, 'linkme', '606060');
  assert.equal(linked.ok, true);
  assert.equal(linked.record.password, 'originalpassword');
  assert.equal(linked.record.email, 'linkme@example.com');
  assert.equal(linked.record.fbUserId, '606060');
  assert.equal((await accountStore.getByFacebookUserId(event, '606060')).username, 'linkme');
});

test('account-store: linkFacebookUserId is idempotent for the same id, and fails closed rather than repointing a Facebook id that already belongs to another account', async function () {
  var accountStore = require('../netlify/functions/lib/account-store');
  var event = evt();
  await accountStore.createAccount(event, { username: 'ownerone', password: null, email: 'ownerone@example.com', fbUserId: '707070' });
  await accountStore.createAccount(event, { username: 'ownertwo', password: 'pw12345', email: 'ownertwo@example.com' });

  // Re-linking the same id to the account that already has it is fine.
  assert.equal((await accountStore.linkFacebookUserId(event, 'ownerone', '707070')).ok, true);

  // Stealing it for a different account is refused — otherwise ownerone's
  // Facebook login would silently start resolving to ownertwo.
  var stolen = await accountStore.linkFacebookUserId(event, 'ownertwo', '707070');
  assert.equal(stolen.ok, false);
  assert.equal(stolen.error, 'facebook_id_taken');
  assert.equal((await accountStore.getByFacebookUserId(event, '707070')).username, 'ownerone');
});

test('account-store: linkFacebookUserId refuses to overwrite an account that is already linked to a DIFFERENT Facebook identity', async function () {
  var accountStore = require('../netlify/functions/lib/account-store');
  var event = evt();
  await accountStore.createAccount(event, { username: 'alreadylinked', password: null, email: 'al@example.com', fbUserId: '808080' });
  var res = await accountStore.linkFacebookUserId(event, 'alreadylinked', '818181');
  assert.equal(res.ok, false);
  assert.equal(res.error, 'account_already_linked');
  assert.equal((await accountStore.getByUsername(event, 'alreadylinked')).fbUserId, '808080');
});

test('account-store: linkFacebookUserId on a non-existent account returns not_found and creates nothing', async function () {
  var accountStore = require('../netlify/functions/lib/account-store');
  var event = evt();
  var res = await accountStore.linkFacebookUserId(event, 'nobody', '909090');
  assert.equal(res.ok, false);
  assert.equal(res.error, 'not_found');
  assert.equal(await accountStore.getByFacebookUserId(event, '909090'), null);
});

test('account-store: createAccount refuses a second account claiming an already-linked Facebook id', async function () {
  var accountStore = require('../netlify/functions/lib/account-store');
  var event = evt();
  await accountStore.createAccount(event, { username: 'firstfb', password: null, email: 'firstfb@example.com', fbUserId: '111222' });
  var dupe = await accountStore.createAccount(event, { username: 'secondfb', password: null, email: 'secondfb@example.com', fbUserId: '111222' });
  assert.equal(dupe.ok, false);
  assert.equal(dupe.error, 'facebook_id_taken');
  assert.equal((await accountStore.getByFacebookUserId(event, '111222')).username, 'firstfb');
});

test('account-store: deleteAccount cleans up the f: index too, but only when it still points at this username', async function () {
  var accountStore = require('../netlify/functions/lib/account-store');
  var event = evt();
  await accountStore.createAccount(event, { username: 'deleteme', password: null, email: 'deleteme@example.com', fbUserId: '333444' });
  assert.equal((await accountStore.deleteAccount(event, 'deleteme')).ok, true);
  assert.equal(await accountStore.getByFacebookUserId(event, '333444'), null);
  assert.equal(await accountStore.getByUsername(event, 'deleteme'), null);

  // A record whose f: index has since been repointed at somebody else
  // must not have that other person's index deleted out from under them.
  await accountStore.createAccount(event, { username: 'staleowner', password: null, email: 'stale@example.com', fbUserId: '555666' });
  await accountStore.createAccount(event, { username: 'realowner', password: null, email: 'real@example.com' });
  mockBlobs.seed(accountStore.STORE_NAME, 'f:555666', 'realowner');
  await accountStore.deleteAccount(event, 'staleowner');
  var stillThere = await accountStore.getByUsername(event, 'realowner');
  assert.ok(stillThere, 'the other account survives');
});

test('account-store: a Facebook-only (password:null) account can never be logged into with any password', async function () {
  var accountStore = require('../netlify/functions/lib/account-store');
  var event = evt();
  await accountStore.createAccount(event, { username: 'nopassword', password: null, email: 'nopassword@example.com', fbUserId: '121212' });
  var attempts = ['', 'null', 'undefined', 'anything', 'nopassword'];
  for (var i = 0; i < attempts.length; i++) {
    var res = await accountStore.verifyLogin(event, 'nopassword', attempts[i]);
    assert.equal(res.ok, false, 'password "' + attempts[i] + '" must not authenticate a Facebook-only account');
  }
});

test('register-account.js is completely unaffected by the new field — a normal signup still produces the old record shape', async function () {
  var handler = require('../netlify/functions/register-account').handler;
  var res = await handler(fakeEvent({ method: 'POST', ip: '10.7.7.7', body: { username: 'normaluser', password: 'normalpassword', email: 'normal@example.com' } }));
  var body = JSON.parse(res.body);
  assert.equal(body.ok, true);

  var accountStore = require('../netlify/functions/lib/account-store');
  var record = await accountStore.getByEmail(evt(), 'normal@example.com');
  assert.equal(Object.prototype.hasOwnProperty.call(record, 'fbUserId'), false);
  assert.equal(record.password, 'normalpassword');
});

// ===== lib/derive-username.js =====

test('derive-username: deriveUsernameBase matches start.html/wizard.html rules exactly', async function () {
  var derive = require('../netlify/functions/lib/derive-username');
  assert.equal(derive.deriveUsernameBase('Nova.Dreamer@example.com'), 'novadreamer');
  assert.equal(derive.deriveUsernameBase('a@example.com'), 'adrea');
  assert.equal(derive.deriveUsernameBase('!!@example.com'), 'drea');
  assert.equal(derive.deriveUsernameBase('a-very-long-local-part-indeed@example.com'), 'averylonglocalpartin');
  // An empty/absent local part pads to 'drea' — NOT 'dreamer'. This is
  // the existing pages' actual behavior (the `|| 'dreamer'` tail in all
  // three copies is unreachable, since the pad-to-3 step above it always
  // produces a non-empty string); asserted here so the server copy stays
  // bug-for-bug identical rather than "fixed" into divergence.
  assert.equal(derive.deriveUsernameBase(''), 'drea');
  assert.equal(derive.deriveUsernameBase(null), 'drea');
});

test('derive-username: deriveUsernameBase never exceeds 20 characters and never emits a non-alphanumeric character', async function () {
  var derive = require('../netlify/functions/lib/derive-username');
  var samples = ['ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@x.com', 'user+tag.with_dots@x.com', '....@x.com', 'Ünïcødé@x.com'];
  samples.forEach(function (s) {
    var out = derive.deriveUsernameBase(s);
    assert.ok(out.length <= 20, s + ' -> ' + out);
    assert.match(out, /^[a-z0-9]+$/, s + ' -> ' + out);
  });
});

test('derive-username: the server-side helper produces IDENTICAL output to start.html\'s and wizard.html\'s own in-page copies, for every input', async function () {
  // The one real risk of having a third copy of this logic is silent
  // drift — an account created by Facebook Login getting a
  // differently-shaped handle than the same email would get through
  // manual signup. Rather than trusting a comment that says "identical",
  // this pulls both page-local implementations straight out of the HTML
  // and runs all three against the same inputs.
  var fs = require('node:fs');
  var derive = require('../netlify/functions/lib/derive-username');
  var RE = /function deriveUsernameBase\(email\)\{[\s\S]*?\n {2}\}/;

  ['start.html', 'wizard.html'].forEach(function (page) {
    var source = fs.readFileSync(require('node:path').join(__dirname, '..', page), 'utf8');
    var match = source.match(RE);
    assert.ok(match, 'deriveUsernameBase must still be findable in ' + page);
    /* eslint-disable no-new-func */
    var pageFn = new Function(match[0] + '; return deriveUsernameBase;')();

    var inputs = [
      'Nova.Dreamer@example.com', 'a@example.com', 'ab@example.com', '!!@example.com',
      'a-very-long-local-part-indeed@example.com', 'user+tag_dots.here@x.com',
      'ALLCAPS@x.com', '0123456789@x.com', 'x@x.com'
    ];
    inputs.forEach(function (input) {
      assert.equal(derive.deriveUsernameBase(input), pageFn(input),
        page + ' disagrees with lib/derive-username.js for ' + input);
    });
  });
});

test('derive-username: deriveAvailableUsername returns the base when it is free', async function () {
  var derive = require('../netlify/functions/lib/derive-username');
  var res = await derive.deriveAvailableUsername('free@example.com', async function () { return false; });
  assert.deepEqual(res, { ok: true, username: 'free' });
});

test('derive-username: deriveAvailableUsername retries with a fresh suffix on the BASE, never compounding suffixes', async function () {
  var derive = require('../netlify/functions/lib/derive-username');
  var seen = [];
  var suffixes = [1111, 2222, 3333];
  var i = 0;
  var res = await derive.deriveAvailableUsername('taken@example.com', async function (candidate) {
    seen.push(candidate);
    return seen.length < 3; // first two are taken
  }, { randomSuffix: function () { return suffixes[i++]; } });

  assert.deepEqual(seen, ['taken', 'taken1111', 'taken2222']);
  assert.equal(res.ok, true);
  assert.equal(res.username, 'taken2222');
});

test('derive-username: deriveAvailableUsername fails closed when every attempt collides — it never returns a taken name', async function () {
  var derive = require('../netlify/functions/lib/derive-username');
  var res = await derive.deriveAvailableUsername('busy@example.com', async function () { return true; }, { maxAttempts: 3 });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'no_available_username');
  assert.equal(res.username, undefined);
});
