// test/admin-diagnose-resend-sends.test.js
//
// Covers netlify/functions/admin-diagnose-resend-sends.js: the READ-ONLY
// diagnostic built for tracker item
// for-product-urgent-email-dedup-integrity-iys5fb (see that file's own
// header comment for the full reasoning -- settling whether the 08-01/
// 08-02 multi-send accounts are an event-taxonomy over-count or a real
// CAS bug, by counting Resend's own actual delivered sends). Same test
// conventions as test/admin-diagnose-account-duplicates.test.js /
// test/admin-diagnose-dodo-payment.test.js for auth/rate-limit/request-
// shape coverage, plus test/send-first-dream-email.test.js's global.fetch
// spy convention for the external Resend API call this file makes (the
// only admin-diagnose-*.js so far to call a real external vendor API).

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');

var OWNER_EMAIL = 'founder@dreamtube.example';
var realFetch = global.fetch;

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
  global.fetch = realFetch;
  mockBlobs.reset();
  delete require.cache[require.resolve('../netlify/functions/admin-diagnose-resend-sends')];
  delete require.cache[require.resolve('../netlify/functions/lib/account-store')];
  delete require.cache[require.resolve('../netlify/functions/lib/entitlements')];
});
test.after(function () {
  global.fetch = realFetch;
});

var ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return '10.9.5.' + ipCounter;
}

async function seedOwnerAccount(event, overrides) {
  var accountStore = require('../netlify/functions/lib/account-store');
  var body = Object.assign({ username: 'ronbrightman', password: 'realfounderpw1', email: OWNER_EMAIL }, overrides || {});
  return accountStore.createAccount(event, body);
}

/**
 * Installs a fake Resend list-emails endpoint backed by an in-memory,
 * already-newest-first array of "pages" (each an array of raw Resend
 * email objects). Records every request URL made so tests can assert on
 * pagination cursor usage. Any request whose URL doesn't start with the
 * real RESEND_LIST_API_BASE throws, so a real network call would fail
 * loudly rather than silently going out.
 */
function installResendListSpy(pages, opts) {
  opts = opts || {};
  var calls = [];
  var pageIndex = 0;
  global.fetch = async function (url) {
    var urlStr = String(url);
    calls.push(urlStr);
    if (urlStr.indexOf('https://api.resend.com/emails') !== 0) {
      throw new Error('unexpected fetch in test: ' + urlStr);
    }
    if (opts.failOnCall && calls.length === opts.failOnCall) {
      return { ok: false, status: 500, text: async function () { return 'internal error'; } };
    }
    var data = pageIndex < pages.length ? pages[pageIndex] : [];
    var hasMore = pageIndex < pages.length - 1;
    pageIndex += 1;
    return {
      ok: true,
      status: 200,
      json: async function () { return { object: 'list', has_more: hasMore, data: data }; }
    };
  };
  return calls;
}

function makeEmail(id, createdAtISO, to, subject) {
  return { id: id, message_id: 'msg_' + id, to: Array.isArray(to) ? to : [to], from: 'DreamTube <dreams@dreamtube.life>', created_at: createdAtISO, subject: subject || 'Your dream is ready' };
}

function baseBody(overrides) {
  return Object.assign({
    usernameOrEmail: OWNER_EMAIL,
    password: 'realfounderpw1',
    recipientEmails: ['moreecemiller@gmail.com'],
    sinceISO: '2026-08-01T00:00:00Z',
    untilISO: '2026-08-03T00:00:00Z'
  }, overrides || {});
}

// ===== the actual founder scenario =====

test('POST correctly counts and reports multiple real sends to one recipient within range', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, RESEND_API_KEY: 'resend-test-key' }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);

    var page1 = [
      makeEmail('e4', '2026-08-02T09:06:05Z', 'moreecemiller@gmail.com', 'Your dream is ready'),
      makeEmail('e3', '2026-08-02T09:05:15Z', 'moreecemiller@gmail.com', 'Your dream is ready'),
      makeEmail('e2', '2026-08-02T09:01:22Z', 'moreecemiller@gmail.com', 'Your dream is ready'),
      makeEmail('e1', '2026-08-01T12:00:00Z', 'someoneelse@example.com', 'Your dream is ready')
    ];
    installResendListSpy([page1]);

    var handler = require('../netlify/functions/admin-diagnose-resend-sends').handler;
    var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: baseBody() }));
    assert.equal(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.results['moreecemiller@gmail.com'].count, 3, 'genuinely 3 distinct Resend sends to this address in range');
    assert.equal(body.results['moreecemiller@gmail.com'].sends.length, 3);
    assert.equal(body.results['moreecemiller@gmail.com'].sends[0].createdAt, '2026-08-02T09:06:05Z');
    assert.equal(body.results['moreecemiller@gmail.com'].sends[0].subject, 'Your dream is ready');
    assert.equal(body.totalEmailsScanned, 4);
    assert.equal(body.truncated, false);
  });
});

test('POST filters and counts correctly across MULTIPLE recipients in one call', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, RESEND_API_KEY: 'resend-test-key' }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);

    var page1 = [
      makeEmail('e5', '2026-08-02T10:00:00Z', 'dtsexton18@example.com', 'Your dream is ready'),
      makeEmail('e4', '2026-08-02T09:00:00Z', 'demiaharchie49@example.com', 'Your dream is ready'),
      makeEmail('e3', '2026-08-02T08:00:00Z', 'moreecemiller@gmail.com', 'Your dream is ready'),
      makeEmail('e2', '2026-08-01T20:00:00Z', 'moreecemiller@gmail.com', 'Your dream is ready'),
      makeEmail('e1', '2026-08-01T10:00:00Z', 'unrelated@example.com', 'Some other email')
    ];
    installResendListSpy([page1]);

    var handler = require('../netlify/functions/admin-diagnose-resend-sends').handler;
    var res = await handler(fakeEvent({
      method: 'POST', ip: nextIp(),
      body: baseBody({ recipientEmails: ['moreecemiller@gmail.com', 'dtsexton18@example.com', 'demiaharchie49@example.com'] })
    }));
    assert.equal(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.equal(body.results['moreecemiller@gmail.com'].count, 2);
    assert.equal(body.results['dtsexton18@example.com'].count, 1);
    assert.equal(body.results['demiaharchie49@example.com'].count, 1);
  });
});

test('POST matches recipients case-insensitively', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, RESEND_API_KEY: 'resend-test-key' }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    installResendListSpy([[makeEmail('e1', '2026-08-02T09:00:00Z', 'MoreEceMiller@Gmail.com', 'Your dream is ready')]]);

    var handler = require('../netlify/functions/admin-diagnose-resend-sends').handler;
    var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: baseBody({ recipientEmails: ['moreecemiller@gmail.com'] }) }));
    var body = JSON.parse(res.body);
    assert.equal(body.results['moreecemiller@gmail.com'].count, 1);
  });
});

test('POST excludes a send outside the [sinceISO, untilISO] window even on an in-range page', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, RESEND_API_KEY: 'resend-test-key' }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    // One send strictly AFTER untilISO (2026-08-03T00:00:00Z), one within range.
    installResendListSpy([[
      makeEmail('e2', '2026-08-03T05:00:00Z', 'moreecemiller@gmail.com', 'Your dream is ready'),
      makeEmail('e1', '2026-08-02T05:00:00Z', 'moreecemiller@gmail.com', 'Your dream is ready')
    ]]);

    var handler = require('../netlify/functions/admin-diagnose-resend-sends').handler;
    var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: baseBody() }));
    var body = JSON.parse(res.body);
    assert.equal(body.results['moreecemiller@gmail.com'].count, 1);
    assert.equal(body.results['moreecemiller@gmail.com'].sends[0].createdAt, '2026-08-02T05:00:00Z');
  });
});

// ===== created_at parsing (Resend's REAL, non-ISO-8601 format) =====
//
// Resend's own documented example response
// (resend.com/docs/api-reference/emails/list-emails) shows `created_at`
// in raw Postgres `timestamptz` text form -- e.g.
// "2026-04-03 22:13:42.674981+00" -- NOT strict ISO-8601 (space instead
// of 'T', 6-digit microseconds, bare 2-digit offset with no colon/
// minutes). Plain Date.parse() of that exact shape is a documented
// cross-engine/cross-version footgun that can return NaN. Every other
// test in this file uses `makeEmail`'s clean ISO-8601 helper, which
// would never have caught this class of bug -- these tests use the
// literal real-format string instead.

test('POST correctly parses Resend\'s REAL documented created_at format (Postgres timestamptz text, not ISO-8601), matching the exact millisecond', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, RESEND_API_KEY: 'resend-test-key' }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);

    // Literal sample from Resend's own docs.
    var REAL_RESEND_CREATED_AT = '2026-04-03 22:13:42.674981+00';

    // Independently computed (via Date.UTC, not via the code under test)
    // expected epoch ms for that exact timestamp -- JS Date truncates the
    // microsecond fraction (.674981s) down to its millisecond field (674ms).
    var EXPECTED_MS = Date.UTC(2026, 3, 3, 22, 13, 42, 674);
    assert.equal(EXPECTED_MS, 1775254422674, 'sanity-check the independently-computed expected ms itself');

    installResendListSpy([[
      { id: 'e1', message_id: 'msg_e1', to: ['moreecemiller@gmail.com'], from: 'DreamTube <dreams@dreamtube.life>', created_at: REAL_RESEND_CREATED_AT, subject: 'Your dream is ready' }
    ]]);

    var handler = require('../netlify/functions/admin-diagnose-resend-sends').handler;
    // Window is exactly [EXPECTED_MS, EXPECTED_MS+1) -- a 1ms-wide box. If
    // the parser is off by even a single millisecond in either direction,
    // the item falls outside the window and the count comes back 0,
    // proving this isn't just "didn't NaN" but the exact right value.
    var res = await handler(fakeEvent({
      method: 'POST', ip: nextIp(),
      body: baseBody({
        sinceISO: new Date(EXPECTED_MS).toISOString(),
        untilISO: new Date(EXPECTED_MS + 1).toISOString()
      })
    }));
    assert.equal(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.equal(body.results['moreecemiller@gmail.com'].count, 1, 'the Postgres-timestamptz-form created_at must parse to exactly the expected ms to fall in this 1ms window');
    assert.equal(body.results['moreecemiller@gmail.com'].sends[0].createdAt, REAL_RESEND_CREATED_AT, 'raw created_at is passed through to the response verbatim, unparsed');
  });
});

test('POST still handles plain ISO-8601 created_at correctly (defensive against Resend switching format later)', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, RESEND_API_KEY: 'resend-test-key' }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    installResendListSpy([[makeEmail('e1', '2026-08-02T09:06:05Z', 'moreecemiller@gmail.com', 'Your dream is ready')]]);

    var handler = require('../netlify/functions/admin-diagnose-resend-sends').handler;
    var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: baseBody() }));
    assert.equal(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.equal(body.results['moreecemiller@gmail.com'].count, 1);
  });
});

test('POST fails LOUDLY with 502 E11 on a genuinely unparseable created_at, rather than silently reporting count:0', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, RESEND_API_KEY: 'resend-test-key' }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    installResendListSpy([[
      { id: 'e1', message_id: 'msg_e1', to: ['moreecemiller@gmail.com'], from: 'DreamTube <dreams@dreamtube.life>', created_at: 'definitely-not-a-real-timestamp', subject: 'Your dream is ready' }
    ]]);

    var handler = require('../netlify/functions/admin-diagnose-resend-sends').handler;
    var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: baseBody() }));
    assert.equal(res.statusCode, 502);
    assert.match(JSON.parse(res.body).error, /^E11: unparseable_timestamp/, 'must be a loud, documented error -- never a silent count:0 that looks like a clean scan');
  });
});

// ===== pagination self-consistency (newest-first assumption) =====

test('POST fails LOUDLY with 502 E12 when a page\'s items violate the newest-first order the pagination safety logic depends on', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, RESEND_API_KEY: 'resend-test-key' }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    // Deliberately OUT of newest-first order: older item first, then a newer one.
    installResendListSpy([[
      makeEmail('e1', '2026-08-01T00:00:00Z', 'moreecemiller@gmail.com', 'Your dream is ready'),
      makeEmail('e2', '2026-08-02T00:00:00Z', 'moreecemiller@gmail.com', 'Your dream is ready')
    ]]);

    var handler = require('../netlify/functions/admin-diagnose-resend-sends').handler;
    var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: baseBody() }));
    assert.equal(res.statusCode, 502);
    assert.match(JSON.parse(res.body).error, /^E12: resend_order_violation/);
  });
});

// ===== pagination =====

test('POST pages backward across multiple pages and stops once it pages past sinceISO', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, RESEND_API_KEY: 'resend-test-key' }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);

    // Page 1: newest, all within range. Page 2: straddles the sinceISO
    // boundary -- one in-range email, then one OLDER than sinceISO, which
    // must stop pagination before a (deliberately unreachable) page 3.
    var page1 = [makeEmail('e3', '2026-08-02T12:00:00Z', 'moreecemiller@gmail.com', 'Your dream is ready')];
    var page2 = [
      makeEmail('e2', '2026-08-01T06:00:00Z', 'moreecemiller@gmail.com', 'Your dream is ready'),
      makeEmail('e1', '2026-07-31T23:00:00Z', 'moreecemiller@gmail.com', 'Your dream is ready') // older than sinceISO
    ];
    var page3WouldBeUnreachable = [makeEmail('e0', '2026-07-30T00:00:00Z', 'moreecemiller@gmail.com', 'Your dream is ready')];

    var calls = installResendListSpy([page1, page2, page3WouldBeUnreachable]);

    var handler = require('../netlify/functions/admin-diagnose-resend-sends').handler;
    var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: baseBody() }));
    var body = JSON.parse(res.body);
    assert.equal(body.results['moreecemiller@gmail.com'].count, 2, 'e3 and e2 are in range; e1 is older than sinceISO and excluded');
    assert.equal(body.pagesFetched, 2, 'must stop after page 2, never fetching page 3');
    assert.equal(body.truncated, false);
    assert.equal(calls.length, 2);
    assert.match(calls[1], /after=e3/, 'second page request must cursor off the last id of page 1');
  });
});

test('POST hits the safety page cap before reaching sinceISO and honestly reports truncated:true', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, RESEND_API_KEY: 'resend-test-key' }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);

    // 60 pages of 1 email each, ALL still within the requested window
    // (sinceISO is far in the past) -- the PAGE_CAP (50) must stop this
    // before it would otherwise page all the way back.
    var pages = [];
    for (var i = 0; i < 60; i++) {
      pages.push([makeEmail('e' + i, '2026-08-02T00:00:00Z', 'moreecemiller@gmail.com', 'Your dream is ready')]);
    }
    installResendListSpy(pages);

    var handler = require('../netlify/functions/admin-diagnose-resend-sends').handler;
    var res = await handler(fakeEvent({
      method: 'POST', ip: nextIp(),
      body: baseBody({ sinceISO: '2020-01-01T00:00:00Z', untilISO: '2026-08-03T00:00:00Z' })
    }));
    assert.equal(res.statusCode, 200);
    var body = JSON.parse(res.body);
    assert.equal(body.truncated, true);
    assert.equal(body.pagesFetched, 50, 'stops exactly at the safety cap');
    assert.equal(body.totalEmailsScanned, 50, 'never silently claims a complete scan past the cap');
  });
});

test('POST stops paginating (without truncation) once Resend itself reports has_more:false', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, RESEND_API_KEY: 'resend-test-key' }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    // Single page, has_more:false (installResendListSpy sets has_more
    // false on the last page in the array) -- window is wide open (far
    // past sinceISO) so the ONLY reason to stop is Resend's own signal.
    installResendListSpy([[makeEmail('e1', '2026-08-02T00:00:00Z', 'moreecemiller@gmail.com', 'Your dream is ready')]]);

    var handler = require('../netlify/functions/admin-diagnose-resend-sends').handler;
    var res = await handler(fakeEvent({
      method: 'POST', ip: nextIp(),
      body: baseBody({ sinceISO: '2020-01-01T00:00:00Z' })
    }));
    var body = JSON.parse(res.body);
    assert.equal(body.pagesFetched, 1);
    assert.equal(body.truncated, false);
  });
});

// ===== honest error propagation =====

test('POST propagates a real Resend API error honestly (502 E10), never swallowing it into an empty result', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, RESEND_API_KEY: 'resend-test-key' }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    installResendListSpy([[makeEmail('e1', '2026-08-02T00:00:00Z', 'moreecemiller@gmail.com', 'x')]], { failOnCall: 1 });

    var handler = require('../netlify/functions/admin-diagnose-resend-sends').handler;
    var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: baseBody() }));
    assert.equal(res.statusCode, 502);
    assert.match(JSON.parse(res.body).error, /^E10: resend_api_error/);
  });
});

test('POST propagates a network-level fetch failure honestly (502 E10)', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, RESEND_API_KEY: 'resend-test-key' }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    global.fetch = async function () { throw new Error('ECONNRESET'); };

    var handler = require('../netlify/functions/admin-diagnose-resend-sends').handler;
    var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: baseBody() }));
    assert.equal(res.statusCode, 502);
    assert.match(JSON.parse(res.body).error, /^E10: resend_api_error/);
  });
});

test('POST returns 500 E9 when RESEND_API_KEY is not configured, without ever calling fetch', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, RESEND_API_KEY: undefined }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    global.fetch = async function () { throw new Error('must never be called'); };

    var handler = require('../netlify/functions/admin-diagnose-resend-sends').handler;
    var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: baseBody() }));
    assert.equal(res.statusCode, 500);
    assert.match(JSON.parse(res.body).error, /^E9: missing_resend_api_key/);
  });
});

// ===== request shape =====

test('POST rejects a missing, non-array, empty, or oversized recipientEmails list (400 E7)', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, RESEND_API_KEY: 'resend-test-key' }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    var handler = require('../netlify/functions/admin-diagnose-resend-sends').handler;

    var missing = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: baseBody({ recipientEmails: undefined }) }));
    assert.equal(missing.statusCode, 400);
    assert.match(JSON.parse(missing.body).error, /^E7: invalid_recipient_emails/);

    var notArray = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: baseBody({ recipientEmails: 'a@example.com' }) }));
    assert.equal(notArray.statusCode, 400);
    assert.match(JSON.parse(notArray.body).error, /^E7: invalid_recipient_emails/);

    var empty = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: baseBody({ recipientEmails: [] }) }));
    assert.equal(empty.statusCode, 400);
    assert.match(JSON.parse(empty.body).error, /^E7: invalid_recipient_emails/);

    var tooMany = new Array(21).fill('a@example.com');
    var oversized = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: baseBody({ recipientEmails: tooMany }) }));
    assert.equal(oversized.statusCode, 400);
    assert.match(JSON.parse(oversized.body).error, /^E7: invalid_recipient_emails/);

    var blankEntry = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: baseBody({ recipientEmails: ['ok@example.com', '  '] }) }));
    assert.equal(blankEntry.statusCode, 400);
    assert.match(JSON.parse(blankEntry.body).error, /^E7: invalid_recipient_emails/);
  });
});

test('POST rejects a missing, unparseable, or inverted date range (400 E8)', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, RESEND_API_KEY: 'resend-test-key' }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    var handler = require('../netlify/functions/admin-diagnose-resend-sends').handler;

    var missingSince = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: baseBody({ sinceISO: undefined }) }));
    assert.equal(missingSince.statusCode, 400);
    assert.match(JSON.parse(missingSince.body).error, /^E8: invalid_date_range/);

    var badFormat = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: baseBody({ sinceISO: 'not-a-date' }) }));
    assert.equal(badFormat.statusCode, 400);
    assert.match(JSON.parse(badFormat.body).error, /^E8: invalid_date_range/);

    var inverted = await handler(fakeEvent({
      method: 'POST', ip: nextIp(),
      body: baseBody({ sinceISO: '2026-08-03T00:00:00Z', untilISO: '2026-08-01T00:00:00Z' })
    }));
    assert.equal(inverted.statusCode, 400);
    assert.match(JSON.parse(inverted.body).error, /^E8: invalid_date_range/);

    var equal = await handler(fakeEvent({
      method: 'POST', ip: nextIp(),
      body: baseBody({ sinceISO: '2026-08-01T00:00:00Z', untilISO: '2026-08-01T00:00:00Z' })
    }));
    assert.equal(equal.statusCode, 400);
    assert.match(JSON.parse(equal.body).error, /^E8: invalid_date_range/);
  });
});

test('POST rejects missing fields, invalid JSON, and non-POST methods', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, RESEND_API_KEY: 'resend-test-key' }, async function () {
    var handler = require('../netlify/functions/admin-diagnose-resend-sends').handler;

    var missing = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: { usernameOrEmail: 'someone' } }));
    assert.equal(missing.statusCode, 400);
    assert.match(JSON.parse(missing.body).error, /^E4: missing_fields/);

    var badJson = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: '{not json' }));
    assert.equal(badJson.statusCode, 400);
    assert.match(JSON.parse(badJson.body).error, /^E3: invalid_json/);

    var wrongMethod = await handler(fakeEvent({ method: 'GET' }));
    assert.equal(wrongMethod.statusCode, 405);
    assert.match(JSON.parse(wrongMethod.body).error, /^E1: method_not_allowed/);
  });
});

// ===== auth =====

test('POST rejects a wrong password for the owner account (403 E5), never calling Resend', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, RESEND_API_KEY: 'resend-test-key' }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    global.fetch = async function () { throw new Error('must never be called on auth failure'); };

    var handler = require('../netlify/functions/admin-diagnose-resend-sends').handler;
    var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: baseBody({ password: 'totallywrongpw' }) }));
    assert.equal(res.statusCode, 403);
    assert.match(JSON.parse(res.body).error, /^E5: forbidden/);
  });
});

test('POST rejects a real, correct password belonging to a non-owner account (403 E5)', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, RESEND_API_KEY: 'resend-test-key' }, async function () {
    var accountStore = require('../netlify/functions/lib/account-store');
    var event = fakeEvent({ method: 'POST' });
    await accountStore.createAccount(event, { username: 'randomguy', password: 'randompw123', email: 'random@example.com' });
    global.fetch = async function () { throw new Error('must never be called on auth failure'); };

    var handler = require('../netlify/functions/admin-diagnose-resend-sends').handler;
    var res = await handler(fakeEvent({
      method: 'POST', ip: nextIp(),
      body: baseBody({ usernameOrEmail: 'randomguy', password: 'randompw123' })
    }));
    assert.equal(res.statusCode, 403);
    assert.match(JSON.parse(res.body).error, /^E5: forbidden/);
  });
});

test('POST is rejected with 500 when OWNER_EMAIL is not configured, before any credential check', function () {
  return withEnv({ OWNER_EMAIL: undefined, RESEND_API_KEY: 'resend-test-key' }, async function () {
    var handler = require('../netlify/functions/admin-diagnose-resend-sends').handler;
    var res = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: baseBody({ usernameOrEmail: 'anyone', password: 'whatever123' }) }));
    assert.equal(res.statusCode, 500);
    assert.match(JSON.parse(res.body).error, /^E2: missing_owner_email/);
  });
});

// ===== rate limiting =====

test('POST exceeding MAX_ADMIN_DIAGNOSE_RESEND_SENDS_PER_IP_PER_DAY is rejected with 429 E6', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, RESEND_API_KEY: 'resend-test-key', MAX_ADMIN_DIAGNOSE_RESEND_SENDS_PER_IP_PER_DAY: '1' }, async function () {
    var handler = require('../netlify/functions/admin-diagnose-resend-sends').handler;
    var ip = nextIp();

    var first = await handler(fakeEvent({ method: 'POST', ip: ip, body: baseBody({ usernameOrEmail: 'nobody', password: 'wrongpw123' }) }));
    assert.equal(first.statusCode, 403);

    var second = await handler(fakeEvent({ method: 'POST', ip: ip, body: baseBody() }));
    assert.equal(second.statusCode, 429);
    assert.match(JSON.parse(second.body).error, /^E6: rate_limited/);
  });
});

test('POST exceeding MAX_ADMIN_DIAGNOSE_RESEND_SENDS_PER_IDENTIFIER_PER_DAY is rejected with 429 E6', function () {
  return withEnv({ OWNER_EMAIL: OWNER_EMAIL, RESEND_API_KEY: 'resend-test-key', MAX_ADMIN_DIAGNOSE_RESEND_SENDS_PER_IDENTIFIER_PER_DAY: '1' }, async function () {
    var event = fakeEvent({ method: 'POST' });
    await seedOwnerAccount(event);
    installResendListSpy([[]]);
    var handler = require('../netlify/functions/admin-diagnose-resend-sends').handler;

    var first = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: baseBody() }));
    assert.equal(first.statusCode, 200);

    var second = await handler(fakeEvent({ method: 'POST', ip: nextIp(), body: baseBody() }));
    assert.equal(second.statusCode, 429);
    assert.match(JSON.parse(second.body).error, /^E6: rate_limited/);
  });
});
